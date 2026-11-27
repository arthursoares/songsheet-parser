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

  $("workspaceSongs").addEventListener("click", () => {
    if (state.activeView === "shapes") showView(state.lastSongView || "bars");
  });
  $("workspaceShapes").addEventListener("click", () => showView("shapes"));

  albumSel.addEventListener("change", () => {
    if (!confirmDiscard()) { albumSel.value = state.album; return; }
    fillSongs();
    loadSong();
  });
  songSel.addEventListener("change", () => {
    if (!confirmDiscard()) { songSel.value = state.file; return; }
    loadSong();
  });

  $("saveBtn").addEventListener("click", save);
  $("undoBtn").addEventListener("click", undo);
  $("redoBtn").addEventListener("click", redo);
  $("statusSel").addEventListener("change", (ev) => {
    if (!state.doc) return;
    pushUndo();
    state.doc.document.status = ev.target.value;
    markDirty();
    if (typeof ReviewUI === "object") ReviewUI.documentChanged?.();
    if (state.activeView === "json" && typeof renderJson === "function" &&
        !(typeof hasUnappliedJsonEdits === "function" && hasUnappliedJsonEdits())) {
      renderJson();
    }
  });
  // key selector — drives interval analysis; stored on song.key. Major + minor.
  const keySel = $("keySel");
  const ROOTS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const KEYS = ROOTS.concat(ROOTS.map((r) => r + "m")); // major then minor
  keySel.innerHTML = '<option value="">key: —</option>' +
    KEYS.map((k) => `<option value="${esc(k)}">key: ${esc(k)}</option>`).join("");
  keySel.addEventListener("change", (ev) => {
    if (!state.doc) return;
    if (typeof confirmChordDraftDiscard === "function" && !confirmChordDraftDiscard()) {
      keySel.value = songKey();
      return;
    }
    pushUndo();
    song().key = ev.target.value || null;
    markDirty();
    window.ChordNaming.setKeyTonic(songKey());
    renderBars();
    if (state.activeView === "review" && typeof renderReview === "function") renderReview();
    if (state.activeView === "dict") renderDict();
    if (state.activeView === "harmony" && typeof renderHarmony === "function") renderHarmony();
    if (state.activeView === "preview") renderPreview();
    if (state.activeView === "json" && typeof renderJson === "function" &&
        !(typeof hasUnappliedJsonEdits === "function" && hasUnappliedJsonEdits())) {
      renderJson();
    }
    if (state.sel) openEditor(state.sel.si, state.sel.bi, state.sel.ei);
  });
  // song-list sidebar: search + status filter
  $("songSearchClear").addEventListener("click", () => {
    state.songSearch = "";
    $("songSearch").value = "";
    renderSongList();
    $("songSearch").focus();
  });
  $("songSearch").addEventListener("input", (ev) => {
    state.songSearch = ev.target.value;
    renderSongList();
  });
  $("songsFilter").querySelectorAll("[data-filter]").forEach((b) =>
    b.addEventListener("click", () => {
      state.songFilter = b.dataset.filter;
      $("songsFilter").querySelectorAll("[data-filter]").forEach((x) => {
        x.classList.toggle("active", x === b);
        x.setAttribute("aria-pressed", String(x === b));
      });
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
  if (typeof ReviewUI === "object" && ReviewUI) {
    ReviewUI.wire?.();
    $("reviewRecord")?.addEventListener("click", ReviewUI.recordSelected);
    $("reviewField")?.addEventListener("change", () => {
      if (typeof ReviewUI.syncInputs === "function") ReviewUI.syncInputs();
    });
  }
  $("cmCopy").addEventListener("click", copyChordmark);
  ["pvStyle", "pvDict", "pvDiagrams", "pvBars"].forEach((id) =>
    $(id).addEventListener("change", () => {
      if (state.activeView === "preview") renderPreview();
    }));
  // Source toggle: show/hide the generated .chordmark source beside the render.
  $("pvSource").addEventListener("change", () => {
    if (state.activeView === "preview") togglePreviewSource();
  });
  wireExport();

  // global flat/sharp spelling toggle — re-renders bars (and editor if open)
  const spellBtn = $("spellToggle");
  spellBtn.addEventListener("click", () => {
    if (typeof confirmChordDraftDiscard === "function" && !confirmChordDraftDiscard()) return;
    const next = window.ChordNaming.getSpelling() === "sharp" ? "flat" : "sharp";
    window.ChordNaming.setSpelling(next);
    spellBtn.textContent = next === "flat" ? "♭/♯" : "♯/♭";
    spellBtn.title = `Note spelling: ${next} (click to switch)`;
    renderBars();
    if (state.activeView === "dict") renderDict();
    if (state.activeView === "harmony" && typeof renderHarmony === "function") renderHarmony();
    if (state.sel) openEditor(state.sel.si, state.sel.bi, state.sel.ei);
  });

  // layout toggles (focus mode): hide the PDF-scan pane and/or the song list.
  // Persisted in localStorage; `\` toggles the scan pane from the keyboard.
  $("scanToggle").addEventListener("click", () => toggleLayoutPane("pages"));
  $("songsToggle").addEventListener("click", () => toggleLayoutPane("songs"));
  $("noteToggle").addEventListener("click", function openSongNote() {
    if (state.activeView === "chordReview" && showView("bars") === false) return;
    localStorage.setItem("qaHideSongs", "0");
    applyLayoutToggles();
    $("songNote").focus();
  });
  applyLayoutToggles();
  wireChordReview();
  wireScanReview();
  $("kbdHint").addEventListener("click", showShortcutDialog);

  window.addEventListener("beforeunload", (e) => {
    const jsonEdits = typeof hasUnappliedJsonEdits === "function" && hasUnappliedJsonEdits();
    const chordDraft = typeof chordEditorHasDraft === "function" && chordEditorHasDraft();
    if (state.dirty || jsonEdits || chordDraft) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // per-song note: one undo per editing session (focus → blur), commit on blur.
  const noteTa = $("songNote");
  if (noteTa) {
    let noteStart = noteTa.value || "";
    const syncBaseline = () => { noteStart = noteTa.value; };
    const commitNote = () => {
      if (!state.doc) return true;
      const next = noteTa.value;
      if (next === noteStart) return true;
      pushUndo();
      if (next.trim() === "") delete song().note;
      else song().note = next;
      noteStart = next;
      markDirty();
      return true;
    };
    noteTa._syncBaseline = syncBaseline;
    noteTa._commitOnSave = commitNote;
    noteTa.addEventListener("focus", syncBaseline);
    noteTa.addEventListener("blur", commitNote);
  }

  $("nextFlagBtn").addEventListener("click", () => {
    if (state.activeView === "chordReview") {
      if (typeof moveChordReview === "function") moveChordReview(1, true);
    } else nextFlagged();
  });
  document.addEventListener("keydown", onKeydown);
  document.addEventListener("pointerdown", () => { keyboardFocus = false; }, true);
  document.addEventListener("mousedown", () => { keyboardFocus = false; }, true);
  document.addEventListener("click", (ev) => {
    const btn = ev.target?.closest?.("button");
    if (btn && ev.detail > 0 && !btn.hasAttribute("aria-pressed")) {
      btn.blur?.();
    }
  });
  const header = document.querySelector("header");
  const syncHeaderHeight = () => {
    document.documentElement.style.setProperty("--qa-header-height", `${header.offsetHeight}px`);
  };
  syncHeaderHeight();
  if (typeof ResizeObserver === "function") new ResizeObserver(syncHeaderHeight).observe(header);

  fillSongs();
  loadSong();
}

// ---- layout focus mode ----
// Hide the PDF-scan pane / song list to give the working pane the full width
// (the three-pane layout gets cramped once lanes + panel are on screen).
function applyLayoutToggles() {
  const reviewing = state.activeView === "chordReview";
  const shapes = state.activeView === "shapes";
  const noPages = localStorage.getItem("qaHidePages") === "1";
  const noSongs = reviewing || localStorage.getItem("qaHideSongs") === "1";
  const layout = document.querySelector(".layout");
  layout.classList.toggle("chord-review-mode", reviewing);
  layout.classList.toggle("shapes-mode", shapes);
  document.querySelector("header")?.classList.toggle("shapes-mode", shapes);
  layout.classList.toggle("no-pages", noPages);
  layout.classList.toggle("no-songs", noSongs);
  $("scanToggle").classList.toggle("active", !noPages);
  $("songsToggle").classList.toggle("active", !noSongs);
  $("songsToggle").disabled = reviewing;
}

function toggleLayoutPane(which) {
  const key = which === "pages" ? "qaHidePages" : "qaHideSongs";
  localStorage.setItem(key, localStorage.getItem(key) === "1" ? "0" : "1");
  applyLayoutToggles();
  if (which === "pages" && localStorage.getItem(key) !== "1") updateScanSelection(true);
}

function showShortcutDialog() {
  const dialog = $("shortcutDialog");
  if (!dialog.open) dialog.showModal();
}

let keyboardFocus = false;

function handleChordWorkspaceKey(ev) {
  const reviewing = state.activeView === "chordReview";
  if ((!reviewing && state.activeView !== "bars") || !state.doc || ev.defaultPrevented) return false;
  const key = String(ev.key || "").toLowerCase();
  if (!reviewing && ev.shiftKey && /^[hjkl]$/.test(key)) {
    const selection = activeChordSelection();
    if (selection && !ev.repeat && typeof moveChordSelection === "function") {
      moveChordSelection(selection, key === "h" || key === "k" ? -1 : 1, key === "h" || key === "l");
    }
    return true;
  }
  if (reviewing && ev.shiftKey && (key === "j" || key === "k")) return false;
  if (key === "h" || key === "l" || key === "arrowleft" || key === "arrowright") {
    const dir = key === "h" || key === "arrowleft" ? -1 : 1;
    if (reviewing) {
      if (typeof moveChordReview === "function") moveChordReview(dir, ev.shiftKey);
    } else if (ev.shiftKey) stepFlagged(dir);
    else stepEntry(dir);
    return true;
  }
  if (key === "j" || key === "k" || key === "arrowdown" || key === "arrowup") {
    stepBar(key === "j" || key === "arrowdown" ? 1 : -1);
    return true;
  }
  if (/^[1-4]$/.test(key)) {
    if (!reviewing && !$("editor").classList.contains("open")) return false;
    const suggestions = $(reviewing ? "chordReviewSuggestions" : "edSuggest");
    const button = suggestions?.querySelector(`[data-suggestion="${Number(key) - 1}"]`);
    if (button && !ev.repeat) button.click();
    return Boolean(button);
  }
  const advance = key === " " || ev.code === "Space";
  if (key === "a" && !reviewing) {
    if (!state.sel || !$("editor").classList.contains("open")) return false;
    if (!ev.repeat && typeof submitActiveChord === "function") submitActiveChord({ usePrinted: true, advance: true });
    return true;
  }
  if (key === "s" && !reviewing) {
    const selection = activeChordSelection();
    const entry = selection && typeof song === "function"
      ? song()?.sections?.[selection.si]?.bars?.[selection.bi]?.[selection.ei]
      : null;
    const defer = $("editor").classList.contains("open") && $("edDeferReview");
    if (!selection || !defer || entry?.chord === "%") return false;
    if (!ev.repeat) defer.click();
    return true;
  }
  if (key === "r" || advance) {
    if (advance && ev.target?.tagName === "BUTTON") {
      const fromKeyboard = keyboardFocus || Boolean(ev.target.matches?.(":focus-visible"));
      if (fromKeyboard) return false;
      ev.target.blur?.();
    }
    const selection = activeChordSelection();
    const mark = !reviewing && $("editor").classList.contains("open") && $("edMarkReviewed");
    if (!selection || (!reviewing && !mark)) return false;
    if (ev.repeat) return true;
    if (reviewing) {
      if (typeof decideChordReview === "function") decideChordReview("keep", advance);
    } else if (advance) {
      if (typeof submitActiveChord === "function") submitActiveChord({ advance: true });
    } else {
      mark.click();
    }
    return true;
  }
  return reviewing && typeof handleChordReviewKey === "function" && handleChordReviewKey(ev);
}

// Global keyboard shortcuts. We ignore most keys while typing in a field,
// except ⌘S/Ctrl+S (Save) and Esc (close editor), which work everywhere.
function onKeydown(ev) {
  if (ev.key === "Tab") {
    keyboardFocus = true;
  } else if (ev.key && !["Shift", "Control", "Alt", "Meta"].includes(ev.key) && ev.target?.tagName !== "BUTTON") {
    keyboardFocus = false;
  }
  if ($("shortcutDialog").open) return;
  const el = ev.target;
  const inCM = el && el.closest && el.closest(".CodeMirror");
  const typing = !!inCM ||
    (el && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT"));

  // ⌘S / Ctrl+S → Save (always)
  if ((ev.metaKey || ev.ctrlKey) && (ev.key === "s" || ev.key === "S")) {
    ev.preventDefault();
    save();
    return;
  }
  // ⌘Enter / Ctrl+Enter → Apply JSON edits when in JSON view
  if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter" && !ev.defaultPrevented &&
      state.activeView === "json" && typeof jsonApply === "function") {
    ev.preventDefault();
    jsonApply();
    return;
  }
  if (state.activeView === "shapes") {
    if (!typing && (ev.key === "?" || ev.key === "/")) {
      ev.preventDefault();
      showShortcutDialog();
    }
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
    if (ev.defaultPrevented) return;
    if (state.activeView === "chordReview" && $("editor").classList.contains("editor-inline")) {
      ev.preventDefault();
      $("edCancel").click();
      return;
    }
    if (state.activeView === "chordReview" && !typing) {
      showView("bars");
      $("chordReviewToggle").focus();
      return;
    }
    if (state.activeView === "bars" && $("editor").classList.contains("open")) {
      if (typeof confirmChordDraftDiscard === "function" && !confirmChordDraftDiscard()) return;
      $("editor").classList.remove("open");
      state.sel = null;
      renderBars();
    }
    return;
  }
  if (typing || ev.isComposing || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.key === "?" || ev.key === "/") {
    ev.preventDefault();
    showShortcutDialog();
    return;
  }
  if (handleChordWorkspaceKey(ev)) {
    ev.preventDefault();
    return;
  }

  if (ev.key === "\\") { ev.preventDefault(); toggleLayoutPane("pages"); return; }
  if (ev.key === "n") { ev.preventDefault(); stepSong(+1); }
  else if (ev.key === "p") { ev.preventDefault(); stepSong(-1); }
  else if (ev.key === "]") { ev.preventDefault(); stepEntry(+1); }
  else if (ev.key === "[") { ev.preventDefault(); stepEntry(-1); }
  else if (ev.key === "}") { ev.preventDefault(); nextFlagged(); }
  else if (ev.key === "{") { ev.preventDefault(); prevFlagged(); }
}

init();
