const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const DocOps = require("../../scripts/qa_static/doc_ops.js");

const source = readFileSync(join(__dirname, "../../scripts/qa_static/app_lyrics.js"), "utf8");

function arrange(bars, { mode = "grid", sections, flowWidth = 0, measureText = null, discard = true } = {}) {
  let focused;
  let scan;
  let undo = 0;
  let redraw = 0;
  let resize;
  let timer;
  let confirmations = 0;
  const book = { sections: sections || [{ bars }] };
  const state = { doc: { songs: [book] }, sel: null };

  function element(tag) {
    const events = {};
    let value = "";
    const node = {
      tag, children: [], dataset: {}, className: "", textContent: "",
      style: { setProperty(name, val) { this[name] = val; } },
      attributes: {},
      appendChild(child) { this.children.push(child); child.parent = this; },
      replaceChild(next, previous) {
        this.children[this.children.indexOf(previous)] = next;
        next.parent = this;
      },
      set innerHTML(html) { this.children = []; value = html; },
      get innerHTML() { return value; },
      setAttribute(name, val) { this.attributes[name] = val; },
      get classList() {
        const classes = new Set(this.className.split(" ").filter(Boolean));
        return {
          contains: (name) => classes.has(name),
          add: (...names) => { names.forEach((name) => classes.add(name)); this.className = [...classes].join(" "); },
          remove: (...names) => { names.forEach((name) => classes.delete(name)); this.className = [...classes].join(" "); },
          toggle: (name, force) => force ? this.classList.add(name) : this.classList.remove(name),
        };
      },
      addEventListener(name, callback) { events[name] = callback; },
      fire(name, additions = {}) {
        let prevented = false;
        events[name]?.({ ...additions, preventDefault: () => { prevented = true; }, stopPropagation() {} });
        return prevented;
      },
      focus() { focused = this; },
      blur() { this.fire("blur"); },
      get parentElement() { return this.parent; },
      select() {},
      get clientWidth() { return flowWidth; },
      getBoundingClientRect() {
        if (measureText && this.classList.contains("ly-flow-lyric")) return { left: 100 };
        if (measureText && this.classList.contains("ly-flow-fragment")) {
          const prior = this.parent.children.slice(0, this.parent.children.indexOf(this));
          const left = 100 + prior.reduce((width, child) => width + measureText(child.textContent), 0);
          return { left, right: left + measureText(this.textContent) };
        }
        return { width: flowWidth ? 10 : 0 };
      },
      scrollIntoView() {},
      contains(candidate) {
        return this === candidate || this.children.some((child) => child.contains(candidate));
      },
      querySelectorAll(selector) {
        const matching = selector.startsWith("[data-ly-chord=")
          ? (item) => item.dataset.lyChord === selector.match(/"([^"]+)"/)[1]
          : (item) => selector.split(", ").some((part) => part.startsWith(".") &&
              part.slice(1).split(".").every((name) => item.classList.contains(name)));
        return all(this).filter(matching);
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0]; },
    };
    if (tag === "canvas" && measureText) {
      node.getContext = () => ({ measureText: (text) => ({ width: measureText(text) }) });
    }
    return node;
  }

  function all(node) { return node.children.flatMap((child) => [child, ...all(child)]); }
  const root = element("div");
  const editor = element("aside");
  const context = vm.createContext({
    state, song: () => book, $: (id) => id === "lyrics" ? root : id === "editor" ? editor
      : all(root).find((node) => node.id === id),
    document: {
      createElement: element,
      createTextNode(text) { return Object.assign(element("#text"), { textContent: text }); },
      get activeElement() { return focused; },
    }, window: { DocOps },
    ResizeObserver: class {
      constructor(callback) { resize = callback; }
      observe() {}
      disconnect() { resize = null; }
    },
    localStorage: { getItem: () => mode, setItem: (_, value) => { mode = value; } },
    confirm: () => { confirmations++; return discard; },
    setTimeout: (callback) => { timer = callback; return 1; },
    clearTimeout: () => { timer = null; },
    pushUndo: () => { undo += 1; }, markDirty: () => { state.dirty = true; },
    renderBars: () => { redraw += 1; }, confirmChordDraftDiscard: () => true,
    syncScanSelection: (coords) => { scan = coords; },
  });
  vm.runInContext(source, context);
  context.renderLyrics();
  return {
    book, root, state,
    chord: (key) => root.querySelector(`[data-ly-chord="${key}"]`),
    word: (text) => all(root).find((node) => node.tag === "button" &&
      (node.classList.contains("ly-text") || node.classList.contains("ly-flow-fragment")) &&
      node.textContent === text),
    flowText: () => root.querySelectorAll(".ly-flow-lyric")
      .map((line) => line.children.map((node) => node.textContent).join("")).join(" "),
    status: () => all(root).find((node) => node.id === "lyArrangeStatus").textContent,
    undo: () => undo, redraw: () => redraw, focused: () => focused, scan: () => scan,
    resizeFlow: (width) => { flowWidth = width; resize(); },
    flushClick: () => { const pending = timer; timer = null; pending?.(); },
    confirmDiscard: () => context.confirmLyricDraftDiscard(),
    confirmations: () => confirmations,
    render: () => context.renderLyrics(),
  };
}

