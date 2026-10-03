pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const state = {
  docId: null,
  version: 1,
  versions: [],
  pdf: null,
  page: 1,
  pageCount: 1,
  scale: 1.4,
  pageSize: { width: 0, height: 0 }, // current page box, in PDF points
  items: [], // { kind: 'image'|'text', page, x, y, w, h, text?, data? }
  image: null, // { data, width, height } — the image staged for placement
  selected: -1, // index into state.items, -1 for none
  compare: {
    active: false, // the read-only comparison view is showing
    loading: false, // a comparePair request is in flight
    mode: "side", // "side" | "overlay"
    sync: true, // mirror scrolling between panes
    opacity: 0.5, // alpha of the newer revision in overlay mode
    panes: [], // { layers, page, pageCount, scale, scroller, canvas, ctx, pageEl }
    focus: 0, // pane the compare-bar zoom and page turns act on
    scrollLock: false, // breaks the sync-scroll feedback loop
  },
};

const $ = (id) => document.getElementById(id);
const canvas = $("pdfCanvas");
const ctx = canvas.getContext("2d");

// The overlay sits directly on top of the rendered page and owns all pointer
// input, so clicks place items and drags move/resize them.
const overlay = document.createElement("canvas");
overlay.className = "absolute";
overlay.style.position = "absolute";
$("canvasWrap").appendChild(overlay);
const octx = overlay.getContext("2d");

const HANDLE = 9; // resize grab square, in screen px

function toast(msg, isError = false) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden", "bg-slate-900", "bg-red-600");
  t.classList.add(isError ? "bg-red-600" : "bg-slate-900");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), isError ? 5000 : 2500);
}

// Every handler in this file is fire-and-forget async, so without this a failed
// request would fail completely silently.
window.addEventListener("unhandledrejection", (e) => {
  console.error(e.reason);
  toast(e.reason?.message || String(e.reason) || "Something went wrong", true);
});

async function api(path, options = {}) {
  const res = await fetch(path, options);
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))).detail;
    throw new Error(Array.isArray(detail) ? detail[0]?.msg || res.statusText : detail || res.statusText);
  }
  return res;
}

/* ---------- document / version lists ---------- */

async function loadDocuments() {
  const { documents } = await (await api("/documents")).json();
  const ul = $("docList");
  ul.innerHTML = "";
  documents.forEach((d) => {
    const li = document.createElement("li");
    li.className = "p-1 rounded cursor-pointer hover:bg-slate-100 flex justify-between";
    li.innerHTML = `<span class="truncate">${d.filename}</span><span class="text-xs text-slate-400">v${d.latest_version || 1}</span>`;
    li.onclick = () => openDocument(d.doc_id);
    ul.appendChild(li);
  });
}

async function loadVersions(docId) {
  const { versions } = await (await api(`/versions/${docId}`)).json();
  state.versions = versions;
  const ul = $("versionList");
  ul.innerHTML = "";
  const selA = $("cmpA");
  const selB = $("cmpB");
  selA.innerHTML = "";
  selB.innerHTML = "";

  versions.forEach((v) => {
    const li = document.createElement("li");
    li.className = "p-1 rounded cursor-pointer hover:bg-slate-100 flex justify-between";
    li.innerHTML = `<span>v${v.version_number}</span><span class="text-xs text-slate-400 truncate ml-2">${v.stored_at.slice(0, 19).replace("T", " ")}</span>`;
    li.onclick = () => openVersion(v.version_number);
    ul.appendChild(li);

    for (const sel of [selA, selB]) {
      const o = document.createElement("option");
      o.value = v.version_number;
      o.textContent = `v${v.version_number}`;
      sel.appendChild(o);
    }
  });
  if (versions.length > 1) {
    selA.value = versions[versions.length - 2].version_number;
    selB.value = versions[versions.length - 1].version_number;
  }
}

/* ---------- rendering ---------- */

