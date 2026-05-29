// Tiny read-only chord-diagram thumbnail (vertical box) from a comma voicing.
// window.ChordDiagram.svg("6,x,5,6,6,x") -> an <svg> string.
// Low E on the left; x/o markers on top; starting-fret number at the side.

(function () {
  const STR = 6, ROWS = 5;          // strings, visible fret rows
  const SX = 9, SY = 10;            // string + fret spacing (px)
  const LPAD = 13, TPAD = 11, RPAD = 4, BPAD = 2;
  const W = LPAD + (STR - 1) * SX + RPAD;
  const H = TPAD + ROWS * SY + BPAD;
  const LINE = "#8a93a3", DOT = "#6ea8fe", MARK = "#c7ccd6";

  function parse(voicing) {
    return String(voicing).split(",").map((t) => {
      t = t.trim();
      return t === "x" || t === "X" ? "x" : parseInt(t, 10);
    });
  }

  function windowStart(v) {
    const fretted = v.filter((f) => f !== "x" && f > 0);
    if (!fretted.length) return 1;
    const lo = Math.min(...fretted), hi = Math.max(...fretted);
    return hi <= ROWS ? 1 : lo; // show open position when it fits, else start at lowest
  }

  function svg(voicing) {
    if (!voicing) return "";
    const v = parse(voicing);
    if (v.length !== STR) return "";
    const start = windowStart(v);
    const x = (i) => LPAD + i * SX;
    const y = (row) => TPAD + row * SY;
    const parts = [];

    // strings (vertical) + frets (horizontal)
    for (let i = 0; i < STR; i++)
      parts.push(`<line x1="${x(i)}" y1="${TPAD}" x2="${x(i)}" y2="${TPAD + ROWS * SY}" stroke="${LINE}" stroke-width="1"/>`);
    for (let r = 0; r <= ROWS; r++) {
      const sw = (r === 0 && start === 1) ? 2.5 : 1; // nut
      parts.push(`<line x1="${x(0)}" y1="${y(r)}" x2="${x(STR - 1)}" y2="${y(r)}" stroke="${LINE}" stroke-width="${sw}"/>`);
    }
    // starting fret number (when not open position)
    if (start > 1)
      parts.push(`<text x="${LPAD - 4}" y="${y(0) + SY - 2}" fill="${MARK}" font-size="8" text-anchor="end" font-family="ui-monospace,monospace">${start}</text>`);

    // markers + dots per string
    v.forEach((f, i) => {
      if (f === "x") {
        parts.push(`<text x="${x(i)}" y="${TPAD - 3}" fill="${MARK}" font-size="8" text-anchor="middle" font-family="ui-monospace,monospace">×</text>`);
      } else if (f === 0) {
        parts.push(`<circle cx="${x(i)}" cy="${TPAD - 5}" r="2.5" fill="none" stroke="${MARK}" stroke-width="1"/>`);
      } else {
        const row = f - start;
        if (row >= 0 && row < ROWS)
          parts.push(`<circle cx="${x(i)}" cy="${y(row) + SY / 2}" r="3" fill="${DOT}"/>`);
      }
    });

    return `<svg class="cdia" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${parts.join("")}</svg>`;
  }

  const api = { svg };
  if (typeof window !== "undefined") window.ChordDiagram = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
