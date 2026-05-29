# Chord Dictionary & Batch Edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-song chord dictionary to the QA tool that groups chord occurrences by exact (name + voicing), lets you batch-edit a group's name/voicing across all occurrences, and manually merge groups that are the same chord misread two ways.

**Architecture:** A new pure client-side module `chord_dictionary.js` (build the derived dictionary; apply batch edits/merges to the in-memory song — no server or schema change). A new "Dictionary" view in `app.js` renders the groups and wires edit/merge using the existing `Fretboard` and `ChordNaming`. Persistence reuses the existing validated Save.

**Tech Stack:** Vanilla JS (browser), reusing `scripts/qa_static/chord_naming.js` (`ChordNaming`) and `fretboard.js` (`Fretboard`). Pure functions verified with a Node smoke harness (no JS test runner in repo); UI verified by manual checklist.

**Spec:** `docs/superpowers/specs/2026-05-29-chord-dictionary-batch-edit-design.md`

---

## File structure

| File | Responsibility | Action |
|------|----------------|--------|
| `scripts/qa_static/chord_dictionary.js` | pure: `buildDictionary`, `applyEdit`, `mergeEntries` | Create |
| `scripts/qa_static/app.js` | Dictionary view + edit/merge wiring | Modify |
| `scripts/qa_static/index.html` | dictionary panel markup, styles, `<script>` include | Modify |

The pure data logic lives in `chord_dictionary.js` so it is testable in Node without a DOM
(same pattern as `chord_naming.js`). `app.js` only does rendering and event wiring.

---

## Task 1: `buildDictionary` — group occurrences by (name + voicing)

**Files:**
- Create: `scripts/qa_static/chord_dictionary.js`

Verified with a Node smoke harness (no JS test runner). `buildDictionary` is pure: given a song
object it returns grouped entries. It must NOT depend on the DOM. It MAY call `window.ChordNaming`
for notes/suggestions when present, but must still work when `ChordNaming` is absent (fields just
come back empty) so it can be smoke-tested headlessly.

- [ ] **Step 1: Create the module with `buildDictionary`**

Create `scripts/qa_static/chord_dictionary.js`:

```javascript
// Per-song chord dictionary: pure functions over a song object (no DOM).
// A song is { sections: [ { bars: [ [ {chord, voicing?, text?}, ... ], ... ] } ] }.
// Grouping key is exact (chord name + voicing). "%" continuation entries are excluded.

(function () {
  function entryKey(chord, voicing) {
    return chord + " " + (voicing || "");
  }

  // Walk every chord occurrence; callback(entry, si, bi, ei).
  function eachOccurrence(song, cb) {
    (song.sections || []).forEach((sec, si) =>
      (sec.bars || []).forEach((bar, bi) =>
        bar.forEach((e, ei) => cb(e, si, bi, ei))));
  }

  // Build the dictionary: ordered list of groups, most frequent first.
  function buildDictionary(song) {
    const map = new Map();
    eachOccurrence(song, (e, si, bi, ei) => {
      if (!e.chord || e.chord === "%") return;
      const key = entryKey(e.chord, e.voicing);
      if (!map.has(key)) {
        map.set(key, { key, chord: e.chord, voicing: e.voicing || null, occurrences: [] });
      }
      map.get(key).occurrences.push({ si, bi, ei });
    });

    const CN = (typeof window !== "undefined") && window.ChordNaming;
    const entries = [...map.values()].map((g) => {
      const v = g.voicing;
      const parsed = v ? v.split(",").map((t) => (t === "x" ? "x" : parseInt(t, 10))) : null;
      return {
        ...g,
        count: g.occurrences.length,
        notes: (CN && parsed) ? CN.pcNotes(parsed) : [],
        suggestions: (CN && parsed) ? CN.suggestNames(parsed).slice(0, 4) : [],
        nameMatchesVoicing: (CN && parsed) ? CN.nameMatchesVoicing(g.chord, parsed) : null,
      };
    });
    entries.sort((a, b) => b.count - a.count);
    return entries;
  }

  const api = { buildDictionary, entryKey, eachOccurrence };
  if (typeof window !== "undefined") window.ChordDictionary = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
```

