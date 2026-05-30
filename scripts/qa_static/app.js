// Songsheet QA app: load albums/songs, render pages + editable chord chips, edit panel, save.
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
  if (state.activeView === "review") renderReview();
  if (state.activeView === "dict") renderDict();
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

function fillSongs() {
  const songSel = $("songSel");
  const a = albums.find((x) => x.album === $("albumSel").value);
  const songs = (a && a.songs) || [];
  songSel.innerHTML = songs
    .map((s) => `<option value="${esc(s.file)}">${STATUS_LABEL[s.status] || "○"}  ${esc(s.file)}</option>`)
    .join("");
  renderSongList();
  updateProgress();
}

// Status glyph from STATUS_LABEL (first char), default pending glyph.
function statusGlyph(status) {
  return (STATUS_LABEL[status] || STATUS_LABEL.pending).trim().charAt(0);
}

// Prettify a song filename for display (strip .json, NN- prefix → readable).
function prettyFile(file) {
  return String(file).replace(/\.json$/i, "");
}

// Songs for the current album, after search + status filtering.
function filteredSongs() {
  const a = albums.find((x) => x.album === $("albumSel").value);
  const songs = (a && a.songs) || [];
  const q = state.songSearch.trim().toLowerCase();
  return songs.filter((s) => {
    if (state.songFilter !== "all" && (s.status || "pending") !== state.songFilter) return false;
    if (q && !s.file.toLowerCase().includes(q)) return false;
    return true;
  });
}

// Render the left song-list sidebar (status glyph + name, current highlighted).
function renderSongList() {
  const list = $("songsList");
  if (!list) return;
  const songs = filteredSongs();
  if (!songs.length) {
    list.innerHTML = `<div class="songs-empty">No songs match.</div>`;
    return;
  }
  list.innerHTML = "";
  songs.forEach((s) => {
    const row = document.createElement("div");
    row.className = "song-row" + (s.file === state.file ? " sel" : "");
    row.innerHTML =
      `<span class="sg">${esc(statusGlyph(s.status))}</span>` +
      `<span class="snm" title="${esc(s.file)}">${esc(prettyFile(s.file))}</span>`;
    row.addEventListener("click", () => selectSong(s.file));
    list.appendChild(row);
  });
}

// Load a song by file, going through the dirty-guard. No-op if same file.
function selectSong(file) {
  if (file === state.file) return;
  if (!confirmDiscard()) return;
  $("songSel").value = file;
  loadSong();
}

function updateProgress() {
  const a = albums.find((x) => x.album === $("albumSel").value);
  if (!a || !a.songs) { $("albumProgress").textContent = ""; return; }
  const done = a.songs.filter((s) => s.status === "done").length;
  $("albumProgress").textContent = `${done}/${a.songs.length} done`;
}

// If there are unsaved edits, confirm before switching away. Returns true to proceed.
function confirmDiscard() {
  if (!state.dirty) return true;
  return confirm("Discard unsaved changes?");
}

