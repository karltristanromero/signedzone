# Goal: PDF Signing & Version Comparison Web App

## Requirements

### 1. Document Management & Versions
- Allow users to upload a PDF.
- Store original documents in `./storage/{doc_id}/v1.pdf`.
- Save metadata (document ID, version number, timestamp, change summary) in an SQLite database.
- Whenever changes are committed, write an immutable new revision (`v2.pdf`, `v3.pdf`).

### 2. PDF Editor UI
- Render pages using PDF.js onto an HTML5 `<canvas>`.
- Allow adding custom text boxes with adjustable coordinates.
- Allow drawing freehand signatures on a signature canvas pad and placing them onto the document page.
- "Save New Version" button sends placement coordinates/signatures to the backend to burn into the next PDF revision.

### 3. Comparison & Version Diffing
- Provide a sidebar showing all historical revisions.
- Allow selecting two versions (e.g., v1 vs v2) to display side-by-side or as an opacity overlay to inspect additions.

## Execution Checklist
- [ ] Initialize project structure and `requirements.txt`.
- [ ] Build FastAPI backend endpoints for upload, fetch, sign, and versions.
- [ ] Build frontend in `static/index.html` and `static/app.js`.
- [ ] Create `test_app.py` to verify upload and signing flows headlessly.
- [ ] Start the development server and verify in browser.