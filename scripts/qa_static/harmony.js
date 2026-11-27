// Harmony tab (plan C1–C4 + C7): measures of function-colored chord cells with
// Roman numerals and lyrics, tension/bass/tonicization lanes, device brackets
// with pedagogical tooltips, spotlight chips, a rich click panel (diagram,
// why, confidence), and the key-confirm edit loop. Fed by POST
// /api/harmony-doc with the CURRENT in-memory doc, so unsaved edits are
// analyzed live (same contract as the Preview tab). Visual language ported
// from the validated prototype (experiments/harmonic-analysis/desde-viz.html).

"use strict";

// ---- shared state ----
let hmAnalysis = null;          // last /api/harmony-doc result
let hmCellEls = {};             // event idx -> cell element
const hmSpotlight = new Set();  // active function/device chip keys
let hmSelected = null;          // selected event idx

const HM_PC = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const HM_PC_FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const HM_LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function hmEsc(s) {
  if (typeof esc === "function") return esc(s);
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function hmNoteToPc(name) {
  if (typeof name !== "string") return -1;
  const m = name.trim().match(/^([A-Ga-g])([#b♯♭]*)$/);
  if (!m) return -1;
  let pc = HM_LETTER_PC[m[1].toUpperCase()];
  for (const ch of m[2]) {
    if (ch === "#" || ch === "♯") pc += 1;
    else if (ch === "b" || ch === "♭") pc -= 1;
  }
  return ((pc % 12) + 12) % 12;
}

function hmUseFlatSpelling() {
  return typeof window === "object" && window !== null &&
    window.ChordNaming && typeof window.ChordNaming.getSpelling === "function" &&
    window.ChordNaming.getSpelling() === "flat";
}

function hmPcName(pc) {
  const n = Number(pc);
  if (!Number.isFinite(n)) return "";
  const idx = ((Math.trunc(n) % 12) + 12) % 12;
  return (hmUseFlatSpelling() ? HM_PC_FLAT : HM_PC)[idx];
}

function hmFormatNoteLabel(name) {
  if (!name) return "";
  if (!hmUseFlatSpelling()) return name;
  const pc = hmNoteToPc(name);
  return pc >= 0 ? HM_PC_FLAT[pc] : name;
}

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

function hmCss(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function hmColor(fn) {
  return hmCss(HM_FN_COLORS[fn] || "--muted");
}

// ---- header summary line ----
function hmHeader(analysis) {
  const k = analysis.key || {};
  const s = analysis.summary || {};
  const bits = [];
  if (k.tonic_name) {
    bits.push(`key ${hmFormatNoteLabel(k.tonic_name)} ${k.mode || ""} (${k.how}` +
      (k.how !== "stored" ? `, confidence ${k.confidence}` : "") + `)`);
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

// ---- C7: key confirm / override bar ----
// The cadence estimator proposes a key; one click stores it on the song (via
// the same pushUndo/markDirty path as the header keySel), which is how the
// corpus accumulates confirmed keys ahead of the functional corpus report.
function hmKeyName(name, mode) {
  // keySel option values are sharp-spelled; normalize flats (Db -> C#)
  const pc = hmNoteToPc(name);
  const root = pc >= 0 ? HM_PC[pc] : name;
  return mode === "minor" ? root + "m" : root;
}

function hmApplyKey(name, mode) {
  if (typeof state !== "object" || !state || !state.doc) return;
  pushUndo();
  song().key = hmKeyName(name, mode);
  markDirty();
  $("keySel").value = songKey();
  if (typeof window === "object" && window && window.ChordNaming &&
      typeof window.ChordNaming.setKeyTonic === "function") {
    window.ChordNaming.setKeyTonic(songKey());
  }
  renderBars();
  renderHarmony();   // re-analyzes: Romans/functions re-derive from the stored key
}

function hmKeybar(analysis) {
  const bar = document.getElementById("hmKeybar");
  if (!bar) return;
  bar.innerHTML = "";
  const k = analysis.key || {};
  if (k.how === "stored") {
    if (k.cadence_agrees === false) {
      const cad = (k.candidates || []).find((c) => c.how === "cadence");
      const cadName = cad && cad.tonic_name ? hmFormatNoteLabel(cad.tonic_name) : "";
      const warn = document.createElement("span");
      warn.className = "hm-keywarn";
      warn.textContent = "⚠ the cadence estimate disagrees with the stored key" +
        (cadName ? ` (it suggests ${cadName} ${cad.mode})` : "");
      bar.appendChild(warn);
      if (cad && cad.tonic_name) {
        const btn = document.createElement("button");
        btn.className = "tab";
        btn.textContent = `Use ${cadName} ${cad.mode} instead`;
        btn.onclick = () => hmApplyKey(cad.tonic_name, cad.mode);
        bar.appendChild(btn);
      }
    }
    return; // stored & agreeing: nothing to confirm
  }
  if (!k.tonic_name) return;

  const tonicLabel = hmFormatNoteLabel(k.tonic_name);
  const label = document.createElement("span");
  label.className = "muted";
  label.textContent =
    `inferred key ${tonicLabel} ${k.mode} — not stored on the song yet:`;
  bar.appendChild(label);

  const confirm = document.createElement("button");
  confirm.className = "btn-primary";
  confirm.textContent = `Confirm key ${tonicLabel} ${k.mode}`;
  confirm.onclick = () => hmApplyKey(k.tonic_name, k.mode);
  bar.appendChild(confirm);

  const sel = document.createElement("select");
  sel.setAttribute("aria-label", "Choose an alternative key");
  sel.innerHTML = '<option value="">or pick another…</option>' +
    (k.candidates || [])
      .filter((c) => c.tonic_pc != null)
      .map((c) => {
        const nm = c.tonic_name ? hmFormatNoteLabel(c.tonic_name) : hmPcName(c.tonic_pc);
        return `<option value="${hmEsc(nm)}|${hmEsc(c.mode)}">` +
          `${hmEsc(nm)} ${hmEsc(c.mode)} (${hmEsc(c.how)})</option>`;
      }).join("");
  sel.onchange = () => {
    if (!sel.value) return;
    const [nm, mode] = sel.value.split("|");
    hmApplyKey(nm, mode);
  };
  bar.appendChild(sel);
}

// ---- C3: spotlight legend ----
const HM_FN_CHIPS = [
  ["tonic", "tonic", (e) => e.function === "tonic"],
  ["subdominant", "subdominant", (e) => e.function === "subdominant"],
  ["dominant", "dominant", (e) => e.function === "dominant"],
  ["secondary", "secondary",
    (e) => e.function === "secondary_dominant" || e.function === "secondary_ii"],
  ["passing", "passing", (e) => e.function === "passing"],
  ["chromatic", "chromatic", (e) => e.function === "chromatic"],
];
const HM_DEV_CHIPS = [
  ["ii-V-I", "ii–V–I"],
  ["ii-V", "ii–V"],
  ["secondary_dominant", "secondary dom"],
  ["tritone_sub", "tritone sub"],
  ["chromatic_bass_run", "chromatic bass"],
];

function hmMatchesSpot(e) {
  if (hmSpotlight.size === 0) return true;
  for (const key of hmSpotlight) {
    const fn = HM_FN_CHIPS.find(([k]) => k === key);
    if (fn && fn[2](e)) return true;
    if (!fn && (e.devices || []).includes(key)) return true;
  }
  return false;
}

function hmApplySpotlight() {
  if (!hmAnalysis) return;
  for (const e of hmAnalysis.events) {
    const el = hmCellEls[e.idx];
    if (el) el.classList.toggle("hm-dim", !hmMatchesSpot(e));
  }
  document.querySelectorAll(".hm-lanes [data-event]").forEach((node) => {
    const e = hmAnalysis.events[Number(node.dataset.event)];
    node.classList.toggle("hm-dim", !!e && !hmMatchesSpot(e));
  });
  document.querySelectorAll(".hm-lanes [data-events]").forEach((node) => {
    const matches = node.dataset.events.split(",").some((idx) => hmMatchesSpot(hmAnalysis.events[Number(idx)]));
    node.classList.toggle("hm-dim", !matches);
  });
  document.querySelectorAll("#hmBrackets .hm-bracket").forEach((b) => {
    const on = hmSpotlight.size === 0 || hmSpotlight.has(b.dataset.devkey);
    b.classList.toggle("hm-dim", !on);
  });
}

function hmLegend() {
  const wrap = document.createElement("div");
  wrap.className = "hm-legend";
  const chip = (key, label, color, dev) => {
    const c = document.createElement("button");
    c.type = "button";
    const fn = HM_FN_CHIPS.find(([k]) => k === key);
    const count = dev ? (hmAnalysis?.devices || []).filter((d) => d.type === key).length
      : (hmAnalysis?.events || []).filter((e) => fn && fn[2](e)).length;
    c.disabled = count === 0;
    c.setAttribute("aria-pressed", String(hmSpotlight.has(key)));
    c.className = "hm-chip" + (dev ? " dev" : "");
    if (color) {
      const dot = document.createElement("span");
      dot.className = "hm-dot";
      dot.style.background = color;
      c.appendChild(dot);
    }
    c.appendChild(document.createTextNode(`${label} ${count}`));
    c.onclick = () => {
      if (hmSpotlight.has(key)) hmSpotlight.delete(key);
      else hmSpotlight.add(key);
      c.classList.toggle("active", hmSpotlight.has(key));
      c.setAttribute("aria-pressed", String(hmSpotlight.has(key)));
      hmApplySpotlight();
    };
    if (hmSpotlight.has(key)) c.classList.add("active");
    return c;
  };
  HM_FN_CHIPS.forEach(([key, label]) => wrap.appendChild(
    chip(key, label, hmColor(key === "secondary" ? "secondary_dominant" : key))));
  const sep = document.createElement("span");
  sep.className = "hm-sep";
  wrap.appendChild(sep);
  HM_DEV_CHIPS.forEach(([key, label]) =>
    wrap.appendChild(chip(key, label, null, true)));
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "hm-chip";
  clear.textContent = "clear";
  clear.onclick = () => {
    hmSpotlight.clear();
    wrap.querySelectorAll(".hm-chip").forEach((x) => { x.classList.remove("active"); x.setAttribute("aria-pressed", "false"); });
    hmApplySpotlight();
  };
  wrap.appendChild(clear);
  return wrap;
}

// ---- score ----
function hmCellTitle(e) {
  const parts = [];
  if (e.func_label) parts.push(`${e.function} · ${e.func_label}`);
  if (e.quality) parts.push(`quality ${e.quality} (${e.quality_source || "?"})`);
  if (e.why) parts.push(e.why);
  if (e.tonic_target) parts.push(`tonicizing ${hmFormatNoteLabel(e.tonic_target)}`);
  if (e.devices && e.devices.length) parts.push("devices: " + e.devices.join(", "));
  parts.push("confidence " + e.confidence);
  if (e.discrepancy) parts.push("⚠ " + e.discrepancy);
  return parts.join("\n");
}

function hmBuildScore(analysis) {
  hmCellEls = {};
  const score = document.createElement("div");
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
        const cell = document.createElement("button");
        cell.type = "button";
        cell.className = "hm-cell" +
          (e.is_percent ? " held" : "") +
          (e.confidence === "low" ? " lowconf" :
            e.confidence === "medium" ? " medconf" : "");
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

        cell.onclick = () => hmSelect(e.idx);
        cell.ondblclick = () => hmEditChord(e);
        barEl.appendChild(cell);
        hmCellEls[e.idx] = cell;
      }
      barsDiv.appendChild(barEl);
    }
    secDiv.appendChild(barsDiv);
    score.appendChild(secDiv);
  }
  return score;
}

// ---- C2: lanes (tension contour / bass line / tonicization ribbon) ----
let hmLaneWidth = 1000;
function hmBeats(e) {
  const beats = Number(e?.beats);
  return Number.isFinite(beats) && beats > 0 ? beats : 1;
}
function hmXs(events, width = hmLaneWidth) {
  if (typeof events === "number") events = Array.from({ length: events }, () => ({ beats: 1 }));
  const total = events.reduce((sum, e) => sum + hmBeats(e), 0);
  let beat = 0;
  return events.map((e) => {
    const x = 32 + (width - 44) * beat / total;
    beat += hmBeats(e);
    return x;
  });
}
function hmLaneTicks(events, xs, height) {
  return events.map((e, i) => {
    if (i && e.bar === events[i - 1].bar && e.section === events[i - 1].section) return "";
    const section = !i || e.section !== events[i - 1].section;
    return `<line x1="${xs[i]}" x2="${xs[i]}" y1="0" y2="${height}" stroke="${hmCss("--muted")}" opacity="${section ? .4 : .15}"/>`;
  }).join("");
}
function hmBuildTension(events, xs) {
  const svg = document.getElementById("hmTensionSvg");
  const H = 90, ys = events.map((e) => 78 - 66 * (e.tension || 0) / 3);
  let s = hmLaneTicks(events, xs, H);
  [0, 3].forEach((t) => { s += `<text x="5" y="${78 - 22 * t}" font-size="10" fill="${hmCss("--muted")}">${t}</text>`; });
  events.forEach((e, i) => {
    const x1 = xs[i + 1] ?? hmLaneWidth - 12, y1 = ys[i + 1] ?? ys[i];
    s += `<g data-event="${e.idx}"><path d="M ${xs[i]} ${ys[i]} L ${x1} ${y1}" fill="none" stroke="${hmColor(e.function)}" stroke-width="1.5"/>` +
      `<circle cx="${xs[i]}" cy="${ys[i]}" r="3" fill="${hmColor(e.function)}"/></g>`;
  });
  svg.innerHTML = s;
}
function hmBuildBass(events, xs) {
  const svg = document.getElementById("hmBassSvg"), H = 70;
  let last = null;
  const vals = events.map((e) => { if (e.midis?.length) last = e.midis[0]; return last; });
  const pitches = vals.filter((v) => v != null);
  if (!pitches.length) { svg.innerHTML = ""; return; }
  const lo = Math.min(...pitches), hi = Math.max(...pitches);
  const yfor = (v) => 58 - 42 * (v - lo) / Math.max(1, hi - lo);
  const col = hmCss("--fn-chrombass");
  let s = hmLaneTicks(events, xs, H);
  s += `<text x="3" y="65" fill="${hmCss("--muted")}" font-size="9">${hmPcName(lo)}</text>`;
  events.forEach((e, i) => {
    const v = vals[i];
    if (v == null) return;
    const x1 = xs[i + 1] ?? hmLaneWidth - 12, next = vals[i + 1] ?? v;
    s += `<g data-event="${e.idx}"><path d="M ${xs[i]} ${yfor(v)} H ${x1} V ${yfor(next)}" fill="none" stroke="${col}" stroke-width="1.6"/>` +
      `<circle cx="${xs[i]}" cy="${yfor(v)}" r="2.5" fill="${col}"/>`;
    if (i === 0 || (v !== vals[i - 1] && x1 - xs[i] > 18)) s += `<text x="${xs[i]}" y="${yfor(v) - 5}" fill="${hmCss("--muted")}" font-size="10" text-anchor="middle">${hmEsc(hmPcName(v))}</text>`;
    s += "</g>";
  });
  svg.innerHTML = s;
}
function hmBuildRibbon(analysis, xs) {
  const svg = document.getElementById("hmRibbonSvg");
  if (!svg) return;
  const events = analysis.events, home = analysis.key?.tonic_name;
  const palette = ["--fn-subdominant", "--fn-secondary", "--fn-passing", "--fn-dominant", "--fn-chromatic", "--fn-chrombass"];
  let s = "";
  events.forEach((e, i) => {
    const t = e.tonic_target, isHome = t == null, pc = hmNoteToPc(t);
    const col = hmCss(isHome ? "--fn-tonic" : pc >= 0 ? palette[pc % palette.length] : "--fn-chromatic");
    const x0 = xs[i], x1 = xs[i + 1] ?? hmLaneWidth - 12;
    const lab = isHome ? (home ? `${hmFormatNoteLabel(home)} (home)` : "home") : `→ ${hmFormatNoteLabel(t)}`;
    s += `<g data-event="${e.idx}"><title>${hmEsc(lab)}</title><rect x="${x0}" y="3" width="${Math.max(0, x1 - x0)}" height="20" rx="2" fill="${col}" fill-opacity="${isHome ? .10 : .30}" stroke="${col}" stroke-opacity="0.5"/>`;

    s += "</g>";
  });
  for (let i = 0; i < events.length;) {
    let j = i + 1;
    while (j < events.length && events[j].tonic_target === events[i].tonic_target) j++;
    const x1 = xs[j] ?? hmLaneWidth - 12, target = events[i].tonic_target;
    const label = target == null ? (home ? `${hmFormatNoteLabel(home)} (home)` : "home") : `→ ${hmFormatNoteLabel(target)}`;
    if (x1 - xs[i] > 40) s += `<text data-events="${events.slice(i, j).map((e) => e.idx).join(",")}" x="${(xs[i] + x1) / 2}" y="17" fill="${hmCss("--text")}" font-size="10" text-anchor="middle">${hmEsc(label)}</text>`;
    i = j;
  }
  svg.innerHTML = s + hmLaneTicks(events, xs, 26);
}
function hmRenderLanes() {
  if (!hmAnalysis) return;
  const lanes = document.querySelector("#harmony .hm-lanes");
  hmLaneWidth = Math.max(80, lanes?.clientWidth || 1000);
  const xs = hmXsCache = hmXs(hmAnalysis.events);
  for (const [id, height] of [["hmTensionSvg", 90], ["hmBassSvg", 70], ["hmRibbonSvg", 26], ["hmCursorSvg", lanes?.clientHeight || 260]]) {
    const svg = document.getElementById(id);
    svg.setAttribute("viewBox", `0 0 ${hmLaneWidth} ${height}`);
    if (id !== "hmCursorSvg") {
      svg.setAttribute("tabindex", "0");
      svg.setAttribute("role", "group");
      svg.setAttribute("aria-label", `${id === "hmTensionSvg" ? "Tension" : id === "hmBassSvg" ? "Bass notes" : "Local key"} timeline. Arrow keys seek; Enter plays from selection.`);
      svg.onkeydown = (ev) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(ev.key)) return;
        ev.preventDefault(); ev.stopPropagation();
        const current = hmSelected ?? Math.max(0, hmCurIdx);
        const idx = ev.key === "Home" ? 0 : ev.key === "End" ? xs.length - 1 : Math.max(0, Math.min(xs.length - 1, current + (ev.key === "ArrowRight" ? 1 : ev.key === "ArrowLeft" ? -1 : 0)));
        hmSelect(idx); hmSeek(idx, ev.key === "Enter" || hmPlaying);
      };
      svg.onclick = (ev) => {
      const x = (ev.clientX - svg.getBoundingClientRect().left) * hmLaneWidth / (svg.clientWidth || hmLaneWidth);
      let idx = xs.findIndex((start, i) => x >= start && x < (xs[i + 1] ?? Infinity));
      if (idx < 0) idx = 0;
      hmSelect(idx);
      hmSeek(idx);
      };
    }
  }
  hmBuildTension(hmAnalysis.events, xs);
  hmBuildBass(hmAnalysis.events, xs);
  hmBuildRibbon(hmAnalysis, xs);
  if (hmCurIdx >= 0) {
    hmSegX0 = xs[hmCurIdx];
    hmSegX1 = xs[hmCurIdx + 1] ?? hmLaneWidth - 12;
    const progress = hmSegDur > 0 ? (hmPausedAt ?? (hmNow() - hmSegStart)) / hmSegDur : 0;
    hmSetCursorX(hmSegX0 + (hmSegX1 - hmSegX0) * Math.max(0, Math.min(1, progress)));
  }
  hmApplySpotlight();
}

// ---- C3: device brackets with pedagogical tooltips ----
const HM_DEV_EXPLAIN = {
  "ii-V-I": "ii–V–I — the strongest cadence in tonal harmony: a pre-dominant, " +
    "then the dominant, resolving home onto its target.",
  "ii-V": "ii–V — a pre-dominant pair pointing at a target chord; the " +
    "resolution may be elided or deferred.",
  secondary_dominant: "Secondary dominant — a dominant 7th borrowed to " +
    "tonicize a chord other than I, briefly treating it as a temporary key.",
  tritone_sub: "Tritone substitution — a dominant replaced by the dominant a " +
    "tritone away; same guide-tones, chromatic bass approach.",
  chromatic_bass_run: "Chromatic bass run — the bass walks down by " +
    "half-steps, often through passing chords, linking two diatonic anchors.",
};
const HM_DEV_COLORS = {
  "ii-V-I": "--fn-tonic",
  "ii-V": "--fn-subdominant",
  secondary_dominant: "--fn-secondary",
  tritone_sub: "--fn-secondary",
  chromatic_bass_run: "--fn-chrombass",
};

function hmShowTip(ev, text) {
  const t = document.getElementById("hmTip");
  if (!t) return;
  t.textContent = text;
  t.style.opacity = 1;
  const pad = 8;
  const vw = (typeof window === "object" && window && Number(window.innerWidth)) || 1024;
  const vh = (typeof window === "object" && window && Number(window.innerHeight)) || 768;
  const tipW = t.offsetWidth || 280;
  const tipH = t.offsetHeight || 80;
  let x = ev.clientX + 14;
  if (x + tipW + pad > vw) x = ev.clientX - tipW - 14;
  x = Math.max(pad, Math.min(x, Math.max(pad, vw - tipW - pad)));
  let y = ev.clientY + 14;
  if (y + tipH + pad > vh) y = ev.clientY - tipH - 14;
  y = Math.max(pad, Math.min(y, Math.max(pad, vh - tipH - pad)));
  t.style.left = x + "px";
  t.style.top = y + "px";
}

function hmHideTip() {
  const t = document.getElementById("hmTip");
  if (t) t.style.opacity = 0;
}

let hmBracketsRaf = null;
let hmScoreObserver = null;

function hmRenderBracketsNow(mine) {
  const layer = document.getElementById("hmBrackets");
  if (!layer) return;
  if (!hmAnalysis || (mine && hmAnalysis !== mine)) return;
  if (typeof state === "object" && state && state.activeView !== "harmony") return;
  const wrap = document.getElementById("hmScoreWrap");
  if (!wrap) return;
  layer.innerHTML = "";
  const events = hmAnalysis.events;
  const bars = [...new Set(Object.values(hmCellEls).map((cell) => cell.parentNode).filter(Boolean))];
  bars.forEach((bar) => { bar.style.marginTop = "0px"; });
  const rows = [];
  events.forEach((e) => {
    const cell = hmCellEls[e.idx];
    if (!cell) return;
    const rect = cell.getBoundingClientRect();
    let row = rows.find((r) => Math.abs(r.top - rect.top) <= 2);
    if (!row) { row = { top: rect.top, cells: [], lanes: [] }; rows.push(row); }
    row.cells.push({ e, cell, rect });
  });
  const segments = [];
  const inIiVI = new Set(hmAnalysis.devices.filter((d) => d.type === "ii-V-I").flatMap((d) => d.event_idxs));
  for (const d of hmAnalysis.devices) {
    if (!(d.type in HM_DEV_COLORS) || !d.event_idxs.length) continue;
    if (d.type === "secondary_dominant" && d.event_idxs.every((i) => inIiVI.has(i))) continue;
    const first = Math.min(...d.event_idxs), last = Math.max(...d.event_idxs);
    const parts = rows.map((row) => ({ row, cells: row.cells.filter(({ e }) => e.idx >= first && e.idx <= last) })).filter((part) => part.cells.length);
    parts.forEach(({ row, cells }, part) => {
      const x0 = cells[0].rect.left, x1 = cells[cells.length - 1].rect.right;
      let lane = 0;
      while (row.lanes[lane]?.some((range) => !(x1 < range[0] || x0 > range[1]))) lane++;
      (row.lanes[lane] ||= []).push([x0, x1]);
      segments.push({ d, cells, lane, before: part > 0, after: part < parts.length - 1 });
    });
  }
  rows.forEach((row) => {
    const gap = row.lanes.length ? 14 + row.lanes.length * 16 : 0;
    row.cells.forEach(({ cell }) => {
      if (cell.parentNode) cell.parentNode.style.marginTop = Math.max(parseFloat(cell.parentNode.style.marginTop) || 0, gap) + "px";
    });
  });
  const wrapRect = wrap.getBoundingClientRect();
  for (const { d, cells, lane, before, after } of segments) {
    const ra = cells[0].cell.getBoundingClientRect(), rb = cells[cells.length - 1].cell.getBoundingClientRect();
    const div = document.createElement("div");
    div.className = "hm-bracket" + (before ? " continued-before" : "") + (after ? " continued-after" : "");
    div.style.left = (ra.left - wrapRect.left) + "px";
    div.style.width = Math.max(14, rb.right - ra.left) + "px";
    div.style.top = (ra.top - wrapRect.top - 13 - lane * 16) + "px";
    const col = hmCss(HM_DEV_COLORS[d.type]), target = hmFormatNoteLabel(d.target);
    div.style.borderColor = col;
    div.dataset.devkey = d.type;
    const label = { "ii-V-I": `ii–V–I→${target}`, "ii-V": `ii–V→${target}`, secondary_dominant: `V7/${target || "x"}`, tritone_sub: `tritone→${target}`, chromatic_bass_run: "chrom bass" }[d.type];
    div.innerHTML = `<span class="hm-blab" style="color:${col}">${before ? "┈ " : ""}${hmEsc(label)}${after ? " ┈" : ""}</span>`;
    div.title = HM_DEV_EXPLAIN[d.type];
    div.tabIndex = 0;
    div.setAttribute("role", "button");
    div.setAttribute("aria-label", HM_DEV_EXPLAIN[d.type]);
    const show = () => { const rect = div.getBoundingClientRect(); hmShowTip({ clientX: rect.left, clientY: rect.bottom }, div.title); };
    div.addEventListener("focus", show);
    div.addEventListener("blur", hmHideTip);
    div.addEventListener("click", show);
    div.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); show(); } if (ev.key === "Escape") hmHideTip(); });
    div.addEventListener("mousemove", (ev) => hmShowTip(ev, HM_DEV_EXPLAIN[d.type]));
    div.addEventListener("mouseleave", hmHideTip);
    layer.appendChild(div);
  }
  hmApplySpotlight();
}

