// Songsheet QA app: load albums/songs, render pages + editable chord chips, edit panel, save.
let state = { album: null, file: null, doc: null, sel: null, dictSel: new Set(), dictEdit: null, dictSort: "count" };

async function api(path, opts) {
  const r = await fetch(path, opts);
  return r.json();
}

const STATUS_LABEL = { pending: "○ pending", in_progress: "◐ in progress", done: "✓ done" };

let albums = [];

function fillSongs() {
  const albumSel = document.getElementById("albumSel");
  const songSel = document.getElementById("songSel");
  const a = albums.find((x) => x.album === albumSel.value);
  songSel.innerHTML = a.songs
    .map((s) => `<option value="${s.file}">${STATUS_LABEL[s.status] || "○"}  ${s.file}</option>`)
    .join("");
  updateProgress();
}

function updateProgress() {
  const a = albums.find((x) => x.album === document.getElementById("albumSel").value);
  if (!a) return;
  const done = a.songs.filter((s) => s.status === "done").length;
  document.getElementById("albumProgress").textContent = `${done}/${a.songs.length} done`;
}

async function init() {
  albums = await api("/api/albums");
  const albumSel = document.getElementById("albumSel");
  albumSel.innerHTML = albums.map((a) => `<option>${a.album}</option>`).join("");
  const songSel = document.getElementById("songSel");
  albumSel.onchange = () => { fillSongs(); loadSong(); };
  songSel.onchange = loadSong;
  document.getElementById("saveBtn").onclick = save;
  document.getElementById("statusSel").onchange = (ev) => {
    if (!state.doc) return;
    state.doc.document.status = ev.target.value;
  };
  // key selector — drives interval analysis; stored on song.key. Major + minor.
  const keySel = document.getElementById("keySel");
  const ROOTS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const KEYS = ROOTS.concat(ROOTS.map((r) => r + "m")); // major then minor
  keySel.innerHTML = '<option value="">key: —</option>' +
    KEYS.map((k) => `<option value="${k}">key: ${k}</option>`).join("");
  keySel.onchange = (ev) => {
    if (!state.doc) return;
    song().key = ev.target.value || null;
    window.ChordNaming.setKeyTonic(songKey());
    renderBars();
    if (document.getElementById("dict").style.display !== "none") renderDict();
    if (state.sel) openEditor(state.sel.si, state.sel.bi, state.sel.ei);
  };
  document.getElementById("tabBars").onclick = () => showView("bars");
  document.getElementById("tabDict").onclick = () => showView("dict");

  // global flat/sharp spelling toggle — re-renders bars (and editor if open)
  const spellBtn = document.getElementById("spellToggle");
  spellBtn.onclick = () => {
    const next = window.ChordNaming.getSpelling() === "sharp" ? "flat" : "sharp";
    window.ChordNaming.setSpelling(next);
    spellBtn.textContent = next === "flat" ? "♭ flat" : "♯ sharp";
    renderBars();
    if (document.getElementById("dict").style.display !== "none") renderDict();
    if (state.sel) openEditor(state.sel.si, state.sel.bi, state.sel.ei);
  };

  fillSongs();
  loadSong();
}

async function loadSong() {
  state.album = document.getElementById("albumSel").value;
  state.file = document.getElementById("songSel").value;
  state.doc = await api(`/api/song/${state.album}/${state.file}`);
  state.sel = null;
  state.dictSel.clear();
  state.dictEdit = null;
  const status = (state.doc.document && state.doc.document.status) || "pending";
  document.getElementById("statusSel").value = status;
  document.getElementById("keySel").value = songKey();
  window.ChordNaming.setKeyTonic(songKey());
  renderPages();
  renderBars();
  showView("bars");
  document.getElementById("editor").classList.remove("open");
}

function song() { return state.doc.songs[0]; }

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
  document.getElementById("pages").innerHTML = pages.map((n) =>
    `<img src="/api/page/${state.album}/${state.file}/${n}" alt="page ${n}">
     <div class="pagecap">page ${n}</div>`).join("");
}

