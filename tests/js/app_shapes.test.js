// Focused contracts for the library Shapes workspace.
// Run with: node --test tests/js/
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const Shapes = require("../../scripts/qa_static/app_shapes.js");

test("single-album crops backfill from distinct songs without duplicate occurrences", () => {
  const rows = [
    { id: "a1", album: "A", file: "one.json" },
    { id: "a2", album: "A", file: "one.json" },
    { id: "a3", album: "A", file: "two.json" },
    { id: "a4", album: "A", file: "three.json" },
  ];
  assert.deepEqual(Shapes.representativeShapeOccurrences(rows).map((row) => row.id), ["a1", "a3", "a4"]);
});

test("batch undo describes its target and cancellation never sends a write", async (t) => {
  const previous = { ...Shapes.shapesUI };
  const prompts = [], requests = [];
  t.after(() => {
    Object.assign(Shapes.shapesUI, previous);
    delete global.confirm; delete global.api; delete global.shapeWritesReady;
  });
  global.confirm = (text) => { prompts.push(text); return false; };
  global.api = async (path) => { requests.push(path); };
  global.shapeWritesReady = () => true;
  Object.assign(Shapes.shapesUI, {
    container: null, writePending: false, restoredBatch: false,
    latestBatch: { id: "batch", voicing: "x,3,2,0,1,0", entries: 5, songs: 2, appliedAt: "2026-11-27T10:00:00Z", files: [] },
  });
  await Shapes.undoLatestShapeBatch();
  assert.match(prompts[0], /x,3,2,0,1,0 \(5 entries in 2 songs\)/);
  assert.match(prompts[0], /Applied/);
  Shapes.shapesUI.latestBatch.songs = 1;
  Shapes.shapesUI.restoredBatch = true;
  await Shapes.undoLatestShapeBatch();
  assert.equal(prompts.length, 2);
  assert.deepEqual(requests, []);
});

test("shape cards expose the inspected group and crop dialog uses occurrence evidence", (t) => {
  const previous = { ...Shapes.shapesUI };
  let shown = false;
  const elements = {
    shapeResults: {}, shapeCropTitle: {}, shapeCropImage: {},
    shapeCropDialog: { showModal() { shown = true; } },
  };
  global.$ = (id) => elements[id];
  t.after(() => { Object.assign(Shapes.shapesUI, previous); delete global.$; });
  Object.assign(Shapes.shapesUI, {
    page: 1, groups: [{ id: "one", voicing: "x,3,2,0,1,0" }, { id: "two" }],
    detail: { id: "one", occurrences: [{ id: "crop/1", title: "Fixture", file: "one.json" }] },
  });
  Shapes.renderShapeResults();
  assert.match(elements.shapeResults.innerHTML, /shape-result-card active/);
  assert.match(elements.shapeResults.innerHTML, /data-shape-open="one" aria-current="true"/);
  assert.doesNotMatch(elements.shapeResults.innerHTML, /data-shape-open="two" aria-current/);
  Shapes.openShapeCrop("crop/1");
  assert.equal(shown, true);
  assert.equal(elements.shapeCropImage.src, "/api/shapes/crop/crop%2F1");
  assert.match(elements.shapeCropTitle.textContent, /Fixture/);
});

test("shape status filters are sent to the server", () => {
  Shapes.shapesUI.filter = "unresolved";
  assert.match(Shapes.shapeListUrl(), /filter=unresolved/);
  Shapes.shapesUI.filter = "";
});

test("dirty song warning names the song and disables batch changes; similar groups remain inspectable", (t) => {
  const previous = { ...Shapes.shapesUI };
  const undo = {}, elements = {
    shapeDetail: {}, shapeDirtyWarning: {}, shapeDirtyText: {}, shapeApply: {},
  };
  global.$ = (id) => elements[id];
  global.state = { dirty: true, doc: { songs: [{ title: "Fixture song" }] } };
  t.after(() => { Object.assign(Shapes.shapesUI, previous); delete global.$; delete global.state; });
  const item = { id: "one", editable: true, album: "A", file: "one.json", editorial: "x,3,2,0,3,0" };
  Object.assign(Shapes.shapesUI, {
    listPending: false, detailPending: false, writePending: false,
    container: { querySelector: () => null, querySelectorAll: (query) => query === "[data-shape-undo]" ? [undo] : [] },
    detail: { voicing: "x,3,2,0,1,0", occurrences: [item], similar: [{ id: "similar", voicing: "x,3,2,0,3,0" }] },
    targetVoicing: "x,3,2,0,1,0", targetName: "", selected: new Set(["one"]),
    latestBatch: { id: "batch", voicing: "x,3,2,0,1,0", entries: 1, songs: 1 },
  });
  Shapes.renderShapeDetail();
  Shapes.syncShapeControls();
  assert.match(elements.shapeDetail.innerHTML, /data-shape-open="similar"/);
  assert.equal(elements.shapeDirtyWarning.hidden, false);
  assert.match(elements.shapeDirtyText.textContent, /Unsaved edits in Fixture song/);
  assert.equal(elements.shapeApply.disabled, true);
  assert.equal(undo.disabled, true);
  global.state.dirty = false;
  Shapes.syncShapeControls();
  assert.equal(elements.shapeDirtyWarning.hidden, true);
  assert.equal(elements.shapeApply.disabled, false);
  assert.equal(elements.shapeApply.textContent, "Apply to 1 occurrences (1 songs)");
  assert.equal(undo.disabled, false);
});

