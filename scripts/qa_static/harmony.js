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
    bits.push(`key ${k.tonic_name} ${k.mode || ""} (${k.how}` +
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
      const warn = document.createElement("span");
      warn.className = "hm-keywarn";
      warn.textContent = "⚠ the cadence estimate disagrees with the stored key" +
        (cad && cad.tonic_name ? ` (it suggests ${cad.tonic_name} ${cad.mode})` : "");
      bar.appendChild(warn);
      if (cad && cad.tonic_name) {
        const btn = document.createElement("button");
        btn.className = "tab";
        btn.textContent = `Use ${cad.tonic_name} ${cad.mode} instead`;
        btn.onclick = () => hmApplyKey(cad.tonic_name, cad.mode);
        bar.appendChild(btn);
      }
    }
    return; // stored & agreeing: nothing to confirm
  }
  if (!k.tonic_name) return;

  const label = document.createElement("span");
  label.className = "muted";
  label.textContent =
    `inferred key ${k.tonic_name} ${k.mode} — not stored on the song yet:`;
  bar.appendChild(label);

  const confirm = document.createElement("button");
  confirm.className = "btn-primary";
  confirm.textContent = `Confirm key ${k.tonic_name} ${k.mode}`;
  confirm.onclick = () => hmApplyKey(k.tonic_name, k.mode);
  bar.appendChild(confirm);

  const sel = document.createElement("select");
  sel.innerHTML = '<option value="">or pick another…</option>' +
    (k.candidates || [])
      .filter((c) => c.tonic_pc != null)
      .map((c) => {
        const nm = c.tonic_name || hmPcName(c.tonic_pc);
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
  document.querySelectorAll("#hmBrackets .hm-bracket").forEach((b) => {
    const on = hmSpotlight.size === 0 || hmSpotlight.has(b.dataset.devkey);
    b.classList.toggle("hm-dim", !on);
  });
}

function hmLegend() {
  const wrap = document.createElement("div");
  wrap.className = "hm-legend";
  const chip = (key, label, color, dev) => {
    const c = document.createElement("span");
    c.className = "hm-chip" + (dev ? " dev" : "");
    if (color) {
      const dot = document.createElement("span");
      dot.className = "hm-dot";
      dot.style.background = color;
      c.appendChild(dot);
    }
    c.appendChild(document.createTextNode(label));
    c.onclick = () => {
      if (hmSpotlight.has(key)) hmSpotlight.delete(key);
      else hmSpotlight.add(key);
      c.classList.toggle("active", hmSpotlight.has(key));
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
  const clear = document.createElement("span");
  clear.className = "hm-chip";
  clear.textContent = "clear";
  clear.onclick = () => {
    hmSpotlight.clear();
    wrap.querySelectorAll(".hm-chip").forEach((x) => x.classList.remove("active"));
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
        const cell = document.createElement("div");
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
function hmXs(n) {
  const pad = 12, w = 1000 - 2 * pad;
  return Array.from({ length: n }, (_, i) => pad + (w * (i + 0.5)) / n);
}

function hmBuildTension(events, xs) {
  const svg = document.getElementById("hmTensionSvg");
  const H = 90, pad = 8, maxT = 3;
  if (!events.length) { svg.innerHTML = ""; return; }
  const ys = events.map((e) => H - pad - ((H - 2 * pad) * ((e.tension || 0) / maxT)));
  let line = `M ${xs[0]} ${ys[0]}`;
  for (let i = 1; i < events.length; i++) {
    const mx = (xs[i - 1] + xs[i]) / 2;
    line += ` C ${mx} ${ys[i - 1]} ${mx} ${ys[i]} ${xs[i]} ${ys[i]}`;
  }
  const area = `${line} L ${xs[events.length - 1]} ${H} L ${xs[0]} ${H} Z`;
  let s = '<defs><linearGradient id="hmTg" x1="0" y1="0" x2="0" y2="1">' +
    `<stop offset="0%" stop-color="${hmCss("--fn-dominant")}" stop-opacity="0.55"/>` +
    `<stop offset="100%" stop-color="${hmCss("--fn-tonic")}" stop-opacity="0.08"/>` +
    "</linearGradient></defs>";
  s += `<path d="${area}" fill="url(#hmTg)"/>`;
  s += `<path d="${line}" fill="none" stroke="${hmCss("--text")}" stroke-width="1.3" opacity="0.85"/>`;
  events.forEach((e, i) => {
    s += `<circle cx="${xs[i]}" cy="${ys[i]}" r="2.2" fill="${hmColor(e.function)}"/>`;
  });
  svg.innerHTML = s;
}

function hmBuildBass(events, xs) {
  const svg = document.getElementById("hmBassSvg");
  const H = 70, pad = 10;
  const pts = [];
  let last = null;
  events.forEach((e, i) => {
    const v = (e.midis && e.midis.length) ? e.midis[0] : last;
    if (v != null) { pts.push([xs[i], v]); last = v; }
  });
  if (!pts.length) { svg.innerHTML = ""; return; }
  const vals = pts.map((p) => p[1]);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const yfor = (v) => H - pad - ((H - 2 * pad) * (v - lo)) / Math.max(1, hi - lo);
  let path = `M ${pts[0][0]} ${yfor(pts[0][1])}`;
  for (let i = 1; i < pts.length; i++) {
    path += ` L ${pts[i][0]} ${yfor(pts[i - 1][1])} L ${pts[i][0]} ${yfor(pts[i][1])}`;
  }
  const col = hmCss("--fn-chrombass");
  let s = `<path d="${path}" fill="none" stroke="${col}" stroke-width="1.6"/>`;
  let prev = null;
  pts.forEach(([x, v]) => {
    s += `<circle cx="${x}" cy="${yfor(v)}" r="2" fill="${col}"/>`;
    const name = hmPcName(v % 12);
    if (name !== prev) {
      s += `<text x="${x}" y="${yfor(v) - 4}" fill="${hmCss("--muted")}" font-size="8" text-anchor="middle">${hmEsc(name)}</text>`;
      prev = name;
    }
  });
  svg.innerHTML = s;
}

function hmBuildRibbon(analysis, xs) {
  const svg = document.getElementById("hmRibbonSvg");
  if (!svg) return;
  const events = analysis.events;
  const H = 26, n = events.length, pad = 12, w = 1000 - 2 * pad;
  const home = (analysis.key || {}).tonic_name || null;
  // palette per target pitch class, cycling the function hues
  const palette = ["--fn-subdominant", "--fn-secondary", "--fn-passing",
                   "--fn-dominant", "--fn-chromatic", "--fn-chrombass"];
  let s = "", i = 0;
  while (i < n) {
    let j = i;
    const t = events[i].tonic_target;
    while (j + 1 < n && events[j + 1].tonic_target === t) j++;
    const x0 = pad + (w * i) / n, x1 = pad + (w * (j + 1)) / n;
    const isHome = t == null;
    const pc = hmNoteToPc(t);
    const col = isHome ? hmCss("--fn-tonic")
      : hmCss(pc >= 0 ? palette[pc % palette.length] : "--fn-chromatic");
    s += `<rect x="${x0}" y="3" width="${x1 - x0}" height="${H - 6}" rx="3" ` +
      `fill="${col}" fill-opacity="${isHome ? 0.10 : 0.30}" ` +
      `stroke="${col}" stroke-opacity="0.5"/>`;
    if (x1 - x0 > 30) {
      const homeLab = hmFormatNoteLabel(home);
      const targLab = hmFormatNoteLabel(t);
      const lab = isHome ? (homeLab ? `${hmEsc(homeLab)} (home)` : "home") : `→ ${hmEsc(targLab)}`;
      s += `<text x="${(x0 + x1) / 2}" y="${H / 2 + 3}" fill="${hmCss("--text")}" ` +
        `font-size="9" text-anchor="middle">${lab}</text>`;
    }
    i = j + 1;
  }
  svg.innerHTML = s;
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
  const wrapRect = wrap.getBoundingClientRect();
  const events = hmAnalysis.events;
  const inIiVI = new Set();
  for (const d of hmAnalysis.devices) {
    if (d.type === "ii-V-I") d.event_idxs.forEach((i) => inIiVI.add(i));
  }
  const lanes = []; // occupied x-ranges per stacking lane, per row band
  for (const d of hmAnalysis.devices) {
    if (!(d.type in HM_DEV_COLORS)) continue;
    // a secondary_dominant span inside a ii–V–I is already bracketed there
    if (d.type === "secondary_dominant" &&
        d.event_idxs.every((i) => inIiVI.has(i))) continue;
    const ca = hmCellEls[Math.min(...d.event_idxs)];
    const cb = hmCellEls[Math.max(...d.event_idxs)];
    if (!ca || !cb) continue;
    const ra = ca.getBoundingClientRect(), rb = cb.getBoundingClientRect();
    if (rb.top !== ra.top) continue; // spans a line wrap — skip the bracket
    const x0 = ra.left - wrapRect.left, x1 = rb.right - wrapRect.left;
    const y = ra.top - wrapRect.top;
    let lane = 0;
    for (const o of lanes) {
      if (o.y === y && !(x1 < o.x0 || x0 > o.x1)) lane = Math.max(lane, o.lane + 1);
    }
    // the 44px row gap fits 3 lanes; anything deeper folds back onto lane 2
    // (its label is dropped below so the pile-up stays legible)
    const overflow = lane > 2;
    if (overflow) lane = 2;
    lanes.push({ x0, x1, y, lane });
    const div = document.createElement("div");
    div.className = "hm-bracket";
    div.style.left = x0 + "px";
    div.style.width = Math.max(14, x1 - x0) + "px";
    // lane 0 sits 13px above the cells, each extra lane climbs 12px;
    // the label straddles the bracket's top edge
    div.style.top = (y - 13 - lane * 12) + "px";
    const col = hmCss(HM_DEV_COLORS[d.type]);
    div.style.borderColor = col;
    div.dataset.devkey = d.type;
    // compact labels — the full name lives in the hover tooltip
    const target = hmFormatNoteLabel(d.target);
    const label = {
      "ii-V-I": `ii–V–I→${target}`,
      secondary_dominant: `V7/${target || "x"}`,
      tritone_sub: `tritone→${target}`,
      chromatic_bass_run: "chrom bass",
    }[d.type] || d.type;
    div.innerHTML = `<span class="hm-blab" style="color:${col}">${hmEsc(label)}</span>`;
    const span = `${events[Math.min(...d.event_idxs)].symbol}…` +
      `${events[Math.max(...d.event_idxs)].symbol}`;
    const expl = (HM_DEV_EXPLAIN[d.type] || label) + ` Spans ${span}.`;
    div.addEventListener("mousemove", (ev) => hmShowTip(ev, expl));
    div.addEventListener("mouseleave", hmHideTip);
    layer.appendChild(div);
    // a label wider than its bracket would spill into the neighbours —
    // drop the text (the tooltip still names the device)
    const blab = div.firstChild;
    if (overflow || (blab && blab.offsetWidth > Math.max(14, x1 - x0) + 16)) {
      blab.style.display = "none";
    }
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
      hmBuildBrackets();
    }
  });
  hmScoreObserver.observe(wrap);
}

// ---- C4: selection + rich side panel ----
function hmSelect(idx) {
  if (hmSelected != null && hmCellEls[hmSelected]) {
    hmCellEls[hmSelected].classList.remove("selected");
  }
  hmSelected = idx;
  if (hmCellEls[idx]) hmCellEls[idx].classList.add("selected");
  hmPanel(hmAnalysis.events[idx]);
}

// C7: jump from a Harmony cell into the chord editor (Bars view)
function hmEditChord(e) {
  showView("bars");
  openEditor(e.section, e.bar_in_section, e.pos);
}

function hmPanel(e) {
  const p = document.getElementById("hmPanel");
  if (!p) return;
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
  p.innerHTML = html;
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
let hmLastMidis = null;       // held/% and voicing-less events carry the last real chord
let hmSegStart = 0, hmSegDur = 0, hmSegX0 = 0, hmSegX1 = 0;
let hmPausedAt = null;
let hmXsCache = [];
const HM_RIGHT_EDGE = 1000 - 12;  // matches hmXs() pad

function hmEnsureAudio() {
  if (!hmActx) {
    hmActx = new (window.AudioContext || window.webkitAudioContext)();
    hmMaster = hmActx.createGain();
    hmMaster.gain.value = 0.15;
    hmMaster.connect(hmActx.destination);
  }
  if (hmActx.state === "suspended") return hmActx.resume();
  return Promise.resolve();
}

function hmMidiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

function hmPlayChord(midis, dur) {
  if (!midis || !midis.length || !(dur > 0)) return;
  const now = hmActx.currentTime;
  midis.forEach((m) => {
    const o = hmActx.createOscillator();
    o.type = "triangle";
    o.frequency.value = hmMidiToFreq(m);
    const g = hmActx.createGain();
    g.gain.value = 0;
    o.connect(g);
    g.connect(hmMaster);
    const atk = Math.min(0.015, dur * 0.25);
    const rel = Math.min(0.25, dur * 0.5);
    const peak = 0.9 / Math.sqrt(midis.length);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(peak, now + atk);
    g.gain.setValueAtTime(peak, now + Math.max(atk, dur - rel));
    g.gain.linearRampToValueAtTime(0.0001, now + dur);
    o.start(now);
    o.stop(now + dur + 0.05);
    const voice = { o, g, stopped: false };
    hmActiveVoices.push(voice);
    o.onended = () => {
      voice.stopped = true;
      const k = hmActiveVoices.indexOf(voice);
      if (k >= 0) hmActiveVoices.splice(k, 1);
    };
  });
}

function hmSilenceVoices() {
  const now = hmActx ? hmActx.currentTime : 0;
  hmActiveVoices.forEach((voice) => {
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
    cs.innerHTML = '<line x1="0" y1="0" x2="0" y2="100"/>';
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
  try {
    const midis = hmResolveMidis(e);
    if (midis && midis.length) {
      hmPlayChord(midis, d);
      hmLastMidis = midis;
    }
    if (hmCurIdx > 0 && hmCellEls[hmCurIdx - 1]) {
      hmCellEls[hmCurIdx - 1].classList.remove("cur");
    }
    if (hmCellEls[hmCurIdx]) {
      hmCellEls[hmCurIdx].classList.add("cur");
      hmCellEls[hmCurIdx].scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    hmPanel(e);   // panel follows the playhead
  } catch (err) {
    console.warn("harmony onset: skipping event " + hmCurIdx, err);
  }
  hmSegDur = d;
  hmSegStart = hmNow();
  hmSegX0 = isFinite(hmXsCache[hmCurIdx]) ? hmXsCache[hmCurIdx] : 0;
  hmSegX1 = (hmCurIdx + 1 < hmAnalysis.events.length && isFinite(hmXsCache[hmCurIdx + 1]))
    ? hmXsCache[hmCurIdx + 1] : HM_RIGHT_EDGE;
  hmSetCursorX(hmSegX0);
}

function hmFrame() {
  if (!hmPlaying) return;
  let prog = hmSegDur > 0 ? (hmNow() - hmSegStart) / hmSegDur : 1;
  if (prog >= 1) {
    while (prog >= 1 && hmPlaying) {
      hmCurIdx++;
      if (hmCurIdx >= hmAnalysis.events.length) {
        hmSetCursorX(HM_RIGHT_EDGE);
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
  const mine = hmAnalysis;
  await hmEnsureAudio();
  if (!hmAnalysis || hmAnalysis !== mine || !hmAnalysis.events.length) return;
  if (typeof state === "object" && state && state.activeView !== "harmony") return;
  if (hmPlaying) return;
  const btn = document.getElementById("hmPlayBtn");
  if (btn) {
    btn.textContent = "⏸";
    btn.classList.add("playing");
  }
  const audioStateEl = document.getElementById("hmAudioState");
  if (audioStateEl && hmActx) audioStateEl.textContent = "audio: " + hmActx.state;
  if (hmPausedAt != null) {
    // resume: re-anchor the in-progress segment and re-trigger the paused chord
    const pausedAt = hmPausedAt;
    hmPausedAt = null;
    hmPlaying = true;
    hmSegStart = hmNow() - pausedAt;
    const rem = hmSegDur - pausedAt;
    if (rem > 0.01 && hmCurIdx >= 0 && hmCurIdx < hmAnalysis.events.length) {
      try {
        const midis = hmResolveMidis(hmAnalysis.events[hmCurIdx]);
        if (midis && midis.length) {
          hmPlayChord(midis, rem);
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
  }
  if (hmRaf) cancelAnimationFrame(hmRaf);
  hmRaf = null;
  hmSilenceVoices();
}

// full reset (also called when leaving the tab or re-rendering)
function hmStopPlayback() {
  hmPlaying = false;
  hmPausedAt = null;
  const btn = document.getElementById("hmPlayBtn");
  if (btn) { btn.textContent = "▶"; btn.classList.remove("playing"); }
  if (hmRaf) cancelAnimationFrame(hmRaf);
  hmRaf = null;
  if (hmActx) hmSilenceVoices();
  if (hmCurIdx >= 0 && hmCellEls[hmCurIdx]) hmCellEls[hmCurIdx].classList.remove("cur");
  hmCurIdx = -1;
  hmLastMidis = null;
  hmSegStart = 0;
  hmSegDur = 0;
  hmSegX0 = 0;
  hmSegX1 = 0;
  const cs = document.getElementById("hmCursorSvg");
  if (cs) cs.innerHTML = "";
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
      if (voice.stopped || !voice.g || !voice.g.gain) return;
      const g = voice.g;
      try {
        if (typeof g.gain.cancelScheduledValues === "function") {
          g.gain.cancelScheduledValues(now);
          const curVal = Number.isFinite(g.gain.value) && g.gain.value > 0.0001
            ? g.gain.value
            : 0.9 / Math.sqrt(Math.max(1, hmActiveVoices.length));
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
    `.hm-wrap{width:${width}px}` +
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
    () => (hmPlaying ? hmPause() : hmPlay());
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
    const xs = hmXsCache = hmXs(hmAnalysis.events.length);
    hmBuildTension(hmAnalysis.events, xs);
    hmBuildBass(hmAnalysis.events, xs);
    hmBuildRibbon(hmAnalysis, xs);
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
