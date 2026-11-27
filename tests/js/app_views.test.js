const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

function readStatic(name) {
  return readFileSync(join(__dirname, "../../scripts/qa_static", name), "utf8");
}

function makeClassList(initial = []) {
  const set = new Set(initial);
  return {
    add: (...cls) => cls.forEach((c) => set.add(c)),
    remove: (...cls) => cls.forEach((c) => set.delete(c)),
    contains: (c) => set.has(c),
    toggle(c, force) {
      if (force === undefined) {
        if (set.has(c)) { set.delete(c); return false; }
        set.add(c);
        return true;
      }
      if (force) set.add(c);
      else set.delete(c);
      return Boolean(force);
    },
  };
}

function makeElement(id, extra = {}) {
  const listeners = new Map();
  const attributes = new Map();
  return {
    id,
    value: "",
    textContent: "",
    innerHTML: "",
    title: "",
    disabled: false,
    hidden: false,
    className: "",
    style: {},
    dataset: {},
    options: [],
    classList: makeClassList(),
    setAttribute: (k, v) => attributes.set(k, String(v)),
    getAttribute: (k) => attributes.get(k) ?? null,
    removeAttribute: (k) => attributes.delete(k),
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatch(type, event = {}) {
      for (const fn of listeners.get(type) || []) fn(event);
    },
    click() {
      this.dispatch("click", { target: this });
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    appendChild() {},
    focus() {},
    ...extra,
  };
}

function createCodeMirrorHarness() {
  let cmInstance = null;
  function posFromIndex(text, idx) {
    const clamped = Math.max(0, Math.min(idx, text.length));
    const slice = text.slice(0, clamped);
    const lines = slice.split("\n");
    return { line: lines.length - 1, ch: lines[lines.length - 1].length };
  }
  function CodeMirror(host, options) {
    let text = options.value || "";
    let cursor = { line: 0, ch: 0 };
    let scroll = { left: 0, top: 0 };
    let focused = false;
    let scrolledTo = null;
    const listeners = new Map();
    const undoHistory = [];
    const calls = { setValue: 0, replaceRange: [], operation: 0, refresh: 0 };

    function emit(name) {
      for (const fn of listeners.get(name) || []) fn(cmInstance);
    }

    cmInstance = {
      host,
      options,
      calls,
      undoHistory,
      on(name, fn) {
        if (!listeners.has(name)) listeners.set(name, []);
        listeners.get(name).push(fn);
      },
      getValue: () => text,
      setValue(next) {
        calls.setValue += 1;
        undoHistory.length = 0;
        text = String(next);
        cursor = { line: 0, ch: 0 };
        emit("change");
      },
      replaceRange(replacement, from, to, origin) {
        calls.replaceRange.push({ replacement, from, to, origin });
        undoHistory.push(text);
        const lines = text.split("\n");
        const startOffset = lines.slice(0, from.line).reduce((n, l) => n + l.length + 1, 0) + from.ch;
        const endOffset = lines.slice(0, to.line).reduce((n, l) => n + l.length + 1, 0) + to.ch;
        text = text.slice(0, startOffset) + replacement + text.slice(endOffset);
        emit("change");
      },
      undo() {
        if (!undoHistory.length) return;
        text = undoHistory.pop();
        emit("change");
      },
      lastLine() {
        return text.split("\n").length - 1;
      },
      getLine(line) {
        return text.split("\n")[line] ?? "";
      },
      getCursor: () => ({ ...cursor }),
      setCursor(pos) { cursor = { ...pos }; },
      getScrollInfo: () => ({ ...scroll }),
      setScrollInfo(next) { scroll = { ...next }; },
      scrollTo(left, top) { scroll = { left, top }; },
      scrollIntoView(pos, margin) { scrolledTo = { pos, margin }; },
      posFromIndex: (idx) => posFromIndex(text, idx),
      focus() { focused = true; },
      isFocused: () => focused,
      scrolledTo: () => scrolledTo,
      refresh() { calls.refresh += 1; },
      operation(fn) { calls.operation += 1; return fn(); },
      typeText(next) {
        undoHistory.push(text);
        text = next;
        emit("change");
      },
      triggerExtraKey(name) {
        const handler = options.extraKeys?.[name];
        assert.equal(typeof handler, "function", `Missing extraKey ${name}`);
        return handler(cmInstance);
      },
    };
    return cmInstance;
  }
  CodeMirror.registerHelper = () => {};
  return {
    CodeMirror,
    getInstance: () => cmInstance,
  };
}

function createHarness({ withAppInit = false, apiImpl, confirmImpl, renderBarsImpl } = {}) {
  const elements = {};
  const ids = [
    "albumSel", "songSel", "workspaceSongs", "workspaceShapes", "saveBtn", "saveStatus",
    "statusSel", "keySel", "songSearch", "songsFilter", "songsList", "currentSongTitle",
    "albumProgress", "provenance", "songNote", "pages", "bars", "chordReview",
    "chordReviewToggle", "flagCount", "editor", "lyrics", "review", "dict", "harmony",
    "preview", "json", "jsonApply", "jsonReload", "jsonFormat", "jsonDirtyBadge",
    "jsonMsg", "jsonEditor", "jsonSource", "tabBars", "tabLyrics", "tabReview",
    "tabDict", "tabHarmony", "tabPreview", "tabJson", "reviewRecord", "cmCopy",
    "pvStyle", "pvDict", "pvDiagrams", "pvBars", "pvSource", "pvExportPdf", "pvExportPng",
    "pvExportHtml", "pvExportChordmark", "pvExportChordpro", "pvExportAlbum",
    "cmDownload", "pvExportMsg", "pvPreviewMsg", "previewFrame", "cmSource", "pvSourceBar",
    "spellToggle", "scanToggle", "songsToggle", "kbdHint", "shortcutDialog", "nextFlagBtn",
    "chordReviewPrev", "chordReviewNext", "chordReviewAccept", "chordReviewKeep",
    "chordReviewSkip", "chordReviewEdit", "edName", "edText", "edErr", "edBadge",
    "scanPendingReview", "scanEditReview", "scanMarkReviewed", "scanDeferReview",
  ];
  for (const id of ids) elements[id] = makeElement(id);
  elements.jsonDirtyBadge.hidden = true;
  elements.jsonDirtyBadge.classList = makeClassList(["json-dirty-badge", "hidden"]);
  elements.albumSel.value = "album-1";
  elements.songSel.value = "01-song.json";
  elements.albumSel.options = [{ value: "album-1" }];
  elements.songSel.options = [{ value: "01-song.json", textContent: "○  01-song.json" }];

  const timers = new Map();
  let nextTimerId = 1;
  const confirmCalls = [];
  const docListeners = new Map();
  const winListeners = new Map();
  const cmHarness = createCodeMirrorHarness();
  const storage = new Map();

  const initialDoc = {
    document: { title: "Album 1", status: "pending" },
    songs: [{
      title: "Blue Bossa",
      key: "Cm",
      pages: [1],
      sections: [{ label: "A", bars: [[{ chord: "Cm7", voicing: "x,3,5,3,4,3" }]] }],
    }],
  };

  let apiRequests = [];
  const defaultApi = async (path, opts) => {
    apiRequests.push({ path, opts });
    if (path === "/api/albums") {
      return [{ album: "album-1", songs: [{ file: "01-song.json", status: "pending" }, { file: "02-other.json", status: "done" }] }];
    }
    if (path.startsWith("/api/song/") && (!opts || opts.method !== "POST")) {
      return structuredClone(initialDoc);
    }
    return { ok: true };
  };

  const context = {
    console,
    JSON,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Set,
    Map,
    Promise,
    Error,
    RegExp,
    URLSearchParams,
    Symbol,
    CodeMirror: cmHarness.CodeMirror,
    confirm: (msg) => {
      confirmCalls.push(msg);
      return confirmImpl ? confirmImpl(msg) : true;
    },
    setTimeout(fn, delay) {
      const id = nextTimerId++;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    localStorage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, String(v)),
    },
    document: {
      getElementById: (id) => elements[id] || null,
      createElement: (tag) => makeElement(tag),
      querySelector: () => makeElement("layout"),
      documentElement: { style: { setProperty() {} } },
      addEventListener(type, fn) {
        if (!docListeners.has(type)) docListeners.set(type, []);
        docListeners.get(type).push(fn);
      },
    },
    window: {
      ChordNaming: {
        setKeyTonic() {},
        parseKey(k) {
          if (!k) return null;
          return k.endsWith("m")
            ? { tonic: k.slice(0, -1), mode: "minor" }
            : { tonic: k, mode: "major" };
        },
        getSpelling: () => "sharp",
        setSpelling() {},
      },
      addEventListener(type, fn) {
        if (!winListeners.has(type)) winListeners.set(type, []);
        winListeners.get(type).push(fn);
      },
    },
    fetch: async (path, opts) => ({
      ok: true,
      headers: { get: () => null },
      json: async () => (apiImpl || defaultApi)(path, opts),
      text: async () => "",
    }),
    renderBars() { if (renderBarsImpl) renderBarsImpl(); },
    renderPages() {},
    renderLyrics() {},
    renderReview() {},
    renderDict() {},
    renderHarmony() {},
    renderShapes() {},
    syncScanDocument() {},
    updateChordReviewEntryPoint() {},
    applyLayoutToggles() {},
    wireChordReview() {},
    wireScanReview() {},
    ReviewUI: { recordSelected() {} },
    PreviewExport: {},
  };
  context.window.window = context.window;
  vm.createContext(context);

  for (const filename of ["app_core.js", "app_songs.js", "app_views.js"]) {
    vm.runInContext(readStatic(filename), context, { filename });
  }
  const appState = vm.runInContext("state", context);
  context.state = appState;
  context.undoStack = vm.runInContext("undoStack", context);
  if (withAppInit) {
    vm.runInContext(readStatic("app.js").replace(/\ninit\(\);\s*$/, ""), context, { filename: "app.js" });
  } else {
    // Wire basic initial state without full app.js init
    vm.runInContext(`albums = ${JSON.stringify([{
      album: "album-1",
      songs: [
        { file: "01-song.json", status: "pending" },
        { file: "02-other.json", status: "done" },
      ],
    }])};`, context);
    appState.album = "album-1";
    appState.file = "01-song.json";
    appState.doc = structuredClone(initialDoc);
  }

  return {
    context,
    elements,
    cmHarness,
    confirmCalls,
    timers,
    apiRequests,
    docListeners,
    winListeners,
    initialDoc,
    undoLength: () => vm.runInContext("undoStack.length", context),
    flushTimers() {
      const pending = [...timers.entries()];
      timers.clear();
      for (const [, entry] of pending) entry.fn();
    },
  };
}

