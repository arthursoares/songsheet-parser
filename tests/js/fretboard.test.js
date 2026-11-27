const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const Diagram = require("../../scripts/qa_static/diagram.js");
const Audio = require("../../scripts/qa_static/voicing_audio.js");

function harness(options = {}, windowOverrides = {}) {
  const doc = { activeElement: null };
  let created = 0;
  doc.createElement = (tag) => {
    created++;
    const el = {
      tagName: tag.toUpperCase(), children: [], attrs: {}, value: "", className: "",
      appendChild(child) { this.children.push(child); return child; },
      setAttribute(name, value) { this.attrs[name] = value; },
      focus() { doc.activeElement = this; },
      set innerHTML(value) { this.children = []; },
    };
    return el;
  };
  const win = { ChordNaming: {
    getKeyTonic: () => "C", perStringNotes: () => ["C", "E"], perStringInKey: () => ["1", "3"],
  }, ...windowOverrides };
  const ctx = vm.createContext({ document: doc, window: win });
  vm.runInContext(readFileSync(join(__dirname, "../../scripts/qa_static/fretboard.js"), "utf8"), ctx);
  const container = doc.createElement("div"), changes = [];
  const fb = ctx.Fretboard(container, (v) => changes.push(Array.from(v)), options);
  const descendants = (node) => node.children.flatMap((child) => [child, ...descendants(child)]);
  const all = (cls) => descendants(container).filter((el) => el.className.split(" ").includes(cls));
  const grid = all("fb-grid")[0];
  const cell = (string, row) => grid.children[string + 1].children[row + 1];
  const mark = (string) => grid.children[string + 1].children[0];
  return { fb, doc, changes, all, grid, cell, mark, container, created: () => created,
    text: all("fb-text")[0], ctl: all("fb-ctl")[0].children };
}

test("nut and off-window fret indicators remain explicit; reveal does not edit notes", () => {
  const h = harness();
  assert.match(h.cell(0, 0).className, /fb-nut/);
  h.fb.set([3, "x", 3, 3, 3, 9]);
  assert.doesNotMatch(h.cell(0, 0).className, /fb-nut/);
  assert.equal(h.mark(5).textContent, "↓9");
  assert.match(h.mark(5).title, /Fret 9 \(below visible window\)/);
  h.mark(5).onclick();
  assert.equal(h.ctl[1].textContent, "fret 9");
  assert.equal(h.mark(0).textContent, "↑3");
  assert.match(h.mark(0).title, /above visible window/);
  assert.equal(h.changes.length, 0);
  assert.deepEqual(Array.from(h.fb.get()), [3, "x", 3, 3, 3, 9]);
  h.mark(0).onclick();
  assert.equal(h.ctl[1].textContent, "fret 3");
});

test("window buttons and committed text preserve DOM, focus and decorated content", () => {
  const h = harness(), count = h.created();
  const extra = h.doc.createElement("small");
  h.container.appendChild(extra);
  h.ctl[2].focus();
  h.ctl[2].onclick({ detail: 1 });
  assert.equal(h.doc.activeElement, h.ctl[2]);
  assert.equal(h.ctl[1].textContent, "fret 2");
  h.fb.set(["x", 20, 22, 22, 21, 20]);
  h.ctl[2].onclick({ detail: 1 });
  assert.equal(h.doc.activeElement, h.ctl[2]);
  assert.equal(h.ctl[1].textContent, "fret 20");
  assert.equal(h.ctl[2].attrs["aria-disabled"], "true");
  h.text.focus();
  h.text.value = "x,5,7,5,6,5";
  h.text.onkeydown({ key: "Enter", preventDefault() {} });
  assert.equal(h.doc.activeElement, h.text);
  assert.equal(h.all("fb-text")[0], h.text);
  assert.equal(h.ctl[1].textContent, "fret 5");
  assert.deepEqual(h.changes.at(-1), ["x", 5, 7, 5, 6, 5]);
  assert.equal(h.created(), count + 1);
  assert.equal(h.container.children.at(-1), extra);
  assert.equal(h.ctl[0].type, "button");
  assert.equal(h.ctl[2].type, "button");
});

test("window shifts preserve invalid draft and committing rejects it", () => {
  const h = harness();
  h.fb.set([3, "x", 3, 3, 3, 5]);
  h.text.value = "3,x,3,3,3,25";
  h.text.oninput();
  h.ctl[2].onclick();
  assert.equal(h.text.value, "3,x,3,3,3,25");
  assert.equal(h.fb.isValid(), false);
  assert.equal(h.fb.commit(), false);
  assert.equal(h.doc.activeElement, h.text);
  assert.equal(h.changes.length, 0);
  assert.deepEqual(Array.from(h.fb.get()), [3, "x", 3, 3, 3, 5]);
});