async function loadPdf(version) {
  const url = `/doc/${state.docId}/v${version}.pdf`;
  state.pdf = await pdfjsLib.getDocument(url).promise;
  state.pageCount = state.pdf.numPages;
  $("pageCount").textContent = state.pageCount;
  if (state.page > state.pageCount) state.page = 1;
  await renderPage();
}

async function renderPage() {
  const page = await state.pdf.getPage(state.page);
  const viewport = page.getViewport({ scale: state.scale });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: ctx, viewport }).promise;

  // Remember the page box in PDF points so placement can be clamped to it.
  const unit = page.getViewport({ scale: 1 });
  state.pageSize = { width: unit.width, height: unit.height };

  const wrap = $("canvasWrap");
  // Position the overlay from live rects rather than offsetLeft: the overlay's
  // containing block is #canvasWrap (it is position:relative), and this stays
  // correct regardless of any positioning added to the ancestors in between.
  const wrapRect = wrap.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  overlay.style.left = `${canvasRect.left - wrapRect.left + wrap.scrollLeft}px`;
  overlay.style.top = `${canvasRect.top - wrapRect.top + wrap.scrollTop}px`;
  overlay.width = canvas.width;
  overlay.height = canvas.height;
  overlay.style.cursor = state.image ? "copy" : "default";
  drawOverlay();

  $("pageNum").textContent = state.page;
}

/* Repaint whichever view is live: the editor canvas or the compare panes. */
function repaint() {
  if (state.compare.active) state.compare.panes.forEach(renderPane);
  else if (state.pdf) renderPage();
}

const imgCache = new Map();

/* state.items carry 0-based page indexes because that is what the API expects;
   the UI shows 1-based page numbers to the user. */
const pageIndex = () => state.page - 1;

/* ---------- placement geometry (all values in PDF points) ---------- */

const MIN_SIZE = 10;

function clampToPage(item) {
  const pw = state.pageSize.width || item.w;
  const ph = state.pageSize.height || item.h;
  item.w = Math.max(MIN_SIZE, Math.min(item.w, pw));
  item.h = Math.max(MIN_SIZE, Math.min(item.h, ph));
  item.x = Math.max(0, Math.min(item.x, pw - item.w));
  item.y = Math.max(0, Math.min(item.y, ph - item.h));
  return item;
}

function itemAt(px, py) {
  // Topmost first, and search back to front so the newest item wins.
  for (let i = state.items.length - 1; i >= 0; i--) {
    const it = state.items[i];
    if (it.page !== pageIndex()) continue;
    if (px >= it.x && px <= it.x + it.w && py >= it.y && py <= it.y + it.h) return i;
  }
  return -1;
}

function handleAt(px, py) {
  if (state.selected < 0) return -1;
  const it = state.items[state.selected];
  if (!it || it.page !== pageIndex()) return -1;
  const pad = HANDLE / state.scale;
  const hx = it.x + it.w;
  const hy = it.y + it.h;
  if (Math.abs(px - hx) <= pad && Math.abs(py - hy) <= pad) return state.selected;
  return -1;
}

function screenToPage(evt) {
  const rect = canvas.getBoundingClientRect();
  return { x: (evt.clientX - rect.left) / state.scale, y: (evt.clientY - rect.top) / state.scale };
}

function newImageAt(px, py) {
  const pct = Math.min(100, Math.max(1, parseFloat($("imgWidth").value) || 25));
  const w = state.pageSize.width * (pct / 100);
  const h = w * (state.image.height / state.image.width);
  // Only builds the item: every caller pushes it into state.items itself.
  return clampToPage({
    kind: "image",
    page: pageIndex(),
    x: px - w / 2,
    y: py - h / 2,
    w,
    h,
    data: state.image.data,
  });
}