function renderBars() {
  const root = document.getElementById("bars");
  root.innerHTML = "";
  let flags = 0;
  song().sections.forEach((sec, si) => {
    const lab = document.createElement("div");
    lab.className = "section-label";
    lab.textContent = sec.label || `Section ${si + 1}`;
    root.appendChild(lab);
    sec.bars.forEach((bar, bi) => {
      const bd = document.createElement("div");
      bd.className = "bar";
      bd.innerHTML = `<div class="barnum">bar ${bi + 1}${bar.length > 1 ? " · " + bar.length + " chords" : ""}</div>`;
      const chips = document.createElement("div");
      chips.className = "chips";
      bar.forEach((e, ei) => {
        const mismatch = e.chord !== "%" && e.voicing &&
          window.ChordNaming.nameMatchesVoicing(e.chord, parseVoicing(e.voicing)) === false;
        if (mismatch) flags++;
        const chip = document.createElement("div");
        chip.className = "chip" + (e.chord === "%" ? " pct" : "") +
          (state.sel && state.sel.si === si && state.sel.bi === bi && state.sel.ei === ei ? " sel" : "");
        const notes = (e.chord !== "%" && e.voicing) ? notesFor(e.voicing) : "";
        const ivals = (e.chord !== "%") ? intervalsFor(e.voicing) : "";
        const civals = (e.chord !== "%") ? chordIvalsFor(e.voicing, e.chord) : "";
        const canLeft = bi > 0;
        const canRight = bi < sec.bars.length - 1;
        chip.innerHTML =
          `<div class="nm">${e.chord}${mismatch ? '<span class="warn"></span>' : ""}</div>
           <div class="vc">${e.voicing || "—"}</div>
           ${notes ? `<div class="nt">${notes}</div>` : ""}
           ${civals ? `<div class="ci">${civals}</div>` : ""}
           ${ivals ? `<div class="iv">${ivals}</div>` : ""}
           <div class="tx">${e.text ? "_" + e.text : "—"}</div>
           <div class="mv">
             <button class="mvl" title="move to previous bar" ${canLeft ? "" : "disabled"}>←</button>
             <button class="mvr" title="move to next bar" ${canRight ? "" : "disabled"}>→</button>
           </div>`;
        chip.onclick = () => openEditor(si, bi, ei);
        chip.querySelector(".mvl").onclick = (ev) => { ev.stopPropagation(); moveChord(si, bi, ei, -1); };
        chip.querySelector(".mvr").onclick = (ev) => { ev.stopPropagation(); moveChord(si, bi, ei, +1); };
        chips.appendChild(chip);
      });
      bd.appendChild(chips);
      root.appendChild(bd);
    });
  });
  document.getElementById("flagCount").textContent = flags ? `${flags} flagged` : "";
}

function parseVoicing(s) {
  return s.split(",").map((t) => (t === "x" ? "x" : parseInt(t, 10)));
}

// Move a chord entry to the adjacent bar (dir -1 = previous, +1 = next).
// Moving left appends to the end of the previous bar; right prepends to the next.
function moveChord(si, bi, ei, dir) {
  const bars = song().sections[si].bars;
  const target = bi + dir;
  if (target < 0 || target >= bars.length) return;
  const [entry] = bars[bi].splice(ei, 1);
  if (dir < 0) bars[target].push(entry);
  else bars[target].unshift(entry);
  state.sel = null;
  document.getElementById("editor").classList.remove("open");
  renderBars();
}

