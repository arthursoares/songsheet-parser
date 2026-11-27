// Pure presentation-contract tests for the whole-song Review tab.
// Run with: node --test tests/js/
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

const ReviewUI = require("../../scripts/qa_static/app_review.js");

test("source issues keep unpaired page counts visible without granting verification", () => {
  const issues = ReviewUI.sourceIssues({_meta:{diagram_diagnostics:{one:{record:{page:29,
    diagrams:[{},{}], eligible_observation_ids:["a"], page_eligible_observation_count:3}}}}});
  assert.equal(issues.length, 1);
  assert.match(issues[0], /Page 29/);
  assert.match(issues[0], /2 detected diagrams, 3 chord occurrences/);
  assert.match(issues[0], /needs review/);
  assert.deepEqual(ReviewUI.sourceIssues(null), []);
});

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

function installReviewDom({ field = "chords", reviewer = "AS" } = {}) {
  const elements = {
    reviewField: { value: field, disabled: false },
    reviewStatus: { value: "pending", disabled: false },
    reviewReviewer: { value: reviewer, disabled: false },
    reviewEvidence: { value: "", disabled: false },
    reviewRecord: { disabled: false },
    reviewMsg: { textContent: "" },
    reviewStatusBody: { innerHTML: "" },
    verificationChordProgress: { textContent: "" },
    reviewSourceIssues: { innerHTML: "", classList: { toggle() {}, add() {} } },
    reviewFlags: { innerHTML: "" },
    reviewDefaultEvidence: { value: "" },
    reviewBadge: { textContent: "", hidden: true },
    reviewDone: { hidden: true, disabled: false },
    reviewDoneWarning: { hidden: true, textContent: "" },
    reviewDetails: { open: false },
    statusSel: { value: "pending" },
  };
  for (const element of Object.values(elements)) {
    element.handlers = {};
    element.addEventListener = (event, handler) => { element.handlers[event] = handler; };
  }
  global.$ = (id) => elements[id];
  global.esc = (value) => String(value ?? "");
  global.entryCoords = () => [];
  global.chordReviewStatus = () => "pending";
  global.chordAt = () => ({});
  return elements;
}

function removeReviewDom() {
  for (const name of [
    "state", "$", "esc", "api", "pushUndo", "markDirty", "renderProvenance",
    "entryCoords", "chordReviewStatus", "chordAt",
    "localStorage", "save", "chordEditorHasDraft", "hasUnappliedJsonEdits",
    "scrollScanToPage", "toggleChordReview", "selectChordReviewEntry", "showView",
    "flushBlurCommittedInputs",
  ]) {
    delete global[name];
  }
}

test("render syncs reviewStatus and reviewEvidence per song without leaking across songs", async () => {
  const elements = installReviewDom({ field: "chords", reviewer: "AS" });
  const songA = {
    songs: [{ sections: [] }],
    _meta: {
      review: {
        version: 1,
        fields: {
          chords: { status: "verified", reviewer: "AS", evidence: "checked p.14" },
        },
      },
    },
  };
  const songB = { songs: [{ sections: [] }] };
  const songC = {
    songs: [{ sections: [] }],
    _meta: {
      review: {
        version: 1,
        fields: {
          chords: { status: "done", reviewer: "AS", evidence: "draft note" },
        },
      },
    },
  };
  global.api = async () => ({ ok: true, review: { fields: {} } });
  try {
    global.state = { doc: songA, flags: [] };
    ReviewUI.resetForDocument();
    ReviewUI.render();
    assert.equal(elements.reviewStatus.value, "verified");
    assert.equal(elements.reviewEvidence.value, "checked p.14");
    assert.equal(elements.reviewReviewer.value, "AS");

    // Simulate unsaved edit on Song A before switching to Song B.
    elements.reviewEvidence.value = "unsaved Song A evidence";
    elements.reviewStatus.value = "in_progress";

    global.state = { doc: songB, flags: [] };
    ReviewUI.resetForDocument();
    ReviewUI.render();
    assert.equal(elements.reviewStatus.value, "pending");
    assert.equal(elements.reviewEvidence.value, "");
    assert.equal(elements.reviewReviewer.value, "AS");

    // Invalid stored status falls back to "pending" while preserving stored evidence.
    global.state = { doc: songC, flags: [] };
    ReviewUI.render();
    assert.equal(elements.reviewStatus.value, "pending");
    assert.equal(elements.reviewEvidence.value, "draft note");
    await new Promise((done) => setImmediate(done));
  } finally {
    removeReviewDom();
  }
});

