// Songsheet QA app — entry point: init (event wiring), global keyboard
// shortcuts, and the layout focus toggles. The rest of the app lives in the
// app_* classic scripts loaded before this one (see index.html for the order):
//   app_core.js    state + undo/redo + shared helpers
//   app_songs.js   song list sidebar, load/save, dirty-guard navigation
//   app_bars.js    Bars view, chord editor, structural edits (doc_ops.js)
//   app_lyrics.js  Lyrics view prototype (drag re-anchoring)
//   app_views.js   tab switching, Review, Preview + exports, JSON (CodeMirror)
//   app_dict.js    Dictionary view (chord_dictionary.js logic)
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
  $("tabLyrics").addEventListener("click", () => showView("lyrics"));
  $("tabReview").addEventListener("click", () => showView("review"));
  $("tabDict").addEventListener("click", () => showView("dict"));
  $("tabHarmony").addEventListener("click", () => showView("harmony"));
  $("tabPreview").addEventListener("click", () => showView("preview"));
  $("tabJson").addEventListener("click", () => showView("json"));
  $("jsonApply").addEventListener("click", jsonApply);
  $("jsonReload").addEventListener("click", jsonReload);
  $("jsonFormat").addEventListener("click", jsonFormat);
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

  // layout toggles (focus mode): hide the PDF-scan pane and/or the song list.
  // Persisted in localStorage; `\` toggles the scan pane from the keyboard.
  $("scanToggle").addEventListener("click", () => toggleLayoutPane("pages"));
  $("songsToggle").addEventListener("click", () => toggleLayoutPane("songs"));
  applyLayoutToggles();

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

// ---- layout focus mode ----
// Hide the PDF-scan pane / song list to give the working pane the full width
// (the three-pane layout gets cramped once lanes + panel are on screen).
function applyLayoutToggles() {
  const noPages = localStorage.getItem("qaHidePages") === "1";
  const noSongs = localStorage.getItem("qaHideSongs") === "1";
  const layout = document.querySelector(".layout");
  layout.classList.toggle("no-pages", noPages);
  layout.classList.toggle("no-songs", noSongs);
  $("scanToggle").classList.toggle("active", !noPages);
  $("songsToggle").classList.toggle("active", !noSongs);
}

function toggleLayoutPane(which) {
  const key = which === "pages" ? "qaHidePages" : "qaHideSongs";
  localStorage.setItem(key, localStorage.getItem(key) === "1" ? "0" : "1");
  applyLayoutToggles();
}

// Global keyboard shortcuts. We ignore most keys while typing in a field,
// except ⌘S/Ctrl+S (Save) and Esc (close editor), which work everywhere.
function onKeydown(ev) {
  const el = ev.target;
  const inCM = el && el.closest && el.closest(".CodeMirror");
  const typing = !!inCM ||
    (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT"));

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

  if (ev.key === "\\") { ev.preventDefault(); toggleLayoutPane("pages"); return; }
  if (ev.key === "n") { ev.preventDefault(); stepSong(+1); }
  else if (ev.key === "p") { ev.preventDefault(); stepSong(-1); }
  else if (ev.key === "]") { ev.preventDefault(); stepEntry(+1); }
  else if (ev.key === "[") { ev.preventDefault(); stepEntry(-1); }
  else if (ev.key === "}") { ev.preventDefault(); nextFlagged(); }
  else if (ev.key === "{") { ev.preventDefault(); prevFlagged(); }
}

init();
