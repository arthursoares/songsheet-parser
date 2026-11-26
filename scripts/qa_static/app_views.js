// Tab switching + the Review, Preview (render/source/exports), and JSON
// (CodeMirror) views.
function showView(which) {
  if (!state.doc && which !== "shapes") which = "bars";
  const wasChordReview = state.activeView === "chordReview";
  const wasShapes = state.activeView === "shapes";
  const shapes = which === "shapes";
  const reviewing = which === "chordReview";
  if (state.activeView === "lyrics" && which !== "lyrics" &&
      typeof stopLyricResize === "function") stopLyricResize();
  if (state.activeView === "harmony" && which !== "harmony" &&
      typeof hmStopPlayback === "function") hmStopPlayback();
  if (state.activeView === "preview" && which !== "preview") setPreviewSnapshot(null);
  state.activeView = which;
  $("shapes")?.classList.toggle("hidden", !shapes);
  for (const [id, active] of [["workspaceSongs", !shapes], ["workspaceShapes", shapes]]) {
    const button = $(id);
    button?.classList.toggle("active", active);
    button?.setAttribute("aria-pressed", String(active));
  }
  $("bars").classList.toggle("hidden", which !== "bars" && !reviewing);
  $("chordReview").classList.toggle("hidden", !reviewing);
  $("chordReviewToggle").classList.toggle("active", reviewing);
  $("chordReviewToggle").setAttribute("aria-pressed", String(reviewing));
  $("chordReviewToggle").disabled = !state.doc || !state.doc.songs?.length;
  $("flagCount").classList.toggle("hidden", reviewing);
  $("editor").classList.toggle("hidden", which !== "bars");
  $("lyrics").classList.toggle("hidden", which !== "lyrics");
  $("review").classList.toggle("hidden", which !== "review");
  $("dict").classList.toggle("hidden", which !== "dict");
  $("harmony").classList.toggle("hidden", which !== "harmony");
  $("preview").classList.toggle("hidden", which !== "preview");
  $("json").classList.toggle("hidden", which !== "json");
  for (const [label, view] of [
    ["Bars", "bars"], ["Lyrics", "lyrics"], ["Review", "review"], ["Dict", "dict"],
    ["Harmony", "harmony"], ["Preview", "preview"], ["Json", "json"],
  ]) {
    const tab = $(`tab${label}`);
    tab.classList.toggle("active", which === view);
    tab.setAttribute("aria-pressed", String(which === view));
    tab.disabled = !state.doc && view !== "bars";
  }
  if (typeof updateChordReviewEntryPoint === "function") updateChordReviewEntryPoint();
  if (wasChordReview !== reviewing || wasShapes !== shapes) applyLayoutToggles();
  if (wasChordReview && !reviewing) syncChordChip(null);
  if (which === "lyrics") renderLyrics();
  if (which === "review") renderReview();
  if (which === "dict") renderDict();
  if (which === "harmony") renderHarmony();
  if (which === "preview") renderPreview();
  if (which === "json") renderJson();
  if (shapes) renderShapes();
}

