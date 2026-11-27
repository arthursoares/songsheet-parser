const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const DocOps = require("../../scripts/qa_static/doc_ops.js");

function harness({ split = false, savedDoc = null, storage = new Map() } = {}) {
  const original = [
    { chord: "C", voicing: "x,3,2,0,1,0", voicing_printed: "8,x,10,9,8,x" },
    { chord: "%" },
    { chord: "Dm" },
    { chord: "G7", voicing: "3,2,0,0,0,1", voicing_printed: "3,x,3,4,3,x", observation_id: "obs-g" },
  ];
  const elements = new Map();
  let focused = null;
  let scrolled = null;
  let scanSelection = null;
  let previous = null;
  let undoCount = 0;
  let dirty = false;
  let discardDraft = true;
  let activeFretboard = null;
  const scanProposals = new WeakMap();
  function element(id) {
    const classes = new Set();
    const attributes = new Map();
    const handlers = {};
    let markup = "";
    let suggestions = [];
    let blurCount = 0;
    return {
      dataset: {},
      appendChild(child) { child.parentElement = this; },
      classList: {
        add: (value) => classes.add(value),
        remove: (value) => classes.delete(value),
        contains: (value) => classes.has(value),
        toggle: (value, force) => force ? classes.add(value) : classes.delete(value),
      },
      set innerHTML(value) {
        markup = value;
        suggestions = [...value.matchAll(/data-suggestion="(\d+)"/g)].map(() => element());
        if (id === "editor") {
          for (const field of ["edName", "edText"]) {
            get(field).value = value.match(new RegExp(`id="${field}" value="([^"]*)"`))?.[1] || "";
          }
        }
      },
      get innerHTML() { return markup; },
      querySelectorAll: () => suggestions,
      querySelector(selector) {
        const match = selector.match(/data-suggestion="(\d+)"/);
        return match ? suggestions[Number(match[1])] : null;
      },
      addEventListener: (event, handler) => { handlers[event] = handler; },
      click: (ev) => handlers.click?.(ev),
      keyDown(key) {
        let prevented = false;
        handlers.keydown?.({ key, preventDefault: () => { prevented = true; } });
        return prevented;
      },
      getAttribute: (name) => attributes.get(name) ?? null,
      setAttribute: (name, value) => attributes.set(name, value),
      removeAttribute: (name) => attributes.delete(name),
      focus() { focused = this; },
      blur() { blurCount += 1; if (focused === this) focused = null; },
      get blurCount() { return blurCount; },
      scrollIntoView() { scrolled = this; },
      showModal() { this.open = true; },
    };
  }
  function get(id) {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  }
  const state = {
    album: "album", file: "song.json", activeView: "chordReview",
    doc: savedDoc || { songs: [{ sections: [{ bars: split ? [original.slice(0, 3), original.slice(3)] : [original] }] }] },
  };
  const song = () => state.doc.songs[0];
  const chips = () => song().sections.flatMap((sec, si) =>
    sec.bars.flatMap((bar, bi) => bar.map((_entry, ei) => get(`chip:${si}:${bi}:${ei}`))));
  get("bars").querySelector = (selector) => selector === ".chip.sel"
    ? chips().find((chip) => chip.classList.contains("sel"))
    : get(`chip:${selector.match(/"([^"]+)"/)[1]}`);
  const context = vm.createContext({
    state, $: get, song,
    esc: (value) => String(value ?? ""),
    document: { querySelector: () => get("layout") },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    confirm: () => discardDraft,
    window: {
      DocOps,
      ChordDiagram: { svg: () => "" },
      ChordNaming: {
        suggestNames: () => [{ name: "Cmaj7" }, { name: "Am/C" }, { name: "C6" }, { name: "Em/C" }],
        validateName: (name) => ({ valid: name !== "not a chord" }),
        nameMatchesVoicing: () => true,
        perStringChordIntervals: () => [],
      },
      Fretboard: () => {
        let strings;
        activeFretboard = { set: (next) => { strings = next; }, get: () => strings };
        return activeFretboard;
      },
    },
    parseVoicing: (v) => v.split(","),
    scanProposal: (entry) => scanProposals.get(entry) || "",
    renderSongList() {},
    syncScanSelection: (coords) => { scanSelection = coords && { ...coords }; },
    pushUndo: () => { previous = structuredClone(state.doc); undoCount += 1; },
    markDirty: () => { dirty = true; },
    undo: () => {
      if (!previous) return;
      state.doc = previous;
      context.renderChordReview();
    },
  });
  for (const filename of ["app_views.js", "app_bars.js", "app_chord_review.js", "app.js"]) {
    const source = readFileSync(join(__dirname, "../../scripts/qa_static", filename), "utf8");
    vm.runInContext(source.replace(/\ninit\(\);\s*$/, ""), context, { filename });
  }
  context.renderBars = () => {
    if (state.activeView === "chordReview") context.renderChordReview();
    else context.syncChordChip(state.sel);
  };
  context.renderChordReview(true);

  return {
    get chips() { return chips(); },
    get entries() { return song().sections.flatMap((s) => s.bars.flat()); },
    state, get, song,
    rejectDiscard: () => { discardDraft = false; },
    addBarAfter: (si, bi) => context.addBarAfter(si, bi),
    addBarBefore: (si, bi) => context.addBarBefore(si, bi),
    splitBar: (si, bi) => context.splitBar(si, bi),
    open: (si, bi, ei) => context.openEditor(si, bi, ei, true),
    undoCount: () => undoCount,
    focused: () => focused, scrolled: () => scrolled, dirty: () => dirty,
    scanSelection: () => scanSelection,
    draftVoicing: () => activeFretboard?.get().join(","),
    setScanProposal: (entry, proposal) => scanProposals.set(entry, proposal),
    refreshScanProposal: () => vm.runInContext("syncActiveChordProposal()", context),
    wireChordReview: () => context.wireChordReview(),
    enableUnsavedDialog() {
      const source = readFileSync(join(__dirname, "../../scripts/qa_static/app_interactions.js"), "utf8");
      vm.runInContext(source, context);
      get("unsavedDialog").close = () => { get("unsavedDialog").open = false; };
    },
    requestDraftContinuation: (resume) => context.confirmChordDraftDiscard(resume),
    decide: (action, advance) => context.decideChordReview(action, advance),
    submit(options) {
      return vm.runInContext(`submitActiveChord(${JSON.stringify(options || {})})`, context);
    },
    key(key, options = {}) {
      let prevented = false;
      context.onKeydown({
        key, target: { tagName: "DIV" }, ...options,
        preventDefault: () => { prevented = true; },
      });
      return prevented;
    },
  };
}