- [ ] **Step 2: Write a Node smoke harness and run it (RED — module asserts)**

Run this exact command (it both defines expectations and runs them):

```bash
node -e '
const D = require("./scripts/qa_static/chord_dictionary.js");
const song = { sections: [ { bars: [
  [ {chord:"Dm7", voicing:"x,5,7,5,6,5", text:"Vai"} ],
  [ {chord:"%"} ],
  [ {chord:"Dm7", voicing:"x,5,7,5,6,5"}, {chord:"A13", voicing:"x,0,2,0,2,2"} ],
  [ {chord:"Dm7", voicing:"x,x,0,2,2,1"} ],
] } ] };
const dict = D.buildDictionary(song);
const byKey = Object.fromEntries(dict.map(e => [e.key, e]));
console.assert(dict.length === 3, "expected 3 groups, got " + dict.length);
console.assert(byKey["Dm7 x,5,7,5,6,5"].count === 2, "Dm7 main count");
console.assert(byKey["Dm7 x,x,0,2,2,1"].count === 1, "Dm7 open count");
console.assert(byKey["A13 x,0,2,0,2,2"].count === 1, "A13 count");
console.assert(dict[0].count >= dict[1].count, "sorted by count desc");
console.assert(!dict.some(e => e.chord === "%"), "% excluded");
console.log("Task 1 OK:", dict.map(e => e.key + "=" + e.count).join(", "));
'
```
Expected once implemented: `Task 1 OK: Dm7 x,5,7,5,6,5=2, ...` and no assertion errors. (Before
the file exists this errors with MODULE_NOT_FOUND — that is the RED.)

- [ ] **Step 3: Commit**

```bash
git add scripts/qa_static/chord_dictionary.js
git commit -m "feat(qa): chord dictionary builder (group by name+voicing)"
```

---

## Task 2: `applyEdit` — batch-edit a group's name/voicing

**Files:**
- Modify: `scripts/qa_static/chord_dictionary.js`

- [ ] **Step 1: Add `applyEdit`**

In `scripts/qa_static/chord_dictionary.js`, add this function and include it in the exported
`api` object (add `applyEdit` to both `const api = {...}` and keep the existing keys):

```javascript
  // Mutate every occurrence in group `key`, setting chord and/or voicing.
  // changes = {chord?, voicing?}. A voicing of "" or null deletes the voicing key.
  // Returns the number of occurrences changed.
  function applyEdit(song, key, changes) {
    let n = 0;
    eachOccurrence(song, (e) => {
      if (!e.chord || e.chord === "%") return;
      if (entryKey(e.chord, e.voicing) !== key) return;
      if ("chord" in changes && changes.chord) e.chord = changes.chord;
      if ("voicing" in changes) {
        if (changes.voicing) e.voicing = changes.voicing;
        else delete e.voicing;
      }
      n++;
    });
    return n;
  }
```

Update the export line to:
```javascript
  const api = { buildDictionary, entryKey, eachOccurrence, applyEdit };
```

- [ ] **Step 2: Smoke-test (the key must be captured BEFORE mutating)**