async function openShapesForEntry(si, bi, ei) {
  if (state.dirty) {
    $("edErr").textContent = "Save the song before looking up its shape.";
    return;
  }
  const { album, file, songRevision } = state;
  const params = new URLSearchParams({
    album, file, song_index: "0", si, bi, ei, revision: songRevision || "",
  });
  showView("shapes");
  const hasShapesUI = typeof shapesUI === "object" && shapesUI !== null;
  if (hasShapesUI) {
    shapesUI.detailGeneration += 1;
    shapesUI.detailPending = true;
    shapesUI.detail = null;
    shapesUI.selected?.clear();
    if (typeof syncShapeControls === "function") syncShapeControls();
  }
  const detailGeneration = hasShapesUI ? shapesUI.detailGeneration : 0;
  const isCurrent = () => state.activeView === "shapes" && state.album === album &&
    state.file === file && (!hasShapesUI || shapesUI.detailGeneration === detailGeneration);
  const detailEl = typeof $ === "function" ? $("shapeDetail") : null;
  const reportStatus = (msg, kind) => {
    if (typeof setShapeStatus === "function") setShapeStatus(msg, kind);
  };
  const loadingHtml = (seconds = 0) =>
    `<div class="shape-empty">Finding matching shape in library index (first run may take 10–60s)…${seconds > 0 ? ` (${seconds}s)` : ""}</div>`;
  if (detailEl) detailEl.innerHTML = loadingHtml(0);
  reportStatus("Finding matching shape in library index…");
  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (!isCurrent()) return;
    const seconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
    if (detailEl) detailEl.innerHTML = loadingHtml(seconds);
    reportStatus(`Finding matching shape in library index… (${seconds}s)`);
  }, 1000);
  try {
    const result = await api(`/api/shapes/entry?${params}`);
    if (!isCurrent()) return;
    if (!result || result.error) throw new Error(result?.error || "Could not locate matching shape.");
    clearInterval(timer);
    if (hasShapesUI && shapesUI.detailGeneration === detailGeneration) {
      shapesUI.detailPending = false;
    }
    if (typeof openShapeGroup === "function") {
      await openShapeGroup(result.id, { library: true });
    }
  } catch (error) {
    if (isCurrent()) {
      const msg = String(error?.message || error || "Could not locate matching shape.");
      if (detailEl) {
        const safe = typeof esc === "function"
          ? esc(msg)
          : msg.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
        detailEl.innerHTML = `<div class="shape-error">${safe}</div>`;
      }
      reportStatus(msg, "error");
    }
  } finally {
    clearInterval(timer);
    if (hasShapesUI && shapesUI.detailGeneration === detailGeneration) {
      shapesUI.detailPending = false;
      if (typeof syncShapeControls === "function") syncShapeControls();
    }
  }
}

// ---- Raw JSON editor tab (CodeMirror 5) ----
// A CodeMirror instance backs the JSON tab: 2-space soft tabs, syntax coloring,
// and a custom live JSON linter (gutter markers + inline squiggle) that runs as
// you type. The existing Apply-time shape guard is unchanged. We mirror the
// editor's text into the hidden #jsonSource textarea so any legacy reader still
// works, but jsonGet()/jsonSet() are the canonical accessors.
let jsonCM = null;

// Derive a {line, ch} CodeMirror position from a JSON.parse error message.
// V8 reports "... at position N", Firefox reports "line L column C".
function jsonErrPos(cm, msg) {
  let m = /line (\d+) column (\d+)/i.exec(msg);
  if (m) return { line: Math.max(0, +m[1] - 1), ch: Math.max(0, +m[2] - 1) };
  m = /position (\d+)/i.exec(msg);
  if (m) return cm.posFromIndex(+m[1]);
  return { line: 0, ch: 0 };
}

// Custom CM lint helper: parse the text; on failure return one error annotation
// at the derived position (covering to end-of-line so it's visible).
function jsonLinter(text) {
  if (!text.trim()) return [];
  try { JSON.parse(text); return []; }
  catch (e) {
    const msg = String(e.message || e);
    const cm = jsonCM;
    const from = cm ? jsonErrPos(cm, msg) : { line: 0, ch: 0 };
    const to = cm
      ? { line: from.line, ch: (cm.getLine(from.line) || "").length }
      : { line: from.line, ch: from.ch + 1 };
    return [{ from, to, message: msg, severity: "error" }];
  }
}

