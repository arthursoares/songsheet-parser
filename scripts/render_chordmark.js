#!/usr/bin/env node
/**
 * Render a .chordmark file to a standalone HTML page using Arthur's ChordMark fork.
 *
 * The fork is a sibling repo (not part of songsheet-parser). This script bundles
 * the fork's source on the fly with its own esbuild, then renders headlessly via
 * the fork's own jsdom. Point at the fork with --chordmark-repo or $CHORDMARK_REPO.
 *
 * Usage:
 *   node scripts/render_chordmark.js <input.chordmark> <output.html>
 *       [--chordmark-repo PATH] [--diagrams dictionary|inline|both] [--expected-bars N,N,...]
 *       [--chart-data PATH]
 *
 * Looks for an installed sibling fork, then .local/chordmark-runtime.
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
const defaultForks = [
  path.join(repoRoot, "..", "chordmark", "chord-mark"),
  path.join(repoRoot, ".local", "chordmark-runtime"),
];
const installedFork = defaultForks.find((directory) =>
  fs.existsSync(path.join(directory, "node_modules", ".bin", "esbuild")) &&
  fs.existsSync(path.join(directory, "node_modules", "jsdom")));
const fork = path.resolve(
  arg("--chordmark-repo", process.env.CHORDMARK_REPO || installedFork || defaultForks[0])
);
const diagramLayout = arg("--diagrams", "inline");
if (!["dictionary", "inline", "both"].includes(diagramLayout)) {
  console.error("Expected --diagrams dictionary, inline, or both.");
  process.exit(2);
}
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
const src = sourceForFork(fs.readFileSync(inPath, "utf8"));
const parsed = cm.parseSong(src);
const chordLines = parsed.allLines.filter((line) => line.type === "chord");
const expectedBars = arg("--expected-bars");
if (expectedBars) {
  const parsedBars = chordLines.map((line) => line.model.allBars.length).join(",");
  if (parsedBars !== expectedBars) {
    failChartData("ChordMark could not preserve the chart’s bar boundaries.");
  }
}
const chartDataPath = arg("--chart-data");
let chordSymbolRenderer = false;
let expectedRenderedLabels = null;
let renderedLabels = 0;
if (chartDataPath) {
  let chartData;
  try {
    chartData = JSON.parse(fs.readFileSync(chartDataPath, "utf8"));
  } catch (error) {
    failChartData(`Cannot read chart data: ${error.message}`);
  }
  const labels = applyChartData(parsed, chordLines, chartData);
  expectedRenderedLabels = labels.length;
  chordSymbolRenderer = () => labels[renderedLabels++];
}
if (diagramLayout !== "inline" && !chartDataPath) {
  for (const line of parsed.allLines) {
    if (line.type !== "chord") continue;
    for (const bar of line.model.allBars) {
      for (const chord of bar.allChords) {
        const name = chord.string.match(/[A-G][^\s\[]*/)?.[0];
        if (name && chord.inlineVoicing) {
          parsed.chordDefinitions[name] ??= { frets: chord.inlineVoicing, source: "inline" };
        }
      }
    }
  }
}
const inner = cm.renderSong(parsed, {
  alignChordsWithLyrics: true,
  chordSymbolRenderer,
  showChordDiagrams: diagramLayout,
  diagramSize: "medium",
});
if (expectedRenderedLabels !== null && renderedLabels !== expectedRenderedLabels) {
  failChartData(`ChordMark rendered ${renderedLabels} chord slots; chart data has ` +
    `${expectedRenderedLabels}.`);
}

function failChartData(message) {
  console.error(message);
  fs.rmSync(bundle, { force: true });
  process.exit(3);
}

