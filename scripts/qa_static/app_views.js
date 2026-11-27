// Tab switching + the Review, Preview (render/source/exports), and JSON
// (CodeMirror) views.
function showView(which) {
  if (!state.doc && which !== "shapes") which = "bars";
  if (state.activeView === "lyrics" && which !== "lyrics" &&
      typeof confirmLyricDraftDiscard === "function" && !confirmLyricDraftDiscard()) return false;
  if (state.activeView === "chordReview" && which !== "chordReview" &&
      $("editor").classList.contains("editor-inline")) {
    if (state.doc && !confirmChordDraftDiscard()) return false;
    closeChordEditor();
  }
  if (state.activeView === "json" && which !== "json" && hasUnappliedJsonEdits()) {
    if (typeof confirm === "function" && !confirm("Discard unapplied JSON edits?")) return false;
    resetJsonEditorState();
  }
  const wasChordReview = state.activeView === "chordReview";
  const wasShapes = state.activeView === "shapes";
  if (which === "shapes" && !wasShapes) state.lastSongView = state.activeView;
  const shapes = which === "shapes";
  const reviewing = which === "chordReview";
  if (state.activeView === "lyrics" && which !== "lyrics" &&
      typeof stopLyricResize === "function") stopLyricResize();
  if (state.activeView === "harmony" && which !== "harmony" &&
      typeof hmStopPlayback === "function") hmStopPlayback();
  if (state.activeView === "preview" && which !== "preview") setPreviewSnapshot(null);
  state.activeView = which;
  if (typeof hmSyncBackLink === "function") hmSyncBackLink();
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
  if (!reviewing) $("flagCount").textContent = String(state.flags?.length || 0);
  $("editor").classList.toggle("hidden", which !== "bars" && !reviewing);
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
    tab.setAttribute("aria-selected", String(which === view || (reviewing && view === "bars")));
    tab.tabIndex = which === view || (reviewing && view === "bars") ? 0 : -1;
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
let jsonDirty = false;
let jsonBaselineText = "";
let jsonHasBaseline = false;
let jsonValidateTimer = null;
let jsonLastErrPos = null;
let jsonMsgWired = false;

function clearJsonValidateTimer() {
  if (jsonValidateTimer) {
    if (typeof clearTimeout === "function") clearTimeout(jsonValidateTimer);
    jsonValidateTimer = null;
  }
}

function hasUnappliedJsonEdits() {
  return Boolean(state.doc && (jsonDirty || (jsonHasBaseline && jsonGet() !== jsonBaselineText)));
}

function updateJsonDirtyBadge() {
  const badge = $("jsonDirtyBadge");
  if (!badge) return;
  const dirty = hasUnappliedJsonEdits();
  badge.hidden = !dirty;
  badge.classList?.toggle("hidden", !dirty);
}

function updateJsonDirtyState() {
  jsonDirty = Boolean(state.doc && jsonHasBaseline && jsonGet() !== jsonBaselineText);
  updateJsonDirtyBadge();
  return jsonDirty;
}

function resetJsonEditorState() {
  clearJsonValidateTimer();
  jsonHasBaseline = false;
  jsonBaselineText = "";
  jsonDirty = false;
  jsonLastErrPos = null;
  jsonSet("");
  updateJsonDirtyState();
  jsonMsg("", "");
}

function posFromTextIndex(text, index) {
  const clamped = Math.max(0, Math.min(index, text.length));
  let line = 0;
  let lastNl = -1;
  for (let i = 0; i < clamped; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      lastNl = i;
    }
  }
  return { line, ch: clamped - lastNl - 1 };
}

// Derive a {line, ch} CodeMirror position from a JSON.parse error message.
// V8 reports "... at position N", Firefox reports "line L column C".
// Return null when the runtime (e.g. Safari) omits position details.
function jsonErrPos(cm, msg) {
  let m = /line (\d+) column (\d+)/i.exec(msg);
  if (m) return { line: Math.max(0, +m[1] - 1), ch: Math.max(0, +m[2] - 1) };
  m = /position (\d+)/i.exec(msg);
  if (m) {
    const idx = +m[1];
    if (cm && typeof cm.posFromIndex === "function") return cm.posFromIndex(idx);
    return posFromTextIndex(jsonGet(), idx);
  }
  return null;
}