function hmBuildBrackets() {
  const layer = document.getElementById("hmBrackets");
  if (layer) layer.innerHTML = "";
  if (hmBracketsRaf != null && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(hmBracketsRaf);
    hmBracketsRaf = null;
  }
  if (!hmAnalysis) return;
  if (typeof state === "object" && state && state.activeView !== "harmony") return;
  const mine = hmAnalysis;
  if (typeof requestAnimationFrame !== "function") {
    hmRenderBracketsNow(mine);
    return;
  }
  // wait a frame so the freshly-built cells have geometry
  hmBracketsRaf = requestAnimationFrame(() => {
    hmBracketsRaf = null;
    hmRenderBracketsNow(mine);
  });
}

function hmEnsureScoreObserver() {
  if (hmScoreObserver || typeof ResizeObserver !== "function") return;
  const wrap = document.getElementById("hmScoreWrap");
  if (!wrap) return;
  hmScoreObserver = new ResizeObserver(() => {
    if (typeof state === "object" && state && state.activeView === "harmony" && hmAnalysis) {
      hmRenderLanes();
      hmBuildBrackets();
    }
  });
  hmScoreObserver.observe(wrap);
  const lanes = document.querySelector("#harmony .hm-lanes");
  if (lanes) hmScoreObserver.observe(lanes);
}

