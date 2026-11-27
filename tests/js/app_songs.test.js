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
  assert.equal(elements.saveStatus.style.color, "#d29922");
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
  assert.equal(saveStatus.style.color, "#d29922");
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