test("Arrange renders chord controls and drags a chord across bars with one undo step", () => {
  const moved = { chord: "G7", text: "b c", observation_id: "read-7", voicing: "3,x,3,4,3,x" };
  const app = arrange([[{ chord: "C", text: "a" }, moved], [{ chord: "Dm", text: "e f" }]]);
  const token = app.chord("0:0:1");
  const column = app.word("f").parent;
  const dataTransfer = { setData() {} };
  assert.equal(token.draggable, true);
  token.fire("dragstart", { dataTransfer });
  assert.equal(column.fire("dragover", { dataTransfer }), true);
  assert.equal(dataTransfer.dropEffect, "move");
  assert.equal(column.classList.contains("drop-ok"), true);
  column.fire("drop");

  assert.deepEqual(JSON.parse(JSON.stringify(app.book.sections[0].bars)), [
    [{ chord: "C", text: "a b c" }],
    [{ chord: "Dm", text: "e" }, { ...moved, text: "f" }],
  ]);
  assert.equal(app.undo(), 1);
  assert.equal(app.redraw(), 1);
  assert.equal(app.state.dirty, true);
  assert.equal(app.focused(), app.chord("0:1:1"));
  assert.deepEqual({ ...app.scan() }, { si: 0, bi: 1, ei: 1 });
});

test("click-to-place explains a move that would strand lyrics, with no mutation", () => {
  const bars = [[{ chord: "C", text: "begin" }], [{ chord: "F", text: "then" }]];
  const app = arrange(bars);
  app.chord("0:0:0").fire("click");
  app.word("then").fire("click");
  app.flushClick();
  assert.match(app.status(), /orphan lyrics/i);
  assert.deepEqual(app.book.sections[0].bars, bars);
  assert.equal(app.undo(), 0);
  assert.equal(app.state.dirty, undefined);
});

test("double-click edits the displayed lyric and refreshes the other views", () => {
  const app = arrange([[{ chord: "C", text: "old text" }]]);
  const word = app.word("old");
  const column = word.parent;
  word.fire("dblclick");
  const input = column.children.find((node) => node.tag === "input");
  input.value = "new";
  input.fire("keydown", { key: "Enter" });
  assert.equal(app.book.sections[0].bars[0][0].text, "new text");
  assert.ok(app.word("new"));
  assert.equal(app.undo(), 1);
  assert.equal(app.redraw(), 1);
});

test("F2 opens an editor for the focused lyric", () => {
  const app = arrange([[{ chord: "C", text: "old text" }]], { mode: "flow" });
  const word = app.word("old");
  assert.equal(word.attributes["aria-keyshortcuts"], "F2");
  assert.equal(word.fire("keydown", { key: "F2" }), true);
  const field = word.parent.children.find((node) => node.tag === "input");
  field.value = "new";
  field.fire("keydown", { key: "Enter" });
  assert.equal(app.flowText(), "new text");
});

test("Flow joins words across bars and unlabelled sections while retaining chord positions", () => {
  const sections = [
    { bars: [[{ chord: "C", text: "A tris-" }], [{ chord: "G", text: "te-" }]] },
    { bars: [
      [{ chord: "Am", text: "za e se-" }], [{ chord: "F", text: "nho- ra," }],
      [{ chord: "Dm", text: "desde que o sam-" }], [{ chord: "A7", text: "ba e sam-" }],
      [{ chord: "D7", text: "ba…" }],
    ] },
  ];
  const app = arrange(null, { mode: null, sections });
  assert.equal(app.flowText(), "A tristeza e senhora, desde que o samba e samba…");
  assert.equal(app.chord("0:1:0").parent.style.insetInlineStart, "6ch");
  assert.equal(app.chord("1:0:0").parent.style.insetInlineStart, "8ch");
  assert.equal(app.word("tris").textContent, "tris");
  const syllable = app.word("te");
  syllable.fire("dblclick");
  assert.equal(syllable.parent.children.find((node) => node.tag === "input").value, "te-");
});

test("Flow can move a chord across bars while the full lyric text stays in order", () => {
  const moved = { chord: "G7", text: "b c", observation_id: "read-7" };
  const app = arrange([[{ chord: "C", text: "a" }, moved], [{ chord: "Dm", text: "e f" }]], { mode: "flow" });
  assert.equal(app.flowText(), "a b c e f");
  app.chord("0:0:1").fire("click");
  app.word("f").fire("click");
  app.flushClick();
  assert.equal(app.flowText(), "a b c e f");
  assert.deepEqual({ ...app.book.sections[0].bars[1][1] }, { ...moved, text: "f" });
  assert.equal(app.chord("0:1:1").parent.style.insetInlineStart, "8ch");
  assert.equal(app.focused(), app.chord("0:1:1"));
  assert.equal(app.undo(), 1);
});

