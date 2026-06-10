// Bars view: page scans, chord chips with flags, the chord editor panel, and
// the structural-edit wrappers (the pure mutations live in doc_ops.js).
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
  if (e.voicing_printed && e.voicing_printed !== (e.voicing || ""))
    return e.voicing ? "≠ print" : "no voicing (print has one)";
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
  if (!window.DocOps.canMoveChord(song(), si, bi, dir)) return;
  pushUndo();
  window.DocOps.moveChord(song(), si, bi, ei, dir);
  markDirty();
  state.sel = null;
  $("editor").classList.remove("open");
  renderBars();
}

// ---- Structural editing (Bars view) ----
// The pure mutations live in doc_ops.js (window.DocOps); these wrappers own
// pushUndo() (before the change), confirm dialogs, selection, and re-render.

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

function addBarAfter(si, bi) {
  pushUndo();
  window.DocOps.addBarAfter(song(), si, bi);
  afterStructuralEdit();
}

function deleteBar(si, bi) {
  if (!confirm(`Delete bar ${bi + 1}?`)) return;
  pushUndo();
  window.DocOps.deleteBar(song(), si, bi);
  afterStructuralEdit();
}

function splitBar(si, bi) {
  pushUndo();
  window.DocOps.splitBar(song(), si, bi);
  afterStructuralEdit();
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
    ${e.voicing_printed
      ? `<img class="printcrop" id="edPrintCrop" alt="" title="the printed diagram"
             src="/api/diagram-crop/${encodeURIComponent(state.album)}/${encodeURIComponent(state.file)}?si=${si}&bi=${bi}&ei=${ei}">`
      : ""}
    ${e.voicing_printed && e.voicing_printed !== (e.voicing || "")
      ? `<div class="printhint">print reads <b>${esc(e.voicing_printed)}</b>
           <button id="edUsePrint" title="set the fretboard to what the page prints">use</button>
           <button id="edUsePrintNext" title="accept the printed voicing and jump to the next flagged chord">use + next</button></div>`
      : ""}
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
  const cropImg = $("edPrintCrop");
  if (cropImg) cropImg.addEventListener("error", () => { cropImg.style.display = "none"; });
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
      pushUndo();
      e.voicing = e.voicing_printed;
      markDirty();
      renderBars();
      stepEntry(+1); // full-review flow: advance to the NEXT CHORD, not next flag
    });
  }
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
