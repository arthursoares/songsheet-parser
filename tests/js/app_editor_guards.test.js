// Integration tests for Issue #15 (P1-01):
//   1. Flush blur-committed inputs (#songNote, .seclabel, .ly-line-edit, .ly-edit) on save / Cmd+S
//   2. Guard chordEditorHasDraft() on save / Cmd+S (apply valid or block with #saveStatus error)
//   3. Guard chordEditorHasDraft() on navigation, Escape, #edCancel, beforeunload, and structural edits
//   4. Live .fb-text validation, fb.isValid()/getError()/commit(), and blocking invalid Apply
//   5. state.savedSnapshot clean-state undo/redo and rerenderAll() state.sel preservation
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const DocOps = require("../../scripts/qa_static/doc_ops.js");

function createMockDom() {
  const byId = new Map();
  let activeElement = null;
  const docListeners = {};
  const winListeners = {};

  function parseHtmlElements(html, parent) {
    if (parent.tagName === "SELECT") {
      const opts = [];
      const optMatches = html.matchAll(/<option(?:\s+value="([^"]*)")?[^>]*>([^<]*)<\/option>/gi);
      for (const om of optMatches) {
        const opt = createEl("option");
        opt.value = om[1] !== undefined ? om[1] : om[2];
        opt.textContent = om[2];
        opts.push(opt);
        parent.appendChild(opt);
      }
      parent.options = opts;
      if (opts.length && !opts.some((o) => o.value === parent.value)) {
        parent.value = opts[0].value;
      }
      return;
    }
    const tags = html.match(/<(button|input|div|span|select|textarea|img|small|b|h2|label)([^>]*)>/gi) || [];
    for (const tagStr of tags) {
      const m = tagStr.match(/^<(\w+)([^>]*)>/i);
      if (!m) continue;
      const node = createEl(m[1].toLowerCase());
      const attrs = m[2];
      const idMatch = attrs.match(/\bid="([^"]*)"/);
      if (idMatch) {
        node.id = idMatch[1];
        byId.set(node.id, node);
      }
      const clsMatch = attrs.match(/\bclass="([^"]*)"/);
      if (clsMatch) node.className = clsMatch[1];
      const valMatch = attrs.match(/\bvalue="([^"]*)"/);
      if (valMatch) node.value = valMatch[1];
      const dataActMatch = attrs.match(/\bdata-act=([^\s>]+)/);
      if (dataActMatch) node.dataset.act = dataActMatch[1].replace(/^["']|["']$/g, "");
      const dataSugMatch = attrs.match(/\bdata-suggestion="(\d+)"/);
      if (dataSugMatch) node.dataset.suggestion = dataSugMatch[1];
      parent.appendChild(node);
    }
  }

  function allDescendants(node) {
    const out = [];
    for (const child of node.children) {
      out.push(child, ...allDescendants(child));
    }
    return out;
  }

  function matchesSelector(node, sel) {
    if (sel.startsWith("#")) return node.id === sel.slice(1);
    if (sel.startsWith(".")) {
      const parts = sel.slice(1).split(".");
      return parts.every((c) => node.classList.contains(c));
    }
    const attrEq = sel.match(/^\[([^=\]]+)=([^\]]+)\]$/);
    if (attrEq) {
      const attr = attrEq[1];
      const expected = attrEq[2].replace(/^["']|["']$/g, "");
      if (attr === "data-act") return node.dataset.act === expected;
      if (attr === "data-chord-coords") return node.dataset.chordCoords === expected;
      if (attr === "data-ly-chord") return node.dataset.lyChord === expected;
      return node.getAttribute(attr) === expected;
    }
    if (sel === "[data-suggestion]") return node.dataset.suggestion !== undefined;
    if (sel === "[data-filter]") return node.dataset.filter !== undefined;
    if (sel === "[data-mode]") return node.dataset.mode !== undefined;
    return false;
  }

  function createEl(tagName = "div", id = "") {
    const listeners = {};
    const attrs = new Map();
    let classSet = new Set();
    let markup = "";
    const node = {
      tagName: tagName.toUpperCase(),
      id,
      type: "",
      value: "",
      textContent: "",
      title: "",
      disabled: false,
      hidden: false,
      open: false,
      style: { setProperty() {} },
      dataset: {},
      children: [],
      options: [],
      parent: null,
      get className() { return [...classSet].join(" "); },
      set className(val) {
        classSet = new Set(String(val || "").split(/\s+/).filter(Boolean));
      },
      classList: {
        add: (...names) => names.forEach((n) => classSet.add(n)),
        remove: (...names) => names.forEach((n) => classSet.delete(n)),
        contains: (n) => classSet.has(n),
        toggle: (n, force) => {
          const on = force === undefined ? !classSet.has(n) : Boolean(force);
          if (on) classSet.add(n); else classSet.delete(n);
          return on;
        },
      },
      appendChild(child) {
        child.parent = node;
        node.children.push(child);
        return child;
      },
      replaceChild(next, prev) {
        const idx = node.children.indexOf(prev);
        if (idx >= 0) node.children[idx] = next;
        next.parent = node;
      },
      get innerHTML() { return markup; },
      set innerHTML(val) {
        markup = String(val || "");
        node.children = [];
        parseHtmlElements(markup, node);
      },
      querySelector(sel) {
        for (const part of sel.split(",").map((s) => s.trim())) {
          const found = allDescendants(node).find((d) => matchesSelector(d, part));
          if (found) return found;
        }
        return null;
      },
      querySelectorAll(sel) {
        const parts = sel.split(",").map((s) => s.trim());
        return allDescendants(node).filter((d) => parts.some((p) => matchesSelector(d, p)));
      },
      contains(target) {
        return node === target || allDescendants(node).includes(target);
      },
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      removeAttribute(k) { attrs.delete(k); },
      addEventListener(type, fn) {
        (listeners[type] ||= []).push(fn);
      },
      dispatch(type, ev = {}) {
        const event = {
          target: node,
          defaultPrevented: false,
          propagationStopped: false,
          preventDefault() { this.defaultPrevented = true; },
          stopPropagation() { this.propagationStopped = true; },
          ...ev,
        };
        if (typeof node[`on${type}`] === "function") node[`on${type}`](event);
        for (const fn of (listeners[type] || [])) fn(event);
        return event;
      },
      click() { return node.dispatch("click"); },
      focus() {
        const prev = activeElement;
        activeElement = node;
        if (prev && prev !== node) prev.dispatch("blur");
        node.dispatch("focus");
      },
      blur() {
        if (activeElement === node) activeElement = null;
        node.dispatch("blur");
      },
      select() {},
      scrollIntoView() {},
    };
    if (id) byId.set(id, node);
    return node;
  }

  function get(id) {
    if (!byId.has(id)) createEl("div", id);
    return byId.get(id);
  }

  const documentElement = createEl("html");
  const header = createEl("header");
  header.offsetHeight = 40;
  const layout = createEl("div");
  layout.className = "layout";

  const document = {
    documentElement,
    createElement: (tag) => createEl(tag),
    createTextNode: (t) => Object.assign(createEl("#text"), { textContent: t }),
    getElementById: get,
    querySelector: (sel) => sel === "header" ? header : sel === ".layout" ? layout : null,
    get activeElement() { return activeElement; },
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
    dispatch(type, ev = {}) {
      const event = {
        defaultPrevented: false,
        propagationStopped: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.propagationStopped = true; },
        ...ev,
      };
      for (const fn of (docListeners[type] || [])) fn(event);
      return event;
    },
  };

  return { createEl, get, document, winListeners };
}

