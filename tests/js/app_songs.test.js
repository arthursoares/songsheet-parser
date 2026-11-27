// Async save-state regressions for the QA app.
// Run with: node --test tests/js/
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const SongsUI = require("../../scripts/qa_static/app_songs.js");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("save is single-flight and preserves edits made while the request is pending", async () => {
  const pending = deferred();
  const doc = {
    document: { title: "Album", status: "in_progress" },
    songs: [{ sections: [{ bars: [[{ chord: "C" }]] }] }],
  };
  const elements = {
    saveBtn: { disabled: false },
    saveStatus: { textContent: "", style: {} },
  };
  global.state = { doc, album: "album", file: "song.json", dirty: true, activeView: "bars" };
  global.albums = [];
  global.$ = (id) => elements[id];
  let requests = 0;
  let submitted;
  global.api = async (_path, options) => {
    requests += 1;
    submitted = options.body;
    return pending.promise;
  };
  let scanSaved;
  global.syncSavedScanDocument = (snapshot, unchanged) => { scanSaved = { snapshot, unchanged }; };

  const first = SongsUI.save();
  const overlapping = SongsUI.save();
  assert.equal(first, overlapping);
  assert.equal(requests, 1);
  assert.equal(elements.saveBtn.disabled, true);

  doc.songs[0].sections[0].bars[0][0].chord = "Dm";
  pending.resolve({ ok: true });
  await first;

  assert.equal(JSON.parse(submitted).songs[0].sections[0].bars[0][0].chord, "C");
  assert.equal(global.state.doc.songs[0].sections[0].bars[0][0].chord, "Dm");
  assert.equal(scanSaved.snapshot.songs[0].sections[0].bars[0][0].chord, "C");
  assert.equal(scanSaved.unchanged, false);
  assert.equal(global.state.dirty, true);
  assert.equal(elements.saveStatus.textContent, "Unsaved changes");
  assert.equal(elements.saveStatus.style.color, "var(--warn)");
  assert.equal(elements.saveBtn.disabled, false);

  for (const name of ["state", "albums", "$", "api", "syncSavedScanDocument"]) delete global[name];
});

test("markDirty reports unsaved changes immediately and advances the edit version", () => {
  const saveStatus = { textContent: "✓ saved", style: { color: "var(--ok)" } };
  const context = vm.createContext({
    document: { getElementById: (id) => id === "saveStatus" ? saveStatus : null },
    window: {},
  });
  const source = fs.readFileSync(
    require.resolve("../../scripts/qa_static/app_core.js"), "utf8");
  vm.runInContext(source, context);
  vm.runInContext("markDirty(); markDirty();", context);

  assert.equal(vm.runInContext("state.dirty", context), true);
  assert.equal(vm.runInContext("state.editVersion", context), 2);
  assert.equal(saveStatus.textContent, "Unsaved changes");
  assert.equal(saveStatus.style.color, "var(--warn)");
});

function installLoadHarness() {
  const rows = [];
  const elements = {
    albumSel: { value: "album" },
    songSel: { value: "first.json" },
    saveStatus: { textContent: "", style: {} },
    pages: { innerHTML: "stale pages" },
    bars: { innerHTML: "stale bars" },
    editor: { classList: { remove() {} } },
    statusSel: { value: "" },
    keySel: { value: "" },
    albumProgress: { textContent: "" },
    currentSongTitle: { textContent: "stale title" },
    songsList: {
      innerHTML: "",
      appendChild(row) { rows.push(row); },
    },
  };
  const storage = {};
  global.localStorage = {
    getItem: (key) => storage[key] || null,
    setItem: (key, value) => { storage[key] = value; },
  };
  global.document = {
    createElement: (tagName) => ({
      tagName,
      className: "",
      attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener() {},
      innerHTML: "",
    }),
  };
  global.state = {
    album: null, file: null, doc: { songs: [{ title: "stale" }] }, sel: null,
    dictSel: new Set(), dictEdit: null, dictMergeOpen: false,
    activeView: "bars", dirty: false, flags: [], songSearch: "", songFilter: "all",
  };
  global.albums = [{
    album: "album",
    songs: [
      { file: "first.json", status: "pending" },
      { file: "second.json", status: "done" },
    ],
  }];
  global.undoStack = [];
  global.redoStack = [];
  global.$ = (id) => elements[id];
  global.esc = (value) => String(value);
  global.STATUS_LABEL = { pending: "○ pending", done: "✓ done" };
  global.song = () => global.state.doc.songs[0];
  global.songKey = () => "";
  global.syncNote = () => {};
  global.renderProvenance = () => {};
  global.renderPages = () => {};
  global.renderBars = () => {};
  global.showView = (view) => { global.state.activeView = view; };
  global.window = { ChordNaming: { setKeyTonic() {} } };
  global.updateChordReviewEntryPoint = () => {};
  return { elements, rows, storage };
}

