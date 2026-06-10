// Core app state + undo/redo + tiny shared helpers. Loaded first of the app_*
// files; everything here is a plain global shared by the other classic scripts
// (same idiom as chord_naming.js / harmony.js — no build, explicit load order
// in index.html).
let state = {
  album: null, file: null, doc: null, sel: null,
  dictSel: new Set(), dictEdit: null, dictSort: "count",
  dictMergeOpen: false, activeView: "bars", dirty: false,
  songSearch: "", songFilter: "all", flags: [],
};

// Shorthand element lookup.
const $ = (id) => document.getElementById(id);

// HTML-escape any value interpolated into innerHTML or an attribute.
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Mark the document as having unsaved edits.
function markDirty() { state.dirty = true; }

// ---- Undo / redo ----
// Deep-JSON snapshots of state.doc. pushUndo() is called at the START of every
// mutation (before the change is applied), so undo() restores the pre-edit state.
let undoStack = [];
let redoStack = [];

function snapshot() { return JSON.parse(JSON.stringify(state.doc)); }

// Record the current state.doc before a mutation, and clear the redo stack.
// Cap the stack so very long sessions don't grow unbounded.
function pushUndo() {
  if (!state.doc) return;
  undoStack.push(snapshot());
  if (undoStack.length > 100) undoStack.shift();
  redoStack = [];
}

// Re-render everything that reads from state.doc after an undo/redo swap.
function rerenderAll() {
  state.sel = null;
  $("editor").classList.remove("open");
  const status = (state.doc.document && state.doc.document.status) || "pending";
  $("statusSel").value = status;
  $("keySel").value = songKey();
  window.ChordNaming.setKeyTonic(songKey());
  syncNote();
  renderProvenance();
  renderBars();
  renderSongList();
  if (state.activeView === "lyrics") renderLyrics();
  if (state.activeView === "review") renderReview();
  if (state.activeView === "dict") renderDict();
  if (state.activeView === "harmony") renderHarmony();
  if (state.activeView === "preview") renderPreview();
}

function undo() {
  if (!state.doc || !undoStack.length) return;
  redoStack.push(snapshot());
  state.doc = undoStack.pop();
  markDirty();
  rerenderAll();
}

function redo() {
  if (!state.doc || !redoStack.length) return;
  undoStack.push(snapshot());
  state.doc = redoStack.pop();
  markDirty();
  rerenderAll();
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  return r.json();
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
  if (!state.doc) { ta.value = ""; ta.disabled = true; return; }
  ta.disabled = false;
  ta.value = song().note || "";
}

// Read-only provenance line: song page numbers + any top-level _meta keys.
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
    const keys = Object.keys(meta);
    if (keys.length) parts.push("meta: " + keys.map((k) => `${k}=${meta[k]}`).join(", "));
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
