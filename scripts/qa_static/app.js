// Songsheet QA app: load albums/songs, render pages + editable chord chips, edit panel, save.
let state = { album: null, file: null, doc: null, sel: null };

async function api(path, opts) {
  const r = await fetch(path, opts);
  return r.json();
}

async function init() {
  const albums = await api("/api/albums");
  const albumSel = document.getElementById("albumSel");
  albumSel.innerHTML = albums.map((a) => `<option>${a.album}</option>`).join("");
  const songSel = document.getElementById("songSel");
  function fillSongs() {
    const a = albums.find((x) => x.album === albumSel.value);
    songSel.innerHTML = a.songs.map((s) => `<option>${s}</option>`).join("");
  }
  albumSel.onchange = () => { fillSongs(); loadSong(); };
  songSel.onchange = loadSong;
  document.getElementById("saveBtn").onclick = save;

  // global flat/sharp spelling toggle — re-renders bars (and editor if open)
  const spellBtn = document.getElementById("spellToggle");
  spellBtn.onclick = () => {
    const next = window.ChordNaming.getSpelling() === "sharp" ? "flat" : "sharp";
    window.ChordNaming.setSpelling(next);
    spellBtn.textContent = next === "flat" ? "♭ flat" : "♯ sharp";
    renderBars();
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
  renderPages();
  renderBars();
  document.getElementById("editor").classList.remove("open");
}

function song() { return state.doc.songs[0]; }

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
        const notes = (e.chord !== "%" && e.voicing)
          ? window.ChordNaming.pcNotes(parseVoicing(e.voicing)).join(" ") : "";
        chip.innerHTML =
          `<div class="nm">${e.chord}${mismatch ? '<span class="warn"></span>' : ""}</div>
           <div class="vc">${e.voicing || "—"}</div>
           ${notes ? `<div class="nt">${notes}</div>` : ""}
           <div class="tx">${e.text ? "_" + e.text : "—"}</div>`;
        chip.onclick = () => openEditor(si, bi, ei);
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
  if (res.ok) { status.textContent = "✓ saved"; status.style.color = "#3fb950"; }
  else { status.textContent = "✗ " + res.error; status.style.color = "#f85149"; }
}

init();
