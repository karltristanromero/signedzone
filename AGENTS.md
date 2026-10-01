# Signly — PDF Image Insertion & Version Comparison

FastAPI + vanilla JS. The signature pad was **removed**; the feature is now
**insert image** (pick a file → stage with preview → click/drag on the page).
Backend payload field `signatures` → `images`. Suite **11/11**.

## Commands — always via `.venv` (system/conda/pyenv lack the deps)
```bash
./run.sh                                   # 127.0.0.1:8000  (PORT=N to change)
./.venv/bin/python -m pytest test_app.py -q
```
Never bare `uvicorn` / `python -m uvicorn` — that was a past `No module named 'click'`.

## Files
`app.py` = the entire backend. `static/` = `index.html` + `app.js` + `styles.css`,
no build step / bundler. `test_app.py` = pytest, monkeypatches `DB_PATH`/`STORAGE_DIR`
to `tmp_path`. `storage/{doc_id}/vN.pdf` = immutable revisions; `storage/database.db`
= metadata. `app/` is an **empty leftover directory** — the backend is `app.py`,
not a package. Scratch files go in `/tmp`. This **is** a git repo (branch `master`,
no commits yet) and `.gitignore` excludes `storage/`, `.venv/` and caches — but do
not commit or push unless explicitly asked.

## Stack
Python 3.14, FastAPI 0.141, Uvicorn 0.54, stdlib `sqlite3` (so **no `sqlite` entry**
in `requirements.txt`), `pymupdf` imported as `import fitz`. Browser: PDF.js 3.11.174
+ Tailwind CDN, `pdfjsLib` global.

## API
| Method | Path | Notes |
|---|---|---|
| GET | `/` | SPA |
| GET | `/static/*` | `Cache-Control: no-cache` |
| POST | `/upload` | multipart field `file` → `{doc_id, version: 1}` |
| GET | `/doc/{id}`, `/doc/{id}/v{n}.pdf` | 404 if missing |
| POST | `/sign` | `SignBody` → `{doc_id, new_version}` |
| GET | `/documents`, `/versions/{id}` | |

`SignBody` = `{doc_id, change_summary="", images=[], text_boxes=[]}` with
`extra="forbid"`. Item = `{page, x, y, w, h, data?|text?|size?}`; coords are **PDF
points, origin top-left**, from `getViewport({scale:1})`; `page` is **0-based**
(client sends `state.page - 1`); `data` is bare base64 with no `data:` prefix.

## Invariants — do not break
1. Revisions are immutable: `/sign` copies `v{n-1}.pdf` → `v{n}.pdf`, forward only.
2. Save via `.vN.tmp.pdf` then `replace()` — PyMuPDF cannot save over its own open file.
3. Version number is `MAX(version_number) + 1`, never a client counter.
4. `state.items` holds uncommitted work only; cleared on save and on doc/version switch.
5. `init_db()` runs at import time; tests must monkeypatch the paths first.
6. Validate the **whole** payload before `shutil.copy2`, and unlink the copied
   `vN.pdf` on failure — a stray revision makes the next request hit a 409.
7. `clamp_to_page()` every placement against `target.rect` (overhang trimmed,
   fully outside → 400). The client clamps too, but the API must not trust it.
   Keep `except HTTPException: raise` **before** the generic `except`, or a 400
   is reported as a 500.
8. `extra="forbid"` is deliberate: Pydantic silently dropping `images` was the
   original "my image vanished" bug.
9. The client re-encodes every pick to PNG. PyMuPDF reads **PNG, JPEG, BMP, GIF,
   TIFF** — not WebP/SVG/AVIF, which browsers render happily.
10. `/` and `/static/*` send `Cache-Control: no-cache`; only `/doc/*.pdf` stays
    cacheable since revisions never change. A stale cached `app.js` strands every
    handler below the first failed `$()` lookup — check the Console for a
    load-time TypeError before blaming a handler.

## Frontend (`static/app.js`)
- Module `state`: `docId, version, versions, pdf, page, pageCount, scale (1.4),
  pageSize, items, image, selected`. All wiring is `onclick` assignment at the bottom.
- Stacked canvases: `#pdfCanvas` (render) plus a created `overlay` appended to
  `#canvasWrap`. **The overlay owns all pointer input** (deliberately *not*
  `pointer-events-none`): pointerdown on the resize handle → resize keeping the
  aspect ratio, else on an item → move, else with an image staged → place centred
  on the click, else deselect. `Delete` removes, `Escape` clears, `pointercancel`
  ends drags so a scroll can't strand one.
- `pageIndex()` is `state.page - 1`; the item chips display `it.page + 1`.
- `renderPage()` stores `state.pageSize` (the scale-1 viewport); `clampToPage()`
  caps `w`/`h` to the page then pins `x`/`y` into `0 .. page - size`, on create,
  move and resize alike. `drawOverlay()` scales points by `state.scale` and
  previews placed images from `imgCache` at 70% alpha.
- Two layout rules the viewer cannot work without: `main` needs `lg:grid-rows-1`
  (a grid row defaults to `auto` = *content* height, so the pane grows to the whole
  canvas, `lg:overflow-hidden` clips it, and the scrollbar dies), and
  `#canvasWrap` needs `relative` (otherwise the overlay's containing block is the
  viewport, it doesn't scroll with the canvas, and hit-testing drifts by the
  scroll offset). Layout is `body: h-screen overflow-hidden flex flex-col` +
  `main: flex-1 min-h-0`; never reintroduce `calc(100vh-Npx)` header arithmetic.
- Handlers are fire-and-forget async, so an `unhandledrejection` listener plus a
  try/catch in `saveVersion` surface failures as toasts. Don't add a bare
  `await api(...)`.

## Gotchas
- **`comparePair()` is destructive**: it wipes `#canvasWrap`, destroys
  `#pdfCanvas` and `overlay.remove()`s the overlay — only a page reload recovers.
  Comparison renders page 1 only.
- **Never `rmtree` anything under `./storage` to clean up a manual test.**
  `Path(STORAGE_DIR) / ""` collapses to `STORAGE_DIR`, so one failed upload whose
  `doc_id` came back empty wipes the entire library including `database.db`. That
  happened here and lost five documents. Tear down test servers by port, never by
  deleting files; put fixtures in `/tmp`; if you must delete, assert the id is a
  real UUID and the resolved path is a strict child of `STORAGE_DIR` first.
- Coordinate math assumes no page rotation.
- Adding item fields means extending the mappers in the `saveVersion` handler.

## Workflow
Backend first, then frontend, then verification. Keep the backend in `app.py`.
Extend `test_app.py` for any backend change and keep it green; tests must never
touch the real `./storage`. Verify frontend changes in a browser at
`http://127.0.0.1:8000` and report the toast / network result actually observed —
never assume success. Notify the user once per `task.md` milestone.