test("chord review arrows focus, scroll, and highlight the matching sidebar chip", () => {
  const app = harness();
  assert.equal(app.focused(), app.chips[0]);
  assert.equal(app.key("ArrowRight"), true);
  assert.equal(app.focused(), app.chips[2]);
  assert.equal(app.scrolled(), app.chips[2]);
  assert.equal(app.chips[2].getAttribute("aria-current"), "true");
  assert.equal(app.chips[0].getAttribute("aria-current"), null);
  assert.match(app.get("chordReviewPosition").textContent, /Chord 2 of 3/);
  app.key("ArrowRight", { shiftKey: true });
  assert.equal(app.focused(), app.chips[3]);
  app.key("ArrowLeft", { shiftKey: true });
  assert.equal(app.focused(), app.chips[0]);

  assert.equal(app.key("ArrowRight", { target: { tagName: "INPUT" } }), false);
  app.state.activeView = "lyrics";
  assert.equal(app.key("ArrowRight"), false);
  assert.equal(app.focused(), app.chips[0]);
});

test("accept changes only the fingering and keeps navigation synchronized", () => {
  const app = harness();
  assert.equal(app.key("a", { repeat: true }), true);
  assert.equal(app.dirty(), false);
  assert.equal(app.key("a"), true);
  assert.equal(app.entries[0].voicing, app.entries[0].voicing_printed);
  assert.equal(app.entries[0].chord, "C");
  assert.equal(app.dirty(), true);
  assert.equal(app.focused(), app.chips[2]);
  assert.equal(app.key("z", { metaKey: true }), true);
  assert.equal(app.entries[0].voicing, "x,3,2,0,1,0");
});

test("marking reviewed and deferred edits the saved document and updates the queue", () => {
  const app = harness();
  app.key(" ");
  assert.equal(app.entries[0].chord_review.status, "reviewed");
  assert.equal(app.focused(), app.chips[2]);
  assert.match(app.get("chordReviewPosition").textContent, /1 flagged/);
  app.key("s");
  assert.equal(app.entries[2].chord_review.status, "deferred");
  assert.equal(app.focused(), app.chips[3]);
  assert.match(app.get("chordReviewPosition").textContent, /2 flagged/);
  app.key("ArrowLeft", { shiftKey: true });
  assert.equal(app.focused(), app.chips[2]);
  assert.match(app.get("chordReviewContext").textContent, /Deferred/);
  app.key("ArrowLeft", { shiftKey: true });
  assert.equal(app.focused(), app.chips[2]);
  assert.equal(app.dirty(), true);
});