function removeLoadHarness() {
  for (const name of [
    "localStorage", "document", "state", "albums", "undoStack", "redoStack", "$",
    "esc", "STATUS_LABEL", "song", "songKey", "syncNote", "renderProvenance",
    "renderPages", "renderBars", "showView", "window", "updateChordReviewEntryPoint",
    "api",
  ]) delete global[name];
}

test("an older song fetch cannot replace a newer selection", async () => {
  const { elements, storage } = installLoadHarness();
  const first = deferred();
  const second = deferred();
  global.api = (path) => path.endsWith("first.json") ? first.promise : second.promise;

  const firstLoad = SongsUI.loadSong();
  assert.equal(global.state.doc, null);
  assert.match(elements.bars.innerHTML, /Loading song/);
  assert.equal(elements.currentSongTitle.textContent, "");

  elements.songSel.value = "second.json";
  const secondLoad = SongsUI.loadSong();
  const secondDoc = { document: { status: "done" }, songs: [{ title: "Second" }] };
  second.resolve(secondDoc);
  await secondLoad;
  first.resolve({ document: { status: "pending" }, songs: [{ title: "First" }] });
  await firstLoad;

  assert.equal(global.state.doc, secondDoc);
  assert.equal(global.state.album, "album");
  assert.equal(global.state.file, "second.json");
  assert.equal(elements.currentSongTitle.textContent, "Second");
  assert.equal(JSON.parse(storage.qaLastSongByAlbum).album, "second.json");
  removeLoadHarness();
});

test("a rejected song load leaves no stale editable document", async () => {
  const { elements } = installLoadHarness();
  global.api = async () => { throw new Error("offline"); };

  await SongsUI.loadSong();

  assert.equal(global.state.doc, null);
  assert.equal(global.state.dirty, false);
  assert.match(elements.bars.innerHTML, /Could not load/);
  assert.equal(elements.currentSongTitle.textContent, "");
  removeLoadHarness();
});

test("song rows are native buttons with an accessible current state", () => {
  const { rows } = installLoadHarness();
  global.state.file = "second.json";

  SongsUI.renderSongList();

  assert.equal(rows.length, 2);
  assert.equal(rows[0].tagName, "button");
  assert.equal(rows[0].type, "button");
  assert.equal(rows[0].attributes["aria-current"], "false");
  assert.match(rows[0].attributes["aria-label"], /first, pending/);
  assert.equal(rows[1].attributes["aria-current"], "true");
  assert.match(rows[1].attributes["aria-label"], /second, done/);
  removeLoadHarness();
});

test("fillSongs restores the last successfully loaded song for an album", () => {
  const { elements, storage } = installLoadHarness();
  storage.qaLastSongByAlbum = JSON.stringify({ album: "second.json" });

  SongsUI.fillSongs();

  assert.equal(elements.songSel.value, "second.json");
  removeLoadHarness();
});