```bash
node -e '
const D = require("./scripts/qa_static/chord_dictionary.js");
const song = { sections: [ { bars: [
  [ {chord:"Dm7", voicing:"x,5,7,5,6,5", text:"Vai"} ],
  [ {chord:"Dm7", voicing:"x,5,7,5,6,5"} ],
  [ {chord:"A13", voicing:"x,0,2,0,2,2"} ],
] } ] };
const n = D.applyEdit(song, "Dm7 x,5,7,5,6,5", {voicing:"x,5,7,5,6,0"});
console.assert(n === 2, "changed 2, got " + n);
const bars = song.sections[0].bars;
console.assert(bars[0][0].voicing === "x,5,7,5,6,0", "occ1 voicing");
console.assert(bars[1][0].voicing === "x,5,7,5,6,0", "occ2 voicing");
console.assert(bars[0][0].text === "Vai", "text untouched");
console.assert(bars[2][0].voicing === "x,0,2,0,2,2", "other group untouched");
// clearing voicing deletes the key
D.applyEdit(song, "Dm7 x,5,7,5,6,0", {voicing:""});
console.assert(!("voicing" in bars[0][0]), "voicing deleted when cleared");
console.log("Task 2 OK");
'
```
Expected: `Task 2 OK`, no assertion errors.

- [ ] **Step 3: Commit**

```bash
git add scripts/qa_static/chord_dictionary.js
git commit -m "feat(qa): batch-edit a dictionary group across occurrences"
```

---

## Task 3: `mergeEntries` — unify selected groups to a canonical chord

**Files:**
- Modify: `scripts/qa_static/chord_dictionary.js`

- [ ] **Step 1: Add `mergeEntries`**

In `scripts/qa_static/chord_dictionary.js`, add:

```javascript
  // Set chord+voicing on every occurrence across all groups in `keys` to the
  // canonical {chord, voicing}. Returns the number of occurrences changed.
  function mergeEntries(song, keys, canonical) {
    const keySet = new Set(keys);
    let n = 0;
    eachOccurrence(song, (e) => {
      if (!e.chord || e.chord === "%") return;
      if (!keySet.has(entryKey(e.chord, e.voicing))) return;
      e.chord = canonical.chord;
      if (canonical.voicing) e.voicing = canonical.voicing;
      else delete e.voicing;
      n++;
    });
    return n;
  }
```

Update the export line to:
```javascript
  const api = { buildDictionary, entryKey, eachOccurrence, applyEdit, mergeEntries };
```

- [ ] **Step 2: Smoke-test merge (capture keys before mutating)**

```bash
node -e '
const D = require("./scripts/qa_static/chord_dictionary.js");
const song = { sections: [ { bars: [
  [ {chord:"Dm7", voicing:"x,5,7,5,6,5"} ],
  [ {chord:"Dm7", voicing:"x,5,7,5,6,x"} ],
  [ {chord:"Dm7", voicing:"x,x,0,2,2,1"} ],
] } ] };
const n = D.mergeEntries(song, ["Dm7 x,5,7,5,6,5","Dm7 x,5,7,5,6,x"], {chord:"Dm7", voicing:"x,5,7,5,6,5"});
console.assert(n === 2, "merged 2, got " + n);
const dict = D.buildDictionary(song);
console.assert(dict.length === 2, "now 2 groups, got " + dict.length);
const main = dict.find(e => e.key === "Dm7 x,5,7,5,6,5");
console.assert(main.count === 2, "merged group count 2");
console.assert(dict.some(e => e.key === "Dm7 x,x,0,2,2,1"), "open voicing untouched");
console.log("Task 3 OK");
'
```
Expected: `Task 3 OK`, no assertion errors.

- [ ] **Step 3: Commit**

```bash
git add scripts/qa_static/chord_dictionary.js
git commit -m "feat(qa): merge dictionary groups to a canonical chord"
```

---

## Task 4: Dictionary panel — markup, styles, script include

**Files:**
- Modify: `scripts/qa_static/index.html`

- [ ] **Step 1: Add the script include**

In `scripts/qa_static/index.html`, the existing script tags are (in order):
`vendor/tonal.bundle.js`, `vendor/chord-symbol.bundle.js`, `chord_naming.js`, `fretboard.js`,
`app.js`. Add `chord_dictionary.js` immediately BEFORE `app.js`:

```html
<script src="fretboard.js"></script>
<script src="chord_dictionary.js"></script>
<script src="app.js"></script>
```

- [ ] **Step 2: Add a view toggle + dictionary container to the right column**