test("undoing an accepted fingering preserves other decisions for the review pass", () => {
  const app = harness();
  app.key(" ");
  app.key("s");
  app.key("a");
  app.key("z", { metaKey: true });
  assert.match(app.get("chordReviewPosition").textContent, /2 flagged/);
  app.key("ArrowLeft", { shiftKey: true });
  assert.equal(app.focused(), app.chips[2]);
  assert.match(app.get("chordReviewContext").textContent, /Deferred/);
  app.key("ArrowLeft", { shiftKey: true });
  assert.equal(app.focused(), app.chips[2]);
});

test("saved reviews and the selected chord resume after reload", () => {
  const storage = new Map();
  const app = harness({ storage });
  app.key(" ");
  app.key("s");
  const savedDoc = JSON.parse(JSON.stringify(app.state.doc));
  const resumed = harness({ savedDoc, storage });
  assert.match(resumed.get("chordReviewPosition").textContent, /Chord 3 of 3.*1 reviewed.*1 deferred/);
  assert.equal(resumed.focused(), resumed.chips[3]);
  resumed.key("ArrowLeft", { shiftKey: true });
  assert.match(resumed.get("chordReviewContext").textContent, /Deferred/);
});

test("a reviewed chord needs re-review after its chord name changes", () => {
  const app = harness();
  app.key(" ");
  app.key("h");
  app.entries[0].chord = "Am/C";
  app.key("l");
  app.key("h");
  assert.equal(app.entries[0].chord, "Am/C");
  assert.equal(app.entries[0].chord_review.snapshot.chord, "C");
  assert.match(app.get("chordReviewContext").textContent, /Needs re-review/);
  assert.match(app.get("chordReviewPosition").textContent, /0 reviewed/);
});

test("1-4 in Chord Review marks the chord reviewed with updated snapshot (matching Bars)", () => {
  const app = harness();
  app.key("2");
  assert.equal(app.entries[0].chord, "Am/C");
  assert.equal(app.entries[0].chord_review.status, "reviewed");
  assert.equal(app.entries[0].chord_review.snapshot.chord, "Am/C");
  assert.match(app.get("chordReviewContext").textContent, /Reviewed/);
  assert.match(app.get("chordReviewPosition").textContent, /1 reviewed/);
  assert.match(app.get("chordReviewMessage").textContent, /applied and chord reviewed/i);

  // Applying a numbered suggestion on an already-reviewed chord updates both chord and snapshot.
  app.key("3");
  assert.equal(app.entries[0].chord, "C6");
  assert.equal(app.entries[0].chord_review.status, "reviewed");
  assert.equal(app.entries[0].chord_review.snapshot.chord, "C6");
  assert.match(app.get("chordReviewContext").textContent, /Reviewed/);
});

test("editor Apply marks the resulting chord reviewed in the same undo action", () => {
  const app = harness();
  app.state.activeView = "bars";
  app.key("l");
  app.get("edDeferReview").click();
  app.get("edName").value = "Cmaj7";
  app.get("edText").value = "adjusted";
  app.get("edApply").click();
  assert.equal(app.entries[0].chord, "Cmaj7");
  assert.equal(app.entries[0].text, "adjusted");
  assert.equal(app.entries[0].chord_review.status, "reviewed");
  assert.equal(app.entries[0].chord_review.snapshot.chord, "Cmaj7");
  assert.equal(app.get("edReviewStatus").textContent, "Reviewed");
  assert.equal(app.focused(), app.chips[0]);
  app.key("z", { metaKey: true });
  assert.equal(app.entries[0].chord, "C");
  assert.equal(app.entries[0].text, undefined);
  assert.equal(app.entries[0].chord_review.status, "deferred");
});

test("E edits inline; rejecting navigation retains its draft and R applies it once", () => {
  const app = harness();
  app.setScanProposal(app.entries[0], "x,3,2,0,1,0");
  assert.equal(app.key("e"), true);
  const editor = app.get("editor");
  assert.equal(editor.parentElement, app.get("chordReviewEditorSlot"));
  assert.equal(app.focused(), app.get("edName"));
  assert.equal(app.get("edScanProposal").hidden, false);
  assert.match(editor.innerHTML, /Save & review/);
  app.get("edText").value = "corrected lyric";
  app.rejectDiscard();
  app.key("ArrowRight");
  assert.equal(app.get("edText").value, "corrected lyric");
  assert.equal(app.entries[0].text, undefined);
  app.key("r");
  assert.equal(app.entries[0].text, "corrected lyric");
  assert.equal(app.entries[0].chord_review.status, "reviewed");
  assert.equal(app.undoCount(), 1);
  assert.equal(editor.parentElement, app.get("layout"));
  assert.equal(app.state.activeView, "chordReview");
});

