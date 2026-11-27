const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

const script = readFileSync(join(__dirname, "../../scripts/qa_static/app_scan.js"), "utf8");

function scanElement(top, bottom) {
  const classes = new Set();
  const attrs = new Map();
  return {
    classList: {
      add: (value) => classes.add(value),
      remove: (value) => classes.delete(value),
      contains: (value) => classes.has(value),
    },
    setAttribute: (name, value) => attrs.set(name, value),
    removeAttribute: (name) => attrs.delete(name),
    getBoundingClientRect: () => ({ top, bottom }),
  };
}

test("scan highlights the linked chord, scrolls between pages, and follows a diagram click", async () => {
  const entries = [
    { chord: "C", observation_id: "a", status: "reviewed" },
    { chord: "Dm", observation_id: "b", status: "deferred" },
    { chord: "G7", observation_id: "c", status: "pending" },
  ];
  const coords = entries.map((_, ei) => ({ si: 0, bi: 0, ei }));
  const song = { pages: [1, 2], sections: [{ bars: [entries] }] };
  const state = {
    album: "album", file: "song.json", activeView: "chordReview",
    doc: {
      songs: [song],
      _meta: {
        observations: {
          a: { source_id: "first", value: { chord: "C" } },
          b: { source_id: "second", value: { chord: "Dm" } },
          c: { source_id: "second", value: { chord: "G7" } },
        },
        page_sources: { first: { page: 1 }, second: { page: 2 } },
      },
    },
  };
  const marks = [scanElement(40, 65), scanElement(250, 270)];
  const layers = [{ innerHTML: "" }, { innerHTML: "" }];
  const pages = [scanElement(20, 180), scanElement(200, 400)];
  pages.forEach((page, i) => {
    page.id = "scan-page-" + (i + 1);
    page.querySelector = (selector) => selector === ".scan-review-marks"
      ? layers[i]
      : selector === `[data-scan-chord="0:0:${i}"]` ? marks[i] : null;
  });
  let click;
  let keydown;
  let chosen;
  let requests = 0;
  const root = {
    clientHeight: 150, scrollTop: 0,
    getBoundingClientRect: () => ({ top: 0, bottom: 150 }),
    querySelectorAll: (selector) => selector === ".scan-page" ? pages : [],
    querySelector(selector) {
      if (selector === ".scan-page.current") return pages.find((page) => page.classList.contains("current"));
      if (selector === ".scan-review-mark.selected") return marks.find((mark) => mark.classList.contains("selected"));
      return null;
    },
    addEventListener(event, handler) {
      if (event === "click") click = handler;
      if (event === "keydown") keydown = handler;
    },
  };
  const legend = {};
  const proposalLegend = {};
  const details = {};
  const heading = {};
  const content = {};
  let toggle;
  const checkbox = { addEventListener: (_event, handler) => { toggle = handler; } };
  const handlers = new Map();
  const input = (id) => ({ addEventListener: (event, handler) => handlers.set(id + ":" + event, handler) });
  const viewport = {
    ...root, ...scanElement(0, 150), clientWidth: 400, scrollLeft: 0,
    querySelector: () => marks[0], style: { setProperty: (key, value) => handlers.set(key, value) },
    addEventListener: (event, handler) => handlers.set(event, handler),
  };
  viewport.classList.toggle = (name, value) => viewport.classList[value ? "add" : "remove"](name);
  const lookup = new Map([
    ["pages", root], ["scanReviewLegend", legend], ["scanEditDetails", details],
    ["scanProposalLegend", proposalLegend], ["scanEditHeading", heading], ["scanEditContent", content],
    ["scanViewport", viewport], ...["scanZoom", "scanZoomIn", "scanZoomOut", "scanShowBoxes"].map((id) => [id, input(id)]),
    ["scanShowEdits", checkbox], ...pages.map((p) => [p.id, p]),
  ]);
  const storage = new Map();
  const context = vm.createContext({
    state, song: () => song, $: (id) => lookup.get(id), esc: String,
    localStorage: {
      getItem: (key) => storage.get(key),
      setItem: (key, value) => storage.set(key, value),
    },
    entryCoords: () => coords,
    chordAt: ({ ei }) => entries[ei],
    chordReviewStatus: (entry) => entry.status,
    CHORD_REVIEW_LABELS: { reviewed: "Reviewed", deferred: "Deferred", pending: "Unreviewed" },
    api: async () => {
      requests += 1;
      return {
        locations: { a: { page: 1, box: [0.1, 0.03, 0.2, 0.2] }, b: { page: 2, box: [0.3, 0.4, 0.5, 0.6] } },
      };
    },
    selectChordReviewEntry: (point) => { chosen = point; },
    jumpToEntry: (point) => { chosen = point; state.activeView = "bars"; },
    activeChordSelection: () => chosen,
  });
  vm.runInContext(script, context);
  context.renderPages();
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(layers[0].innerHTML, /data-review-status="reviewed"/);
  assert.match(layers[1].innerHTML, /data-review-status="deferred"/);
  assert.equal(legend.hidden, false);
  assert.equal(proposalLegend.hidden, true);
  assert.match(root.innerHTML, /<\/figure>\s*<\/div>\s*<details id="scanEditDetails"/);

  context.syncScanSelection(coords[0], true);
  assert.equal(marks[0].classList.contains("selected"), true);
  assert.equal(viewport.scrollTop, 0);
  context.syncScanSelection(coords[1], true);
  assert.equal(marks[0].classList.contains("selected"), false);
  assert.equal(marks[1].classList.contains("selected"), true);
  assert.equal(viewport.scrollTop, 185);
  handlers.get("scanZoom:change")({ target: { value: "175" } });
  assert.equal(handlers.get("--scan-zoom"), "175%");
  assert.equal(storage.get("qaScanZoom"), "175");
  assert.match(layers[1].innerHTML, /left:30%;top:40%;width:20%/);
  handlers.get("scanShowBoxes:change")({ target: { checked: false } });
  assert.equal(viewport.classList.contains("hide-boxes"), true);
  assert.equal(legend.hidden, true);
  assert.equal(marks[1].classList.contains("selected"), true);
  handlers.get("scanShowBoxes:change")({ target: { checked: true } });
  assert.equal(legend.hidden, false);
  context.syncScanSelection(coords[2], true);
  assert.equal(pages[1].classList.contains("current"), true);
  assert.equal(marks[1].classList.contains("selected"), false);

  context.wireScanReview();
  let stopped = false;
  keydown({ target: { tagName: "SUMMARY" }, key: " ", stopPropagation: () => { stopped = true; } });
  assert.equal(stopped, true);
  click({ target: { closest: (selector) => selector === "[data-scan-chord]"
    ? { dataset: { scanChord: "0:0:1" } } : null } });
  assert.deepEqual({ ...chosen }, coords[1]);

  entries[0].chord = "Cmaj7";
  entries[0].text = "new lyric";
  context.renderScanReviewMarks();
  assert.doesNotMatch(layers[0].innerHTML, /scan-edit-badge/);
  toggle({ target: { checked: true } });
  assert.equal(storage.get("qaShowScanEdits"), "1");
  assert.match(layers[0].innerHTML, /class="scan-edit-badge below" data-edit-status="unsaved"><span>Cmaj7<\/span>/);
  assert.match(layers[0].innerHTML, /data-review-status="reviewed"/);
  context.syncScanSelection(coords[0]);
  assert.equal(details.hidden, false);
  assert.match(content.innerHTML, /As extracted/);
  assert.match(content.innerHTML, /<th scope="row">Chord<\/th><td>C<\/td><td>Cmaj7/);
  assert.match(content.innerHTML, /<th scope="row">Lyric<\/th><td>—<\/td><td>new lyric/);
  assert.match(content.innerHTML, /id="scanEditOpen"/);
  click({ target: { closest: (selector) => selector === "#scanEditOpen" ? {} : null } });
  assert.deepEqual({ ...chosen }, coords[0]);
  assert.equal(state.activeView, "bars");
  context.syncSavedScanDocument();
  assert.match(layers[0].innerHTML, /data-edit-status="saved"><span>Cmaj7<\/span>/);
  assert.match(heading.textContent, /Saved edit/);
  context.renderPages();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(layers[0].innerHTML, /data-edit-status="saved"><span>Cmaj7<\/span>/);
  toggle({ target: { checked: false } });
  assert.equal(storage.get("qaShowScanEdits"), "0");
  assert.doesNotMatch(layers[0].innerHTML, /scan-edit-badge/);
  assert.equal(details.hidden, true);

  song.pages = [2];
  context.syncScanDocument();
  assert.doesNotMatch(root.innerHTML, /id="scan-page-1"/);
  assert.match(root.innerHTML, /id="scan-page-2"/);
  assert.equal(requests, 2);
  context.syncSavedScanDocument();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 3);
});

