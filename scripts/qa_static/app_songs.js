// Song list sidebar, song loading/saving, and the dirty-guard navigation.
const LAST_SONGS_KEY = "qaLastSongByAlbum";

function rememberedSong(album) {
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_SONGS_KEY) || "{}");
    return saved && typeof saved[album] === "string" ? saved[album] : "";
  } catch (_error) {
    return "";
  }
}

function rememberSong(album, file) {
  if (!album || !file) return;
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_SONGS_KEY) || "{}");
    const next = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
    next[album] = file;
    localStorage.setItem(LAST_SONGS_KEY, JSON.stringify(next));
  } catch (_error) {
    // Storage can be disabled or full; song loading must still work.
  }
}

function fillSongs() {
  const songSel = $("songSel");
  const album = $("albumSel").value;
  const a = albums.find((x) => x.album === album);
  const songs = (a && a.songs) || [];
  songSel.innerHTML = songs
    .map((s) => `<option value="${esc(s.file)}">${STATUS_LABEL[s.status] || "○"}  ${esc(s.file)}</option>`)
    .join("");
  const remembered = rememberedSong(album);
  if (songs.some((s) => s.file === remembered)) songSel.value = remembered;
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
    const row = document.createElement("button");
    row.type = "button";
    row.className = "song-row" + (s.file === state.file ? " sel" : "");
    row.setAttribute("aria-current", s.file === state.file ? "true" : "false");
    const statusName = (STATUS_LABEL[s.status] || STATUS_LABEL.pending)
      .replace(/^\S+\s*/, "");
    row.setAttribute("aria-label", `${prettyFile(s.file)}, ${statusName}`);
    // audit badge: print-diff count (review backlog), or ✓ when the CV audit
    // confirmed every voicing — a "ready to confirm" candidate at a glance
    const badge = !s.audited ? ""
      : s.print_diffs ? `<span class="sdiff" title="${s.print_diffs} voicings differ from print">${s.print_diffs}</span>`
      : `<span class="sdiff ok" title="all voicings match print">✓</span>`;
    row.innerHTML =
      `<span class="sg">${esc(statusGlyph(s.status))}</span>` +
      `<span class="snm" title="${esc(s.file)}">${esc(prettyFile(s.file))}</span>` +
      badge;
    row.addEventListener("click", () => selectSong(s.file));
    list.appendChild(row);
  });
}

function syncCurrentSongTitle() {
  const title = $("currentSongTitle");
  if (!title) return;
  title.textContent = state.doc && state.doc.songs && state.doc.songs.length
    ? (song().title || "")
    : "";
  title.title = title.textContent;
}

// Load a song by file, going through the dirty-guard.
function selectSong(file) {
  if (file === state.file && (state.doc || loadingSong)) return;
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
  if (typeof confirmChordDraftDiscard === "function" && !confirmChordDraftDiscard()) return false;
  if (typeof confirmLyricDraftDiscard === "function" && !confirmLyricDraftDiscard()) return false;
  const jsonEdits = typeof hasUnappliedJsonEdits === "function" && hasUnappliedJsonEdits();
  if (!state.dirty && !jsonEdits) return true;
  const msg = state.dirty && jsonEdits
    ? "Discard unsaved changes and unapplied JSON edits?"
    : jsonEdits
      ? "Discard unapplied JSON edits?"
      : "Discard unsaved changes?";
  return confirm(msg);
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
  state.songRevision = null;
  state.sel = null;
  state.flags = [];
  state.dirty = false;
  state.savedSnapshot = null;
  state.editVersion = 0;
  syncSaveAvailability();
  undoStack = [];
  redoStack = [];
  $("pages").innerHTML = "";
  $("bars").innerHTML = `<div class="empty">No song to show. Pick an album and song from the sidebar.</div>`;
  $("editor").classList.remove("open");
  syncNote();
  renderProvenance();
  syncCurrentSongTitle();
  renderSongList();
  if (typeof resetJsonEditorState === "function") resetJsonEditorState();
  if (typeof resetReviewInputs === "function") resetReviewInputs();
  showView("bars");
  if (typeof updateChordReviewEntryPoint === "function") updateChordReviewEntryPoint();
}