// ---- C4: selection + rich side panel ----
function hmSelect(idx, manual = true) {
  if (!hmAnalysis?.events[idx]) return;
  if (manual) hmSetFollow(false);
  if (hmSelected != null && hmCellEls[hmSelected]) {
    hmCellEls[hmSelected].classList.remove("selected");
  }
  hmSelected = idx;
  if (hmCellEls[idx]) hmCellEls[idx].classList.add("selected");
  hmPanel(hmAnalysis.events[idx]);
}

// C7: jump from a Harmony cell into the chord editor (Bars view)
let hmReturn = null;
function hmSyncBackLink() {
  const back = document.getElementById("hmBackBtn");
  if (back) back.hidden = !hmReturn || state.activeView !== "bars" || hmReturn.album !== state.album || hmReturn.file !== state.file;
}
function hmEditChord(e) {
  hmReturn = { album: state.album, file: state.file, idx: e.idx, scroll: document.getElementById("harmony")?.scrollTop || 0 };
  if (showView("bars") === false) return;
  openEditor(e.section, e.bar_in_section, e.pos);
  const bars = document.getElementById("bars");
  if (!bars) return;
  let back = document.getElementById("hmBackBtn");
  if (!back) { back = document.createElement("button"); back.id = "hmBackBtn"; back.className = "tab hm-back"; bars.parentNode ? bars.parentNode.insertBefore(back, bars) : bars.prepend(back); }
  back.hidden = false;
  back.textContent = "← Back to Harmony";
  back.onclick = () => { if (showView("harmony") !== false) back.hidden = true; };
}

