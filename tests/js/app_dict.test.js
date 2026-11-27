const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

function createDictHarness({ initialDoc } = {}) {
  const byId = new Map();
  let undoCount = 0;
  let dirtyCount = 0;
  let renderBarsCalls = 0;
  let jumped;

  function makeElement(tag = "div") {
    const listeners = new Map();
    let html = "";
    const children = [];
    const el = {
      tagName: tag.toUpperCase(),
      className: "",
      value: "",
      textContent: "",
      style: {},
      dataset: {},
      setAttribute(name, value) { this[name] = value; },
      focus() {},
      contains(node) { return this === node || children.some((child) => child.contains(node)); },
      children,
      _bySelector: new Map(),
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatch(type, ev = {}) {
        const event = { stopPropagation() {}, preventDefault() {}, ...ev };
        for (const fn of listeners.get(type) || []) fn(event);
      },
      click() { this.dispatch("click"); },
      input(val) {
        if (val !== undefined) this.value = val;
        this.dispatch("input");
      },
      appendChild(child) {
        children.push(child);
        return child;
      },
      querySelector(sel) {
        return this._bySelector.get(sel) || null;
      },
      querySelectorAll(sel) {
        if (sel === "[data-sort]") return this._sortButtons || [];
        return [];
      },
      set innerHTML(val) {
        html = val;
        children.length = 0;
        this._bySelector.clear();
        if (this.className === "dsort") {
          const btns = [...val.matchAll(/data-sort="([^"]+)"/g)].map((m) => {
            const b = makeElement("button");
            b.dataset.sort = m[1];
            return b;
          });
          this._sortButtons = btns;
        }
        if (this.className.startsWith("dmergebar")) {
          for (const id of ["dMergeBtn", "dClearSel", "dMergeForm", "dMergeName", "dMergeVoicing", "dMergeApply", "dMergeCancel", "dMergeErr"]) {
            const node = makeElement(id.includes("Name") || id.includes("Voicing") ? "input" : "div");
            node.id = id;
            byId.set(id, node);
          }
        }
        if (this.className.startsWith("drow")) {
          const head = makeElement("div");
          head.className = "dhead";
          const cb = makeElement("input");
          cb.dataset.sel = val.match(/data-sel="([^"]*)"/)?.[1] || "";
          const pb = val.includes('class="dprint"') ? makeElement("button") : null;
          this._bySelector.set(".dhead", head);
          this._bySelector.set("[data-sel]", cb);
          if (pb) this._bySelector.set(".dprint", pb);
        }
        if (this.className === "dedit") {
          const nameInput = makeElement("input");
          nameInput.value = val.match(/class="dName"[^>]* value="([^"]*)"/)?.[1] || "";
          const errEl = makeElement("div");
          const applyBtn = makeElement("button");
          const cancelBtn = makeElement("button");
          const fbEl = makeElement("div");
          const sugEl = makeElement("div");
          sugEl.querySelectorAll = () => [];
          this._bySelector.set(".dName", nameInput);
          this._bySelector.set(".derr", errEl);
          this._bySelector.set(".apply", applyBtn);
          this._bySelector.set(".cancel", cancelBtn);
          this._bySelector.set(".dFb", fbEl);
          this._bySelector.set(".dsuggest", sugEl);
        }
      },
      get innerHTML() { return html; },
    };
    return el;
  }

  const dictRoot = makeElement("div");
  dictRoot.id = "dict";
  byId.set("dict", dictRoot);

  const state = {
    album: "album",
    file: "song.json",
    activeView: "dict",
    dictSel: new Set(),
    dictEdit: null,
    dictSort: "count",
    dictMergeOpen: false,
    dirty: false,
    doc: initialDoc || {
      _meta: { extraction_sources: { src1: { type: "pdf" } } },
      songs: [{
        sections: [{
          bars: [
            [
              { chord: "C", voicing: "x,3,2,0,1,0", voicing_printed: "x,3,5,5,5,3", observation_id: "obs-c1" },
              { chord: "C", voicing: "x,3,5,5,5,3" },
            ],
            [
              { chord: "G7", voicing: "3,2,0,0,0,1" },
              { chord: "Am", voicing: "x,0,2,2,1,0" },
            ],
          ],
        }],
      }],
    },
  };

  let fbVoicing = ["x", "x", "x", "x", "x", "x"];
  const windowObj = {
    ChordDiagram: { svg: () => "<svg/>" },
    ChordNaming: {
      validateName: (name) => ({ valid: Boolean(name) && name !== "bad chord" }),
      nameMatchesVoicing: (name) => name !== "G7",
      suggestNames: () => [{ name: "C" }],
      pcNotes: () => [],
    },
    Fretboard: () => ({
      set: (v) => { fbVoicing = v.slice(); },
      get: () => fbVoicing.slice(),
    }),
  };

  const context = vm.createContext({
    state,
    window: windowObj,
    $: (id) => byId.get(id) || null,
    song: () => state.doc.songs[0],
    esc: (s) => String(s ?? ""),
    parseVoicing: (v) => String(v).split(",").map((t) => (t === "x" ? "x" : parseInt(t, 10))),
    notesFor: () => "",
    intervalsFor: () => "",
    chordIvalsFor: () => "",
    pushUndo: () => { undoCount += 1; },
    markDirty: () => { dirtyCount += 1; state.dirty = true; },
    renderBars: () => { renderBarsCalls += 1; },
    jumpToEntry: (coords) => { jumped = coords; },
    document: {
      createElement: (tag) => makeElement(tag),
    },
  });

  for (const file of ["chord_dictionary.js", "app_dict.js"]) {
    const src = readFileSync(join(__dirname, "../../scripts/qa_static", file), "utf8");
    vm.runInContext(src, context, { filename: file });
  }
  context.renderDict();

  const rows = () => dictRoot.children.filter((c) => c.className.startsWith("drow"));
  const rowFor = (chord, voicing) => {
    const entries = windowObj.ChordDictionary.buildDictionary(state.doc.songs[0]);
    const sorted = state.dictSort === "alpha"
      ? [...entries].sort((a, b) => a.chord.localeCompare(b.chord, undefined, { numeric: true, sensitivity: "base" }) || (a.voicing || "").localeCompare(b.voicing || ""))
      : entries;
    const idx = sorted.findIndex((e) => e.chord === chord && (e.voicing || "") === (voicing || ""));
    return idx >= 0 ? rows()[idx] : null;
  };
  const sortButtons = () => dictRoot.children.find((c) => c.className === "dsort").querySelectorAll("[data-sort]");

  return {
    state,
    get: (id) => byId.get(id),
    rows,
    rowFor,
    sortButtons,
    renderDict: () => context.renderDict(),
    setEditorFretboard: (v) => { fbVoicing = v; },
    undoCount: () => undoCount,
    dirtyCount: () => dirtyCount,
    renderBarsCalls: () => renderBarsCalls,
    entries: () => windowObj.ChordDictionary.buildDictionary(state.doc.songs[0]),
    root: dictRoot,
    jumped: () => jumped,
  };
}