function drawOverlay() {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  state.items.forEach((i, idx) => {
    if (i.page !== pageIndex()) return;
    const x = i.x * state.scale;
    const y = i.y * state.scale;
    const w = i.w * state.scale;
    const h = i.h * state.scale;
    const selected = idx === state.selected;
    octx.strokeStyle = i.kind === "image" ? "#059669" : "#4f46e5";
    octx.lineWidth = selected ? 2.5 : 1.5;
    octx.setLineDash(selected ? [] : [5, 4]);
    octx.strokeRect(x, y, w, h);
    octx.setLineDash([]);
    if (i.kind === "image") {
      const el = imgCache.get(i.data);
      if (el) {
        octx.globalAlpha = 0.7;
        octx.drawImage(el, x, y, w, h);
        octx.globalAlpha = 1;
      }
    } else if (i.text) {
      octx.fillStyle = "rgba(79,70,229,0.15)";
      octx.fillRect(x, y, w, h);
      octx.fillStyle = "#4f46e5";
      octx.font = "12px sans-serif";
      octx.fillText(i.text.slice(0, 40), x + 4, y + 14);
    }
    if (selected) {
      octx.fillStyle = "#fff";
      octx.strokeStyle = i.kind === "image" ? "#059669" : "#4f46e5";
      octx.lineWidth = 2;
      octx.fillRect(x + w - HANDLE / 2, y + h - HANDLE / 2, HANDLE, HANDLE);
      octx.strokeRect(x + w - HANDLE / 2, y + h - HANDLE / 2, HANDLE, HANDLE);
    }
  });
  renderItemList();
}

/* ---------- pointer interaction on the page ---------- */

let drag = null;

overlay.onpointerdown = (e) => {
  if (!state.pdf) return;
  const { x, y } = screenToPage(e);
  const resizing = handleAt(x, y);
  if (resizing >= 0) {
    const it = state.items[resizing];
    drag = { mode: "resize", idx: resizing, ratio: it.h / it.w, w: it.w, h: it.h };
    overlay.setPointerCapture(e.pointerId);
    return;
  }
  const hit = itemAt(x, y);
  if (hit >= 0) {
    state.selected = hit;
    const it = state.items[hit];
    drag = { mode: "move", idx: hit, dx: x - it.x, dy: y - it.y, moved: false };
    overlay.setPointerCapture(e.pointerId);
    drawOverlay();
    return;
  }
  if (state.image) {
    state.selected = state.items.push(newImageAt(x, y)) - 1;
    toast("Placed — drag to move, drag the corner to resize.");
  } else {
    state.selected = -1;
  }
  drawOverlay();
};

overlay.onpointermove = (e) => {
  const { x, y } = screenToPage(e);
  if (!drag) {
    overlay.style.cursor =
      handleAt(x, y) >= 0 ? "nwse-resize" : state.image ? "copy" : "default";
    return;
  }
  const it = state.items[drag.idx];
  if (drag.mode === "move") {
    drag.moved = true;
    it.x = x - drag.dx;
    it.y = y - drag.dy;
  } else {
    // Preserve the aspect ratio so resizing never distorts the image.
    const w = Math.max(MIN_SIZE, x - it.x);
    it.w = w;
    it.h = w * drag.ratio;
  }
  clampToPage(it);
  drawOverlay();
};

function endDrag(e) {
  if (!drag) return;
  if (e && overlay.hasPointerCapture(e.pointerId)) overlay.releasePointerCapture(e.pointerId);
  drag = null;
}

overlay.onpointerup = endDrag;
overlay.onpointercancel = endDrag;

document.addEventListener("keydown", (e) => {
  if (state.selected < 0) return;
  if (e.key === "Delete" || e.key === "Backspace") {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    e.preventDefault();
    state.items.splice(state.selected, 1);
    state.selected = -1;
    drawOverlay();
  }
});