test("reviewer and default evidence persist across UI reloads, with storage optional", () => {
  const saved = new Map();
  global.localStorage = { getItem: (key) => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  try {
    let elements = installReviewDom();
    ReviewUI.wire();
    elements.reviewReviewer.value = "Arthur";
    elements.reviewReviewer.handlers.input();
    elements.reviewDefaultEvidence.value = "Checked against book scan";
    elements.reviewDefaultEvidence.handlers.input();
    elements = installReviewDom();
    ReviewUI.wire();
    assert.equal(elements.reviewReviewer.value, "Arthur");
    assert.equal(elements.reviewDefaultEvidence.value, "Checked against book scan");
    global.localStorage = { getItem() { throw Error("blocked"); }, setItem() { throw Error("blocked"); } };
    assert.doesNotThrow(() => ReviewUI.wire());
    assert.doesNotThrow(() => elements.reviewReviewer.handlers.input());
  } finally { removeReviewDom(); }
});

test("inline Verify records the clicked field with reviewer and default evidence, through undo", async () => {
  const elements = installReviewDom({ field: "chords", reviewer: "Arthur" });
  elements.reviewDefaultEvidence.value = "Checked against book scan";
  elements.reviewEvidence.value = "Only for chords";
  const original = { document: {}, songs: [{ sections: [] }] };
  global.state = { doc: original, flags: [] };
  const requests = [];
  global.api = async (_url, options) => {
    const payload = JSON.parse(options.body);
    requests.push(payload);
    return { ok: true, doc: { ...payload.doc, _meta: { review: { version: 1, fields: {
      [payload.field]: { status: payload.status, evidence: payload.evidence },
    } } } }, review: { fields: { [payload.field]: { status: "verified" } } } };
  };
  let beforeUndo;
  global.pushUndo = () => { beforeUndo = global.state.doc; };
  global.markDirty = () => { global.state.dirty = true; };
  global.renderProvenance = () => {};
  try {
    ReviewUI.wire();
    elements.reviewReviewer.value = "Arthur";
    elements.reviewDefaultEvidence.value = "Checked against book scan";
    const button = { dataset: { reviewAction: "verify", reviewField: "lyrics" } };
    elements.reviewStatusBody.handlers.click({ target: { closest: () => button } });
    await new Promise((done) => setImmediate(done));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].field, "lyrics");
    assert.equal(requests[0].status, "verified");
    assert.equal(requests[0].reviewer, "Arthur");
    assert.equal(requests[0].evidence, "Checked against book scan");
    assert.equal(beforeUndo, original);
    assert.equal(global.state.dirty, true);
    assert.equal((elements.reviewStatusBody.innerHTML.match(/>Verify ✓<\/button>/g) || []).length, 6);
    button.dataset.reviewAction = "edit";
    elements.reviewStatusBody.handlers.click({ target: { closest: () => button } });
    assert.equal(elements.reviewField.value, "lyrics");
    assert.equal(elements.reviewDetails.open, true);
    assert.equal(elements.reviewEvidence.value, "Checked against book scan");
  } finally { removeReviewDom(); }
});

test("timestamps render relative text and retain the exact ISO timestamp", async () => {
  const elements = installReviewDom();
  const timestamp = "2026-11-25T10:00:00Z";
  global.state = { doc: { document: {} }, flags: [] };
  global.api = async () => ({ ok: true, review: { fields: { key: { status: "verified", timestamp } } } });
  try {
    assert.equal(ReviewUI.relativeTimestamp(timestamp, Date.parse("2026-11-25T12:00:00Z")), "2h ago");
    await ReviewUI.refresh();
    assert.match(elements.reviewStatusBody.innerHTML, /<time datetime="2026-11-25T10:00:00Z" title="2026-11-25T10:00:00Z">/);
  } finally { removeReviewDom(); }
});