async function init() {
  albums = await api("/api/albums");
  const albumSel = $("albumSel");
  albumSel.innerHTML = albums.map((a) => `<option>${esc(a.album)}</option>`).join("");
  const songSel = $("songSel");

  // album switch: remember the previous value so we can revert if the user cancels.
  let lastAlbum = albumSel.value;
  let lastSong = songSel.value;
  albumSel.addEventListener("change", () => {
    if (!confirmDiscard()) { albumSel.value = lastAlbum; return; }
    lastAlbum = albumSel.value;
    fillSongs();
    lastSong = songSel.value;
    loadSong();
  });
  songSel.addEventListener("change", () => {
    if (!confirmDiscard()) { songSel.value = lastSong; return; }
    lastSong = songSel.value;
    loadSong();
  });

  $("saveBtn").addEventListener("click", save);
  $("statusSel").addEventListener("change", (ev) => {
    if (!state.doc) return;
    pushUndo();
    state.doc.document.status = ev.target.value;
    markDirty();
  });
  // key selector — drives interval analysis; stored on song.key. Major + minor.
  const keySel = $("keySel");
  const ROOTS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const KEYS = ROOTS.concat(ROOTS.map((r) => r + "m")); // major then minor
  keySel.innerHTML = '<option value="">key: —</option>' +
    KEYS.map((k) => `<option value="${esc(k)}">key: ${esc(k)}</option>`).join("");
  keySel.addEventListener("change", (ev) => {
    if (!state.doc) return;
    pushUndo();
    song().key = ev.target.value || null;
    markDirty();
    window.ChordNaming.setKeyTonic(songKey());
    renderBars();
    if (state.activeView === "dict") renderDict();
    if (state.sel) openEditor(state.sel.si, state.sel.bi, state.sel.ei);
  });
  // song-list sidebar: search + status filter
  $("songSearch").addEventListener("input", (ev) => {
    state.songSearch = ev.target.value;
    renderSongList();
  });
  $("songsFilter").querySelectorAll("[data-filter]").forEach((b) =>
    b.addEventListener("click", () => {
      state.songFilter = b.dataset.filter;
      $("songsFilter").querySelectorAll("[data-filter]").forEach((x) =>
        x.classList.toggle("active", x === b));
      renderSongList();
    }));

  $("tabBars").addEventListener("click", () => showView("bars"));
  $("tabReview").addEventListener("click", () => showView("review"));
  $("tabDict").addEventListener("click", () => showView("dict"));
  $("tabPreview").addEventListener("click", () => showView("preview"));
  $("cmCopy").addEventListener("click", copyChordmark);
  ["pvStyle", "pvDict", "pvInline", "pvBars"].forEach((id) =>
    $(id).addEventListener("change", () => {
      if (state.activeView === "preview") renderPreview();
    }));
  // Source toggle: show/hide the generated .chordmark source beside the render.
  $("pvSource").addEventListener("change", () => {
    if (state.activeView === "preview") renderPreview();
  });
  wireExport();

  // global flat/sharp spelling toggle — re-renders bars (and editor if open)
  const spellBtn = $("spellToggle");
  spellBtn.addEventListener("click", () => {
    const next = window.ChordNaming.getSpelling() === "sharp" ? "flat" : "sharp";
    window.ChordNaming.setSpelling(next);
    spellBtn.textContent = next === "flat" ? "♭ flat" : "♯ sharp";
    renderBars();
    if (state.activeView === "dict") renderDict();
    if (state.sel) openEditor(state.sel.si, state.sel.bi, state.sel.ei);
  });

  window.addEventListener("beforeunload", (e) => {
    if (state.dirty) { e.preventDefault(); e.returnValue = ""; }
  });

  // per-song note: one undo per editing session (focus → blur), commit on blur.
  const noteTa = $("songNote");
  if (noteTa) {
    let noteStart = "";
    noteTa.addEventListener("focus", () => { noteStart = noteTa.value; });
    noteTa.addEventListener("blur", () => {
      if (!state.doc) return;
      const next = noteTa.value;
      if (next === noteStart) return;
      pushUndo();
      if (next.trim() === "") delete song().note;
      else song().note = next;
      markDirty();
    });
  }

  $("nextFlagBtn").addEventListener("click", nextFlagged);
  document.addEventListener("keydown", onKeydown);

  fillSongs();
  loadSong();
}

// Global keyboard shortcuts. We ignore most keys while typing in a field,
// except ⌘S/Ctrl+S (Save) and Esc (close editor), which work everywhere.
function onKeydown(ev) {
  const el = ev.target;
  const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");

  // ⌘S / Ctrl+S → Save (always)
  if ((ev.metaKey || ev.ctrlKey) && (ev.key === "s" || ev.key === "S")) {
    ev.preventDefault();
    save();
    return;
  }
  // Undo / redo — only when NOT typing, so native input undo is preserved.
  //   ⌘Z / Ctrl+Z → undo, ⌘⇧Z / Ctrl+Y → redo.
  if (!typing && (ev.metaKey || ev.ctrlKey)) {
    const k = ev.key.toLowerCase();
    if (k === "z" && !ev.shiftKey) { ev.preventDefault(); undo(); return; }
    if ((k === "z" && ev.shiftKey) || k === "y") { ev.preventDefault(); redo(); return; }
  }
  // Esc → close editor (always)
  if (ev.key === "Escape") {
    if ($("editor").classList.contains("open")) {
      $("editor").classList.remove("open");
      state.sel = null;
      renderBars();
    }
    return;
  }
  if (typing || ev.metaKey || ev.ctrlKey || ev.altKey) return;

  if (ev.key === "n") { ev.preventDefault(); stepSong(+1); }
  else if (ev.key === "p") { ev.preventDefault(); stepSong(-1); }
  else if (ev.key === "]") { ev.preventDefault(); nextFlagged(); }
}

// Move to the next/previous song in the current filtered sidebar list
// (dirty-guarded via selectSong).
function stepSong(dir) {
  const songs = filteredSongs();
  if (!songs.length) return;
  let idx = songs.findIndex((s) => s.file === state.file);
  if (idx === -1) { selectSong(songs[0].file); return; }
  const next = songs[(idx + dir + songs.length) % songs.length];
  selectSong(next.file);
}

// Friendly empty state when an album has no songs (or none is selected).
function showEmpty() {
  state.doc = null;
  state.sel = null;
  state.flags = [];
  undoStack = [];
  redoStack = [];
  $("pages").innerHTML = "";
  $("bars").innerHTML = `<div class="empty">No song to show. Pick an album and song from the sidebar.</div>`;
  $("editor").classList.remove("open");
  syncNote();
  renderProvenance();
  renderSongList();
  showView("bars");
}