test("shape heading uses printed identity instead of an arbitrary chart name", () => {
  assert.equal(Shapes.shapeTitle({
    name: "A13-9", labels: ["Bm7/F#"], pattern: "MFFFFM", voicing: "x,2,4,2,3,x",
  }), "x,2,4,2,3,x");
  assert.equal(Shapes.shapeTitle({ name: "A13-9", labels: ["Bm7/F#"], pattern: "MFFFFM" }), "MFFFFM");
});

test("shape preview names muted, open, and relative fret columns per string", () => {
  const group = {
    pattern: "MFOFFM",
    columns: [null, 1, null, 2, 3, null],
    voicing: "x,3,0,2,4,x",
  };

  const columns = Shapes.normalizeShapeColumns(group);
  assert.deepEqual(columns.map((column) => column.string),
    ["low E", "A", "D", "G", "B", "high E"]);
  const html = Shapes.renderShapeVoicing(group);
  assert.match(html, /low E<\/th><td>muted<\/td><td>muted/);
  assert.match(html, /D<\/th><td>open<\/td><td>open/);
  assert.match(html, /A<\/th><td>column 2<\/td><td>3/);
});

test("selection eligibility follows the effective target, not the old detected difference", () => {
  const detected = "x,3,2,0,1,0";
  const corrected = "x,3,2,0,3,0";
  assert.equal(Shapes.isSelectableShapeOccurrence({ editable: true, editorial: detected }, corrected), true);
  assert.equal(Shapes.isSelectableShapeOccurrence({ editable: false, editorial: detected }, corrected), false);
  assert.equal(Shapes.isSelectableShapeOccurrence({ editable: true, editorial: corrected }, corrected), false);
  assert.equal(Shapes.isSelectableShapeOccurrence({ editable: true, editorial: detected }, "bad"), false);
});

test("effective proposal prefers the latest correction while preserving detected scan data", () => {
  const group = { voicing: "x,3,2,0,1,0", correction: "x,3,2,0,3,0" };
  assert.equal(Shapes.shapeEffectiveVoicing(group), "x,3,2,0,3,0");
  assert.equal(group.voicing, "x,3,2,0,1,0");
  assert.equal(Shapes.shapeEffectiveVoicing({ voicing: group.voicing }), group.voicing);
  assert.equal(Shapes.shapeEffectiveVoicing({ correction: group.correction }), "");
});

test("current-equals-scanner rows preview and request a changed manual target", () => {
  const current = "x,3,2,0,1,0";
  const target = "x,3,2,0,3,0";
  Object.assign(Shapes.shapesUI, {
    detail: { voicing: current }, targetVoicing: target, selected: new Set(["occ-1"]), container: null,
  });
  const item = { id: "occ-1", editable: true, editorial: current, title: "Song", file: "song.json" };
  const html = Shapes.renderShapeOccurrence(item);
  assert.match(html, /data-shape-select="occ-1"/);
  assert.match(html, /<span>Current fingering<\/span>/);
  assert.match(html, /<span>Target fingering<\/span>/);
  assert.match(html, /shape-changed[^>]*aria-label="B: 1"[^>]*title="B: 1"[^>]*>1<\/span>/);
  assert.match(html, /shape-changed[^>]*aria-label="B: 3"[^>]*title="B: 3"[^>]*>3<\/span>/);
  assert.deepEqual(Shapes.shapeApplyPayload([item]), {
    selected: ["occ-1"], voicing: target,
  });
});

