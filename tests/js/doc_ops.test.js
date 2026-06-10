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
  DocOps.splitBar(song, 0, 1);
  assert.deepEqual(song.sections[0].bars[2], [{ chord: "%" }]);
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

test("reanchoredBar returns null for no-op or invalid moves", () => {
  const bar = makeSong().sections[0].bars[0];
  assert.equal(DocOps.reanchoredBar(bar, 1, 2), null); // already at syllable 2
  assert.equal(DocOps.reanchoredBar(bar, 5, 0), null); // no such chord
  assert.equal(DocOps.reanchoredBar(bar, -1, 0), null);
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
