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