// Lazily build the CodeMirror instance over #jsonEditor.
function ensureJsonCM() {
  if (jsonCM || typeof CodeMirror === "undefined") return jsonCM;
  CodeMirror.registerHelper("lint", "json", jsonLinter);
  jsonCM = CodeMirror($("jsonEditor"), {
    value: "",
    mode: { name: "javascript", json: true },
    theme: "material-darker",
    lineNumbers: true,
    tabSize: 2,
    indentUnit: 2,
    indentWithTabs: false,
    smartIndent: true,
    matchBrackets: true,
    autoCloseBrackets: true,
    styleActiveLine: false,
    lint: { getAnnotations: jsonLinter, async: false, lintOnChange: true, delay: 250 },
    gutters: ["CodeMirror-lint-markers", "CodeMirror-linenumbers"],
    extraKeys: {
      // 2-space soft tab; indent a multi-line selection.
      Tab(cm) {
        if (cm.somethingSelected()) cm.indentSelection("add");
        else cm.replaceSelection("  ", "end");
      },
      "Shift-Tab"(cm) { cm.indentSelection("subtract"); },
      // ⌘S / Ctrl+S → Save (let our global handler not be needed inside CM).
      "Cmd-S"(cm) { save(); },
      "Ctrl-S"(cm) { save(); },
    },
  });
  // Live validity feedback as the user types (debounced ~250ms), in addition to
  // the gutter lint markers. Mirror text into the hidden textarea.
  let t = null;
  jsonCM.on("change", () => {
    $("jsonSource").value = jsonCM.getValue();
    if (t) clearTimeout(t);
    t = setTimeout(jsonValidateLive, 250);
  });
  return jsonCM;
}

// Canonical text accessors (CM if present, else the textarea fallback).
function jsonGet() { return jsonCM ? jsonCM.getValue() : $("jsonSource").value; }
function jsonSet(text) {
  if (jsonCM) jsonCM.setValue(text);
  $("jsonSource").value = text;
}

// Debounced validity readout shown in #jsonMsg while typing.
function jsonValidateLive() {
  const text = jsonGet();
  if (!text.trim()) { jsonMsg("", ""); return; }
  try {
    JSON.parse(text);
    jsonMsg("valid ✓", "ok");
  } catch (e) {
    const msg = String(e.message || e);
    const pos = jsonCM ? jsonErrPos(jsonCM, msg) : { line: 0, ch: 0 };
    jsonMsg(`invalid — ${msg} (line ${pos.line + 1}, col ${pos.ch + 1})`, "err");
  }
}

// Populate the editor from the CURRENT in-memory document so it reflects
// unsaved edits made in other tabs. Refresh CM (it mis-measures while hidden).
function renderJson() {
  ensureJsonCM();
  if (!state.doc) { jsonSet(""); jsonMsg("", ""); if (jsonCM) jsonCM.refresh(); return; }
  jsonSet(JSON.stringify(state.doc, null, 2));
  jsonMsg("", "");
  if (jsonCM) setTimeout(() => jsonCM.refresh(), 0);
}

function jsonMsg(text, cls) {
  const el = $("jsonMsg");
  el.textContent = text;
  el.className = cls || "muted";
}

// Reload: repopulate from state.doc, discarding editor edits.
function jsonReload() {
  if (!state.doc) { jsonSet(""); jsonMsg("", ""); return; }
  jsonSet(JSON.stringify(state.doc, null, 2));
  jsonMsg("", "");
}

// Format: pretty-print the editor text if it parses; otherwise show the error
// and leave the text untouched.
function jsonFormat() {
  let parsed;
  try {
    parsed = JSON.parse(jsonGet());
  } catch (e) {
    jsonMsg(String(e.message || e), "err");
    return;
  }
  jsonSet(JSON.stringify(parsed, null, 2));
  jsonMsg("formatted ✓", "ok");
}

// Apply: parse + shape-guard, then swap state.doc and re-render. If re-render
// throws (structurally bad doc), restore the pre-apply snapshot so the app
// can't be left broken. Does NOT save — Save persists + schema-validates.
function jsonApply() {
  if (!state.doc) return;
  let parsed;
  try {
    parsed = JSON.parse(jsonGet());
  } catch (e) {
    jsonMsg(String(e.message || e), "err");
    return;
  }
  const shapeOk = parsed && parsed.document && Array.isArray(parsed.songs)
    && parsed.songs[0] && Array.isArray(parsed.songs[0].sections);
  if (!shapeOk) {
    jsonMsg("Bad shape: need { document, songs: [ { sections: [...] } ] }", "err");
    return;
  }
  pushUndo();
  state.doc = parsed;
  state.sel = null;
  $("editor").classList.remove("open");
  markDirty();
  try {
    rerenderAll();
  } catch (e) {
    // Re-render failed on the new doc — roll back to the snapshot we just pushed.
    state.doc = undoStack.pop();
    state.sel = null;
    try { rerenderAll(); } catch (e2) { /* best-effort recovery */ }
    jsonMsg("Could not apply: " + String(e.message || e), "err");
    return;
  }
  jsonMsg("applied ✓ — Save to persist", "ok");
}

