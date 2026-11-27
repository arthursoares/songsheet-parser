// Dual-mode guitar editor. Classic script with stable DOM nodes for keyboard focus.
// Fretboard(container, onChange, { showIntervals: false }); frets 0–24; x = muted.
function Fretboard(container, onChange, { showIntervals = true } = {}) {
  const STRINGS = 6, WINDOW = 5, labels = ["E", "A", "D", "G", "B", "e"];
  let voicing = ["x", "x", "x", "x", "x", "x"], start = 1;
  let anchor = null, drag = null, dragged = false;
  const marks = [], cells = [], numbers = [];

  function fittedStart(v) {
    const fretted = v.filter((f) => f !== "x" && Number(f) > 0).map(Number);
    return fretted.length ? Math.max(1, Math.min(Math.min(...fretted), 20)) : 1;
  }
  function parseText(raw) {
    const toks = raw.split(",").map((t) => t.trim());
    if (toks.length !== STRINGS) return { error: "need exactly 6 values" };
    const out = [];
    for (const t of toks) {
      if (/^x$/i.test(t)) { out.push("x"); continue; }
      if (!/^\d{1,2}$/.test(t)) return { error: `bad value "${t}"` };
      const n = Number(t);
      if (n > 24) return { error: `fret ${n} out of range 0-24` };
      out.push(n);
    }
    return { voicing: out };
  }
  function element(tag, className, parent, text) {
    const el = document.createElement(tag);
    el.className = className;
    if (text !== undefined) el.textContent = text;
    parent.appendChild(el);
    return el;
  }
  function button(parent, className, text, action) {
    const el = element("button", className, parent, text);
    el.type = "button";
    el.onclick = action;
    return el;
  }
  function changed() { update(); onChange(voicing.slice()); }
  function barre(from, to, fret, base = voicing) {
    voicing = base.slice();
    for (let s = Math.min(from, to); s <= Math.max(from, to); s++) voicing[s] = fret;
    changed();
  }

  container.innerHTML = "";
  const ctl = element("div", "fb-ctl", container);
  const down = button(ctl, "", "−", () => { start = Math.max(1, start - 1); update(false); });
  down.setAttribute("aria-label", "Show lower frets");
  const position = element("span", "", ctl);
  const up = button(ctl, "", "+", () => { start = Math.min(20, start + 1); update(false); });
  up.setAttribute("aria-label", "Show higher frets");
  const grid = element("div", "fb-grid", container);
  grid.onpointerup = grid.onpointercancel = () => { drag = null; };
  const legend = element("div", "fb-col fb-legend", grid);
  element("div", "fb-mark", legend);
  for (let row = 0; row < WINDOW; row++) numbers.push(element("div", "fb-fretnum", legend));
  element("div", "fb-lbl", legend);

  for (let s = 0; s < STRINGS; s++) {
    const col = element("div", "fb-col", grid);
    const mark = button(col, "fb-mark", "", () => {
      const fret = voicing[s];
      if (fret > 0 && (fret < start || fret >= start + WINDOW)) {
        start = Math.max(1, Math.min(Number(fret), 20));
        update(false);
      } else {
        voicing[s] = fret === 0 ? "x" : 0;
        changed();
      }
    });
    mark.oncontextmenu = (ev) => { ev.preventDefault(); voicing[s] = "x"; changed(); };
    marks.push(mark);
    cells[s] = [];
    for (let row = 0; row < WINDOW; row++) {
      const cell = button(col, "fb-cell", "", (ev) => {
        if (dragged && ev?.detail !== 0) { dragged = false; return; }
        dragged = false;
        const fret = start + row;
        if (ev?.shiftKey && anchor?.fret === fret) barre(anchor.string, s, fret);
        else { voicing[s] = voicing[s] === fret ? "x" : fret; changed(); }
        anchor = { string: s, fret };
      });
      cell.onpointerdown = (ev) => {
        if (ev.button !== 0) return;
        dragged = false;
        drag = { string: s, row, base: voicing.slice() };
      };
      cell.onpointerenter = (ev) => {
        if (!(ev.buttons & 1)) { drag = null; return; }
        if (!drag || drag.row !== row || drag.string === s) return;
        dragged = true;
        barre(drag.string, s, start + row, drag.base);
        anchor = { string: drag.string, fret: start + row };
      };
      cells[s].push(cell);
    }
    element("div", "fb-lbl", col, labels[s]);
  }
  const textEl = element("input", "fb-text", container);
  textEl.type = "text";
  textEl.setAttribute("aria-label", "Fingering, six comma-separated string values");
  const errEl = element("div", "fb-err", container);
  const readout = element("div", "fb-readout", container);
  const notesEl = element("div", "fb-notes", readout);
  const play = button(readout, "fb-play", "▶", async () => {
    if (!applyText()) return;
    const ok = await window.VoicingAudio.playVoicing(voicing.join(","));
    if (!ok) errEl.textContent = "Audio playback unavailable";
  });
  play.setAttribute("aria-label", "Play current voicing");
  play.title = "Play current voicing";
  const intervalsEl = showIntervals ? element("div", "fb-notes", container) : null;
  const help = element("small", "fb-help", container,
    "Drag across a fret, or click then Shift+click, to set a barre. Top markers open/mute; right-click to mute.");
  help.title = "Arrow markers reveal frets outside the visible window";

  function validate() {
    const result = parseText(textEl.value);
    errEl.textContent = result.error || "";
    textEl.setAttribute("aria-invalid", result.error ? "true" : "false");
    play.disabled = Boolean(result.error || !result.voicing.some((f) => f !== "x"));
    return result;
  }
  function applyText({ focusOnError = false } = {}) {
    const result = validate();
    if (result.error) { if (focusOnError) textEl.focus(); return false; }
    if (result.voicing.join(",") !== voicing.join(",")) {
      voicing = result.voicing;
      start = fittedStart(voicing);
      anchor = null;
      changed();
    } else update();
    return true;
  }
  textEl.oninput = validate;
  textEl.onchange = () => applyText();
  textEl.onkeydown = (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); applyText({ focusOnError: true }); }
  };

  function update(syncText = true) {
    position.textContent = `fret ${start}`;
    down.setAttribute("aria-disabled", String(start === 1));
    up.setAttribute("aria-disabled", String(start === 20));
    numbers.forEach((el, row) => { el.textContent = start + row; });
    marks.forEach((mark, s) => {
      const fret = voicing[s];
      const outside = fret > 0 && (fret < start || fret >= start + WINDOW);
      mark.className = "fb-mark" + (outside ? " fb-overflow" : fret > 0 ? " fb-fretted" : "");
      mark.textContent = outside ? `${fret < start ? "↑" : "↓"}${fret}` : fret === "x" ? "×" : "○";
      mark.title = outside ? `Fret ${fret} (${fret < start ? "above" : "below"} visible window); click to reveal; right-click to mute`
        : fret === 0 ? "Open; click to mute" : "Click to open; right-click to mute";
      mark.setAttribute("aria-label", `String ${labels[s]}: ${mark.title}`);
      cells[s].forEach((cell, row) => {
        const fretNumber = start + row;
        cell.className = "fb-cell" + (voicing[s] === fretNumber ? " on" : "") + (start === 1 && row === 0 ? " fb-nut" : "");
        cell.title = `string ${labels[s]} fret ${fretNumber}`;
        cell.setAttribute("aria-label", cell.title);
        cell.setAttribute("aria-pressed", String(voicing[s] === fretNumber));
      });
    });
    if (syncText) { textEl.value = voicing.join(","); validate(); }
    const CN = window.ChordNaming;
    const hasNotes = voicing.some((f) => f !== "x");
    notesEl.textContent = CN && hasNotes ? "notes: " + CN.perStringNotes(voicing).join(" ") : "notes: —";
    const tonic = CN?.getKeyTonic?.();
    if (intervalsEl) {
      intervalsEl.hidden = !tonic || !hasNotes;
      intervalsEl.textContent = tonic && hasNotes ? "intervals: " + CN.perStringInKey(voicing, tonic).join(" ") : "";
    }
    play.hidden = !window.VoicingAudio?.supported();
  }
  update();
  return {
    set(v) { voicing = v.slice(); start = fittedStart(voicing); anchor = null; update(); },
    get() { return voicing.slice(); },
    isValid() { return !parseText(textEl.value).error; },
    getError() { return parseText(textEl.value).error || ""; },
    commit() { return applyText({ focusOnError: true }); },
    hasUncommittedText() {
      const result = parseText(textEl.value);
      return Boolean(result.error || result.voicing.join(",") !== voicing.join(","));
    },
    focusText() { textEl.focus(); },
  };
}
window.Fretboard = Fretboard;
