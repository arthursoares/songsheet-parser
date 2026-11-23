// Invariant tests for the QA tool's pure document mutations (doc_ops.js).
// Run with: node --test tests/js/
const { test } = require("node:test");
const assert = require("node:assert/strict");

const DocOps = require("../../scripts/qa_static/doc_ops.js");

// A small song with the shapes that matter: multi-entry bars, voicings,
// instrumental (textless) entries, and a "%" continuation.
function makeSong() {
  return {
    title: "T",
    sections: [
      {
        label: "A",
        bars: [
          [{ chord: "Dm7", voicing: "x,5,7,5,6,x", text: "Vai mi" }, { chord: "G7", text: "nha tris" }],
          [{ chord: "Cmaj7", text: "teza" }],
          [{ chord: "%" }],
        ],
      },
      { label: "B", bars: [[{ chord: "Am7" }]] },
    ],
  };
}

const clone = (x) => JSON.parse(JSON.stringify(x));

// Total chord-entry and syllable counts across a song — the conserved
// quantities for every op that doesn't explicitly add/remove entries.
function counts(song) {
  let entries = 0, syls = 0;
  song.sections.forEach((s) => s.bars.forEach((b) => b.forEach((e) => {
    entries += 1;
    syls += DocOps.lySyllables(e.text).length;
  })));
  return { entries, syls };
}

// ---- structural ops ----

test("addBarAfter inserts an empty bar, including into an empty section via bi=-1", () => {
  const song = makeSong();
  DocOps.addBarAfter(song, 0, 0);
  assert.equal(song.sections[0].bars.length, 4);
  assert.deepEqual(song.sections[0].bars[1], []);

  song.sections.push({ label: "C", bars: [] });
  DocOps.addBarAfter(song, 2, -1);
  assert.deepEqual(song.sections[2].bars, [[]]);

  song.sections.push({ label: "D" });
  assert.equal(DocOps.canAddBarAfter(song, 3, -1), true);
  assert.equal(DocOps.addBarAfter(song, 3, -1), true);
  assert.deepEqual(song.sections[3].bars, [[]]);
});

test("addBarAfter rejects stale coordinates without mutating", () => {
  const song = makeSong();
  const before = clone(song);
  for (const [si, bi] of [[0, -1], [0, 99], [99, 0], [0, 0.5]]) {
    assert.equal(DocOps.canAddBarAfter(song, si, bi), false);
    assert.equal(DocOps.addBarAfter(song, si, bi), false);
  }
  assert.deepEqual(song, before);
});

test("addBarBefore inserts before the first or last target and rejects stale coordinates", () => {
  const song = makeSong();
  const first = song.sections[0].bars[0];
  const last = song.sections[0].bars[2];
  assert.equal(DocOps.addBarBefore(song, 0, 0), true);
  assert.deepEqual(song.sections[0].bars[0], []);
  assert.strictEqual(song.sections[0].bars[1], first);
  assert.equal(DocOps.addBarBefore(song, 0, 3), true);
  assert.deepEqual(song.sections[0].bars[3], []);
  assert.strictEqual(song.sections[0].bars[4], last);

  const before = clone(song);
  assert.equal(DocOps.canAddBarBefore(song, 0, -1), false);
  assert.equal(DocOps.addBarBefore(song, 0, 99), false);
  assert.deepEqual(song, before);
});

test("deleteBar removes the bar; out-of-range is a non-mutating no-op", () => {
  const song = makeSong();
  assert.equal(DocOps.deleteBar(song, 0, 1), true);
  assert.equal(song.sections[0].bars.length, 2);
  const before = clone(song);
  assert.equal(DocOps.deleteBar(song, 0, 99), false);
  assert.deepEqual(song, before);
});

test("splitBar at midpoint then mergeBarWithNext round-trips the section", () => {
  const song = makeSong();
  const before = clone(song.sections[0].bars[0]);
  DocOps.splitBar(song, 0, 0);
  assert.equal(song.sections[0].bars.length, 4);
  assert.deepEqual(song.sections[0].bars[0], [before[0]]);
  assert.deepEqual(song.sections[0].bars[1], [before[1]]);
  DocOps.mergeBarWithNext(song, 0, 0);
  assert.deepEqual(song.sections[0].bars[0], before);
  assert.deepEqual(song, makeSong());
});