// Switch to Bars, select the flagged chip, and open its editor.
function jumpToFlag(f) {
  jumpToEntry(f);
}

// ---- sequential chord review (the primary navigation) ----
// A full manual pass walks EVERY chord, not just flagged ones. ]/[ step
// through all non-'%' entries in document order, opening the editor on each.

// Ordered coords of every reviewable chord entry ('%' continuations carry no
// name/voicing to verify, so they are skipped).
function entryCoords() {
  const out = [];
  song().sections.forEach((sec, si) =>
    (sec.bars || []).forEach((bar, bi) =>
      bar.forEach((e, ei) => {
        if (e.chord !== "%") out.push({ si, bi, ei });
      })));
  return out;
}

function compareChordCoords(a, b) {
  return a.si - b.si || a.bi - b.bi || a.ei - b.ei;
}

function activeChordSelection() {
  return state.activeView === "chordReview"
    ? chordReviewCoords()[chordReview.index]
    : state.sel;
}

function jumpToEntry(c, { discardDraft = false, reopen = false } = {}) {
  const same = state.sel && compareChordCoords(c, state.sel) === 0;
  if (!discardDraft && !same && !confirmChordDraftDiscard()) {
    syncChordChip(state.sel, true);
    return;
  }
  showView("bars");
  if (same && !reopen && $("editor").classList.contains("open")) syncChordChip(c, true);
  else openEditor(c.si, c.bi, c.ei, true);
}

// Step to the next (+1) / previous (-1) chord entry, wrapping. With no
// selection, +1 starts at the first chord and -1 at the last.
function stepEntry(dir, options) {
  if (!state.doc) return;
  const coords = entryCoords();
  if (!coords.length) return;
  let idx = -1;
  if (state.sel) {
    idx = coords.findIndex((c) =>
      c.si === state.sel.si && c.bi === state.sel.bi && c.ei === state.sel.ei);
  }
  if (idx === -1) {
    jumpToEntry(dir > 0 ? coords[0] : coords[coords.length - 1], options);
    return;
  }
  jumpToEntry(coords[(idx + dir + coords.length) % coords.length], options);
}

function stepBar(dir) {
  if (!state.doc) return;
  const coords = entryCoords();
  const selection = activeChordSelection();
  const ordered = dir > 0 ? coords : coords.slice().reverse();
  const adjacent = ordered.find((c) => !selection ||
    dir * (c.si - selection.si || c.bi - selection.bi) > 0);
  if (!adjacent) {
    if (state.activeView === "chordReview") $("chordReviewMessage").textContent = "No more bars with chords in this direction.";
    return;
  }
  const first = coords.find((c) => c.si === adjacent.si && c.bi === adjacent.bi);
  if (state.activeView === "chordReview") selectChordReviewEntry(first);
  else jumpToEntry(first);
}

function stepFlagged(dir) {
  if (!state.doc) return;
  const flags = state.flags;
  if (!flags.length) { showView("review"); return; }
  const ordered = dir > 0 ? flags : flags.slice().reverse();
  const next = ordered.find((f) => !state.sel || dir * compareChordCoords(f, state.sel) > 0);
  jumpToFlag(next || ordered[0]);
}

function nextFlagged() { stepFlagged(1); }
function prevFlagged() { stepFlagged(-1); }

// Copy the generated ChordMark source (current in-memory edits) to the clipboard.
function copyChordmark() {
  const ta = $("cmSource");
  const msg = $("cmCopyMsg");
  const done = () => { msg.textContent = "✓ copied"; setTimeout(() => (msg.textContent = ""), 1500); };
  navigator.clipboard.writeText(ta.value).then(done, () => {
    ta.select(); document.execCommand("copy"); done();
  });
}