test("apply posts the explicit occurrence IDs and effective manual voicing", async () => {
  const calls = [];
  const storageDescriptor = Object.getOwnPropertyDescriptor(global, "localStorage");
  Object.defineProperty(global, "localStorage", {
    value: { setItem() {}, removeItem() {} }, configurable: true,
  });
  global.api = async (path, options) => {
    calls.push({ path, options });
    return { ok: true, batch_id: "batch-1", entries: 1, songs: 1, files: [] };
  };
  global.shapeWritesReady = () => true;
  const item = {
    id: "occ-apply", editable: true, editorial: "x,3,2,0,1,0",
    album: "Album", file: "song.json",
  };
  global.window = { ChordNaming: {
    validateName: () => ({ valid: true }), suggestNames: () => [], nameMatchesVoicing: () => true,
  } };
  Object.assign(Shapes.shapesUI, {
    container: null, detail: { id: "shape-1", voicing: "x,3,2,0,1,0", occurrences: [item] },
    targetVoicing: "x,3,2,0,3,0", targetName: "Cmaj7",
    selected: new Set([item.id]), writePending: false,
  });

  await Shapes.applySelectedShapeOccurrences();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/shapes/shape-1/apply");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    selected: ["occ-apply"], voicing: "x,3,2,0,3,0", chord: "Cmaj7",
  });
  assert.equal(Shapes.shapesUI.latestBatch.entries, 1);
  assert.equal(Shapes.shapesUI.latestBatch.songs, 1);
  assert.equal(Shapes.shapesUI.latestBatch.voicing, "x,3,2,0,3,0");
  assert.equal(Shapes.shapesUI.latestBatch.chord, "Cmaj7");
  assert.ok(Date.parse(Shapes.shapesUI.latestBatch.appliedAt));
  delete global.api;
  delete global.shapeWritesReady;
  delete global.window;
  if (storageDescriptor) Object.defineProperty(global, "localStorage", storageDescriptor);
  else delete global.localStorage;
  Object.assign(Shapes.shapesUI, {
    detail: null, targetVoicing: "", targetName: "", selected: new Set(), latestBatch: null,
  });
});

test("blank name retains each exact label while an explicit name enables name-only rows", () => {
  global.window = { ChordNaming: {
    validateName: (name) => ({ valid: name !== "%" }), suggestNames: () => [],
    nameMatchesVoicing: () => true,
  } };
  const voicing = "x,2,4,2,3,x";
  const item = { id: "name-only", editable: true, editorial: voicing, label: "Bm7/F#" };

  Object.assign(Shapes.shapesUI, { targetVoicing: voicing, targetName: "" });
  assert.equal(Shapes.shapeTargetLabel(item), "Bm7/F#");
  assert.equal(Shapes.isSelectableShapeOccurrence(item, voicing, ""), false);
  assert.deepEqual(Shapes.shapeApplyPayload([item], voicing, ""), {
    selected: ["name-only"], voicing,
  });

  assert.equal(Shapes.isSelectableShapeOccurrence(item, voicing, "Bm7"), true);
  assert.equal(Shapes.shapeOccurrenceNeedsChange(item, voicing, "Bm7"), true);
  assert.deepEqual(Shapes.shapeApplyPayload([item], voicing, "Bm7"), {
    selected: ["name-only"], voicing, chord: "Bm7",
  });
  delete global.window;
  Shapes.shapesUI.targetName = "";
});

test("definite retained-label conflicts are protected but unknown compatibility is allowed", () => {
  global.window = { ChordNaming: {
    validateName: () => ({ valid: true }), suggestNames: () => [],
    nameMatchesVoicing: (name) => name === "A13-9" ? false : null,
  } };
  const target = "x,2,4,2,3,x";
  const conflict = {
    id: "conflict", editable: true, editorial: "x,2,4,2,2,x", label: "A13-9",
    title: "Exception", file: "exception.json", album: "Book",
  };
  const unknown = { ...conflict, id: "unknown", label: "Bm7/F#" };
  Object.assign(Shapes.shapesUI, { targetVoicing: target, targetName: "" });

  assert.equal(Shapes.isSelectableShapeOccurrence(conflict, target, ""), false);
  assert.equal(Shapes.isSelectableShapeOccurrence(unknown, target, ""), true);
  const html = Shapes.renderShapeOccurrence(conflict);
  assert.doesNotMatch(html, /data-shape-select=/);
  assert.match(html, /conflicts with retained chord label “A13-9”/);
  assert.match(html, /Jump to song/);
  delete global.window;
  Shapes.shapesUI.targetName = "";
});

test("invalid percent and explicit name-voicing conflicts block requests", async () => {
  const calls = [];
  global.api = async (...args) => { calls.push(args); return { ok: true }; };
  global.shapeWritesReady = () => true;
  global.window = { ChordNaming: {
    validateName: (name) => ({ valid: name !== "Bad" && name !== "%" }), suggestNames: () => [],
    nameMatchesVoicing: (name) => name === "C" ? false : true,
  } };
  const item = {
    id: "blocked", editable: true, editorial: "x,3,2,0,1,0", label: "Am",
    album: "Album", file: "song.json",
  };
  Object.assign(Shapes.shapesUI, {
    container: null, detail: { id: "shape-1", voicing: item.editorial, occurrences: [item] },
    targetVoicing: "x,3,2,0,3,0", targetName: "%", selected: new Set([item.id]), writePending: false,
  });
  assert.equal(Shapes.shapeNameValidation().valid, false);
  await Shapes.applySelectedShapeOccurrences();
  assert.equal(calls.length, 0);

  Shapes.shapesUI.targetName = "C";
  assert.equal(Shapes.shapeNameValidation().valid, true);
  await Shapes.applySelectedShapeOccurrences();
  assert.equal(calls.length, 0);

  delete global.api;
  delete global.shapeWritesReady;
  delete global.window;
  Object.assign(Shapes.shapesUI, {
    detail: null, targetVoicing: "", targetName: "", selected: new Set(), writePending: false,
  });
});

