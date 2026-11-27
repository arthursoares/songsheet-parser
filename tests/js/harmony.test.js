const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

const HARMONY_SOURCE = readFileSync(join(__dirname, "../../scripts/qa_static/harmony.js"), "utf8");
const APP_SOURCE = readFileSync(join(__dirname, "../../scripts/qa_static/app.js"), "utf8");

function makeElement(tag = "div", id = "") {
  const classes = new Set();
  const listeners = {};
  const attrs = new Map();
  let _innerHTML = "";
  const el = {
    tagName: tag.toUpperCase(),
    id,
    dataset: {},
    style: {},
    children: [],
    parentNode: null,
    textContent: "",
    value: "",
    offsetWidth: 0,
    offsetHeight: 0,
    _rect: { left: 0, top: 0, right: 60, bottom: 30, width: 60, height: 30 },
    classList: {
      add: (...cs) => cs.forEach((c) => classes.add(c)),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : Boolean(force);
        if (on) classes.add(c);
        else classes.delete(c);
        return on;
      },
    },
    get className() {
      return [...classes].join(" ");
    },
    set className(val) {
      classes.clear();
      String(val || "").split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
    },
    get firstChild() {
      return el.children[0] || null;
    },
    get outerHTML() {
      return `<${tag} id="${id}">${_innerHTML || el.textContent}</${tag}>`;
    },
    get innerHTML() {
      return _innerHTML;
    },
    set innerHTML(val) {
      _innerHTML = String(val ?? "");
      el.children = [];
      if (_innerHTML.includes("<span class=\"hm-blab\"")) {
        const span = makeElement("span");
        span.className = "hm-blab";
        span.offsetWidth = 20;
        el.children.push(span);
      }
      if (_innerHTML.includes("<line")) {
        const ln = makeElement("line");
        el.children.push(ln);
      }
    },
    prepend(child) { child.parentNode = el; el.children.unshift(child); },
    appendChild(child) {
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    setAttribute(name, val) {
      attrs.set(name, String(val));
      if (name === "id") el.id = String(val);
    },
    getAttribute(name) {
      return attrs.has(name) ? attrs.get(name) : null;
    },
    addEventListener(type, fn) {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(fn);
    },
    dispatchEvent(type, ev = {}) {
      for (const fn of listeners[type] || []) fn(ev);
    },
    click() {
      if (typeof el.onclick === "function") el.onclick({ target: el });
      el.dispatchEvent("click", { target: el });
    },
    querySelector(sel) {
      if (sel === "line") return el.children.find((c) => c.tagName === "LINE") || null;
      return findBySelector(el, sel);
    },
    querySelectorAll(sel) {
      return findAllBySelector(el, sel);
    },
    getBoundingClientRect() {
      return el._rect;
    },
    scrollIntoView() {},
  };
  return el;
}

function matchesSelector(node, sel) {
  if (!node) return false;
  if (sel.startsWith("#")) return node.id === sel.slice(1);
  if (sel.startsWith(".")) return node.classList?.contains(sel.slice(1));
  return node.tagName === sel.toUpperCase();
}

function findBySelector(root, sel) {
  for (const child of root.children || []) {
    if (matchesSelector(child, sel)) return child;
    const nested = findBySelector(child, sel);
    if (nested) return nested;
  }
  return null;
}

function findAllBySelector(root, sel) {
  const out = [];
  for (const child of root.children || []) {
    if (matchesSelector(child, sel)) out.push(child);
    out.push(...findAllBySelector(child, sel));
  }
  return out;
}