test("completion of a previous-song save does not dirty the newly loaded song", async () => {
  const pending = deferred();
  const submitted = {
    document: { title: "Old", status: "done" },
    songs: [{ sections: [] }],
  };
  const current = { document: { title: "New" }, songs: [{ sections: [] }] };
  const elements = {
    saveBtn: { disabled: false },
    saveStatus: { textContent: "saving…", style: { color: "old" } },
  };
  global.state = {
    doc: submitted,
    album: "album-a",
    file: "old.json",
    dirty: true,
    activeView: "bars",
  };
  global.albums = [
    { album: "album-a", songs: [{ file: "old.json", status: "pending" }] },
    { album: "album-b", songs: [{ file: "new.json", status: "in_progress" }] },
  ];
  global.$ = (id) => elements[id];
  global.api = async () => pending.promise;

  const saving = SongsUI.save();
  global.state.doc = current;
  global.state.album = "album-b";
  global.state.file = "new.json";
  global.state.dirty = false;
  elements.saveStatus.textContent = ""; // loadSong clears the previous request's message
  elements.saveStatus.style.color = "new-song-color";
  pending.resolve({ ok: true });
  await saving;

  assert.equal(global.state.doc, current);
  assert.equal(global.state.dirty, false);
  assert.equal(elements.saveStatus.textContent, "");
  assert.equal(elements.saveStatus.style.color, "new-song-color");
  assert.equal(global.albums[0].songs[0].status, "done");
  assert.equal(global.albums[1].songs[0].status, "in_progress");
  for (const name of ["state", "albums", "$", "api"]) delete global[name];
});

test("completion of a save leaves a new empty state clean", async () => {
  const pending = deferred();
  const submitted = { document: { title: "Old" }, songs: [{ sections: [] }] };
  const elements = {
    saveBtn: { disabled: false },
    saveStatus: { textContent: "", style: {} },
  };
  global.state = {
    doc: submitted,
    album: "album-a",
    file: "old.json",
    dirty: true,
    activeView: "bars",
  };
  global.albums = [];
  global.$ = (id) => elements[id];
  global.api = async () => pending.promise;

  const saving = SongsUI.save();
  global.state.doc = null;
  global.state.album = null;
  global.state.file = null;
  global.state.dirty = false;
  elements.saveStatus.textContent = "";
  pending.resolve({ ok: true });
  await saving;

  assert.equal(global.state.doc, null);
  assert.equal(global.state.dirty, false);
  assert.equal(elements.saveStatus.textContent, "");
  for (const name of ["state", "albums", "$", "api"]) delete global[name];
});

test("loadSong and showEmpty call resetReviewInputs around clearing and loading songs", async () => {
  const { elements } = installLoadHarness();
  const observedDocs = [];
  global.resetReviewInputs = () => { observedDocs.push(global.state.doc); };
  const loadedDoc = { document: { status: "pending" }, songs: [{ title: "First" }] };
  try {
    global.api = async () => loadedDoc;
    await SongsUI.loadSong();
    assert.equal(observedDocs.length, 2);
    assert.equal(observedDocs[0], null);
    assert.equal(observedDocs[1], loadedDoc);

    observedDocs.length = 0;
    global.api = async () => { throw new Error("offline"); };
    await SongsUI.loadSong();
    assert.deepEqual(observedDocs, [null, null]);

    observedDocs.length = 0;
    elements.songSel.value = "";
    await SongsUI.loadSong();
    assert.deepEqual(observedDocs, [null]);
  } finally {
    delete global.resetReviewInputs;
    removeLoadHarness();
  }
});