test("Shift+click fills a barre between anchors and direct marker cycle opens before muting", () => {
  const h = harness();
  h.cell(1, 2).onclick({});
  h.cell(5, 2).onclick({ shiftKey: true });
  assert.deepEqual(Array.from(h.fb.get()), ["x", 3, 3, 3, 3, 3]);
  h.mark(3).onclick();
  assert.equal(h.fb.get()[3], 0);
  h.mark(3).onclick();
  assert.equal(h.fb.get()[3], "x");
  h.mark(3).onclick();
  assert.equal(h.fb.get()[3], 0);
  h.mark(1).oncontextmenu({ preventDefault() {} });
  assert.equal(h.fb.get()[1], "x");
});

test("horizontal pointer drag fills skipped strings without toggling the ending note", () => {
  const h = harness();
  h.fb.set(["x", 5, 7, 5, 6, 5]);
  h.cell(1, 0).onpointerdown({ button: 0, shiftKey: true });
  h.cell(5, 0).onpointerenter({ buttons: 1, shiftKey: true });
  h.grid.onpointerup();
  h.cell(5, 0).onclick({ detail: 1, shiftKey: true });
  assert.deepEqual(Array.from(h.fb.get()), ["x", 5, 5, 5, 5, 5]);
  assert.equal(h.changes.length, 1);
  // A subsequent keyboard activation is not swallowed by an earlier drag.
  h.cell(4, 0).onclick({ detail: 0 });
  assert.equal(h.fb.get()[4], "x");
});

test("interval option is explicit and unsupported audition is hidden", () => {
  const h = harness({ showIntervals: false });
  h.fb.set(["x", 3, 2, 0, 1, 0]);
  assert.equal(h.all("fb-notes").length, 1);
  assert.equal(h.all("fb-play")[0].hidden, true);
  const standard = harness();
  standard.fb.set(["x", 3, 2, 0, 1, 0]);
  assert.equal(standard.all("fb-notes").length, 2);
  assert.equal(standard.all("fb-notes")[1].hidden, false);
});

test("audition commits valid typed voicing and rejects invalid input", async () => {
  const heard = [];
  const h = harness({}, { VoicingAudio: {
    supported: () => true,
    playVoicing: async (v) => { heard.push(v); return true; },
  } });
  const play = h.all("fb-play")[0];
  assert.equal(play.disabled, true);
  h.text.value = "3,x,3,3,3,5";
  h.text.oninput();
  assert.equal(play.disabled, false);
  await play.onclick();
  assert.deepEqual(heard, ["3,x,3,3,3,5"]);
  h.text.value = "invalid";
  h.text.oninput();
  await play.onclick();
  assert.equal(play.disabled, true);
  assert.equal(heard.length, 1);
});

test("mini diagrams expose wide stretches and leave ordinary diagrams compact", () => {
  const wide = Diagram.svg("3,x,3,3,3,12");
  assert.match(wide, /class="cdia-overflow"/);
  assert.match(wide, /Fret 12 \(below visible window\)/);
  assert.match(wide, /<\/title>\+<\/text>/);
  assert.match(wide, /height="73"/);
  const compact = Diagram.svg("x,5,7,5,6,5");
  assert.doesNotMatch(compact, /cdia-overflow/);
  assert.match(compact, /height="63"/);
});

test("shared audition decoder preserves guitar registers and rejects malformed voicings", () => {
  assert.deepEqual(Audio.voicingMidis("3,x,3,3,3,5"), [43, 53, 58, 62, 69]);
  assert.deepEqual(Audio.voicingMidis("x,5,7,5,6,5"), [50, 57, 60, 65, 69]);
  for (const v of ["3,x,3", "3,x,3,3,3,25", "3,x,3,3,3,-1", "x,x,x,x,x,x"]) {
    assert.deepEqual(Audio.voicingMidis(v), []);
  }
});

test("audition fails quietly without Web Audio or when audio initialization is rejected", async () => {
  assert.equal(await Audio.playVoicing("3,x,3,3,3,5"), false);
  const win = { AudioContext: class { constructor() { throw new Error("audio unavailable"); } } };
  const ctx = vm.createContext({ window: win });
  vm.runInContext(readFileSync(join(__dirname, "../../scripts/qa_static/voicing_audio.js"), "utf8"), ctx);
  assert.equal(await win.VoicingAudio.playVoicing("3,x,3,3,3,5"), false);
});