function hmPanel(e) {
  const p = document.getElementById("hmPanel");
  if (!p) return;
  if (!e) return;
  const col = hmColor(e.function);
  const noteNames = (e.notes || []).map((pc) => hmPcName(pc)).join(" ");
  const bassName = e.bass ||
    (e.bass_physical != null ? hmPcName(e.bass_physical) : null);
  const slash = e.bass && e.root && e.bass !== e.root;
  let html = "";
  html += `<div class="hm-bigsym">${hmEsc(e.symbol || "?")}` +
    (e.is_percent ? ' <span class="muted" style="font-size:12px">(held / re-strum of ' +
      hmEsc(e.chord || "?") + ")</span>" : "") + "</div>";
  html += `<div class="hm-rompanel" style="color:${col}">${hmEsc(e.roman || "")}` +
    ` &nbsp;<span class="muted" style="font-size:12px">${hmEsc(e.function || "")}` +
    ` (${hmEsc(e.func_label || "")})</span></div>`;
  if (e.why) html += `<div class="hm-whybox">${hmEsc(e.why)}</div>`;
  if (e.voicing && typeof window === "object" && window && window.ChordDiagram) {
    html += `<div class="hm-diagram">${window.ChordDiagram.svg(e.voicing)}</div>`;
  }
  const kv = (k, v) => v ? `<div class="hm-kv"><span class="k">${k}</span><span>${v}</span></div>` : "";
  html += kv("notes", hmEsc(noteNames));
  html += kv("bass", bassName ? hmEsc(bassName) +
    (slash ? ' <span style="color:var(--fn-chrombass)">(slash / inversion)</span>' : "") : null);
  html += kv("tension", Number.isFinite(e.tension) ? e.tension.toFixed(1) : null);
  html += kv("tonicizes", e.tonic_target ? hmEsc(hmFormatNoteLabel(e.tonic_target)) : null);
  if (e.devices && e.devices.length) {
    html += '<div class="hm-tags">' +
      e.devices.map((d) => `<span class="hm-tag">${hmEsc(d)}</span>`).join("") + "</div>";
  }
  const lvl = e.confidence || "";
  html += `<div class="hm-conf ${lvl}">confidence: <b>${lvl.toUpperCase()}</b>` +
    (e.discrepancy ? "<br>⚠ " + hmEsc(e.discrepancy) : "") + "</div>";
  html += '<button id="hmEditBtn" class="btn-primary" style="margin-top:10px;width:100%">Edit chord →</button>';
  html += '<div class="hm-panel-actions"><button id="hmAuditionBtn" class="tab">Audition</button><button id="hmFromBtn" class="tab">Play from here</button></div>';
  p.innerHTML = html;
  const audition = document.getElementById("hmAuditionBtn");
  if (audition) { audition.disabled = !e.midis?.length; audition.onclick = () => hmAudition(e); }
  const from = document.getElementById("hmFromBtn");
  if (from) from.onclick = () => hmSeek(e.idx, true);
  const editBtn = document.getElementById("hmEditBtn");
  if (editBtn) editBtn.onclick = () => hmEditChord(e);
}

