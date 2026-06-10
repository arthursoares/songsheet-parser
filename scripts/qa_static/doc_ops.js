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

  // ---- ChordMark-style lyric line (free-form text editing) ----
  // The editable form of a run of entries is ONE string in ChordMark lyric
  // syntax: a "_" marker per entry, lyrics flowing naturally around them.
  // A marker glued into a word ("tris_te") is a mid-word chord change, which
  // the corpus stores as a trailing continuation dash ("tris-"). So:
  //   build:  trailing dash on an entry's text -> glue the next marker
  //           (internal "syl- la- ble" runs collapse to the natural word)
  //   parse:  segment not ending in whitespace before the next marker ->
  //           store it with a trailing dash

  // Display form of one entry's text: internal continuation dashes collapse
  // ("tris- te- za e" -> "tristeza e"); a trailing dash is DROPPED here (the
  // caller expresses it by gluing the next marker instead).
  function lyDisplayText(text) {
    const toks = lySyllables(text);
    let out = "";
    toks.forEach((t, i) => {
      const cont = t.endsWith("-") && i < toks.length - 1;
      out += cont ? t.slice(0, -1) : t + " ";
    });
    return out.trim().replace(/-$/, "");
  }

  // One editable lyric line for a run of entries, ChordMark-style.
  function buildLyricLine(entries) {
    let out = "";
    entries.forEach((e, i) => {
      if (i > 0) {
        const prevRaw = (entries[i - 1].text || "").trim();
        out += prevRaw.endsWith("-") ? "_" : " _";
      } else {
        out = "_";
      }
      const seg = lyDisplayText(e.text);
      if (seg) out += seg;
    });
    return out;
  }

  // Parse an edited lyric line back into per-entry text fragments.
  // Returns { leading, fragments } where fragments[k] is entry k's new text
  // ("" = no text) and leading is any text BEFORE the first marker (belongs
  // to whatever entry precedes this run). Returns null when the marker count
  // doesn't equal expectedCount — the one invariant that guards the commit.
  function parseLyricLine(line, expectedCount) {
    const pieces = String(line || "").split("_");
    if (pieces.length - 1 !== expectedCount) return null;
    const leading = pieces[0].trim();
    const fragments = [];
    for (let k = 1; k < pieces.length; k++) {
      const raw = pieces[k];
      const frag = raw.trim();
      // glued to the NEXT marker = the word continues -> trailing dash
      const glued = k < pieces.length - 1 && raw.length > 0 && !/\s$/.test(raw);
      fragments.push(frag ? frag + (glued && !frag.endsWith("-") ? "-" : "") : "");
    }
    return { leading, fragments };
  }

  // New entry text with token k replaced by newText (trimmed). A space inside
  // newText SPLITS the token into multiple syllables; empty newText DELETES
  // the token. Returns null if k is out of range; "" means no tokens remain.
  function replaceTextToken(text, k, newText) {
    const toks = lySyllables(text);
    if (k < 0 || k >= toks.length) return null;
    const nt = String(newText || "").trim().replace(/\s+/g, " ");
    if (nt) toks.splice(k, 1, ...nt.split(" "));
    else toks.splice(k, 1);
    return toks.join(" ");
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
    replaceTextToken,
    lyDisplayText, buildLyricLine, parseLyricLine,
  };
  if (typeof window !== "undefined") window.DocOps = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