test("Apply only saves the lyric without certifying the fingering", () => {
  const app = harness();
  app.state.activeView = "bars";
  app.open(0, 0, 0);
  app.get("edText").value = "corrected lyric";
  app.get("edApplyOnly").click();
  assert.equal(app.entries[0].text, "corrected lyric");
  assert.equal(app.entries[0].chord_review, undefined);
  assert.equal(app.undoCount(), 1);
});

test("changing an inline chord to a repeat advances to the next remaining chord", () => {
  const app = harness();
  app.key("e");
  app.get("edName").value = "%";
  assert.equal(app.key(" "), true);
  assert.equal(app.entries[0].chord, "%");
  assert.equal(app.focused(), app.chips[2]);
  assert.equal(app.get("chordReviewName").textContent, "Dm");
});

test("Apply and Continue applies a retained Bars draft while Lyrics is active", async () => {
  const app = harness();
  app.state.activeView = "bars";
  app.open(0, 0, 0);
  app.get("edName").value = "Cmaj7";
  app.get("edText").value = "retained lyric";
  app.state.activeView = "lyrics";
  app.enableUnsavedDialog();
  let resumed = 0;
  assert.equal(app.requestDraftContinuation(() => resumed++), false);
  assert.equal(app.get("unsavedDialog").open, true);
  assert.equal(app.submit(), false); // Ordinary hidden-editor shortcuts stay blocked.
  await app.get("unsavedApply").onclick();
  assert.equal(app.entries[0].chord, "Cmaj7");
  assert.equal(app.entries[0].text, "retained lyric");
  assert.equal(app.entries[0].chord_review.status, "reviewed");
  assert.equal(app.undoCount(), 1);
  assert.equal(resumed, 1);
  assert.equal(app.get("unsavedDialog").open, false);
  assert.equal(app.state.activeView, "lyrics");
  assert.notEqual(app.focused(), app.chips[0]);
});

test("Apply converting a chord to a repeat never defers the next chord", async () => {
  const app = harness();
  app.key("e");
  app.get("edName").value = "%";
  app.enableUnsavedDialog();
  app.decide("skip", true);
  assert.equal(app.get("unsavedDialog").open, true);
  await app.get("unsavedApply").onclick();
  assert.equal(app.entries[0].chord, "%");
  assert.equal(app.entries[2].chord, "Dm");
  assert.equal(app.entries[2].chord_review, undefined);
  assert.equal(app.undoCount(), 1);
  assert.equal(app.get("chordReviewName").textContent, "Dm");
});

test("editor submit commits lyric drafts before applying printed voicing and advancing", () => {
  const app = harness();
  app.state.activeView = "bars";
  app.key("l");
  app.get("edName").value = "Cmaj7";
  app.get("edText").value = "anchored lyric";
  app.rejectDiscard();
  app.get("edUsePrintNext").click();
  assert.equal(app.entries[0].chord, "Cmaj7");
  assert.equal(app.entries[0].text, "anchored lyric");
  assert.equal(app.entries[0].voicing, app.entries[0].voicing_printed);
  assert.equal(app.entries[0].chord_review.status, "reviewed");
  assert.equal(app.get("edName").value, "Dm");
  assert.equal(app.focused(), app.chips[2]);
});

test("late scan proposal is review-only until the user copies and applies it", () => {
  const app = harness();
  app.state.activeView = "bars";
  app.key("l");
  const entry = app.entries[0];
  const original = structuredClone(entry);
  const selection = { ...app.state.sel };

  assert.equal(app.get("edScanProposal").hidden, true);
  app.setScanProposal(entry, "x,3,5,5,5,3");
  assert.equal(app.refreshScanProposal(), true);
  assert.equal(app.get("edScanProposal").hidden, false);
  assert.equal(app.get("edScanProposalValue").textContent, "x,3,5,5,5,3");
  assert.deepEqual(entry, original);
  assert.equal(app.dirty(), false);
  assert.equal(app.undoCount(), 0);
  assert.deepEqual({ ...app.state.sel }, selection);

  app.get("edUseScanProposal").click();
  assert.equal(app.draftVoicing(), "x,3,5,5,5,3");
  assert.deepEqual(entry, original);
  assert.equal(app.dirty(), false);
  assert.equal(app.undoCount(), 0);
  assert.deepEqual({ ...app.state.sel }, selection);

  app.get("edApply").click();
  assert.equal(entry.voicing, "x,3,5,5,5,3");
  assert.equal(entry.voicing_printed, original.voicing_printed);
  assert.equal(entry.chord_review.status, "reviewed");
  assert.equal(app.dirty(), true);
  assert.equal(app.undoCount(), 1);
});

