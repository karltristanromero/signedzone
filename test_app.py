import base64
import io
import shutil
import tempfile
import uuid
from pathlib import Path

import fitz
import pytest
from fastapi.testclient import TestClient

import app as app_module


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(app_module, "STORAGE_DIR", tmp_path / "storage")
    monkeypatch.setattr(app_module, "DB_PATH", tmp_path / "storage" / "database.db")
    app_module.STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    app_module.init_db()
    with TestClient(app_module.app) as c:
        yield c


def make_pdf(pages: int = 1) -> bytes:
    doc = fitz.open()
    for i in range(pages):
        page = doc.new_page()
        page.insert_text((72, 72), f"Test page {i + 1}", fontsize=18)
    buf = doc.tobytes()
    doc.close()
    return buf


def png_base64(color=(0, 0, 0)) -> str:
    doc = fitz.open()
    page = doc.new_page(width=200, height=80)
    page.draw_rect(fitz.Rect(10, 10, 190, 70), color=color, fill=color)
    pix = page.get_pixmap()
    return base64.b64encode(pix.tobytes("png")).decode()


def test_upload_creates_v1(client):
    res = client.post("/upload", files={"file": ("sample.pdf", make_pdf(), "application/pdf")})
    assert res.status_code == 200
    doc_id = res.json()["doc_id"]

    stored = app_module.STORAGE_DIR / doc_id / "v1.pdf"
    assert stored.exists()

    versions = client.get(f"/versions/{doc_id}").json()["versions"]
    assert [v["version_number"] for v in versions] == [1]

    listing = client.get("/documents").json()["documents"]
    assert any(d["doc_id"] == doc_id for d in listing)


def test_sign_inserts_image_creates_new_immutable_version(client):
    doc_id = client.post("/upload", files={"file": ("a.pdf", make_pdf(2), "application/pdf")}).json()["doc_id"]
    v1_bytes = (app_module.STORAGE_DIR / doc_id / "v1.pdf").read_bytes()

    res = client.post(
        "/sign",
        json={
            "doc_id": doc_id,
            "change_summary": "added a logo",
            "images": [{"page": 0, "x": 50, "y": 400, "w": 160, "h": 60, "data": png_base64()}],
            "text_boxes": [{"page": 1, "x": 50, "y": 500, "w": 200, "h": 24, "text": "Approved"}],
        },
    )
    assert res.status_code == 200
    assert res.json()["new_version"] == 2

    v2 = app_module.STORAGE_DIR / doc_id / "v2.pdf"
    assert v2.exists()
    assert (app_module.STORAGE_DIR / doc_id / "v1.pdf").read_bytes() == v1_bytes  # v1 untouched

    # content really was burned in
    edited = fitz.open(str(v2))
    assert edited.page_count == 2
    assert "Approved" in edited[1].get_text()
    first = edited[0]
    assert len(first.get_images()) >= 1
    inserted = first.get_image_rects(first.get_images()[0][0])[0]
    assert round(inserted.width) == 160 and round(inserted.height) == 60
    edited.close()

    versions = client.get(f"/versions/{doc_id}").json()["versions"]
    assert [v["version_number"] for v in versions] == [1, 2]

    listing = client.get("/documents").json()["documents"]
    assert next(d for d in listing if d["doc_id"] == doc_id)["change_summary"] == "added a logo"


def test_sign_rejects_undecodable_image(client):
    doc_id = client.post("/upload", files={"file": ("c.pdf", make_pdf(), "application/pdf")}).json()["doc_id"]
    before = client.get(f"/versions/{doc_id}").json()["versions"]

    bad = client.post(
        "/sign",
        json={"doc_id": doc_id, "images": [{"page": 0, "x": 10, "y": 10, "w": 50, "h": 50, "data": "not-an-image"}]},
    )
    assert bad.status_code == 400

    not_b64 = client.post(
        "/sign",
        json={"doc_id": doc_id, "images": [{"page": 0, "x": 10, "y": 10, "w": 50, "h": 50, "data": "!!!not base64!!!"}]},
    )
    assert not_b64.status_code == 400

    zero_size = client.post(
        "/sign",
        json={"doc_id": doc_id, "images": [{"page": 0, "x": 10, "y": 10, "w": 0, "h": 50, "data": png_base64()}]},
    )
    assert zero_size.status_code == 400

    # nothing was committed and no stray v2 exists
    assert client.get(f"/versions/{doc_id}").json()["versions"] == before
    assert not (app_module.STORAGE_DIR / doc_id / "v2.pdf").exists()


def test_page_index_is_zero_based_and_clamped(client):
    doc_id = client.post("/upload", files={"file": ("d.pdf", make_pdf(2), "application/pdf")}).json()["doc_id"]
    res = client.post(
        "/sign",
        json={
            "doc_id": doc_id,
            "images": [
                {"page": 0, "x": 10, "y": 10, "w": 50, "h": 25, "data": png_base64((1, 0, 0))},
                {"page": 99, "x": 10, "y": 10, "w": 50, "h": 25, "data": png_base64((0, 0, 1))},
            ],
        },
    )
    assert res.status_code == 200

    edited = fitz.open(str(app_module.STORAGE_DIR / doc_id / "v2.pdf"))
    assert len(edited[0].get_images()) == 1  # page 0 -> first page
    assert len(edited[1].get_images()) == 1  # page 99 -> clamped to last page
    edited.close()


