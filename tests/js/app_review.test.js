// Pure presentation-contract tests for the whole-song Review tab.
// Run with: node --test tests/js/
const { test } = require("node:test");
const assert = require("node:assert/strict");

const ReviewUI = require("../../scripts/qa_static/app_review.js");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("rows always expose the six field labels in workflow order", () => {
  const rows = ReviewUI.rows({ fields: {} });
  assert.deepEqual(rows.map((row) => row.label), [
    "Structure",
    "Chord names",
    "Lyrics",
    "Editorial voicings",
    "Printed diagrams",
    "Key",
  ]);
});

test("rows preserve stale and reviewer evidence returned by the server", () => {
  const rows = ReviewUI.rows({
    fields: {
      lyrics: {
        status: "stale",
        reviewer: "AS",
        evidence: "page 4",
      },
    },
  });
  const lyrics = rows.find((row) => row.field === "lyrics");
  assert.equal(lyrics.statusLabel, "Stale — values changed");
  assert.equal(lyrics.reviewer, "AS");
  assert.equal(lyrics.evidence, "page 4");
});

test("unknown server status is displayed as invalid, never verified", () => {
  const lyrics = ReviewUI.rows({ fields: { lyrics: { status: "done" } } })
    .find((row) => row.field === "lyrics");
  assert.equal(lyrics.status, "invalid");
  assert.equal(lyrics.statusLabel, "Invalid review record");
});

test("recording applies the returned document through undo and dirty state", async () => {
  const original = { document: { title: "T" }, songs: [{ sections: [] }] };
  const reviewed = { ...original, _meta: { review: { version: 1, fields: {} } } };
  const elements = {
    reviewRecord: { disabled: false },
    reviewMsg: { textContent: "" },
    reviewField: { value: "lyrics" },
    reviewStatus: { value: "in_progress" },
    reviewReviewer: { value: "AS" },
    reviewEvidence: { value: "page 4" },
    reviewStatusBody: { innerHTML: "" },
  };
  global.state = { doc: original };
  global.$ = (id) => elements[id];
  global.esc = (value) => String(value);
  global.api = async (_path, options) => {
    const payload = JSON.parse(options.body);
    assert.deepEqual(payload.doc, original);
    assert.equal(payload.field, "lyrics");
    return { ok: true, doc: reviewed, review: { fields: {} } };
  };
  let undoDoc = null;
  global.pushUndo = () => { undoDoc = global.state.doc; };
  global.markDirty = () => { global.state.dirty = true; };
  global.renderProvenance = () => {};

  await ReviewUI.recordSelected();

  assert.equal(undoDoc, original);
  assert.equal(global.state.doc, reviewed);
  assert.equal(global.state.dirty, true);
  assert.match(elements.reviewMsg.textContent, /Save song/);
  for (const name of ["state", "$", "esc", "api", "pushUndo", "markDirty", "renderProvenance"]) {
    delete global[name];
  }
});

test("deferred record response never replaces an intervening in-place edit", async () => {
  const pending = deferred();
  const doc = {
    document: { title: "T" },
    songs: [{ sections: [{ bars: [[{ chord: "C" }]] }] }],
  };
  const staleResponse = {
    document: { title: "T" },
    songs: [{ sections: [{ bars: [[{ chord: "C" }]] }] }],
    _meta: { review: { version: 1, fields: {} } },
  };
  const elements = {
    reviewRecord: { disabled: false },
    reviewMsg: { textContent: "" },
    reviewField: { value: "chords" },
    reviewStatus: { value: "verified" },
    reviewReviewer: { value: "AS" },
    reviewEvidence: { value: "page 1" },
    reviewStatusBody: { innerHTML: "" },
  };
  global.state = { doc };
  global.$ = (id) => elements[id];
  global.esc = (value) => String(value);
  let requests = 0;
  global.api = async () => {
    requests += 1;
    if (requests === 1) return pending.promise;
    return { ok: true, review: { fields: {} } };
  };
  let undos = 0;
  global.pushUndo = () => { undos += 1; };
  global.markDirty = () => {};
  global.renderProvenance = () => {};

  const recording = ReviewUI.recordSelected();
  doc.songs[0].sections[0].bars[0][0].chord = "Dm";
  pending.resolve({ ok: true, doc: staleResponse, review: { fields: {} } });
  await recording;
  await new Promise((done) => setImmediate(done));

  assert.equal(global.state.doc, doc);
  assert.equal(global.state.doc.songs[0].sections[0].bars[0][0].chord, "Dm");
  assert.equal(undos, 0);
  assert.equal(requests, 2); // stale response discarded, current summary requested
  for (const name of ["state", "$", "esc", "api", "pushUndo", "markDirty", "renderProvenance"]) {
    delete global[name];
  }
});

test("deferred summary response is discarded and recomputed after an in-place edit", async () => {
  const pending = deferred();
  const doc = {
    document: { title: "T" },
    songs: [{ sections: [{ bars: [[{ chord: "C" }]] }] }],
  };
  const elements = {
    reviewMsg: { textContent: "" },
    reviewStatusBody: { innerHTML: "untouched" },
  };
  global.state = { doc };
  global.$ = (id) => elements[id];
  global.esc = (value) => String(value);
  let requests = 0;
  global.api = async () => {
    requests += 1;
    if (requests === 1) return pending.promise;
    return {
      ok: true,
      review: { fields: { chords: { status: "in_progress", reviewer: "Fresh" } } },
    };
  };

  const refreshing = ReviewUI.refresh();
  doc.songs[0].sections[0].bars[0][0].chord = "Dm";
  pending.resolve({
    ok: true,
    review: { fields: { chords: { status: "verified", reviewer: "Stale" } } },
  });
  await refreshing;
  await new Promise((done) => setImmediate(done));

  assert.equal(requests, 2);
  assert.match(elements.reviewStatusBody.innerHTML, /Fresh/);
  assert.doesNotMatch(elements.reviewStatusBody.innerHTML, /Stale/);
  for (const name of ["state", "$", "esc", "api"]) delete global[name];
});