test("splitBar on a single-entry bar appends a % continuation bar", () => {
  const song = makeSong();
  assert.equal(DocOps.canSplitBar(song, 0, 1), false);
  DocOps.splitBar(song, 0, 1);
  assert.deepEqual(song.sections[0].bars[2], [{ chord: "%" }]);
});

test("splitBar can restore several missing boundaries without changing any chord entries", () => {
  const song = makeSong();
  const entries = [
    { chord: "Adim7", text: "de mim, Nao" },
    { chord: "G#m6", text: "sai de mim, nao", voicing_printed: "4,x,3,4,4,x", observation_id: "obs-1" },
    { chord: "Cm7", text: "sai" },
    { chord: "G13/G#" },
    { chord: "G#m6", observation_id: "obs-4" },
  ];
  song.sections[0].bars[0] = entries.slice();
  const before = clone(entries);

  for (let bi = 0; bi < 3; bi++) assert.equal(DocOps.splitBar(song, 0, bi, 1), true);

  const bars = song.sections[0].bars.slice(0, 4);
  assert.deepEqual(bars, [[before[0]], [before[1]], [before[2]], before.slice(3)]);
  assert.ok(bars.flat().every((entry, index) => entry === entries[index]));
});

test("splitBar rejects invalid selected boundaries without adding a bar", () => {
  const song = makeSong();
  const before = clone(song);
  for (const index of [0, -1, 1.5, 2, 10, null]) {
    assert.equal(DocOps.canSplitBar(song, 0, 0, index), false);
    assert.equal(DocOps.splitBar(song, 0, 0, index), false);
  }
  assert.deepEqual(song, before);
});

test("mergeBarWithNext on the last bar is a non-mutating no-op", () => {
  const song = makeSong();
  const before = clone(song);
  assert.equal(DocOps.canMergeBarWithNext(song, 1, 0), false);
  assert.equal(DocOps.mergeBarWithNext(song, 1, 0), false);
  assert.deepEqual(song, before);
});

test("moveChord shifts an entry across the bar boundary, conserving entries", () => {
  const song = makeSong();
  const pre = counts(song);
  assert.equal(DocOps.moveChord(song, 0, 0, 1, +1), true); // G7 -> front of bar 2
  assert.deepEqual(song.sections[0].bars[0], [{ chord: "Dm7", voicing: "x,5,7,5,6,x", text: "Vai mi" }]);
  assert.equal(song.sections[0].bars[1][0].chord, "G7");
  assert.deepEqual(counts(song), pre);

  assert.equal(DocOps.moveChord(song, 0, 1, 0, -1), true); // and back (appends)
  assert.equal(song.sections[0].bars[0][1].chord, "G7");
  assert.deepEqual(song, makeSong());
});

test("moveChord off either end is a non-mutating no-op", () => {
  const song = makeSong();
  const before = clone(song);
  assert.equal(DocOps.canMoveChord(song, 0, 0, -1), false);
  assert.equal(DocOps.moveChord(song, 0, 0, 0, -1), false);
  assert.equal(DocOps.moveChord(song, 0, 2, 0, +1), false);
  assert.deepEqual(song, before);
});

test("reorderChord swaps immediate neighbors in either direction, preserving entry identity", () => {
  const song = makeSong();
  const bar = song.sections[0].bars[0];
  const dm7 = bar[0];
  const g7 = bar[1];

  assert.equal(DocOps.canReorderChord(song, 0, 0, 0, +1), true);
  assert.equal(DocOps.reorderChord(song, 0, 0, 0, +1), true);
  assert.strictEqual(bar[0], g7);
  assert.strictEqual(bar[1], dm7);
  assert.equal(bar[0].text, "nha tris");

  assert.equal(DocOps.canReorderChord(song, 0, 0, 1, -1), true);
  assert.equal(DocOps.reorderChord(song, 0, 0, 1, -1), true);
  assert.strictEqual(bar[0], dm7);
  assert.strictEqual(bar[1], g7);
});