function renderItemList() {
  const ul = $("itemList");
  ul.innerHTML = "";
  const has = state.items.length > 0;
  ul.classList.toggle("hidden", !has);
  ul.classList.toggle("flex", has);
  if (!has) return;
  state.items.forEach((it, idx) => {
    const li = document.createElement("li");
    li.className =
      "item-chip flex items-center gap-1 border rounded px-2 py-0.5 cursor-pointer " +
      (idx === state.selected ? "border-indigo-500 bg-indigo-50" : "hover:bg-slate-50");
    const label =
      it.kind === "image" ? `Image p${it.page + 1}` : `"${it.text}" p${it.page + 1}`;
    li.innerHTML = `<span class="truncate max-w-[9rem]">${label}</span>`;
    li.onclick = () => {
      state.selected = idx;
      if (it.page !== pageIndex()) state.page = it.page + 1;
      renderPage().then(drawOverlay);
    };
    const del = document.createElement("button");
    del.className = "text-red-500 font-bold";
    del.textContent = "x";
    del.title = "Remove";
    del.onclick = (e) => {
      e.stopPropagation();
      state.items.splice(idx, 1);
      if (state.selected === idx) state.selected = -1;
      drawOverlay();
    };
    li.appendChild(del);
    ul.appendChild(li);
  });
}

/* ---------- sidebar ---------- */

const desktopMQ = window.matchMedia("(min-width: 1024px)");

const sidebarOpen = () => !$("sidebar").classList.contains("hidden");

function setSidebar(open) {
  const sb = $("sidebar");
  sb.classList.toggle("hidden", !open);
  sb.classList.toggle("flex", open);
  // The toggle floats over main's top-left corner: clear room for it — below
  // the sidebar content when open, in the viewer toolbar when closed.
  sb.classList.toggle("pt-14", open);
  $("viewerBar").classList.toggle("pl-12", !open);
  $("compareBar").classList.toggle("pl-12", !open);
  $("sidebarToggle").setAttribute("aria-expanded", String(open));
  // Toggling changes the viewer's width, so re-anchor whichever view is live.
  requestAnimationFrame(repaint);
}

/* ---------- document lifecycle ---------- */

async function openDocument(docId) {
  state.docId = docId;
  state.items = [];
  state.selected = -1;
  // A comparison belongs to the document it was opened from.
  if (state.compare.active) await exitCompare(true);
  // Below lg the sidebar floats over the viewer — put it away once used.
  if (!desktopMQ.matches) setSidebar(false);
  await loadVersions(docId);
  // Open the newest revision rather than v1: /versions comes back ascending, so the
  // last entry is the latest. Keeps state.version in step with what is on screen.
  const latest = state.versions.length ? state.versions[state.versions.length - 1].version_number : 1;
  state.version = latest;
  await loadPdf(latest);
}

async function openVersion(version) {
  if (state.compare.active) await exitCompare(true);
  state.version = version;
  state.items = [];
  state.selected = -1;
  await loadPdf(version);
  toast(`Viewing v${version}`);
}

$("uploadInput").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);
  const res = await (await api("/upload", { method: "POST", body: fd })).json();
  toast(res.message);
  await loadDocuments();
  await openDocument(res.doc_id);
  e.target.value = "";
};

$("prevPage").onclick = async () => {
  if (state.page > 1) {
    state.page--;
    await renderPage();
  }
};
$("nextPage").onclick = async () => {
  if (state.page < state.pageCount) {
    state.page++;
    await renderPage();
  }
};

$("addText").onclick = async () => {
  if (!state.pdf) return toast("Upload a PDF first");
  const text = prompt("Text to add:");
  if (!text) return;
  const page = await state.pdf.getPage(state.page);
  const vp = page.getViewport({ scale: 1 });
  state.items.push({
    kind: "text",
    page: pageIndex(),
    x: vp.width * 0.15,
    y: vp.height * 0.15,
    w: vp.width * 0.5,
    h: 24,
    text,
  });
  drawOverlay();
};

/* ---------- image insertion ---------- */

function clearStagedImage() {
  state.image = null;
  $("imagePreview").classList.add("hidden");
  $("imageMeta").classList.add("hidden");
  $("imageMeta").textContent = "";
  $("imageInput").value = "";
  setStagedBar(false);
  overlay.style.cursor = "default";
}

/* The staging controls live in the viewer toolbar and only appear while an
   image is staged, so they cost no space otherwise. */
