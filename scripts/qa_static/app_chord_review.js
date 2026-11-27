// Decisions are editable entry metadata. The local cursor remembers where the
// reviewer left off without making ordinary navigation a document change.
const chordReview = { album: null, file: null, index: 0 };
const CHORD_REVIEW_LABELS = {
  pending: "Unreviewed", reviewed: "Reviewed", deferred: "Deferred", changed: "Needs re-review",
};

function chordReviewStorageKey() {
  return `qaChordReviewPosition:${JSON.stringify([state.album, state.file])}`;
}

function rememberedChordIndex(coords) {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(chordReviewStorageKey())); }
  catch { return -1; }
  if (!saved) return -1;
  return coords.findIndex((coord) => {
    const entry = chordAt(coord);
    if (saved.observation_id) return entry.observation_id === saved.observation_id;
    return !entry.observation_id && entry.chord === saved.chord &&
      compareChordCoords(coord, saved) === 0;
  });
}

function rememberChordReviewPosition(coord, entry) {
  try {
    localStorage.setItem(chordReviewStorageKey(), JSON.stringify(
      entry.observation_id ? { observation_id: entry.observation_id } : { ...coord, chord: entry.chord }
    ));
  } catch { /* Review and Save still work with browser storage disabled. */ }
}

function updateChordReviewEntryPoint() {
  const toggle = $("chordReviewToggle");
  if (!toggle) return;
  const coords = state.doc ? entryCoords() : [];
  if (state.activeView === "chordReview") {
    toggle.textContent = `Review ${coords.length ? chordReview.index + 1 : 0}/${coords.length}`;
    toggle.title = "Exit chord review";
    return;
  }
  let index = rememberedChordIndex(coords);
  if (index < 0 && coords.some((coord) => chordAt(coord).chord_review)) {
    chordReviewCoords();
    index = chordReview.index;
  }
  toggle.textContent = coords.length ? `Review ${index >= 0 ? index + 1 : 1}/${coords.length}` : "Review";
  toggle.title = index >= 0 ? `Resume review · chord ${index + 1} of ${coords.length}` : "Start chord review";
}

function chordReviewCoords() {
  const coords = state.doc ? entryCoords() : [];
  if (state.album !== chordReview.album || state.file !== chordReview.file) {
    chordReview.album = state.album;
    chordReview.file = state.file;
    const remembered = rememberedChordIndex(coords);
    const pending = coords.findIndex((coord) => {
      const status = chordReviewStatus(chordAt(coord));
      return status === "pending" || status === "changed";
    });
    const deferred = coords.findIndex((coord) => chordReviewStatus(chordAt(coord)) === "deferred");
    chordReview.index = [remembered, pending, deferred, coords.length - 1, 0].find((index) => index >= 0);
  }
  chordReview.index = Math.min(chordReview.index, Math.max(0, coords.length - 1));
  return coords;
}

function chordAt({ si, bi, ei }) {
  return song().sections[si].bars[bi][ei];
}

function chordReviewSnapshot(entry) {
  return {
    chord: entry.chord, voicing: entry.voicing ?? null,
    voicing_printed: entry.voicing_printed ?? null, observation_id: entry.observation_id ?? null,
  };
}

function chordReviewStatus(entry) {
  const review = entry.chord_review;
  if (!review || !["reviewed", "deferred"].includes(review.status)) return "pending";
  const snapshot = chordReviewSnapshot(entry);
  return Object.keys(snapshot).every((key) => review.snapshot?.[key] === snapshot[key])
    ? review.status : "changed";
}

function setChordReviewStatus(entry, status) {
  entry.chord_review = { status, snapshot: chordReviewSnapshot(entry) };
}

function chordReviewFlag(coords, entry = chordAt(coords)) {
  const status = chordReviewStatus(entry);
  if (status === "reviewed") return "";
  if (status === "deferred" || status === "changed") return CHORD_REVIEW_LABELS[status];
  return flagReason(entry);
}