async function loadSong() {
  state.album = $("albumSel").value;
  state.file = $("songSel").value;
  state.dictSel.clear();
  state.dictEdit = null;
  state.dictMergeOpen = false;
  undoStack = [];
  redoStack = [];
  if (!state.album || !state.file) { showEmpty(); return; }
  state.doc = await api(`/api/song/${state.album}/${state.file}`);
  if (!state.doc || state.doc.error || !state.doc.songs || !state.doc.songs.length) {
    $("pages").innerHTML = "";
    $("bars").innerHTML = `<div class="empty">Could not load this song.</div>`;
    $("editor").classList.remove("open");
    showView("bars");
    return;
  }
  state.sel = null;
  state.dirty = false;
  const status = (state.doc.document && state.doc.document.status) || "pending";
  $("statusSel").value = status;
  $("keySel").value = songKey();
  window.ChordNaming.setKeyTonic(songKey());
  syncNote();
  renderProvenance();
  renderPages();
  renderBars();
  renderSongList();
  showView("bars");
  $("editor").classList.remove("open");
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

function renderPages() {
  const pages = song().pages || [];
  $("pages").innerHTML = pages.map((n) =>
    `<img src="/api/page/${encodeURIComponent(state.album)}/${encodeURIComponent(state.file)}/${encodeURIComponent(n)}" alt="page ${esc(n)}">
     <div class="pagecap">page ${esc(n)}</div>`).join("");
}

// Classify an entry as flagged. Returns a reason string, or "" if clean.
//  - "invalid name": chord name doesn't parse (excluding the % bar-repeat).
//  - "name ≠ voicing": name and voicing disagree.
function flagReason(e) {
  if (e.chord === "%") return "";
  if (window.ChordNaming.validateName(e.chord).valid === false) return "invalid name";
  if (e.voicing &&
      window.ChordNaming.nameMatchesVoicing(e.chord, parseVoicing(e.voicing)) === false)
    return "name ≠ voicing";
  return "";
}

function renderBars() {
  const root = $("bars");
  root.innerHTML = "";
  state.flags = [];
  song().sections.forEach((sec, si) => {
    const lab = document.createElement("div");
    lab.className = "section-label";
    // inline-editable section label + section structural controls
    lab.innerHTML =
      `<input class="seclabel" type="text" value="${esc(sec.label || "")}"
              placeholder="Section ${si + 1}" title="section label">
       <span class="secmv">
         <button class="secAdd" title="add section after">+ section</button>
         <button class="secDel" title="delete section">delete</button>
       </span>`;
    const labInput = lab.querySelector(".seclabel");
    // commit label on blur or Enter (one undo per logical rename)
    let labStart = sec.label || "";
    labInput.addEventListener("focus", () => { labStart = labInput.value; });
    const commitLabel = () => {
      const next = labInput.value;
      if (next === labStart) return;
      pushUndo();
      sec.label = next === "" ? null : next;
      labStart = next;
      markDirty();
      renderSongList();
    };
    labInput.addEventListener("blur", commitLabel);
    labInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); labInput.blur(); }
    });
    lab.querySelector(".secAdd").addEventListener("click", () => addSectionAfter(si));
    lab.querySelector(".secDel").addEventListener("click", () => deleteSection(si));
    root.appendChild(lab);
    if (!sec.bars || !sec.bars.length) {
      const empty = document.createElement("div");
      empty.className = "sec-empty";
      empty.innerHTML = `<span class="muted">empty section</span>
        <button class="barAddFirst" title="add first bar">+ bar</button>`;
      empty.querySelector(".barAddFirst").addEventListener("click", () => addBarAfter(si, -1));
      root.appendChild(empty);
      return;
    }
    sec.bars.forEach((bar, bi) => {
      const bd = document.createElement("div");
      bd.className = "bar";
      bd.innerHTML =
        `<div class="barhead">
           <span class="barnum">bar ${bi + 1}${bar.length > 1 ? " · " + bar.length + " chords" : ""}</span>
           <span class="barmv">
             <button class="barAdd" title="add empty bar after">+ bar</button>
             <button class="barSplit" title="split bar in two">split</button>
             <button class="barMerge" title="merge with next bar" ${bi < sec.bars.length - 1 ? "" : "disabled"}>merge ↓</button>
             <button class="barDel" title="delete bar">✕</button>
           </span>
         </div>`;
      bd.querySelector(".barAdd").addEventListener("click", () => addBarAfter(si, bi));
      bd.querySelector(".barSplit").addEventListener("click", () => splitBar(si, bi));
      bd.querySelector(".barMerge").addEventListener("click", () => mergeBarWithNext(si, bi));
      bd.querySelector(".barDel").addEventListener("click", () => deleteBar(si, bi));
      const chips = document.createElement("div");
      chips.className = "chips";
      bar.forEach((e, ei) => {
        const reason = flagReason(e);
        const mismatch = !!reason;
        if (reason) state.flags.push({ si, bi, ei, chord: e.chord, reason,
          label: sec.label || `Section ${si + 1}` });
        const chip = document.createElement("div");
        chip.className = "chip" + (e.chord === "%" ? " pct" : "") +
          (state.sel && state.sel.si === si && state.sel.bi === bi && state.sel.ei === ei ? " sel" : "");
        const notes = (e.chord !== "%" && e.voicing) ? notesFor(e.voicing) : "";
        const ivals = (e.chord !== "%") ? intervalsFor(e.voicing) : "";
        const civals = (e.chord !== "%") ? chordIvalsFor(e.voicing, e.chord) : "";
        const canLeft = bi > 0;
        const canRight = bi < sec.bars.length - 1;
        const dia = (e.chord !== "%" && e.voicing) ? window.ChordDiagram.svg(e.voicing) : "";
        chip.innerHTML =
          `<div class="nm">${esc(e.chord)}${mismatch ? '<span class="warn"></span>' : ""}</div>
           <div class="vc">${esc(e.voicing || "—")}</div>
           ${dia}
           ${notes ? `<div class="nt">${esc(notes)}</div>` : ""}
           ${civals ? `<div class="ci">${esc(civals)}</div>` : ""}
           ${ivals ? `<div class="iv">${esc(ivals)}</div>` : ""}
           <div class="tx">${e.text ? "_" + esc(e.text) : "—"}</div>
           <div class="mv">
             <button class="mvl" title="move to previous bar" ${canLeft ? "" : "disabled"}>←</button>
             <button class="mvr" title="move to next bar" ${canRight ? "" : "disabled"}>→</button>
           </div>`;
        chip.addEventListener("click", () => openEditor(si, bi, ei));
        chip.querySelector(".mvl").addEventListener("click", (ev) => { ev.stopPropagation(); moveChord(si, bi, ei, -1); });
        chip.querySelector(".mvr").addEventListener("click", (ev) => { ev.stopPropagation(); moveChord(si, bi, ei, +1); });
        chips.appendChild(chip);
      });
      bd.appendChild(chips);
      root.appendChild(bd);
    });
  });
  const flags = state.flags.length;
  $("flagCount").textContent = flags ? `${flags} flagged` : "";
  if (state.activeView === "review") renderReview();
}