test("reorderChord rejects invalid bounds and direction without mutating", () => {
  const song = makeSong();
  const before = clone(song);
  assert.equal(DocOps.canReorderChord(song, 0, 0, 0, -1), false);
  assert.equal(DocOps.reorderChord(song, 0, 0, 0, -1), false);
  assert.equal(DocOps.reorderChord(song, 0, 0, 1, +1), false);
  assert.equal(DocOps.reorderChord(song, 0, 0, -1, +1), false);
  assert.equal(DocOps.reorderChord(song, 0, 0, 0, 0), false);
  assert.equal(DocOps.reorderChord(song, 9, 0, 0, +1), false);
  assert.deepEqual(song, before);
});

test("addSectionAfter inserts a renderable section; deleteSection removes it", () => {
  const song = makeSong();
  DocOps.addSectionAfter(song, 0);
  assert.equal(song.sections.length, 3);
  assert.deepEqual(song.sections[1], { label: "", bars: [[{ chord: "%" }]] });
  DocOps.deleteSection(song, 1);
  assert.deepEqual(song, makeSong());
});

// ---- lyrics model / re-anchoring ----

test("lySyllables tokenizes on whitespace and handles empty", () => {
  assert.deepEqual(DocOps.lySyllables("Vai mi nha"), ["Vai", "mi", "nha"]);
  assert.deepEqual(DocOps.lySyllables(""), []);
  assert.deepEqual(DocOps.lySyllables(undefined), []);
});

test("lyRebuildBar of an unmoved model reproduces the bar exactly", () => {
  const bars = makeSong().sections[0].bars;
  for (const bar of bars) {
    assert.deepEqual(DocOps.lyRebuildBar(DocOps.lyBarModel(bar)), bar);
  }
});

test("reanchoredBar moves text ownership without mutating the input", () => {
  const bar = makeSong().sections[0].bars[0];
  const before = clone(bar);
  // Move G7 (chordPos 1) from syllable 2 ("nha") back to syllable 1 ("mi").
  const rebuilt = DocOps.reanchoredBar(bar, 1, 1);
  assert.deepEqual(bar, before); // input untouched
  assert.deepEqual(rebuilt, [
    { chord: "Dm7", voicing: "x,5,7,5,6,x", text: "Vai" },
    { chord: "G7", text: "mi nha tris" },
  ]);
});

test("reanchoredBar conserves chords, voicings, and syllables", () => {
  // Moving the FIRST chord forward must not orphan-drop the leading syllables
  // (regression: they used to be silently deleted).
  const bar = makeSong().sections[0].bars[0];
  const rebuilt = DocOps.reanchoredBar(bar, 0, 3);
  const sylsOf = (b) => b.flatMap((e) => DocOps.lySyllables(e.text));
  assert.deepEqual(sylsOf(rebuilt).sort(), sylsOf(bar).sort());
  assert.deepEqual(rebuilt.map((e) => e.chord).sort(), bar.map((e) => e.chord).sort());
  const voicings = (b) => b.map((e) => e.voicing).filter(Boolean).sort();
  assert.deepEqual(voicings(rebuilt), voicings(bar));
});

test("reanchoredBar preserves extra entry fields like voicing_printed", () => {
  const bar = [
    { chord: "Dm7", voicing: "x,5,7,5,6,x", voicing_printed: "x,5,7,5,6,5", text: "Vai mi" },
    { chord: "G7", text: "nha tris" },
  ];
  const rebuilt = DocOps.reanchoredBar(bar, 1, 1);
  assert.equal(rebuilt[0].voicing_printed, "x,5,7,5,6,5");
  assert.equal(rebuilt[0].voicing, "x,5,7,5,6,x");
});

test("reanchoredBar returns null for no-op or invalid moves", () => {
  const bar = makeSong().sections[0].bars[0];
  assert.equal(DocOps.reanchoredBar(bar, 1, 2), null); // already at syllable 2
  assert.equal(DocOps.reanchoredBar(bar, 5, 0), null); // no such chord
  assert.equal(DocOps.reanchoredBar(bar, -1, 0), null);
});

test("replaceTextToken edits, splits on space, deletes on empty", () => {
  assert.equal(DocOps.replaceTextToken("Vai mi nha", 1, "MI"), "Vai MI nha");
  assert.equal(DocOps.replaceTextToken("demorando em", 0, "demo rando"), "demo rando em");
  assert.equal(DocOps.replaceTextToken("Vai mi nha", 2, ""), "Vai mi");
  assert.equal(DocOps.replaceTextToken("Vai", 0, ""), "");
  assert.equal(DocOps.replaceTextToken("Vai mi", 5, "x"), null);
  assert.equal(DocOps.replaceTextToken("a  b", 1, "  c   d  "), "a c d");
});