test("scan edits report actual split boundaries plus unsaved voicing and lyric reversions", () => {
  const context = vm.createContext({ state: { dirty: true } });
  vm.runInContext(script, context);
  const entries = [
    { chord: "A°7", observation_id: "a" },
    { chord: "G#m6", voicing: "4,x,3,4,4,x", text: "sai", observation_id: "b" },
    { chord: "Cm7", observation_id: "c" },
    { chord: "G13/G#", observation_id: "d" },
    { chord: "G#m6", observation_id: "e" },
    { chord: "Cmaj7", observation_id: "f" },
  ];
  const observations = Object.fromEntries(entries.map((entry, index) => [entry.observation_id, {
    source_id: "page31", position: [0, 0, index === 5 ? 22 : 21, index],
    value: { chord: entry.chord, voicing: entry.voicing, text: entry.text },
  }]));
  const section = { bars: [entries.slice(0, 5), [entries[5]]] };
  const doc = { songs: [{ sections: [section] }], _meta: { observations } };
  const saved = context.scanEditSnapshot(doc);
  section.bars = [[entries[0]], [entries[1]], [entries[2]], entries.slice(3, 5), [entries[5]]];
  entries[1].voicing = "4,x,4,4,4,x";
  entries[1].text = "";
  const changes = context.scanEditsForDocument(doc, saved);
  assert.deepEqual([...changes.keys()], ["b", "c", "d"]);
  assert.equal(changes.get("b").newBar, true);
  assert.equal(changes.get("b").unsaved, true);
  assert.equal(changes.get("b").rows[0].before, "4,x,3,4,4,x");
  assert.equal(changes.get("b").rows[1].now, "");
  assert.equal(changes.get("d").newBar, true);

  const savedSplit = context.scanEditSnapshot(doc);
  assert.equal(context.scanEditsForDocument(doc, savedSplit).get("b").unsaved, false);
  section.bars = [[], entries.slice(0, 5), [entries[5]]];
  entries[1].voicing = observations.b.value.voicing;
  entries[1].text = observations.b.value.text;
  const reverted = context.scanEditsForDocument(doc, savedSplit);
  assert.equal(reverted.get("b").joined, true);
  assert.equal(reverted.get("b").unsaved, true);
  assert.equal(reverted.get("b").rows[0].lastSaved, "4,x,4,4,4,x");
  assert.equal(reverted.has("f"), false);
  assert.equal(context.scanEditsForDocument(doc, context.scanEditSnapshot(doc)).size, 0);
});