// Move a chord entry to the adjacent bar (dir -1 = previous, +1 = next).
// Moving left appends to the end of the previous bar; right prepends to the next.
function moveChord(si, bi, ei, dir) {
  const bars = song().sections[si].bars;
  const target = bi + dir;
  if (target < 0 || target >= bars.length) return;
  pushUndo();
  const [entry] = bars[bi].splice(ei, 1);
  if (dir < 0) bars[target].push(entry);
  else bars[target].unshift(entry);
  markDirty();
  state.sel = null;
  $("editor").classList.remove("open");
  renderBars();
}

// ---- Structural editing (Bars view) ----
// All ops: pushUndo() first, mutate song().sections, clear selection (so the
// editor never points at a removed entry), markDirty(), re-render.

// After any structural change: drop the editor selection and re-render bars +
// the dependent views/sidebar (renderBars rebuilds state.flags → Review).
function afterStructuralEdit() {
  state.sel = null;
  $("editor").classList.remove("open");
  markDirty();
  renderBars();
  renderSongList();
  if (state.activeView === "review") renderReview();
}

// Insert an empty bar after bar index bi (use bi = -1 to add the first bar to an
// empty section). An empty bar [] is schema-valid (bars is an array of arrays).
function addBarAfter(si, bi) {
  pushUndo();
  song().sections[si].bars.splice(bi + 1, 0, []);
  afterStructuralEdit();
}

function deleteBar(si, bi) {
  if (!confirm(`Delete bar ${bi + 1}?`)) return;
  pushUndo();
  song().sections[si].bars.splice(bi, 1);
  afterStructuralEdit();
}

// Split a bar into two. Multi-entry: split at the midpoint. Single/empty entry:
// the new second bar is a "%" continuation (keeps it simple & schema-valid).
function splitBar(si, bi) {
  const bars = song().sections[si].bars;
  const bar = bars[bi];
  pushUndo();
  if (bar.length >= 2) {
    const mid = Math.ceil(bar.length / 2);
    const tail = bar.splice(mid);
    bars.splice(bi + 1, 0, tail);
  } else {
    bars.splice(bi + 1, 0, [{ chord: "%" }]);
  }
  afterStructuralEdit();
}

// Merge a bar with the next one (concatenate entries, drop the next bar).
function mergeBarWithNext(si, bi) {
  const bars = song().sections[si].bars;
  if (bi >= bars.length - 1) return;
  pushUndo();
  bars[bi] = bars[bi].concat(bars[bi + 1]);
  bars.splice(bi + 1, 1);
  afterStructuralEdit();
}

// Insert a new section after section index si (with one "%" bar so it renders).
function addSectionAfter(si) {
  pushUndo();
  song().sections.splice(si + 1, 0, { label: "", bars: [[{ chord: "%" }]] });
  afterStructuralEdit();
}