let loadGeneration = 0;
let loadingSong = false;

function clearSongForLoad(message, view = "bars") {
  state.doc = null;
  state.songRevision = null;
  state.sel = null;
  state.flags = [];
  state.dirty = false;
  state.savedSnapshot = null;
  state.editVersion = 0;
  syncSaveAvailability();
  undoStack = [];
  redoStack = [];
  $("pages").innerHTML = "";
  $("bars").innerHTML = `<div class="empty">${esc(message)}</div>`;
  $("editor").classList.remove("open");
  syncNote();
  renderProvenance();
  syncCurrentSongTitle();
  renderSongList();
  if (typeof resetJsonEditorState === "function") resetJsonEditorState();
  if (typeof resetReviewInputs === "function") resetReviewInputs();
  showView(view);
}

async function loadSong({ view = "bars" } = {}) {
  const generation = ++loadGeneration;
  $("saveStatus").textContent = "";
  const album = $("albumSel").value;
  const file = $("songSel").value;
  state.album = album;
  state.file = file;
  state.dictSel.clear();
  state.dictEdit = null;
  state.dictMergeOpen = false;
  loadingSong = Boolean(album && file);
  if (!album || !file) { showEmpty(); return; }
  clearSongForLoad("Loading song…", view);
  let loaded;
  try {
    loaded = await api(`/api/song/${album}/${file}`);
  } catch (_error) {
    if (generation !== loadGeneration) return;
    loadingSong = false;
    clearSongForLoad("Could not load this song.", view);
    if (typeof updateChordReviewEntryPoint === "function") updateChordReviewEntryPoint();
    return;
  }
  if (generation !== loadGeneration) return;
  loadingSong = false;
  if (!loaded || loaded.error || !loaded.songs || !loaded.songs.length) {
    clearSongForLoad("Could not load this song.", view);
    if (typeof updateChordReviewEntryPoint === "function") updateChordReviewEntryPoint();
    return;
  }
  state.doc = loaded;
  state.songRevision = loaded[Symbol.for("songsheetRevision")] || null;
  state.sel = null;
  state.dirty = false;
  state.savedSnapshot = JSON.stringify(loaded);
  state.editVersion = 0;
  syncSaveAvailability();
  rememberSong(album, file);
  const status = (state.doc.document && state.doc.document.status) || "pending";
  $("statusSel").value = status;
  $("keySel").value = songKey();
  window.ChordNaming.setKeyTonic(songKey());
  syncNote();
  renderProvenance();
  syncCurrentSongTitle();
  renderPages();
  renderBars();
  renderSongList();
  if (typeof resetReviewInputs === "function") resetReviewInputs();
  showView(view);
  $("editor").classList.remove("open");
  if (typeof updateChordReviewEntryPoint === "function") updateChordReviewEntryPoint();
}

let savePromise = null;

function syncSaveAvailability() {
  const button = $("saveBtn");
  if (button) button.disabled = Boolean(savePromise) || !state.doc;
}