test("applyMerge validates #dMergeVoicing, blocks mutation on invalid input, and clears error on input", () => {
  const app = createDictHarness();
  app.rowFor("C", "x,3,2,0,1,0").querySelector("[data-sel]").click();
  app.rowFor("C", "x,3,5,5,5,3").querySelector("[data-sel]").click();
  app.get("dMergeBtn").click();

  const beforeDoc = JSON.stringify(app.state.doc);
  for (const badVoicing of ["x32010", "x,3,2,0,1,25", "x,3,2,0,1"]) {
    app.get("dMergeName").input("C");
    app.get("dMergeVoicing").input(badVoicing);
    app.get("dMergeApply").click();

    assert.ok(app.get("dMergeErr").textContent.length > 0);
    assert.equal(JSON.stringify(app.state.doc), beforeDoc);
    assert.equal(app.state.dirty, false);
    assert.equal(app.undoCount(), 0);
    assert.equal(app.state.dictSel.size, 2);
    assert.equal(app.state.dictMergeOpen, true);
    assert.equal(app.get("dMergeVoicing").value, badVoicing);
  }

  // Typing clears #dMergeErr
  app.get("dMergeVoicing").input("x,3,2,0,1,0");
  assert.equal(app.get("dMergeErr").textContent, "");
});