function createHarmonyHarness(options = {}) {
  const elements = new Map();
  const ids = [
    "hmHead", "hmKeybar", "hmLegend", "hmTensionSvg", "hmBassSvg",
    "hmRibbonSvg", "hmCursorSvg", "hmScoreWrap", "hmBrackets", "hmScore",
    "hmPanel", "hmTip", "hmPlayBtn", "hmTempo", "hmTempoVal",
    "hmAudioState", "hmExportJson", "hmExportCsv", "hmExportHtml",
    "hmExportPdf", "hmExportMsg", "hmStopBtn", "hmVolume", "hmMuteBtn", "hmFollow", "harmony", "bars",
  ];
  for (const id of ids) {
    const el = makeElement("div", id);
    if (id === "hmTempo") el.value = "120";
    if (id === "hmScoreWrap") {
      el.offsetWidth = 800;
      el._rect = { left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400 };
    }
    elements.set(id, el);
  }
  const hmLanesEl = makeElement("div");
  hmLanesEl.className = "hm-lanes";

  const cssVars = {
    "--fn-tonic": "#3fb950",
    "--fn-subdominant": "#6ea8fe",
    "--fn-dominant": "#f0883e",
    "--fn-secondary": "#9d8df1",
    "--fn-passing": "#5bb3a6",
    "--fn-chromatic": "#8a93a3",
    "--fn-chrombass": "#c8a26b",
    "--text": "#e6e8ee",
    "--muted": "#9aa3b2",
  };

  let spelling = options.spelling || "sharp";
  let rafSeq = 0;
  const rafQueue = new Map();
  const cancelledRafs = [];
  const resizeObservers = [];
  const windowListeners = {};

  class MockResizeObserver {
    constructor(cb) {
      this.cb = cb;
      this.observed = [];
      resizeObservers.push(this);
    }
    observe(target) {
      this.observed.push(target);
    }
    disconnect() {}
    trigger(entries = []) {
      this.cb(entries, this);
    }
  }

  let audioTime = 0;
  const audioCreated = { oscillators: [], gains: [], resumed: 0 };

  class MockAudioContext {
    constructor() {
      this.state = options.audioState || "running";
      this.destination = {};
    }
    get currentTime() {
      return audioTime;
    }
    resume() {
      audioCreated.resumed += 1;
      this.state = "running";
      return Promise.resolve();
    }
    createOscillator() {
      const osc = {
        type: "sine",
        frequency: { value: 440 },
        startedAt: null,
        stoppedAt: [],
        stopCalls: 0,
        _ended: false,
        onended: null,
        connect() {},
        start(t) { osc.startedAt = t; },
        stop(t) {
          osc.stopCalls += 1;
          osc.stoppedAt.push(t);
        },
      };
      audioCreated.oscillators.push(osc);
      return osc;
    }
    createGain() {
      if (options.timeAwareAudio) {
        let defaultValue = 0;
        let timeline = [];
        const gainParam = {
          events: [],
          cancelledAt: [],
          get value() {
            let cur = defaultValue;
            let prevTime = 0;
            for (const ev of timeline) {
              if (ev.time <= audioTime) {
                cur = ev.value;
                prevTime = ev.time;
              } else {
                if (ev.kind === "ramp" && ev.time > prevTime) {
                  const frac = Math.max(0, Math.min(1, (audioTime - prevTime) / (ev.time - prevTime)));
                  return cur + (ev.value - cur) * frac;
                }
                break;
              }
            }
            return cur;
          },
          set value(v) {
            defaultValue = v;
          },
          setValueAtTime(v, t) {
            timeline.push({ kind: "set", value: v, time: t });
            timeline.sort((a, b) => a.time - b.time);
            gainParam.events.push(["set", v, t]);
          },
          linearRampToValueAtTime(v, t) {
            timeline.push({ kind: "ramp", value: v, time: t });
            timeline.sort((a, b) => a.time - b.time);
            gainParam.events.push(["ramp", v, t]);
          },
          cancelScheduledValues(t) {
            timeline = timeline.filter((ev) => ev.time < t);
            gainParam.cancelledAt.push(t);
          },
        };
        const gainNode = { gain: gainParam, connect() {} };
        audioCreated.gains.push(gainNode);
        return gainNode;
      }
      const gainNode = {
        gain: {
          value: 0,
          events: [],
          cancelledAt: [],
          setValueAtTime(v, t) {
            gainNode.gain.value = v;
            gainNode.gain.events.push(["set", v, t]);
          },
          linearRampToValueAtTime(v, t) {
            gainNode.gain.events.push(["ramp", v, t]);
          },
          cancelScheduledValues(t) {
            gainNode.gain.cancelledAt.push(t);
          },
        },
        connect() {},
      };
      audioCreated.gains.push(gainNode);
      return gainNode;
    }
  }

  const state = options.state || {
    album: "album1",
    file: "song1.json",
    activeView: "harmony",
    doc: { songs: [{ title: "Test Song", sections: [] }] },
  };

  const docObj = {
    styleSheets: options.styleSheets || [],
    getElementById(id) {
      if (elements.has(id)) return elements.get(id);
      for (const el of elements.values()) {
        const found = findBySelector(el, "#" + id);
        if (found) return found;
      }
      return null;
    },
    createElement: (tag) => makeElement(tag),
    createTextNode: (txt) => ({ textContent: String(txt ?? "") }),
    querySelector(sel) {
      if (sel === "#harmony .hm-lanes") return hmLanesEl;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === "#hmBrackets .hm-bracket") {
        return elements.get("hmBrackets").children.filter((c) => c.classList.contains("hm-bracket"));
      }
      return [];
    },
    documentElement: {},
    fonts: null,
  };

  const windowObj = {
    innerWidth: options.innerWidth ?? 1024,
    innerHeight: options.innerHeight ?? 768,
    addEventListener(type, fn) {
      if (!windowListeners[type]) windowListeners[type] = [];
      windowListeners[type].push(fn);
    },
    ChordNaming: options.omitChordNaming ? undefined : {
      getSpelling: () => spelling,
      setSpelling: (next) => { spelling = next; },
      setKeyTonic() {},
    },
    ChordDiagram: { svg: (v) => `<svg data-v="${v}"></svg>` },
    AudioContext: MockAudioContext,
  };

  const context = vm.createContext({
    window: windowObj,
    document: docObj,
    state,
    $: (id) => docObj.getElementById(id),
    song: () => state.doc?.songs?.[0] || null,
    songKey: () => state.doc?.songs?.[0]?.key || "",
    esc: (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
    getComputedStyle: () => ({
      getPropertyValue: (name) => cssVars[name] || "",
    }),
    requestAnimationFrame(fn) {
      const id = ++rafSeq;
      rafQueue.set(id, fn);
      return id;
    },
    cancelAnimationFrame(id) {
      cancelledRafs.push(id);
      rafQueue.delete(id);
    },
    ResizeObserver: options.omitResizeObserver ? undefined : MockResizeObserver,
    fetch: options.fetch || (async () => ({ ok: true, json: async () => ({ events: [], devices: [], summary: {} }) })),
    setTimeout: () => 1,
    undo() {},
    redo() {},
    pushUndo() {},
    markDirty() {},
    renderBars() {},
    showView() {},
    openEditor() {},
    console,
    Math,
    Number,
    String,
    Array,
    Map,
    Set,
    JSON,
    Promise,
  });

  vm.runInContext(readFileSync(join(__dirname, "../../scripts/qa_static/voicing_audio.js"), "utf8"), context, { filename: "voicing_audio.js" });
  vm.runInContext(HARMONY_SOURCE, context, { filename: "harmony.js" });

  return {
    context,
    elements,
    state,
    windowObj,
    docObj,
    setSpelling(next) { spelling = next; },
    setAudioTime(t) {
      audioTime = t;
      if (options.timeAwareAudio) {
        for (const osc of audioCreated.oscillators) {
          const stopAt = osc.stoppedAt.length ? osc.stoppedAt[osc.stoppedAt.length - 1] : null;
          if (!osc._ended && stopAt != null && audioTime >= stopAt) {
            osc._ended = true;
            if (typeof osc.onended === "function") osc.onended();
          }
        }
      }
    },
    getAudioTime() { return audioTime; },
    audioCreated,
    resizeObservers,
    windowListeners,
    rafQueue,
    cancelledRafs,
    flushRaf() {
      const pending = [...rafQueue.entries()];
      rafQueue.clear();
      for (const [, fn] of pending) fn();
    },
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("flat-key tonicization ribbon produces valid non-empty CSS colors for all flats and unicode", () => {
  const h = createHarmonyHarness();
  const targets = ["Bb", "Eb", "Ab", "Db", "Gb", "Cb", "Fb", "B♭", "F♯", "C#", null, "??"];
  const events = targets.map((t, i) => ({ idx: i, tonic_target: t }));
  const xs = events.map((_, i) => 50 + i * 60);

  h.context.hmBuildRibbon({ key: { tonic_name: "F" }, events }, xs);

  const svg = h.elements.get("hmRibbonSvg").innerHTML;
  const fills = [...svg.matchAll(/<rect[^>]*\bfill="([^"]*)"/g)].map((m) => m[1]);
  const strokes = [...svg.matchAll(/<rect[^>]*\bstroke="([^"]*)"/g)].map((m) => m[1]);

  assert.equal(fills.length, targets.length);
  for (const fill of fills) {
    assert.ok(fill.length > 0, "ribbon rect fill must never be empty");
    assert.notEqual(fill, "undefined");
  }
  for (const stroke of strokes) {
    assert.ok(stroke.length > 0, "ribbon rect stroke must never be empty");
    assert.notEqual(stroke, "undefined");
  }
  // Bb, Eb, Ab, Db, Gb all resolve to valid pitch classes (never falling back to chromatic gray)
  // while unparseable "??" falls back to --fn-chromatic (#8a93a3).
  assert.equal(fills[targets.length - 1], "#8a93a3");
  // Bb and B♭ resolve to the same pitch class (10), hence the same color
  assert.equal(fills[0], fills[7]);
  assert.match(svg, /→ Bb/);
});

test("hmNoteToPc and hmKeyName handle sharps, flats, Unicode accidentals, and keySel normalization", () => {
  const h = createHarmonyHarness();
  assert.equal(h.context.hmNoteToPc("Bb"), 10);
  assert.equal(h.context.hmNoteToPc("Eb"), 3);
  assert.equal(h.context.hmNoteToPc("Ab"), 8);
  assert.equal(h.context.hmNoteToPc("Db"), 1);
  assert.equal(h.context.hmNoteToPc("Gb"), 6);
  assert.equal(h.context.hmNoteToPc("Cb"), 11);
  assert.equal(h.context.hmNoteToPc("Fb"), 4);
  assert.equal(h.context.hmNoteToPc("B♭"), 10);
  assert.equal(h.context.hmNoteToPc("F♯"), 6);
  assert.equal(h.context.hmNoteToPc("invalid"), -1);

  assert.equal(h.context.hmKeyName("Bb", "major"), "A#");
  assert.equal(h.context.hmKeyName("Db", "minor"), "C#m");
  assert.equal(h.context.hmKeyName("B♭", "major"), "A#");
});

test("ChordNaming.getSpelling() controls pitch names in hmBuildBass, hmPanel, hmKeybar, and hmBuildRibbon", () => {
  const h = createHarmonyHarness({ spelling: "flat" });
  const analysis = {
    key: {
      tonic_name: "Bb",
      mode: "major",
      how: "cadence",
      candidates: [{ tonic_pc: 10, mode: "major", how: "ks" }],
    },
    events: [
      {
        idx: 0,
        symbol: "Bbmaj7",
        roman: "Imaj7",
        function: "tonic",
        func_label: "home",
        notes: [10, 2, 5, 9],
        midis: [46, 53, 58, 62],
        bass_physical: 10,
        tonic_target: "A#",
        confidence: "high",
      },
      {
        idx: 1,
        symbol: "Eb7",
        roman: "IV7",
        function: "subdominant",
        func_label: "pre-dom",
        notes: [3, 7, 10, 1],
        midis: [39, 46, 51, 55],
        bass_physical: 3,
        tonic_target: "D#",
        confidence: "high",
      },
    ],
  };

  h.context.hmKeybar(analysis);
  const keybarHtml = h.elements.get("hmKeybar").children.map((c) => c.innerHTML).join("\n");
  assert.match(keybarHtml, />Bb major \(ks\)</);

  h.context.hmBuildBass(analysis.events, [100, 300]);
  assert.match(h.elements.get("hmBassSvg").innerHTML, />Bb</);
  assert.match(h.elements.get("hmBassSvg").innerHTML, />Eb</);
  assert.doesNotMatch(h.elements.get("hmBassSvg").innerHTML, />A#</);

  h.context.hmBuildRibbon(analysis, [100, 300]);
  assert.match(h.elements.get("hmRibbonSvg").innerHTML, /→ Bb/);
  assert.match(h.elements.get("hmRibbonSvg").innerHTML, /→ Eb/);

  h.context.hmPanel(analysis.events[0]);
  const panelHtml = h.elements.get("hmPanel").innerHTML;
  assert.match(panelHtml, /Bb D F A/);
  assert.match(panelHtml, /<span>Bb<\/span>/);
  assert.match(panelHtml, /tonicizes<\/span><span>Bb<\/span>/);

  // Switch to sharp mode and re-render
  h.setSpelling("sharp");
  h.context.hmKeybar(analysis);
  const keybarSharp = h.elements.get("hmKeybar").children.map((c) => c.innerHTML).join("\n");
  assert.match(keybarSharp, />A# major \(ks\)</);

  h.context.hmBuildBass(analysis.events, [100, 300]);
  assert.match(h.elements.get("hmBassSvg").innerHTML, />A#</);
  assert.match(h.elements.get("hmBassSvg").innerHTML, />D#</);

  h.context.hmPanel(analysis.events[0]);
  assert.match(h.elements.get("hmPanel").innerHTML, /A# D F A/);
});

test("harmony.js works cleanly when window.ChordNaming and ResizeObserver are absent", () => {
  const h = createHarmonyHarness({ omitChordNaming: true, omitResizeObserver: true });
  h.context.hmBuildBass([{ midis: [46] }], [100]);
  assert.match(h.elements.get("hmBassSvg").innerHTML, />A#</);
  assert.doesNotThrow(() => h.context.hmEnsureScoreObserver());
});

test("ResizeObserver on #hmScoreWrap debounces via rAF and guards view/analysis", async () => {
  const analysis = {
    key: { tonic_name: "C", mode: "major", how: "stored" },
    summary: { events: 2 },
    events: [
      { idx: 0, section: 0, bar: 0, symbol: "Dm7", function: "subdominant", confidence: "high", beats: 2 },
      { idx: 1, section: 0, bar: 0, symbol: "G7", function: "dominant", confidence: "high", beats: 2 },
    ],
    devices: [{ type: "ii-V-I", event_idxs: [0, 1], target: "C" }],
  };
  const h = createHarmonyHarness({
    fetch: async () => ({ ok: true, json: async () => analysis }),
  });

  await h.context.renderHarmony();
  assert.equal(h.resizeObservers.length, 1);
  assert.equal(h.resizeObservers[0].observed[0], h.elements.get("hmScoreWrap"));
  assert.equal(h.resizeObservers[0].observed[1].className, "hm-lanes");

  // Initial render scheduled 1 rAF; flush it to create brackets at initial cell rects
  const cell0 = vm.runInContext("hmCellEls[0]", h.context);
  const cell1 = vm.runInContext("hmCellEls[1]", h.context);
  cell0._rect = { left: 10, top: 60, right: 70, bottom: 90 };
  cell1._rect = { left: 80, top: 60, right: 140, bottom: 90 };
  h.flushRaf();
  const brackets = h.elements.get("hmBrackets");
  assert.equal(brackets.children.length, 1);
  assert.equal(brackets.children[0].style.left, "10px");
  assert.equal(brackets.children[0].style.width, "130px");

  // Simulate pane toggle changing cell geometry & firing ResizeObserver multiple times in 1 frame
  cell0._rect = { left: 20, top: 60, right: 100, bottom: 90 };
  cell1._rect = { left: 110, top: 60, right: 200, bottom: 90 };
  h.resizeObservers[0].trigger();
  h.resizeObservers[0].trigger();
  assert.equal(h.rafQueue.size, 1, "multiple ResizeObserver ticks coalesce to 1 pending rAF");
  assert.ok(h.cancelledRafs.length >= 1, "previous pending rAF was cancelled");

  h.flushRaf();
  assert.equal(brackets.children.length, 1);
  assert.equal(brackets.children[0].style.left, "20px");
  assert.equal(brackets.children[0].style.width, "180px");

  // Guard: if view switches away from harmony BEFORE rAF fires, brackets do not build
  h.resizeObservers[0].trigger();
  assert.equal(h.rafQueue.size, 1);
  h.state.activeView = "bars";
  h.flushRaf();
  assert.equal(brackets.children.length, 0);

  // Guard: ResizeObserver ignores events when inactive or hmAnalysis is null
  h.resizeObservers[0].trigger();
  assert.equal(h.rafQueue.size, 0);

  h.state.activeView = "harmony";
  h.resizeObservers[0].trigger();
  assert.equal(h.rafQueue.size, 1);
  vm.runInContext("hmAnalysis = null;", h.context);
  assert.doesNotThrow(() => h.flushRaf());
  assert.equal(brackets.children.length, 0);
});

test("app.js #keySel change and #spellToggle click call renderHarmony only when activeView === 'harmony'", async () => {
  const elements = new Map();
  function getEl(id) {
    if (!elements.has(id)) elements.set(id, makeElement("div", id));
    return elements.get(id);
  }
  getEl("songsFilter").querySelectorAll = () => [];
  getEl("shortcutDialog").open = false;

  const state = {
    album: "a",
    file: "f.json",
    activeView: "bars",
    doc: { document: { status: "pending" }, songs: [{ key: "C", sections: [] }] },
    sel: null,
  };
  let harmonyRenderCount = 0;
  let spelling = "sharp";

  const context = vm.createContext({
    state,
    $: getEl,
    song: () => state.doc.songs[0],
    songKey: () => state.doc.songs[0].key || "",
    esc: (s) => String(s ?? ""),
    api: async () => [{ album: "a", files: ["f.json"] }],
    albums: [],
    fillSongs() {},
    loadSong() {},
    save() {},
    undo() {}, redo() {},
    showView() {},
    nextFlagged() {},
    moveChordReview() {},
    confirmDiscard: () => true,
    undo() {},
    redo() {},
    pushUndo() {},
    markDirty() {},
    renderBars() {},
    renderDict() {},
    renderPreview() {},
    renderHarmony() { harmonyRenderCount += 1; },
    openEditor() {},
    jsonApply() {},
    jsonReload() {},
    jsonFormat() {},
    copyChordmark() {},
    wireExport() {},
    wireChordReview() {},
    wireScanReview() {},
    renderSongList() {},
    updateScanSelection() {},
    ReviewUI: { recordSelected() {} },
    window: {
      ChordNaming: {
        getSpelling: () => spelling,
        setSpelling: (next) => { spelling = next; },
        setKeyTonic() {},
      },
      addEventListener() {},
    },
    document: {
      addEventListener() {},
      querySelector: () => makeElement("div"),
      documentElement: { style: { setProperty() {} } },
    },
    localStorage: { getItem: () => null, setItem() {} },
  });

  vm.runInContext(APP_SOURCE.replace(/\ninit\(\);\s*$/, ""), context, { filename: "app.js" });
  await context.init();

  // In bars view: neither keySel nor spellToggle calls renderHarmony
  getEl("keySel").value = "G";
  getEl("keySel").dispatchEvent("change", { target: getEl("keySel") });
  getEl("spellToggle").click();
  assert.equal(harmonyRenderCount, 0);

  // In harmony view: both trigger renderHarmony
  state.activeView = "harmony";
  getEl("keySel").value = "D";
  getEl("keySel").dispatchEvent("change", { target: getEl("keySel") });
  assert.equal(harmonyRenderCount, 1);
  assert.equal(state.doc.songs[0].key, "D");

  getEl("spellToggle").click();
  assert.equal(harmonyRenderCount, 2);
  assert.equal(spelling, "sharp");
});

test("Web Audio pause/resume re-triggers active chord (including % via hmLastMidis) for remaining duration", async () => {
  const analysis = {
    key: { tonic_name: "C", mode: "major", how: "stored" },
    summary: { events: 2 },
    events: [
      { idx: 0, section: 0, bar: 0, symbol: "Cmaj7", beats: 4, midis: [48, 55, 59, 64], function: "tonic", confidence: "high" },
      { idx: 1, section: 0, bar: 1, symbol: "%", is_percent: true, chord: "Cmaj7", beats: 4, midis: [], function: "tonic", confidence: "high" },
    ],
    devices: [],
  };
  const h = createHarmonyHarness({
    fetch: async () => ({ ok: true, json: async () => analysis }),
  });
  await h.context.renderHarmony();
  h.elements.get("hmTempo").value = "120"; // 0.5s/beat -> 4 beats = 2.0s

  // Play event 0 at t=1.0
  h.setAudioTime(1.0);
  await h.context.hmPlay();
  assert.equal(h.audioCreated.oscillators.length, 4);
  assert.equal(vm.runInContext("hmCurIdx", h.context), 0);
  assert.equal(vm.runInContext("hmSegDur", h.context), 2.0);

  // Pause at t=1.75 (0.75s elapsed, 1.25s remaining)
  h.setAudioTime(1.75);
  h.context.hmPause();
  assert.equal(vm.runInContext("hmPausedAt", h.context), 0.75);
  for (const osc of h.audioCreated.oscillators) {
    assert.equal(osc.stopCalls, 2); // initial scheduled stop + pause silence stop
  }

  // Resume at t=5.0 -> must re-trigger 4 oscillators for remaining 1.25s
  h.setAudioTime(5.0);
  await h.context.hmPlay();
  assert.equal(h.audioCreated.oscillators.length, 8);
  assert.equal(vm.runInContext("hmSegStart", h.context), 4.25);
  for (const osc of h.audioCreated.oscillators.slice(4)) {
    assert.equal(osc.startedAt, 5.0);
    assert.ok(Math.abs(osc.stoppedAt[0] - (5.0 + 1.25 + 0.05)) < 1e-6);
  }

  // Advance into event 1 ('%'), which carries hmLastMidis
  h.setAudioTime(6.3);
  h.flushRaf();
  assert.equal(vm.runInContext("hmCurIdx", h.context), 1);
  assert.equal(h.audioCreated.oscillators.length, 12);

  // Pause and resume on '%' event
  h.setAudioTime(6.8); // 0.55s into event 1 (note: onset at t=6.3 -> elapsed 0.5s, rem = 1.5s)
  h.context.hmPause();
  assert.ok(Math.abs(vm.runInContext("hmPausedAt", h.context) - 0.5) < 1e-6);

  h.setAudioTime(8.0);
  await h.context.hmPlay();
  assert.equal(h.audioCreated.oscillators.length, 16, "% event must re-trigger carried chord on resume");
  const resumedOsc = h.audioCreated.oscillators[12];
  assert.equal(resumedOsc.startedAt, 8.0);
  assert.ok(Math.abs(resumedOsc.stoppedAt[0] - (8.0 + 1.5 + 0.05)) < 1e-6);
});

test("live #hmTempo input rescales active hmSegDur, hmSegStart, and hmPausedAt proportionally", async () => {
  const analysis = {
    key: { tonic_name: "C", mode: "major", how: "stored" },
    summary: { events: 1 },
    events: [
      { idx: 0, section: 0, bar: 0, symbol: "Cmaj7", beats: 4, midis: [48, 55, 59, 64], function: "tonic", confidence: "high" },
    ],
    devices: [],
  };
  const h = createHarmonyHarness({
    fetch: async () => ({ ok: true, json: async () => analysis }),
  });
  await h.context.renderHarmony();

  const tempoEl = h.elements.get("hmTempo");
  tempoEl.value = "120"; // 4 beats = 2.0s

  // Start at t=0
  h.setAudioTime(0);
  await h.context.hmPlay();
  assert.equal(vm.runInContext("hmSegDur", h.context), 2.0);

  // At t=1.0 (50% progress), drag tempo to 60 BPM (4 beats = 4.0s)
  h.setAudioTime(1.0);
  tempoEl.value = "60";
  tempoEl.oninput();
  assert.equal(h.elements.get("hmTempoVal").textContent, "60");
  assert.equal(vm.runInContext("hmSegDur", h.context), 4.0);
  assert.equal(vm.runInContext("hmSegStart", h.context), -1.0); // (1.0 - (-1.0)) / 4.0 === 0.5
  for (const osc of h.audioCreated.oscillators) {
    assert.equal(osc.stopCalls, 1, "must never call o.stop() twice on tempo change");
  }
  const firstGain = h.audioCreated.gains[1]; // index 0 is hmMaster
  assert.ok(firstGain.gain.cancelledAt.includes(1.0));
  assert.ok(firstGain.gain.events.some(([kind, val, t]) => kind === "ramp" && val === 0.0001 && Math.abs(t - 3.0) < 1e-6));

  // Pause at t=2.0 -> 3.0s elapsed out of 4.0s (75% progress)
  h.setAudioTime(2.0);
  h.context.hmPause();
  assert.equal(vm.runInContext("hmPausedAt", h.context), 3.0);

  // While paused, drag tempo back to 120 BPM (newSegDur = 2.0s -> pausedAt becomes 1.5s)
  tempoEl.value = "120";
  tempoEl.oninput();
  assert.equal(vm.runInContext("hmSegDur", h.context), 2.0);
  assert.equal(vm.runInContext("hmPausedAt", h.context), 1.5);

  // Resume at t=10.0 -> plays remaining 0.5s
  h.setAudioTime(10.0);
  await h.context.hmPlay();
  const resumed = h.audioCreated.oscillators[4];
  assert.ok(Math.abs(resumed.stoppedAt[0] - (10.0 + 0.5 + 0.05)) < 1e-6);
});

test("hmPlay aborts cleanly if view switches or analysis clears during async audio resume", async () => {
  const analysis = {
    key: { tonic_name: "C", mode: "major", how: "stored" },
    summary: { events: 1 },
    events: [{ idx: 0, section: 0, bar: 0, symbol: "C", beats: 2, midis: [48, 52, 55], function: "tonic", confidence: "high" }],
    devices: [],
  };
  const h = createHarmonyHarness({
    audioState: "suspended",
    fetch: async () => ({ ok: true, json: async () => analysis }),
  });
  await h.context.renderHarmony();
  const playPromise = h.context.hmPlay();
  h.state.activeView = "bars";
  await playPromise;
  assert.equal(vm.runInContext("hmPlaying", h.context), false);
  assert.equal(h.audioCreated.oscillators.length, 0);
});

test("renderHarmony clears stale DOM on loading & !state.doc, guards races, and shows Retry on error", async () => {
  const d1 = deferred();
  const d2 = deferred();
  let call = 0;
  let shouldFail = false;

  const analysisA = {
    key: { tonic_name: "C", mode: "major", how: "stored" },
    summary: { events: 1 },
    events: [{ idx: 0, section: 0, bar: 0, symbol: "Cmaj7", beats: 4, midis: [48, 52, 55, 59], function: "tonic", confidence: "high" }],
    devices: [],
  };
  const analysisB = {
    key: { tonic_name: "F", mode: "major", how: "stored" },
    summary: { events: 1 },
    events: [{ idx: 0, section: 0, bar: 0, symbol: "Fmaj7", beats: 4, midis: [41, 45, 48, 52], function: "tonic", confidence: "high" }],
    devices: [],
  };

  const h = createHarmonyHarness({
    fetch: async () => {
      call += 1;
      if (call === 1) return { ok: true, json: async () => analysisA };
      if (call === 2) return d1.promise;
      if (call === 3) return d2.promise;
      if (shouldFail) return { ok: false, status: 500, json: async () => ({ error: "analysis boom" }) };
      return { ok: true, json: async () => analysisB };
    },
  });

  // Load Song A
  await h.context.renderHarmony();
  assert.ok(h.elements.get("hmScore").children.length > 0);
  assert.ok(h.elements.get("hmBassSvg").innerHTML.length > 0);

  // Switch to Song B and start slow fetch -> stale Song A lanes/score must clear immediately
  const docB = { songs: [{ title: "Song B", sections: [] }] };
  h.state.file = "songB.json";
  h.state.doc = docB;
  const pSongBStale = h.context.renderHarmony();
  assert.equal(vm.runInContext("hmAnalysis", h.context), null);
  assert.equal(h.elements.get("hmBassSvg").innerHTML, "");
  assert.equal(h.elements.get("hmRibbonSvg").innerHTML, "");
  assert.equal(h.elements.get("hmTensionSvg").innerHTML, "");
  assert.equal(h.elements.get("hmKeybar").innerHTML, "");
  assert.match(h.elements.get("hmScore").innerHTML, /Analyzing harmony/);

  // Trigger newer request before call 2 finishes
  const pSongBNewer = h.context.renderHarmony();
  d2.resolve({ ok: true, json: async () => analysisB });
  await pSongBNewer;
  assert.equal(vm.runInContext("hmAnalysis", h.context).key.tonic_name, "F");

  // Resolve older call 2 with Song A -> must be ignored!
  d1.resolve({ ok: true, json: async () => analysisA });
  await pSongBStale;
  assert.equal(vm.runInContext("hmAnalysis", h.context).key.tonic_name, "F");

  // Trigger HTTP error -> shows .hm-error + #hmRetryBtn; clicking Retry recovers
  shouldFail = true;
  await h.context.renderHarmony();
  assert.equal(vm.runInContext("hmAnalysis", h.context), null);
  assert.match(h.elements.get("hmHead").textContent, /analysis boom/);
  const retryBtn = h.docObj.getElementById("hmRetryBtn");
  assert.ok(retryBtn, "#hmRetryBtn must be rendered inside .hm-error");
  assert.equal(h.elements.get("hmKeybar").children[0].className, "hm-error");

  shouldFail = false;
  retryBtn.click();
  // Let microtasks drain
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(vm.runInContext("hmAnalysis", h.context).key.tonic_name, "F");

  // !state.doc clears everything
  h.state.doc = null;
  await h.context.renderHarmony();
  assert.equal(h.elements.get("hmHead").textContent, "no song loaded");
  assert.equal(h.elements.get("hmScore").innerHTML, "");
  assert.equal(h.elements.get("hmBassSvg").innerHTML, "");
});

test("hmShowTip clamps horizontally >= 8 and flips/clamps vertically near viewport edges", () => {
  const h = createHarmonyHarness({ innerWidth: 300, innerHeight: 400 });
  const tip = h.elements.get("hmTip");
  tip.offsetWidth = 280;
  tip.offsetHeight = 90;

  // Narrow viewport where flipping left would go negative -> clamps to 8px
  h.context.hmShowTip({ clientX: 20, clientY: 50 }, "Tooltip text");
  assert.equal(tip.style.left, "8px");
  assert.equal(tip.style.top, "64px");

  // Near bottom edge -> flips above cursor
  h.context.hmShowTip({ clientX: 5, clientY: 390 }, "Bottom tip");
  assert.equal(tip.style.top, (390 - 90 - 14) + "px");
  assert.equal(tip.style.left, "8px");
});

test("hmSnapshotHtml collects :root/.hm-/#hm/.muted rules and skips throwing or null-cssRules sheets", () => {
  const h = createHarmonyHarness({
    styleSheets: [
      {
        get cssRules() {
          throw new Error("SecurityError");
        },
      },
      { cssRules: null },
      {
        cssRules: [
          { selectorText: ":root", cssText: ":root { --bg: #0f1115; }" },
          { selectorText: ".hm-error", cssText: ".hm-error { color: red; }" },
          { selectorText: "#hmScoreWrap", cssText: "#hmScoreWrap { position: relative; }" },
          { selectorText: ".muted", cssText: ".muted { color: gray; }" },
          { selectorText: ".unrelated", cssText: ".unrelated { display: none; }" },
        ],
      },
    ],
  });

  const snap = h.context.hmSnapshotHtml();
  assert.match(snap, /:root \{ --bg: #0f1115; \}/);
  assert.match(snap, /\.hm-error \{ color: red; \}/);
  assert.match(snap, /#hmScoreWrap \{ position: relative; \}/);
  assert.match(snap, /\.muted \{ color: gray; \}/);
  assert.doesNotMatch(snap, /\.unrelated/);
});

test("hmOnTempoInput never resurrects decayed prior-chord voices across chord boundaries (time-aware AudioParam)", async () => {
  const analysis = {
    key: { tonic_name: "C", mode: "major", how: "stored" },
    summary: { events: 2 },
    events: [
      { idx: 0, section: 0, bar: 0, symbol: "Cmaj7", beats: 4, midis: [48, 52, 55, 59], function: "tonic", confidence: "high" },
      { idx: 1, section: 0, bar: 1, symbol: "G7", beats: 4, midis: [43, 47, 50, 53], function: "dominant", confidence: "high" },
    ],
    devices: [],
  };

  // Probe 1: Speedup across chord boundary (50 BPM -> 200 BPM -> advance to Chord 1 -> 195 BPM)
  {
    const h = createHarmonyHarness({
      timeAwareAudio: true,
      fetch: async () => ({ ok: true, json: async () => analysis }),
    });
    await h.context.renderHarmony();
    const tempoEl = h.elements.get("hmTempo");
    tempoEl.value = "50"; // 4 beats = 4.8s; Chord 0 o.stop at 4.85s

    h.setAudioTime(0);
    await h.context.hmPlay();
    assert.equal(h.audioCreated.oscillators.length, 4);

    // At t=0.50, speed up to 200 BPM (hmSegDur = 1.2s, Chord 0 ends at 1.575s)
    h.setAudioTime(0.5);
    tempoEl.value = "200";
    tempoEl.oninput();

    // At t=1.60, advance hmFrame() to Chord 1 while Chord 0 oscillators still await o.stop(4.85)
    h.setAudioTime(1.6);
    h.flushRaf();
    assert.equal(vm.runInContext("hmCurIdx", h.context), 1);
    assert.equal(h.audioCreated.oscillators.length, 8);
    const chord0Gains = h.audioCreated.gains.slice(1, 5); // index 0 is hmMaster
    const chord1Gains = h.audioCreated.gains.slice(5, 9);
    for (const g of chord0Gains) {
      assert.ok(g.gain.value <= 0.0001, "Chord 0 gain must be decayed at chord boundary");
    }

    // At t=1.70, nudge #hmTempo to 195 BPM -> must NOT boost Chord 0 voices above 0.0001
    h.setAudioTime(1.7);
    tempoEl.value = "195";
    tempoEl.oninput();

    for (const g of chord0Gains) {
      assert.ok(g.gain.value <= 0.0001, `Chord 0 zombie voice resurrected to ${g.gain.value}`);
      assert.deepEqual(g.gain.cancelledAt, [0.5], "decayed prior-chord voice must not be rescheduled at t=1.7");
    }
    for (const g of chord1Gains) {
      assert.ok(g.gain.value > 0.4, "active Chord 1 voices remain sounding");
      assert.deepEqual(g.gain.cancelledAt, [1.7], "active Chord 1 voices rescale at t=1.7");
    }
  }

  // Probe 2: Constant tempo within 50ms tail across chord boundary (120 BPM -> advance at t=2.01 -> 118 BPM at t=2.02)
  {
    const h = createHarmonyHarness({
      timeAwareAudio: true,
      fetch: async () => ({ ok: true, json: async () => analysis }),
    });
    await h.context.renderHarmony();
    const tempoEl = h.elements.get("hmTempo");
    tempoEl.value = "120"; // 4 beats = 2.0s; Chord 0 o.stop at 2.05s

    h.setAudioTime(0);
    await h.context.hmPlay();
    assert.equal(h.audioCreated.oscillators.length, 4);

    // At t=2.01 (inside Chord 0's 50ms tail), hmFrame() advances to Chord 1
    h.setAudioTime(2.01);
    h.flushRaf();
    assert.equal(vm.runInContext("hmCurIdx", h.context), 1);
    assert.equal(h.audioCreated.oscillators.length, 8);
    const chord0Gains = h.audioCreated.gains.slice(1, 5);
    const chord1Gains = h.audioCreated.gains.slice(5, 9);
    for (const g of chord0Gains) {
      assert.ok(g.gain.value <= 0.0001);
    }

    // At t=2.02, drag #hmTempo to 118 BPM
    h.setAudioTime(2.02);
    tempoEl.value = "118";
    tempoEl.oninput();

    for (const g of chord0Gains) {
      assert.ok(g.gain.value <= 0.0001, `Chord 0 tail voice resurrected to ${g.gain.value}`);
      assert.deepEqual(g.gain.cancelledAt, []);
    }
    for (const g of chord1Gains) {
      assert.ok(g.gain.value > 0.25, "active Chord 1 voices remain sounding during attack/sustain");
      assert.deepEqual(g.gain.cancelledAt, [2.02]);
    }

    // Advancing past 2.05s fires onended and prunes Chord 0 voices from hmActiveVoices
    h.setAudioTime(2.06);
    assert.equal(vm.runInContext("hmActiveVoices.length", h.context), 4);
  }
});

test("hmHeader and hmKeybar format sharp-stored and cadence tonic_name via hmFormatNoteLabel in flat mode", () => {
  const h = createHarmonyHarness({ spelling: "flat" });

  // Stored key A# disagreeing with cadence D# -> displayed as Bb and Eb in flat mode
  const storedAnalysis = {
    key: {
      tonic_name: "A#",
      mode: "major",
      how: "stored",
      cadence_agrees: false,
      candidates: [{ tonic_name: "D#", tonic_pc: 3, mode: "major", how: "cadence" }],
    },
    summary: { events: 4 },
  };
  assert.match(h.context.hmHeader(storedAnalysis), /^key Bb major \(stored\)/);
  h.context.hmKeybar(storedAnalysis);
  const storedBarText = h.elements.get("hmKeybar").children.map((c) => c.textContent).join(" | ");
  assert.match(storedBarText, /it suggests Eb major/);
  assert.match(storedBarText, /Use Eb major instead/);

  // Inferred key A# with candidate G# -> displayed as Bb and Ab in flat mode
  const inferredAnalysis = {
    key: {
      tonic_name: "A#",
      mode: "major",
      how: "cadence",
      confidence: "high",
      candidates: [{ tonic_name: "G#", tonic_pc: 8, mode: "minor", how: "ks" }],
    },
    summary: { events: 4 },
  };
  assert.match(h.context.hmHeader(inferredAnalysis), /^key Bb major \(cadence, confidence high\)/);
  h.context.hmKeybar(inferredAnalysis);
  const inferredText = h.elements.get("hmKeybar").children.map((c) => c.textContent).join(" | ");
  const inferredHtml = h.elements.get("hmKeybar").children.map((c) => c.innerHTML).join("\n");
  assert.match(inferredText, /inferred key Bb major/);
  assert.match(inferredText, /Confirm key Bb major/);
  assert.match(inferredHtml, />Ab minor \(ks\)</);

  // Switch back to sharp mode -> preserves sharp tonic_name
  h.setSpelling("sharp");
  assert.match(h.context.hmHeader(storedAnalysis), /^key A# major \(stored\)/);
  h.context.hmKeybar(storedAnalysis);
  const sharpBarText = h.elements.get("hmKeybar").children.map((c) => c.textContent).join(" | ");
  assert.match(sharpBarText, /it suggests D# major/);
  assert.match(sharpBarText, /Use D# major instead/);
});

function interactiveAnalysis() {
  return {
    key: { tonic_name: "C", mode: "major", how: "stored" }, summary: { events: 3 },
    events: [1, 3, 2].map((beats, idx) => ({ idx, section: 0, bar: idx, bar_in_section: idx, pos: 0,
      beats, symbol: ["Dm7", "G7", "C"][idx], function: ["subdominant", "dominant", "tonic"][idx],
      confidence: "high", midis: [48 + idx, 55, 60], devices: ["ii-V-I"] })),
    devices: [{ type: "ii-V-I", event_idxs: [0, 1, 2], target: "C" }],
  };
}

test("beat-weighted lanes retain pixel dimensions and click-to-seek keeps the requested event", async () => {
  const analysis = interactiveAnalysis();
  const h = createHarmonyHarness({ fetch: async () => ({ ok: true, json: async () => analysis }) });
  await h.context.renderHarmony();
  const xs = h.context.hmXs(analysis.events, 644);
  assert.deepEqual(Array.from(xs), [32, 132, 432]);
  assert.equal(h.elements.get("hmTensionSvg").getAttribute("viewBox"), "0 0 1000 90");
  const svg = h.elements.get("hmTensionSvg");
  const seekXs = h.context.hmXs(analysis.events);
  svg.onclick({ clientX: seekXs[1] + 5 });
  assert.equal(vm.runInContext("hmCurIdx", h.context), 1);
  assert.equal(vm.runInContext("hmSelected", h.context), 1);
  await h.context.hmPlay();
  assert.equal(vm.runInContext("hmCurIdx", h.context), 1, "play resumes at the sought event, without advancing");
  assert.equal(h.audioCreated.oscillators[0].frequency.value, 440 * 2 ** ((49 - 69) / 12));
  assert.match(h.elements.get("hmAudioState").textContent, /bar 2 \/ 3 · event 2 \/ 3/);
  h.elements.get("hmStopBtn").click();
  assert.equal(vm.runInContext("hmCurIdx", h.context), -1);
  assert.equal(vm.runInContext("hmActiveVoices.length", h.context), 0);
});

test("manual selection disables panel follow until explicitly enabled, and volume/mute control master gain", async () => {
  const analysis = interactiveAnalysis();
  const h = createHarmonyHarness({ fetch: async () => ({ ok: true, json: async () => analysis }) });
  await h.context.renderHarmony();
  await h.context.hmPlay();
  h.context.hmSelect(2);
  h.setAudioTime(.6); h.flushRaf();
  assert.equal(vm.runInContext("hmCurIdx", h.context), 1);
  assert.equal(vm.runInContext("hmSelected", h.context), 2);
  assert.match(h.elements.get("hmPanel").innerHTML, /hm-bigsym">C</);
  const follow = h.elements.get("hmFollow"); follow.checked = true; follow.onchange();
  assert.equal(vm.runInContext("hmSelected", h.context), 1);
  const volume = h.elements.get("hmVolume"); volume.value = "25"; volume.oninput();
  assert.equal(h.audioCreated.gains[0].gain.value, .075);
  h.elements.get("hmMuteBtn").click();
  assert.equal(h.audioCreated.gains[0].gain.value, 0);
  h.elements.get("hmMuteBtn").click();
  assert.equal(h.audioCreated.gains[0].gain.value, .075);
});

test("wrapped devices render both continuation segments and reserve row-specific bracket space", async () => {
  const analysis = interactiveAnalysis();
  const h = createHarmonyHarness({ fetch: async () => ({ ok: true, json: async () => analysis }) });
  await h.context.renderHarmony();
  const cells = vm.runInContext("hmCellEls", h.context);
  cells[0]._rect = { left: 0, right: 60, top: 30 };
  cells[1]._rect = { left: 70, right: 130, top: 30 };
  cells[2]._rect = { left: 0, right: 60, top: 120 };
  h.flushRaf();
  const brackets = h.elements.get("hmBrackets").children;
  assert.equal(brackets.length, 2);
  assert.ok(brackets[0].classList.contains("continued-after"));
  assert.ok(brackets[1].classList.contains("continued-before"));
  assert.match(brackets[0].innerHTML, /┈/);
  assert.equal(cells[0].parentNode.style.marginTop, "30px");
  assert.equal(cells[2].parentNode.style.marginTop, "30px");
});

test("Harmony edit return restores selection and scroller only for the same song", async () => {
  const analysis = interactiveAnalysis();
  const h = createHarmonyHarness({ fetch: async () => ({ ok: true, json: async () => analysis }) });
  await h.context.renderHarmony();
  h.elements.get("harmony").scrollTop = 240;
  h.context.hmEditChord(analysis.events[2]);
  h.elements.get("harmony").scrollTop = 0;
  await h.context.renderHarmony(); h.flushRaf(); h.flushRaf();
  assert.equal(vm.runInContext("hmSelected", h.context), 2);
  assert.equal(h.elements.get("harmony").scrollTop, 240);
  h.context.hmEditChord(analysis.events[1]); h.state.file = "other.json";
  await h.context.renderHarmony(); h.flushRaf(); h.flushRaf();
  assert.equal(vm.runInContext("hmSelected", h.context), null);
});

test("Stop cancels playback pending an asynchronous audio resume", async () => {
  const analysis = interactiveAnalysis();
  const h = createHarmonyHarness({ fetch: async () => ({ ok: true, json: async () => analysis }) });
  await h.context.renderHarmony();
  const pending = deferred();
  h.context.hmEnsureAudio = () => pending.promise;
  const play = h.context.hmPlay();
  h.context.hmStopPlayback();
  pending.resolve(); await play;
  assert.equal(vm.runInContext("hmPlaying", h.context), false);
  assert.equal(vm.runInContext("hmCurIdx", h.context), -1);
});

test("lane keyboard navigation seeks and preserves a manually chosen detail panel", async () => {
  const analysis = interactiveAnalysis();
  const h = createHarmonyHarness({ fetch: async () => ({ ok: true, json: async () => analysis }) });
  await h.context.renderHarmony();
  const svg = h.elements.get("hmBassSvg");
  let prevented = false;
  svg.onkeydown({ key: "End", preventDefault() { prevented = true; }, stopPropagation() {} });
  assert.equal(prevented, true);
  assert.equal(vm.runInContext("hmSelected", h.context), 2);
  assert.equal(vm.runInContext("hmCurIdx", h.context), 2);
  assert.equal(vm.runInContext("hmFollow", h.context), false);
});

test("playback completion clears the last event highlight", async () => {
  const analysis = interactiveAnalysis();
  const h = createHarmonyHarness({ fetch: async () => ({ ok: true, json: async () => analysis }) });
  await h.context.renderHarmony();
  await h.context.hmSeek(2, true);
  h.setAudioTime(2); h.flushRaf();
  assert.equal(vm.runInContext("hmPlaying", h.context), false);
  assert.equal(vm.runInContext("hmCellEls[2].classList.contains('cur')", h.context), false);
});