// Custom CM lint helper: parse the text; on failure return one error annotation
// at the derived position (covering to end-of-line so it's visible).
function jsonLinter(text) {
  if (!text.trim()) return [];
  try { JSON.parse(text); return []; }
  catch (e) {
    const msg = String(e.message || e);
    const cm = jsonCM;
    const pos = cm ? jsonErrPos(cm, msg) : null;
    const from = pos || { line: 0, ch: 0 };
    const to = cm
      ? { line: from.line, ch: (cm.getLine(from.line) || "").length }
      : { line: from.line, ch: from.ch + 1 };
    return [{ from, to, message: msg, severity: "error" }];
  }
}

function jumpToJsonError() {
  if (!jsonCM || !jsonLastErrPos) return false;
  if (typeof jsonCM.focus === "function") jsonCM.focus();
  if (typeof jsonCM.setCursor === "function") jsonCM.setCursor(jsonLastErrPos);
  if (typeof jsonCM.scrollIntoView === "function") jsonCM.scrollIntoView(jsonLastErrPos, 80);
  return true;
}

function wireJsonMsgJump() {
  if (jsonMsgWired) return;
  const el = $("jsonMsg");
  if (!el || typeof el.addEventListener !== "function") return;
  jsonMsgWired = true;
  el.addEventListener("click", jumpToJsonError);
  el.addEventListener("keydown", (event) => {
    if (!jsonLastErrPos || !["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    jumpToJsonError();
  });
}

// Lazily build the CodeMirror instance over #jsonEditor.
function ensureJsonCM() {
  if (jsonCM || typeof CodeMirror === "undefined") return jsonCM;
  CodeMirror.registerHelper("lint", "json", jsonLinter);
  jsonCM = CodeMirror($("jsonEditor"), {
    screenReaderLabel: "Song JSON editor",
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
      // ⌘S / Ctrl+S → apply unapplied JSON edits first, then Save.
      "Cmd-S"() {
        if (hasUnappliedJsonEdits() && !jsonApply()) return;
        if (typeof save === "function") save();
      },
      "Ctrl-S"() {
        if (hasUnappliedJsonEdits() && !jsonApply()) return;
        if (typeof save === "function") save();
      },
      // ⌘Enter / Ctrl+Enter → Apply JSON edits to model.
      "Cmd-Enter"() { jsonApply(); },
      "Ctrl-Enter"() { jsonApply(); },
    },
  });
  // Live validity feedback as the user types (debounced ~250ms), in addition to
  // the gutter lint markers. Mirror text into the hidden textarea and update
  // unapplied-edit state synchronously.
  jsonCM.on("change", () => {
    const ta = $("jsonSource");
    if (ta) ta.value = jsonCM.getValue();
    updateJsonDirtyState();
    clearJsonValidateTimer();
    jsonValidateTimer = setTimeout(jsonValidateLive, 250);
  });
  wireJsonMsgJump();
  return jsonCM;
}

// Canonical text accessors (CM if present, else the textarea fallback).
function jsonGet() {
  if (jsonCM) return jsonCM.getValue();
  const ta = $("jsonSource");
  return ta ? ta.value : "";
}
function jsonSet(text) {
  if (jsonCM) jsonCM.setValue(text);
  const ta = $("jsonSource");
  if (ta) ta.value = text;
  clearJsonValidateTimer();
}

function setJsonSyntaxError(prefix, err) {
  const msg = String((err && err.message) || err);
  const pos = jsonErrPos(jsonCM, msg);
  jsonLastErrPos = pos;
  const loc = pos ? ` (line ${pos.line + 1}, col ${pos.ch + 1})` : "";
  jsonMsg(`${prefix}${msg}${loc}`, "err");
}

// Debounced validity readout shown in #jsonMsg while typing.
function jsonValidateLive() {
  const text = jsonGet();
  if (!text.trim()) {
    jsonLastErrPos = null;
    jsonMsg("", "");
    updateJsonDirtyState();
    return;
  }
  try {
    JSON.parse(text);
    jsonLastErrPos = null;
    jsonMsg("valid ✓", "ok");
  } catch (e) {
    setJsonSyntaxError("invalid — ", e);
  }
  updateJsonDirtyState();
}

// Populate the editor from the CURRENT in-memory document so it reflects
// unsaved edits made in other tabs. Refresh CM (it mis-measures while hidden).
function renderJson() {
  ensureJsonCM();
  wireJsonMsgJump();
  if (!state.doc) {
    resetJsonEditorState();
    if (jsonCM) jsonCM.refresh();
    return;
  }
  if (hasUnappliedJsonEdits()) {
    updateJsonDirtyBadge();
    if (jsonCM) setTimeout(() => jsonCM.refresh(), 0);
    return;
  }
  const text = JSON.stringify(state.doc, null, 2);
  jsonBaselineText = text;
  jsonHasBaseline = true;
  jsonLastErrPos = null;
  jsonSet(text);
  updateJsonDirtyState();
  jsonMsg("", "");
  if (jsonCM) setTimeout(() => jsonCM.refresh(), 0);
}

function jsonMsg(text, cls) {
  const el = $("jsonMsg");
  if (!el) return;
  const jumpable = cls === "err" && Boolean(jsonLastErrPos);
  el.textContent = text;
  el.className = (cls || "muted") + (jumpable ? " jumpable" : "");
  el.title = jumpable ? "Click to jump to error" : "";
  el.setAttribute("role", jumpable ? "button" : "status");
  el.tabIndex = jumpable ? 0 : -1;
}

// Reload: repopulate from state.doc, confirming if unapplied edits exist.
function jsonReload() {
  if (hasUnappliedJsonEdits() && typeof confirm === "function" &&
      !confirm("Discard unapplied JSON edits?")) {
    return;
  }
  if (!state.doc) { resetJsonEditorState(); return; }
  const text = JSON.stringify(state.doc, null, 2);
  jsonBaselineText = text;
  jsonHasBaseline = true;
  jsonLastErrPos = null;
  jsonSet(text);
  updateJsonDirtyState();
  jsonMsg("", "");
}

// Format: pretty-print the editor text if it parses, preserving CodeMirror undo
// history and cursor/scroll position; otherwise show the error untouched.
function jsonFormat() {
  let parsed;
  try {
    parsed = JSON.parse(jsonGet());
  } catch (e) {
    setJsonSyntaxError("invalid — ", e);
    return;
  }
  const formatted = JSON.stringify(parsed, null, 2);
  if (jsonCM) {
    if (jsonCM.getValue() !== formatted) {
      const cursor = typeof jsonCM.getCursor === "function" ? jsonCM.getCursor() : null;
      const scroll = typeof jsonCM.getScrollInfo === "function" ? jsonCM.getScrollInfo() : null;
      const lastLine = jsonCM.lastLine();
      const endCh = (jsonCM.getLine(lastLine) || "").length;
      const applyReplace = () => {
        jsonCM.replaceRange(formatted, { line: 0, ch: 0 }, { line: lastLine, ch: endCh }, "+format");
        if (cursor) {
          const maxLine = jsonCM.lastLine();
          const line = Math.min(cursor.line, maxLine);
          const ch = Math.min(cursor.ch, (jsonCM.getLine(line) || "").length);
          jsonCM.setCursor({ line, ch });
        }
        if (scroll && typeof jsonCM.scrollTo === "function") {
          jsonCM.scrollTo(scroll.left, scroll.top);
        }
      };
      if (typeof jsonCM.operation === "function") jsonCM.operation(applyReplace);
      else applyReplace();
      clearJsonValidateTimer();
    }
  } else {
    const ta = $("jsonSource");
    if (ta) ta.value = formatted;
  }
  jsonLastErrPos = null;
  updateJsonDirtyState();
  jsonMsg("formatted ✓", "ok");
}

function jsonEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!jsonEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const keysA = Object.keys(a).filter((k) => a[k] !== undefined);
  const keysB = Object.keys(b).filter((k) => b[k] !== undefined);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || b[k] === undefined || !jsonEqual(a[k], b[k])) {
      return false;
    }
  }
  return true;
}

