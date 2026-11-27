// Core app state + undo/redo + tiny shared helpers. Loaded first of the app_*
// files; everything here is a plain global shared by the other classic scripts
// (same idiom as chord_naming.js / harmony.js — no build, explicit load order
// in index.html).
let state = {
  album: null, file: null, doc: null, sel: null,
  dictSel: new Set(), dictEdit: null, dictSort: "count",
  dictMergeOpen: false, activeView: "bars", dirty: false,
  savedSnapshot: null,
  songSearch: "", songFilter: "all", flags: [],
};

// Shorthand element lookup.
const $ = (id) => document.getElementById(id);

// HTML-escape any value interpolated into innerHTML or an attribute.
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Mark the document as having unsaved edits.
function markDirty() {
  state.dirty = true;
  state.editVersion = (state.editVersion || 0) + 1;
  $("saveBtn")?.classList?.toggle("dirty", true);
  if (typeof ReviewUI === "object") ReviewUI.documentChanged?.();
  const status = $("saveStatus");
  if (status) {
    status.textContent = "Unsaved changes";
    status.style.color = "var(--warn)";
  }
}

function syncUndoRedoDirty() {
  if (typeof state.savedSnapshot === "string" && JSON.stringify(state.doc) === state.savedSnapshot) {
    state.dirty = false;
    $("saveBtn")?.classList?.toggle("dirty", false);
    state.editVersion = (state.editVersion || 0) + 1;
    if (typeof ReviewUI === "object") ReviewUI.documentChanged?.();
    const status = $("saveStatus");
    if (status) {
      status.textContent = "";
      status.style.color = "";
    }
    return;
  }
  markDirty();
}

// ---- Undo / redo ----
// Deep-JSON snapshots of state.doc. pushUndo() is called at the START of every
// mutation (before the change is applied), so undo() restores the pre-edit state.
let undoStack = [];
let redoStack = [];

function syncHistoryButtons() {
  const undoButton = $("undoBtn"), redoButton = $("redoBtn");
  if (undoButton) undoButton.disabled = !state.doc || !undoStack.length;
  if (redoButton) redoButton.disabled = !state.doc || !redoStack.length;
}

function snapshot() {
  const copy = JSON.parse(JSON.stringify(state.doc));
  if (typeof copyLegacyScanLinks === "function") copyLegacyScanLinks(copy);
  return copy;
}

// Record the current state.doc before a mutation, and clear the redo stack.
// Cap the stack so very long sessions don't grow unbounded.
function pushUndo() {
  if (!state.doc) return;
  undoStack.push(snapshot());
  if (undoStack.length > 100) undoStack.shift();
  redoStack = [];
  syncHistoryButtons();
}

// Re-render everything that reads from state.doc after an undo/redo swap.
function rerenderAll() {
  const prevSel = state.sel;
  const editorEl = $("editor");
  const wasEditorOpen = Boolean(editorEl && editorEl.classList.contains("open"));
  const selValid = Boolean(
    prevSel &&
    state.doc?.songs?.[0]?.sections?.[prevSel.si]?.bars?.[prevSel.bi]?.[prevSel.ei]
  );
  state.sel = selValid ? prevSel : null;
  if (!state.sel && editorEl) {
    if (editorEl.classList.contains("editor-inline")) closeChordEditor();
    else editorEl.classList.remove("open");
  }
  const status = (state.doc.document && state.doc.document.status) || "pending";
  $("statusSel").value = status;
  $("keySel").value = songKey();
  window.ChordNaming.setKeyTonic(songKey());
  syncNote();
  renderProvenance();
  if (typeof syncCurrentSongTitle === "function") syncCurrentSongTitle();
  if (typeof syncScanDocument === "function") syncScanDocument();
  renderBars();
  if (state.sel && wasEditorOpen && typeof openEditor === "function") {
    openEditor(state.sel.si, state.sel.bi, state.sel.ei);
  }
  renderSongList();
  if (state.activeView === "lyrics") renderLyrics();
  if (state.activeView === "review") renderReview();
  if (state.activeView === "dict") renderDict();
  if (state.activeView === "harmony") renderHarmony();
  if (state.activeView === "preview") renderPreview();
  if (state.activeView === "json" && typeof renderJson === "function" &&
      !(typeof hasUnappliedJsonEdits === "function" && hasUnappliedJsonEdits())) {
    renderJson();
  }
}