function deleteSection(si) {
  const sec = song().sections[si];
  const name = (sec && sec.label) || `Section ${si + 1}`;
  if (!confirm(`Delete "${name}" and all its bars?`)) return;
  pushUndo();
  song().sections.splice(si, 1);
  afterStructuralEdit();
}

function openEditor(si, bi, ei) {
  state.sel = { si, bi, ei };
  const e = song().sections[si].bars[bi][ei];
  const ed = $("editor");
  ed.classList.add("open");
  ed.innerHTML = `
    <h2>Edit chord · bar ${bi + 1}</h2>
    <label>Chord name</label>
    <input type="text" id="edName" value="${esc(e.chord)}">
    <div id="edBadge"></div>
    <div id="edErr" class="err"></div>
    <div id="edIvals" class="fb-notes"></div>
    <label>Anchored lyric</label>
    <input type="text" id="edText" value="${esc(e.text || "")}">
    <label>Voicing</label>
    <div id="edFb"></div>
    <label>Suggestions</label>
    <div class="suggest" id="edSuggest"></div>
    <div class="ed-actions">
      <button class="apply" id="edApply">Apply</button>
      <button id="edCancel">Cancel</button>
    </div>`;
  let curVoicing = e.voicing ? parseVoicing(e.voicing) : ["x", "x", "x", "x", "x", "x"];
  const fb = window.Fretboard($("edFb"), (v) => {
    curVoicing = v;
    refreshNaming();
  });
  fb.set(curVoicing);
  $("edName").addEventListener("input", () => { $("edErr").textContent = ""; refreshNaming(); });
  // Enter in the name field applies; Esc cancels (handled here so it works
  // even though the global Esc handler also closes the editor).
  $("edName").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); $("edApply").click(); }
    else if (ev.key === "Escape") { ev.preventDefault(); $("edCancel").click(); }
  });

  function refreshNaming() {
    const name = $("edName").value.trim();
    const badge = $("edBadge");
    const match = window.ChordNaming.nameMatchesVoicing(name, curVoicing);
    if (match === true) { badge.className = "badge ok"; badge.textContent = "● matches voicing"; }
    else if (match === false) { badge.className = "badge bad"; badge.textContent = "● name ≠ voicing"; }
    else { badge.className = ""; badge.textContent = ""; }
    const sug = window.ChordNaming.suggestNames(curVoicing);
    $("edSuggest").innerHTML = sug.length
      ? sug.map((s) => `<div class="s" data-n="${esc(s.name)}"><b>${esc(s.name)}</b><span>suggest</span></div>`).join("")
      : `<div class="s"><span>no detection</span></div>`;
    $("edSuggest").querySelectorAll(".s[data-n]").forEach((el) =>
      el.addEventListener("click", () => { $("edName").value = el.dataset.n; $("edErr").textContent = ""; refreshNaming(); }));
    const ci = window.ChordNaming.perStringChordIntervals(curVoicing, name);
    $("edIvals").textContent = ci.length ? "chord intervals: " + ci.join(" ") : "";
  }
  refreshNaming();

  $("edApply").addEventListener("click", () => {
    const name = $("edName").value.trim();
    const v = window.ChordNaming.validateName(name);
    if (!v.valid && name !== "%") { $("edErr").textContent = "Not a valid ChordMark chord: " + name; return; }
    pushUndo();
    e.chord = name;
    const text = $("edText").value.trim();
    if (text) e.text = text; else delete e.text;
    const vc = fb.get();
    if (vc.every((f) => f === "x")) delete e.voicing;
    else e.voicing = vc.join(",");
    markDirty();
    renderBars();
  });
  $("edCancel").addEventListener("click", () => {
    ed.classList.remove("open"); state.sel = null; renderBars();
  });
}

async function save() {
  if (!state.doc) return;
  const status = $("saveStatus");
  status.textContent = "saving…"; status.style.color = "var(--muted)";
  const res = await api(`/api/song/${state.album}/${state.file}`,
    { method: "POST", body: JSON.stringify(state.doc) });
  if (res.ok) {
    status.textContent = "✓ saved"; status.style.color = "var(--ok)";
    state.dirty = false;
    // reflect the saved status in the local album cache → progress count + dropdown label
    const a = albums.find((x) => x.album === state.album);
    const s = a && a.songs && a.songs.find((x) => x.file === state.file);
    if (s) {
      s.status = (state.doc.document && state.doc.document.status) || "pending";
      const opt = [...$("songSel").options].find((o) => o.value === state.file);
      if (opt) opt.textContent = `${STATUS_LABEL[s.status] || "○"}  ${s.file}`;
      renderSongList();
      updateProgress();
    }
    // refresh the preview (it renders the in-memory doc, so this just re-syncs)
    if (state.activeView === "preview") renderPreview();
  } else { status.textContent = "✗ " + res.error; status.style.color = "var(--bad)"; }
}