async function saveOnce() {
  const status = $("saveStatus");
  const submittedDoc = state.doc;
  const submittedJson = JSON.stringify(submittedDoc);
  const submittedEditVersion = state.editVersion || 0;
  const submittedGeneration = loadGeneration;
  const submittedAlbum = state.album;
  const submittedFile = state.file;
  const params = new URLSearchParams();
  if (state.songRevision) {
    params.set("revision", state.songRevision);
    if (typeof legacyScanOrderChanged === "function" && legacyScanOrderChanged()) {
      params.set("legacy_scan_order", "changed");
    }
  }
  const query = params.size ? `?${params}` : "";
  const submittedStatus =
    (submittedDoc.document && submittedDoc.document.status) || "pending";
  status.textContent = "saving…"; status.style.color = "var(--muted)";
  let res;
  try {
    res = await api(`/api/song/${submittedAlbum}/${submittedFile}${query}`,
      { method: "POST", body: submittedJson });
  } catch (error) {
    if (state.doc === submittedDoc) {
      status.textContent = "Unsaved changes · save failed: " + String(error);
      status.style.color = "var(--bad)";
    }
    return { ok: false, error: String(error) };
  }
  if (res.ok) {
    if (res.revision && submittedGeneration === loadGeneration) {
      state.songRevision = res.revision;
    }
    const sameDocument = state.doc === submittedDoc;
    if (submittedGeneration === loadGeneration && state.doc &&
        state.album === submittedAlbum && state.file === submittedFile) {
      state.savedSnapshot = submittedJson;
    }
    const unchanged = sameDocument &&
      (state.editVersion || 0) === submittedEditVersion &&
      JSON.stringify(state.doc) === submittedJson;
    if (unchanged) {
      status.textContent = "✓ saved";
      state.dirty = false;
    } else if (sameDocument) {
      status.textContent = "Unsaved changes";
    }
    if (submittedGeneration === loadGeneration && state.doc &&
        state.album === submittedAlbum && state.file === submittedFile &&
        typeof syncSavedScanDocument === "function") {
      syncSavedScanDocument(unchanged ? state.doc : JSON.parse(submittedJson), unchanged);
    }
    if (sameDocument) status.style.color = unchanged ? "var(--ok)" : "#d29922";
    // reflect the saved status in the local album cache → progress count + dropdown label
    const a = albums.find((x) => x.album === submittedAlbum);
    const s = a && a.songs && a.songs.find((x) => x.file === submittedFile);
    if (s) {
      s.status = submittedStatus;
      const sameSelection = state.album === submittedAlbum && state.file === submittedFile;
      const opt = sameSelection
        ? [...$("songSel").options].find((o) => o.value === submittedFile)
        : null;
      if (opt) opt.textContent = `${STATUS_LABEL[s.status] || "○"}  ${s.file}`;
      if (sameSelection) {
        renderSongList();
        updateProgress();
      }
    }
    // refresh the preview (it renders the in-memory doc, so this just re-syncs)
    if (sameDocument && state.activeView === "preview") renderPreview();
    if (typeof shapesUI === "object" && shapesUI) {
      shapesUI.loaded = false;
      shapesUI.stale = true;
    }
  } else if (state.doc === submittedDoc) {
    status.textContent = "Unsaved changes · save failed: " + res.error;
    status.style.color = "var(--bad)";
  }
  return res;
}

function shapeWritesReady(files) {
  const affectsCurrent = !files?.length ||
    files.some(({ album, file }) => album === state.album && file === state.file);
  const hasDraft = typeof chordEditorHasDraft === "function" && chordEditorHasDraft();
  return !loadingSong && !savePromise &&
    (!affectsCurrent || (!state.dirty && !hasDraft));
}

async function refreshAfterShapeWrite(files) {
  if (!files?.some(({ album, file }) => album === state.album && file === state.file)) return true;
  if (!shapeWritesReady(files)) return false;
  await loadSong({ view: state.activeView });
  return Boolean(state.doc);
}

async function openShapeOccurrence(item) {
  if (item.song_index !== 0) {
    throw new Error("Open the indexed arrangement as a separate song to edit it.");
  }
  const sameSong = item.album === state.album && item.file === state.file;
  const current = sameSong && state.doc && state.songRevision === item.document_sha256;
  if (!current) {
    if (!confirmDiscard()) return false;
    if (!albums.some((album) => album.album === item.album &&
        album.songs.some((record) => record.file === item.file))) {
      throw new Error("The song is no longer in the library. Refresh Shapes.");
    }
    $("albumSel").value = item.album;
    fillSongs();
    $("songSel").value = item.file;
    await loadSong({ view: "shapes" });
  } else if (state.dirty) {
    throw new Error("Save your song edits and refresh Shapes to update the chord positions.");
  }
  if (!state.doc || state.album !== item.album || state.file !== item.file ||
      state.songRevision !== item.document_sha256) {
    throw new Error("The song changed. Refresh Shapes to locate the chord.");
  }
  const selected = { si: item.si, bi: item.bi, ei: item.ei };
  if (!song().sections[item.si]?.bars[item.bi]?.[item.ei]) {
    throw new Error("The chord was moved. Refresh Shapes.");
  }
  jumpToEntry(selected);
  if (localStorage.getItem("qaHidePages") === "1") toggleLayoutPane("pages");
}

