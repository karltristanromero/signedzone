import os
import uuid
import base64
import binascii
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.requests import Request
from pydantic import BaseModel, ConfigDict
import fitz  # pymupdf

app = FastAPI()

DB_PATH = Path("./storage/database.db")
STORAGE_DIR = Path("./storage")

# Ensure directories exist
STORAGE_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

# Mount static files
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.middleware("http")
async def revalidate_static_assets(request: Request, call_next):
    """Force browsers to revalidate app.js / index.html on every load.

    There is no build step here, so filenames never change between edits. Without
    an explicit Cache-Control the browser is free to apply *heuristic* freshness
    and reuse a stale app.js for hours, which silently strands the rest of the
    script: any $("...") lookup for a removed element throws at load time and
    every handler below that line is never wired up. Revalidation is cheap (the
    304 carries no body), so correctness wins over it.
    """
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response


class SignBody(BaseModel):
    # extra="forbid" so a payload from an older client (e.g. the pre-insert-image
    # `signatures` field) is rejected loudly instead of being silently dropped.
    model_config = ConfigDict(extra="forbid")

    doc_id: str
    change_summary: str = ""
    images: list = []
    text_boxes: list = []


def decode_image(data) -> bytes:
    """Decode a bare base64 image payload, rejecting anything PyMuPDF can't open."""
    if not isinstance(data, str) or not data:
        raise HTTPException(status_code=400, detail="Image data is missing")
    try:
        raw = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail="Image data is not valid base64")
    if not raw:
        raise HTTPException(status_code=400, detail="Image data is empty")
    try:
        fitz.Pixmap(raw)
    except Exception:
        raise HTTPException(
            status_code=400,
            detail="Image is in a format the server cannot read (PNG, JPEG, BMP, GIF, TIFF)",
        )
    return raw