test("editing JSON updates jsonDirty synchronously and shows #jsonDirtyBadge distinct from valid ✓", () => {
  const h = createHarness();
  h.context.showView("json");

  const cm = h.cmHarness.getInstance();
  assert.ok(cm);
  assert.equal(h.context.hasUnappliedJsonEdits(), false);
  assert.equal(h.elements.jsonDirtyBadge.hidden, true);
  assert.equal(h.elements.jsonDirtyBadge.classList.contains("hidden"), true);

  const edited = JSON.parse(cm.getValue());
  edited.songs[0].title = "Edited Bossa";
  cm.typeText(JSON.stringify(edited, null, 2));

  // Synchronous before the 250ms validation timer fires
  assert.equal(h.context.hasUnappliedJsonEdits(), true);
  assert.equal(h.elements.jsonDirtyBadge.hidden, false);
  assert.equal(h.elements.jsonDirtyBadge.classList.contains("hidden"), false);

  // Debounced live validation prints valid ✓ without clearing #jsonDirtyBadge
  h.flushTimers();
  assert.equal(h.elements.jsonMsg.textContent, "valid ✓");
  assert.equal(h.elements.jsonMsg.className, "ok");
  assert.equal(h.elements.jsonDirtyBadge.hidden, false);
  assert.equal(h.context.hasUnappliedJsonEdits(), true);

  // Reverting back to baseline clears jsonDirty and hides #jsonDirtyBadge
  cm.typeText(JSON.stringify(h.initialDoc, null, 2));
  assert.equal(h.context.hasUnappliedJsonEdits(), false);
  assert.equal(h.elements.jsonDirtyBadge.hidden, true);
});