function renderChordReview(focus = false) {
  const coords = chordReviewCoords();
  updateChordReviewEntryPoint();
  const selection = coords[chordReview.index];
  $("chordReviewContent").hidden = !selection;
  const counts = { reviewed: 0, deferred: 0, flagged: 0 };
  for (const coord of coords) {
    const entry = chordAt(coord);
    const status = chordReviewStatus(entry);
    if (status === "reviewed" || status === "deferred") counts[status] += 1;
    if (chordReviewFlag(coord, entry)) counts.flagged += 1;
  }
  $("chordReviewPosition").textContent = selection
    ? `Chord ${chordReview.index + 1} of ${coords.length} · ${counts.reviewed} reviewed · ${counts.deferred} deferred · ${counts.flagged} flagged`
    : "No chords to review";
  if (state.activeView === "chordReview") $("flagCount").textContent = String(counts.flagged);
  const progress = $("chordReviewProgress");
  progress.max = Math.max(1, coords.length);
  progress.value = counts.reviewed;
  $("chordReviewNextFlagged").disabled = !coords.slice(chordReview.index + 1).some((coord) => chordReviewFlag(coord));
  $("chordReviewDone").hidden = !selection || chordReview.index !== coords.length - 1;
  syncChordChip(selection, focus);
  if (!selection) {
    $("chordReviewName").textContent = "";
    $("chordReviewContext").textContent = "";
    $("chordReviewMessage").textContent = "";
    return;
  }

  const entry = chordAt(selection);
  const reason = chordReviewFlag(selection, entry);
  const label = CHORD_REVIEW_LABELS[chordReviewStatus(entry)];
  rememberChordReviewPosition(selection, entry);
  $("chordReviewName").textContent = entry.chord;
  $("chordReviewContext").textContent =
    `Section ${selection.si + 1} · Bar ${selection.bi + 1} · ${label}${reason && reason !== label ? ` · ${reason}` : ""}`;
  $("chordReviewCurrent").textContent = entry.voicing || "No fingering";
  $("chordReviewDiagram").innerHTML = window.ChordDiagram.svg(entry.voicing);
  const voicing = entry.voicing ? parseVoicing(entry.voicing) : [];
  renderChordSuggestions($("chordReviewSuggestions"), voicing, (name) => {
    if (!window.ChordNaming.validateName(name).valid) return;
    if ($("editor").classList.contains("editor-inline")) {
      $("edName").value = name;
      $("edName").dispatchEvent(new Event("input"));
      return;
    }
    if (entry.chord === name && chordReviewStatus(entry) === "reviewed") return;
    pushUndo();
    entry.chord = name;
    setChordReviewStatus(entry, "reviewed");
    markDirty();
    renderBars();
    syncChordChip(selection, true);
    $("chordReviewMessage").textContent = "Chord name applied and chord reviewed.";
  });
  $("chordReviewProposed").textContent = entry.voicing_printed || "";
  $("chordReviewAccept").disabled = !entry.voicing_printed || (entry.voicing || "") === entry.voicing_printed;
  $("chordReviewPrev").disabled = chordReview.index === 0;
  $("chordReviewNext").disabled = chordReview.index === coords.length - 1;
  syncChordReviewCrop(selection, entry);
}

function syncChordReviewCrop(selection = activeChordSelection(), entry) {
  if (state.activeView !== "chordReview" || !selection) return;
  entry ??= chordAt(selection);
  const proposal = typeof scanProposal === "function" ? scanProposal(entry) : "";
  $("chordReviewProposed").textContent = entry.voicing_printed || (proposal ? `Proposed: ${proposal}` : "");
  const image = $("chordReviewCrop");
  const url = hasDiagramCrop(entry) ? diagramCropUrl(selection, entry) : "";
  if (!url || url !== image.getAttribute("src")) {
    image.hidden = true;
    if (url) image.setAttribute("src", url);
    else image.removeAttribute("src");
    $("chordReviewSourceStatus").textContent = url ? "Loading scan crop…" : "No scan crop available";
  }
}

function selectChordReviewEntry(selection, redrawBars = false) {
  const coords = chordReviewCoords();
  const index = coords.findIndex((c) =>
    c.si === selection.si && c.bi === selection.bi && c.ei === selection.ei);
  if (index < 0) return;
  if (index !== chordReview.index && $("editor").classList.contains("editor-inline")) {
    if (!confirmChordDraftDiscard()) return;
    closeChordEditor();
  }
  chordReview.index = index;
  $("chordReviewMessage").textContent = "";
  if (redrawBars) {
    renderBars();
    syncChordChip(selection, true);
  } else {
    renderChordReview(true);
  }
}

function moveChordReview(direction, flagged = false) {
  const coords = chordReviewCoords();
  if (!coords.length) return;
  let index = chordReview.index + direction;
  if (flagged) {
    while (index >= 0 && index < coords.length && !chordReviewFlag(coords[index])) {
      index += direction;
    }
  }
  if (index < 0 || index >= coords.length) {
    $("chordReviewMessage").textContent = flagged ? "No more flagged chords in this direction." : "End of chord list.";
    return;
  }
  selectChordReviewEntry(coords[index]);
}