async function createAppHarness({
  doc = null,
  confirmQueue = [],
  apiHandler = null,
  lyMode = "text",
} = {}) {
  const dom = createMockDom();
  const baseDoc = doc || {
    document: { title: "Album", status: "in_progress" },
    songs: [{
      title: "Song A",
      key: "C",
      note: "initial note",
      sections: [
        {
          label: "Verse",
          bars: [
            [{ chord: "C", voicing: "x,3,2,0,1,0", text: "hel-" }, { chord: "G", voicing: "3,2,0,0,0,3", text: "lo" }],
            [{ chord: "Am", voicing: "x,0,2,2,1,0", text: "world" }],
          ],
        },
        {
          label: "Chorus",
          bars: [[{ chord: "F", voicing: "1,3,3,2,1,1" }]],
        },
      ],
    }],
  };

  const albums = [
    {
      album: "album-1",
      songs: [
        { file: "01-a.json", status: "in_progress" },
        { file: "02-b.json", status: "pending" },
      ],
    },
    {
      album: "album-2",
      songs: [{ file: "03-c.json", status: "done" }],
    },
  ];
  const storage = new Map([["qaLyMode", lyMode]]);
  const confirmPrompts = [];
  const apiCalls = [];

  for (const id of [
    "albumSel", "songSel", "workspaceSongs", "workspaceShapes", "saveBtn", "saveStatus",
    "statusSel", "keySel", "songSearch", "songsFilter", "tabBars", "tabLyrics",
    "tabReview", "tabDict", "tabHarmony", "tabPreview", "tabJson", "jsonApply",
    "jsonReload", "jsonFormat", "reviewRecord", "cmCopy", "pvStyle", "pvDict",
    "pvDiagrams", "pvBars", "pvSource", "spellToggle", "scanToggle", "songsToggle",
    "kbdHint", "songNote", "nextFlagBtn", "shortcutDialog", "editor", "bars",
    "pages", "lyrics", "review", "dict", "harmony", "preview", "json", "shapes",
    "chordReview", "chordReviewToggle", "flagCount", "albumProgress", "currentSongTitle",
    "songsList", "provenance",
  ]) {
    dom.get(id);
  }
  dom.get("songNote").tagName = "TEXTAREA";
  dom.get("albumSel").tagName = "SELECT";
  dom.get("songSel").tagName = "SELECT";

  const windowObj = {
    DocOps,
    ChordDiagram: { svg: () => "" },
    ChordNaming: {
      parseKey: (k) => k ? { tonic: k.replace(/m$/, ""), mode: k.endsWith("m") ? "minor" : "major" } : null,
      setKeyTonic() {},
      getKeyTonic: () => "C",
      getSpelling: () => "sharp",
      setSpelling() {},
      validateName: (name) => ({ valid: Boolean(name) && name !== "INVALID_CHORD" }),
      nameMatchesVoicing: () => true,
      suggestNames: () => [{ name: "Cmaj7" }],
      perStringNotes: (v) => v.map(() => "C"),
      perStringInKey: (v) => v.map(() => "1"),
      perStringChordIntervals: (v) => v.map(() => "1"),
    },
    addEventListener(type, fn) { (dom.winListeners[type] ||= []).push(fn); },
  };

  const context = vm.createContext({
    window: windowObj,
    document: dom.document,
    localStorage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, String(v)),
    },
    confirm: (msg) => {
      confirmPrompts.push(msg);
      return confirmQueue.length ? confirmQueue.shift() : true;
    },
    URLSearchParams,
    fetch: async (path, opts) => {
      apiCalls.push({ path, opts });
      let data;
      if (apiHandler) {
        data = await apiHandler(path, opts);
      } else if (path === "/api/albums") {
        data = albums;
      } else if (path.startsWith("/api/song/") && (!opts || opts.method !== "POST")) {
        data = structuredClone(baseDoc);
      } else if (path.startsWith("/api/song/") && opts?.method === "POST") {
        data = { ok: true, revision: "rev-2" };
      } else {
        data = {};
      }
      return {
        json: async () => data,
        headers: { get: () => "rev-1" },
      };
    },
    // Minimal stubs for unrelated modules not loaded here
    renderPages() {},
    renderReview() {},
    renderDict() {},
    renderHarmony() {},
    renderPreview() {},
    renderJson() {},
    renderShapes() {},
    setPreviewSnapshot() {},
    wireExport() {},
    copyChordmark() {},
    jsonApply() {},
    jsonReload() {},
    jsonFormat() {},
    ReviewUI: { recordSelected() {} },
    wireChordReview() {},
    wireScanReview() {},
    syncScanDocument() {},
    syncScanSelection() {},
    renderScanReviewMarks() {},
    updateChordReviewEntryPoint() {},
    chordReviewStatus: () => "pending",
    setChordReviewStatus(e, status) { e.chord_review = { status }; },
    CHORD_REVIEW_LABELS: { pending: "", reviewed: "Reviewed", deferred: "Deferred" },
  });
  windowObj.window = windowObj;

  for (const filename of [
    "fretboard.js",
    "app_core.js",
    "app_songs.js",
    "app_bars.js",
    "app_lyrics.js",
    "app_views.js",
    "app.js",
  ]) {
    const source = readFileSync(join(__dirname, "../../scripts/qa_static", filename), "utf8");
    const code = filename === "app.js" ? source.replace(/\ninit\(\);\s*$/, "") : source;
    vm.runInContext(code, context, { filename });
  }

  await context.init();
  await context.loadSong();

  return {
    dom,
    context,
    state: vm.runInContext("state", context),
    chordEditorHasDraft: () => vm.runInContext("chordEditorHasDraft()", context),
    confirmQueue,
    confirmPrompts,
    apiCalls,
    storage,
    setLyMode(mode) { storage.set("qaLyMode", mode); },
    cmdS(target = { tagName: "INPUT" }) {
      const ev = dom.document.dispatch("keydown", { key: "s", metaKey: true, target });
      return ev;
    },
    cmdZ(shiftKey = false) {
      return dom.document.dispatch("keydown", { key: "z", metaKey: true, shiftKey, target: { tagName: "DIV" } });
    },
    pressEsc(target = { tagName: "DIV" }) {
      return dom.document.dispatch("keydown", { key: "Escape", target });
    },
    fireBeforeUnload() {
      const ev = {
        defaultPrevented: false,
        returnValue: undefined,
        preventDefault() { this.defaultPrevented = true; },
      };
      for (const fn of (dom.winListeners.beforeunload || [])) fn(ev);
      return ev;
    },
  };
}

