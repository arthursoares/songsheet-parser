// Async save-state regressions for the QA app.
// Run with: node --test tests/js/
const { test } = require("node:test");
const assert = require("node:assert/strict");

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
  assert.equal(global.state.dirty, true);
  assert.match(elements.saveStatus.textContent, /newer edits unsaved/);
  assert.equal(elements.saveBtn.disabled, false);

  for (const name of ["state", "albums", "$", "api"]) delete global[name];
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