def get_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS documents (
            doc_id TEXT PRIMARY KEY,
            filename TEXT,
            created_at TEXT,
            change_summary TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS versions (
            version_id INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id TEXT,
            version_number INTEGER,
            filename TEXT,
            stored_at TEXT,
            FOREIGN KEY (doc_id) REFERENCES documents(doc_id)
        )
        """
    )
    conn.commit()
    conn.close()


init_db()


def save_metadata(doc_id: str, filename: str, change_summary: str = ""):
    conn = get_db()
    conn.execute(
        "INSERT OR REPLACE INTO documents (doc_id, filename, created_at, change_summary) VALUES (?, ?, ?, ?)",
        (doc_id, filename, datetime.now(timezone.utc).isoformat(), change_summary),
    )
    conn.execute(
        "INSERT INTO versions (doc_id, version_number, filename, stored_at) VALUES (?, 1, ?, ?)",
        (doc_id, f"{doc_id}/v1.pdf", datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()
    conn.close()


def get_versions(doc_id: str):
    conn = get_db()
    rows = conn.execute(
        "SELECT version_number, filename, stored_at FROM versions WHERE doc_id = ? ORDER BY version_number",
        (doc_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_version_filepath(doc_id: str, version: int):
    return STORAGE_DIR / doc_id / f"v{version}.pdf"


@app.post("/upload")
async def upload_pdf(file: UploadFile = File(...)):
    doc_id = str(uuid.uuid4())
    doc_dir = STORAGE_DIR / doc_id
    doc_dir.mkdir(parents=True, exist_ok=True)

    # Save the uploaded PDF
    file_path = doc_dir / "v1.pdf"
    content = await file.read()
    with open(file_path, "wb") as f:
        f.write(content)

    # Save metadata
    save_metadata(doc_id, file.filename or "unknown.pdf")

    return {"doc_id": doc_id, "version": 1, "message": "PDF uploaded successfully"}


@app.get("/doc/{doc_id}")
async def fetch_doc(doc_id: str):
    doc_dir = STORAGE_DIR / doc_id
    v1_path = doc_dir / "v1.pdf"
    if not v1_path.exists():
        raise HTTPException(status_code=404, detail="Document not found")
    return FileResponse(str(v1_path))


@app.get("/doc/{doc_id}/v{version}.pdf")
async def fetch_version(doc_id: str, version: int):
    filepath = get_version_filepath(doc_id, version)
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="Version not found")
    return FileResponse(str(filepath))


@app.post("/sign")
async def save_new_version(body: SignBody):
    doc_id = body.doc_id
    change_summary = body.change_summary
    images = body.images
    text_boxes = body.text_boxes

    conn = get_db()
    # Get current max version
    max_ver = conn.execute(
        "SELECT MAX(version_number) FROM versions WHERE doc_id = ?", (doc_id,)
    ).fetchone()[0]
    new_version = (max_ver or 0) + 1

    # Copy previous version as base, then annotate
    prev_filepath = get_version_filepath(doc_id, new_version - 1)
    new_dir = STORAGE_DIR / doc_id
    new_filepath = new_dir / f"v{new_version}.pdf"

    if new_filepath.exists():
        conn.close()
        raise HTTPException(status_code=409, detail=f"Version {new_version} already exists")

    import shutil
    if not prev_filepath.exists():
        conn.close()
        raise HTTPException(status_code=404, detail="Base version not found")

    def resolve_size(item):
        w, h = float(item.get("w", 0)), float(item.get("h", 0))
        if w <= 0 or h <= 0:
            raise HTTPException(status_code=400, detail="Placement needs a positive width and height")
        return w, h

    # Validate sizes and image bytes before touching the filesystem, so a bad
    # payload never leaves a half-written revision behind.
    placements = []
    for img in images:
        resolve_size(img)
        placements.append(("image", img.get("page", 0), img, {"stream": decode_image(img.get("data", ""))}))
    for tb in text_boxes:
        resolve_size(tb)
        placements.append(
            ("text", tb.get("page", 0), tb, {"text": tb.get("text", ""), "size": float(tb.get("size", 12))})
        )

    shutil.copy2(str(prev_filepath), str(new_filepath))

    # Annotate the new PDF with images and text boxes
    doc = fitz.open(str(new_filepath))
    if doc.page_count == 0:
        doc.close()
        conn.close()
        raise HTTPException(status_code=400, detail="No pages in PDF")

    pages_cache = {}

    def resolve_page(page_index):
        idx = max(0, min(int(page_index or 0), doc.page_count - 1))
        if idx not in pages_cache:
            pages_cache[idx] = doc[idx]
        return pages_cache[idx]

    def clamp_to_page(item, target):
        """Keep a placement entirely inside the page box.

        The client clamps too, but the API must not trust that: a rect hanging
        off the edge would burn a half-visible image into the revision.
        """
        page_rect = target.rect
        w, h = resolve_size(item)
        x, y = float(item.get("x", 0)), float(item.get("y", 0))
        x0, y0 = max(x, page_rect.x0), max(y, page_rect.y0)
        x1, y1 = min(x + w, page_rect.x1), min(y + h, page_rect.y1)
        if x1 - x0 <= 0 or y1 - y0 <= 0:
            raise HTTPException(status_code=400, detail="Placement lies entirely outside the page")
        return fitz.Rect(x0, y0, x1, y1)

    try:
        for kind, page_index, item, opts in placements:
            target = resolve_page(page_index)
            rect = clamp_to_page(item, target)
            if kind == "image":
                target.insert_image(rect, stream=opts["stream"], keep_proportion=False)
            else:
                target.draw_rect(rect, color=(0.4, 0.4, 0.9), width=1)
                target.insert_textbox(
                    rect,
                    opts["text"],
                    fontsize=opts["size"],
                    fontname="helv",
                    color=(0, 0, 0),
                )

        # Save via a temp file: PyMuPDF cannot overwrite the document it has open
        tmp_path = new_dir / f".v{new_version}.tmp.pdf"
        doc.save(str(tmp_path))
        tmp_path.replace(new_filepath)
    except HTTPException:
        doc.close()
        conn.close()
        new_filepath.unlink(missing_ok=True)
        raise
    except Exception as exc:
        doc.close()
        conn.close()
        new_filepath.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"Could not write revision: {exc}")
    doc.close()

    # Save version metadata
    conn.execute(
        "INSERT INTO versions (doc_id, version_number, filename, stored_at) VALUES (?, ?, ?, ?)",
        (doc_id, new_version, f"{doc_id}/v{new_version}.pdf", datetime.now(timezone.utc).isoformat()),
    )
    # Update documents change summary
    conn.execute(
        "UPDATE documents SET change_summary = ? WHERE doc_id = ?",
        (change_summary, doc_id),
    )
    conn.commit()
    conn.close()

    return {
        "doc_id": doc_id,
        "new_version": new_version,
        "message": "Version saved with images and text boxes",
    }


@app.get("/documents")
async def list_documents():
    conn = get_db()
    rows = conn.execute(
        """
        SELECT d.doc_id, d.filename, d.created_at, d.change_summary,
               (SELECT MAX(version_number) FROM versions WHERE doc_id = d.doc_id) AS latest_version
        FROM documents d
        ORDER BY d.created_at DESC
        """
    ).fetchall()
    conn.close()
    return {"documents": [dict(r) for r in rows]}


@app.get("/versions/{doc_id}")
async def list_versions(doc_id: str):
    versions = get_versions(doc_id)
    return {"doc_id": doc_id, "versions": versions}


@app.get("/")
async def root():
    return FileResponse(str(Path("static") / "index.html"))