test("Feature 4: live .fb-text validation preserves focus and blocks invalid Apply / Cmd+S without silent old-voicing commit", async () => {
  const app = await createAppHarness();
  app.context.openEditor(0, 0, 0);

  const fbText = app.dom.get("edFb").querySelector(".fb-text");
  const fbErr = app.dom.get("edFb").querySelector(".fb-err");
  assert.equal(fbText.value, "x,3,2,0,1,0");
  assert.equal(fbText.getAttribute("aria-invalid"), "false");
  assert.equal(app.chordEditorHasDraft(), false);

  // Typing invalid partial voicing updates error live without destroying .fb-text element
  fbText.focus();
  fbText.value = "x,3,2,0,1";
  fbText.dispatch("input");
  assert.equal(app.dom.get("edFb").querySelector(".fb-text"), fbText);
  assert.equal(app.dom.document.activeElement, fbText);
  assert.match(fbErr.textContent, /6 values/);
  assert.equal(fbText.getAttribute("aria-invalid"), "true");
  assert.equal(app.chordEditorHasDraft(), true);

  // Blur focus elsewhere then click Apply -> must block, set #edErr, focus .fb-text, NOT pushUndo/mutate
  app.dom.get("edName").focus();
  app.dom.get("edApply").click();
  assert.match(app.dom.get("edErr").textContent, /Invalid voicing/);
  assert.equal(app.dom.document.activeElement, fbText);
  assert.equal(app.state.doc.songs[0].sections[0].bars[0][0].voicing, "x,3,2,0,1,0");
  assert.equal(app.state.dirty, false);

  // Cmd+S while invalid .fb-text is focused -> blocked, #saveStatus error, no POST
  const postsBefore = app.apiCalls.filter((c) => c.opts?.method === "POST").length;
  app.cmdS(fbText);
  await new Promise((r) => setImmediate(r));
  assert.equal(app.apiCalls.filter((c) => c.opts?.method === "POST").length, postsBefore);
  assert.equal(app.dom.get("saveStatus").style.color, "var(--bad)");
  assert.equal(fbText.value, "x,3,2,0,1");

  // Typing valid unblurred voicing clears live error and commits on Cmd+S
  fbText.value = "x,3,2,0,3,0";
  fbText.dispatch("input");
  assert.equal(fbErr.textContent, "");
  assert.equal(fbText.getAttribute("aria-invalid"), "false");
  assert.equal(app.chordEditorHasDraft(), true);

  app.cmdS(fbText);
  await new Promise((r) => setImmediate(r));
  const posts = app.apiCalls.filter((c) => c.opts?.method === "POST");
  assert.equal(posts.length, postsBefore + 1);
  assert.equal(JSON.parse(posts[0].opts.body).songs[0].sections[0].bars[0][0].voicing, "x,3,2,0,3,0");
  assert.equal(app.state.dirty, false);
});