test("name and voicing proposals clear selection independently", () => {
  const detected = "x,3,2,0,1,0";
  Object.assign(Shapes.shapesUI, {
    detail: { voicing: detected }, targetVoicing: detected, targetName: "",
    selected: new Set(["name-change"]), container: null,
  });
  assert.equal(Shapes.setShapeNameProposal("Am", { announce: false }), true);
  assert.equal(Shapes.shapeTargetName(), "Am");
  assert.equal(Shapes.shapesUI.selected.size, 0);
  Shapes.shapesUI.selected.add("voicing-change");
  assert.equal(Shapes.setShapeProposal("x,3,2,0,3,0", { announce: false }), true);
  assert.equal(Shapes.shapeTargetName(), "Am");
  assert.equal(Shapes.shapesUI.selected.size, 0);
  Object.assign(Shapes.shapesUI, { detail: null, targetVoicing: "", targetName: "", selected: new Set() });
});

test("invalid edits stay inert and resetting restores the detected target", () => {
  const detected = "x,3,2,0,1,0";
  Object.assign(Shapes.shapesUI, {
    detail: { voicing: detected }, targetVoicing: detected,
    selected: new Set(["keep-until-valid-change"]), container: null, fretboard: null,
  });
  assert.equal(Shapes.normalizeShapeVoicing("x,3,2,0,25,0"), "");
  assert.equal(Shapes.setShapeProposal("x,3,2,0,25,0", { announce: false }), false);
  assert.equal(Shapes.shapeTargetVoicing(), detected);
  assert.deepEqual([...Shapes.shapesUI.selected], ["keep-until-valid-change"]);

  assert.equal(Shapes.setShapeProposal("x,3,2,0,3,0", { announce: false }), true);
  assert.equal(Shapes.shapeTargetVoicing(), "x,3,2,0,3,0");
  assert.equal(Shapes.shapesUI.selected.size, 0);
  Shapes.shapesUI.selected.add("will-clear-on-reset");
  assert.equal(Shapes.resetShapeProposal(), true);
  assert.equal(Shapes.shapeTargetVoicing(), detected);
  assert.equal(Shapes.shapesUI.selected.size, 0);
});

test("an explicit zero count does not fall back to another quantity", () => {
  assert.equal(Shapes.shapeCount(0), 0);
  assert.equal(Shapes.shapeCount([]), 0);
  assert.equal(Shapes.shapeDisagreementCount({ disagreements: 0, matches: 12 }), 0);
});

test("representative evidence favors different albums", () => {
  const rows = [
    { id: "a1", album: "A" }, { id: "a2", album: "A" },
    { id: "b1", album: "B" }, { id: "c1", album: "C" }, { id: "d1", album: "D" },
  ];
  assert.deepEqual(Shapes.representativeShapeOccurrences(rows).map((row) => row.id),
    ["a1", "b1", "c1"]);
});

test("list URL encodes the server-side search, album, and page", () => {
  Object.assign(Shapes.shapesUI, { query: "Em9/G & song", album: "Álbum A", page: 3 });
  const url = new URL(Shapes.shapeListUrl(), "http://localhost");
  assert.equal(url.pathname, "/api/shapes");
  assert.equal(url.searchParams.get("q"), "Em9/G & song");
  assert.equal(url.searchParams.get("album"), "Álbum A");
  assert.equal(url.searchParams.get("page"), "3");
  Object.assign(Shapes.shapesUI, { query: "", album: "", page: 1 });
});

test("parent write readiness is authoritative", () => {
  let received;
  global.shapeWritesReady = (files) => { received = files; return false; };
  const files = [{ album: "A", file: "song.json" }];
  assert.equal(Shapes.shapeWritesAvailable(files), false);
  assert.equal(received, files);
  global.shapeWritesReady = () => true;
  assert.equal(Shapes.shapeWritesAvailable(files), true);
  delete global.shapeWritesReady;
});