function setStagedBar(on) {
  const bar = $("stagedBar");
  bar.classList.toggle("hidden", !on);
  bar.classList.toggle("flex", on);
}

$("imageInput").onchange = async (e) => {
  const input = e.target;
  const file = input.files && input.files[0];
  if (!file) return;

  try {
    if (!file.type.startsWith("image/")) {
      toast("That is not an image file", true);
      input.value = "";
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      toast("Image is over 12 MB — pick a smaller one", true);
      input.value = "";
      return;
    }

    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("the file could not be read"));
      reader.readAsDataURL(file);
    });

    const el = new Image();
    el.src = dataUrl;
    try {
      await el.decode();
    } catch {
      throw new Error("the browser could not decode it");
    }

    // Re-encode to PNG before we ever talk to the server: PyMuPDF cannot read
    // WebP/SVG/AVIF even though the browser renders them, and normalising here
    // also means the preview is exactly what gets embedded.
    const MAX_DIM = 4000;
    const ratio = Math.min(1, MAX_DIM / Math.max(el.naturalWidth, el.naturalHeight));
    const cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round(el.naturalWidth * ratio));
    cv.height = Math.max(1, Math.round(el.naturalHeight * ratio));
    cv.getContext("2d").drawImage(el, 0, 0, cv.width, cv.height);
    const png = cv.toDataURL("image/png");

    state.image = { data: png.split(",")[1], width: cv.width, height: cv.height };
    imgCache.set(state.image.data, el);
    $("imagePreview").src = png;
    $("imagePreview").classList.remove("hidden");
    $("imageMeta").textContent = `${file.name} — ${cv.width}x${cv.height} PNG`;
    $("imageMeta").classList.remove("hidden");
    setStagedBar(true);
    overlay.style.cursor = "copy";
    toast("Image loaded — click anywhere on the page to place it.");
  } catch (err) {
    console.error(err);
    clearStagedImage();
    toast(`Could not import that image: ${err.message}`, true);
  } finally {
    input.value = "";
  }
};

$("clearImage").onclick = clearStagedImage;

$("openPlace").onclick = () => $("imageInput").click();

$("placeCentre").onclick = () => {
  if (!state.pdf) return toast("Upload a PDF first");
  if (!state.image) return toast("Choose an image first", true);
  state.selected = state.items.push(
    newImageAt(state.pageSize.width / 2, state.pageSize.height / 2)
  ) - 1;
  drawOverlay();
};

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  // Escape leaves the read-only comparison before it clears a selection.
  if (state.compare.active) return exitCompare();
  state.selected = -1;
  drawOverlay();
});

/* ---------- save version ---------- */

$("saveVersion").onclick = async () => {
  if (!state.docId) return toast("Upload a PDF first");
  const body = {
    doc_id: state.docId,
    change_summary: $("changeSummary").value,
    images: state.items
      .filter((i) => i.kind === "image")
      .map((i) => ({ page: i.page, x: i.x, y: i.y, w: i.w, h: i.h, data: i.data })),
    text_boxes: state.items.filter((i) => i.kind === "text").map((i) => ({ page: i.page, x: i.x, y: i.y, w: i.w, h: i.h, text: i.text })),
  };
  if (!body.images.length && !body.text_boxes.length) {
    return toast("Nothing to save — place an image or a text box first", true);
  }
  try {
    const res = await (await api("/sign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })).json();
    toast(`${res.message} (v${res.new_version})`);
    $("changeSummary").value = "";
    state.items = [];
    await loadVersions(state.docId);
    await loadDocuments();
    await openVersion(res.new_version);
  } catch (err) {
    // Keep the pending placements so the user can retry or switch format.
    toast(`Save failed: ${err.message}`, true);
  }
};

/* ---------- zoom ---------- */

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.1;

const clampZoom = (v) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(v * 100) / 100));