test("applyMerge normalizes valid voicings, handles blank/all-x, and preserves provenance", () => {
  const app = createDictHarness();
  app.rowFor("C", "x,3,2,0,1,0").querySelector("[data-sel]").click();
  app.rowFor("C", "x,3,5,5,5,3").querySelector("[data-sel]").click();
  app.get("dMergeBtn").click();

  app.get("dMergeName").input("C");
  app.get("dMergeVoicing").input(" X, 03, 2, 0, 1, 0 ");
  app.get("dMergeApply").click();

  assert.equal(app.undoCount(), 1);
  assert.equal(app.state.dirty, true);
  assert.equal(app.state.dictSel.size, 0);
  assert.equal(app.state.dictMergeOpen, false);
  const c1 = app.state.doc.songs[0].sections[0].bars[0][0];
  const c2 = app.state.doc.songs[0].sections[0].bars[0][1];
  assert.equal(c1.voicing, "x,3,2,0,1,0");
  assert.equal(c2.voicing, "x,3,2,0,1,0");
  assert.equal(c1.voicing_printed, "x,3,5,5,5,3");
  assert.equal(c1.observation_id, "obs-c1");
  assert.deepEqual(app.state.doc._meta, { extraction_sources: { src1: { type: "pdf" } } });

  // Blank or all-x clears voicing cleanly
  app.rowFor("G7", "3,2,0,0,0,1").querySelector("[data-sel]").click();
  app.rowFor("Am", "x,0,2,2,1,0").querySelector("[data-sel]").click();
  app.get("dMergeBtn").click();
  app.get("dMergeName").input("G6");
  app.get("dMergeVoicing").input("x,x,x,x,x,x");
  app.get("dMergeApply").click();
  const g7 = app.state.doc.songs[0].sections[0].bars[1][0];
  assert.equal(g7.chord, "G6");
  assert.equal("voicing" in g7, false);
});

test(".dprint and single-group .apply prune stale keys from state.dictSel", () => {
  const app = createDictHarness();
  app.rowFor("C", "x,3,2,0,1,0").querySelector("[data-sel]").click();
  app.rowFor("G7", "3,2,0,0,0,1").querySelector("[data-sel]").click();
  app.rowFor("Am", "x,0,2,2,1,0").querySelector("[data-sel]").click();
  assert.equal(app.state.dictSel.size, 3);

  // .dprint changes "C x,3,2,0,1,0" -> "C x,3,5,5,5,3", pruning old key from dictSel
  app.rowFor("C", "x,3,2,0,1,0").querySelector(".dprint").click();
  assert.equal(app.state.dictSel.has("C x,3,2,0,1,0"), false);
  assert.equal(app.state.dictSel.size, 2);
  assert.equal(app.get("dMergeBtn") !== null, true);

  // Single-group .apply changes "G7 3,2,0,0,0,1" -> "G7 3,2,0,0,3,3", pruning old key and closing merge bar (< 2)
  app.rowFor("G7", "3,2,0,0,0,1").querySelector(".dhead").click();
  const dedit = app.rowFor("G7", "3,2,0,0,0,1").children.find((c) => c.className === "dedit");
  app.setEditorFretboard([3, 2, 0, 0, 3, 3]);
  dedit.querySelector(".apply").click();
  assert.equal(app.state.dictSel.has("G7 3,2,0,0,0,1"), false);
  assert.equal(app.state.dictSel.size, 1);
  assert.equal(app.state.dictMergeOpen, false);
});