function undo() {
  if (!state.doc || !undoStack.length) return;
  redoStack.push(snapshot());
  state.doc = undoStack.pop();
  syncHistoryButtons();
  syncUndoRedoDirty();
  rerenderAll();
  if (typeof showToast === "function") showToast("Undo complete");
}

function redo() {
  if (!state.doc || !redoStack.length) return;
  undoStack.push(snapshot());
  state.doc = redoStack.pop();
  syncHistoryButtons();
  syncUndoRedoDirty();
  rerenderAll();
  if (typeof showToast === "function") showToast("Redo complete");
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  const data = await r.json();
  const revision = r.headers?.get("X-Songsheet-Revision");
  if (revision && data && typeof data === "object") {
    data[Symbol.for("songsheetRevision")] = revision;
  }
  return data;
}

const STATUS_LABEL = { pending: "○ pending", in_progress: "◐ in progress", done: "✓ done" };

let albums = [];

// Parse a comma-form voicing string into an array of fret ints / "x".
function parseVoicing(s) {
  return String(s).split(",").map((t) => (t === "x" ? "x" : parseInt(t, 10)));
}

function song() { return state.doc.songs[0]; }

// Populate the per-song note textarea from song().note (or empty/disabled).
function syncNote() {
  const ta = $("songNote");
  if (!ta) return;
  if (!state.doc) {
    ta.value = "";
    ta.disabled = true;
    ta._syncBaseline?.();
    return;
  }
  ta.disabled = false;
  ta.value = song().note || "";
  ta._syncBaseline?.();
}

// Read-only provenance line: page span and durable source/reading counts.
function renderProvenance() {
  const el = $("provenance");
  if (!el) return;
  if (!state.doc) { el.textContent = ""; return; }
  const parts = [];
  const pages = (song().pages || []).filter((n) => Number.isFinite(n));
  if (pages.length) {
    const lo = Math.min(...pages), hi = Math.max(...pages);
    parts.push(lo === hi ? `page ${lo}` : `pages ${lo}–${hi}`);
  }
  const meta = state.doc._meta;
  if (meta && typeof meta === "object") {
    const sources = meta.extraction_sources;
    const readings = meta.observations;
    if (sources && typeof sources === "object" && !Array.isArray(sources)) {
      const n = Object.keys(sources).length;
      parts.push(`${n} source${n === 1 ? "" : "s"}`);
    }
    if (readings && typeof readings === "object" && !Array.isArray(readings)) {
      const n = Object.keys(readings).length;
      parts.push(`${n} reading${n === 1 ? "" : "s"}`);
    }
  }
  el.textContent = parts.join(" · ");
  el.title = el.textContent;
}

// Usable key string from song.key (may be null or non-standard); "" if none.
// Returns a normalized "<root>" or "<root>m" via ChordNaming.parseKey.
function songKey() {
  const parsed = window.ChordNaming.parseKey(song().key);
  if (!parsed) return "";
  return parsed.tonic + (parsed.mode === "minor" ? "m" : "");
}

// per-string notes aligned to the voicing (x for muted), or "".
function notesFor(voicing) {
  if (!voicing) return "";
  return window.ChordNaming.perStringNotes(parseVoicing(voicing)).join(" ");
}

// per-string scale degrees in the song key, aligned to the voicing, or "".
function intervalsFor(voicing) {
  const k = songKey();
  if (!k || !voicing) return "";
  return window.ChordNaming.perStringInKey(parseVoicing(voicing), k).join(" ");
}

// per-string chord-relative intervals (from the chord's own root), aligned, or "".
function chordIvalsFor(voicing, chord) {
  if (!voicing || !chord || chord === "%") return "";
  return window.ChordNaming.perStringChordIntervals(parseVoicing(voicing), chord).join(" ");
}
