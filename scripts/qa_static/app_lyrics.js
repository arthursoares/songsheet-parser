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

// Two modes: "text" = free-form ChordMark lyric lines (chords read-only above,
// `_` markers in editable text); "grid" = the original drag/dblclick prototype.
function lyMode() { return localStorage.getItem("qaLyMode") || "text"; }

function renderLyrics() {
  const root = $("lyrics");
  if (!root) return;
  if (!state.doc) { root.innerHTML = `<div class="empty">No song loaded.</div>`; return; }
  root.innerHTML = "";

  const bar = document.createElement("div");
  bar.className = "ly-modebar";
  bar.innerHTML =
    `<button class="tab ${lyMode() === "text" ? "active" : ""}" data-mode="text">text</button>
     <button class="tab ${lyMode() === "grid" ? "active" : ""}" data-mode="grid">grid</button>`;
  bar.querySelectorAll("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => { localStorage.setItem("qaLyMode", b.dataset.mode); renderLyrics(); }));
  root.appendChild(bar);

  if (lyMode() === "text") renderLyricsText(root);
  else renderLyricsGrid(root);
}

// ---- text mode: ChordMark lyric lines ----
// One row per 4 bars: a read-only chord line above an editable lyric line with
// one `_` marker per chord entry. Commit on Enter/blur; Esc reverts. The only
// invariant is the marker count — a mismatch refuses the commit with a message.
// Gluing a marker into a word ("tris_te") stores a continuation dash; text
// before the row's first marker flows back to the previous entry.
const LY_BARS_PER_ROW = 4;

function renderLyricsText(root) {
  const hint = document.createElement("div");
  hint.className = "ly-hint";
  hint.textContent = "Each _ anchors the chord shown above it. Edit text freely: " +
    "delete the space before a _ to split a word across chords (tris_te), " +
    "add one to separate. Enter/blur applies, Esc reverts. ⌘Z undoes.";
  root.appendChild(hint);

  let prevEntry = null; // last entry of the previous row (for leading text)
  song().sections.forEach((sec, si) => {
    const secEl = document.createElement("div");
    secEl.className = "ly-section";
    const lab = document.createElement("div");
    lab.className = "ly-seclabel";
    lab.textContent = sec.label || `Section ${si + 1}`;
    secEl.appendChild(lab);

    const bars = sec.bars || [];
    for (let b0 = 0; b0 < bars.length; b0 += LY_BARS_PER_ROW) {
      const rowBars = bars.slice(b0, b0 + LY_BARS_PER_ROW);
      const entries = rowBars.flat();
      if (!entries.length) continue;
      const rowEl = document.createElement("div");
      rowEl.className = "ly-row";
      const chordLine = document.createElement("div");
      chordLine.className = "ly-chordline";
      chordLine.textContent =
        "| " + rowBars.map((bar) => bar.map((e) => e.chord).join("  ")).join("  |  ") + " |";
      rowEl.appendChild(chordLine);

      const input = document.createElement("input");
      input.className = "ly-line-edit";
      input.value = window.DocOps.buildLyricLine(entries);
      input.spellcheck = false;
      const original = input.value;
      const errEl = document.createElement("div");
      errEl.className = "ly-line-err";
      const prevRef = prevEntry; // entry preceding this row, frozen at render
      let cancelled = false;
      const commit = () => {
        if (cancelled || input.value === original) return;
        const parsed = window.DocOps.parseLyricLine(input.value, entries.length);
        if (parsed === null) {
          const got = (input.value.match(/_/g) || []).length;
          errEl.textContent =
            `needs exactly ${entries.length} markers for the chords above (found ${got}) — not applied`;
          return;
        }
        errEl.textContent = "";
        pushUndo();
        if (parsed.leading) {
          if (prevRef) prevRef.text = ((prevRef.text || "") + " " + parsed.leading).trim();
          else parsed.fragments[0] = (parsed.leading + " " + parsed.fragments[0]).trim();
        }
        entries.forEach((e, k) => {
          const frag = parsed.fragments[k];
          if (frag) e.text = frag; else delete e.text;
        });
        markDirty();
        renderBars();
        renderLyrics();
      };
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); commit(); }
        else if (ev.key === "Escape") { cancelled = true; input.value = original; errEl.textContent = ""; input.blur(); cancelled = false; }
      });
      input.addEventListener("blur", commit);
      rowEl.appendChild(input);
      rowEl.appendChild(errEl);
      secEl.appendChild(rowEl);
      prevEntry = entries[entries.length - 1];
    }
    root.appendChild(secEl);
  });
}

// ---- grid mode: the original drag/dblclick prototype ----
function renderLyricsGrid(root) {
  const hint = document.createElement("div");
  hint.className = "ly-hint";
  hint.textContent = "Drag a chord onto a syllable to re-anchor it (within its bar). " +
    "Double-click a syllable to edit it — a space splits the word, empty deletes. ⌘Z undoes.";
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
          sylIndexInBar(bar, chordPos, k),
          chordPos, k));
      });
    } else {
      // instrumental / textless entry — standalone chord token, droppable too
      wrap.appendChild(makeSyl(si, bi, "",
        { chord: e.chord, voicing: e.voicing, chordPos, inst: true },
        sylIndexInBar(bar, chordPos, 0),
        chordPos, 0));
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
// ownerPos/k locate the syllable for editing: token k of entry ownerPos.
function makeSyl(si, bi, sylText, chord, sylIdx, ownerPos, k) {
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

  // Inline syllable editing: double-click swaps the span for an input.
  // Commit rebuilds the owning entry's text token (space = split, empty =
  // delete); Esc cancels. One undo step per committed edit.
  if (sylText && !(chord && chord.inst)) {
    txt.title = "double-click to edit (space splits, empty deletes)";
    txt.addEventListener("dblclick", (ev) => {
      ev.stopPropagation();
      const input = document.createElement("input");
      input.className = "ly-edit";
      input.value = sylText;
      input.size = Math.max(3, sylText.length + 2);
      col.replaceChild(input, txt);
      input.focus();
      input.select();
      let done = false;
      const commit = () => {
        if (done) return;
        done = true;
        const e = song().sections[si].bars[bi][ownerPos];
        const nt = window.DocOps.replaceTextToken(e.text, k, input.value);
        if (nt === null || nt === (e.text || "")) { renderLyrics(); return; }
        pushUndo();
        if (nt) e.text = nt; else delete e.text;
        markDirty();
        renderLyrics();
      };
      input.addEventListener("keydown", (ev2) => {
        if (ev2.key === "Enter") { ev2.preventDefault(); commit(); }
        else if (ev2.key === "Escape") { done = true; renderLyrics(); }
      });
      input.addEventListener("blur", commit);
    });
  }

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