function openEditor(si, bi, ei) {
  state.sel = { si, bi, ei };
  const e = song().sections[si].bars[bi][ei];
  const ed = document.getElementById("editor");
  ed.classList.add("open");
  ed.innerHTML = `
    <h2>Edit chord · bar ${bi + 1}</h2>
    <label>Chord name</label>
    <input type="text" id="edName" value="${e.chord}">
    <div id="edBadge"></div>
    <div id="edIvals" class="fb-notes"></div>
    <label>Anchored lyric</label>
    <input type="text" id="edText" value="${e.text || ""}">
    <label>Voicing</label>
    <div id="edFb"></div>
    <label>Suggestions</label>
    <div class="suggest" id="edSuggest"></div>
    <div class="ed-actions">
      <button class="apply" id="edApply">Apply</button>
      <button id="edCancel">Cancel</button>
    </div>`;
  let curVoicing = e.voicing ? parseVoicing(e.voicing) : ["x", "x", "x", "x", "x", "x"];
  const fb = window.Fretboard(document.getElementById("edFb"), (v) => {
    curVoicing = v;
    refreshNaming();
  });
  fb.set(curVoicing);
  document.getElementById("edName").oninput = refreshNaming;

  function refreshNaming() {
    const name = document.getElementById("edName").value.trim();
    const badge = document.getElementById("edBadge");
    const match = window.ChordNaming.nameMatchesVoicing(name, curVoicing);
    if (match === true) { badge.className = "badge ok"; badge.textContent = "● matches voicing"; }
    else if (match === false) { badge.className = "badge bad"; badge.textContent = "● name ≠ voicing"; }
    else { badge.className = ""; badge.textContent = ""; }
    const sug = window.ChordNaming.suggestNames(curVoicing);
    document.getElementById("edSuggest").innerHTML = sug.length
      ? sug.map((s) => `<div class="s" data-n="${s.name}"><b>${s.name}</b><span>suggest</span></div>`).join("")
      : `<div class="s"><span>no detection</span></div>`;
    document.querySelectorAll("#edSuggest .s[data-n]").forEach((el) =>
      el.onclick = () => { document.getElementById("edName").value = el.dataset.n; refreshNaming(); });
    const ci = window.ChordNaming.perStringChordIntervals(curVoicing, name);
    document.getElementById("edIvals").textContent = ci.length ? "chord intervals: " + ci.join(" ") : "";
  }
  refreshNaming();

  document.getElementById("edApply").onclick = () => {
    const name = document.getElementById("edName").value.trim();
    const v = window.ChordNaming.validateName(name);
    if (!v.valid && name !== "%") { alert("Not a valid ChordMark chord: " + name); return; }
    e.chord = name;
    const text = document.getElementById("edText").value.trim();
    if (text) e.text = text; else delete e.text;
    const vc = fb.get();
    if (vc.every((f) => f === "x")) delete e.voicing;
    else e.voicing = vc.join(",");
    renderBars();
  };
  document.getElementById("edCancel").onclick = () => {
    ed.classList.remove("open"); state.sel = null; renderBars();
  };
}

async function save() {
  const status = document.getElementById("saveStatus");
  status.textContent = "saving…"; status.style.color = "#9aa3b2";
  const res = await api(`/api/song/${state.album}/${state.file}`,
    { method: "POST", body: JSON.stringify(state.doc) });
  if (res.ok) {
    status.textContent = "✓ saved"; status.style.color = "#3fb950";
    // reflect the saved status in the local album cache → progress count + dropdown label
    const a = albums.find((x) => x.album === state.album);
    const s = a && a.songs.find((x) => x.file === state.file);
    if (s) {
      s.status = (state.doc.document && state.doc.document.status) || "pending";
      const opt = [...document.getElementById("songSel").options]
        .find((o) => o.value === state.file);
      if (opt) opt.textContent = `${STATUS_LABEL[s.status] || "○"}  ${s.file}`;
      updateProgress();
    }
  } else { status.textContent = "✗ " + res.error; status.style.color = "#f85149"; }
}

// ---- Dictionary view ----

function showView(which) {
  document.getElementById("bars").style.display = which === "bars" ? "" : "none";
  document.getElementById("dict").style.display = which === "dict" ? "" : "none";
  document.getElementById("tabBars").classList.toggle("active", which === "bars");
  document.getElementById("tabDict").classList.toggle("active", which === "dict");
  if (which === "dict") renderDict();
}

