const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function harness(native = true) {
  const elements = Object.fromEntries(["unsavedDialog", "unsavedMessage", "unsavedApply", "unsavedDiscard", "unsavedCancel", "unsavedError"].map((id) => [id, { textContent: "", focus() {} }]));
  const dialog = elements.unsavedDialog;
  if (native) {
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; };
  }
  const context = vm.createContext({ state: { doc: {}, album: "a", file: "b" }, loadGeneration: 1, $: (id) => elements[id], confirm: () => true });
  vm.runInContext(fs.readFileSync("scripts/qa_static/app_interactions.js", "utf8"), context);
  return { context, elements, dialog, guard: (options) => context.guardUnsavedChanges(options) };
}

test("Cancel preserves drafts and duplicate navigation cannot replace a pending dialog", () => {
  const h = harness();
  let discarded = 0, resumed = 0;
  const options = { message: "First song", discard: () => discarded++, resume: () => resumed++ };
  assert.equal(h.guard(options), false);
  assert.equal(h.guard({ message: "Other song" }), false);
  assert.equal(h.elements.unsavedMessage.textContent, "First song");
  h.elements.unsavedCancel.onclick();
  assert.equal(discarded, 0);
  assert.equal(resumed, 0);
  assert.equal(h.dialog.open, false);
  assert.equal(h.guard(options), false);
  h.elements.unsavedDiscard.onclick();
  assert.equal(discarded, 1);
  assert.equal(resumed, 1);
});

test("failed Save keeps the dialog open and retry only resumes after success", async () => {
  const h = harness();
  let resumed = 0, ok = false;
  h.guard({ message: "Save song?", apply: async () => ({ ok, error: "Server unavailable" }), resume: () => resumed++ });
  await h.elements.unsavedApply.onclick();
  assert.equal(h.dialog.open, true);
  assert.equal(h.elements.unsavedError.textContent, "Server unavailable");
  assert.equal(resumed, 0);
  ok = true;
  await h.elements.unsavedApply.onclick();
  assert.equal(h.dialog.open, false);
  assert.equal(resumed, 1);
});

test("navigation is not resumed when song changes during Save", async () => {
  const h = harness();
  let resolve, resumed = 0;
  h.guard({ message: "Save?", apply: () => new Promise((done) => { resolve = done; }), resume: () => resumed++ });
  const pending = h.elements.unsavedApply.onclick();
  h.context.loadGeneration++;
  resolve({ ok: true });
  await pending;
  assert.equal(resumed, 0);
  assert.equal(h.dialog.open, false);
});

test("JSON replacement during failed Save still allows explicit Discard", async () => {
  const h = harness();
  let discarded = 0, resumed = 0;
  h.guard({ message: "Save?", apply: () => { h.context.state.doc = {}; return { ok: false }; }, discard: () => discarded++, resume: () => resumed++ });
  await h.elements.unsavedApply.onclick();
  h.elements.unsavedDiscard.onclick();
  assert.equal(discarded, 1);
  assert.equal(resumed, 1);
});

test("mocked dialogs keep a synchronous, cancel-safe fallback", () => {
  const h = harness(false);
  let discarded = 0, resumed = 0;
  const options = { message: "Discard?", discard: () => discarded++, resume: () => resumed++ };
  h.context.confirm = () => false;
  assert.equal(h.guard(options), false);
  assert.equal(discarded, 0);
  h.context.confirm = () => true;
  assert.equal(h.guard(options), true);
  assert.equal(discarded, 1);
  assert.equal(resumed, 0); // Synchronous callers execute their own next line.
});

test("song guard makes one choice for song, chord, JSON and lyric drafts", async () => {
  const h = harness();
  vm.runInContext(fs.readFileSync("scripts/qa_static/app_songs.js", "utf8"), h.context);
  let chord = true, lyric = true, json = true, resumed = 0;
  Object.assign(h.context, {
    chordEditorHasDraft: () => chord,
    hasLyricDrafts: () => lyric,
    hasUnappliedJsonEdits: () => json,
    closeChordEditor: () => { chord = false; },
    discardLyricDrafts: () => { lyric = false; },
    resetJsonEditorState: () => { json = false; },
  });
  h.context.state.dirty = true;
  const resume = () => resumed++;
  assert.equal(h.context.confirmDiscard(resume), false);
  h.elements.unsavedCancel.onclick();
  assert.equal(chord && lyric && json && h.context.state.dirty, true);
  assert.equal(resumed, 0);
  h.context.confirmDiscard(resume);
  h.elements.unsavedDiscard.onclick();
  assert.equal(chord || lyric || json || h.context.state.dirty, false);
  assert.equal(resumed, 1);
});

test("song guard refuses navigation if edits arrive during a successful Save", async () => {
  const h = harness();
  vm.runInContext(fs.readFileSync("scripts/qa_static/app_songs.js", "utf8"), h.context);
  let resumed = 0;
  h.context.state.dirty = true;
  h.context.save = async () => ({ ok: true });
  h.context.confirmDiscard(() => resumed++);
  await h.elements.unsavedApply.onclick();
  assert.equal(resumed, 0);
  assert.equal(h.dialog.open, true);
  assert.match(h.elements.unsavedError.textContent, /New edits remain unsaved/);
});

test("chord guard applies or discards before resuming the captured action", async () => {
  const h = harness();
  vm.runInContext(fs.readFileSync("scripts/qa_static/app_bars.js", "utf8"), h.context);
  h.context.state.sel = { si: 0, bi: 0, ei: 0 };
  let draft = true, applied = 0, discarded = 0, resumed = 0;
  h.context.hasDraft = () => draft;
  h.context.submitDraft = () => { applied++; draft = false; return true; };
  h.context.openEditor = () => { discarded++; draft = false; };
  vm.runInContext("chordEditorHasDraft = hasDraft; submitActiveChord = submitDraft", h.context);
  h.context.confirmChordDraftDiscard(() => resumed++);
  await h.elements.unsavedApply.onclick();
  assert.equal(applied, 1);
  assert.equal(resumed, 1);
  draft = true;
  h.context.confirmChordDraftDiscard(() => resumed++);
  h.elements.unsavedDiscard.onclick();
  assert.equal(discarded, 1);
  assert.equal(resumed, 2);
});

test("bar and section deletion are immediate and their toast Undo restores the document", () => {
  const doc = { songs: [{ sections: [{ label: "Verse", bars: [[{ chord: "C" }], []] }] }] };
  let action, confirmations = 0;
  const context = vm.createContext({
    state: { doc: structuredClone(doc) }, undoStack: [],
    window: { DocOps: require("../../scripts/qa_static/doc_ops.js") },
    song: () => context.state.doc.songs[0],
    pushUndo: () => context.undoStack.push(structuredClone(context.state.doc)),
    undo: () => { context.state.doc = context.undoStack.pop(); },
    confirm: () => { confirmations++; return true; },
  });
  for (const file of ["app_interactions.js", "app_bars.js"]) vm.runInContext(fs.readFileSync("scripts/qa_static/" + file, "utf8"), context);
  context.afterStructuralEdit = () => {};
  context.showToast = (_message, next) => { action = next; };
  context.deleteBar(0, 0);
  assert.equal(context.state.doc.songs[0].sections[0].bars.length, 1);
  assert.equal(confirmations, 0);
  action.run();
  assert.deepEqual(context.state.doc, doc);
  context.deleteSection(0);
  assert.equal(context.state.doc.songs[0].sections.length, 0);
  assert.equal(confirmations, 0);
  action.run();
  assert.deepEqual(context.state.doc, doc);
});