test("badges and Done bridge use current server evidence and retain normal save flow", async () => {
  const elements = installReviewDom();
  const fields = Object.fromEntries(Object.keys(ReviewUI.FIELD_LABELS).map((field) => [field, { status: "verified" }]));
  global.state = { doc: { document: { status: "done" } }, flags: [{ chord: "C" }] };
  global.api = async () => ({ ok: true, review: { fields } });
  let undos = 0, saves = 0;
  global.pushUndo = () => { undos += 1; };
  global.markDirty = () => { global.state.dirty = true; };
  global.save = async () => { saves += 1; };
  try {
    fields.key.status = "stale";
    await ReviewUI.refresh();
    assert.equal(elements.reviewBadge.textContent, "1 stale · 1 flags");
    assert.equal(elements.reviewDone.hidden, true);
    assert.equal(elements.reviewDoneWarning.hidden, false);
    assert.match(elements.reviewDoneWarning.textContent, /1 unverified fields \(1 stale\)/);
    await ReviewUI.markDoneAndSave();
    assert.equal(saves, 0);
    fields.key.status = "verified";
    global.state.flags = [];
    await ReviewUI.refresh();
    assert.equal(elements.reviewDone.hidden, false);
    assert.equal(elements.reviewDoneWarning.hidden, true);
    global.state.doc.document.status = "pending";
    ReviewUI.updateBridge();
    assert.equal(elements.reviewDone.hidden, true); // changed revision cannot reuse readiness
    global.chordEditorHasDraft = () => true;
    await ReviewUI.markDoneAndSave();
    assert.equal(saves, 0);
    global.chordEditorHasDraft = () => false;
    await ReviewUI.markDoneAndSave();
    assert.equal(saves, 1);
    assert.equal(undos, 1);
    assert.equal(global.state.doc.document.status, "done");
    assert.equal(global.state.dirty, true);
  } finally { removeReviewDom(); }
});

test("Done bridge rejects a changed document while verification is in flight", async () => {
  installReviewDom();
  const pending = deferred();
  const fields = Object.fromEntries(Object.keys(ReviewUI.FIELD_LABELS).map((field) => [field, { status: "verified" }]));
  global.state = { doc: { document: { status: "pending" } }, flags: [] };
  let calls = 0, saves = 0;
  global.api = async () => ++calls === 1 ? pending.promise : { ok: true, review: { fields: {} } };
  global.save = async () => { saves += 1; };
  try {
    const marking = ReviewUI.markDoneAndSave();
    global.state.doc.document.title = "Edited while waiting";
    pending.resolve({ ok: true, review: { fields } });
    await marking;
    await new Promise((done) => setImmediate(done));
    assert.equal(saves, 0);
    assert.equal(global.state.doc.document.status, "pending");
  } finally { removeReviewDom(); }
});

test("source page and chord progress actions use existing navigation helpers", () => {
  const elements = installReviewDom();
  global.state = { doc: {}, activeView: "review", flags: [] };
  let page, chordOpened = false;
  global.scrollScanToPage = (value) => { page = value; };
  global.toggleChordReview = () => { chordOpened = true; global.state.activeView = "chordReview"; };
  try {
    ReviewUI.wire();
    elements.reviewSourceIssues.handlers.click({ target: { closest: () => ({ dataset: { reviewPage: "29" } }) } });
    assert.equal(page, 29);
    elements.verificationChordProgress.handlers.click();
    assert.equal(chordOpened, true);
  } finally { removeReviewDom(); }
});

test("edits outside Verification refresh badges and coalesce synchronous changes", async () => {
  const elements = installReviewDom();
  global.state = { doc: { document: { title: "Before" } }, flags: [] };
  let calls = 0;
  global.api = async () => {
    calls += 1;
    return { ok: true, review: { fields: { key: { status: "stale" } } } };
  };
  try {
    ReviewUI.resetForDocument();
    ReviewUI.documentChanged();
    global.state.doc.document.title = "After";
    ReviewUI.documentChanged();
    await new Promise((done) => setImmediate(done));
    assert.equal(calls, 1);
    assert.equal(elements.reviewBadge.textContent, "1 stale");
    ReviewUI.documentChanged();
    await new Promise((done) => setImmediate(done));
    assert.equal(calls, 1); // unchanged revisions reuse the canonical summary
  } finally { removeReviewDom(); }
});