test("active editor submit validates its name and refuses unavailable printed voicings", () => {
  const app = harness();
  app.state.activeView = "bars";
  app.key("l");
  app.get("edName").value = "not a chord";
  assert.equal(app.submit(), false);
  assert.match(app.get("edErr").textContent, /Not a valid/);
  app.get("edName").value = "C";
  app.get("edUsePrintNext").click();
  assert.equal(app.get("edName").value, "Dm");
  assert.equal(app.submit({ usePrinted: true, advance: true }), false);
  assert.match(app.get("edErr").textContent, /No printed voicing/);
  assert.equal(app.get("edName").value, "Dm");
});

test("Enter submits both chord-name and anchored-lyric editor fields", () => {
  const app = harness();
  app.state.activeView = "bars";
  app.key("l");
  app.get("edName").value = "Cmaj7";
  assert.equal(app.get("edName").keyDown("Enter"), true);
  assert.equal(app.entries[0].chord, "Cmaj7");
  app.get("edText").value = "entered lyric";
  assert.equal(app.get("edText").keyDown("Enter"), true);
  assert.equal(app.entries[0].text, "entered lyric");
});

test("R stays on the chord and Space prevents scrolling and advances in Bars", () => {
  const app = harness();
  app.state.activeView = "bars";
  app.key("l");
  assert.equal(app.key("r"), true);
  assert.equal(app.entries[0].chord_review.status, "reviewed");
  assert.equal(app.focused(), app.chips[0]);
  app.get("edText").value = "space lyric";
  assert.equal(app.key(" ", { target: { tagName: "INPUT" } }), false);
  assert.equal(app.focused(), app.chips[0]);
  assert.equal(app.key(" ", { code: "Space" }), true);
  assert.equal(app.entries[0].text, "space lyric");
  assert.equal(app.get("edName").value, "Dm");
  assert.equal(app.focused(), app.chips[2]);

  const reviewing = harness();
  assert.equal(reviewing.key("r"), true);
  assert.equal(reviewing.entries[0].chord_review.status, "reviewed");
  assert.equal(reviewing.focused(), reviewing.chips[0]);
  assert.equal(reviewing.key(" "), true);
  assert.equal(reviewing.focused(), reviewing.chips[2]);
});

test("A accepts printed voicing without discarding the editor lyric draft", () => {
  const app = harness();
  app.state.activeView = "bars";
  app.key("l");
  app.get("edText").value = "A lyric";
  assert.equal(app.key("a"), true);
  assert.equal(app.entries[0].text, "A lyric");
  assert.equal(app.entries[0].voicing, app.entries[0].voicing_printed);
  assert.equal(app.entries[0].chord_review.status, "reviewed");
  assert.equal(app.get("edName").value, "Dm");
});

test("Bars keyboard navigation updates the focus, editor and source crop together", () => {
  const app = harness({ split: true });
  app.state.activeView = "bars";
  app.key("l");
  assert.equal(app.get("edName").value, "C");
  app.key("l");
  assert.equal(app.get("edName").value, "Dm");
  app.key("j");
  assert.equal(app.get("edName").value, "G7");
  assert.equal(app.focused(), app.chips[3]);
  assert.match(app.get("editor").innerHTML, /<h2>Edit chord · bar 2<\/h2>/);
  assert.match(app.get("editor").innerHTML, /[?]si=0&bi=1&ei=0/);
  assert.match(app.get("editor").innerHTML, /observation_id=obs-g/);
  app.key("k");
  assert.equal(app.get("edName").value, "C");
  assert.equal(app.focused(), app.chips[0]);
  app.get("edName").value = "draft";
  app.rejectDiscard();
  app.key("l");
  assert.equal(app.get("edName").value, "draft");
  assert.equal(app.focused(), app.chips[0]);
  const before = app.song().sections[0].bars.map((bar) => bar.slice());
  app.key("J", { shiftKey: true });
  assert.deepEqual(app.song().sections[0].bars, before);
  assert.equal(app.get("edName").value, "draft");
});

test("shifted Vim keys move the selected chord and keep its editor and focus", () => {
  const app = harness({ split: true });
  app.state.activeView = "bars";
  app.key("l");
  const first = app.entries[0];
  app.key("L", { shiftKey: true });
  assert.equal(app.song().sections[0].bars[0][1], first);
  assert.equal(app.focused(), app.chips[1]);
  app.key("J", { shiftKey: true });
  assert.equal(app.song().sections[0].bars[1][0], first);
  assert.equal(app.get("edName").value, "C");
  assert.equal(app.focused(), app.chips[2]);
  assert.deepEqual({ ...app.state.sel }, { si: 0, bi: 1, ei: 0 });
});