// Render the CURRENT in-memory doc (state.doc) — reflects UNSAVED edits, no Save
// required. POSTs the doc to render-doc (POST can't use iframe.src, so srcdoc).
// When the Source toggle is on, also fetch the generated .chordmark source text.
let previewRequest = 0;
let previewSnapshot = null;
const PREVIEW_EXPORTS = {
  pvExportHtml: "html", pvExportChordmark: "chordmark",
  pvExportChordpro: "chordpro", cmDownload: "chordmark",
};

function setPreviewSnapshot(snapshot) {
  previewSnapshot = snapshot;
  [...Object.keys(PREVIEW_EXPORTS), "pvExportPdf", "pvExportPng"].forEach((id) => {
    const button = $(id);
    if (button) button.disabled = !snapshot;
  });
}

async function renderPreview() {
  if (!state.doc) {
    previewRequest += 1;
    setPreviewSnapshot(null);
    $("previewFrame").srcdoc = "";
    $("cmSource").value = "";
    $("pvPreviewMsg").textContent = "No song loaded.";
    return;
  }
  const request = ++previewRequest;
  const { album, file, doc } = state;
  const isCurrent = () => request === previewRequest && state.activeView === "preview" &&
    state.album === album && state.file === file && state.doc === doc;
  setPreviewSnapshot(null);
  const frame = $("previewFrame");
  frame.srcdoc = "";
  const message = $("pvPreviewMsg");
  message.textContent = "Rendering…";
  const style = $("pvStyle").value;
  const dictionary = $("pvDict");
  const dict = dictionary.value;
  const diagrams = $("pvDiagrams").value;
  dictionary.disabled = style === "fork" || diagrams === "inline";
  const bars = $("pvBars").value;
  const showSource = $("pvSource").checked;
  // Source pane: textarea + control bar visibility tracks the toggle.
  $("cmSource").classList.toggle("hidden", !showSource);
  $("pvSourceBar").classList.toggle("hidden", !showSource);
  if (showSource) {
    $("cmSource").value = "";
    $("cmCopy").disabled = true;
  }

  const docBody = JSON.stringify(doc);
  try {
    const res = await fetch(
      `/api/render-doc?style=${style}&dict=${dict}&diagrams=${diagrams}&bars=${bars}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: docBody });
    const html = await res.text();
    if (!isCurrent()) return;
    frame.srcdoc = res.ok
      ? html.replace(/<head>/i, `$&<meta name="songsheet-preview" content="${request}">`)
      : html;
    const fallback = res.headers.get("X-Songsheet-Preview-Style") === "target";
    if (fallback) {
      dictionary.disabled = diagrams === "inline";
      message.textContent = res.headers.get("X-Songsheet-Preview-Reason") === "bar-layout"
        ? "Showing Lead Sheet to preserve this chart’s bar layout."
        : "Chord Chart renderer unavailable. Showing Lead Sheet.";
    } else {
      message.textContent = "";
    }
    if (res.ok) setPreviewSnapshot({
      album, file, docBody, request, style: fallback ? "target" : style, dict, diagrams, bars,
    });
  } catch (e) {
    if (!isCurrent()) return;
    message.textContent = "";
    frame.srcdoc = "<pre style='color:#b00;padding:20px'>preview failed: " + esc(e) + "</pre>";
  }

  if (showSource) {
    const ta = $("cmSource");
    try {
      const r = await fetch(`/api/chordmark-doc?bars=${bars}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: docBody });
      const source = await r.text();
      if (isCurrent()) {
        ta.value = r.ok ? source : "/* could not build ChordMark: " + source + " */";
        $("cmCopy").disabled = !r.ok;
      }
    } catch (e) {
      if (isCurrent()) ta.value = "/* failed to load ChordMark: " + e + " */";
    }
  }
}