test("SongsUI.loadSong integrated with ReviewUI clears stale review evidence and loading table across switches", async () => {
  const ReviewUI = require("../../scripts/qa_static/app_review.js");
  const { elements } = installLoadHarness();
  elements.reviewField = { value: "chords", disabled: false };
  elements.reviewStatus = { value: "pending", disabled: false };
  elements.reviewReviewer = { value: "AS", disabled: false };
  elements.reviewEvidence = { value: "", disabled: false };
  elements.reviewRecord = { disabled: false };
  elements.reviewMsg = { textContent: "" };
  elements.reviewStatusBody = { innerHTML: "" };
  elements.verificationChordProgress = { textContent: "" };
  elements.reviewSourceIssues = { innerHTML: "", classList: { toggle() {}, add() {} } };
  elements.reviewFlags = { innerHTML: "" };

  const songA = {
    document: { status: "in_progress" },
    songs: [{ title: "First", sections: [] }],
    _meta: {
      review: {
        version: 1,
        fields: {
          chords: { status: "verified", reviewer: "AS", evidence: "Song A chords ok" },
        },
      },
    },
  };
  const songB = {
    document: { status: "pending" },
    songs: [{ title: "Second", sections: [] }],
  };
  const pendingSecond = deferred();
  const reviewRequests = [];
  global.resetReviewInputs = () => ReviewUI.resetForDocument();
  global.showView = (view) => {
    global.state.activeView = view;
    if (view === "review") ReviewUI.render();
  };
  global.api = async (path, options) => {
    if (path.endsWith("/first.json")) return songA;
    if (path.endsWith("/second.json")) return pendingSecond.promise;
    if (path === "/api/review-doc") {
      const payload = JSON.parse(options.body);
      reviewRequests.push(payload.doc);
      return {
        ok: true,
        review: {
          fields: {
            chords: payload.doc?.songs?.[0]?.title === "First"
              ? { status: "verified", reviewer: "AS", evidence: "Song A chords ok" }
              : { status: "pending", reviewer: "", evidence: "" },
          },
        },
      };
    }
    throw new Error(`Unexpected path: ${path}`);
  };
  try {
    elements.songSel.value = "first.json";
    await SongsUI.loadSong({ view: "review" });
    await new Promise((done) => setImmediate(done));
    assert.equal(elements.reviewEvidence.value, "Song A chords ok");
    assert.equal(elements.reviewStatus.value, "verified");
    assert.match(elements.reviewStatusBody.innerHTML, /Song A chords ok/);

    // User types an unrecorded draft on Song A, then switches to Song B while fetch is pending.
    elements.reviewEvidence.value = "unsaved draft on A";
    elements.songSel.value = "second.json";
    const loadingSecond = SongsUI.loadSong({ view: "review" });
    assert.equal(global.state.doc, null);
    assert.equal(elements.reviewEvidence.value, "");
    assert.equal(elements.reviewStatus.value, "pending");
    assert.equal(elements.reviewStatusBody.innerHTML, "");
    assert.equal(elements.reviewRecord.disabled, true);
    assert.equal(reviewRequests.some((doc) => doc === null), false);

    pendingSecond.resolve(songB);
    await loadingSecond;
    await new Promise((done) => setImmediate(done));
    assert.equal(global.state.doc, songB);
    assert.equal(elements.reviewEvidence.value, "");
    assert.equal(elements.reviewStatus.value, "pending");
    assert.equal(elements.reviewRecord.disabled, false);
    assert.doesNotMatch(elements.reviewStatusBody.innerHTML, /Song A chords ok/);
  } finally {
    delete global.resetReviewInputs;
    removeLoadHarness();
  }
});

test("save flushes active blur-committed inputs before serializing state.doc and skips .fb-text", async () => {
  const doc = {
    document: { title: "Album", status: "in_progress" },
    songs: [{ note: "old", sections: [{ label: "Verse", bars: [[{ chord: "C" }]] }] }],
  };
  const elements = {
    saveBtn: { disabled: false },
    saveStatus: { textContent: "", style: {} },
  };
  const activeInput = {
    id: "songNote",
    className: "",
    _commitOnSave() {
      doc.songs[0].note = "flushed note";
      global.state.dirty = true;
      return true;
    },
  };
  global.document = { activeElement: activeInput };
  global.state = { doc, album: "album", file: "song.json", dirty: false, activeView: "bars" };
  global.albums = [];
  global.$ = (id) => elements[id];
  const bodies = [];
  global.api = async (_path, options) => {
    bodies.push(JSON.parse(options.body));
    return { ok: true };
  };

  await SongsUI.save();
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].songs[0].note, "flushed note");
  assert.equal(global.state.dirty, false);
  assert.equal(global.state.savedSnapshot, JSON.stringify(doc));

  // Fallback to blur() when _commitOnSave is absent on a blur-committed class
  let blurred = false;
  global.document = {
    activeElement: {
      id: "",
      className: "seclabel",
      blur() {
        blurred = true;
        doc.songs[0].sections[0].label = "Chorus";
      },
    },
  };
  await SongsUI.save();
  assert.equal(blurred, true);
  assert.equal(bodies[1].songs[0].sections[0].label, "Chorus");

  // Never blindly blur .fb-text
  let fbBlurred = false;
  global.document = {
    activeElement: {
      id: "",
      className: "fb-text",
      blur() { fbBlurred = true; },
    },
  };
  await SongsUI.save();
  assert.equal(fbBlurred, false);

  for (const name of ["document", "state", "albums", "$", "api"]) delete global[name];
});