test("Feature 1: Cmd+S flushes #songNote, .seclabel, and .ly-line-edit (blocking on invalid markers)", async () => {
  const app = await createAppHarness();

  // 1) #songNote unblurred edit committed on Cmd+S
  const noteTa = app.dom.get("songNote");
  noteTa.focus();
  noteTa.value = "Capo 2";
  app.cmdS(noteTa);
  await new Promise((r) => setImmediate(r));
  let posts = app.apiCalls.filter((c) => c.opts?.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(posts[0].opts.body).songs[0].note, "Capo 2");
  assert.equal(app.state.dirty, false);
  // Blurring afterward does not double-dirty
  noteTa.blur();
  assert.equal(app.state.dirty, false);

  // 2) .seclabel unblurred edit committed on Cmd+S
  const secInput = app.dom.get("bars").querySelector(".seclabel");
  secInput.focus();
  secInput.value = "Verse 1";
  app.cmdS(secInput);
  await new Promise((r) => setImmediate(r));
  posts = app.apiCalls.filter((c) => c.opts?.method === "POST");
  assert.equal(posts.length, 2);
  assert.equal(JSON.parse(posts[1].opts.body).songs[0].sections[0].label, "Verse 1");

  // 3) .ly-line-edit invalid marker count blocks Cmd+S
  app.context.showView("lyrics");
  const lyInput = app.dom.get("lyrics").querySelector(".ly-line-edit");
  const lyErr = app.dom.get("lyrics").querySelector(".ly-line-err");
  lyInput.focus();
  lyInput.value = "missing markers";
  app.cmdS(lyInput);
  await new Promise((r) => setImmediate(r));
  posts = app.apiCalls.filter((c) => c.opts?.method === "POST");
  assert.equal(posts.length, 2);
  assert.match(lyErr.textContent, /needs exactly/);
  assert.equal(app.dom.get("saveStatus").style.color, "var(--bad)");

  // Fixing marker count commits and saves
  lyInput.value = "_one _two _three";
  app.cmdS(lyInput);
  await new Promise((r) => setImmediate(r));
  posts = app.apiCalls.filter((c) => c.opts?.method === "POST");
  assert.equal(posts.length, 3);
  assert.equal(JSON.parse(posts[2].opts.body).songs[0].sections[0].bars[0][0].text, "one");
});