test("preview escapes API-provided voicing content", () => {
  const html = Shapes.renderShapeVoicing({
    pattern: "FOOOOO", columns: [1, 0, 0, 0, 0, 0], voicing: "<img,0,0,0,0,0",
  });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test("basis labels and changed strings are human-readable", () => {
  assert.equal(Shapes.shapeBasisLabel("recorded_evidence"), "Recorded source link");
  assert.equal(Shapes.shapeBasisLabel("legacy_exact_count"), "Legacy reading-order match");
  const html = Shapes.renderOccurrenceFingering("0,2,x,0,3,2", "0,2,0,0,3,2");
  assert.match(html, /shape-changed[^>]*aria-label="D: muted"[^>]*title="D: muted"[^>]*>×<\/span>/);
});

test("unresolved base-fret shapes cannot enable checkboxes, chord-name inputs, or Apply", () => {
  global.window = { ChordNaming: {
    validateName: () => ({ valid: true }), suggestNames: () => [{ name: "Am" }],
    nameMatchesVoicing: () => true,
  } };
  const occ = {
    id: "unresolved-1", editable: true, editorial: "x,0,2,2,1,0",
    label: "Am", title: "Song", file: "song.json", album: "Book",
  };
  assert.equal(Shapes.isSelectableShapeOccurrence(occ, "", "C"), false);

  const elements = {
    shapeDetail: { innerHTML: "", scrollTop: 0 },
    shapeSelection: { innerHTML: "" },
    shapeApply: { disabled: false },
    shapeStatus: { textContent: "", dataset: {}, setAttribute() {} },
  };
  const selectAllBtn = { disabled: false };
  const container = {
    querySelector: (sel) => sel === "[data-shape-select-all]" ? selectAllBtn : null,
    querySelectorAll: () => [],
  };
  global.$ = (id) => elements[id];
  Object.assign(Shapes.shapesUI, {
    container,
    detail: { id: "g-unresolved", voicing: null, pattern: "MFFFFM", songs: 1, matches: 1, occurrences: [occ] },
    targetVoicing: "",
    targetName: "",
    selected: new Set(["unresolved-1"]),
    listPending: false,
    detailPending: false,
    writePending: false,
  });

  const nameHtml = Shapes.shapeNameControl(Shapes.shapesUI.detail);
  assert.doesNotMatch(nameHtml, /id="shapeChordName"/);
  assert.doesNotMatch(nameHtml, /data-shape-name-suggestion/);
  assert.match(nameHtml, /unavailable until the scan fingering is resolved/);
  assert.equal(Shapes.setShapeNameProposal("C", { announce: false }), false);
  assert.equal(Shapes.shapeTargetName(), "");

  Shapes.renderShapeDetail();
  assert.doesNotMatch(elements.shapeDetail.innerHTML, /id="shapeChordName"/);
  assert.doesNotMatch(elements.shapeDetail.innerHTML, /data-shape-select=/);
  assert.match(elements.shapeDetail.innerHTML, /Group fingering is unresolved; edit this occurrence in its song\./);
  assert.doesNotMatch(elements.shapeDetail.innerHTML, /already agree/);
  assert.equal(selectAllBtn.disabled, true);
  assert.equal(elements.shapeApply.disabled, true);

  delete global.$;
  delete global.window;
  Object.assign(Shapes.shapesUI, {
    container: null, detail: null, targetVoicing: "", targetName: "", selected: new Set(),
  });
});

test("occurrence voicings render spaced guitar pills and handle unresolved blank targets cleanly", () => {
  const html = Shapes.renderOccurrenceFingering("x,0,2,2,1,0", "x,0,2,2,1,0");
  assert.match(html, /aria-label="low E: muted" title="low E: muted">×<\/span> <span[^>]*aria-label="A: open" title="A: open">0<\/span>/);
  assert.match(html, /<span[^>]*aria-label="high E: open" title="high E: open">0<\/span>$/);
  assert.doesNotMatch(html, /shape-changed/);

  const blankTarget = Shapes.renderOccurrenceFingering("", "x,0,2,2,1,0");
  assert.equal(blankTarget, '<span class="shape-occurrence-string shape-unresolved">—</span>');
  assert.doesNotMatch(blankTarget, /shape-changed/);

  const vsBlankTarget = Shapes.renderOccurrenceFingering("x,0,2,2,1,0", "");
  assert.doesNotMatch(vsBlankTarget, /shape-changed/);
  assert.match(vsBlankTarget, />×<\/span>/);
});

test("proposal edits preserve compatible selections, checked state, and scrollTop while pruning incompatible ones", () => {
  global.window = { ChordNaming: {
    validateName: () => ({ valid: true }),
    suggestNames: () => [{ name: "C" }],
    nameMatchesVoicing: (label, voicing) => {
      if (label === "Am" && voicing.join(",") === "x,3,2,0,3,0") return false;
      if (label === "C" && voicing.join(",") === "x,3,2,0,1,0") return true;
      if (label === "F" && voicing.join(",") === "x,3,2,0,1,0") return false;
      return true;
    },
  } };
  const occKeep = {
    id: "keep", editable: true, editorial: "x,3,2,0,2,0", label: "C",
    album: "A", file: "keep.json", title: "Keep",
  };
  const occDropByName = {
    id: "drop-name", editable: true, editorial: "x,3,2,0,2,0", label: "F",
    album: "A", file: "drop.json", title: "Drop",
  };
  const occAlreadySame = {
    id: "same-after-voicing", editable: true, editorial: "x,3,2,0,3,0", label: "C",
    album: "A", file: "same.json", title: "Same",
  };
  const elements = {
    shapeOccurrenceList: { innerHTML: "", scrollTop: 145 },
    shapeDetail: { scrollTop: 80 },
    shapeSelection: { innerHTML: "" },
    shapeEffectiveVoicing: { textContent: "" },
    shapeApply: { disabled: false },
    shapeStatus: { textContent: "", dataset: {}, setAttribute() {} },
  };
  const container = {
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  global.$ = (id) => elements[id];
  Object.assign(Shapes.shapesUI, {
    container,
    detail: { id: "g1", voicing: "x,3,2,0,1,0", occurrences: [occKeep, occDropByName, occAlreadySame] },
    targetVoicing: "x,3,2,0,1,0",
    targetName: "",
    selected: new Set(["keep", "drop-name"]),
    listPending: false, detailPending: false, writePending: false,
  });

  // Changing targetName to "C" makes "drop-name" match if explicit name overrides retained label,
  // so test dropping via explicit incompatible name "F":
  Shapes.shapesUI.selected = new Set(["keep", "drop-name"]);
  // Add an occurrence that becomes incompatible with "C" by already agreeing (same voicing + same name):
  occAlreadySame.editorial = "x,3,2,0,1,0";
  occAlreadySame.label = "C";
  Shapes.shapesUI.selected = new Set(["keep", "same-after-voicing"]);
  assert.equal(Shapes.setShapeNameProposal("C", { announce: false, refreshControl: false }), true);
  assert.deepEqual([...Shapes.shapesUI.selected], ["keep"]);
  assert.equal(elements.shapeStatus.textContent, "1 selected occurrence became incompatible and was deselected.");
  assert.equal(elements.shapeOccurrenceList.scrollTop, 145);
  assert.equal(elements.shapeDetail.scrollTop, 80);
  assert.match(elements.shapeOccurrenceList.innerHTML, /data-shape-select="keep" checked/);

  // Changing voicing target to x,3,2,0,3,0 retains "keep" and prunes an occurrence whose editorial equals x,3,2,0,3,0
  occAlreadySame.editorial = "x,3,2,0,3,0";
  occAlreadySame.label = "Dm";
  Shapes.shapesUI.targetName = "";
  Shapes.shapesUI.selected = new Set(["keep", "same-after-voicing"]);
  assert.equal(Shapes.setShapeProposal("x,3,2,0,3,0", { announce: false }), true);
  assert.deepEqual([...Shapes.shapesUI.selected], ["keep"]);
  assert.equal(elements.shapeStatus.textContent, "1 selected occurrence became incompatible and was deselected.");
  assert.equal(elements.shapeOccurrenceList.scrollTop, 145);
  assert.match(elements.shapeOccurrenceList.innerHTML, /data-shape-select="keep" checked/);

  delete global.$;
  delete global.window;
  Object.assign(Shapes.shapesUI, {
    container: null, detail: null, targetVoicing: "", targetName: "", selected: new Set(),
  });
});

test("typing valid voicing in .fb-text updates target on input and blur-into-Apply does not wipe selection", async () => {
  const listeners = {};
  let fretboardSetCalls = 0;
  let applyCalls = 0;
  const fbInput = {
    value: "x,3,2,0,3,0",
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    focus() {},
    closest: (sel) => sel.includes(".fb-text") ? fbInput : null,
  };
  const elements = {
    shapeSearch: { addEventListener() {}, value: "", disabled: false },
    shapeAlbum: { addEventListener() {}, value: "", disabled: false },
    shapeOccurrenceList: { innerHTML: "", scrollTop: 32 },
    shapeDetail: { scrollTop: 0 },
    shapeSelection: { innerHTML: "" },
    shapeEffectiveVoicing: { textContent: "" },
    shapeApply: { disabled: false },
    shapeStatus: { textContent: "", dataset: {}, setAttribute() {} },
  };
  const container = {
    addEventListener(type, fn) { listeners[type] = fn; },
    querySelector: (sel) => sel.includes(".fb-text") ? fbInput : null,
    querySelectorAll: () => [],
  };
  global.$ = (id) => elements[id];
  global.api = async (_path, options) => {
    applyCalls += 1;
    assert.deepEqual(JSON.parse(options.body), { selected: ["occ-1"], voicing: "x,3,2,0,3,0" });
    return { ok: true, batch_id: "b2", entries: 1, songs: 1, files: [] };
  };
  global.shapeWritesReady = () => true;
  const occ = { id: "occ-1", editable: true, editorial: "x,3,2,0,1,0", album: "A", file: "s.json", title: "S" };
  Object.assign(Shapes.shapesUI, {
    container,
    detail: { id: "g1", voicing: "x,3,2,0,1,0", occurrences: [occ] },
    targetVoicing: "x,3,2,0,1,0",
    targetName: "",
    selected: new Set(["occ-1"]),
    fretboard: { set() { fretboardSetCalls += 1; } },
    listPending: false, detailPending: false, writePending: false,
  });

  Shapes.wireShapesWorkspace(container);
  listeners.input({ target: fbInput });
  assert.equal(Shapes.shapeTargetVoicing(), "x,3,2,0,3,0");
  assert.equal(fretboardSetCalls, 0);
  assert.equal(fbInput.attrs["aria-invalid"], "false");
  assert.deepEqual([...Shapes.shapesUI.selected], ["occ-1"]);
  assert.equal(elements.shapeApply.disabled, false);

  // Simulated blur -> change from fretboard.js keeps selection & Apply enabled
  listeners.change({ target: fbInput });
  assert.deepEqual([...Shapes.shapesUI.selected], ["occ-1"]);
  assert.equal(elements.shapeApply.disabled, false);

  await Shapes.applySelectedShapeOccurrences();
  assert.equal(applyCalls, 1);

  delete global.$;
  delete global.api;
  delete global.shapeWritesReady;
  Object.assign(Shapes.shapesUI, {
    container: null, detail: null, targetVoicing: "", targetName: "", selected: new Set(),
    fretboard: null, latestBatch: null, groups: [], loaded: false,
  });
});

test("Refresh index button, first-run indexing latency feedback, and renderShapes stale reload work cleanly", async () => {
  const apiPaths = [];
  const elements = {
    shapeSearch: { addEventListener() {}, value: "", disabled: false },
    shapeAlbum: { addEventListener() {}, value: "", innerHTML: "", disabled: false },
    shapeStatus: { textContent: "", dataset: {}, setAttribute() {} },
    shapeResults: { innerHTML: "" },
    shapePager: { innerHTML: "" },
    shapeDetail: { innerHTML: "" },
    shapeRefresh: { disabled: false },
  };
  let rootContainer;
  const makeContainer = () => ({
    dataset: {},
    innerHTML: "",
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  });
  rootContainer = makeContainer();
  elements.shapes = rootContainer;
  global.$ = (id) => elements[id];

  let resolveList;
  const listPromise = new Promise((resolve) => { resolveList = resolve; });
  global.api = async (path) => {
    apiPaths.push(path);
    if (path.startsWith("/api/shapes?")) return listPromise;
    return { id: "g1", voicing: "x,3,2,0,1,0", occurrences: [] };
  };

  Object.assign(Shapes.shapesUI, {
    container: null, groups: [], loaded: false, stale: false, detail: null,
    listPending: false, detailPending: false, writePending: false,
    listGeneration: 0, detailGeneration: 0, listTimer: null,
  });

  Shapes.ensureShapesWorkspace();
  assert.match(rootContainer.innerHTML, /id="shapeRefresh" data-shape-refresh>Refresh index<\/button>/);

  const loadPromise = Shapes.loadShapeGroups();
  assert.match(elements.shapeStatus.textContent, /Indexing library shapes \(first run may take 10–60s\)/);
  assert.match(elements.shapeResults.innerHTML, /Indexing library shapes \(first run may take 10–60s\)/);
  assert.equal(elements.shapeRefresh.disabled, true);
  assert.notEqual(Shapes.shapesUI.listTimer, null);

  resolveList({ groups: [{ id: "g1", voicing: "x,3,2,0,1,0", songs: 1, matches: 1 }], counts: { groups: 1 }, albums: [], page: 1, pages: 1 });
  assert.equal(await loadPromise, true);
  assert.equal(Shapes.shapesUI.loaded, true);
  assert.equal(Shapes.shapesUI.stale, false);
  assert.equal(Shapes.shapesUI.listTimer, null);
  assert.equal(elements.shapeRefresh.disabled, false);

  // Clicking Refresh index reloads groups and reopens active detail
  apiPaths.length = 0;
  global.api = async (path) => {
    apiPaths.push(path);
    if (path.startsWith("/api/shapes?")) {
      return { groups: [{ id: "g1", voicing: "x,3,2,0,1,0", songs: 1, matches: 1 }], counts: { groups: 1 }, albums: [], page: 1, pages: 1 };
    }
    return { id: "g1", voicing: "x,3,2,0,1,0", occurrences: [] };
  };
  Shapes.shapesUI.detail = { id: "g1", voicing: "x,3,2,0,1,0", occurrences: [] };
  const refreshBtn = { disabled: false };
  Shapes.handleShapesClick({ target: { closest: (sel) => sel === "[data-shape-refresh]" ? refreshBtn : null } });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(apiPaths[0], "/api/shapes?page=1");
  assert.equal(apiPaths[1], "/api/shapes/g1");

  // Stale invalidation triggers reload on renderShapes()
  apiPaths.length = 0;
  Shapes.shapesUI.loaded = false;
  Shapes.shapesUI.stale = true;
  Shapes.shapesUI.detail = null;
  Shapes.renderShapes();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(apiPaths, ["/api/shapes?page=1"]);

  delete global.$;
  delete global.api;
  Object.assign(Shapes.shapesUI, {
    container: null, detail: null, groups: [], loaded: false, stale: false,
    listPending: false, detailPending: false, writePending: false, listTimer: null,
  });
});

test("openShapesForEntry shows loading/error state in #shapeDetail and works without app_shapes.js", async () => {
  const source = fs.readFileSync(require.resolve("../../scripts/qa_static/app_views.js"), "utf8");

  // 1. Isolated context without app_shapes.js (no ReferenceError)
  const isolatedEls = {
    edErr: { textContent: "" },
    shapeDetail: { innerHTML: "Choose a shape" },
    bars: { classList: { toggle() {} } },
    chordReview: { classList: { toggle() {} } },
    chordReviewToggle: { classList: { toggle() {}, }, setAttribute() {}, disabled: false },
    flagCount: { classList: { toggle() {} } },
    editor: { classList: { toggle() {} } },
    lyrics: { classList: { toggle() {} } },
    review: { classList: { toggle() {} } },
    dict: { classList: { toggle() {} } },
    harmony: { classList: { toggle() {} } },
    preview: { classList: { toggle() {} } },
    json: { classList: { toggle() {} } },
    tabBars: { classList: { toggle() {} }, setAttribute() {} },
    tabLyrics: { classList: { toggle() {} }, setAttribute() {} },
    tabReview: { classList: { toggle() {} }, setAttribute() {} },
    tabDict: { classList: { toggle() {} }, setAttribute() {} },
    tabHarmony: { classList: { toggle() {} }, setAttribute() {} },
    tabPreview: { classList: { toggle() {} }, setAttribute() {} },
    tabJson: { classList: { toggle() {} }, setAttribute() {} },
  };
  const isolatedCtx = vm.createContext({
    state: { doc: { songs: [{}] }, album: "A", file: "s.json", songRevision: "rev1", dirty: false, activeView: "bars" },
    $: (id) => isolatedEls[id],
    applyLayoutToggles() {},
    renderShapes() {},
    esc: (v) => String(v),
    api: async () => ({ id: "g1" }),
    URLSearchParams,
    setInterval,
    clearInterval,
  });
  vm.runInContext(source, isolatedCtx);
  await vm.runInContext("openShapesForEntry(0, 1, 2)", isolatedCtx);
  assert.match(isolatedEls.shapeDetail.innerHTML, /Finding matching shape in library index/);

  // 2. Context with shapesUI verifying loading -> error handling and cleanup
  let resolveEntry;
  const entryPending = new Promise((r) => { resolveEntry = r; });
  const statuses = [];
  const withShapesEls = { ...isolatedEls, shapeDetail: { innerHTML: "Choose a shape" } };
  const withShapesCtx = vm.createContext({
    state: { doc: { songs: [{}] }, album: "A", file: "s.json", songRevision: "rev1", dirty: false, activeView: "bars" },
    shapesUI: { detailGeneration: 1, detailPending: false, detail: { id: "old" }, selected: new Set(["x"]) },
    $: (id) => withShapesEls[id],
    applyLayoutToggles() {},
    renderShapes() {},
    syncShapeControls() {},
    setShapeStatus: (msg, kind) => statuses.push({ msg, kind }),
    openShapeGroup: async () => true,
    esc: (v) => String(v),
    api: async () => entryPending,
    URLSearchParams,
    setInterval,
    clearInterval,
  });
  vm.runInContext(source, withShapesCtx);
  const run = vm.runInContext("openShapesForEntry(0, 1, 2)", withShapesCtx);
  assert.equal(withShapesCtx.shapesUI.detailGeneration, 2);
  assert.equal(withShapesCtx.shapesUI.detailPending, true);
  assert.equal(withShapesCtx.shapesUI.detail, null);
  assert.equal(withShapesCtx.shapesUI.selected.size, 0);
  assert.match(withShapesEls.shapeDetail.innerHTML, /Finding matching shape in library index/);

  resolveEntry({ error: "No matching shape" });
  await run;
  assert.equal(withShapesCtx.shapesUI.detailPending, false);
  assert.match(withShapesEls.shapeDetail.innerHTML, /shape-error.*No matching shape/);
  assert.deepEqual(statuses.at(-1), { msg: "No matching shape", kind: "error" });
});