test("flagged rows show review and print differences with distinct guarded navigation", async () => {
  const elements = installReviewDom();
  const flag = { si: 0, bi: 1, ei: 0, chord: "C", label: "Verse", reason: "Print differs" };
  global.state = { doc: { document: {} }, flags: [flag], activeView: "review" };
  global.chordAt = () => ({ voicing: "x,3,2,0,1,0", voicing_printed: "x,3,2,0,1,3" });
  global.chordReviewStatus = () => "deferred";
  global.api = async () => ({ ok: true, review: { fields: {} } });
  global.document = { createElement() {
    return { children: [], handlers: {}, appendChild(child) { this.children.push(child); },
      addEventListener(event, handler) { this.handlers[event] = handler; } };
  } };
  elements.reviewFlagsTitle = { textContent: "" };
  elements.reviewFlags.children = [];
  elements.reviewFlags.appendChild = (row) => elements.reviewFlags.children.push(row);
  let selected, edited;
  global.toggleChordReview = () => {}; // draft guard refuses navigation
  global.selectChordReviewEntry = (coords) => { selected = coords; };
  global.jumpToFlag = (coords) => { edited = coords; };
  try {
    ReviewUI.render();
    const row = elements.reviewFlags.children[0];
    assert.equal(elements.reviewFlagsTitle.textContent, "Flagged chords (1)");
    assert.match(row.innerHTML, /deferred/);
    assert.match(row.innerHTML, /Print differs/);
    assert.match(row.innerHTML, /x,3,2,0,1,0/);
    row.children[0].handlers.click();
    assert.equal(selected, undefined);
    global.toggleChordReview = () => { global.state.activeView = "chordReview"; };
    row.children[0].handlers.click();
    assert.equal(selected, flag);
    row.children[1].handlers.click();
    assert.equal(edited, flag);
    await new Promise((done) => setImmediate(done));
  } finally {
    delete global.document;
    delete global.jumpToFlag;
    removeReviewDom();
  }
});

test("syncInputs updates reviewStatus and reviewEvidence when reviewField changes", () => {
  const elements = installReviewDom({ field: "structure", reviewer: "AS" });
  const doc = {
    songs: [{ sections: [] }],
    _meta: {
      review: {
        version: 1,
        fields: {
          structure: { status: "verified", evidence: "bars match p.1" },
          lyrics: { status: "in_progress", evidence: "verse 2 pending" },
        },
      },
    },
  };
  try {
    global.state = { doc, flags: [] };
    ReviewUI.resetForDocument();
    assert.equal(elements.reviewStatus.value, "verified");
    assert.equal(elements.reviewEvidence.value, "bars match p.1");

    elements.reviewEvidence.value = "unrecorded structure edit";
    elements.reviewField.value = "lyrics";
    ReviewUI.syncInputs();
    assert.equal(elements.reviewStatus.value, "in_progress");
    assert.equal(elements.reviewEvidence.value, "verse 2 pending");

    elements.reviewField.value = "chords";
    ReviewUI.syncInputs();
    assert.equal(elements.reviewStatus.value, "pending");
    assert.equal(elements.reviewEvidence.value, "");
  } finally {
    removeReviewDom();
  }
});

test("refresh paints a loading row while in flight and clears reviewStatusBody on error, !ok, and !state.doc", async () => {
  const elements = installReviewDom();
  let nextResponse;
  global.api = async () => nextResponse.promise;
  try {
    global.state = { doc: { songs: [{ sections: [] }] }, flags: [] };
    elements.reviewStatusBody.innerHTML = "<tr><td>Old Song Verified</td></tr>";

    nextResponse = deferred();
    const pendingOk = ReviewUI.refresh();
    assert.match(elements.reviewStatusBody.innerHTML, /Loading verification status/);
    assert.doesNotMatch(elements.reviewStatusBody.innerHTML, /Old Song Verified/);
    nextResponse.resolve({ ok: false, error: "bad payload" });
    await pendingOk;
    assert.equal(elements.reviewStatusBody.innerHTML, "");
    assert.match(elements.reviewMsg.textContent, /bad payload/);

    let rejectPromise;
    nextResponse = {
      promise: new Promise((_res, rej) => { rejectPromise = rej; }),
    };
    const pendingError = ReviewUI.refresh();
    assert.match(elements.reviewStatusBody.innerHTML, /Loading verification status/);
    rejectPromise(new Error("network down"));
    await pendingError;
    assert.equal(elements.reviewStatusBody.innerHTML, "");
    assert.match(elements.reviewMsg.textContent, /network down/);

    let calls = 0;
    global.api = async () => { calls += 1; return { ok: true, review: { fields: {} } }; };
    global.state = { doc: null, flags: [] };
    elements.reviewStatusBody.innerHTML = "<tr><td>Stale</td></tr>";
    await ReviewUI.refresh();
    assert.equal(calls, 0);
    assert.equal(elements.reviewStatusBody.innerHTML, "");
  } finally {
    removeReviewDom();
  }
});

