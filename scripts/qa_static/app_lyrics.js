// ---- Lyrics view (PROTOTYPE) ----
// A lyrics-first layout: each chord sits ABOVE the first syllable of the text
// fragment it anchors to. Chords are draggable; syllables are drop targets.
// Dropping a chord onto a syllable RE-ANCHORS it to that syllable.
//
// KNOWN LIMITATION (prototype): re-anchoring is scoped to WITHIN A SINGLE BAR.
// On drop we treat the bar as (syllables[] = concatenated entry texts) plus a
// (chord -> syllable-index) map, move the dragged chord to the target syllable,
// then rebuild the bar's entries so each chord owns the run of syllables from
// its index up to the next chord's index. Voicings are preserved per chord.
// Cross-bar drops are detected and no-op gracefully.

// Tokenization + bar model + rebuild live in doc_ops.js (window.DocOps).
const lySyllables = (text) => window.DocOps.lySyllables(text);
const sylIndexInBar = (bar, chordPos, k) => window.DocOps.sylIndexInBar(bar, chordPos, k);

// Perform the re-anchor: move chord at chordPos within the bar to target
// syllable index, rebuild entries, mutate state.doc.
function lyReanchor(si, bi, chordPos, targetSylIdx) {
  const bar = song().sections[si].bars[bi];
  const rebuilt = window.DocOps.reanchoredBar(bar, chordPos, targetSylIdx);
  if (rebuilt === null) return; // invalid or no change
  pushUndo();
  song().sections[si].bars[bi] = rebuilt;
  markDirty();
  renderLyrics();
}

// Currently-dragged chord descriptor (set on dragstart, read on drop).
let lyDrag = null;

function renderLyrics() {
  const root = $("lyrics");
  if (!root) return;
  if (!state.doc) { root.innerHTML = `<div class="empty">No song loaded.</div>`; return; }
  root.innerHTML = "";
  const hint = document.createElement("div");
  hint.className = "ly-hint";
  hint.textContent = "Drag a chord onto a syllable to re-anchor it (within its bar). ⌘Z undoes.";
  root.appendChild(hint);

  song().sections.forEach((sec, si) => {
    const secEl = document.createElement("div");
    secEl.className = "ly-section";
    const lab = document.createElement("div");
    lab.className = "ly-seclabel";
    lab.textContent = sec.label || `Section ${si + 1}`;
    secEl.appendChild(lab);

    const line = document.createElement("div");
    line.className = "ly-line";
    const bars = sec.bars || [];
    if (!bars.length) {
      const e = document.createElement("span");
      e.className = "ly-text empty";
      e.textContent = "(empty section)";
      line.appendChild(e);
    }
    bars.forEach((bar, bi) => {
      if (bi > 0) {
        const sep = document.createElement("span");
        sep.className = "ly-barsep";
        sep.textContent = "|";
        line.appendChild(sep);
      }
      line.appendChild(renderLyBar(si, bi, bar));
    });
    secEl.appendChild(line);
    root.appendChild(secEl);
  });
}

// Render one bar as a sequence of syllable columns, each optionally topped by
// the chord(s) anchored to its first syllable. chordPos is the chord's position
// within the bar (its index in the bar's entry array), used by re-anchor.
function renderLyBar(si, bi, bar) {
  const wrap = document.createElement("span");
  wrap.className = "ly-bar";

  // Map each entry to {chord, voicing, syls, chordPos}. The chord shows over the
  // first syllable; remaining syllables render as bare columns under no chord.
  let anySyl = false;
  bar.forEach((e, chordPos) => {
    const syls = lySyllables(e.text);
    if (syls.length) {
      anySyl = true;
      syls.forEach((syl, k) => {
        wrap.appendChild(makeSyl(si, bi, syl,
          k === 0 ? { chord: e.chord, voicing: e.voicing, chordPos } : null,
          // drop target syllable index within the bar's flat syllable list:
          sylIndexInBar(bar, chordPos, k)));
      });
    } else {
      // instrumental / textless entry — standalone chord token, droppable too
      wrap.appendChild(makeSyl(si, bi, "",
        { chord: e.chord, voicing: e.voicing, chordPos, inst: true },
        sylIndexInBar(bar, chordPos, 0)));
    }
  });
  if (!anySyl && !bar.length) {
    const empty = document.createElement("span");
    empty.className = "ly-text empty";
    empty.textContent = "·";
    wrap.appendChild(empty);
  }
  return wrap;
}

// Build a syllable column. `chord` (or null) renders a draggable token above;
// the column itself is a drop target carrying its flat syllable index.
function makeSyl(si, bi, sylText, chord, sylIdx) {
  const col = document.createElement("span");
  col.className = "ly-syl";

  if (chord) {
    const tok = document.createElement("span");
    const isPct = chord.chord === "%";
    tok.className = "ly-chord" + (isPct ? " pct" : "") + (chord.inst ? " inst" : "");
    tok.textContent = chord.chord;
    if (chord.voicing) tok.title = chord.voicing;
    tok.draggable = true;
    tok.addEventListener("dragstart", (ev) => {
      lyDrag = { si, bi, chordPos: chord.chordPos };
      tok.classList.add("dragging");
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = "move";
        ev.dataTransfer.setData("text/plain", chord.chord);
      }
    });
    tok.addEventListener("dragend", () => {
      tok.classList.remove("dragging");
      lyDrag = null;
    });
    col.appendChild(tok);
  } else {
    const spacer = document.createElement("span");
    spacer.className = "ly-chordrow-spacer";
    col.appendChild(spacer);
  }

  const txt = document.createElement("span");
  if (chord && chord.inst) {
    txt.className = "ly-text ly-inst";
    txt.textContent = "—";
  } else {
    txt.className = "ly-text";
    txt.textContent = sylText || "·";
  }
  col.appendChild(txt);

  // Drop target: re-anchor the dragged chord onto this syllable (same bar only).
  col.addEventListener("dragover", (ev) => {
    if (!lyDrag) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect =
      (lyDrag.si === si && lyDrag.bi === bi) ? "move" : "none";
    col.classList.add("drop-ok");
  });
  col.addEventListener("dragleave", () => col.classList.remove("drop-ok"));
  col.addEventListener("drop", (ev) => {
    ev.preventDefault();
    col.classList.remove("drop-ok");
    if (!lyDrag) return;
    const d = lyDrag;
    lyDrag = null;
    if (d.si !== si || d.bi !== bi) return; // cross-bar: no-op (prototype scope)
    lyReanchor(si, bi, d.chordPos, sylIdx);
  });

  return col;
}