test("split before a chord keeps its editor, scan crop, and review linked to the new bar", () => {
  const app = harness();
  app.state.activeView = "bars";
  const tail = { chord: "Am", text: "following lyric" };
  app.song().sections[0].bars[0].push(tail);
  app.key("h");
  app.key("h");
  const chord = app.entries[3];
  app.get("edMarkReviewed").click();
  app.get("edText").value = "pending draft";
  app.get("edSplitBefore").click();
  assert.equal(app.song().sections[0].bars.length, 1);
  assert.equal(app.get("edText").value, "pending draft");
  assert.match(app.get("edSplitStatus").textContent, /Apply your chord edits/);

  app.get("edText").value = "";
  app.get("edSplitBefore").click();
  assert.strictEqual(app.song().sections[0].bars[1][0], chord);
  assert.strictEqual(app.song().sections[0].bars[1][1], tail);
  assert.equal(chord.chord_review.status, "reviewed");
  assert.deepEqual({ ...app.state.sel }, { si: 0, bi: 1, ei: 0 });
  assert.equal(app.focused(), app.chips[3]);
  assert.equal(app.get("edName").value, "G7");
  assert.match(app.get("editor").innerHTML, /<h2>Edit chord · bar 2<\/h2>/);
  assert.match(app.get("editor").innerHTML, /[?]si=0&bi=1&ei=0&(?:amp;)?observation_id=obs-g/);
  assert.match(app.get("editor").innerHTML, /id="edSplitBefore"[^>]*disabled/);
  assert.deepEqual(app.scanSelection(), { si: 0, bi: 1, ei: 0 });
  app.key("z", { metaKey: true });
  assert.equal(app.song().sections[0].bars.length, 1);
  assert.equal(app.entries[3].chord_review.status, "reviewed");
});

test("+ bar keeps the selected editor attached when later bar coordinates shift", () => {
  const app = harness({ split: true });
  app.state.activeView = "bars";
  const selected = app.song().sections[0].bars[1][0];
  app.open(0, 1, 0);

  app.addBarAfter(0, 0);

  assert.equal(app.song().sections[0].bars.length, 3);
  assert.deepEqual(app.song().sections[0].bars[1], []);
  assert.strictEqual(app.song().sections[0].bars[2][0], selected);
  assert.deepEqual({ ...app.state.sel }, { si: 0, bi: 2, ei: 0 });
  assert.equal(app.get("edName").value, "G7");
  assert.match(app.get("editor").innerHTML, /<h2>Edit chord · bar 3<\/h2>/);
  assert.match(app.get("editor").innerHTML, /[?]si=0&bi=2&ei=0/);
  assert.deepEqual(app.scanSelection(), { si: 0, bi: 2, ei: 0 });
  assert.equal(app.focused(), app.chips[3]);
  assert.equal(app.scrolled(), app.chips[3]);
  assert.equal(app.undoCount(), 1);
});

test("bar insertion supports before the first and after the last while retaining selection", () => {
  const app = harness({ split: true });
  app.state.activeView = "bars";
  const selected = app.song().sections[0].bars[1][0];
  app.open(0, 1, 0);

  app.addBarBefore(0, 0);
  assert.deepEqual(app.song().sections[0].bars[0], []);
  assert.strictEqual(app.song().sections[0].bars[2][0], selected);
  assert.deepEqual({ ...app.state.sel }, { si: 0, bi: 2, ei: 0 });

  app.addBarAfter(0, 2);
  assert.deepEqual(app.song().sections[0].bars[3], []);
  assert.strictEqual(app.song().sections[0].bars[2][0], selected);
  assert.deepEqual({ ...app.state.sel }, { si: 0, bi: 2, ei: 0 });
  assert.equal(app.get("edName").value, "G7");
  assert.deepEqual(app.scanSelection(), { si: 0, bi: 2, ei: 0 });
  assert.equal(app.focused(), app.chips[3]);
  assert.equal(app.undoCount(), 2);
});