/* A diff is only useful if both panes show the same magnification, so while Sync
   is on one zoom click moves every pane and the working pane together. With Sync
   off each pane keeps its own scale, which is how you zoom one region of a
   revision against a full-page view of the other. */
function applyZoom(target, scale) {
  const s = clampZoom(scale);
  if (state.compare.sync) {
    state.scale = s;
    state.compare.panes.forEach((p) => {
      p.scale = s;
    });
  } else if (target === "editor") {
    state.scale = s;
  } else if (target) {
    target.scale = s;
  }
  repaint();
  renderZoom();
}

/* The compare bar's buttons act on whichever pane was last paged or scrolled;
   the editor bar's act on state.scale. */
function zoomTarget(el) {
  return el.closest("#compareBar") ? state.compare.panes[state.compare.focus] : "editor";
}

function stepZoom(el, dir) {
  const target = zoomTarget(el);
  if (target !== "editor" && !target) return;
  applyZoom(target, (target === "editor" ? state.scale : target.scale) + dir * ZOOM_STEP);
}

function renderZoom() {
  const editor = $("viewerBar").querySelector("[data-zoom-val]");
  if (editor) editor.textContent = `${Math.round(state.scale * 100)}%`;
  const compare = $("compareBar").querySelector("[data-zoom-val]");
  if (!compare) return;
  const pane = state.compare.panes[state.compare.focus];
  compare.textContent = `${Math.round((pane ? pane.scale : state.scale) * 100)}%`;
}

document.querySelectorAll("[data-zoom-step]").forEach((btn) => {
  btn.onclick = () => stepZoom(btn, Number(btn.dataset.zoomStep));
});

/* ---------- comparison ----------
   A reversible, read-only view. It renders into its own #compareWrap and must
   never touch #canvasWrap, #pdfCanvas or the overlay: that is what lets
   exitCompare() hand the editor back exactly as it was, uncommitted
   state.items included. Compare panes are viewers only — placing and saving
   stay in the working pane. */

const fraction = (v, max) => (max > 0 ? v / max : 0);

/* Panes scroll in their own containers so two revisions of different page sizes
   can be linked proportionally instead of sharing one scrollbar. */
function saveScroll(pane) {
  const s = pane.scroller;
  return {
    x: fraction(s.scrollLeft, s.scrollWidth - s.clientWidth),
    y: fraction(s.scrollTop, s.scrollHeight - s.clientHeight),
  };
}

function applyScroll(pane, saved) {
  const s = pane.scroller;
  const mx = s.scrollWidth - s.clientWidth;
  const my = s.scrollHeight - s.clientHeight;
  if (mx > 0) s.scrollLeft = saved.x * mx;
  if (my > 0) s.scrollTop = saved.y * my;
}

function syncScroll(source) {
  state.compare.focus = Math.max(0, state.compare.panes.indexOf(source));
  if (!state.compare.active || !state.compare.sync || state.compare.scrollLock) return;
  state.compare.scrollLock = true;
  const from = saveScroll(source);
  state.compare.panes.forEach((p) => {
    if (p !== source) applyScroll(p, from);
  });
  // Released on the next frame: scroll events are dispatched per element, so
  // clearing the lock synchronously would let the panes echo back and drift.
  requestAnimationFrame(() => {
    state.compare.scrollLock = false;
  });
}

function paneEl(label, note) {
  const el = document.createElement("div");
  el.className = "flex-1 min-w-0 flex flex-col min-h-0";
  el.innerHTML = `
    <div class="flex items-center gap-2 pb-2 text-xs text-slate-600">
      <span data-label class="font-semibold text-slate-800"></span>
      <span data-note class="text-slate-400 truncate"></span>
      <span class="flex-1"></span>
      <button data-d="-1" type="button" title="Previous page" class="px-1.5 py-0.5 border rounded text-slate-500 hover:bg-slate-100">&larr;</button>
      <span data-page class="tabular-nums whitespace-nowrap text-slate-500"></span>
      <button data-d="1" type="button" title="Next page" class="px-1.5 py-0.5 border rounded text-slate-500 hover:bg-slate-100">&rarr;</button>
    </div>
    <div data-scroll class="relative flex-1 min-h-0 overflow-auto rounded bg-slate-300/40 p-2">
      <canvas class="block mx-auto bg-white shadow"></canvas>
    </div>`;
  el.querySelector("[data-label]").textContent = label;
  el.querySelector("[data-note]").textContent = note;
  return el;
}