// ---- C5: audio playback (ported from the validated prototype) ----
// Timing is driven off AudioContext.currentTime in a rAF loop, so the gliding
// playhead and the chord advance can't drift apart; setTimeout is never used
// for boundaries. Pause freezes the glide and silences ringing notes; resume
// re-anchors the in-progress segment.
let hmActx = null, hmMaster = null;
let hmPlaying = false, hmCurIdx = -1, hmRaf = null;
let hmActiveVoices = [];
let hmOnsetToken = 0, hmPlayRequest = 0;
let hmLastMidis = null;       // held/% and voicing-less events carry the last real chord
let hmSegStart = 0, hmSegDur = 0, hmSegX0 = 0, hmSegX1 = 0;
let hmPausedAt = null;
let hmXsCache = [];
let hmFollow = true, hmVolume = 0.15, hmMuted = false;
function hmSetFollow(follow) {
  hmFollow = follow;
  const input = document.getElementById("hmFollow");
  if (input) input.checked = follow;
}
function hmUpdateVolume() {
  if (hmMaster) hmMaster.gain.value = hmMuted ? 0 : hmVolume;
  const mute = document.getElementById("hmMuteBtn");
  if (mute) { mute.textContent = hmMuted ? "Unmute" : "Mute"; mute.setAttribute("aria-pressed", String(hmMuted)); }
}
function hmProgress() {
  const el = document.getElementById("hmAudioState"), events = hmAnalysis?.events || [];
  const bars = [...new Set(events.map((e) => `${e.section}:${e.bar}`))];
  const e = events[hmCurIdx];
  const bar = e ? bars.indexOf(`${e.section}:${e.bar}`) + 1 : 0;
  if (el) el.textContent = `bar ${bar} / ${bars.length} · event ${e ? hmCurIdx + 1 : 0} / ${events.length}`;
}
function hmTogglePlayback() { return hmPlaying ? hmPause() : hmPlay(); }
async function hmAudition(e) {
  hmPause();
  const request = ++hmPlayRequest, analysis = hmAnalysis;
  try { await hmEnsureAudio(); if (request !== hmPlayRequest || analysis !== hmAnalysis) return; hmSilenceVoices(); hmPlayChord(e.midis, 1.2); }
  catch (_) { document.getElementById("hmAudioState").textContent = "Audio unavailable"; }
}
function hmSeek(idx, play = hmPlaying) {
  if (!hmAnalysis?.events[idx]) return;
  hmStopPlayback();
  hmCurIdx = idx;
  hmLastMidis = null;
  for (let i = 0; i <= idx; i++) if (hmAnalysis.events[i].midis?.length) hmLastMidis = hmAnalysis.events[i].midis;
  hmSegDur = hmStepDur(hmAnalysis.events[idx]);
  hmSegX0 = hmXsCache[idx];
  hmSegX1 = hmXsCache[idx + 1] ?? hmLaneWidth - 12;
  hmPausedAt = 0;
  hmCellEls[idx]?.classList.add("cur");
  hmSetCursorX(hmSegX0);
  hmProgress();
  if (play) return hmPlay();
}