// ---- Dictionary view ----

function showView(which) {
  state.activeView = which;
  $("bars").classList.toggle("hidden", which !== "bars");
  $("review").classList.toggle("hidden", which !== "review");
  $("dict").classList.toggle("hidden", which !== "dict");
  $("preview").classList.toggle("hidden", which !== "preview");
  $("tabBars").classList.toggle("active", which === "bars");
  $("tabReview").classList.toggle("active", which === "review");
  $("tabDict").classList.toggle("active", which === "dict");
  $("tabPreview").classList.toggle("active", which === "preview");
  if (which === "review") renderReview();
  if (which === "dict") renderDict();
  if (which === "preview") renderPreview();
}

// Review tab: worklist of every flagged chord in the current song. Click an
// item to jump to its chip (Bars view) and open the editor.
function renderReview() {
  const root = $("review");
  if (!state.doc) { root.innerHTML = `<div class="empty">No song loaded.</div>`; return; }
  const flags = state.flags;
  if (!flags.length) {
    root.innerHTML = `<div class="review-empty">No flagged chords ✓</div>`;
    return;
  }
  root.innerHTML = "";
  flags.forEach((f) => {
    const row = document.createElement("div");
    row.className = "rev-row";
    row.innerHTML =
      `<span class="rnm">${esc(f.chord || "—")}</span>` +
      `<span class="rwhere">${esc(f.label)} · bar ${f.bi + 1}</span>` +
      `<span class="rwhy">${esc(f.reason)}</span>`;
    row.addEventListener("click", () => jumpToFlag(f));
    root.appendChild(row);
  });
}

// Switch to Bars, select the flagged chip, and open its editor.
function jumpToFlag(f) {
  showView("bars");
  openEditor(f.si, f.bi, f.ei);
  // bring the freshly-selected chip into view
  const sel = $("bars").querySelector(".chip.sel");
  if (sel) sel.scrollIntoView({ block: "center", behavior: "smooth" });
}

// Jump to the next flagged chord after the current selection (wrapping).
function nextFlagged() {
  if (!state.doc) return;
  const flags = state.flags;
  if (!flags.length) { showView("review"); return; }
  let start = -1;
  if (state.sel) {
    start = flags.findIndex((f) =>
      f.si === state.sel.si && f.bi === state.sel.bi && f.ei === state.sel.ei);
  }
  const next = flags[(start + 1) % flags.length];
  jumpToFlag(next);
}

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
async function renderPreview() {
  if (!state.doc) return;
  const frame = $("previewFrame");
  const style = $("pvStyle").value;
  const dict = $("pvDict").value;
  const inline = $("pvInline").checked ? "1" : "0";
  const bars = $("pvBars").value;
  const showSource = $("pvSource").checked;
  // Source pane: textarea + control bar visibility tracks the toggle.
  $("cmSource").classList.toggle("hidden", !showSource);
  $("pvSourceBar").classList.toggle("hidden", !showSource);

  const docBody = JSON.stringify(state.doc);
  try {
    const res = await fetch(
      `/api/render-doc?style=${style}&dict=${dict}&inline=${inline}&bars=${bars}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: docBody });
    frame.srcdoc = await res.text();
  } catch (e) {
    frame.srcdoc = "<pre style='color:#b00;padding:20px'>preview failed: " + esc(e) + "</pre>";
  }

  if (showSource) {
    const ta = $("cmSource");
    try {
      const r = await fetch(`/api/chordmark-doc?bars=${bars}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: docBody });
      ta.value = r.ok ? await r.text()
        : "/* could not build ChordMark: " + (await r.text()) + " */";
    } catch (e) {
      ta.value = "/* failed to load ChordMark: " + e + " */";
    }
  }
}

