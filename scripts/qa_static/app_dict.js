// ---- Dictionary view ----
// Per-song chord dictionary UI: grouped voicings (pure logic in
// chord_dictionary.js), batch edit, and the multi-select merge flow.
let dictMergeDraft = null;
let dictNotice = "";

function pruneDictSelection(entries) {
  const validKeys = new Set(entries.map((e) => e.key));
  for (const key of state.dictSel) {
    if (!validKeys.has(key)) state.dictSel.delete(key);
  }
  if (state.dictEdit && !validKeys.has(state.dictEdit)) state.dictEdit = null;
}

function renderDict() {
  const root = $("dict");
  const entries = window.ChordDictionary.buildDictionary(song()); // count desc by default
  pruneDictSelection(entries);
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

  const filters = document.createElement("div");
  filters.className = "dict-filters";
  for (const [value, label] of [["all", "All"], ["mismatch", "Mismatches"], ["print", "Print diffs"], ["duplicates", "Duplicate names"]]) {
    const button = document.createElement("button");
    button.className = "tab" + ((state.dictFilter || "all") === value ? " active" : "");
    button.textContent = label;
    button.setAttribute("aria-pressed", String((state.dictFilter || "all") === value));
    button.addEventListener("click", () => { state.dictFilter = value; renderDict(); });
    filters.appendChild(button);
  }
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Search chords or voicings";
  search.setAttribute("aria-label", search.placeholder);
  search.value = state.dictSearch || "";
  search.addEventListener("input", () => {
    state.dictSearch = search.value;
    const caret = search.selectionStart;
    renderDict();
    const next = $("dict").querySelector(".dict-search");
    next?.focus();
    if (caret != null) next?.setSelectionRange(caret, caret);
  });
  search.className = "dict-search";
  filters.appendChild(search);
  root.appendChild(filters);
  if (dictNotice) {
    const notice = document.createElement("p");
    notice.setAttribute("role", "status");
    notice.textContent = dictNotice;
    root.appendChild(notice);
    dictNotice = "";
  }

  // merge bar (shown when 2+ selected). If dictMergeOpen, render the inline merge form.
  if (state.dictSel.size < 2) state.dictMergeOpen = false;
  if (!state.dictMergeOpen) dictMergeDraft = null;
  const mergeBar = document.createElement("div");
  mergeBar.className = "dmergebar" + (state.dictSel.size >= 2 ? " show" : "");
  const affected = entries.filter((entry) => state.dictSel.has(entry.key)).reduce((sum, entry) => sum + entry.count, 0);
  mergeBar.innerHTML = `<b>${state.dictSel.size} groups · ${affected} occurrences selected</b> — merge into one chord:
    <button id="dMergeBtn">Merge…</button>
    <button id="dClearSel">Clear</button>
    <div class="dmergeform" id="dMergeForm" style="display:none">
      <input type="text" id="dMergeName" placeholder="chord name">
      <input type="text" id="dMergeVoicing" placeholder="voicing (comma form, blank = none)">
      <button class="apply" id="dMergeApply">Apply merge</button>
      <button id="dMergeCancel">Cancel</button>
      <span class="err" id="dMergeErr" role="alert"></span>
    </div>`;
  root.appendChild(mergeBar);
  if (state.dictSel.size >= 2) {
    const largest = entries
      .filter((e) => state.dictSel.has(e.key))
      .sort((a, b) => b.count - a.count)[0];
    const form = $("dMergeForm");
    const syncMergeDraft = () => {
      dictMergeDraft = {
        name: $("dMergeName").value,
        voicing: $("dMergeVoicing").value,
        edited: true,
      };
      $("dMergeErr").textContent = "";
    };
    $("dMergeName").addEventListener("input", syncMergeDraft);
    $("dMergeVoicing").addEventListener("input", syncMergeDraft);
    $("dMergeBtn").addEventListener("click", () => {
      state.dictMergeOpen = true;
      form.style.display = "flex";
      dictMergeDraft = {
        name: largest ? largest.chord : "",
        voicing: largest ? (largest.voicing || "") : "",
        edited: false,
      };
      $("dMergeName").value = dictMergeDraft.name;
      $("dMergeVoicing").value = dictMergeDraft.voicing;
      $("dMergeErr").textContent = "";
    });
    $("dClearSel").addEventListener("click", () => {
      state.dictSel.clear();
      state.dictMergeOpen = false;
      dictMergeDraft = null;
      renderDict();
    });
    $("dMergeCancel").addEventListener("click", () => {
      state.dictMergeOpen = false;
      dictMergeDraft = null;
      form.style.display = "none";
      $("dMergeErr").textContent = "";
    });
    $("dMergeApply").addEventListener("click", () => applyMerge());
    if (state.dictMergeOpen) {
      form.style.display = "flex";
      if (!dictMergeDraft || !dictMergeDraft.edited) {
        dictMergeDraft = {
          name: largest ? largest.chord : "",
          voicing: largest ? (largest.voicing || "") : "",
          edited: false,
        };
      }
      $("dMergeName").value = dictMergeDraft.name;
      $("dMergeVoicing").value = dictMergeDraft.voicing;
    }
  }

  const names = new Map();
  entries.forEach((entry) => names.set(entry.chord, (names.get(entry.chord) || 0) + 1));
  const shown = entries.filter((entry) => {
    if (state.dictFilter === "mismatch" && entry.nameMatchesVoicing !== false) return false;
    if (state.dictFilter === "print" && !entry.printDiffCount) return false;
    if (state.dictFilter === "duplicates" && names.get(entry.chord) < 2) return false;
    return `${entry.chord} ${entry.voicing || ""}`.toLowerCase().includes((state.dictSearch || "").toLowerCase());
  });
  shown.forEach((e) => {
    const row = document.createElement("div");
    row.className = "drow" + (state.dictSel.has(e.key) ? " sel" : "");
    const mism = e.nameMatchesVoicing === false ? '<span class="warn"></span>' : "";
    const ivals = intervalsFor(e.voicing);
    const civals = chordIvalsFor(e.voicing, e.chord);
    row.innerHTML = `<div class="dhead" tabindex="0" role="button" aria-expanded="${state.dictEdit === e.key}" aria-label="Edit ${esc(e.chord)} group">
      <input type="checkbox" ${state.dictSel.has(e.key) ? "checked" : ""} data-sel="${esc(e.key)}">
      <span class="dnm">${esc(e.chord)}</span>${mism}
      <span class="dvc">${esc(e.voicing || "—")}</span>
      ${e.voicing ? window.ChordDiagram.svg(e.voicing) : ""}
      <span class="dnt">${esc(notesFor(e.voicing))}</span>
      ${civals ? `<span class="dci">${esc(civals)}</span>` : ""}
      ${ivals ? `<span class="div">${esc(ivals)}</span>` : ""}
      <span class="dct">${e.count}×</span>
      ${e.printedVariants > 1 ? `<span class="dprint-conflict">⚠ ${e.printedVariants} conflicting prints</span>` : ""}
      ${e.printed && e.printed !== (e.voicing || "")
        ? `<button class="dprint" title="Apply to ${e.printedCount} printed occurrences; leave ${e.unprintedCount} without printed evidence unchanged">print ${esc(e.printed)} → ${e.printedCount}× · ${e.unprintedCount} unprinted unchanged</button>`
        : ""}
    </div>`;
    const pb = row.querySelector(".dprint");
    if (pb) {
      pb.addEventListener("click", (ev) => {
        ev.stopPropagation();
        pushUndo();
        const changed = window.ChordDictionary.applyPrinted(song(), e.key);
        dictNotice = `Applied printed voicing to ${changed} occurrences; ${e.unprintedCount} unprinted unchanged. Undo with ⌘Z / Ctrl+Z.`;
        state.dictSel.delete(e.key);
        if (state.dictEdit === e.key) state.dictEdit = null;
        markDirty();
        if (typeof renderBars === "function") renderBars();
        renderDict();
      });
    }
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
    row.querySelector(".dhead").addEventListener("keydown", (event) => {
      if (event.target !== event.currentTarget || !["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      state.dictEdit = state.dictEdit === e.key ? null : e.key;
      renderDict();
    });
    const occurrences = document.createElement("details");
    occurrences.className = "dict-occurrences";
    const summary = document.createElement("summary");
    summary.textContent = `${e.count} occurrences`;
    occurrences.appendChild(summary);
    for (const coords of e.occurrences) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.textContent = `Sec ${coords.si + 1} · b.${coords.bi + 1} · #${coords.ei + 1}`;
      chip.addEventListener("click", () => jumpToEntry(coords));
      occurrences.appendChild(chip);
    }
    row.appendChild(occurrences);
    if (state.dictEdit === e.key) row.appendChild(buildDictEditor(e));
    root.appendChild(row);
  });
  if (!shown.length) {
    const empty = document.createElement("p");
    empty.textContent = "No chord groups match these filters.";
    root.appendChild(empty);
  }
}

// Apply the inline merge form: validate name and voicing, merge selected groups, re-render.
function applyMerge() {
  const name = $("dMergeName").value.trim();
  const voicing = $("dMergeVoicing").value.trim();
  const v = window.ChordNaming.validateName(name);
  if (!v.valid && name !== "%") { $("dMergeErr").textContent = "Not a valid ChordMark chord: " + name; return; }
  const vc = window.ChordDictionary.validateVoicing(voicing);
  if (!vc.valid) { $("dMergeErr").textContent = vc.error; return; }
  pushUndo();
  window.ChordDictionary.mergeEntries(song(), [...state.dictSel], { chord: name, voicing: vc.normalized });
  state.dictSel.clear();
  state.dictEdit = null;
  state.dictMergeOpen = false;
  dictMergeDraft = null;
  markDirty();
  if (typeof renderBars === "function") renderBars();
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
    state.dictSel.delete(entry.key);
    state.dictEdit = null;
    markDirty();
    if (typeof renderBars === "function") renderBars();
    renderDict();
  });
  wrap.querySelector(".cancel").addEventListener("click", () => { state.dictEdit = null; renderDict(); });
  return wrap;
}