In `index.html`, the right column is currently `<div class="col right" id="bars"></div>`.
Replace that single line with a toggle bar plus two containers:

```html
  <div class="col right">
    <div class="viewtabs">
      <button id="tabBars" class="tab active">Bars</button>
      <button id="tabDict" class="tab">Dictionary</button>
    </div>
    <div id="bars"></div>
    <div id="dict" style="display:none"></div>
  </div>
```

- [ ] **Step 3: Add styles**

In the `<style>` block of `index.html`, append:

```css
  .viewtabs{display:flex;gap:6px;margin-bottom:10px}
  .tab{background:#1e222b;color:#9aa3b2;border:1px solid #2a2f3a;border-radius:6px;padding:5px 12px;cursor:pointer}
  .tab.active{background:#2d3b5a;color:#e6e8ee;border-color:#6ea8fe}
  .drow{border:1px solid #2a2f3a;border-radius:8px;padding:8px;margin-bottom:8px;background:#171a21}
  .drow.sel{border-color:#6ea8fe}
  .dhead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .dhead .dnm{font-weight:700}
  .dhead .dvc{font:11px ui-monospace,monospace;color:#9aa3b2}
  .dhead .dnt{font:11px ui-monospace,monospace;color:#7fb3a0}
  .dhead .dct{font-size:11px;color:#9aa3b2;margin-left:auto}
  .dhead .warn{display:inline-block;width:8px;height:8px;border-radius:50%;background:#f85149}
  .dedit{margin-top:8px;border-top:1px solid #2a2f3a;padding-top:8px}
  .dedit input[type=text]{width:100%;background:#11141b;border:1px solid #2a2f3a;color:#e6e8ee;border-radius:6px;padding:7px;margin-bottom:6px}
  .dsuggest .s{display:inline-block;border:1px solid #2a2f3a;border-radius:6px;padding:2px 8px;margin:2px;cursor:pointer;font-size:12px}
  .dsuggest .s:hover{border-color:#6ea8fe}
  .dactions{display:flex;gap:8px;margin-top:8px}
  .dactions button{border-radius:6px;padding:7px 12px;border:1px solid #2a2f3a;background:#171a21;color:#e6e8ee;cursor:pointer}
  .dactions .apply{background:#6ea8fe;color:#06132b;border:0;font-weight:600}
  .dmergebar{position:sticky;top:0;background:#11141b;border:1px solid #6ea8fe;border-radius:8px;padding:8px;margin-bottom:8px;display:none}
  .dmergebar.show{display:block}
```

- [ ] **Step 4: Commit**

```bash
git add scripts/qa_static/index.html
git commit -m "feat(qa): dictionary panel markup, tabs, and styles"
```

---

## Task 5: Render the dictionary + tab switching

**Files:**
- Modify: `scripts/qa_static/app.js`

- [ ] **Step 1: Wire the tabs in `init`**

In `scripts/qa_static/app.js`, inside `init()`, after the line
`document.getElementById("saveBtn").onclick = save;` add:

```javascript
  document.getElementById("tabBars").onclick = () => showView("bars");
  document.getElementById("tabDict").onclick = () => showView("dict");
```

- [ ] **Step 2: Add `showView` and `renderDict` (selection state at top)**

At the top of `app.js`, the state is declared as
`let state = { album: null, file: null, doc: null, sel: null };`. Replace it with:

```javascript
let state = { album: null, file: null, doc: null, sel: null, dictSel: new Set(), dictEdit: null };
```

Then add these functions to `app.js` (anywhere at top level, e.g. after `renderBars`):

