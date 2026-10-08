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
  pageSize, items, image, selected, compare`. All wiring is `onclick` assignment at the bottom.
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
- Layout rules the viewer cannot work without: `main` must stay a *bounded* flex
  row (`relative flex-1 min-h-0 flex`) inside `body: h-screen overflow-hidden
  flex flex-col` — its children stretch to its height, which is what gives
  `#canvasWrap` a working scrollbar instead of growing into empty space — and
  `#canvasWrap` needs `relative` (otherwise the overlay's containing block is the
  viewport, it doesn't scroll with the canvas, and hit-testing drifts by the
  scroll offset). Never reintroduce `calc(100vh-Npx)` header arithmetic.
- There is no left/right pane pair any more: `#sidebar` (documents + revisions)
  hangs off the bookmark tab (`#sidebarToggle`, absolute top-left of `main`) via
  `setSidebar()`, which
  shows it as an inline column on `lg+` and as an absolute drawer over the viewer
  below that; because toggling moves the canvas, `setSidebar()` re-runs
  `renderPage()` on the next frame or the overlay detaches. The tab is a **half-disc**
  (`h-7 w-14`, flat top, `rounded-b-full` in `styles.css`) whose `aria-expanded`
  drives an in-plane `rotate(180deg)` turn — in-plane, never `rotateX`/`translate`,
  because the turn must keep the disc inside its own box or `main`'s
  `overflow-hidden` clips the bulge — and `setSidebar()` unfurls `#sidebar` with a
  WAAPI `animate()` from `transform-origin: top`. Closed, the tab overlaps the
  viewer toolbar, so `#viewerBar`/`#compareBar` carry `pl-16` (64px = the tab's
  56px width + an 8px gap at `left-4`) and `setSidebar()` toggles that class —
  don't fall back to `pl-12`, and don't shrink the tab without re-deriving both.
  The image staging
  controls live in the toolbar's `#stagedBar` (visible only while an image is
  staged) and the placed-item chips in `#itemList` under the canvas — both hide
  themselves when empty.
- Handlers are fire-and-forget async, so an `unhandledrejection` listener plus a
  try/catch in `saveVersion` surface failures as toasts. Don't add a bare
  `await api(...)`.

## Gotchas
- **Comparison is a reversible, read-only mode.** It renders into its own
  `#compareWrap` (sibling of `#canvasWrap` inside the viewer `<section>`) and
  **must never mutate `#canvasWrap`'s children, its inline styles, or
  `overlay`** — that single rule is what lets `exitCompare()` hand the editor
  back untouched, uncommitted `state.items` included. `#viewerBar` and
  `#editFooter` hide while comparing and `#compareBar` takes their place;
  `Escape` exits.
- A compare pane is `{ layers, page, pageCount, scale, scroller, canvas, ctx,
  pageEl }`. Layers are ordered **oldest → newest**, so index 0 is always the
  bottom — `enterCompare()` sorts `cmpA`/`cmpB` ascending regardless of which
  `<select>` the user touched. Side-by-side = one layer per pane (older left);
  overlay = both layers in one pane. `pageCount` is the **minimum** across
  layers, since a pane can only show the pages the revisions share. (In practice
  `/sign` never adds or removes pages, so revisions of one document always match.)
- Panes seed from `state.page`, not 1, and each owns its scroll container so
  two revisions of different page sizes can be linked.
- **`Sync` (`#compareSync`) governs paging, scrolling *and* zoom.** On: one `‹ ›`
  click moves every pane (each clamped to its own `pageCount`), scroll mirrors
  as a **fraction** under `state.compare.scrollLock` (released on the next
  `requestAnimationFrame` — releasing it synchronously lets the panes echo back
  and drift), and `applyZoom()` writes one scale to `state.scale` *and* every
  `pane.scale`. Off: each pane keeps its own page and scale, which is how you
  zoom one region against a full-page view of the other.
- Zoom controls exist in **both** `#viewerBar` and `#compareBar`, marked up as
  `data-zoom-step` / `data-zoom-val` and wired by one `querySelectorAll`, so
  never bind them by id. The editor's scale is `state.scale` (persists across
  documents); a pane's is `pane.scale`. The compare bar's buttons act on
  `state.compare.panes[state.compare.focus]` — `focus` tracks the pane last paged
  or scrolled, so paging pane 0 then pressing `+` zooms pane 0, not pane 1.
  `ZOOM_MIN`/`MAX` 0.25–4, step 0.1.
- `renderPane()` draws every layer into a throwaway canvas before compositing:
  PDF.js paints straight into whatever context it is handed, so blending two
  renders in place would accumulate alpha. It also carries a `pane.token` so a
  rapid `‹ ›` can't let a stale render paint last.
- `repaint()` re-renders whichever view is live (panes while comparing, else
  `renderPage()`); `setSidebar()` and the `resize` listener both call it, so
  don't re-add an `if (state.compare.active)` branch of your own.
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