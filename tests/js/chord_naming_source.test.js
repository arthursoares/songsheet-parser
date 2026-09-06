const {test} = require("node:test");
const assert = require("node:assert/strict");
global.window = globalThis;
require("../../scripts/qa_static/vendor/tonal.bundle.js");
require("../../scripts/qa_static/vendor/chord-symbol.bundle.js");
require("../../scripts/qa_static/chord_naming.js");

for (const name of ["Em7/9", "Bm7/9/F#", "Dm7/11", "C7/13", "C6/9"]) {
  test(`source tension notation is valid without renaming the stored chord: ${name}`, () => {
    assert.equal(window.ChordNaming.validateName(name).valid, true);
  });
}
for (const name of ["C77/9", "C1/3", "C7/9garbage"]) {
  test(`source notation conversion cannot launder malformed input: ${name}`, () => {
    assert.equal(window.ChordNaming.validateName(name).valid, false);
  });
}