test("save aborts without calling api when active input commit fails", async () => {
  const doc = { document: { status: "pending" }, songs: [{ sections: [] }] };
  const elements = {
    saveBtn: { disabled: false },
    saveStatus: { textContent: "", style: {} },
  };
  global.document = {
    activeElement: {
      className: "ly-line-edit",
      _commitOnSave: () => false,
    },
  };
  global.state = { doc, album: "album", file: "song.json", dirty: true, activeView: "lyrics" };
  global.albums = [];
  global.$ = (id) => elements[id];
  let requests = 0;
  global.api = async () => { requests += 1; return { ok: true }; };

  const res = await SongsUI.save();
  assert.equal(res.ok, false);
  assert.equal(res.blocked, true);
  assert.equal(requests, 0);
  assert.equal(global.state.dirty, true);
  assert.equal(elements.saveStatus.style.color, "var(--bad)");
  assert.equal(elements.saveBtn.disabled, false);

  for (const name of ["document", "state", "albums", "$", "api"]) delete global[name];
});

test("save applies valid chord drafts across views and blocks invalid drafts", async () => {
  const doc = { document: { status: "pending" }, songs: [{ sections: [{ bars: [[{ chord: "C" }]] }] }] };
  const elements = {
    saveBtn: { disabled: false },
    saveStatus: { textContent: "", style: {} },
  };
  let draft = true;
  let applyResult = true;
  const switchedViews = [];
  global.state = { doc, album: "album", file: "song.json", dirty: false, activeView: "preview" };
  global.albums = [];
  global.$ = (id) => elements[id];
  global.chordEditorHasDraft = () => draft;
  global.showView = (view) => { switchedViews.push(view); global.state.activeView = view; };
  global.submitActiveChord = () => {
    if (!applyResult) return false;
    doc.songs[0].sections[0].bars[0][0].chord = "Cmaj7";
    draft = false;
    global.state.dirty = true;
    return true;
  };
  const saved = [];
  global.api = async (_path, options) => {
    saved.push(JSON.parse(options.body));
    return { ok: true };
  };

  await SongsUI.save();
  assert.deepEqual(switchedViews, ["bars"]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].songs[0].sections[0].bars[0][0].chord, "Cmaj7");
  assert.equal(global.state.dirty, false);

  // Invalid draft blocks save and preserves dirty state
  draft = true;
  applyResult = false;
  global.state.dirty = true;
  const blocked = await SongsUI.save();
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blocked, true);
  assert.equal(saved.length, 1);
  assert.equal(global.state.dirty, true);
  assert.equal(elements.saveStatus.style.color, "var(--bad)");
  assert.equal(elements.saveBtn.disabled, false);

  for (const name of [
    "state", "albums", "$", "api", "chordEditorHasDraft", "showView", "submitActiveChord",
  ]) delete global[name];
});

test("confirmDiscard checks confirmChordDraftDiscard before state.dirty", () => {
  let confirmCalls = 0;
  let draftOk = false;
  global.state = { dirty: false };
  global.confirm = () => { confirmCalls += 1; return true; };
  global.confirmChordDraftDiscard = () => draftOk;

  assert.equal(SongsUI.confirmDiscard(), false);
  assert.equal(confirmCalls, 0);

  draftOk = true;
  assert.equal(SongsUI.confirmDiscard(), true);
  assert.equal(confirmCalls, 0);

  global.state.dirty = true;
  assert.equal(SongsUI.confirmDiscard(), true);
  assert.equal(confirmCalls, 1);

  for (const name of ["state", "confirm", "confirmChordDraftDiscard"]) delete global[name];
});