/* layers are ordered oldest -> newest, so index 0 is always the bottom. */
async function buildPane(layers, label, base) {
  const el = paneEl(label, "");
  const pane = {
    layers,
    page: Math.min(Math.max(state.page, 1), Math.min(...layers.map((l) => l.doc.numPages))),
    pageCount: Math.min(...layers.map((l) => l.doc.numPages)),
    scale: state.scale,
    scroller: el.querySelector("[data-scroll]"),
    canvas: el.querySelector("canvas"),
    ctx: null,
    pageEl: el.querySelector("[data-page]"),
  };
  pane.ctx = pane.canvas.getContext("2d");
  el.querySelectorAll("button[data-d]").forEach((btn) => {
    btn.onclick = () => stepPane(pane, parseInt(btn.dataset.d, 10));
  });
  pane.scroller.addEventListener("scroll", () => syncScroll(pane));
  el.querySelector("[data-note]").textContent = paneNote(pane, base);
  $("compareWrap").appendChild(el);
  return pane;
}

/* One turner moves every pane while Sync is on; each clamps to its own page
   count, so revisions of different lengths stay side by side. */
function stepPane(pane, delta) {
  state.compare.focus = Math.max(0, state.compare.panes.indexOf(pane));
  const targets = state.compare.sync ? state.compare.panes : [pane];
  let moved = false;
  targets.forEach((p) => {
    const next = Math.min(Math.max(p.page + delta, 1), p.pageCount);
    if (next === p.page) return;
    p.page = next;
    moved = true;
  });
  if (moved) targets.forEach(renderPane);
}

async function renderPane(pane) {
  // Rapid clicks can leave two renders in flight; only the newest may paint.
  const token = (pane.token = (pane.token || 0) + 1);
  const scroll = saveScroll(pane);
  // Each layer is drawn offscreen first: PDF.js paints straight into whatever
  // context it is handed, so blending two of them in place would accumulate
  // alpha instead of mixing them.
  const shots = [];
  for (const layer of pane.layers) {
    const page = await layer.doc.getPage(Math.min(pane.page, layer.doc.numPages));
    const vp = page.getViewport({ scale: pane.scale });
    const off = document.createElement("canvas");
    off.width = vp.width;
    off.height = vp.height;
    await page.render({ canvasContext: off.getContext("2d"), viewport: vp }).promise;
    shots.push(off);
  }
  if (token !== pane.token) return;
  const base = shots[0];
  pane.canvas.width = base.width;
  pane.canvas.height = base.height;
  pane.ctx.clearRect(0, 0, base.width, base.height);
  pane.ctx.drawImage(base, 0, 0);
  shots.slice(1).forEach((s) => {
    pane.ctx.globalAlpha = state.compare.opacity;
    pane.ctx.drawImage(s, 0, 0);
    pane.ctx.globalAlpha = 1;
  });
  pane.pageEl.textContent = `Page ${pane.page} / ${pane.pageCount}`;
  applyScroll(pane, scroll);
}

/* Revisions can differ in length; a pane can only show the pages they share. */
function paneNote(pane, base) {
  const extra = pane.layers
    .filter((l) => l.doc.numPages !== pane.pageCount)
    .map((l) => `v${l.version} has ${l.doc.numPages}`);
  return extra.length ? `${base} · ${extra.join(", ")}` : base;
}