function escapeHtml(value) {
  return value.replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function validateSlot(slot, location) {
  if (!slot || typeof slot !== "object" || Array.isArray(slot) ||
      typeof slot.name !== "string" || !(slot.voicing === null || Array.isArray(slot.voicing))) {
    failChartData(`Invalid chart-data slot at ${location}.`);
  }
  if (slot.voicing !== null && (slot.voicing.length !== 6 ||
      slot.voicing.some((fret) => fret !== null &&
        (!Number.isInteger(fret) || fret < 0 || fret > 24)))) {
    failChartData(`Invalid chart-data voicing at ${location}.`);
  }
  if (slot.name === "" && slot.voicing !== null) {
    failChartData(`Blank chart-data slot must not have a voicing at ${location}.`);
  }
}

function applyChartData(parsedSong, lines, chartData) {
  if (!Array.isArray(chartData)) {
    failChartData("Chart data must be an array of chord-line rows.");
  }
  if (chartData.length !== lines.length) {
    failChartData(`Chart data has ${chartData.length} rows; ChordMark parsed ${lines.length}.`);
  }

  // Parser directives produce a normal object. Copy through a null-prototype
  // dictionary so user-provided chord names cannot mutate its prototype.
  const definitions = Object.assign(Object.create(null), parsedSong.chordDefinitions || {});
  const labels = [];
  chartData.forEach((row, rowIndex) => {
    if (!Array.isArray(row)) {
      failChartData(`Chart-data row ${rowIndex + 1} must be an array of bars.`);
    }
    const bars = lines[rowIndex].model.allBars;
    if (row.length !== bars.length) {
      failChartData(`Chart-data row ${rowIndex + 1} has ${row.length} bars; ChordMark parsed ${bars.length}.`);
    }
    row.forEach((slots, barIndex) => {
      if (!Array.isArray(slots)) {
        failChartData(`Chart-data bar ${rowIndex + 1}.${barIndex + 1} must be an array of slots.`);
      }
      const bar = bars[barIndex];
      if (slots.length !== bar.allChords.length) {
        failChartData(`Chart-data bar ${rowIndex + 1}.${barIndex + 1} has ${slots.length} slots; ` +
          `ChordMark parsed ${bar.allChords.length}.`);
      }
      bar.isRepeated = false;
      slots.forEach((slot, slotIndex) => {
        const location = `${rowIndex + 1}.${barIndex + 1}.${slotIndex + 1}`;
        validateSlot(slot, location);
        if (slot.name === "" && slots.length !== 1) {
          failChartData(`Blank chart-data slot must be the only slot in its bar at ${location}.`);
        }
        const chord = bar.allChords[slotIndex];
        chord.inlineVoicing = slot.voicing || undefined;
        if (chord.model && chord.model.input && typeof chord.model.input === "object") {
          // Prevent a dictionary voicing for the same played name from leaking
          // into an occurrence whose source slot explicitly has no voicing.
          chord.model.input.symbol = slot.voicing ? slot.name : "";
        }
        // The fork's lyric spacer expects at least one character per slot.
        labels.push(slot.name ? escapeHtml(slot.name) : "\u00a0");
        if (slot.name && slot.voicing && !Object.hasOwn(definitions, slot.name)) {
          definitions[slot.name] = { frets: slot.voicing, source: "chart-data" };
        }
      });
    });
  });
  parsedSong.chordDefinitions = definitions;
  return labels;
}

function sourceForFork(source) {
  const sample = "x,3,2,0,1,0";
  const acceptsInline = cm.parseSong(`C[${sample}]`).allLines.some((line) => line.type === "chord");
  const acceptsDefinition = Object.hasOwn(cm.parseSong(`chord C ${sample}`).chordDefinitions, "C");
  if (acceptsInline && acceptsDefinition) return source;

  // Older forks use one character per string: 0–9, a–o for 10–24, and x.
  const fret = "(?:x|[0-9]|1[0-9]|2[0-4])";
  const voicing = `${fret}(?:,${fret}){5}`;
  const inline = new RegExp(`(^|\\s)([A-G][^\\s\\[]*)\\[(${voicing})\\]`, "gi");
  const definition = new RegExp(`^(chord\\s+.+?\\s+)(${voicing})\\s*$`, "i");
  const compact = (value) => value.toLowerCase().split(",").map((token) => {
    const number = Number(token);
    return number >= 10 ? String.fromCharCode(87 + number) : token;
  }).join("");
  return source.split("\n").map((line) => {
    if (line.startsWith("chord ")) {
      return acceptsDefinition ? line : line.replace(definition, (_, prefix, frets) => prefix + compact(frets));
    }
    if (acceptsInline) return line;
    const converted = line.replace(inline, (_, space, chord, frets) =>
      `${space}${chord}[${compact(frets)}]`);
    return converted !== line && cm.parseSong(converted).allLines.some((line) => line.type === "chord")
      ? converted : line;
  }).join("\n");
}

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