test("loadSong records savedSnapshot and saveOnce updates savedSnapshot even with concurrent edits", async () => {
  const { elements } = installLoadHarness();
  elements.songSel.options = [];
  const loaded = { document: { status: "pending" }, songs: [{ title: "First", sections: [{ bars: [[{ chord: "C" }]] }] }] };
  global.api = async () => loaded;

  await SongsUI.loadSong();
  assert.equal(global.state.savedSnapshot, JSON.stringify(loaded));
  assert.equal(global.state.dirty, false);

  // Concurrent edit while save is in flight
  const pending = deferred();
  loaded.songs[0].sections[0].bars[0][0].chord = "Dm";
  global.state.dirty = true;
  global.state.editVersion = 1;
  global.api = async () => pending.promise;
  elements.saveBtn = { disabled: false };
  const saving = SongsUI.save();

  loaded.songs[0].sections[0].bars[0][0].chord = "Em";
  global.state.editVersion = 2;
  pending.resolve({ ok: true });
  await saving;

  assert.equal(JSON.parse(global.state.savedSnapshot).songs[0].sections[0].bars[0][0].chord, "Dm");
  assert.equal(global.state.dirty, true);
  removeLoadHarness();
});

test("save marks shapesUI unloaded and stale on success, and keeps it loaded on failure", async () => {
  const doc = {
    document: { title: "Album", status: "done" },
    songs: [{ sections: [{ bars: [[{ chord: "C" }]] }] }],
  };
  const elements = {
    saveBtn: { disabled: false },
    saveStatus: { textContent: "", style: {} },
  };
  global.state = { doc, album: "album", file: "song.json", dirty: true, activeView: "bars" };
  global.albums = [];
  global.$ = (id) => elements[id];
  global.shapesUI = { loaded: true, stale: false };

  global.api = async () => ({ ok: false, error: "conflict" });
  await SongsUI.save();
  assert.equal(global.shapesUI.loaded, true);
  assert.equal(global.shapesUI.stale, false);

  global.api = async () => ({ ok: true, revision: "rev-2" });
  await SongsUI.save();
  assert.equal(global.shapesUI.loaded, false);
  assert.equal(global.shapesUI.stale, true);

  for (const name of ["state", "albums", "$", "api", "shapesUI"]) delete global[name];
});

test("confirmDiscard and save respect unapplied JSON edits via guarded hooks", async () => {
  const prompts = [];
  let confirmResult = false;
  let jsonDirty = true;
  let applyResult = false;
  let apiCalls = 0;
  const elements = {
    saveBtn: { disabled: false },
    saveStatus: { textContent: "", style: {} },
  };
  global.state = {
    doc: { document: { status: "pending" }, songs: [{ sections: [] }] },
    album: "album",
    file: "song.json",
    dirty: false,
    activeView: "json",
  };
  global.albums = [];
  global.$ = (id) => elements[id];
  global.confirm = (msg) => { prompts.push(msg); return confirmResult; };
  global.hasUnappliedJsonEdits = () => jsonDirty;
  global.jsonApply = () => {
    if (!applyResult) return false;
    jsonDirty = false;
    global.state.doc.songs[0].title = "From JSON";
    return true;
  };
  global.api = async (_path, opts) => {
    apiCalls += 1;
    return { ok: true, body: opts.body };
  };

  assert.equal(SongsUI.confirmDiscard(), false);
  assert.equal(prompts[0], "Discard unapplied JSON edits?");

  global.state.dirty = true;
  confirmResult = true;
  assert.equal(SongsUI.confirmDiscard(), true);
  assert.equal(prompts[1], "Discard unsaved changes and unapplied JSON edits?");

  const blocked = await SongsUI.save();
  assert.deepEqual(blocked, { ok: false, error: "Invalid JSON edits" });
  assert.equal(apiCalls, 0);

  applyResult = true;
  const saved = await SongsUI.save();
  assert.equal(saved.ok, true);
  assert.equal(apiCalls, 1);
  assert.equal(JSON.parse(saved.body).songs[0].title, "From JSON");

  for (const name of [
    "state", "albums", "$", "confirm", "hasUnappliedJsonEdits", "jsonApply", "api",
  ]) delete global[name];
});