async function exitCompare(quiet = false) {
  const wasActive = state.compare.active;
  state.compare.active = false;
  state.compare.panes.forEach((p) =>
    p.layers.forEach((l) => Promise.resolve(l.doc.destroy()).catch(() => {}))
  );
  state.compare.panes = [];
  $("compareWrap").innerHTML = "";
  $("compareWrap").classList.add("hidden");
  $("compareBar").classList.add("hidden");
  $("canvasWrap").classList.remove("hidden");
  $("viewerBar").classList.remove("hidden");
  $("editFooter").classList.remove("hidden");
  if (wasActive && !quiet) {
    renderPage();
    toast("Back to the editor");
  }
  renderZoom();
}

async function enterCompare(mode) {
  if (!state.docId) return toast("Open a document first", true);
  const a = parseInt($("cmpA").value, 10);
  const b = parseInt($("cmpB").value, 10);
  if (!a || !b) return toast("Need at least one version", true);
  if (a === b) return toast("Pick two different revisions", true);
  if (state.compare.loading) return;
  state.compare.loading = true;
  $("compareSide").disabled = true;
  $("compareOverlay").disabled = true;

  try {
    // Sorted so the older revision is always the lower layer, whichever <select>
    // the user happened to leave on top.
    const versions = [a, b].sort((x, y) => x - y);
    const docs = await Promise.all(
      versions.map((v) => pdfjsLib.getDocument(`/doc/${state.docId}/v${v}.pdf`).promise)
    );
    await exitCompare(true);
    state.compare.mode = mode;
    state.compare.active = true;
    state.compare.focus = 0;

    $("canvasWrap").classList.add("hidden");
    $("viewerBar").classList.add("hidden");
    $("editFooter").classList.add("hidden");
    $("compareBar").classList.remove("hidden");
    $("compareWrap").classList.remove("hidden");
    $("compareMode").textContent = mode === "side" ? "Side by side" : "Overlay (opacity)";
    $("opacityWrap").classList.toggle("hidden", mode !== "overlay");
    $("opacityWrap").classList.toggle("inline-flex", mode === "overlay");

    if (mode === "side") {
      state.compare.panes = [
        await buildPane([{ version: versions[0], doc: docs[0] }], `v${versions[0]}`, "older — left"),
        await buildPane([{ version: versions[1], doc: docs[1] }], `v${versions[1]}`, "newer — right"),
      ];
    } else {
      state.compare.panes = [
        await buildPane(
          [
            { version: versions[0], doc: docs[0] },
            { version: versions[1], doc: docs[1] },
          ],
          `v${versions[0]} → v${versions[1]}`,
          "newer blended on top"
        ),
      ];
    }
    await Promise.all(state.compare.panes.map(renderPane));
    renderZoom();
    toast(mode === "side" ? "Comparing side by side — older revision on the left" : "Comparing as an overlay — older revision underneath");
  } finally {
    state.compare.loading = false;
    $("compareSide").disabled = false;
    $("compareOverlay").disabled = false;
  }
}

$("compareSide").onclick = () => enterCompare("side");
$("compareOverlay").onclick = () => enterCompare("overlay");
$("exitCompare").onclick = () => exitCompare();

$("compareSync").onchange = (e) => {
  state.compare.sync = e.target.checked;
};

$("compareOpacity").oninput = (e) => {
  state.compare.opacity = parseInt(e.target.value, 10) / 100;
  $("opacityVal").textContent = `${e.target.value}%`;
  // Only the overlay mode has more than one layer per pane.
  const blended = state.compare.panes.find((p) => p.layers.length > 1);
  if (blended) renderPane(blended);
};

$("sidebarToggle").onclick = () => setSidebar(!sidebarOpen());

// Below lg the sidebar is a drawer over the viewer: dismiss it on an outside
// tap so it can never strand the page.
document.addEventListener("click", (e) => {
  if (desktopMQ.matches || !sidebarOpen()) return;
  if ($("sidebar").contains(e.target) || $("sidebarToggle").contains(e.target)) return;
  setSidebar(false);
});

window.addEventListener("resize", repaint);

// Keep the readout honest even though the markup starts at the default scale.
renderZoom();

loadDocuments();