test("resizing Flow rewraps complete words and restores selected chord focus", () => {
  const text = "A tristeza e senhora, desde que o samba e samba…";
  const app = arrange([[{ chord: "C", text }]], { mode: "flow", flowWidth: 600 });
  assert.equal(app.root.querySelectorAll(".ly-flow-lyric").length, 1);
  app.chord("0:0:0").fire("click");
  app.chord("0:0:0").focus();
  app.resizeFlow(230);
  assert.ok(app.root.querySelectorAll(".ly-flow-lyric").length > 1);
  assert.equal(app.flowText(), text);
  assert.equal(app.focused(), app.chord("0:0:0"));
  assert.equal(app.chord("0:0:0").attributes["aria-pressed"], "true");
});

test("Flow places a chord at the rendered syllable even after a wide glyph", () => {
  const width = (text) => Array.from(text).reduce((sum, character) =>
    sum + (character === "😀" ? 20 : 10), 0);
  const app = arrange([[{ chord: "C", text: "😀" }, { chord: "G", text: "oi" }]],
    { mode: "flow", flowWidth: 300, measureText: width });
  assert.equal(app.flowText(), "😀 oi");
  assert.equal(app.chord("0:0:1").parent.style.insetInlineStart, "30px");
});

test("clicking an armed chord again disarms it, and double-click edits without moving", () => {
  for (const mode of ["grid", "flow"]) {
    const app = arrange([[{ chord: "C", text: "a" }, { chord: "G", text: "b c" }]], { mode });
    const chord = app.chord("0:0:1");
    chord.fire("click");
    assert.equal(chord.classList.contains("armed"), true);
    assert.equal(app.root.classList.contains("ly-moving"), true);
    assert.match(app.status(), /Moving G.*Esc/);
    chord.fire("click");
    assert.equal(chord.classList.contains("armed"), false);
    assert.equal(app.root.classList.contains("ly-moving"), false);
    chord.fire("click");
    const target = app.word("c");
    target.fire("click", { detail: 1 });
    target.fire("click", { detail: 2 });
    target.fire("dblclick");
    app.flushClick();
    assert.equal(app.undo(), 0);
    assert.ok(app.root.querySelector(".ly-edit"));
    assert.equal(app.book.sections[0].bars[0][1].text, "b c");
  }
});

test("textless lyric entries can be edited with F2 and restore focus after commit", () => {
  const app = arrange([[{ chord: "C" }]]);
  app.word("—").fire("keydown", { key: "F2" });
  const input = app.root.querySelector(".ly-edit");
  input.value = "hello";
  input.fire("keydown", { key: "Enter" });
  input.fire("blur");
  assert.equal(app.book.sections[0].bars[0][0].text, "hello");
  assert.equal(app.undo(), 1);
  assert.equal(app.focused(), app.word("hello"));
});

test("Text mode counts and aligns markers, retains invalid neighbors, and Enter advances focus", () => {
  const bars = Array.from({ length: 9 }, (_, index) => [{ chord: "C", text: `word${index}` }]);
  const app = arrange(bars, { mode: "text", discard: false });
  const rows = app.root.querySelectorAll(".ly-line-edit");
  rows[0].value = "broken";
  rows[0].fire("input");
  assert.equal(app.root.querySelectorAll(".ly-marker-count")[0].textContent, "0/4 _");
  rows[1].value = "_new _line _of _lyrics";
  rows[1].selectionStart = 6;
  rows[1].fire("input");
  const chords = app.root.querySelectorAll(".ly-chordline")[1].children;
  assert.equal(chords[1].style.insetInlineStart, "5ch");
  assert.equal(chords[1].classList.contains("active"), true);
  rows[1].fire("keydown", { key: "Enter" });
  rows[1].fire("blur");
  assert.equal(app.focused(), rows[2]);
  assert.equal(app.undo(), 1);
  assert.equal(bars[4][0].text, "new");
  assert.equal(rows[0].value, "broken");
  app.render();
  assert.equal(app.root.querySelectorAll(".ly-line-edit")[0].value, "broken");
  assert.equal(app.confirmDiscard(), false);
  assert.equal(app.confirmations(), 1);
});

test("confirmed draft discard clears persisted invalid rows", () => {
  const app = arrange([[{ chord: "C", text: "word" }]], { mode: "text" });
  const input = app.root.querySelector(".ly-line-edit");
  input.value = "invalid";
  input.fire("input");
  assert.equal(app.confirmDiscard(), true);
  app.render();
  assert.equal(app.root.querySelector(".ly-line-edit").value, "_word");
});

test("Text commits update preceding clean rows and do not append leading text twice", () => {
  const bars = Array.from({ length: 5 }, () => [{ chord: "C", text: "word" }]);
  const app = arrange(bars, { mode: "text" });
  const rows = app.root.querySelectorAll(".ly-line-edit");
  rows[1].value = "leading _last";
  rows[1].fire("input");
  rows[1].fire("keydown", { key: "Enter" });
  assert.equal(bars[3][0].text, "word leading");
  assert.match(rows[0].value, /_word leading$/);
  assert.equal(rows[1].value, "_last");
  rows[1].value = "_ending";
  rows[1].fire("input");
  rows[1].fire("keydown", { key: "Enter" });
  assert.equal(bars[3][0].text, "word leading");
  assert.equal(bars[4][0].text, "ending");
});
