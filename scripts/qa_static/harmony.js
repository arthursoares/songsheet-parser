// Harmony tab (C1): measures + chord cells + colour-coded Roman numerals +
// lyrics, fed by POST /api/harmony-doc with the CURRENT in-memory doc — so
// unsaved edits are analyzed live, same contract as the Preview tab.
// Visual language ported from the validated prototype
// (experiments/harmonic-analysis/desde-viz.html).

"use strict";

// engine function name → CSS color var (secondary_* share the secondary hue)
const HM_FN_COLORS = {
  tonic: "--fn-tonic",
  subdominant: "--fn-subdominant",
  dominant: "--fn-dominant",
  secondary_dominant: "--fn-secondary",
  secondary_ii: "--fn-secondary",
  passing: "--fn-passing",
  chromatic: "--fn-chromatic",
  unknown: "--fn-chromatic",
};

function hmColor(fn) {
  const v = HM_FN_COLORS[fn] || "--muted";
  return getComputedStyle(document.documentElement).getPropertyValue(v).trim();
}

// One-line native tooltip per cell until the C3/C4 rich panel lands.
function hmCellTitle(e) {
  const parts = [];
  if (e.func_label) parts.push(`${e.function} · ${e.func_label}`);
  if (e.quality) parts.push(`quality ${e.quality} (${e.quality_source || "?"})`);
  if (e.why) parts.push(e.why);
  if (e.tonic_target) parts.push(`tonicizing ${e.tonic_target}`);
  if (e.devices && e.devices.length) parts.push("devices: " + e.devices.join(", "));
  parts.push("confidence " + e.confidence);
  if (e.discrepancy) parts.push("⚠ " + e.discrepancy);
  return parts.join("\n");
}

function hmHeader(analysis) {
  const k = analysis.key || {};
  const s = analysis.summary || {};
  const bits = [];
  if (k.tonic_name) {
    bits.push(`key ${k.tonic_name} ${k.mode || ""} (${k.how}` +
      (k.how !== "stored" ? `, confidence ${k.confidence}` : "") + `)`);
    if (k.how === "stored" && k.cadence_agrees === false) {
      bits.push("⚠ cadence estimate disagrees with the stored key");
    }
  } else {
    bits.push("key: undetermined");
  }
  bits.push(`${s.events ?? 0} events`);
  const dev = s.devices || {};
  const devBits = Object.keys(dev).sort().map((d) => `${d} ×${dev[d]}`);
  if (devBits.length) bits.push(devBits.join("  ·  "));
  if (s.low_confidence) bits.push(`${s.low_confidence} low-confidence`);
  if (s.discrepancies) bits.push(`${s.discrepancies} discrepancies`);
  return bits.join("   ·   ");
}

function hmLegend() {
  const wrap = document.createElement("div");
  wrap.className = "hm-legend";
  [["tonic", "tonic"], ["subdominant", "subdominant"], ["dominant", "dominant"],
   ["secondary_dominant", "secondary"], ["passing", "passing"],
   ["chromatic", "chromatic"]].forEach(([fn, label]) => {
    const chip = document.createElement("span");
    chip.className = "hm-chip";
    const dot = document.createElement("span");
    dot.className = "hm-dot";
    dot.style.background = hmColor(fn);
    chip.appendChild(dot);
    chip.appendChild(document.createTextNode(label));
    wrap.appendChild(chip);
  });
  return wrap;
}

function hmBuildScore(analysis) {
  const score = document.createElement("div");
  // group events: section index → bar index → [events]
  const sections = new Map();
  for (const e of analysis.events) {
    if (!sections.has(e.section)) {
      sections.set(e.section, { label: e.section_label, bars: new Map() });
    }
    const sec = sections.get(e.section);
    if (!sec.bars.has(e.bar)) sec.bars.set(e.bar, []);
    sec.bars.get(e.bar).push(e);
  }

  for (const [si, sec] of sections) {
    const secDiv = document.createElement("div");
    secDiv.className = "hm-section";
    const lbl = document.createElement("div");
    lbl.className = "hm-seclabel";
    lbl.textContent = sec.label || `Section ${si + 1}`;
    secDiv.appendChild(lbl);

    const barsDiv = document.createElement("div");
    barsDiv.className = "hm-bars";
    for (const [, events] of sec.bars) {
      const barEl = document.createElement("div");
      barEl.className = "hm-bar";
      for (const e of events) {
        const cell = document.createElement("div");
        cell.className = "hm-cell" +
          (e.is_percent ? " held" : "") +
          (e.confidence === "low" ? " lowconf" : "");
        cell.title = hmCellTitle(e);

        const sym = document.createElement("div");
        sym.className = "hm-sym";
        sym.textContent = e.is_percent ? "╶ ╴" : (e.symbol || "?");
        cell.appendChild(sym);

        if (!e.is_percent) {
          const rom = document.createElement("div");
          rom.className = "hm-rom";
          rom.style.color = hmColor(e.function);
          rom.textContent = e.roman || "";
          cell.appendChild(rom);
        }
        if (e.text) {
          const ly = document.createElement("div");
          ly.className = "hm-lyr";
          ly.textContent = e.text;
          cell.appendChild(ly);
        }
        const fb = document.createElement("div");
        fb.className = "hm-fnbar";
        fb.style.background = hmColor(e.function);
        cell.appendChild(fb);

        barEl.appendChild(cell);
      }
      barsDiv.appendChild(barEl);
    }
    secDiv.appendChild(barsDiv);
    score.appendChild(secDiv);
  }
  return score;
}

// Entry point, called by showView("harmony"). Re-analyzes the in-memory doc.
async function renderHarmony() {
  const head = document.getElementById("hmHead");
  const legend = document.getElementById("hmLegend");
  const scoreWrap = document.getElementById("hmScore");
  if (!state.doc) {
    head.textContent = "no song loaded";
    legend.innerHTML = "";
    scoreWrap.innerHTML = "";
    return;
  }
  head.textContent = "analyzing…";
  try {
    const res = await fetch("/api/harmony-doc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.doc),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      head.textContent = "analysis failed: " + (err.error || res.status);
      scoreWrap.innerHTML = "";
      return;
    }
    const analysis = await res.json();
    head.textContent = hmHeader(analysis);
    legend.innerHTML = "";
    legend.appendChild(hmLegend());
    scoreWrap.innerHTML = "";
    scoreWrap.appendChild(hmBuildScore(analysis));
  } catch (e) {
    head.textContent = "analysis failed: " + e;
    scoreWrap.innerHTML = "";
  }
}