test("Feature 2: Cmd+S with valid chord draft on non-bars tab switches to bars, applies, and saves", async () => {
  const app = await createAppHarness();
  app.context.openEditor(0, 0, 0);
  app.dom.get("edName").value = "Cmaj7";
  app.context.showView("preview");
  assert.equal(app.state.activeView, "preview");

  app.cmdS({ tagName: "DIV" });
  await new Promise((r) => setImmediate(r));
  assert.equal(app.state.activeView, "bars");
  assert.equal(app.state.doc.songs[0].sections[0].bars[0][0].chord, "Cmaj7");
  const posts = app.apiCalls.filter((c) => c.path.startsWith("/api/song/") && c.opts?.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(posts[0].opts.body).songs[0].sections[0].bars[0][0].chord, "Cmaj7");
});

test("Feature 3: chordEditorHasDraft guards navigation, beforeunload, Escape (no double prompt), Cancel, and structural edits", async () => {
  const app = await createAppHarness({ confirmQueue: Array(10).fill(false) });
  app.context.openEditor(0, 0, 0);
  app.dom.get("edName").value = "Cmaj7"; // draft while state.dirty === false

  // beforeunload warns even though state.dirty === false
  const unloadEv = app.fireBeforeUnload();
  assert.equal(unloadEv.defaultPrevented, true);
  assert.equal(unloadEv.returnValue, "");

  // #albumSel change cancelled -> restores state.album
  app.dom.get("albumSel").value = "album-2";
  app.dom.get("albumSel").dispatch("change");
  assert.equal(app.dom.get("albumSel").value, "album-1");
  assert.equal(app.state.file, "01-a.json");

  // #songSel change cancelled -> restores state.file
  app.dom.get("songSel").value = "02-b.json";
  app.dom.get("songSel").dispatch("change");
  assert.equal(app.dom.get("songSel").value, "01-a.json");

  // selectSong cancelled
  app.context.selectSong("02-b.json");
  assert.equal(app.state.file, "01-a.json");

  // #edName Escape triggers ONLY ONE prompt (stopPropagation prevents global onKeydown double-prompt)
  const promptsBefore = app.confirmPrompts.length;
  const nameKeyEv = app.dom.get("edName").dispatch("keydown", { key: "Escape" });
  assert.equal(nameKeyEv.propagationStopped, true);
  assert.equal(app.confirmPrompts.length, promptsBefore + 1);
  assert.equal(app.dom.get("editor").classList.contains("open"), true);

  // Global Escape cancelled -> keeps #editor open and draft intact
  app.pressEsc();
  assert.equal(app.dom.get("editor").classList.contains("open"), true);
  assert.equal(app.dom.get("edName").value, "Cmaj7");

  // #edCancel cancelled -> keeps #editor open
  app.dom.get("edCancel").click();
  assert.equal(app.dom.get("editor").classList.contains("open"), true);

  // Structural edits cancelled BEFORE any Delete confirm or DocOps mutation
  const barsBefore = app.state.doc.songs[0].sections[0].bars.length;
  app.context.deleteBar(0, 0);
  assert.equal(app.state.doc.songs[0].sections[0].bars.length, barsBefore);
  assert.equal(app.confirmPrompts.at(-1), "Discard the unapplied chord edits?");

  app.context.mergeBarWithNext(0, 0);
  assert.equal(app.state.doc.songs[0].sections[0].bars.length, barsBefore);

  const secsBefore = app.state.doc.songs[0].sections.length;
  app.context.addSectionAfter(0);
  assert.equal(app.state.doc.songs[0].sections.length, secsBefore);

  app.context.deleteSection(0);
  assert.equal(app.state.doc.songs[0].sections.length, secsBefore);
  assert.equal(app.confirmPrompts.at(-1), "Discard the unapplied chord edits?");

  // Confirming Escape closes editor and clears draft
  app.confirmQueue.push(true);
  app.pressEsc();
  assert.equal(app.dom.get("editor").classList.contains("open"), false);
  assert.equal(app.state.sel, null);
});