test("buildLyricLine: ChordMark markers, dashes glue mid-word splits", () => {
  const entries = [
    { chord: "Bm7/F#", text: "A tris-" },
    { chord: "E13", text: "te-" },
    { chord: "Amaj7", text: "za é se-" },
    { chord: "A7", text: "nhora," },
  ];
  assert.equal(DocOps.buildLyricLine(entries), "_A tris_te_za é se_nhora,");
  // dash-less corpus text gets a space before the next marker instead
  const plain = [{ chord: "C", text: "Vai mi" }, { chord: "G7", text: "nha" }];
  assert.equal(DocOps.buildLyricLine(plain), "_Vai mi _nha");
  // textless entries are bare markers
  const inst = [{ chord: "C" }, { chord: "%" }, { chord: "G7", text: "lá" }];
  assert.equal(DocOps.buildLyricLine(inst), "_ _ _lá");
});

test("lyDisplayText collapses internal continuation dashes", () => {
  assert.equal(DocOps.lyDisplayText("tris- te- za e"), "tristeza e");
  assert.equal(DocOps.lyDisplayText("nhora,"), "nhora,");
  assert.equal(DocOps.lyDisplayText("se-"), "se");
});

test("Text lyric editing keeps a standalone dash and a line-ending continuation", () => {
  const entries = [{ chord: "C", text: "eu -" }, { chord: "G", text: "sei tan-" }];
  const line = DocOps.buildLyricLine(entries);
  assert.equal(line, "_eu - _sei tan-");
  assert.deepEqual(DocOps.parseLyricLine(line, entries.length).fragments, ["eu -", "sei tan-"]);
});

test("parseLyricLine round-trips and derives boundary dashes from glue", () => {
  const r = DocOps.parseLyricLine("_A tris_te_za é se_nhora,", 4);
  assert.deepEqual(r, {
    leading: "",
    fragments: ["A tris-", "te-", "za é se-", "nhora,"],
  });
  // deleting the space fuses the word -> dash appears; adding one removes it
  const r2 = DocOps.parseLyricLine("_Vai mi_nha _tris teza", 3);
  assert.deepEqual(r2.fragments, ["Vai mi-", "nha", "tris teza"]);
  // empty segments clear an entry's text; leading text is surfaced
  const r3 = DocOps.parseLyricLine("hey _ _lá", 2);
  assert.deepEqual(r3, { leading: "hey", fragments: ["", "lá"] });
});

test("parseLyricLine rejects a marker-count mismatch", () => {
  assert.equal(DocOps.parseLyricLine("_a _b", 3), null);
  assert.equal(DocOps.parseLyricLine("_a _b _c", 2), null);
  assert.equal(DocOps.parseLyricLine("no markers at all", 1), null);
});

test("build/parse round-trip is stable", () => {
  const entries = [
    { chord: "Bm7/F#", text: "A tris-" },
    { chord: "E13", text: "te-" },
    { chord: "%" },
    { chord: "A7", text: "nhora," },
  ];
  const line = DocOps.buildLyricLine(entries);
  const r = DocOps.parseLyricLine(line, 4);
  assert.deepEqual(r.fragments, ["A tris-", "te-", "", "nhora,"]);
});

test("reanchoredBar clamps an out-of-range target to the syllable count", () => {
  const bar = makeSong().sections[0].bars[0];
  // Target far past the end: G7 ends up after every syllable (textless).
  const rebuilt = DocOps.reanchoredBar(bar, 1, 99);
  assert.deepEqual(rebuilt, [
    { chord: "Dm7", voicing: "x,5,7,5,6,x", text: "Vai mi nha tris" },
    { chord: "G7" },
  ]);
});

// ---- Arrange-mode lyric anchor planning ----

const changedBar = (plan, si, bi) =>
  plan.changes.find((change) => change.si === si && change.bi === bi).bar;
const lyricTokens = (bar) => bar.flatMap((entry) => DocOps.lySyllables(entry.text));