function hmEnsureAudio() {
  if (!hmActx) {
    hmActx = new (window.AudioContext || window.webkitAudioContext)();
    hmMaster = hmActx.createGain();
    hmMaster.gain.value = hmMuted ? 0 : hmVolume;
    hmMaster.connect(hmActx.destination);
  }
  if (hmActx.state === "suspended") return hmActx.resume();
  return Promise.resolve();
}

function hmRetireVoices() {
  hmActiveVoices.forEach((voice) => {
    voice.released = true;
  });
}

function hmPlayChord(midis, dur, onsetToken = hmOnsetToken) {
  const voices = window.VoicingAudio.playMidis(hmActx, hmMaster, midis, dur, (voice) => {
    const k = hmActiveVoices.indexOf(voice);
    if (k >= 0) hmActiveVoices.splice(k, 1);
  });
  voices.forEach((voice) => { voice.onset = onsetToken; });
  hmActiveVoices.push(...voices);
}

function hmSilenceVoices() {
  hmOnsetToken += 1;
  const now = hmActx ? hmActx.currentTime : 0;
  hmActiveVoices.forEach((voice) => {
    voice.released = true;
    if (voice.stopped) return;
    voice.stopped = true;
    const { o, g } = voice;
    try {
      if (g && g.gain && typeof g.gain.cancelScheduledValues === "function") {
        g.gain.cancelScheduledValues(now);
        g.gain.setValueAtTime(0.0001, now);
      }
      if (o && typeof o.stop === "function") o.stop(now + 0.02);
    } catch (_) { /* already stopped */ }
  });
  hmActiveVoices = [];
}

function hmBeatDur() { return 60 / Number(document.getElementById("hmTempo").value); }

// beat-accurate dwell — always finite > 0 so the scheduler never gets NaN/0
function hmStepDur(e) {
  let b = e && Number(e.beats);
  if (!isFinite(b) || b <= 0) b = 1;
  let bd = hmBeatDur();
  if (!isFinite(bd) || bd <= 0) bd = 0.5;
  const d = b * bd;
  return (isFinite(d) && d > 0) ? d : 0.5;
}

function hmResolveMidis(e) {
  if (e && e.midis && e.midis.length) return e.midis;
  if (hmLastMidis && hmLastMidis.length) return hmLastMidis;
  return null;
}

function hmCursorLine() {
  const cs = document.getElementById("hmCursorSvg");
  let ln = cs.querySelector("line");
  if (!ln) {
    cs.innerHTML = '<line x1="0" y1="0" x2="0" y2="100%"/>';
    ln = cs.querySelector("line");
  }
  return ln;
}

function hmSetCursorX(x) {
  const ln = hmCursorLine();
  if (ln && isFinite(x)) {
    ln.setAttribute("x1", x);
    ln.setAttribute("x2", x);
  }
}

function hmNow() { return hmActx ? hmActx.currentTime : 0; }

// Onset of the chord at hmCurIdx: audio + cell highlight + panel-follow, then
// set up the glide segment (this cell's x → the next cell's x over its beats).
function hmOnsetChord() {
  const e = hmAnalysis.events[hmCurIdx];
  const d = hmStepDur(e);
  hmOnsetToken += 1;
  hmRetireVoices();
  const onsetToken = hmOnsetToken;
  try {
    const midis = hmResolveMidis(e);
    if (midis && midis.length) {
      hmPlayChord(midis, d, onsetToken);
      hmLastMidis = midis;
    }
    if (hmCurIdx > 0 && hmCellEls[hmCurIdx - 1]) {
      hmCellEls[hmCurIdx - 1].classList.remove("cur");
    }
    if (hmCellEls[hmCurIdx]) {
      hmCellEls[hmCurIdx].classList.add("cur");
      if (hmFollow) hmCellEls[hmCurIdx].scrollIntoView({ block: "nearest", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ? "auto" : "smooth" });
    }
    if (hmFollow) hmSelect(hmCurIdx, false);
    hmProgress();
  } catch (err) {
    console.warn("harmony onset: skipping event " + hmCurIdx, err);
  }
  hmSegDur = d;
  hmSegStart = hmNow();
  hmSegX0 = isFinite(hmXsCache[hmCurIdx]) ? hmXsCache[hmCurIdx] : 0;
  hmSegX1 = (hmCurIdx + 1 < hmAnalysis.events.length && isFinite(hmXsCache[hmCurIdx + 1]))
    ? hmXsCache[hmCurIdx + 1] : (hmLaneWidth - 12);
  hmSetCursorX(hmSegX0);
}

function hmFrame() {
  if (!hmPlaying) return;
  let prog = hmSegDur > 0 ? (hmNow() - hmSegStart) / hmSegDur : 1;
  if (prog >= 1) {
    while (prog >= 1 && hmPlaying) {
      hmCurIdx++;
      if (hmCurIdx >= hmAnalysis.events.length) {
        hmSetCursorX((hmLaneWidth - 12));
        hmStopPlayback();
        return;
      }
      hmOnsetChord();
      prog = hmSegDur > 0 ? (hmNow() - hmSegStart) / hmSegDur : 1;
    }
  } else {
    hmSetCursorX(hmSegX0 + (hmSegX1 - hmSegX0) * Math.max(0, Math.min(1, prog)));
  }
  hmRaf = requestAnimationFrame(hmFrame);
}

async function hmPlay() {
  if (!hmAnalysis || !hmAnalysis.events.length) return;
  const mine = hmAnalysis, request = ++hmPlayRequest;
  try { await hmEnsureAudio(); }
  catch (_) { document.getElementById("hmAudioState").textContent = "Audio unavailable"; return; }
  if (request !== hmPlayRequest || !hmAnalysis || hmAnalysis !== mine || !hmAnalysis.events.length) return;
  if (typeof state === "object" && state && state.activeView !== "harmony") return;
  if (hmPlaying) return;
  const btn = document.getElementById("hmPlayBtn");
  if (btn) {
    btn.textContent = "⏸";
    btn.classList.add("playing");
    btn.setAttribute("aria-pressed", "true");
  }
  hmProgress();
  if (hmPausedAt != null) {
    // resume: re-anchor the in-progress segment and re-trigger the paused chord
    const pausedAt = hmPausedAt;
    hmPausedAt = null;
    hmPlaying = true;
    hmSegStart = hmNow() - pausedAt;
    const rem = hmSegDur - pausedAt;
    hmOnsetToken += 1;
    hmRetireVoices();
    const onsetToken = hmOnsetToken;
    if (rem > 0.01 && hmCurIdx >= 0 && hmCurIdx < hmAnalysis.events.length) {
      try {
        const midis = hmResolveMidis(hmAnalysis.events[hmCurIdx]);
        if (midis && midis.length) {
          hmPlayChord(midis, rem, onsetToken);
          hmLastMidis = midis;
        }
      } catch (err) {
        console.warn("harmony resume: skipping chord audio " + hmCurIdx, err);
      }
    }
    hmRaf = requestAnimationFrame(hmFrame);
    return;
  }
  if (hmCurIdx >= hmAnalysis.events.length - 1) hmCurIdx = -1;
  hmPlaying = true;
  hmCurIdx++;
  hmOnsetChord();
  hmRaf = requestAnimationFrame(hmFrame);
}