function renderDict() {
  const root = document.getElementById("dict");
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
    b.onclick = () => { state.dictSort = b.dataset.sort; renderDict(); });
  root.appendChild(sortBar);

  // merge bar (shown when 2+ selected)
  const mergeBar = document.createElement("div");
  mergeBar.className = "dmergebar" + (state.dictSel.size >= 2 ? " show" : "");
  mergeBar.innerHTML = `<b>${state.dictSel.size} selected</b> — merge into one chord:
    <button class="apply" id="dMergeBtn">Merge…</button>
    <button id="dClearSel">Clear</button>`;
  root.appendChild(mergeBar);
  if (state.dictSel.size >= 2) {
    document.getElementById("dMergeBtn").onclick = () => openMerge(entries);
    document.getElementById("dClearSel").onclick = () => { state.dictSel.clear(); renderDict(); };
  }

  entries.forEach((e) => {
    const row = document.createElement("div");
    row.className = "drow" + (state.dictSel.has(e.key) ? " sel" : "");
    const mism = e.nameMatchesVoicing === false ? '<span class="warn"></span>' : "";
    const ivals = intervalsFor(e.voicing);
    const civals = chordIvalsFor(e.voicing, e.chord);
    row.innerHTML = `<div class="dhead">
      <input type="checkbox" ${state.dictSel.has(e.key) ? "checked" : ""} data-sel="${e.key}">
      <span class="dnm">${e.chord}</span>${mism}
      <span class="dvc">${e.voicing || "—"}</span>
      <span class="dnt">${notesFor(e.voicing)}</span>
      ${civals ? `<span class="dci">${civals}</span>` : ""}
      ${ivals ? `<span class="div">${ivals}</span>` : ""}
      <span class="dct">${e.count}×</span>
    </div>`;
    row.querySelector("[data-sel]").onclick = (ev) => {
      ev.stopPropagation();
      if (state.dictSel.has(e.key)) state.dictSel.delete(e.key);
      else state.dictSel.add(e.key);
      renderDict();
    };
    row.querySelector(".dhead").onclick = () => {
      state.dictEdit = state.dictEdit === e.key ? null : e.key;
      renderDict();
    };
    if (state.dictEdit === e.key) row.appendChild(buildDictEditor(e));
    root.appendChild(row);
  });
}

function buildDictEditor(entry) {
  const wrap = document.createElement("div");
  wrap.className = "dedit";
  wrap.onclick = (e) => e.stopPropagation();
  wrap.innerHTML = `
    <input type="text" class="dName" value="${entry.chord}">
    <div class="dFb"></div>
    <div class="dsuggest"></div>
    <div class="dactions">
      <button class="apply">Apply to ${entry.count}×</button>
      <button class="cancel">Cancel</button>
    </div>`;
  let curVoicing = entry.voicing
    ? entry.voicing.split(",").map((t) => (t === "x" ? "x" : parseInt(t, 10)))
    : ["x", "x", "x", "x", "x", "x"];
  const fb = window.Fretboard(wrap.querySelector(".dFb"), (v) => { curVoicing = v; refreshSug(); });
  fb.set(curVoicing);

  function refreshSug() {
    const sug = window.ChordNaming.suggestNames(curVoicing);
    wrap.querySelector(".dsuggest").innerHTML =
      sug.map((s) => `<span class="s" data-n="${s.name}">${s.name}</span>`).join("");
    wrap.querySelectorAll(".dsuggest .s").forEach((el) =>
      el.onclick = () => { wrap.querySelector(".dName").value = el.dataset.n; });
  }
  refreshSug();

  wrap.querySelector(".apply").onclick = () => {
    const name = wrap.querySelector(".dName").value.trim();
    const v = window.ChordNaming.validateName(name);
    if (!v.valid && name !== "%") { alert("Not a valid ChordMark chord: " + name); return; }
    const vc = fb.get();
    const voicing = vc.every((f) => f === "x") ? "" : vc.join(",");
    window.ChordDictionary.applyEdit(song(), entry.key, { chord: name, voicing });
    state.dictEdit = null;
    renderBars();
    renderDict();
  };
  wrap.querySelector(".cancel").onclick = () => { state.dictEdit = null; renderDict(); };
  return wrap;
}

function openMerge(entries) {
  const keys = [...state.dictSel];
  const largest = entries
    .filter((e) => state.dictSel.has(e.key))
    .sort((a, b) => b.count - a.count)[0];
  const name = prompt("Merge chord name:", largest.chord);
  if (name === null) return;
  const voicing = prompt("Merge voicing (comma form, blank = none):", largest.voicing || "");
  if (voicing === null) return;
  const v = window.ChordNaming.validateName(name.trim());
  if (!v.valid && name.trim() !== "%") { alert("Not a valid ChordMark chord: " + name); return; }
  window.ChordDictionary.mergeEntries(song(), keys, { chord: name.trim(), voicing: voicing.trim() });
  state.dictSel.clear();
  state.dictEdit = null;
  renderBars();
  renderDict();
}

init();