test("planLyricAnchorMove reanchors within a bar, preserving metadata and input", () => {
  const song = {
    sections: [{ bars: [[
      { chord: "C", text: "one two" },
      { chord: "G7", voicing: "3,2,0,0,0,1", text: "three four",
        observation_id: "obs-g", chord_review: { status: "reviewed", snapshot: { chord: "G7" } } },
    ]] }],
    _meta: { evidence: { untouched: true } },
  };
  const before = clone(song);
  const plan = DocOps.planLyricAnchorMove(song, { si: 0, bi: 0, ei: 1 },
    { si: 0, bi: 0, syllable: 1 });

  assert.deepEqual(plan, {
    changes: [{ si: 0, bi: 0, bar: [
      { chord: "C", text: "one" },
      { chord: "G7", voicing: "3,2,0,0,0,1", text: "two three four",
        observation_id: "obs-g", chord_review: { status: "reviewed", snapshot: { chord: "G7" } } },
    ] }],
    selection: { si: 0, bi: 0, ei: 1 },
  });
  assert.deepEqual(song, before);
  assert.deepEqual(song._meta, before._meta);
});

test("planLyricAnchorMove puts a moved chord last at a tied target so it owns text", () => {
  const song = { sections: [{ bars: [[
    { chord: "C", text: "one two" },
    { chord: "G7", text: "three four" },
    { chord: "Am7" },
  ]] }] };
  const plan = DocOps.planLyricAnchorMove(song, { si: 0, bi: 0, ei: 0 },
    { si: 0, bi: 0, syllable: 2 });

  assert.deepEqual(changedBar(plan, 0, 0), [
    { chord: "G7", text: "one two" },
    { chord: "C", text: "three four" },
    { chord: "Am7" },
  ]);
  assert.deepEqual(plan.selection, { si: 0, bi: 0, ei: 1 });
  assert.deepEqual(lyricTokens(changedBar(plan, 0, 0)), ["one", "two", "three", "four"]);
});

test("planLyricAnchorMove returns null only when the chord already owns its anchor", () => {
  const song = makeSong();
  assert.equal(DocOps.planLyricAnchorMove(song, { si: 0, bi: 0, ei: 1 },
    { si: 0, bi: 0, syllable: 2 }), null);

  const tied = { sections: [{ bars: [[
    { chord: "C" }, { chord: "G", text: "word" },
  ]] }] };
  const plan = DocOps.planLyricAnchorMove(tied, { si: 0, bi: 0, ei: 0 },
    { si: 0, bi: 0, syllable: 0 });
  assert.deepEqual(changedBar(plan, 0, 0), [{ chord: "G" }, { chord: "C", text: "word" }]);
});

test("planLyricAnchorMove moves across bars while each bar keeps its lyric stream", () => {
  const review = { status: "deferred", snapshot: { chord: "G7", voicing: "3,2,0,0,0,1" } };
  const song = { sections: [{ bars: [
    [{ chord: "C", text: "a b" }, { chord: "G7", text: "c d", voicing: "3,2,0,0,0,1",
      observation_id: "obs-7", chord_review: review }],
    [{ chord: "Dm7", text: "e f" }, { chord: "A7", text: "g" }],
  ] }] };
  const before = clone(song);
  const plan = DocOps.planLyricAnchorMove(song, { si: 0, bi: 0, ei: 1 },
    { si: 0, bi: 1, syllable: 1 });

  assert.deepEqual(changedBar(plan, 0, 0), [{ chord: "C", text: "a b c d" }]);
  assert.deepEqual(changedBar(plan, 0, 1), [
    { chord: "Dm7", text: "e" },
    { chord: "G7", text: "f", voicing: "3,2,0,0,0,1",
      observation_id: "obs-7", chord_review: review },
    { chord: "A7", text: "g" },
  ]);
  assert.deepEqual(plan.selection, { si: 0, bi: 1, ei: 1 });
  assert.deepEqual(lyricTokens(changedBar(plan, 0, 0)), ["a", "b", "c", "d"]);
  assert.deepEqual(lyricTokens(changedBar(plan, 0, 1)), ["e", "f", "g"]);
  assert.deepEqual(song, before);
});