// pause keeps the playhead + highlight in place; resume continues from here
function hmPause() {
  if (!hmPlaying) return;
  hmPausedAt = Math.max(0, Math.min(hmSegDur, hmNow() - hmSegStart));
  hmPlaying = false;
  const btn = document.getElementById("hmPlayBtn");
  if (btn) {
    btn.textContent = "▶";
    btn.classList.remove("playing");
    btn.setAttribute("aria-pressed", "false");
  }
  if (hmRaf) cancelAnimationFrame(hmRaf);
  hmRaf = null;
  hmSilenceVoices();
}

// full reset (also called when leaving the tab or re-rendering)
function hmStopPlayback() {
  hmPlayRequest++;
  hmPlaying = false;
  hmPausedAt = null;
  const btn = document.getElementById("hmPlayBtn");
  if (btn) { btn.textContent = "▶"; btn.classList.remove("playing"); btn.setAttribute("aria-pressed", "false"); }
  if (hmRaf) cancelAnimationFrame(hmRaf);
  hmRaf = null;
  if (hmActx) hmSilenceVoices();
  else {
    hmOnsetToken += 1;
    hmRetireVoices();
  }
  Object.values(hmCellEls).forEach((cell) => cell.classList.remove("cur"));
  hmCurIdx = -1;
  hmLastMidis = null;
  hmSegStart = 0;
  hmSegDur = 0;
  hmSegX0 = 0;
  hmSegX1 = 0;
  const cs = document.getElementById("hmCursorSvg");
  if (cs) cs.innerHTML = "";
  hmProgress();
}

function hmOnTempoInput() {
  const tempo = document.getElementById("hmTempo");
  const tempoVal = document.getElementById("hmTempoVal");
  if (tempoVal && tempo) tempoVal.textContent = tempo.value;
  if (!hmAnalysis || hmCurIdx < 0 || hmCurIdx >= hmAnalysis.events.length) return;
  const newDur = hmStepDur(hmAnalysis.events[hmCurIdx]);
  if (!isFinite(newDur) || newDur <= 0) return;

  if (hmPlaying) {
    const now = hmNow();
    const frac = hmSegDur > 0 ? Math.max(0, Math.min(1, (now - hmSegStart) / hmSegDur)) : 0;
    hmSegDur = newDur;
    hmSegStart = now - frac * newDur;
    const rem = Math.max(0.02, (1 - frac) * newDur);
    hmActiveVoices.forEach((voice) => {
      if (voice.stopped || voice.released || voice.onset !== hmOnsetToken ||
          !voice.g || !voice.g.gain) return;
      const g = voice.g;
      try {
        const curVal = g.gain.value;
        if (!Number.isFinite(curVal) || curVal <= 0.0001) return;
        if (typeof g.gain.cancelScheduledValues === "function") {
          g.gain.cancelScheduledValues(now);
          g.gain.setValueAtTime(curVal, now);
          const rel = Math.min(0.25, rem * 0.5);
          g.gain.setValueAtTime(curVal, now + Math.max(0, rem - rel));
          g.gain.linearRampToValueAtTime(0.0001, now + rem);
        }
      } catch (_) { /* ignore scheduling edge cases */ }
    });
  } else if (hmPausedAt != null) {
    const frac = hmSegDur > 0 ? Math.max(0, Math.min(1, hmPausedAt / hmSegDur)) : 0;
    hmSegDur = newDur;
    hmPausedAt = frac * newDur;
  }
}

// ---- exports of the live (unsaved) analysis ----
function hmExportStem() {
  const f = state.file || "song";
  return f.replace(/\.json$/, "") + "-harmony";
}

function hmExportFlash(msg) {
  const s = document.getElementById("hmExportMsg");
  s.textContent = msg;
  if (msg) setTimeout(() => { if (s.textContent === msg) s.textContent = ""; }, 2500);
}

function hmDownloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function hmCsvCell(v) {
  if (v == null) return "";
  const s = Array.isArray(v) ? v.join("; ") : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function hmAnalysisCsv(analysis) {
  const cols = ["idx", "section", "section_label", "bar", "pos", "beats",
    "symbol", "chord", "root", "bass", "bass_physical", "quality",
    "quality_source", "roman", "function", "func_label", "devices", "tension",
    "tonic_target", "confidence", "discrepancy", "text", "voicing", "notes",
    "why"];
  const lines = [cols.join(",")];
  for (const e of analysis.events) {
    lines.push(cols.map((c) => hmCsvCell(e[c])).join(","));
  }
  return lines.join("\n") + "\n";
}

// Standalone HTML snapshot of the current Harmony view: harvests the hm-*
// rules + theme variables from the live stylesheet and freezes the score at
// its current width (the brackets are absolutely positioned from cell rects,
// so the layout must not reflow in the export).
function hmSnapshotHtml() {
  let css = "";
  for (const sheet of (document.styleSheets || [])) {
    let rules;
    try { rules = sheet.cssRules; } catch (_) { continue; }
    if (!rules) continue;
    for (const r of rules) {
      const sel = r.selectorText || "";
      if (sel === ":root" || sel.includes(".hm-") || sel.includes("#hm") ||
          sel.includes(".muted")) {
        css += r.cssText + "\n";
      }
    }
  }
  const s = typeof song === "function" ? song() : null;
  const title = ((s && s.title) || "song") + " — harmonic analysis";
  const wrap = document.getElementById("hmScoreWrap");
  const width = (wrap && wrap.offsetWidth) || 0;
  const parts = ["hmHead", "hmLegend"];
  let body = "";
  for (const id of parts) {
    const el = document.getElementById(id);
    if (el) body += el.outerHTML;
  }
  const lanes = document.querySelector("#harmony .hm-lanes");
  if (lanes) body += lanes.outerHTML;
  if (wrap) body += wrap.outerHTML;
  return "<!doctype html><html><head><meta charset=\"utf-8\">" +
    `<title>${hmEsc(title)}</title><style>${css}` +
    "body{background:#0f1115;color:#e6e8ee;margin:0;padding:20px;" +
    "font:14px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}" +
    "h1{font-size:18px;margin:0 0 10px}" +
    `.hm-wrap{width:${Math.max(width, lanes?.clientWidth || width)}px}#hmScoreWrap{width:${width}px}.hm-lanes{width:${lanes?.clientWidth || width}px}` +
    "#hmCursorSvg{display:none}" +
    `</style></head><body><h1>${hmEsc(title)}</h1>` +
    `<div class="hm-wrap">${body}</div></body></html>`;
}

async function hmExportPdf() {
  hmExportFlash("Preparing harmony chart…");
  try {
    await PreviewExport.printChartHtml(hmSnapshotHtml());
    hmExportFlash("");
  } catch (error) {
    hmExportFlash("Print failed: " + error.message);
  }
}

let hmToolbarWired = false;
function hmWireToolbar() {
  if (hmToolbarWired) return;
  hmToolbarWired = true;
  document.getElementById("hmPlayBtn").onclick =
    hmTogglePlayback;
  const stop = document.getElementById("hmStopBtn");
  if (stop) stop.onclick = hmStopPlayback;
  const volume = document.getElementById("hmVolume");
  if (volume) volume.oninput = () => { hmVolume = Number(volume.value) / 100 * .3; hmUpdateVolume(); };
  const mute = document.getElementById("hmMuteBtn");
  if (mute) mute.onclick = () => { hmMuted = !hmMuted; hmUpdateVolume(); };
  const follow = document.getElementById("hmFollow");
  if (follow) follow.onchange = () => { hmSetFollow(follow.checked); if (hmFollow && hmCurIdx >= 0) hmSelect(hmCurIdx, false); };
  const tempo = document.getElementById("hmTempo");
  tempo.oninput = hmOnTempoInput;
  const guard = (fn) => () => {
    if (!hmAnalysis) { hmExportFlash("nothing analyzed yet"); return; }
    fn();
  };
  document.getElementById("hmExportJson").onclick = guard(() => {
    hmDownloadBlob(new Blob([JSON.stringify(hmAnalysis, null, 2)],
      { type: "application/json" }), hmExportStem() + ".json");
    hmExportFlash("Exported ✓");
  });
  document.getElementById("hmExportCsv").onclick = guard(() => {
    hmDownloadBlob(new Blob([hmAnalysisCsv(hmAnalysis)],
      { type: "text/csv" }), hmExportStem() + ".csv");
    hmExportFlash("Exported ✓");
  });
  document.getElementById("hmExportHtml").onclick = guard(() => {
    hmDownloadBlob(new Blob([hmSnapshotHtml()],
      { type: "text/html" }), hmExportStem() + ".html");
    hmExportFlash("Exported ✓");
  });
  document.getElementById("hmExportPdf").onclick = guard(hmExportPdf);
}

let hmRequest = 0;

function hmClearView(scoreMsg = "") {
  hmAnalysis = null;
  hmSelected = null;
  hmCellEls = {};
  hmXsCache = [];
  if (hmBracketsRaf != null && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(hmBracketsRaf);
    hmBracketsRaf = null;
  }
  hmHideTip();
  for (const id of [
    "hmKeybar", "hmLegend", "hmTensionSvg", "hmBassSvg",
    "hmRibbonSvg", "hmCursorSvg", "hmBrackets", "hmPanel",
  ]) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = "";
  }
  const score = document.getElementById("hmScore");
  if (score) {
    score.innerHTML = scoreMsg
      ? `<div class="muted" style="padding:16px">${hmEsc(scoreMsg)}</div>`
      : "";
  }
}