test("Feature 5: undo/redo restores clean state at savedSnapshot and rerenderAll preserves valid state.sel", async () => {
  const app = await createAppHarness();
  assert.equal(app.state.dirty, false);
  assert.equal(typeof app.state.savedSnapshot, "string");

  // Edit chord via editor while open
  app.context.openEditor(0, 0, 0);
  app.dom.get("edName").value = "Cmaj7";
  app.dom.get("edApply").click();
  assert.equal(app.state.dirty, true);
  assert.equal(app.dom.get("saveStatus").textContent, "Unsaved changes");
  assert.deepEqual({ ...app.state.sel }, { si: 0, bi: 0, ei: 0 });

  // Undo back to loaded snapshot -> clean state + preserves state.sel + refreshes open #editor
  app.cmdZ(false);
  assert.equal(app.state.doc.songs[0].sections[0].bars[0][0].chord, "C");
  assert.equal(app.state.dirty, false);
  assert.equal(app.dom.get("saveStatus").textContent, "");
  assert.deepEqual({ ...app.state.sel }, { si: 0, bi: 0, ei: 0 });
  assert.equal(app.dom.get("editor").classList.contains("open"), true);
  assert.equal(app.dom.get("edName").value, "C");

  // Redo -> dirty again, #editor refreshed to Cmaj7
  app.cmdZ(true);
  assert.equal(app.state.doc.songs[0].sections[0].bars[0][0].chord, "Cmaj7");
  assert.equal(app.state.dirty, true);
  assert.equal(app.dom.get("edName").value, "Cmaj7");

  // Save updates savedSnapshot; another edit + undo returns clean to new saved state
  app.cmdS({ tagName: "DIV" });
  await new Promise((r) => setImmediate(r));
  assert.equal(app.state.dirty, false);

  app.dom.get("edName").value = "C6";
  app.dom.get("edApply").click();
  assert.equal(app.state.dirty, true);

  app.cmdZ(false);
  assert.equal(app.state.doc.songs[0].sections[0].bars[0][0].chord, "Cmaj7");
  assert.equal(app.state.dirty, false);

  // Undo past saved state marks dirty again
  app.cmdZ(false);
  assert.equal(app.state.doc.songs[0].sections[0].bars[0][0].chord, "C");
  assert.equal(app.state.dirty, true);

  // If selected bar no longer exists after undo, state.sel clears and #editor closes
  app.context.redo();
  app.dom.get("edCancel").click();
  app.context.addBarAfter(0, 0);
  // Bar 1 is newly inserted empty; select bar 2 (old bar 1) and undo addBarAfter
  app.context.openEditor(0, 2, 0);
  app.cmdZ(false);
  assert.equal(app.state.sel, null);
  assert.equal(app.dom.get("editor").classList.contains("open"), false);
});