test("planLyricAnchorMove leaves one lyric carry when the sole struck chord moves", () => {
  const song = { sections: [
    { bars: [[{ chord: "C" }], [{ chord: "G7", text: "keep these words" }]] },
    { bars: [[{ chord: "Am7", text: "over there" }]] },
  ] };
  const plan = DocOps.planLyricAnchorMove(song, { si: 0, bi: 1, ei: 0 },
    { si: 1, bi: 0, syllable: 1 });

  assert.deepEqual(changedBar(plan, 0, 1), [{ chord: "%", text: "keep these words" }]);
  assert.deepEqual(changedBar(plan, 1, 0), [
    { chord: "Am7", text: "over" }, { chord: "G7", text: "there" },
  ]);
});

test("planLyricAnchorMove preserves a continuation that already has source evidence", () => {
  const carry = { chord: "%", text: "these words", observation_id: "carry-source" };
  const song = { sections: [{ bars: [
    [{ chord: "C" }], [{ chord: "G", text: "keep" }, carry], [{ chord: "A", text: "there" }],
  ] }] };
  const plan = DocOps.planLyricAnchorMove(song, { si: 0, bi: 1, ei: 0 },
    { si: 0, bi: 2, syllable: 0 });
  assert.deepEqual(changedBar(plan, 0, 1), [{ ...carry, text: "keep these words" }]);
  assert.equal(carry.text, "these words");
});

test("planLyricAnchorMove counts an earlier destination as the source carry's preceding chord", () => {
  const song = { sections: [{ bars: [
    [{ chord: "%", text: "destination lyric", observation_id: "percent-evidence" }],
    [{ chord: "G7", text: "source lyric" }],
  ] }], _meta: { observations: { "percent-evidence": { kind: "printed" } } } };
  const before = clone(song);
  const plan = DocOps.planLyricAnchorMove(song, { si: 0, bi: 1, ei: 0 },
    { si: 0, bi: 0, syllable: 0 });

  assert.deepEqual(changedBar(plan, 0, 0), [{ chord: "G7", text: "destination lyric" }]);
  assert.deepEqual(changedBar(plan, 0, 1), [{ chord: "%", text: "source lyric" }]);
  assert.deepEqual(plan.selection, { si: 0, bi: 0, ei: 0 });
  // The plan never mutates or transfers the original % evidence record/_meta.
  assert.deepEqual(song, before);
});

test("planLyricAnchorMove protects lyrics that would have no preceding real chord", () => {
  const song = { sections: [{ bars: [
    [{ chord: "C", text: "initial lyrics" }],
    [{ chord: "G", text: "later words" }],
  ] }] };
  const before = clone(song);
  const plan = DocOps.planLyricAnchorMove(song, { si: 0, bi: 0, ei: 0 },
    { si: 0, bi: 1, syllable: 0 });

  assert.match(plan.error, /orphan lyrics/i);
  assert.deepEqual(song, before);
});

test("planLyricAnchorMove keeps a preceding real chord for intervening continuations", () => {
  const song = { sections: [{ bars: [
    [{ chord: "C" }], [{ chord: "%", text: "carried words" }], [{ chord: "G", text: "later" }],
  ] }] };
  const before = clone(song);
  const plan = DocOps.planLyricAnchorMove(song, { si: 0, bi: 0, ei: 0 },
    { si: 0, bi: 2, syllable: 0 });
  assert.match(plan.error, /continuation before the first real chord/i);
  assert.deepEqual(song, before);
});

test("planLyricAnchorMove rejects a first anchor after leading lyrics", () => {
  const song = { sections: [{ bars: [[
    { chord: "C", text: "one two" }, { chord: "G", text: "three" },
  ]] }] };
  const plan = DocOps.planLyricAnchorMove(song, { si: 0, bi: 0, ei: 0 },
    { si: 0, bi: 0, syllable: 1 });
  assert.match(plan.error, /leading lyrics/i);
});

