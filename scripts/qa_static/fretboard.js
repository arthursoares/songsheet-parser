// Dual-mode voicing editor: vertical chord diagram <-> comma fret-number text field, two-way bound.
// Usage: const fb = Fretboard(containerEl, onChange);  fb.set(["x",6,8,6,7,6]);
// onChange(voicingArray) fires on every valid change. Frets 0-24; "x" = muted.

const STRINGS = 6, WINDOW = 5;
const STRING_LABELS = ["E", "A", "D", "G", "B", "e"];

function Fretboard(container, onChange) {
  let voicing = ["x", "x", "x", "x", "x", "x"];
  let start = 1; // top fret of the visible window

  function fittedStart(v) {
    const fretted = v.filter((f) => f !== "x" && f !== 0).map(Number);
    if (!fretted.length) return 1;
    const lo = Math.min(...fretted);
    return lo >= 1 && lo <= 24 ? Math.max(1, Math.min(lo, 24 - WINDOW + 1)) : 1;
  }

  function parseText(raw) {
    const toks = raw.split(",").map((t) => t.trim());
    if (toks.length !== STRINGS) return { error: "need exactly 6 values" };
    const out = [];
    for (const t of toks) {
      if (t === "x" || t === "X") { out.push("x"); continue; }
      if (!/^\d{1,2}$/.test(t)) return { error: `bad value "${t}"` };
      const n = parseInt(t, 10);
      if (n < 0 || n > 24) return { error: `fret ${n} out of range 0-24` };
      out.push(n);
    }
    return { voicing: out };
  }

  function render() {
    container.innerHTML = "";
    // fret window controls
    const ctl = document.createElement("div");
    ctl.className = "fb-ctl";
    ctl.innerHTML = `<button data-act="dn">−</button><span>fret ${start}</span><button data-act="up">+</button>`;
    ctl.querySelector('[data-act=dn]').onclick = () => { if (start > 1) { start--; render(); } };
    ctl.querySelector('[data-act=up]').onclick = () => { if (start < 24 - WINDOW + 1) { start++; render(); } };
    container.appendChild(ctl);

    // DOM grid
    const grid = document.createElement("div");
    grid.className = "fb-grid";

    // fret-number legend column (left side): blank marker slot, a number per fret row, blank label slot
    const legend = document.createElement("div");
    legend.className = "fb-col fb-legend";
    const legendMark = document.createElement("div");
    legendMark.className = "fb-mark";
    legend.appendChild(legendMark);
    for (let f = 0; f < WINDOW; f++) {
      const fn = document.createElement("div");
      fn.className = "fb-fretnum";
      fn.textContent = start + f;
      legend.appendChild(fn);
    }
    const legendLbl = document.createElement("div");
    legendLbl.className = "fb-lbl";
    legend.appendChild(legendLbl);
    grid.appendChild(legend);

    for (let s = 0; s < STRINGS; s++) {
      const col = document.createElement("div");
      col.className = "fb-col";
      // marker (x / o / fretted)
      const mark = document.createElement("div");
      mark.className = "fb-mark";
      mark.textContent = voicing[s] === "x" ? "×" : voicing[s] === 0 ? "○" : "";
      mark.title = "click: muted <-> open";
      mark.onclick = () => { voicing[s] = voicing[s] === "x" ? 0 : "x"; emit(); render(); };
      col.appendChild(mark);
      // fret cells
      for (let f = 0; f < WINDOW; f++) {
        const absFret = start + f;
        const cell = document.createElement("div");
        cell.className = "fb-cell" + (voicing[s] === absFret ? " on" : "");
        cell.title = `string ${STRING_LABELS[s]} fret ${absFret}`;
        cell.onclick = () => { voicing[s] = voicing[s] === absFret ? "x" : absFret; emit(); render(); };
        col.appendChild(cell);
      }
      const lbl = document.createElement("div");
      lbl.className = "fb-lbl";
      lbl.textContent = STRING_LABELS[s];
      col.appendChild(lbl);
      grid.appendChild(col);
    }
    container.appendChild(grid);

    // comma fret-number text field
    const text = document.createElement("input");
    text.type = "text";
    text.className = "fb-text";
    text.value = voicing.join(",");
    const err = document.createElement("div");
    err.className = "fb-err";
    const apply = () => {
      const r = parseText(text.value);
      if (r.error) { err.textContent = r.error; return; }
      err.textContent = "";
      voicing = r.voicing;
      start = fittedStart(voicing);
      emit();
      render();
    };
    text.onchange = apply;
    text.onkeydown = (e) => { if (e.key === "Enter") apply(); };
    container.appendChild(text);
    container.appendChild(err);

    // notes readout (low -> high), computed from the current voicing
    const notesEl = document.createElement("div");
    notesEl.className = "fb-notes";
    let notes = [];
    if (window.ChordNaming && window.ChordNaming.voicingToNotes) {
      // pitch-class names without octave, deduped in playing order
      const seen = new Set();
      window.ChordNaming.voicingToNotes(voicing).forEach((n) => {
        const pc = n.replace(/[0-9]/g, "");
        if (!seen.has(pc)) { seen.add(pc); notes.push(pc); }
      });
    }
    notesEl.textContent = notes.length ? "notes: " + notes.join(" ") : "notes: —";
    container.appendChild(notesEl);
  }

  function emit() { onChange(voicing.slice()); }

  render();
  return {
    set(v) { voicing = v.slice(); start = fittedStart(voicing); render(); },
    get() { return voicing.slice(); },
  };
}

window.Fretboard = Fretboard;
