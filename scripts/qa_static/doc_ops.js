// Pure document-mutation operations for the QA tool: structural bar/section
// edits and the Lyrics tab's chord<->syllable re-anchoring. No DOM, no state,
// no undo — callers own pushUndo/markDirty/re-render. A song is
// { sections: [ { label, bars: [ [ {chord, voicing?, text?}, ... ], ... ] } ] }.
//
// Mutating ops return true if they changed the song, false if the request was
// a no-op (out of range, nothing to merge, ...) — and NEVER mutate on false,
// so callers can pushUndo() only for real changes. can*() predicates exist
// where the UI needs to check validity before snapshotting.

(function () {
  // ---- Structural editing (Bars view) ----

  function canMoveChord(song, si, bi, dir) {
    const bars = song.sections[si].bars;
    const target = bi + dir;
    return target >= 0 && target < bars.length;
  }

  // Move entry ei of bar bi into the previous (dir=-1, appended) or next
  // (dir=+1, prepended) bar, preserving chord order across the boundary.
  function moveChord(song, si, bi, ei, dir) {
    if (!canMoveChord(song, si, bi, dir)) return false;
    const bars = song.sections[si].bars;
    const [entry] = bars[bi].splice(ei, 1);
    if (dir < 0) bars[bi + dir].push(entry);
    else bars[bi + dir].unshift(entry);
    return true;
  }

  // Insert an empty bar after bar index bi (use bi = -1 to add the first bar to
  // an empty section). An empty bar [] is schema-valid (bars is an array of arrays).
  function addBarAfter(song, si, bi) {
    song.sections[si].bars.splice(bi + 1, 0, []);
    return true;
  }

  function deleteBar(song, si, bi) {
    const bars = song.sections[si].bars;
    if (bi < 0 || bi >= bars.length) return false;
    bars.splice(bi, 1);
    return true;
  }

  // Split a bar into two. Multi-entry: split at the midpoint. Single/empty
  // entry: the new second bar is a "%" continuation (keeps it simple & schema-valid).
  function splitBar(song, si, bi) {
    const bars = song.sections[si].bars;
    const bar = bars[bi];
    if (bar.length >= 2) {
      const mid = Math.ceil(bar.length / 2);
      const tail = bar.splice(mid);
      bars.splice(bi + 1, 0, tail);
    } else {
      bars.splice(bi + 1, 0, [{ chord: "%" }]);
    }
    return true;
  }

  function canMergeBarWithNext(song, si, bi) {
    return bi < song.sections[si].bars.length - 1;
  }

  // Merge a bar with the next one (concatenate entries, drop the next bar).
  function mergeBarWithNext(song, si, bi) {
    if (!canMergeBarWithNext(song, si, bi)) return false;
    const bars = song.sections[si].bars;
    bars[bi] = bars[bi].concat(bars[bi + 1]);
    bars.splice(bi + 1, 1);
    return true;
  }

  // Insert a new section after section index si (with one "%" bar so it renders).
  function addSectionAfter(song, si) {
    song.sections.splice(si + 1, 0, { label: "", bars: [[{ chord: "%" }]] });
    return true;
  }

  function deleteSection(song, si) {
    if (si < 0 || si >= song.sections.length) return false;
    song.sections.splice(si, 1);
    return true;
  }

  // ---- Lyrics re-anchoring (within a single bar) ----
  // A bar is modeled as (syllables[] = concatenated entry texts) plus a
  // (chord -> syllable-index) map; moving a chord and rebuilding entries gives
  // each chord the run of syllables from its index up to the next chord's index.

  // Tokenize an entry's text into syllable/word tokens (split on whitespace).
  function lySyllables(text) {
    if (!text) return [];
    return String(text).split(/\s+/).filter((s) => s.length);
  }

  // Build a flat model of one bar for re-anchoring:
  //   syllables: [{text}], chords: [{chord, voicing, idx}] where idx is the
  //   syllable index the chord anchors to. Instrumental entries (no text) anchor
  //   to the syllable index at their position (a synthetic empty-run boundary).
  function lyBarModel(bar) {
    const syllables = [];
    const chords = [];
    bar.forEach((e) => {
      const syls = lySyllables(e.text);
      const idx = syllables.length;
      // carry the whole entry so rebuild preserves every field (voicing,
      // voicing_printed, ...) and only re-derives text
      chords.push({ chord: e.chord, voicing: e.voicing, entry: e, idx });
      syls.forEach((s) => syllables.push({ text: s }));
    });
    return { syllables, chords };
  }

  // Rebuild a bar's entry array from a {syllables, chords} model after a move.
  // Each chord owns syllables [idx, nextChord.idx); text is the run joined by
  // spaces (omitted when empty). Chords are kept in ascending idx order; ties
  // keep their existing relative order (stable). The FIRST chord always owns
  // from syllable 0 — leading syllables can't be orphaned (entry text is the
  // only place a bar's lyrics live, so dropping them would delete lyrics).
  function lyRebuildBar(model) {
    const chords = model.chords
      .map((c, i) => ({ ...c, _o: i }))
      .sort((a, b) => a.idx - b.idx || a._o - b._o);
    return chords.map((c, i) => {
      const start = i === 0 ? 0 : c.idx;
      const next = i + 1 < chords.length ? chords[i + 1].idx : model.syllables.length;
      const run = model.syllables.slice(start, Math.max(start, next))
        .map((s) => s.text).join(" ");
      // preserve every original entry field; only text is re-derived
      const entry = c.entry ? { ...c.entry } : { chord: c.chord };
      if (!c.entry && c.voicing) entry.voicing = c.voicing;
      delete entry.text;
      if (run) entry.text = run;
      return entry;
    });
  }

  // Flat syllable index (within the bar) of the k-th syllable of entry chordPos.
  function sylIndexInBar(bar, chordPos, k) {
    let idx = 0;
    for (let i = 0; i < chordPos; i++) idx += lySyllables(bar[i].text).length;
    return idx + k;
  }

  // The bar that results from moving chord chordPos to target syllable index,
  // or null if the move is invalid / a no-op. Does not mutate the input bar.
  function reanchoredBar(bar, chordPos, targetSylIdx) {
    const model = lyBarModel(bar);
    if (chordPos < 0 || chordPos >= model.chords.length) return null;
    const clamped = Math.max(0, Math.min(targetSylIdx, model.syllables.length));
    if (model.chords[chordPos].idx === clamped) return null; // no change
    model.chords[chordPos].idx = clamped;
    return lyRebuildBar(model);
  }

  const api = {
    canMoveChord, moveChord,
    addBarAfter, deleteBar, splitBar,
    canMergeBarWithNext, mergeBarWithNext,
    addSectionAfter, deleteSection,
    lySyllables, lyBarModel, lyRebuildBar, sylIndexInBar, reanchoredBar,
  };
  if (typeof window !== "undefined") window.DocOps = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