def test_placements_are_clamped_inside_the_page(client):
    """An item hanging off the edge must not be burned in half-visible."""
    doc_id = client.post("/upload", files={"file": ("g.pdf", make_pdf(), "application/pdf")}).json()["doc_id"]
    v1 = app_module.STORAGE_DIR / doc_id / "v1.pdf"
    base = fitz.open(str(v1))
    page_rect = fitz.Rect(base[0].rect)
    pw, ph = page_rect.width, page_rect.height
    base.close()

    res = client.post(
        "/sign",
        json={
            "doc_id": doc_id,
            "images": [
                {"page": 0, "x": -40, "y": -40, "w": pw + 80, "h": ph + 80, "data": png_base64((1, 0, 0))},
                {"page": 0, "x": pw - 20, "y": ph - 10, "w": 120, "h": 40, "data": png_base64((0, 0, 1))},
            ],
        },
    )
    assert res.status_code == 200

    edited = fitz.open(str(app_module.STORAGE_DIR / doc_id / "v2.pdf"))
    first = edited[0]
    rects = [first.get_image_rects(im[0])[0] for im in first.get_images()]
    assert len(rects) == 2
    for r in rects:
        assert r.x0 >= page_rect.x0 - 0.5 and r.y0 >= page_rect.y0 - 0.5
        assert r.x1 <= page_rect.x1 + 0.5 and r.y1 <= page_rect.y1 + 0.5
    assert round(rects[0].width) == round(pw) and round(rects[0].height) == round(ph)
    assert round(rects[1].width) == 20 and round(rects[1].height) == 10
    edited.close()


def test_placement_entirely_off_page_is_rejected(client):
    doc_id = client.post("/upload", files={"file": ("h.pdf", make_pdf(), "application/pdf")}).json()["doc_id"]
    res = client.post(
        "/sign",
        json={"doc_id": doc_id, "images": [{"page": 0, "x": 5000, "y": 5000, "w": 50, "h": 50, "data": png_base64()}]},
    )
    assert res.status_code == 400
    assert not (app_module.STORAGE_DIR / doc_id / "v2.pdf").exists()


def test_stale_signature_payload_is_rejected_not_ignored(client):
    """A pre-insert-image client must fail loudly, not silently drop the image."""
    doc_id = client.post("/upload", files={"file": ("e.pdf", make_pdf(), "application/pdf")}).json()["doc_id"]
    res = client.post(
        "/sign",
        json={"doc_id": doc_id, "signatures": [{"page": 0, "x": 10, "y": 10, "w": 50, "h": 50, "data": png_base64()}]},
    )
    assert res.status_code == 422
    assert not (app_module.STORAGE_DIR / doc_id / "v2.pdf").exists()


def test_sign_unknown_document_is_404(client):
    res = client.post("/sign", json={"doc_id": str(uuid.uuid4()), "images": []})
    assert res.status_code == 404


def test_repeated_signs_increment_versions(client):
    doc_id = client.post("/upload", files={"file": ("b.pdf", make_pdf(), "application/pdf")}).json()["doc_id"]
    for expected in (2, 3, 4):
        res = client.post(
            "/sign",
            json={"doc_id": doc_id, "change_summary": f"rev {expected}", "images": [], "text_boxes": []},
        )
        assert res.json()["new_version"] == expected

    served = client.get(f"/doc/{doc_id}/v3.pdf")
    assert served.status_code == 200
    assert served.content[:4] == b"%PDF"

    assert client.get(f"/doc/{doc_id}/v9.pdf").status_code == 404


def test_spa_is_served(client):
    res = client.get("/")
    assert res.status_code == 200
    assert "Signly" in res.text
    assert 'id="imageInput"' in res.text
    assert "sigPad" not in res.text and "placeSig" not in res.text
    # The page must never be able to scroll into empty space below the app.
    assert "100vh" not in res.text
    assert 'class="h-screen overflow-hidden' in res.text
    # A bounded grid row is what gives #canvasWrap a working scrollbar.
    assert "lg:grid-rows-1" in res.text
    # #canvasWrap must be the overlay's containing block, or the overlay desyncs
    # from the canvas as soon as the pane is scrolled.
    assert 'id="canvasWrap" class="relative' in res.text


def test_static_assets_must_revalidate(client):
    """A stale app.js strands every handler below the first failed lookup."""
    for path in ("/", "/static/app.js", "/static/styles.css"):
        res = client.get(path)
        assert res.status_code == 200, path
        assert "no-cache" in res.headers.get("cache-control", ""), path

    # Immutable revision PDFs are safe to cache hard.
    doc_id = client.post("/upload", files={"file": ("f.pdf", make_pdf(), "application/pdf")}).json()["doc_id"]
    res = client.get(f"/doc/{doc_id}/v1.pdf")
    assert res.status_code == 200
    assert "no-cache" not in res.headers.get("cache-control", "")