```javascript
function showView(which) {
  document.getElementById("bars").style.display = which === "bars" ? "" : "none";
  document.getElementById("dict").style.display = which === "dict" ? "" : "none";
  document.getElementById("tabBars").classList.toggle("active", which === "bars");
  document.getElementById("tabDict").classList.toggle("active", which === "dict");
  if (which === "dict") renderDict();
}

function renderDict() {
  const root = document.getElementById("dict");
  const entries = window.ChordDictionary.buildDictionary(song());
  root.innerHTML = "";

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
    row.innerHTML = `<div class="dhead">
      <input type="checkbox" ${state.dictSel.has(e.key) ? "checked" : ""} data-sel="${e.key}">
      <span class="dnm">${e.chord}</span>${mism}
      <span class="dvc">${e.voicing || "—"}</span>
      <span class="dnt">${e.notes.join(" ")}</span>
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
```

- [ ] **Step 3: Smoke-check syntax**

Run: `node --check scripts/qa_static/app.js`
Expected: no output (valid). (`buildDictEditor` and `openMerge` are added in Task 6 — until then
`node --check` still passes because they are only referenced, not defined; the browser would error
if you opened the dict tab, so do not test in-browser until Task 6.)

- [ ] **Step 4: Commit**

```bash
git add scripts/qa_static/app.js
git commit -m "feat(qa): render chord dictionary with tabs and selection"
```

---

## Task 6: Inline group editor + merge dialog

**Files:**
- Modify: `scripts/qa_static/app.js`

- [ ] **Step 1: Add `buildDictEditor` and `openMerge`**

Add these functions to `scripts/qa_static/app.js`:

```javascript
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
  // prefill canonical from the largest selected group
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
```

- [ ] **Step 2: Syntax check**

Run: `node --check scripts/qa_static/app.js`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add scripts/qa_static/app.js
git commit -m "feat(qa): dictionary group editor and merge dialog"
```

---

## Task 7: End-to-end manual smoke test

**Files:** none (verification)

- [ ] **Step 1: Start the server (if not running)**

Run: `./.venv/bin/python scripts/qa_server.py --songs data/joao-gilberto/songs &`
Open: http://localhost:8000

- [ ] **Step 2: Manual checklist** (pick `1-chega-de-saudade` → a song)

Confirm:
- A **Dictionary** tab appears beside **Bars**; clicking it shows grouped chords with name,
  voicing, notes, count, and a red dot on name↔voicing mismatches.
- Two `Dm7` rows with different voicings appear as **separate** rows (not collapsed).
- Click a row → inline editor with the fretboard + suggestions; **Apply** changes that voicing on
  all N occurrences (verify by switching to Bars — every matching chip updated).
- Check 2+ rows → a merge bar appears → **Merge…** prompts for canonical name/voicing (prefilled
  from the largest) → applying unifies them into one row; other groups untouched.
- Typing an invalid name (e.g. `A13,9`) in editor or merge is rejected.
- **Save song** persists; reloading the song shows the batch edits stuck.

- [ ] **Step 3: Stop the server**

Run: `pkill -f qa_server.py`
(No commit unless the checklist surfaced a fix.)

---

## Self-review notes

- **Spec coverage:** grouping by exact name+voicing (T1), batch edit name/voicing across
  occurrences leaving `text` untouched (T2), manual merge with canonical value prefilled from
  largest (T3 + T6 `openMerge`), dictionary UI with notes/suggestions/consistency (T4–T6),
  `%` excluded and derived-not-stored (T1). Save reuses existing flow (T7). All covered.
- **No schema/server change** — confirmed; only `qa_static/` files touched.
- **Naming consistency:** `window.ChordDictionary.{buildDictionary,applyEdit,mergeEntries,entryKey,eachOccurrence}`,
  `state.dictSel` (Set), `state.dictEdit` (key|null), `renderDict`/`showView`/`buildDictEditor`/`openMerge`
  used consistently across tasks. `entryKey(chord, voicing)` format `"<chord> <voicing|''>"` matches
  between build, applyEdit, and mergeEntries.
- **Known minor:** `openMerge` uses `prompt()` for the canonical value (simple, dependency-free);
  could become an inline form later, but meets the spec (prefilled from largest, editable).
```