test("midpoint split keeps the selected chord, editor, and source coordinates together", () => {
  const app = harness();
  app.state.activeView = "bars";
  const selected = app.song().sections[0].bars[0][3];
  app.open(0, 0, 3);

  app.splitBar(0, 0);

  assert.deepEqual(app.song().sections[0].bars.map((bar) => bar.length), [2, 2]);
  assert.strictEqual(app.song().sections[0].bars[1][1], selected);
  assert.deepEqual({ ...app.state.sel }, { si: 0, bi: 1, ei: 1 });
  assert.equal(app.get("edName").value, "G7");
  assert.match(app.get("editor").innerHTML, /<h2>Edit chord · bar 2<\/h2>/);
  assert.match(app.get("editor").innerHTML, /[?]si=0&bi=1&ei=1/);
  assert.deepEqual(app.scanSelection(), { si: 0, bi: 1, ei: 1 });
  assert.equal(app.focused(), app.chips[3]);
  assert.equal(app.scrolled(), app.chips[3]);
  assert.equal(app.undoCount(), 1);
});

test("split after the selected chord keeps it in the original bar and active", () => {
  const app = harness();
  app.state.activeView = "bars";
  const selected = app.song().sections[0].bars[0][2];
  app.open(0, 0, 2);

  app.get("edSplitAfter").click();

  assert.deepEqual(app.song().sections[0].bars.map((bar) => bar.length), [3, 1]);
  assert.strictEqual(app.song().sections[0].bars[0][2], selected);
  assert.deepEqual({ ...app.state.sel }, { si: 0, bi: 0, ei: 2 });
  assert.equal(app.get("edName").value, "Dm");
  assert.match(app.get("editor").innerHTML, /<h2>Edit chord · bar 1<\/h2>/);
  assert.deepEqual(app.scanSelection(), { si: 0, bi: 0, ei: 2 });
  assert.equal(app.focused(), app.chips[2]);
  assert.equal(app.scrolled(), app.chips[2]);
  assert.equal(app.undoCount(), 1);
});

test("bar controls neither discard a draft nor create fake UI splits", () => {
  const app = harness({ split: true });
  app.state.activeView = "bars";
  app.open(0, 1, 0);
  app.get("edText").value = "pending lyric";
  app.rejectDiscard();

  app.addBarAfter(0, 0);
  assert.equal(app.song().sections[0].bars.length, 2);
  assert.equal(app.get("edText").value, "pending lyric");
  assert.equal(app.undoCount(), 0);

  app.splitBar(0, 1);
  assert.equal(app.song().sections[0].bars.length, 2);
  assert.equal(app.undoCount(), 0);
});

test("numbered suggestions apply the matching name and slash opens help", () => {
  const app = harness();
  app.key("2");
  assert.equal(app.entries[0].chord, "Am/C");
  assert.equal(app.focused(), app.chips[0]);
  app.state.activeView = "bars";
  app.key("l");
  app.key("4");
  assert.equal(app.get("edName").value, "Em/C");
  assert.equal(app.entries[0].chord, "Em/C");
  assert.equal(app.key("/", { target: { tagName: "INPUT" } }), false);
  assert.equal(app.key("/"), true);
  assert.equal(app.get("shortcutDialog").open, true);
  assert.equal(app.key("l"), false);
  assert.equal(app.focused(), app.chips[0]);
  app.get("shortcutDialog").open = false;
  assert.equal(app.key("?", { shiftKey: true }), true);
  assert.equal(app.get("shortcutDialog").open, true);
});

test("Shift+H/L in Chord Review navigates flagged chords without mutating order, and Shift+J/K is ignored", () => {
  const app = harness({ split: true });
  const initialBars = app.song().sections[0].bars.map((bar) => bar.slice());
  app.key("l");
  assert.equal(app.focused(), app.chips[2]);

  // Shift+L jumps to next flagged chord (index 3), never reordering within bar.
  assert.equal(app.key("L", { shiftKey: true }), true);
  assert.equal(app.focused(), app.chips[3]);
  assert.deepEqual(app.song().sections[0].bars, initialBars);

  // Shift+H jumps back to previous flagged chord (index 0).
  assert.equal(app.key("H", { shiftKey: true }), true);
  assert.equal(app.focused(), app.chips[0]);
  assert.deepEqual(app.song().sections[0].bars, initialBars);

  // Shift+J/K in Chord Review is ignored (returns false) and does not move chords or step bars.
  assert.equal(app.key("J", { shiftKey: true }), false);
  assert.equal(app.focused(), app.chips[0]);
  assert.equal(app.key("K", { shiftKey: true }), false);
  assert.equal(app.focused(), app.chips[0]);
  assert.deepEqual(app.song().sections[0].bars, initialBars);
  assert.equal(app.undoCount(), 0);
});