test("resetForDocument invalidates in-flight refresh responses and late errors across song switches", async () => {
  const elements = installReviewDom({ field: "chords", reviewer: "AS" });
  const songA = { songs: [{ title: "A", sections: [] }] };
  const songB = { songs: [{ title: "B", sections: [] }] };
  const songAResponse = deferred();
  let rejectSongA;
  const songAError = new Promise((_res, rej) => { rejectSongA = rej; });
  const songBResponse = deferred();
  let mode = "A";
  let apiCalls = 0;
  global.api = async () => {
    apiCalls += 1;
    if (mode === "A") return songAResponse.promise;
    if (mode === "A-err") return songAError;
    return songBResponse.promise;
  };
  try {
    global.state = { doc: songA, flags: [] };
    const refreshA = ReviewUI.refresh();

    // Clear song while Song A refresh is still pending.
    global.state = { doc: null, flags: [] };
    ReviewUI.resetForDocument();
    assert.equal(elements.reviewStatusBody.innerHTML, "");
    assert.equal(elements.reviewRecord.disabled, true);
    assert.equal(elements.reviewEvidence.disabled, true);

    songAResponse.resolve({
      ok: true,
      review: { fields: { chords: { status: "verified", reviewer: "OldA" } } },
    });
    await refreshA;
    assert.equal(apiCalls, 1);
    assert.equal(elements.reviewStatusBody.innerHTML, "");

    // Overlapping Song A (rejected late) -> Song B (succeeds).
    mode = "A-err";
    global.state = { doc: songA, flags: [] };
    ReviewUI.resetForDocument();
    const refreshAErr = ReviewUI.refresh();

    mode = "B";
    global.state = { doc: songB, flags: [] };
    ReviewUI.resetForDocument();
    const refreshB = ReviewUI.refresh();
    assert.match(elements.reviewStatusBody.innerHTML, /Loading verification status/);

    songBResponse.resolve({
      ok: true,
      review: { fields: { chords: { status: "in_progress", reviewer: "NewB" } } },
    });
    await refreshB;
    rejectSongA(new Error("Song A timed out"));
    await refreshAErr;

    assert.match(elements.reviewStatusBody.innerHTML, /NewB/);
    assert.equal(elements.reviewMsg.textContent, "");
  } finally {
    removeReviewDom();
  }
});

test("recordSelected ignores a mid-flight song switch and keeps reviewRecord disabled when doc is null", async () => {
  const elements = installReviewDom({ field: "chords", reviewer: "AS" });
  const songA = { songs: [{ title: "A", sections: [] }] };
  const songB = { songs: [{ title: "B", sections: [] }] };
  const pending = deferred();
  global.api = async () => pending.promise;
  let undos = 0;
  global.pushUndo = () => { undos += 1; };
  global.markDirty = () => {};
  global.renderProvenance = () => {};
  try {
    global.state = { doc: songA, flags: [] };
    const recordingA = ReviewUI.recordSelected();
    assert.equal(elements.reviewRecord.disabled, true);

    // Switch to Song B mid-flight.
    global.state = { doc: songB, flags: [] };
    ReviewUI.resetForDocument();
    elements.reviewMsg.textContent = "Song B message";
    pending.resolve({ ok: true, doc: { ...songA, _meta: { review: { version: 1, fields: {} } } }, review: { fields: {} } });
    await recordingA;
    assert.equal(global.state.doc, songB);
    assert.equal(undos, 0);
    assert.equal(elements.reviewMsg.textContent, "Song B message");
    assert.equal(elements.reviewRecord.disabled, false);

    // Clear to null mid-flight.
    const pendingClear = deferred();
    global.api = async () => pendingClear.promise;
    global.state = { doc: songB, flags: [] };
    const recordingB = ReviewUI.recordSelected();
    global.state = { doc: null, flags: [] };
    ReviewUI.resetForDocument();
    pendingClear.resolve({ ok: true, doc: songB, review: { fields: {} } });
    await recordingB;
    assert.equal(elements.reviewRecord.disabled, true);
    assert.equal(elements.reviewMsg.textContent, "");
  } finally {
    removeReviewDom();
  }
});