test("legacy scan boxes follow the saved chord object after an unsaved move", async () => {
  const chord = { chord: "C" };
  const song = { pages: [4], sections: [{ bars: [[chord], []] }] };
  const state = { album: "album", file: "song.json", songRevision: "saved", doc: { songs: [song] } };
  const layer = { innerHTML: "" };
  const marker = scanElement(40, 65);
  const page = scanElement(20, 150);
  page.id = "scan-page-4";
  page.querySelector = (selector) => selector === ".scan-review-marks" ? layer :
    (selector.includes("0:1:0") && layer.innerHTML.includes("0:1:0") ? marker : null);
  const root = {
    querySelectorAll: (selector) => selector === ".scan-page" ? [page] : [],
    querySelector: () => null,
  };
  let respond;
  let proposalSyncs = 0;
  const lookup = { pages: root, "scan-page-4": page, scanFocusStatus: {} };
  const context = vm.createContext({
    state, song: () => song, $: (id) => lookup[id], esc: String,
    entryCoords: () => song.sections[0].bars.flatMap((bar, bi) =>
      bar.map((_value, ei) => ({ si: 0, bi, ei }))),
    chordAt: ({ bi, ei }) => song.sections[0].bars[bi][ei],
    chordReviewStatus: () => "pending", CHORD_REVIEW_LABELS: { pending: "Unreviewed" },
    syncActiveChordProposal: () => { proposalSyncs += 1; },
    api: () => new Promise((resolve) => { respond = resolve; }),
  });
  vm.runInContext(script, context);

  context.renderPages();
  song.sections[0].bars = [[], [chord]];
  context.syncScanSelection({ si: 0, bi: 1, ei: 0 });
  assert.equal(context.legacyScanOrderChanged(), false);
  assert.match(lookup.scanFocusStatus.textContent, /Locating chord/);
  const syncsBeforeResponse = proposalSyncs;
  const coordinates = { "0:0:0": {
    page: 4, box: [0.1, 0.2, 0.3, 0.4], basis: "legacy_anchored_proposal",
    proposal: "x, 3, 2, 0, 1, 0",
  } };
  respond({ locations: {}, coordinates, revision: "saved" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(layer.innerHTML, /data-scan-chord="0:1:0"/);
  assert.match(layer.innerHTML, /data-scan-proposal="true"/);
  assert.match(layer.innerHTML, /Proposed position, not verified/);
  assert.match(layer.innerHTML, /proposed fingering x,3,2,0,1,0/);
  assert.equal(context.scanProposal(chord), "x,3,2,0,1,0");
  assert.ok(proposalSyncs > syncsBeforeResponse);
  assert.equal(marker.classList.contains("selected"), true);
  assert.equal(lookup.scanFocusStatus.hidden, true);
  const snapshot = JSON.parse(JSON.stringify(state.doc));
  context.copyLegacyScanLinks(snapshot);
  assert.equal(context.scanLookup(snapshot.songs[0].sections[0].bars[1][0]).page, 4);

  state.songRevision = "saved-edits";
  context.syncSavedScanDocument();
  assert.equal(context.scanProposal(chord), "");
  assert.doesNotMatch(layer.innerHTML, /data-scan-proposal/);

  context.renderPages();
  respond({ locations: {}, coordinates, revision: "later" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(layer.innerHTML, "");
  context.syncScanSelection({ si: 0, bi: 1, ei: 0 });
  assert.equal(lookup.scanFocusStatus.hidden, false);
  assert.match(lookup.scanFocusStatus.textContent, /position is unavailable/);
  assert.equal(context.scanProposal(chord), "");
});

test("scan proposals reject malformed fingerings and never treat ordinary matches as proposals", () => {
  const entry = { chord: "C" };
  const song = { pages: [], sections: [{ bars: [[entry]] }] };
  const state = { album: "album", file: "song.json", doc: { songs: [song] } };
  const root = { innerHTML: "", querySelectorAll: () => [] };
  const context = vm.createContext({
    state, song: () => song, $: (id) => id === "pages" ? root : null, esc: String,
    entryCoords: () => [{ si: 0, bi: 0, ei: 0 }], chordAt: () => entry,
    api: () => new Promise(() => {}),
  });
  vm.runInContext(script, context);
  context.renderPages();
  const location = { basis: "legacy_anchored_proposal", proposal: "x,3,2,0,1,25" };
  context.location = location;
  vm.runInContext("scanReview.legacyLocations.set(song().sections[0].bars[0][0], location)", context);
  assert.equal(context.scanProposal(entry), "");
  location.proposal = "x,3,2,0,1,0";
  location.basis = "legacy_unique_alignment";
  assert.equal(context.scanProposal(entry), "");
});

test("legacy scan order detects reordering even when both printed shapes are identical", () => {
  const entries = [{ chord: "Em9" }, { chord: "Em9" }];
  const song = { pages: [], sections: [{ bars: [entries] }] };
  const root = { innerHTML: "", querySelectorAll: () => [] };
  const state = { album: "album", file: "song.json", songRevision: "saved", doc: { songs: [song] } };
  const context = vm.createContext({
    state, song: () => song, $: (id) => id === "pages" ? root : null, esc: String,
    entryCoords: () => entries.map((_entry, ei) => ({ si: 0, bi: 0, ei })),
    chordAt: ({ ei }) => entries[ei],
    api: () => new Promise(() => {}),
  });
  vm.runInContext(script, context);
  context.renderPages();
  assert.equal(context.legacyScanOrderChanged(), false);
  entries.reverse();
  assert.equal(context.legacyScanOrderChanged(), true);
});