test("Caps Lock uppercase A, S, R, H, L work in Chord Review and Bars (including S Defer)", () => {
  const reviewing = harness();
  assert.equal(reviewing.key("A", { shiftKey: false }), true);
  assert.equal(reviewing.entries[0].voicing, reviewing.entries[0].voicing_printed);
  assert.equal(reviewing.entries[0].chord_review.status, "reviewed");
  assert.equal(reviewing.focused(), reviewing.chips[2]);

  assert.equal(reviewing.key("S", { shiftKey: false }), true);
  assert.equal(reviewing.entries[2].chord_review.status, "deferred");
  assert.equal(reviewing.focused(), reviewing.chips[3]);

  assert.equal(reviewing.key("H", { shiftKey: false }), true);
  assert.equal(reviewing.focused(), reviewing.chips[2]);
  assert.equal(reviewing.key("L", { shiftKey: false }), true);
  assert.equal(reviewing.focused(), reviewing.chips[3]);
  assert.equal(reviewing.key("R", { shiftKey: false }), true);
  assert.equal(reviewing.entries[3].chord_review.status, "reviewed");

  // Bars mode: S defers, respects draft guard, and returns false on %.
  const bars = harness();
  bars.state.activeView = "bars";
  bars.key("l");
  bars.get("edText").value = "pending draft";
  assert.equal(bars.key("S", { shiftKey: false }), true);
  assert.equal(bars.entries[0].chord_review, undefined);
  assert.match(bars.get("edReviewStatus").textContent, /Apply chord edits/);

  bars.get("edText").value = "";
  assert.equal(bars.key("S", { shiftKey: false }), true);
  assert.equal(bars.entries[0].chord_review.status, "deferred");
  assert.equal(bars.get("edReviewStatus").textContent, "Deferred");

  bars.open(0, 0, 1); // "%" continuation entry
  assert.equal(bars.key("s"), false);
  assert.equal(bars.entries[1].chord_review, undefined);
});

test("A refuses to apply/advance in Bars and Chord Review when voicing already equals voicing_printed", () => {
  const reviewing = harness();
  reviewing.entries[0].voicing = reviewing.entries[0].voicing_printed;
  reviewing.key("l");
  reviewing.key("h");
  assert.equal(reviewing.get("chordReviewAccept").disabled, true);
  assert.equal(reviewing.key("a"), true);
  assert.equal(reviewing.entries[0].chord_review, undefined);
  assert.equal(reviewing.focused(), reviewing.chips[0]);
  assert.match(reviewing.get("chordReviewMessage").textContent, /already applied/i);

  const bars = harness();
  bars.state.activeView = "bars";
  bars.entries[0].voicing = bars.entries[0].voicing_printed;
  bars.key("l");
  assert.equal(bars.key("a"), true);
  assert.equal(bars.entries[0].chord_review, undefined);
  assert.equal(bars.get("edName").value, "C");
  assert.match(bars.get("edErr").textContent, /already applied/i);
});

test("Space after pointer-clicked buttons blurs and advances, while Tab-focused buttons yield to native activation", () => {
  const app = harness();
  app.wireChordReview();
  app.get("chordReviewSkip").click();
  assert.equal(app.get("chordReviewSkip").blurCount, 1);
  assert.equal(app.entries[0].chord_review.status, "deferred");
  assert.equal(app.focused(), app.chips[2]);

  // Simulate a clicked button still being ev.target when Space is pressed without Tab:
  let targetBlurCount = 0;
  const clickedBtn = {
    tagName: "BUTTON",
    blur() { targetBlurCount += 1; },
    matches: () => false,
  };
  assert.equal(app.key(" ", { code: "Space", target: clickedBtn }), true);
  assert.equal(targetBlurCount, 1);
  assert.equal(app.entries[2].chord_review.status, "reviewed");
  assert.equal(app.focused(), app.chips[3]);

  // Pressing Tab sets keyboardFocus = true so Space yields (returns false) for button activation.
  assert.equal(app.key("Tab"), false);
  assert.equal(app.key(" ", { code: "Space", target: clickedBtn }), false);
  assert.equal(targetBlurCount, 1);
  assert.equal(app.entries[3].chord_review, undefined);

  // Moving focus back via a non-button key clears keyboardFocus.
  assert.equal(app.key("h"), true);
  assert.equal(app.key(" ", { code: "Space", target: clickedBtn }), true);
  assert.equal(targetBlurCount, 2);
  assert.equal(app.entries[2].chord_review.status, "reviewed");

  // Pointer-clicking Bars editor Defer button also blurs the button.
  const bars = harness();
  bars.state.activeView = "bars";
  bars.key("l");
  bars.get("edDeferReview").click();
  assert.equal(bars.get("edDeferReview").blurCount, 1);
  assert.equal(bars.entries[0].chord_review.status, "deferred");
});