test("merge form preserves user-typed #dMergeName/#dMergeVoicing (even blank) across re-renders and resets on close", () => {
  const app = createDictHarness();
  app.rowFor("C", "x,3,2,0,1,0").querySelector("[data-sel]").click();
  app.rowFor("C", "x,3,5,5,5,3").querySelector("[data-sel]").click();
  app.get("dMergeBtn").click();

  app.get("dMergeName").input("Cmaj7");
  app.get("dMergeVoicing").input(""); // intentionally cleared

  // Checkbox toggle re-renders dict: user values preserved
  app.rowFor("G7", "3,2,0,0,0,1").querySelector("[data-sel]").click();
  assert.equal(app.get("dMergeName").value, "Cmaj7");
  assert.equal(app.get("dMergeVoicing").value, "");

  // Sort toggle re-renders dict: user values preserved
  app.sortButtons()[1].click();
  assert.equal(app.get("dMergeName").value, "Cmaj7");
  assert.equal(app.get("dMergeVoicing").value, "");

  // Row editor toggle re-renders dict: user values preserved
  app.rowFor("Am", "x,0,2,2,1,0").querySelector(".dhead").click();
  assert.equal(app.get("dMergeName").value, "Cmaj7");
  assert.equal(app.get("dMergeVoicing").value, "");

  // Cancel resets draft so reopening Merge re-populates from largest
  app.get("dMergeCancel").click();
  assert.equal(app.state.dictMergeOpen, false);
  app.get("dMergeBtn").click();
  assert.equal(app.get("dMergeName").value, "C");
  assert.equal(app.get("dMergeVoicing").value, "x,3,2,0,1,0");

  // Unchecking below 2 resets draft too
  app.get("dMergeName").input("Cadd9");
  app.rowFor("C", "x,3,2,0,1,0").querySelector("[data-sel]").click();
  app.rowFor("C", "x,3,5,5,5,3").querySelector("[data-sel]").click();
  assert.equal(app.state.dictMergeOpen, false);
  app.rowFor("C", "x,3,2,0,1,0").querySelector("[data-sel]").click();
  app.get("dMergeBtn").click();
  assert.equal(app.get("dMergeName").value, "C");
  assert.equal(app.get("dMergeVoicing").value, "x,3,2,0,1,0");

  // Simulating loadSong() resetting state.dictMergeOpen = false resets draft
  app.get("dMergeName").input("DraftName");
  app.state.dictMergeOpen = false;
  app.renderDict();
  app.get("dMergeBtn").click();
  assert.equal(app.get("dMergeName").value, "C");

  // Clear button resets selection and draft
  app.get("dMergeName").input("DraftName2");
  app.get("dClearSel").click();
  assert.equal(app.state.dictSel.size, 0);
  assert.equal(app.state.dictMergeOpen, false);
});

test("dictionary filters, search and occurrence chips expose the affected entries", () => {
  const app = createDictHarness();
  const filter = (label) => app.root.children.find((node) => node.className === "dict-filters")
    .children.find((node) => node.textContent === label).click();
  filter("Duplicate names");
  assert.equal(app.rows().length, 2);
  assert.ok(app.rows().every((row) => /class="dexpand dnm"[^>]*>C<\/button>/.test(row.innerHTML)));
  filter("Mismatches");
  assert.equal(app.rows().length, 1);
  assert.match(app.rows()[0].innerHTML, /G7/);
  filter("Print diffs");
  assert.equal(app.rows().length, 1);
  const occurrences = app.rows()[0].children.find((node) => node.className === "dict-occurrences");
  assert.equal(occurrences.children[1].textContent, "Sec 1 · b.1 · #1");
  occurrences.children[1].click();
  assert.deepEqual({ ...app.jumped() }, { si: 0, bi: 0, ei: 0 });
  filter("All");
  app.root.children.find((node) => node.className === "dict-filters").children
    .find((node) => node.className === "dict-search").input("Am");
  assert.equal(app.rows().length, 1);
  assert.match(app.rows()[0].innerHTML, /Am/);
});

test("conflicting prints are visible and uniform print apply leaves unaudited occurrences alone", () => {
  const c = { chord: "C", voicing: "x,3,2,0,1,0" };
  const initialDoc = { songs: [{ sections: [{ bars: [[
    { ...c, voicing_printed: "x,3,5,5,5,3" },
    { ...c, voicing_printed: "x,3,2,0,1,0" },
    { ...c },
  ]] }] }] };
  const app = createDictHarness({ initialDoc });
  assert.match(app.rows()[0].innerHTML, /2 conflicting prints/);
  assert.equal(app.rows()[0].querySelector(".dprint"), null);
  delete initialDoc.songs[0].sections[0].bars[0][1].voicing_printed;
  app.renderDict();
  assert.match(app.rows()[0].innerHTML, /1× · 2 unprinted unchanged/);
  app.rows()[0].querySelector(".dprint").click();
  assert.equal(app.undoCount(), 1);
  assert.equal(initialDoc.songs[0].sections[0].bars[0][0].voicing, "x,3,5,5,5,3");
  assert.equal(initialDoc.songs[0].sections[0].bars[0][1].voicing, c.voicing);
  assert.equal(initialDoc.songs[0].sections[0].bars[0][2].voicing, c.voicing);
  assert.match(app.root.children.find((node) => node.role === "status").textContent, /1 occurrences; 2 unprinted unchanged.*Undo/);
});
