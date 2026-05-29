#!/usr/bin/env node
/**
 * Render a .chordmark file to a standalone HTML page using Arthur's ChordMark fork.
 *
 * The fork is a sibling repo (not part of songsheet-parser). This script bundles
 * the fork's source on the fly with its own esbuild, then renders headlessly via
 * the fork's own jsdom. Point at the fork with --chordmark-repo or $CHORDMARK_REPO.
 *
 * Usage:
 *   node scripts/render_chordmark.js <input.chordmark> <output.html> [--chordmark-repo PATH]
 *
 * Defaults the fork path to ../chordmark/chord-mark relative to this repo.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const os = require("os");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const inPath = positional[0];
const outPath = positional[1];
if (!inPath || !outPath) {
  console.error("usage: render_chordmark.js <input.chordmark> <output.html> [--chordmark-repo PATH]");
  process.exit(2);
}

const repoRoot = path.resolve(__dirname, "..");
const fork = path.resolve(
  arg("--chordmark-repo", process.env.CHORDMARK_REPO || path.join(repoRoot, "..", "chordmark", "chord-mark"))
);
const entry = path.join(fork, "packages", "chord-mark", "src", "chordMark.js");
const esbuild = path.join(fork, "node_modules", ".bin", "esbuild");
const jsdomPath = path.join(fork, "node_modules", "jsdom");

for (const [label, p] of [["fork source", entry], ["esbuild", esbuild], ["jsdom", jsdomPath]]) {
  if (!fs.existsSync(p)) {
    console.error(`Cannot find ${label} at ${p}\nSet --chordmark-repo or $CHORDMARK_REPO to the chord-mark package dir.`);
    process.exit(1);
  }
}

// Bundle the fork's source to a temp CJS module (uses the fork's own deps).
const bundle = path.join(os.tmpdir(), `chordmark-bundle-${process.pid}.cjs`);
execFileSync(esbuild, [entry, "--bundle", "--format=cjs", "--platform=node", `--outfile=${bundle}`], {
  stdio: ["ignore", "ignore", "inherit"],
});

// Headless DOM for the renderer (it uses document + DOMPurify).
const { JSDOM } = require(jsdomPath);
const dom = new JSDOM("<!doctype html><html><body></body></html>");
global.window = dom.window;
global.document = dom.window.document;
global.self = dom.window;
global.navigator = dom.window.navigator;

const cm = require(bundle);
const src = fs.readFileSync(inPath, "utf8");
const parsed = cm.parseSong(src);
const inner = cm.renderSong(parsed, {
  alignChordsWithLyrics: true,
  showChordDiagrams: "inline",
  diagramSize: "medium",
});

// Compile the fork's own theme SCSS so the preview uses the REAL ChordMark styles
// (the renderer emits cmTheme-scoped classes; without the theme CSS it looks broken).
// Theme is namespaced under .cmTheme-<name>, so the song must be wrapped in it.
const THEME = "print";
let themeCss = "";
const sass = path.join(fork, "node_modules", ".bin", "sass");
const themeScss = path.join(fork, "packages", "chord-mark-themes", "scss", "themes", `${THEME}.scss`);
if (fs.existsSync(sass) && fs.existsSync(themeScss)) {
  try {
    themeCss = execFileSync(sass, ["--no-source-map", "--quiet", themeScss], { encoding: "utf8" });
  } catch (e) {
    themeCss = "";
  }
}

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  body{background:#fff;margin:0;padding:24px}
  ${themeCss}
</style></head><body><div class="cmTheme-${THEME}">${inner}</div></body></html>`;
fs.writeFileSync(outPath, html);
fs.rmSync(bundle, { force: true });

const diagrams = (inner.match(/<svg/g) || []).length;
console.log(`rendered ${path.basename(inPath)} -> ${outPath}  (${diagrams} chord diagrams)`);