test("Cmd-S and Ctrl-S apply valid JSON edits before saving, and block save on invalid JSON", async () => {
  const h = createHarness();
  h.context.showView("json");
  const cm = h.cmHarness.getInstance();

  // Invalid JSON blocks save
  cm.typeText("{ bad json");
  cm.triggerExtraKey("Cmd-S");
  assert.equal(h.apiRequests.length, 0);
  assert.equal(h.context.hasUnappliedJsonEdits(), true);
  assert.match(h.elements.jsonMsg.className, /^err/);

  // Direct save() also blocks when JSON has unapplied invalid edits
  const blocked = await h.context.save();
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "Invalid JSON edits");
  assert.equal(h.apiRequests.length, 0);

  // Bad shape also blocks save
  cm.typeText(JSON.stringify({ document: {}, songs: [] }, null, 2));
  cm.triggerExtraKey("Ctrl-S");
  assert.equal(h.apiRequests.length, 0);
  assert.match(h.elements.jsonMsg.textContent, /Bad shape/);

  // Valid edit -> Cmd-S applies to state.doc and persists via save()
  const updated = structuredClone(h.initialDoc);
  updated.songs[0].title = "Saved Via Cmd-S";
  cm.typeText(JSON.stringify(updated, null, 2));
  cm.triggerExtraKey("Cmd-S");

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.apiRequests.length, 1);
  assert.equal(JSON.parse(h.apiRequests[0].opts.body).songs[0].title, "Saved Via Cmd-S");
  assert.equal(h.context.state.doc.songs[0].title, "Saved Via Cmd-S");
  assert.equal(h.context.state.dirty, false);
  assert.equal(h.context.hasUnappliedJsonEdits(), false);
  assert.equal(h.elements.jsonDirtyBadge.hidden, true);
  assert.equal(h.elements.saveStatus.textContent, "✓ saved");
});