// Wire the Export buttons. Each fetches the response as a Blob and triggers the
// download from a blob URL, so we get real completion feedback ("Exported ✓" /
// "Export failed: …") instead of a fire-and-forget anchor click.
function wireExport() {
  const a = (id) => encodeURIComponent(id);
  const songBase = () => `/api/export/${a(state.album)}/${a(state.file)}`;
  const pvOpts = () =>
    `style=${$("pvStyle").value}&dict=${$("pvDict").value}` +
    `&inline=${$("pvInline").checked ? 1 : 0}&bars=${$("pvBars").value}`;
  const flash = (m) => {
    const s = $("pvExportMsg");
    s.textContent = m;
    if (m) setTimeout(() => { if (s.textContent === m) s.textContent = ""; }, 2500);
  };
  const guard = () => {
    if (!state.album || !state.file) { flash("no song selected"); return false; }
    return true;
  };

  // Filename from a Content-Disposition header, or a fallback.
  const filenameFrom = (res, fallback) => {
    const cd = res.headers.get("Content-Disposition") || "";
    const m = /filename="?([^"]+)"?/.exec(cd);
    return (m && m[1]) || fallback;
  };

  // Fetch a URL, surface progress + completion as a toast, download the blob.
  async function exportBlob(url, pending, fallbackName) {
    flash(pending);
    try {
      const res = await fetch(url);
      if (!res.ok) {
        let detail = res.status;
        try { const j = await res.json(); if (j && j.error) detail = j.error; } catch (e) { /* not json */ }
        flash("Export failed: " + detail);
        return;
      }
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objUrl;
      link.download = filenameFrom(res, fallbackName);
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(objUrl), 4000);
      flash("Exported ✓");
    } catch (e) {
      flash("Export failed: " + e);
    }
  }

  $("pvExportPdf").addEventListener("click", () => {
    if (!guard()) return;
    exportBlob(`${songBase()}?fmt=pdf&${pvOpts()}`, "exporting PDF…", `${state.file}.pdf`);
  });
  $("pvExportPng").addEventListener("click", () => {
    if (!guard()) return;
    exportBlob(`${songBase()}?fmt=png&${pvOpts()}`, "exporting PNG…", `${state.file}.png`);
  });
  $("pvExportHtml").addEventListener("click", () => {
    if (!guard()) return;
    exportBlob(`${songBase()}?fmt=html&${pvOpts()}`, "exporting HTML…", `${state.file}.html`);
  });
  $("pvExportChordmark").addEventListener("click", () => {
    if (!guard()) return;
    exportBlob(`${songBase()}?fmt=chordmark&bars=${$("pvBars").value}`,
      "exporting .chordmark…", `${state.file}.chordmark`);
  });
  $("pvExportChordpro").addEventListener("click", () => {
    if (!guard()) return;
    exportBlob(`${songBase()}?fmt=chordpro`, "exporting ChordPro…", `${state.file}.chordpro`);
  });
  $("pvExportAlbum").addEventListener("click", () => {
    if (!state.album) { flash("no album selected"); return; }
    exportBlob(
      `/api/export-album/${a(state.album)}?fmt=pdf&style=target&dict=${$("pvDict").value}&bars=${$("pvBars").value}`,
      "exporting album PDF…", `${state.album}-songbook.pdf`);
  });
  // Download .chordmark of the CURRENT in-memory source (the textarea content).
  $("cmDownload").addEventListener("click", () => {
    if (!state.album || !state.file) return;
    const text = $("cmSource").value || "";
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const objUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objUrl;
    link.download = `${state.file.replace(/\.json$/i, "")}.chordmark`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 4000);
    const msg = $("cmCopyMsg");
    msg.textContent = "✓ downloaded";
    setTimeout(() => (msg.textContent = ""), 1500);
  });
}

function renderDict() {
  const root = $("dict");
  const entries = window.ChordDictionary.buildDictionary(song()); // count desc by default
  if (state.dictSort === "alpha") {
    entries.sort((a, b) =>
      a.chord.localeCompare(b.chord, undefined, { numeric: true, sensitivity: "base" })
      || (a.voicing || "").localeCompare(b.voicing || ""));
  }
  root.innerHTML = "";

  // sort control
  const sortBar = document.createElement("div");
  sortBar.className = "dsort";
  sortBar.innerHTML = `sort:
    <button class="tab ${state.dictSort === "count" ? "active" : ""}" data-sort="count">count</button>
    <button class="tab ${state.dictSort === "alpha" ? "active" : ""}" data-sort="alpha">A–Z</button>`;
  sortBar.querySelectorAll("[data-sort]").forEach((b) =>
    b.addEventListener("click", () => { state.dictSort = b.dataset.sort; renderDict(); }));
  root.appendChild(sortBar);

  // merge bar (shown when 2+ selected). If dictMergeOpen, render the inline merge form.
  if (state.dictSel.size < 2) state.dictMergeOpen = false;
  const mergeBar = document.createElement("div");
  mergeBar.className = "dmergebar" + (state.dictSel.size >= 2 ? " show" : "");
  mergeBar.innerHTML = `<b>${state.dictSel.size} selected</b> — merge into one chord:
    <button class="apply" id="dMergeBtn">Merge…</button>
    <button id="dClearSel">Clear</button>
    <div class="dmergeform" id="dMergeForm" style="display:none">
      <input type="text" id="dMergeName" placeholder="chord name">
      <input type="text" id="dMergeVoicing" placeholder="voicing (comma form, blank = none)">
      <button class="apply" id="dMergeApply">Apply</button>
      <button id="dMergeCancel">Cancel</button>
      <span class="err" id="dMergeErr"></span>
    </div>`;
  root.appendChild(mergeBar);
  if (state.dictSel.size >= 2) {
    const largest = entries
      .filter((e) => state.dictSel.has(e.key))
      .sort((a, b) => b.count - a.count)[0];
    const form = $("dMergeForm");
    $("dMergeBtn").addEventListener("click", () => {
      state.dictMergeOpen = true;
      form.style.display = "flex";
      if (largest) { $("dMergeName").value = largest.chord; $("dMergeVoicing").value = largest.voicing || ""; }
    });
    $("dClearSel").addEventListener("click", () => { state.dictSel.clear(); state.dictMergeOpen = false; renderDict(); });
    $("dMergeCancel").addEventListener("click", () => { state.dictMergeOpen = false; form.style.display = "none"; });
    $("dMergeApply").addEventListener("click", () => applyMerge());
    if (state.dictMergeOpen) {
      form.style.display = "flex";
      if (largest) { $("dMergeName").value = largest.chord; $("dMergeVoicing").value = largest.voicing || ""; }
    }
  }

  entries.forEach((e) => {
    const row = document.createElement("div");
    row.className = "drow" + (state.dictSel.has(e.key) ? " sel" : "");
    const mism = e.nameMatchesVoicing === false ? '<span class="warn"></span>' : "";
    const ivals = intervalsFor(e.voicing);
    const civals = chordIvalsFor(e.voicing, e.chord);
    row.innerHTML = `<div class="dhead">
      <input type="checkbox" ${state.dictSel.has(e.key) ? "checked" : ""} data-sel="${esc(e.key)}">
      <span class="dnm">${esc(e.chord)}</span>${mism}
      <span class="dvc">${esc(e.voicing || "—")}</span>
      ${e.voicing ? window.ChordDiagram.svg(e.voicing) : ""}
      <span class="dnt">${esc(notesFor(e.voicing))}</span>
      ${civals ? `<span class="dci">${esc(civals)}</span>` : ""}
      ${ivals ? `<span class="div">${esc(ivals)}</span>` : ""}
      <span class="dct">${e.count}×</span>
    </div>`;
    row.querySelector("[data-sel]").addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (state.dictSel.has(e.key)) state.dictSel.delete(e.key);
      else state.dictSel.add(e.key);
      renderDict();
    });
    row.querySelector(".dhead").addEventListener("click", () => {
      state.dictEdit = state.dictEdit === e.key ? null : e.key;
      renderDict();
    });
    if (state.dictEdit === e.key) row.appendChild(buildDictEditor(e));
    root.appendChild(row);
  });
}