test("keySel change in app.js calls renderReview only in review view and preserves typed draft on same doc", async () => {
  const elements = new Map();
  function element(id) {
    const handlers = {};
    return {
      id,
      value: "",
      disabled: false,
      textContent: "",
      innerHTML: "",
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      setAttribute() {},
      querySelectorAll: () => [],
      addEventListener: (event, handler) => { handlers[event] = handler; },
      dispatch: (event, ev) => handlers[event]?.(ev),
    };
  }
  function get(id) {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  }
  const doc = { songs: [{ key: "C", sections: [] }] };
  const state = { activeView: "bars", doc, album: "a", file: "s.json", sel: null, dirty: false };
  let renderReviewCalls = 0;
  let syncInputsCalls = 0;
  const context = vm.createContext({
    state,
    albums: [],
    $: get,
    esc: (v) => String(v ?? ""),
    api: async () => [{ album: "a", songs: [{ file: "s.json", status: "pending" }] }],
    fillSongs() {},
    loadSong() {},
    confirmDiscard: () => true,
    save() {},
    song: () => state.doc.songs[0],
    songKey: () => state.doc.songs[0].key || "",
    pushUndo() {},
    markDirty() { state.dirty = true; },
    renderBars() {},
    renderDict() {},
    renderPreview() {},
    openEditor() {},
    showView() {},
    jsonApply() {},
    jsonReload() {},
    jsonFormat() {},
    copyChordmark() {},
    wireExport() {},
    wireChordReview() {},
    wireScanReview() {},
    showShortcutDialog() {},
    toggleLayoutPane() {},
    renderSongList() {},
    nextFlagged() {},
    moveChordReview() {},
    updateScanSelection() {},
    renderReview() { renderReviewCalls += 1; },
    ReviewUI: {
      recordSelected() {},
      syncInputs() { syncInputsCalls += 1; },
    },
    window: {
      ChordNaming: { setKeyTonic() {}, getSpelling: () => "sharp", setSpelling() {} },
      addEventListener() {},
    },
    localStorage: { getItem: () => null, setItem() {} },
    document: {
      addEventListener() {},
      querySelector: (sel) => sel === "header"
        ? { offsetHeight: 40, classList: { toggle() {} } }
        : { classList: { toggle() {} } },
      documentElement: { style: { setProperty() {} } },
    },
  });
  const appSource = readFileSync(join(__dirname, "../../scripts/qa_static/app.js"), "utf8");
  vm.runInContext(appSource.replace(/\ninit\(\);\s*$/, ""), context, { filename: "app.js" });
  await context.init();

  get("keySel").dispatch("change", { target: { value: "Dm" } });
  assert.equal(state.doc.songs[0].key, "Dm");
  assert.equal(renderReviewCalls, 0);

  state.activeView = "review";
  get("keySel").dispatch("change", { target: { value: "Am" } });
  assert.equal(state.doc.songs[0].key, "Am");
  assert.equal(renderReviewCalls, 1);

  get("reviewField").dispatch("change", { target: { value: "key" } });
  assert.equal(syncInputsCalls, 1);

  // Also verify ReviewUI.render() preserves in-progress #reviewEvidence on same-doc key change.
  const reviewDom = installReviewDom({ field: "key", reviewer: "AS" });
  try {
    global.state = { doc, flags: [] };
    global.api = async () => ({
      ok: true,
      review: { fields: { key: { status: "stale", reviewer: "AS", evidence: "old key note" } } },
    });
    ReviewUI.resetForDocument();
    ReviewUI.render();
    reviewDom.reviewEvidence.value = "re-checking after key change";
    doc.songs[0].key = "Em";
    ReviewUI.render();
    assert.equal(reviewDom.reviewEvidence.value, "re-checking after key change");
    await new Promise((done) => setImmediate(done));
  } finally {
    removeReviewDom();
  }
});
