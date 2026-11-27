// Tests for the chord dictionary's pure grouping / batch-edit / merge logic.
// Run with: node --test tests/js/
const { test } = require("node:test");
const assert = require("node:assert/strict");

const Dict = require("../../scripts/qa_static/chord_dictionary.js");

function makeSong() {
  return {
    sections: [
      {
        bars: [
          [{ chord: "Dm7", voicing: "x,5,7,5,6,x" }, { chord: "G7", voicing: "3,x,3,4,3,x" }],
          [{ chord: "Dm7", voicing: "x,5,7,5,6,x" }],
          [{ chord: "Dm7", voicing: "x,5,7,5,6,5" }], // same name, different voicing
          [{ chord: "%" }],
        ],
      },
    ],
  };
}

test("buildDictionary groups by exact name+voicing, excludes %, sorts by count", () => {
  const groups = Dict.buildDictionary(makeSong());
  assert.deepEqual(
    groups.map((g) => [g.chord, g.voicing, g.count]),
    [
      ["Dm7", "x,5,7,5,6,x", 2],
      ["G7", "3,x,3,4,3,x", 1],
      ["Dm7", "x,5,7,5,6,5", 1],
    ],
  );
  assert.deepEqual(groups[0].occurrences, [{ si: 0, bi: 0, ei: 0 }, { si: 0, bi: 1, ei: 0 }]);
});

test("buildDictionary exposes the printed voicing when uniform across a group", () => {
  const song = makeSong();
  song.sections[0].bars[0][0].voicing_printed = "x,5,7,5,6,5";
  song.sections[0].bars[1][0].voicing_printed = "x,5,7,5,6,5";
  const groups = Dict.buildDictionary(song);
  const dm7 = groups.find((g) => g.key === Dict.entryKey("Dm7", "x,5,7,5,6,x"));
  assert.equal(dm7.printed, "x,5,7,5,6,5");
  // mixed printed values -> no uniform suggestion
  song.sections[0].bars[1][0].voicing_printed = "x,5,7,5,6,x";
  const dm7b = Dict.buildDictionary(song).find((g) => g.key === dm7.key);
  assert.equal(dm7b.printed, null);
  // groups never audited expose null
  const g7 = groups.find((g) => g.chord === "G7");
  assert.equal(g7.printed, null);
});

test("applyEdit renames every occurrence in one group only", () => {
  const song = makeSong();
  const key = Dict.entryKey("Dm7", "x,5,7,5,6,x");
  assert.equal(Dict.applyEdit(song, key, { chord: "Dmin7" }), 2);
  assert.equal(song.sections[0].bars[0][0].chord, "Dmin7");
  assert.equal(song.sections[0].bars[1][0].chord, "Dmin7");
  assert.equal(song.sections[0].bars[2][0].chord, "Dm7"); // other voicing untouched
});

test("printed evidence counts expose conflicts and restoration preserves unprinted entries", () => {
  const song = { sections: [{ bars: [[
    { chord: "C", voicing: "x,3,2,0,1,0", voicing_printed: "x,3,5,5,5,3", observation_id: "one" },
    { chord: "C", voicing: "x,3,2,0,1,0", voicing_printed: "x,3,2,0,1,0" },
    { chord: "C", voicing: "x,3,2,0,1,0" },
  ]] }] };
  const group = Dict.buildDictionary(song)[0];
  assert.equal(group.printedVariants, 2);
  assert.equal(group.printedCount, 2);
  assert.equal(group.unprintedCount, 1);
  assert.equal(group.printDiffCount, 1);
  assert.equal(group.printed, null);
  assert.equal(Dict.applyPrinted(song, group.key), 1);
  assert.equal(song.sections[0].bars[0][0].observation_id, "one");
  assert.equal(song.sections[0].bars[0][0].voicing_printed, "x,3,5,5,5,3");
  assert.equal(song.sections[0].bars[0][2].voicing, "x,3,2,0,1,0");
  assert.equal("voicing_printed" in song.sections[0].bars[0][2], false);
});

test("applyEdit with empty voicing deletes the voicing key", () => {
  const song = makeSong();
  const key = Dict.entryKey("G7", "3,x,3,4,3,x");
  assert.equal(Dict.applyEdit(song, key, { voicing: null }), 1);
  assert.equal("voicing" in song.sections[0].bars[0][1], false);
});