function decideChordReview(action, advance = true) {
  const coords = chordReviewCoords();
  const selection = coords[chordReview.index];
  if (!selection) return;
  const entry = chordAt(selection);
  if (action === "accept" && (!entry.voicing_printed || (entry.voicing || "") === entry.voicing_printed)) {
    $("chordReviewMessage").textContent = !entry.voicing_printed
      ? "No printed voicing is available for this chord."
      : "Printed voicing is already applied. Press Space to review and advance.";
    return;
  }
  if ($("editor").classList.contains("editor-inline")) {
    if (action === "keep" && chordEditorHasDraft()) return submitActiveChord({ advance });
    if (!confirmChordDraftDiscard()) return;
    closeChordEditor();
  }
  const status = action === "skip" ? "deferred" : "reviewed";
  const changed = action === "accept" || chordReviewStatus(entry) !== status;
  if (changed) {
    pushUndo();
    if (action === "accept") entry.voicing = entry.voicing_printed;
    setChordReviewStatus(entry, status);
    markDirty();
  }
  const last = chordReview.index === coords.length - 1;
  if (advance && !last) chordReview.index += 1;
  if (changed) {
    renderBars();
    syncChordChip(coords[chordReview.index], true);
  } else {
    renderChordReview(true);
  }
  const labels = { accept: "Printed fingering applied and chord reviewed.", keep: "Chord marked reviewed.", skip: "Chord deferred." };
  $("chordReviewMessage").textContent = labels[action] + (advance && last ? " End of song." : "");
}

function toggleChordReview() {
  if (state.activeView === "chordReview") { showView("bars"); return; }
  if (!state.doc) return;
  if (!confirmChordDraftDiscard()) return;
  const previous = state.sel;
  closeChordEditor();
  $("chordReviewMessage").textContent = "";
  if (showView("chordReview") === false) return;
  if (previous && chordAt(previous).chord !== "%") selectChordReviewEntry(previous);
  else renderChordReview(true);
}

function editChordInReview() {
  const selection = chordReviewCoords()[chordReview.index];
  if (!selection) return;
  const editor = $("editor");
  if (!editor.classList.contains("editor-inline") || !editor.classList.contains("open")) {
    openEditor(selection.si, selection.bi, selection.ei);
  }
  else $("edName").focus();
  editor.scrollIntoView?.({ block: "nearest" });
}

async function finishChordReview() {
  const button = $("chordReviewDone");
  const doc = state.doc;
  button.disabled = true;
  try {
    if ($("editor").classList.contains("editor-inline") && chordEditorHasDraft() && !submitActiveChord()) return;
    if (doc.document?.status !== "done") {
      pushUndo();
      doc.document ??= {};
      doc.document.status = "done";
      $("statusSel").value = "done";
      markDirty();
    }
    const result = await save();
    if (result?.ok && doc === state.doc && !state.dirty && !chordEditorHasDraft()) stepSong(1);
  } finally {
    button.disabled = false;
  }
}

function wireChordReview() {
  const onPointerClick = (id, fn) => {
    const btn = $(id);
    btn?.addEventListener("click", (ev) => {
      if (!ev || ev.detail > 0) btn.blur?.();
      fn(ev);
    });
  };
  $("chordReviewToggle").addEventListener("click", toggleChordReview);
  onPointerClick("chordReviewPrev", () => moveChordReview(-1));
  onPointerClick("chordReviewNext", () => moveChordReview(1));
  onPointerClick("chordReviewNextFlagged", () => moveChordReview(1, true));
  onPointerClick("chordReviewDone", finishChordReview);
  onPointerClick("chordReviewAccept", () => decideChordReview("accept"));
  onPointerClick("chordReviewKeep", () => decideChordReview("keep"));
  onPointerClick("chordReviewSkip", () => decideChordReview("skip"));
  onPointerClick("chordReviewEdit", editChordInReview);
  const image = $("chordReviewCrop");
  image.addEventListener("load", () => {
    if (!image.getAttribute("src")) return;
    image.hidden = false;
    $("chordReviewSourceStatus").textContent = "";
  });
  image.addEventListener("error", () => {
    if (!image.getAttribute("src")) return;
    image.hidden = true;
    $("chordReviewSourceStatus").textContent = "Could not load the scan crop";
  });
}

function handleChordReviewKey(ev) {
  const key = String(ev.key || "").toLowerCase();
  if (key === "e") {
    if (!ev.repeat) editChordInReview();
  } else if (key === "[" || key === "]" || key === "{" || key === "}") {
    moveChordReview(key === "]" || key === "}" ? 1 : -1, key === "{" || key === "}");
  } else {
    const action = key === "a" ? "accept" : key === "s" ? "skip" : "";
    if (!action) return false;
    if (!ev.repeat) decideChordReview(action);
  }
  return true;
}