// Apply the inline merge form: validate name, merge selected groups, re-render.
function applyMerge() {
  const name = $("dMergeName").value.trim();
  const voicing = $("dMergeVoicing").value.trim();
  const v = window.ChordNaming.validateName(name);
  if (!v.valid && name !== "%") { $("dMergeErr").textContent = "Not a valid ChordMark chord: " + name; return; }
  pushUndo();
  window.ChordDictionary.mergeEntries(song(), [...state.dictSel], { chord: name, voicing });
  state.dictSel.clear();
  state.dictEdit = null;
  state.dictMergeOpen = false;
  markDirty();
  renderBars();
  renderDict();
}

function buildDictEditor(entry) {
  const wrap = document.createElement("div");
  wrap.className = "dedit";
  wrap.addEventListener("click", (e) => e.stopPropagation());
  wrap.innerHTML = `
    <input type="text" class="dName" value="${esc(entry.chord)}">
    <div class="dFb"></div>
    <div class="derr err"></div>
    <div class="dsuggest"></div>
    <div class="dactions">
      <button class="apply">Apply to ${entry.count}×</button>
      <button class="cancel">Cancel</button>
    </div>`;
  let curVoicing = entry.voicing
    ? parseVoicing(entry.voicing)
    : ["x", "x", "x", "x", "x", "x"];
  const fb = window.Fretboard(wrap.querySelector(".dFb"), (v) => { curVoicing = v; refreshSug(); });
  fb.set(curVoicing);

  function refreshSug() {
    const sug = window.ChordNaming.suggestNames(curVoicing);
    wrap.querySelector(".dsuggest").innerHTML =
      sug.map((s) => `<span class="s" data-n="${esc(s.name)}">${esc(s.name)}</span>`).join("");
    wrap.querySelectorAll(".dsuggest .s").forEach((el) =>
      el.addEventListener("click", () => { wrap.querySelector(".dName").value = el.dataset.n; }));
  }
  refreshSug();

  wrap.querySelector(".apply").addEventListener("click", () => {
    const name = wrap.querySelector(".dName").value.trim();
    const v = window.ChordNaming.validateName(name);
    if (!v.valid && name !== "%") { wrap.querySelector(".derr").textContent = "Not a valid ChordMark chord: " + name; return; }
    const vc = fb.get();
    const voicing = vc.every((f) => f === "x") ? "" : vc.join(",");
    pushUndo();
    window.ChordDictionary.applyEdit(song(), entry.key, { chord: name, voicing });
    state.dictEdit = null;
    markDirty();
    renderBars();
    renderDict();
  });
  wrap.querySelector(".cancel").addEventListener("click", () => { state.dictEdit = null; renderDict(); });
  return wrap;
}

init();