test("Cmd-Enter and Ctrl-Enter apply JSON edits without saving to disk", async () => {
  const h = createHarness({ withAppInit: true });
  await h.context.init();
  await new Promise((resolve) => setImmediate(resolve));
  h.context.showView("json");
  const cm = h.cmHarness.getInstance();

  const updated = structuredClone(h.initialDoc);
  updated.songs[0].title = "Applied Only";
  cm.typeText(JSON.stringify(updated, null, 2));

  cm.triggerExtraKey("Cmd-Enter");
  assert.equal(h.context.state.doc.songs[0].title, "Applied Only");
  assert.equal(h.context.state.dirty, true);
  assert.equal(h.context.hasUnappliedJsonEdits(), false);
  assert.equal(h.elements.jsonMsg.textContent, "applied ✓ — Save to persist");
  // Only init's /api/albums + /api/song GET requests ran, no POST save
  assert.equal(h.apiRequests.filter((r) => r.opts?.method === "POST").length, 0);

  // Global onKeydown Ctrl+Enter when activeView === "json" also applies
  const updated2 = structuredClone(updated);
  updated2.songs[0].title = "Applied Via Global Key";
  cm.typeText(JSON.stringify(updated2, null, 2));
  let prevented = false;
  h.context.onKeydown({
    key: "Enter",
    ctrlKey: true,
    target: { tagName: "DIV" },
    preventDefault: () => { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.equal(h.context.state.doc.songs[0].title, "Applied Via Global Key");
});

test("discard guards protect unapplied JSON edits across showView, confirmDiscard, jsonReload, and beforeunload", async () => {
  let confirmResponse = false;
  const h = createHarness({ withAppInit: true, confirmImpl: () => confirmResponse });
  await h.context.init();
  await new Promise((resolve) => setImmediate(resolve));
  h.context.showView("json");
  const cm = h.cmHarness.getInstance();

  const edited = structuredClone(h.initialDoc);
  edited.songs[0].title = "Unsaved Buffer";
  const editedText = JSON.stringify(edited, null, 2);
  cm.typeText(editedText);

  // 1. showView("bars") cancelled -> stays on json, buffer preserved
  h.context.showView("bars");
  assert.equal(h.confirmCalls.length, 1);
  assert.equal(h.context.state.activeView, "json");
  assert.equal(cm.getValue(), editedText);

  // 2. showView("json") while already on json -> no confirm, no overwrite
  h.context.showView("json");
  assert.equal(h.confirmCalls.length, 1);
  assert.equal(cm.getValue(), editedText);

  // 3. jsonReload() cancelled -> buffer preserved
  h.context.jsonReload();
  assert.equal(h.confirmCalls.length, 2);
  assert.equal(cm.getValue(), editedText);

  // 4. confirmDiscard() cancelled when only jsonDirty is true (state.dirty is false)
  assert.equal(h.context.state.dirty, false);
  assert.equal(h.context.confirmDiscard(), false);
  assert.equal(h.confirmCalls.length, 3);

  // 5. beforeunload prevents unload when jsonDirty is true even if state.dirty is false
  const unloadEvent = { defaultPrevented: false, returnValue: undefined, preventDefault() { this.defaultPrevented = true; } };
  for (const fn of h.winListeners.get("beforeunload") || []) fn(unloadEvent);
  assert.equal(unloadEvent.defaultPrevented, true);
  assert.equal(unloadEvent.returnValue, "");

  // 6. Confirming showView("bars") resets JSON state so later save() won't apply discarded edits
  confirmResponse = true;
  h.context.showView("bars");
  assert.equal(h.context.state.activeView, "bars");
  assert.equal(h.context.hasUnappliedJsonEdits(), false);
  assert.equal(h.elements.jsonDirtyBadge.hidden, true);
  await h.context.save();
  const posts = h.apiRequests.filter((r) => r.opts?.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(posts[0].opts.body).songs[0].title, "Blue Bossa");

  // 7. Re-entering JSON renders fresh state.doc, and confirmed jsonReload resets edits
  h.context.showView("json");
  cm.typeText(editedText);
  h.context.jsonReload();
  assert.equal(h.context.hasUnappliedJsonEdits(), false);
  assert.equal(JSON.parse(cm.getValue()).songs[0].title, "Blue Bossa");
});

test("song switching resets JSON state before showView so there is no double confirm prompt", async () => {
  const h = createHarness({ confirmImpl: () => true });
  h.context.showView("json");
  const cm = h.cmHarness.getInstance();

  const edited = structuredClone(h.initialDoc);
  edited.songs[0].title = "Before Switch";
  cm.typeText(JSON.stringify(edited, null, 2));

  // selectSong calls confirmDiscard() once, then clearSongForLoad calls resetJsonEditorState() before showView()
  h.context.selectSong("02-other.json");
  assert.equal(h.confirmCalls.length, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.context.hasUnappliedJsonEdits(), false);
  assert.equal(h.elements.jsonDirtyBadge.hidden, true);
});

test("rerenderAll (undo/redo), #keySel, and #statusSel sync JSON view when clean, and preserve when dirty", async () => {
  const h = createHarness({ withAppInit: true });
  await h.context.init();
  await new Promise((resolve) => setImmediate(resolve));
  h.context.showView("json");
  const cm = h.cmHarness.getInstance();

  // #keySel change refreshes JSON when clean
  h.elements.keySel.dispatch("change", { target: { value: "Dm" } });
  assert.equal(JSON.parse(cm.getValue()).songs[0].key, "Dm");

  // #statusSel change refreshes JSON when clean
  h.elements.statusSel.dispatch("change", { target: { value: "done" } });
  assert.equal(JSON.parse(cm.getValue()).document.status, "done");

  // undo() and redo() via rerenderAll() refresh JSON when clean
  h.context.undo();
  assert.equal(JSON.parse(cm.getValue()).document.status, "pending");
  h.context.redo();
  assert.equal(JSON.parse(cm.getValue()).document.status, "done");

  // When jsonDirty is true, undo / #keySel / #statusSel must NOT clobber CM buffer
  const dirtyDoc = structuredClone(h.context.state.doc);
  dirtyDoc.songs[0].title = "Keep My Unapplied Buffer";
  const dirtyText = JSON.stringify(dirtyDoc, null, 2);
  cm.typeText(dirtyText);

  h.context.undo();
  assert.equal(cm.getValue(), dirtyText);
  h.elements.keySel.dispatch("change", { target: { value: "G" } });
  assert.equal(cm.getValue(), dirtyText);
  h.elements.statusSel.dispatch("change", { target: { value: "in_progress" } });
  assert.equal(cm.getValue(), dirtyText);
});

test("jsonApply skips undo on unchanged doc and restores wasDirty + #saveStatus + jsonDirty on rollback", () => {
  let shouldThrow = false;
  const h = createHarness({
    renderBarsImpl() {
      if (shouldThrow) throw new Error("render boom");
    },
  });
  h.context.showView("json");
  const cm = h.cmHarness.getInstance();
  h.elements.saveStatus.textContent = "✓ saved";
  h.elements.saveStatus.style.color = "var(--ok)";

  // 1. Reordered keys / whitespace only -> no pushUndo, no markDirty
  const reordered = {
    songs: h.initialDoc.songs,
    document: h.initialDoc.document,
  };
  cm.typeText(JSON.stringify(reordered));
  assert.equal(h.context.hasUnappliedJsonEdits(), true);
  assert.equal(h.context.jsonApply(), true);
  assert.equal(h.undoLength(), 0);
  assert.equal(h.context.state.dirty, false);
  assert.equal(h.context.hasUnappliedJsonEdits(), false);
  assert.equal(h.elements.jsonMsg.textContent, "no model changes");

  // 2. Rollback from clean state preserves wasDirty === false, editVersion === 0, #saveStatus, and jsonDirty === true
  const broken = structuredClone(h.initialDoc);
  broken.songs[0].title = "Broken";
  cm.typeText(JSON.stringify(broken, null, 2));
  shouldThrow = true;
  assert.equal(h.context.jsonApply(), false);
  assert.equal(h.undoLength(), 0);
  assert.equal(h.context.state.doc.songs[0].title, "Blue Bossa");
  assert.equal(h.context.state.dirty, false);
  assert.equal(h.context.state.editVersion || 0, 0);
  assert.equal(h.elements.saveStatus.textContent, "✓ saved");
  assert.equal(h.elements.saveStatus.style.color, "var(--ok)");
  assert.equal(h.context.hasUnappliedJsonEdits(), true);
  assert.equal(h.elements.jsonDirtyBadge.hidden, false);
  assert.match(h.elements.jsonMsg.textContent, /Could not apply: render boom/);

  // 3. Rollback from already-dirty state preserves wasDirty === true and prior editVersion
  h.context.markDirty();
  h.context.markDirty();
  assert.equal(h.context.state.dirty, true);
  assert.equal(h.context.state.editVersion, 2);
  assert.equal(h.context.jsonApply(), false);
  assert.equal(h.context.state.dirty, true);
  assert.equal(h.context.state.editVersion, 2);
  assert.equal(h.elements.saveStatus.textContent, "Unsaved changes");
  assert.equal(h.context.hasUnappliedJsonEdits(), true);
});

test("jsonFormat uses replaceRange (preserving CM undo history), clamps cursor, and preserves scroll", () => {
  const h = createHarness();
  h.context.showView("json");
  const cm = h.cmHarness.getInstance();

  const compact = JSON.stringify(h.initialDoc);
  cm.typeText(compact);
  const beforeSetValueCalls = cm.calls.setValue;
  cm.setCursor({ line: 25, ch: 80 });
  cm.setScrollInfo({ left: 12, top: 140 });

  h.context.jsonFormat();

  assert.equal(cm.calls.setValue, beforeSetValueCalls);
  assert.equal(cm.calls.operation, 1);
  assert.equal(cm.calls.replaceRange.length, 1);
  assert.equal(cm.calls.replaceRange[0].origin, "+format");
  assert.equal(cm.getValue(), JSON.stringify(h.initialDoc, null, 2));
  assert.equal(h.elements.jsonMsg.textContent, "formatted ✓");
  assert.deepEqual(cm.getScrollInfo(), { left: 12, top: 140 });
  assert.ok(cm.getCursor().line <= cm.lastLine());

  // CM undo reverts formatting back to compact string
  cm.undo();
  assert.equal(cm.getValue(), compact);
});

test("jsonErrPos omits fake (line 1, col 1) for Safari errors and #jsonMsg click jumps when position is known", () => {
  const h = createHarness();
  h.context.showView("json");
  const cm = h.cmHarness.getInstance();

  // Unknown position (Safari-style message)
  assert.equal(h.context.jsonErrPos(cm, "JSON Parse error: Expected '}'"), null);
  h.context.setJsonSyntaxError("invalid — ", new SyntaxError("JSON Parse error: Expected '}'"));
  assert.equal(h.elements.jsonMsg.textContent, "invalid — JSON Parse error: Expected '}'");
  assert.doesNotMatch(h.elements.jsonMsg.textContent, /line 1, col 1/);
  assert.equal(h.elements.jsonMsg.className, "err");

  // Linter still safely produces a gutter annotation at line 0 when position is unknown
  const origParse = JSON.parse;
  try {
    h.context.JSON = {
      parse() { throw new SyntaxError("JSON Parse error: Expected '}'"); },
      stringify: origParse.stringify ? origParse.stringify : JSON.stringify,
    };
    const marks = h.context.jsonLinter("{ bad");
    assert.equal(marks.length, 1);
    assert.equal(marks[0].from.line, 0);
    assert.equal(marks[0].from.ch, 0);
  } finally {
    h.context.JSON = JSON;
  }

  // Known position (Firefox/V8 message) marks #jsonMsg jumpable and click jumps CM cursor/scroll
  h.context.setJsonSyntaxError("invalid — ", new SyntaxError("Unexpected token at line 3 column 5"));
  assert.equal(h.elements.jsonMsg.textContent, "invalid — Unexpected token at line 3 column 5 (line 3, col 5)");
  assert.equal(h.elements.jsonMsg.className, "err jumpable");

  h.elements.jsonMsg.click();
  assert.equal(cm.isFocused(), true);
  assert.deepEqual(cm.getCursor(), { line: 2, ch: 4 });
  assert.equal(cm.scrolledTo().pos.line, 2);
  assert.equal(cm.scrolledTo().pos.ch, 4);
  assert.equal(cm.scrolledTo().margin, 80);
});

test("index.html includes #jsonDirtyBadge, CSS rules, and Cmd/Ctrl+Enter shortcut documentation", () => {
  const html = readStatic("index.html");
  const css = readStatic("qa_base.css");
  assert.match(html, /id="jsonDirtyBadge"[^>]*>Unapplied JSON edits<\/span>/);
  assert.match(html, /href="qa_base\.css"/);
  assert.match(css, /#jsonDirtyBadge\.hidden\{display:none\}/);
  assert.match(css, /#jsonMsg\.clickable,#jsonMsg\.jumpable\{/);
  assert.match(html, /id="jsonApply"[^>]*⌘Enter \/ Ctrl\+Enter/);
  assert.match(html, /<kbd>⌘\/Ctrl<\/kbd>\+<kbd>Enter<\/kbd>/);
});