test("Edge cases: .ly-edit flush on Cmd+S, empty .fb-text on unvoiced chord, and invalid draft from another tab", async () => {
  const app = await createAppHarness({ lyMode: "grid" });

  // 1) .ly-edit in Arrange mode flushes on Cmd+S
  app.context.showView("lyrics");
  const wordBtn = app.dom.get("lyrics").querySelectorAll(".ly-text").find((b) => b.textContent === "world");
  wordBtn.dispatch("dblclick");
  const lyEdit = app.dom.get("lyrics").querySelector(".ly-edit");
  assert.ok(lyEdit);
  lyEdit.value = "earth";
  app.cmdS(lyEdit);
  await new Promise((r) => setImmediate(r));
  let songPosts = app.apiCalls.filter((c) => c.path.startsWith("/api/song/") && c.opts?.method === "POST");
  assert.equal(songPosts.length, 1);
  assert.equal(JSON.parse(songPosts[0].opts.body).songs[0].sections[0].bars[1][0].text, "earth");

  // 2) Clearing .fb-text to "" on an entry with no voicing marks draft + blocks Apply
  app.context.showView("bars");
  app.state.doc.songs[0].sections[1].bars[0][0].voicing_printed = "1,3,3,2,1,1";
  delete app.state.doc.songs[0].sections[1].bars[0][0].voicing;
  app.context.openEditor(1, 0, 0);
  const fbText = app.dom.get("edFb").querySelector(".fb-text");
  assert.equal(fbText.value, "x,x,x,x,x,x");
  assert.equal(app.chordEditorHasDraft(), false);

  fbText.value = "";
  fbText.dispatch("input");
  assert.equal(app.chordEditorHasDraft(), true);
  app.dom.get("edApply").click();
  assert.match(app.dom.get("edErr").textContent, /Invalid voicing/);
  assert.equal(app.dom.document.activeElement, fbText);

  // 3) Invalid draft on another tab switches to bars on Cmd+S so #edErr is visible, without saving
  app.context.showView("review");
  app.cmdS({ tagName: "DIV" });
  await new Promise((r) => setImmediate(r));
  assert.equal(app.state.activeView, "bars");
  assert.equal(app.dom.get("saveStatus").style.color, "var(--bad)");
  songPosts = app.apiCalls.filter((c) => c.path.startsWith("/api/song/") && c.opts?.method === "POST");
  assert.equal(songPosts.length, 1);

  // 4) usePrinted (#edUsePrintNext) still works even when .fb-text has invalid text
  app.dom.get("edUsePrintNext").click();
  assert.equal(app.state.doc.songs[0].sections[1].bars[0][0].voicing, "1,3,3,2,1,1");
});
