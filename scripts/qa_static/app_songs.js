// Song list sidebar, song loading/saving, and the dirty-guard navigation.
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