test("planLyricAnchorMove retains an empty or carry source for instrumental bars", () => {
  const first = { sections: [{ bars: [[{ chord: "C" }], [{ chord: "G" }]] }] };
  const emptyPlan = DocOps.planLyricAnchorMove(first, { si: 0, bi: 0, ei: 0 },
    { si: 0, bi: 1, syllable: 0 });
  assert.deepEqual(changedBar(emptyPlan, 0, 0), []);

  const later = { sections: [{ bars: [[{ chord: "C" }], [{ chord: "G" }], [{ chord: "Am" }]] }] };
  const carryPlan = DocOps.planLyricAnchorMove(later, { si: 0, bi: 1, ei: 0 },
    { si: 0, bi: 2, syllable: 0 });
  assert.deepEqual(changedBar(carryPlan, 0, 1), [{ chord: "%" }]);
});

test("planLyricAnchorMove reports invalid and unsupported requests without mutation", () => {
  const song = makeSong();
  const before = clone(song);
  assert.match(DocOps.planLyricAnchorMove(song, { si: 0, bi: 2, ei: 0 },
    { si: 0, bi: 1, syllable: 0 }).error, /named chords/i);
  assert.match(DocOps.planLyricAnchorMove(song, { si: 9, bi: 0, ei: 0 },
    { si: 0, bi: 1, syllable: 0 }).error, /source chord/i);
  assert.match(DocOps.planLyricAnchorMove(song, { si: 0, bi: 0, ei: 0 },
    { si: 0, bi: 99, syllable: 0 }).error, /destination bar/i);
  assert.match(DocOps.planLyricAnchorMove(song, { si: 0, bi: 0, ei: 0 },
    { si: 0, bi: 1, syllable: 99 }).error, /outside/i);
  assert.match(DocOps.planLyricAnchorMove(song, { si: 0, bi: 0, ei: 0 },
    { si: 0, bi: 2, syllable: 1 }).error, /first syllable/i);
  assert.deepEqual(song, before);
});

test("planLyricAnchorMove prevents adding a fifth chord to a four-beat bar", () => {
  const song = { sections: [{ bars: [
    [{ chord: "C" }, { chord: "G" }],
    [{ chord: "A" }, { chord: "Bm" }, { chord: "Dm" }, { chord: "E7" }],
  ] }] };
  const before = clone(song);
  const plan = DocOps.planLyricAnchorMove(song, { si: 0, bi: 0, ei: 1 },
    { si: 0, bi: 1, syllable: 0 });
  assert.match(plan.error, /one beat per chord/);
  assert.deepEqual(song, before);
});

// ---- section lyric flow / wrapping ----

test("buildLyricFlow joins continuation syllables across chords and bars", () => {
  const section = { bars: [
    [{ chord: "Bm7/F#", text: "A tris-" }, { chord: "E13", text: "te-" }],
    [{ chord: "%", text: "za e se-" }, { chord: "A7", text: "nho- ra," }],
  ] };
  const before = clone(section);
  const flow = DocOps.buildLyricFlow(section);

  assert.equal(flow.text, "A tristeza e senhora,");
  assert.deepEqual(flow.spans.map((span) => span.text),
    ["A", "tris", "te", "za", "e", "se", "nho", "ra,"]);
  assert.deepEqual(flow.spans.map(({ bi, ei, k, syllable }) => ({ bi, ei, k, syllable })), [
    { bi: 0, ei: 0, k: 0, syllable: 0 },
    { bi: 0, ei: 0, k: 1, syllable: 1 },
    { bi: 0, ei: 1, k: 0, syllable: 2 },
    { bi: 1, ei: 0, k: 0, syllable: 0 },
    { bi: 1, ei: 0, k: 1, syllable: 1 },
    { bi: 1, ei: 0, k: 2, syllable: 2 },
    { bi: 1, ei: 1, k: 0, syllable: 3 },
    { bi: 1, ei: 1, k: 1, syllable: 4 },
  ]);
  assert.deepEqual(section, before);
});

test("buildLyricFlow preserves case, accents, punctuation, UTF-16 offsets, and anchors", () => {
  const section = { bars: [[
    { chord: "C", text: "É" },
    { chord: "G7" },
    { chord: "%", text: "São, 😀" },
    { chord: "Am", text: "Você!" },
    { chord: "D7" },
  ]] };
  const flow = DocOps.buildLyricFlow(section);

  assert.equal(flow.text, "É São, 😀 Você!");
  assert.deepEqual(flow.spans.map(({ text, start, end }) => ({ text, start, end })), [
    { text: "É", start: 0, end: 1 },
    { text: "São,", start: 2, end: 6 },
    { text: "😀", start: 7, end: 9 },
    { text: "Você!", start: 10, end: 15 },
  ]);
  assert.deepEqual(flow.anchors, [
    { at: 0, bi: 0, ei: 0, hasLyric: true },
    { at: 2, bi: 0, ei: 1, hasLyric: false },
    { at: 10, bi: 0, ei: 3, hasLyric: true },
    { at: 15, bi: 0, ei: 4, hasLyric: false },
  ]);
});