function hasClass(el, name) {
  if (!el) return false;
  const cl = el.classList;
  if (cl && typeof cl.contains === "function") return cl.contains(name);
  const cls = typeof el.className === "string" ? el.className.split(/\s+/) : [];
  return cls.includes(name);
}

function isFretboardTextInput(el) {
  return hasClass(el, "fb-text");
}

function isBlurCommittedInput(el) {
  if (!el) return false;
  if (el.id === "songNote") return true;
  return hasClass(el, "seclabel") || hasClass(el, "ly-line-edit") || hasClass(el, "ly-edit");
}

function flushBlurCommittedInputs() {
  if (typeof document === "undefined") return true;
  const active = document.activeElement;
  const candidates = [];
  const seen = new Set();
  const addCandidate = (el) => {
    if (!el || seen.has(el) || isFretboardTextInput(el)) return;
    seen.add(el);
    candidates.push(el);
  };
  addCandidate(active);
  if (typeof document.querySelectorAll === "function") {
    for (const el of document.querySelectorAll(".ly-line-edit, .ly-edit, .seclabel")) {
      addCandidate(el);
    }
  }
  for (const el of candidates) {
    if (typeof el._validateOnSave === "function" && el._validateOnSave() === false) {
      return false;
    }
  }
  let needsRender = false;
  const onCommit = () => { needsRender = true; };
  const flushDeferredRender = () => {
    if (!needsRender) return;
    if (typeof syncChordEditorUneditedText === "function") syncChordEditorUneditedText();
    if (typeof renderSongList === "function") renderSongList();
    if (typeof renderBars === "function") renderBars();
    if (typeof renderLyrics === "function") renderLyrics();
    if (typeof state === "object" && state && state.activeView === "preview" &&
        typeof renderPreview === "function") {
      renderPreview();
    }
  };
  for (const el of candidates) {
    if (typeof el._commitOnSave === "function") {
      if (el._commitOnSave({ deferRender: true, onCommit, skipChordDraftDiscard: true }) === false) {
        flushDeferredRender();
        return false;
      }
    } else if (el === active && isBlurCommittedInput(el) &&
        typeof el._validateOnSave !== "function" && typeof el.blur === "function") {
      el.blur();
    }
  }
  flushDeferredRender();
  return true;
}

function saveBlocked(message) {
  const status = $("saveStatus");
  if (status) {
    status.textContent = message;
    status.style.color = "var(--bad)";
  }
  syncSaveAvailability();
  return Promise.resolve({ ok: false, blocked: true, error: message });
}

function save() {
  if (!state.doc) return Promise.resolve();
  if (savePromise) return savePromise;
  if (typeof hasUnappliedJsonEdits === "function" && hasUnappliedJsonEdits()) {
    if (typeof jsonApply !== "function" || !jsonApply()) {
      return Promise.resolve({ ok: false, error: "Invalid JSON edits" });
    }
  }
  if (!flushBlurCommittedInputs()) {
    return saveBlocked((state.dirty ? "Unsaved changes · " : "") + "fix invalid input before saving");
  }
  if (typeof chordEditorHasDraft === "function" && chordEditorHasDraft()) {
    if (state.activeView !== "bars" && state.activeView !== "chordReview" &&
        typeof showView === "function") showView("bars");
    const applied = typeof submitActiveChord === "function" && submitActiveChord();
    if (!applied) {
      return saveBlocked((state.dirty ? "Unsaved changes · " : "") + "fix or apply chord edits before saving");
    }
  }
  const button = $("saveBtn");
  if (button) button.disabled = true;
  savePromise = saveOnce().finally(() => {
    savePromise = null;
    syncSaveAvailability();
  });
  return savePromise;
}

if (typeof module === "object" && module.exports) {
  module.exports = { confirmDiscard, fillSongs, loadSong, renderSongList, save };
}