// Apply: parse + shape-guard, then swap state.doc and re-render. If re-render
// throws (structurally bad doc), restore the pre-apply snapshot so the app
// can't be left broken. Does NOT save — Save persists + schema-validates.
function jsonApply() {
  if (!state.doc) return false;
  let parsed;
  try {
    parsed = JSON.parse(jsonGet());
  } catch (e) {
    setJsonSyntaxError("", e);
    return false;
  }
  const shapeOk = parsed && parsed.document && Array.isArray(parsed.songs)
    && parsed.songs[0] && Array.isArray(parsed.songs[0].sections);
  if (!shapeOk) {
    jsonLastErrPos = null;
    jsonMsg("Bad shape: need { document, songs: [ { sections: [...] } ] }", "err");
    return false;
  }
  if (jsonEqual(parsed, state.doc)) {
    jsonBaselineText = jsonGet();
    jsonHasBaseline = true;
    jsonLastErrPos = null;
    updateJsonDirtyState();
    clearJsonValidateTimer();
    jsonMsg(state.dirty ? "no model changes — Save to persist" : "no model changes", "ok");
    return true;
  }
  const wasDirty = Boolean(state.dirty);
  const prevEditVersion = state.editVersion || 0;
  const statusEl = $("saveStatus");
  const prevStatusText = statusEl ? statusEl.textContent : "";
  const prevStatusColor = statusEl && statusEl.style ? statusEl.style.color : "";
  pushUndo();
  state.doc = parsed;
  state.sel = null;
  $("editor")?.classList.remove("open");
  markDirty();
  try {
    rerenderAll();
  } catch (e) {
    // Re-render failed on the new doc — roll back to the snapshot we just pushed.
    state.doc = undoStack.pop();
    state.sel = null;
    state.dirty = wasDirty;
    state.editVersion = prevEditVersion;
    if (statusEl) {
      statusEl.textContent = prevStatusText;
      if (statusEl.style) statusEl.style.color = prevStatusColor;
    }
    try { rerenderAll(); } catch (e2) { /* best-effort recovery */ }
    jsonLastErrPos = null;
    jsonMsg("Could not apply: " + String(e.message || e), "err");
    updateJsonDirtyState();
    return false;
  }
  jsonBaselineText = jsonGet();
  jsonHasBaseline = true;
  jsonLastErrPos = null;
  updateJsonDirtyState();
  clearJsonValidateTimer();
  jsonMsg("applied ✓ — Save to persist", "ok");
  return true;
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
  if (state.activeView !== "chordReview" && !discardDraft && !same && !confirmChordDraftDiscard()) {
    syncChordChip(state.sel, true);
    return;
  }
  if (showView("bars") === false) return;
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
let previewLoaded = false;
let previewExportPending = false;
let previewSourceRequest = 0;
const PREVIEW_EXPORTS = {
  pvExportHtml: "html", pvExportChordmark: "chordmark",
  pvExportChordpro: "chordpro",
};

function setPreviewSnapshot(snapshot, loaded = false) {
  previewSnapshot = snapshot;
  previewLoaded = loaded;
  syncPreviewExportControls();
}

function syncPreviewExportControls() {
  [...Object.keys(PREVIEW_EXPORTS), "pvExportPdf", "pvExportPng"].forEach((id) => {
    const button = $(id);
    const needsFrame = id === "pvExportPdf" || id === "pvExportPng";
    if (button) button.disabled = previewExportPending || !previewSnapshot || (needsFrame && !previewLoaded);
  });
  if ($("pvExportAlbum")) $("pvExportAlbum").disabled = previewExportPending || !state.album;
}

function previewMessage(text, error = false) {
  const message = $("pvPreviewMsg");
  message.textContent = text;
  if (message.dataset) message.dataset.kind = error ? "error" : "info";
  message.setAttribute?.("role", error ? "alert" : "status");
}

async function togglePreviewSource() {
  const show = $("pvSource").checked;
  $("cmSource").classList.toggle("hidden", !show);
  $("pvSourceBar").classList.toggle("hidden", !show);
  const request = ++previewSourceRequest;
  const snapshot = previewSnapshot;
  if (!show || !snapshot) return;
  const ta = $("cmSource"), copy = $("cmCopy");
  if ($("pvPreviewMsg").dataset?.kind === "error") previewMessage("");
  if (snapshot.source !== undefined) {
    ta.value = snapshot.source;
    if (copy) copy.disabled = false;
    return;
  }
  ta.value = "Generating source…";
  if (copy) copy.disabled = true;
  try {
    const response = await fetch(`/api/chordmark-doc?bars=${snapshot.bars}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: snapshot.docBody,
    });
    const source = await response.text();
    if (request !== previewSourceRequest || snapshot !== previewSnapshot) return;
    if (!response.ok) throw new Error(source);
    snapshot.source = source;
    ta.value = source;
    if (copy) copy.disabled = false;
  } catch (error) {
    if (request !== previewSourceRequest || snapshot !== previewSnapshot) return;
    ta.value = "";
    previewMessage(`Could not build ChordMark: ${error.message}`, true);
  }
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
  if (frame.style) frame.style.opacity = "0.55";
  previewMessage("Rendering…");
  const style = $("pvStyle").value;
  const dictionary = $("pvDict");
  const dict = dictionary.value;
  const diagrams = $("pvDiagrams").value;
  dictionary.disabled = style === "fork" || diagrams === "inline";
  dictionary.title = style === "fork" ? "Dictionary grouping is available in Lead Sheet style." :
    diagrams === "inline" ? "Dictionary grouping is unavailable for inline-only diagrams." : "Group diagrams by voicing or chord name.";
  const bars = $("pvBars").value;
  togglePreviewSource();
  $("cmSource").value = "";
  if ($("cmCopy")) $("cmCopy").disabled = true;

  const docBody = JSON.stringify(doc);
  try {
    const res = await fetch(
      `/api/render-doc?style=${style}&dict=${dict}&diagrams=${diagrams}&bars=${bars}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: docBody });
    const html = await res.text();
    if (!isCurrent()) return;
    if (!res.ok) throw new Error(`Could not render preview (HTTP ${res.status}).`);
    const fallback = res.headers.get("X-Songsheet-Preview-Style") === "target";
    let note = "";
    if (fallback) {
      $("pvStyle").value = "target";
      dictionary.disabled = diagrams === "inline";
      dictionary.title = diagrams === "inline" ? "Dictionary grouping is unavailable for inline-only diagrams." : "Group diagrams by voicing or chord name.";
      note = res.headers.get("X-Songsheet-Preview-Reason") === "bar-layout"
        ? "Showing Lead Sheet to preserve this chart’s bar layout."
        : "Chord Chart renderer unavailable. Showing Lead Sheet.";
    }
    setPreviewSnapshot({
      album, file, docBody, request, style: fallback ? "target" : style, dict, diagrams, bars,
    });
    frame.onload = () => {
      if (!isCurrent() || previewSnapshot?.request !== request) return;
      const marker = frame.contentDocument?.querySelector('meta[name="songsheet-preview"]');
      if (marker?.content !== String(request)) return;
      previewLoaded = true;
      if (frame.style) frame.style.opacity = "1";
      if ($("pvPreviewMsg").dataset?.kind !== "error") previewMessage(note);
      syncPreviewExportControls();
    };
    // Real renderer responses contain <head>; support minimal HTML as well.
    const marker = `<meta name="songsheet-preview" content="${request}">`;
    frame.srcdoc = /<head(?:\s[^>]*)?>/i.test(html)
      ? html.replace(/<head(?:\s[^>]*)?>/i, `$&${marker}`) : marker + html;
    if (note) previewMessage(note);
    await togglePreviewSource();
  } catch (e) {
    if (!isCurrent()) return;
    previewMessage(`Preview failed: ${e.message}. Change a preview option to retry.`, true);
  }
}

