// Bars view: chord chips with flags, the chord editor panel, and
// the structural-edit wrappers (the pure mutations live in doc_ops.js).
// Classify an entry as flagged. Returns a reason string, or "" if clean.
//  - "invalid name": chord name doesn't parse (excluding the % bar-repeat).
//  - "name ≠ voicing": name and voicing disagree.
function flagReason(e) {
  if (e.chord === "%") return "";
  if (window.ChordNaming.validateName(e.chord).valid === false) return "invalid name";
  if (e.voicing &&
      window.ChordNaming.nameMatchesVoicing(e.chord, parseVoicing(e.voicing)) === false)
    return "name ≠ voicing";
  if (e.voicing_printed && e.voicing_printed !== (e.voicing || ""))
    return e.voicing ? "≠ print" : "no voicing (print has one)";
  return "";
}

function syncChordChip(coords, focus = false) {
  syncScanSelection(coords, focus);
  const bars = $("bars");
  const previous = bars.querySelector(".chip.sel");
  const next = coords && bars.querySelector(`[data-chord-coords="${coords.si}:${coords.bi}:${coords.ei}"]`);
  if (previous && previous !== next) {
    previous.classList.remove("sel");
    previous.removeAttribute("aria-current");
  }
  if (!next) return;
  next.classList.add("sel");
  next.setAttribute("aria-current", "true");
  if (focus) next.focus({ preventScroll: true });
  if (focus || previous !== next) next.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function renderBars() {
  const root = $("bars");
  const restoreFocus = root.contains(document.activeElement);
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
       </span>
       <span class="chord-review-section-label">${esc(sec.label || `Section ${si + 1}`)}</span>`;
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
             <button class="barAddBefore" title="insert an empty bar before this bar">+ before</button>
             <button class="barAddAfter" title="insert an empty bar after this bar">+ after</button>
             <button class="barSplit" ${bar.length >= 2 ? "" : "disabled"}>Split in half</button>
             <button class="barMerge" title="merge with next bar" ${bi < sec.bars.length - 1 ? "" : "disabled"}>merge ↓</button>
             <button class="barDel" title="delete bar">✕</button>
           </span>
         </div>`;
      bd.querySelector(".barAddBefore").addEventListener("click", () => addBarBefore(si, bi));
      bd.querySelector(".barAddAfter").addEventListener("click", () => addBarAfter(si, bi));
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
        chip.dataset.chordCoords = `${si}:${bi}:${ei}`;
        chip.tabIndex = -1;
        chip.className = "chip" + (e.chord === "%" ? " pct" : "") +
          (state.sel && state.sel.si === si && state.sel.bi === bi && state.sel.ei === ei ? " sel" : "");
        const notes = (e.chord !== "%" && e.voicing) ? notesFor(e.voicing) : "";
        const ivals = (e.chord !== "%") ? intervalsFor(e.voicing) : "";
        const civals = (e.chord !== "%") ? chordIvalsFor(e.voicing, e.chord) : "";
        const canLeft = bi > 0;
        const canRight = bi < sec.bars.length - 1;
        const dia = (e.chord !== "%" && e.voicing) ? window.ChordDiagram.svg(e.voicing) : "";
        const review = e.chord === "%" ? "pending" : chordReviewStatus(e);
        chip.innerHTML =
          `<div class="nm">${esc(e.chord)}${mismatch ? '<span class="warn"></span>' : ""}</div>
           ${review === "pending" ? "" : `<span class="chord-review-state" data-review-status="${review}">${CHORD_REVIEW_LABELS[review]}</span>`}
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
        chip.addEventListener("click", () => {
          if (state.activeView === "chordReview") selectChordReviewEntry({ si, bi, ei });
          else jumpToEntry({ si, bi, ei });
        });
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
  renderScanReviewMarks();
  if (state.activeView === "review") renderReview();
  if (state.activeView === "chordReview") renderChordReview(restoreFocus);
  else syncChordChip(state.sel, restoreFocus);
}

// Move a chord entry to the adjacent bar (dir -1 = previous, +1 = next).
// Moving left appends to the end of the previous bar; right prepends to the next.
function moveChord(si, bi, ei, dir) {
  moveChordSelection({ si, bi, ei }, dir, false);
}

function moveChordSelection({ si, bi, ei }, dir, withinBar) {
  const currentSong = song();
  const { DocOps } = window;
  const canMove = withinBar ? DocOps.canReorderChord(currentSong, si, bi, ei, dir)
    : DocOps.canMoveChord(currentSong, si, bi, dir);
  if (!canMove || !confirmChordDraftDiscard()) return;
  const next = withinBar ? { si, bi, ei: ei + dir }
    : { si, bi: bi + dir, ei: dir < 0 ? currentSong.sections[si].bars[bi + dir].length : 0 };
  pushUndo();
  if (withinBar) DocOps.reorderChord(currentSong, si, bi, ei, dir);
  else DocOps.moveChord(currentSong, si, bi, ei, dir);
  markDirty();
  if (state.activeView === "chordReview") {
    selectChordReviewEntry(next, true);
  } else {
    state.sel = next;
    renderBars();
    jumpToEntry(next, { discardDraft: true, reopen: true });
  }
}

// ---- Structural editing (Bars view) ----
// The pure mutations live in doc_ops.js (window.DocOps); these wrappers own
// pushUndo() (before the change), confirm dialogs, selection, and re-render.

// Re-render the bars and dependent views after a structural change.
function afterStructuralEdit(selection = null) {
  state.sel = selection;
  if (!selection) $("editor").classList.remove("open");
  markDirty();
  renderBars();
  renderSongList();
  if (state.activeView === "review") renderReview();
  if (selection) jumpToEntry(selection, { reopen: true });
}

function selectedEntryForStructuralEdit() {
  const { si, bi, ei } = state.sel || {};
  return song().sections?.[si]?.bars?.[bi]?.[ei] || null;
}

function coordsForEntryIdentity(entry) {
  if (!entry) return null;
  for (let si = 0; si < song().sections.length; si++) {
    const bars = song().sections[si].bars || [];
    for (let bi = 0; bi < bars.length; bi++) {
      const ei = bars[bi].indexOf(entry);
      if (ei >= 0) return { si, bi, ei };
    }
  }
  return null;
}

function addBarAfter(si, bi) {
  if (!window.DocOps.canAddBarAfter(song(), si, bi)) return;
  if (!confirmChordDraftDiscard()) return;
  const selectedEntry = selectedEntryForStructuralEdit();
  pushUndo();
  window.DocOps.addBarAfter(song(), si, bi);
  afterStructuralEdit(coordsForEntryIdentity(selectedEntry));
}

function addBarBefore(si, bi) {
  if (!window.DocOps.canAddBarBefore(song(), si, bi)) return;
  if (!confirmChordDraftDiscard()) return;
  const selectedEntry = selectedEntryForStructuralEdit();
  pushUndo();
  window.DocOps.addBarBefore(song(), si, bi);
  afterStructuralEdit(coordsForEntryIdentity(selectedEntry));
}

function deleteBar(si, bi) {
  if (!confirm(`Delete bar ${bi + 1}?`)) return;
  pushUndo();
  window.DocOps.deleteBar(song(), si, bi);
  afterStructuralEdit();
}

function splitBar(si, bi, beforeEntry) {
  if (!window.DocOps.canSplitBar(song(), si, bi, beforeEntry)) return;
  if (beforeEntry === undefined && !confirmChordDraftDiscard()) return;
  const selectedEntry = selectedEntryForStructuralEdit();
  pushUndo();
  window.DocOps.splitBar(song(), si, bi, beforeEntry);
  afterStructuralEdit(coordsForEntryIdentity(selectedEntry));
}

function mergeBarWithNext(si, bi) {
  if (!window.DocOps.canMergeBarWithNext(song(), si, bi)) return;
  pushUndo();
  window.DocOps.mergeBarWithNext(song(), si, bi);
  afterStructuralEdit();
}

function addSectionAfter(si) {
  pushUndo();
  window.DocOps.addSectionAfter(song(), si);
  afterStructuralEdit();
}

function deleteSection(si) {
  const sec = song().sections[si];
  const name = (sec && sec.label) || `Section ${si + 1}`;
  if (!confirm(`Delete "${name}" and all its bars?`)) return;
  pushUndo();
  window.DocOps.deleteSection(song(), si);
  afterStructuralEdit();
}

let chordEditorHasDraft = () => false;
// Bars keyboard shortcuts call this rather than navigating away from a draft.
// openEditor replaces it for the currently visible editor instance.
let submitActiveChord = () => false;
// The scan request may finish after the editor opens. app_scan.js invokes this
// hook when its guarded lookup receives the current song's locations.
let syncActiveChordProposal = () => false;

function confirmChordDraftDiscard() {
  return !chordEditorHasDraft() || confirm("Discard the unapplied chord edits?");
}

function diagramCropUrl({ si, bi, ei }, entry) {
  const path = `/api/diagram-crop/${encodeURIComponent(state.album)}/${encodeURIComponent(state.file)}`;
  const observation = entry.observation_id ? `&observation_id=${encodeURIComponent(entry.observation_id)}` : "";
  return `${path}?si=${si}&bi=${bi}&ei=${ei}${observation}`;
}

function renderChordSuggestions(container, voicing, apply) {
  const suggestions = window.ChordNaming.suggestNames(voicing);
  container.innerHTML = suggestions.length ? suggestions.map(({ name }, index) =>
    `<button type="button" class="s" data-suggestion="${index}"><b>${esc(name)}</b>${index < 4 ? `<kbd>${index + 1}</kbd>` : ""}</button>`
  ).join("") : '<div class="s muted">No chord-name suggestions</div>';
  container.querySelectorAll("[data-suggestion]").forEach((button, index) => {
    button.addEventListener("click", () => apply(suggestions[index].name));
  });
}

function openEditor(si, bi, ei, focus = false) {
  state.sel = { si, bi, ei };
  const e = song().sections[si].bars[bi][ei];
  const ed = $("editor");
  ed.classList.add("open");
  const barLength = song().sections[si].bars[bi].length;
  ed.innerHTML = `
    <h2>Edit chord · bar ${bi + 1}</h2>
    <div class="ed-split-actions">
      <button type="button" class="tab" id="edSplitBefore"
              title="Start a new bar with this chord" ${ei > 0 ? "" : "disabled"}>Split before</button>
      <button type="button" class="tab" id="edSplitAfter"
              title="End this bar with this chord" ${ei < barLength - 1 ? "" : "disabled"}>Split after</button>
    </div>
    <div id="edSplitStatus" class="muted" role="status"></div>
    <label>Chord name</label>
    <input type="text" id="edName" value="${esc(e.chord)}">
    <div id="edBadge"></div>
    <div id="edErr" class="err"></div>
    <div id="edIvals" class="fb-notes"></div>
    <label>Anchored lyric</label>
    <input type="text" id="edText" value="${esc(e.text || "")}">
    <label>Voicing</label>
    <div id="edFb"></div>
    ${e.voicing_printed
      ? `<img class="printcrop" id="edPrintCrop" alt="" title="the printed diagram"
             src="${esc(diagramCropUrl({ si, bi, ei }, e))}">`
      : ""}
    <div id="edScanProposal" class="scan-fingering-proposal" hidden>
      <span>Proposed fingering <b id="edScanProposalValue"></b></span>
      <button type="button" id="edUseScanProposal">Use proposed fingering</button>
      <small>Inspect, then Apply manually.</small>
    </div>
    ${e.chord === "%" ? "" : '<button type="button" id="edFindShapes" class="tab">Find matching shapes</button>'}
    ${e.voicing_printed && e.voicing_printed !== (e.voicing || "")
      ? `<div class="printhint">print reads <b>${esc(e.voicing_printed)}</b>
           <button id="edUsePrint" title="set the fretboard to what the page prints">use</button>
           <button id="edUsePrintNext" title="accept the printed voicing and jump to the next chord">use + next</button></div>`
      : ""}
    <label>Suggestions</label>
    <div class="suggest" id="edSuggest"></div>
    ${e.chord === "%" ? "" : `<div class="ed-review">
      <span id="edReviewStatus" class="chord-review-state" role="status"></span>
      <button type="button" id="edMarkReviewed" class="tab" aria-keyshortcuts="R" title="Mark the current chord reviewed (R)">Mark reviewed</button>
      <button type="button" id="edDeferReview" class="tab">Defer</button>
    </div>`}
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
  chordEditorHasDraft = () => {
    if (!ed.classList.contains("open")) return false;
    const strings = fb.get();
    const voicing = strings.every((f) => f === "x") ? "" : strings.join(",");
    return $("edName").value.trim() !== e.chord ||
      $("edText").value.trim() !== (e.text || "") || voicing !== (e.voicing || "");
  };
  const splitAt = (boundary) => {
    if (chordEditorHasDraft()) {
      $("edSplitStatus").textContent = "Apply your chord edits before splitting.";
      return;
    }
    splitBar(si, bi, boundary);
  };
  if (ei > 0) $("edSplitBefore").addEventListener("click", () => splitAt(ei));
  if (ei < barLength - 1) $("edSplitAfter").addEventListener("click", () => splitAt(ei + 1));
  const cropImg = $("edPrintCrop");
  if (cropImg) cropImg.addEventListener("error", () => { cropImg.style.display = "none"; });
  $("edFindShapes")?.addEventListener("click", () => openShapesForEntry(si, bi, ei));
  const usePrint = $("edUsePrint");
  if (usePrint) {
    usePrint.addEventListener("click", () => {
      curVoicing = parseVoicing(e.voicing_printed);
      fb.set(curVoicing);
      refreshNaming();
    });
  }
  const usePrintNext = $("edUsePrintNext");
  if (usePrintNext) {
    usePrintNext.addEventListener("click", () => {
      submitActiveChord({ usePrinted: true, advance: true });
    });
  }
  const editorStillCurrent = () => {
    const selected = state.sel;
    return ed.classList.contains("open") && state.activeView === "bars" &&
      selected?.si === si && selected.bi === bi && selected.ei === ei &&
      song().sections[si]?.bars[bi]?.[ei] === e;
  };
  syncActiveChordProposal = () => {
    if (!editorStillCurrent()) return false;
    const proposal = typeof scanProposal === "function" ? scanProposal(e) : "";
    const panel = $("edScanProposal");
    panel.hidden = !proposal;
    $("edScanProposalValue").textContent = proposal;
    return Boolean(proposal);
  };
  $("edUseScanProposal").addEventListener("click", () => {
    if (!editorStillCurrent()) return;
    const proposal = typeof scanProposal === "function" ? scanProposal(e) : "";
    if (!proposal) return;
    curVoicing = parseVoicing(proposal);
    fb.set(curVoicing);
    refreshNaming();
  });
  $("edName").addEventListener("input", () => { $("edErr").textContent = ""; refreshNaming(); });
  // Enter in the name field applies; Esc cancels (handled here so it works
  // even though the global Esc handler also closes the editor).
  $("edName").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); $("edApply").click(); }
    else if (ev.key === "Escape") { ev.preventDefault(); $("edCancel").click(); }
  });
  $("edText").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); $("edApply").click(); }
  });

  function updateEditorReviewStatus() {
    const label = $("edReviewStatus");
    if (!label) return;
    const status = chordReviewStatus(e);
    label.dataset.reviewStatus = status;
    label.textContent = CHORD_REVIEW_LABELS[status];
  }
  for (const [id, status] of [["edMarkReviewed", "reviewed"], ["edDeferReview", "deferred"]]) {
    $(id)?.addEventListener("click", () => {
      if (e.chord === "%") return;
      if (chordEditorHasDraft()) {
        $("edReviewStatus").textContent = "Apply chord edits before recording review.";
        return;
      }
      if (chordReviewStatus(e) === status) return;
      pushUndo();
      setChordReviewStatus(e, status);
      markDirty();
      renderBars();
      updateEditorReviewStatus();
      syncChordChip(state.sel, true);
    });
  }

  function refreshNaming() {
    const name = $("edName").value.trim();
    const badge = $("edBadge");
    const match = window.ChordNaming.nameMatchesVoicing(name, curVoicing);
    if (match === true) { badge.className = "badge ok"; badge.textContent = "● matches voicing"; }
    else if (match === false) { badge.className = "badge bad"; badge.textContent = "● name ≠ voicing"; }
    else { badge.className = ""; badge.textContent = ""; }
    renderChordSuggestions($("edSuggest"), curVoicing, (suggestion) => {
      $("edName").value = suggestion;
      $("edApply").click();
    });
    const ci = window.ChordNaming.perStringChordIntervals(curVoicing, name);
    $("edIvals").textContent = ci.length ? "chord intervals: " + ci.join(" ") : "";
    updateEditorReviewStatus();
  }
  refreshNaming();
  syncActiveChordProposal();

  submitActiveChord = ({ usePrinted = false, advance = false } = {}) => {
    const selected = state.sel;
    if (!ed.classList.contains("open") || state.activeView !== "bars" ||
        !selected || selected.si !== si || selected.bi !== bi || selected.ei !== ei) return false;
    const name = $("edName").value.trim();
    const v = window.ChordNaming.validateName(name);
    if (!v.valid && name !== "%") {
      $("edErr").textContent = "Not a valid ChordMark chord: " + name;
      return false;
    }
    if (usePrinted && !e.voicing_printed) {
      $("edErr").textContent = "No printed voicing is available for this chord.";
      return false;
    }
    pushUndo();
    e.chord = name;
    const text = $("edText").value.trim();
    if (text) e.text = text; else delete e.text;
    if (usePrinted) e.voicing = e.voicing_printed;
    else {
      const vc = fb.get();
      if (vc.every((f) => f === "x")) delete e.voicing;
      else e.voicing = vc.join(",");
    }
    if (name === "%") delete e.chord_review;
    else setChordReviewStatus(e, "reviewed");
    markDirty();
    renderBars();
    $("edErr").textContent = "";
    $("edSplitStatus").textContent = "";
    refreshNaming();
    syncChordChip(state.sel, true);
    if (advance) {
      const next = entryCoords().find((coords) => compareChordCoords(coords, selected) > 0);
      if (next) jumpToEntry(next, { discardDraft: true });
    }
    return true;
  };
  $("edApply").addEventListener("click", () => submitActiveChord());
  $("edCancel").addEventListener("click", () => {
    ed.classList.remove("open"); state.sel = null; renderBars();
  });
  syncChordChip(state.sel, focus);
}