test("buildLyricFlow preserves a standalone hyphen as punctuation", () => {
  const flow = DocOps.buildLyricFlow({ bars: [[{ chord: "C", text: "fica - Depois" }]] });
  assert.equal(flow.text, "fica - Depois");
  assert.deepEqual(flow.spans.map(({ text, start, end }) => ({ text, start, end })), [
    { text: "fica", start: 0, end: 4 },
    { text: "-", start: 5, end: 6 },
    { text: "Depois", start: 7, end: 13 },
  ]);
});

test("buildLyricFlow preserves a terminal hyphen and co-locates textless chord anchors", () => {
  const flow = DocOps.buildLyricFlow({ bars: [
    [{ chord: "C", text: "fica" }, { chord: "G" }],
    [{ chord: "Am" }, { chord: "%", text: "Depois-" }],
  ] });
  assert.equal(flow.text, "fica Depois-");
  assert.deepEqual(flow.anchors, [
    { at: 0, bi: 0, ei: 0, hasLyric: true },
    { at: 5, bi: 0, ei: 1, hasLyric: false },
    { at: 5, bi: 1, ei: 0, hasLyric: false },
  ]);
});

test("wrapLyricFlow uses word boundaries, retains oversized words, and partitions coordinates", () => {
  const flow = DocOps.buildLyricFlow({ bars: [[
    { chord: "C", text: "Uma palavra-" },
    { chord: "G", text: "grandíssima aqui" },
    { chord: "Am" },
  ]] });
  const snapshot = clone(flow);
  const rows = DocOps.wrapLyricFlow(flow, 8);

  assert.deepEqual(rows.map(({ start, end, text }) => ({ start, end, text })), [
    { start: 0, end: 3, text: "Uma" },
    { start: 4, end: 22, text: "palavragrandíssima" },
    { start: 23, end: 27, text: "aqui" },
  ]);
  assert.deepEqual(rows.flatMap((row) => row.spans), flow.spans);
  assert.deepEqual(rows.flatMap((row) => row.anchors), flow.anchors);
  assert.equal(rows.flatMap((row) => row.anchors).length, flow.anchors.length);
  assert.deepEqual(flow, snapshot);
});

test("wrapLyricFlow retains anchors exactly at final text end and handles empty text", () => {
  const flow = DocOps.buildLyricFlow({ bars: [[{ chord: "C", text: "one two" }, { chord: "G" }]] });
  const rows = DocOps.wrapLyricFlow(flow, 3);
  assert.deepEqual(rows.map((row) => row.text), ["one", "two"]);
  assert.deepEqual(rows[1].anchors, [{ at: 7, bi: 0, ei: 1, hasLyric: false }]);
  assert.deepEqual(DocOps.wrapLyricFlow(DocOps.buildLyricFlow({ bars: [[{ chord: "C" }]] }), 10), []);
});

test("wrapLyricFlow accepts measured glyph widths", () => {
  const flow = DocOps.buildLyricFlow({ bars: [[{ chord: "C", text: "😀 oi lá" }]] });
  const width = (text) => Array.from(text).reduce((sum, character) =>
    sum + (character === "😀" ? 2 : 1), 0);
  assert.deepEqual(DocOps.wrapLyricFlow(flow, 4, width).map((row) => row.text),
    ["😀", "oi", "lá"]);
});

test("wrapLyricFlow measures display columns while retaining UTF-16 coordinates", () => {
  const flow = DocOps.buildLyricFlow({ bars: [[{ chord: "C", text: "😀 oi lá" }]] });
  const rows = DocOps.wrapLyricFlow(flow, 4);
  assert.deepEqual(rows.map(({ start, end, text }) => ({ start, end, text })), [
    { start: 0, end: 5, text: "😀 oi" },
    { start: 6, end: 8, text: "lá" },
  ]);
});