// Wire the Export buttons. Each fetches the response as a Blob and triggers the
// download from a blob URL, so we get real completion feedback ("Exported ✓" /
// "Export failed: …") instead of a fire-and-forget anchor click.
function wireExport() {
  const a = (id) => encodeURIComponent(id);
  const flash = (m, kind = "info") => {
    const s = $("pvExportMsg");
    s.textContent = m;
    if (s.dataset) s.dataset.kind = kind;
    s.setAttribute?.("role", kind === "error" ? "alert" : "status");
    if ($("pvDismissMsg")) $("pvDismissMsg").hidden = !m;
    if (m && kind === "success") setTimeout(() => { if (s.textContent === m) flash(""); }, 2500);
  };
  $("pvDismissMsg")?.addEventListener("click", () => flash(""));
  const busy = (value) => { previewExportPending = value; syncPreviewExportControls(); };

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
      flash("Wait for the current preview before exporting.", "error");
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
    if (previewExportPending) return;
    busy(true);
    flash(pending);
    try {
      const options = docBody ? {
        method: "POST", headers: { "Content-Type": "application/json" }, body: docBody,
      } : undefined;
      const res = await fetch(url, options);
      if (!res.ok) {
        let detail = res.status;
        try { const j = await res.json(); if (j && j.error) detail = j.error; } catch (e) { /* not json */ }
        flash("Export failed: " + detail, "error");
        return;
      }
      const blob = await res.blob();
      download(blob, filenameFrom(res, fallbackName));
      flash("Exported ✓", "success");
    } catch (e) {
      flash("Export failed: " + e, "error");
    } finally { busy(false); }
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
    if (previewExportPending) return;
    const snapshot = currentPreview();
    if (!snapshot) return;
    try {
      flash("");
      PreviewExport.printPreviewFrame(loadedPreviewFrame(snapshot));
    } catch (error) {
      flash("Print failed: " + error.message, "error");
    }
  });
  $("pvExportPng").addEventListener("click", async () => {
    if (previewExportPending) return;
    const snapshot = currentPreview();
    if (!snapshot) return;
    busy(true);
    flash("Preparing PNG…");
    try {
      const blob = await PreviewExport.capturePreviewPng(loadedPreviewFrame(snapshot));
      download(blob, `${snapshot.file.replace(/\.json$/i, "")}.png`);
      flash("Exported ✓", "success");
    } catch (error) {
      flash("PNG export failed: " + error.message, "error");
    } finally { busy(false); }
  });
  $("pvExportAlbum").addEventListener("click", async () => {
    if (previewExportPending) return;
    if (!state.album) { flash("No album selected.", "error"); return; }
    if (state.dirty && (typeof confirm !== "function" || !confirm("This album PDF uses saved files. Unsaved song edits will be omitted. Continue with the saved album?"))) return;
    busy(true);
    flash("Preparing saved album in Lead Sheet style…");
    try {
      const url = `/api/export-album/${a(state.album)}?fmt=html&dict=${$("pvDict").value}` +
        `&diagrams=${$("pvDiagrams").value}&bars=${$("pvBars").value}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Could not render saved album (HTTP ${res.status}).`);
      await PreviewExport.printChartHtml(await res.text());
      flash("");
    } catch (error) {
      flash("Print failed: " + error.message, "error");
    } finally { busy(false); }
  });
}