function hmShowError(detail) {
  hmClearView("");
  const head = document.getElementById("hmHead");
  if (head) head.textContent = "Analysis failed: " + detail;
  const bar = document.getElementById("hmKeybar");
  if (!bar) return;
  bar.innerHTML = "";
  if (typeof document.createElement === "function") {
    const box = document.createElement("div");
    box.className = "hm-error";
    if (typeof box.setAttribute === "function") box.setAttribute("role", "alert");
    const msg = document.createElement("span");
    msg.textContent = "Could not analyze harmony: " + detail;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "hmRetryBtn";
    btn.className = "tab";
    btn.textContent = "Retry";
    btn.onclick = () => renderHarmony();
    box.appendChild(msg);
    box.appendChild(btn);
    bar.appendChild(box);
  } else {
    bar.innerHTML = `<div class="hm-error" role="alert"><span>Could not analyze harmony: ${hmEsc(detail)}</span>` +
      `<button type="button" id="hmRetryBtn" class="tab">Retry</button></div>`;
    const btn = document.getElementById("hmRetryBtn");
    if (btn) btn.onclick = () => renderHarmony();
  }
}

// ---- entry point, called by showView("harmony") ----
async function renderHarmony() {
  hmStopPlayback();   // a re-render rebuilds the cells the player points at
  hmWireToolbar();
  hmEnsureScoreObserver();
  const req = ++hmRequest;
  const head = document.getElementById("hmHead");
  if (typeof state !== "object" || !state || !state.doc) {
    hmClearView("");
    if (head) head.textContent = "no song loaded";
    return;
  }
  const { doc, album, file } = state;
  const isCurrent = () => req === hmRequest &&
    typeof state === "object" && state &&
    state.doc === doc && state.album === album && state.file === file &&
    state.activeView === "harmony";
  hmClearView("Analyzing harmony…");
  if (head) head.textContent = "analyzing…";
  try {
    const res = await fetch("/api/harmony-doc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc),
    });
    if (!isCurrent()) return;
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (!isCurrent()) return;
      hmShowError(err.error || `HTTP ${res.status}`);
      return;
    }
    const analysis = await res.json();
    if (!isCurrent()) return;
    hmAnalysis = analysis;
    hmSelected = null;
    if (head) head.textContent = hmHeader(hmAnalysis);
    hmKeybar(hmAnalysis);
    const legend = document.getElementById("hmLegend");
    if (legend) {
      legend.innerHTML = "";
      legend.appendChild(hmLegend());
    }
    hmRenderLanes();
    hmProgress();
    const scoreWrap = document.getElementById("hmScore");
    if (scoreWrap) {
      scoreWrap.innerHTML = "";
      scoreWrap.appendChild(hmBuildScore(hmAnalysis));
    }
    const panel = document.getElementById("hmPanel");
    if (panel) {
      panel.innerHTML =
        '<div class="muted" style="text-align:center;margin-top:40px">' +
        "click a chord — double-click (or Edit) jumps to the editor</div>";
    }
    const bookmark = hmReturn;
    if (bookmark && bookmark.album === album && bookmark.file === file) {
      hmSelect(bookmark.idx, false);
      const restore = () => { const view = document.getElementById("harmony"); if (view && isCurrent()) view.scrollTop = bookmark.scroll; };
      requestAnimationFrame(() => requestAnimationFrame(restore));
      hmReturn = null;
    } else if (bookmark) hmReturn = null;
    const back = document.getElementById("hmBackBtn");
    if (back) back.hidden = true;
    hmApplySpotlight();
    hmBuildBrackets();
    // brackets are absolutely positioned from cell rects, so any late reflow
    // (font metrics settling, scrollbar appearing) leaves them stale — rebuild
    // once fonts are ready and again after the layout has settled
    const mine = hmAnalysis;
    const rebuild = () => {
      if (typeof state === "object" && state && state.activeView === "harmony" && hmAnalysis === mine) {
        hmBuildBrackets();
      }
    };
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(rebuild);
    setTimeout(rebuild, 400);
  } catch (e) {
    if (!isCurrent()) return;
    hmShowError(e && e.message ? e.message : String(e));
  }
}

if (typeof window === "object" && window && typeof window.addEventListener === "function") {
  window.addEventListener("resize", () => {
    if (typeof state === "object" && state && state.activeView === "harmony" && hmAnalysis) {
      hmBuildBrackets();
    }
  });
}