// Wire the Export buttons. Each fetches the response as a Blob and triggers the
// download from a blob URL, so we get real completion feedback ("Exported ✓" /
// "Export failed: …") instead of a fire-and-forget anchor click.
function wireExport() {
  const a = (id) => encodeURIComponent(id);
  const flash = (m) => {
    const s = $("pvExportMsg");
    s.textContent = m;
    if (m) setTimeout(() => { if (s.textContent === m) s.textContent = ""; }, 2500);
  };

  // Filename from a Content-Disposition header, or a fallback.
  const filenameFrom = (res, fallback) => {
    const cd = res.headers.get("Content-Disposition") || "";
    const m = /filename="?([^"]+)"?/.exec(cd);
    return (m && m[1]) || fallback;
  };

  function download(blob, filename) {
    const objUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 4000);
  }

  function currentPreview() {
    const snapshot = previewSnapshot;
    if (!snapshot || snapshot.album !== state.album || snapshot.file !== state.file) {
      flash("Wait for the current preview before exporting.");
      return null;
    }
    return snapshot;
  }

  function loadedPreviewFrame(snapshot) {
    const frame = $("previewFrame");
    const marker = frame.contentDocument?.querySelector('meta[name="songsheet-preview"]');
    if (marker?.content !== String(snapshot.request)) throw new Error("Preview is still loading.");
    return frame;
  }

  // Fetch a URL, surface progress + completion as a toast, download the blob.
  async function exportBlob(url, pending, fallbackName, docBody) {
    flash(pending);
    try {
      const options = docBody ? {
        method: "POST", headers: { "Content-Type": "application/json" }, body: docBody,
      } : undefined;
      const res = await fetch(url, options);
      if (!res.ok) {
        let detail = res.status;
        try { const j = await res.json(); if (j && j.error) detail = j.error; } catch (e) { /* not json */ }
        flash("Export failed: " + detail);
        return;
      }
      const blob = await res.blob();
      download(blob, filenameFrom(res, fallbackName));
      flash("Exported ✓");
    } catch (e) {
      flash("Export failed: " + e);
    }
  }

  for (const [id, fmt] of Object.entries(PREVIEW_EXPORTS)) {
    $(id).addEventListener("click", () => {
      const snapshot = currentPreview();
      if (!snapshot) return;
      const { album, file, style, dict, diagrams, bars, docBody } = snapshot;
      const url = `/api/export-doc/${a(album)}/${a(file)}?fmt=${fmt}` +
        `&style=${style}&dict=${dict}&diagrams=${diagrams}&bars=${bars}`;
      exportBlob(url, `Exporting ${fmt}…`, `${file.replace(/\.json$/i, "")}.${fmt}`, docBody);
    });
  }
  $("pvExportPdf").addEventListener("click", () => {
    const snapshot = currentPreview();
    if (!snapshot) return;
    try {
      PreviewExport.printPreviewFrame(loadedPreviewFrame(snapshot));
    } catch (error) {
      flash("Print failed: " + error.message);
    }
  });
  $("pvExportPng").addEventListener("click", async () => {
    const snapshot = currentPreview();
    if (!snapshot) return;
    flash("Preparing PNG…");
    try {
      const blob = await PreviewExport.capturePreviewPng(loadedPreviewFrame(snapshot));
      download(blob, `${snapshot.file.replace(/\.json$/i, "")}.png`);
      flash("Exported ✓");
    } catch (error) {
      flash("PNG export failed: " + error.message);
    }
  });
  $("pvExportAlbum").addEventListener("click", async () => {
    if (!state.album) { flash("no album selected"); return; }
    flash("Preparing saved album…");
    try {
      const url = `/api/export-album/${a(state.album)}?fmt=html&dict=${$("pvDict").value}` +
        `&diagrams=${$("pvDiagrams").value}&bars=${$("pvBars").value}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Could not render saved album (HTTP ${res.status}).`);
      await PreviewExport.printChartHtml(await res.text());
      flash("");
    } catch (error) {
      flash("Print failed: " + error.message);
    }
  });
}
