// Focused contracts for the library Shapes workspace.
// Run with: node --test tests/js/
const { test } = require("node:test");
const assert = require("node:assert/strict");

const Shapes = require("../../scripts/qa_static/app_shapes.js");

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
  assert.match(html, /shape-changed[^>]*title="B"[^>]*>1<\/span>/);
  assert.match(html, /shape-changed[^>]*title="B"[^>]*>3<\/span>/);
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

test("representative evidence uses at most one crop per album", () => {
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
  assert.match(html, /shape-changed[^>]*title="D"/);
  assert.match(html, />muted<\/span>/);
});