test("mergeEntries collapses groups onto the canonical name+voicing", () => {
  const song = makeSong();
  const keys = [Dict.entryKey("Dm7", "x,5,7,5,6,x"), Dict.entryKey("Dm7", "x,5,7,5,6,5")];
  const n = Dict.mergeEntries(song, keys, { chord: "Dm7", voicing: "x,5,7,5,6,x" });
  assert.equal(n, 3);
  const groups = Dict.buildDictionary(song);
  assert.deepEqual(
    groups.map((g) => [g.chord, g.voicing, g.count]),
    [
      ["Dm7", "x,5,7,5,6,x", 3],
      ["G7", "3,x,3,4,3,x", 1],
    ],
  );
});

test("validateVoicing accepts canonical, blank, and all-muted voicings while normalizing", () => {
  assert.deepEqual(Dict.validateVoicing("x,3,2,0,1,0"), { valid: true, normalized: "x,3,2,0,1,0" });
  assert.deepEqual(Dict.validateVoicing("0,24,0,0,0,0"), { valid: true, normalized: "0,24,0,0,0,0" });
  assert.deepEqual(Dict.validateVoicing(" X, 03, 2, 0, 1, 0 "), { valid: true, normalized: "x,3,2,0,1,0" });
  assert.deepEqual(Dict.validateVoicing(""), { valid: true, normalized: "" });
  assert.deepEqual(Dict.validateVoicing("   "), { valid: true, normalized: "" });
  assert.deepEqual(Dict.validateVoicing(null), { valid: true, normalized: "" });
  assert.deepEqual(Dict.validateVoicing(undefined), { valid: true, normalized: "" });
  assert.deepEqual(Dict.validateVoicing("x,x,x,x,x,x"), { valid: true, normalized: "" });
  assert.deepEqual(Dict.validateVoicing("X, X, x, x, X, x"), { valid: true, normalized: "" });
});

test("validateVoicing rejects malformed voicings and out-of-range frets", () => {
  for (const bad of [
    "x32010",
    "x,3,2,0,1",
    "x,3,2,0,1,0,0",
    "x,3,2,0,1,25",
    "-1,0,0,0,0,0",
    "x,3,2,0,a,0",
    "x,,2,0,1,0",
    "x,3,2,0,1,0,",
  ]) {
    const res = Dict.validateVoicing(bad);
    assert.equal(res.valid, false, `expected invalid for ${bad}`);
    assert.ok(res.error && res.error.length > 0);
  }
});

test("mergeEntries rejects invalid voicings without mutating and preserves provenance on valid merges", () => {
  const song = makeSong();
  song._meta = { extraction_sources: { s1: {} } };
  const target = song.sections[0].bars[0][0];
  target.voicing_printed = "x,5,7,5,6,5";
  target.observation_id = "obs-dm7";
  target.text = "hello";
  target.chord_review = { status: "deferred", snapshot: { chord: "Dm7" } };
  const snapshot = JSON.stringify(song);

  const keys = [Dict.entryKey("Dm7", "x,5,7,5,6,x"), Dict.entryKey("Dm7", "x,5,7,5,6,5")];
  assert.equal(Dict.mergeEntries(song, keys, { chord: "Dm7", voicing: "x32010" }), 0);
  assert.equal(Dict.mergeEntries(song, keys, { chord: "Dm7", voicing: "x,5,7,5,6,25" }), 0);
  assert.equal(JSON.stringify(song), snapshot);

  // Valid normalized merge preserves provenance fields
  assert.equal(Dict.mergeEntries(song, keys, { chord: "Dm7", voicing: " X, 05, 7, 5, 6, 5 " }), 3);
  assert.equal(target.voicing, "x,5,7,5,6,5");
  assert.equal(target.voicing_printed, "x,5,7,5,6,5");
  assert.equal(target.observation_id, "obs-dm7");
  assert.equal(target.text, "hello");
  assert.deepEqual(target.chord_review, { status: "deferred", snapshot: { chord: "Dm7" } });
  assert.deepEqual(song._meta, { extraction_sources: { s1: {} } });

  // Clearing via all-muted "x,x,x,x,x,x" deletes e.voicing while keeping provenance
  assert.equal(Dict.mergeEntries(song, [Dict.entryKey("Dm7", "x,5,7,5,6,5")], { chord: "Dm7", voicing: "x,x,x,x,x,x" }), 3);
  assert.equal("voicing" in target, false);
  assert.equal(target.voicing_printed, "x,5,7,5,6,5");
  assert.equal(target.observation_id, "obs-dm7");
});
