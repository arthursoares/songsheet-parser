// Pin chord-symbol (the QA tool's chord-name validator) against the shared
// parity fixture, mirror of tests/test_chord_name_parity.py: 'agreed' symbols
// must keep matching harmony.py's interval sets; 'divergent' pins this side's
// current deliberate behavior so vocabulary drift fails loudly.
// Run with: node --test tests/js/
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// The vendored bundles are browser IIFEs that attach to `window`.
global.window = globalThis;
require("../../scripts/qa_static/vendor/tonal.bundle.js");
require("../../scripts/qa_static/vendor/chord-symbol.bundle.js");

const parse = window.chordSymbol.chordParserFactory();
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "fixtures", "chord_name_parity.json"), "utf8"),
);

function pcs(symbol) {
  const parsed = parse(symbol);
  assert.equal(parsed.error, undefined, `chord-symbol failed to parse ${symbol}`);
  return [...new Set(parsed.normalized.semitones.map((s) => s % 12))].sort((a, b) => a - b);
}

for (const c of FIXTURE.agreed) {
  test(`agreed: ${c.symbol} -> [${c.pcs}]`, () => {
    assert.deepEqual(pcs(c.symbol), c.pcs);
  });
}

for (const c of FIXTURE.divergent) {
  test(`divergent (pinned): ${c.symbol} -> [${c.chord_symbol_pcs}]`, () => {
    assert.deepEqual(pcs(c.symbol), c.chord_symbol_pcs);
  });
}
