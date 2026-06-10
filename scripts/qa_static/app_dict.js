// ---- Dictionary view ----
// Per-song chord dictionary UI: grouped voicings (pure logic in
// chord_dictionary.js), batch edit, and the multi-select merge flow.
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
