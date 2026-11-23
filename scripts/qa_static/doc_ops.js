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

  // Swap entry ei with its immediate neighbor inside the same bar. Unlike
  // moveChord, this never crosses a bar boundary and preserves entry objects.
  function canReorderChord(song, si, bi, ei, dir) {
    if (dir !== -1 && dir !== 1) return false;
    const bar = song && song.sections && song.sections[si]
      && song.sections[si].bars && song.sections[si].bars[bi];
    if (!Array.isArray(bar) || !Number.isInteger(ei) || ei < 0 || ei >= bar.length) return false;
    const target = ei + dir;
    return target >= 0 && target < bar.length;
  }

  function reorderChord(song, si, bi, ei, dir) {
    if (!canReorderChord(song, si, bi, ei, dir)) return false;
    const bar = song.sections[si].bars[bi];
    const target = ei + dir;
    [bar[ei], bar[target]] = [bar[target], bar[ei]];
    return true;
  }

  // Insert an empty bar after bar index bi (use bi = -1 to add the first bar to
  // an empty section). An empty bar [] is schema-valid (bars is an array of arrays).
  function canAddBarAfter(song, si, bi) {
    const section = song?.sections?.[si];
    if (!section || !Number.isInteger(bi)) return false;
    const bars = Array.isArray(section.bars) ? section.bars : [];
    return bi === -1 ? bars.length === 0 : bi >= 0 && bi < bars.length;
  }

  function addBarAfter(song, si, bi) {
    if (!canAddBarAfter(song, si, bi)) return false;
    const section = song.sections[si];
    if (!Array.isArray(section.bars)) section.bars = [];
    section.bars.splice(bi + 1, 0, []);
    return true;
  }

  function canAddBarBefore(song, si, bi) {
    const bars = song?.sections?.[si]?.bars;
    return Array.isArray(bars) && Number.isInteger(bi) && bi >= 0 && bi < bars.length;
  }

  function addBarBefore(song, si, bi) {
    if (!canAddBarBefore(song, si, bi)) return false;
    song.sections[si].bars.splice(bi, 0, []);
    return true;
  }

  function deleteBar(song, si, bi) {
    const bars = song.sections[si].bars;
    if (bi < 0 || bi >= bars.length) return false;
    bars.splice(bi, 1);
    return true;
  }

  // Split before the specified entry, or at the midpoint for the bar control.
  // splitBar retains the legacy continuation fallback for non-UI callers, while
  // canSplitBar reports whether the requested real boundary exists.
  function canSplitBar(song, si, bi, beforeEntry) {
    const bar = song?.sections?.[si]?.bars?.[bi];
    if (!Array.isArray(bar)) return false;
    if (beforeEntry === undefined) return bar.length >= 2;
    return Number.isInteger(beforeEntry) && beforeEntry > 0 && beforeEntry < bar.length;
  }

  function splitBar(song, si, bi, beforeEntry) {
    const bars = song?.sections?.[si]?.bars;
    const bar = bars?.[bi];
    if (!Array.isArray(bar)) return false;
    if (beforeEntry === undefined && bar.length < 2) {
      bars.splice(bi + 1, 0, [{ chord: "%" }]);
      return true;
    }
    const boundary = beforeEntry === undefined ? Math.ceil(bar.length / 2) : beforeEntry;
    if (!canSplitBar(song, si, bi, boundary)) return false;
    bars.splice(bi + 1, 0, bar.splice(boundary));
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

  function lyContinuesWord(token) {
    return Boolean(token && token.length > 1 && token.endsWith("-"));
  }

  // Collapse explicit continuation marks while preserving punctuation and
  // a trailing marker when there is no following lyric in this display.
  function lyDisplayText(text, continuationAfter = true) {
    const toks = lySyllables(text);
    let out = "";
    toks.forEach((t, i) => {
      const cont = lyContinuesWord(t) && (i < toks.length - 1 || continuationAfter);
      out += cont ? t.slice(0, -1) : t + " ";
    });
    return out.trim();
  }

  // One editable lyric line for a run of entries, ChordMark-style.
  function buildLyricLine(entries) {
    let out = "";
    let end = entries.length - 1;
    while (end >= 0 && !lySyllables(entries[end].text).length) end--;
    entries.forEach((e, i) => {
      if (i > 0) {
        const previous = lySyllables(entries[i - 1].text).at(-1);
        out += i <= end && lyContinuesWord(previous) ? "_" : " _";
      } else {
        out = "_";
      }
      const seg = lyDisplayText(e.text, i < end);
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

  // Build the section-wide lyric stream used by the Lyrics reader. Coordinates
  // are offsets into `text` (and therefore JavaScript UTF-16 offsets). Each
  // stored token remains addressable even when its continuation dash is not
  // visible; `syllable` is local to the token's original bar.
  function buildLyricFlow(section) {
    const entries = [];
    const tokens = [];
    const bars = section && Array.isArray(section.bars) ? section.bars : [];

    bars.forEach((bar, bi) => {
      let syllable = 0;
      if (!Array.isArray(bar)) return;
      bar.forEach((entry, ei) => {
        const entryTokens = lySyllables(entry && entry.text);
        const record = { entry, bi, ei, firstToken: tokens.length, tokenCount: entryTokens.length };
        entries.push(record);
        entryTokens.forEach((raw, k) => {
          tokens.push({ raw, bi, ei, k, syllable: syllable++ });
        });
      });
    });

    let text = "";
    let joinNext = false;
    const spans = tokens.map((token, index) => {
      const continuation = lyContinuesWord(token.raw) && index + 1 < tokens.length;
      const visible = continuation ? token.raw.slice(0, -1) : token.raw;

      if (index > 0 && !joinNext) text += " ";
      const start = text.length;
      text += visible;
      const end = text.length;
      joinNext = continuation;
      return {
        text: visible, start, end,
        bi: token.bi, ei: token.ei, k: token.k, syllable: token.syllable,
      };
    });

    const anchors = [];
    entries.forEach((record) => {
      const chord = record.entry && record.entry.chord;
      if (!chord || chord === "%") return;
      const at = spans[record.firstToken]?.start ?? text.length;
      anchors.push({ at, bi: record.bi, ei: record.ei, hasLyric: record.tokenCount > 0 });
    });

    return { text, spans, anchors };
  }

  // Wrap a lyric flow without changing its source coordinates. Rows exclude
  // the separating whitespace at their edges, keep natural words intact, and
  // own every span/anchor exactly once.
  function wrapLyricFlow(flow, maxWidth, measure = (value) => Array.from(value.normalize("NFC")).length) {
    const text = flow && typeof flow.text === "string" ? flow.text : "";
    if (!text) return [];
    const spans = flow && Array.isArray(flow.spans) ? flow.spans : [];
    const anchors = flow && Array.isArray(flow.anchors) ? flow.anchors : [];
    const limit = Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : Infinity;
    const words = Array.from(text.matchAll(/\S+/g), (match) => ({
      start: match.index,
      end: match.index + match[0].length,
    }));
    if (!words.length) return [];

    const bounds = [];
    let first = words[0];
    let last = first;
    for (let i = 1; i < words.length; i++) {
      const word = words[i];
      const width = measure(text.slice(first.start, word.end));
      if (width > limit) {
        bounds.push({ start: first.start, end: last.end });
        first = word;
      }
      last = word;
    }
    bounds.push({ start: first.start, end: last.end });

    return bounds.map((bound, rowIndex) => {
      const isLast = rowIndex === bounds.length - 1;
      const nextStart = isLast ? text.length : bounds[rowIndex + 1].start;
      return {
        start: bound.start,
        end: bound.end,
        text: text.slice(bound.start, bound.end),
        spans: spans.filter((span) =>
          span.start >= bound.start && span.end <= bound.end
        ).map((span) => ({ ...span })),
        anchors: anchors.filter((anchor) =>
          anchor.at >= bound.start && (anchor.at < nextStart || isLast && anchor.at === text.length)
        ).map((anchor) => ({ ...anchor })),
      };
    });
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

  // Plan an Arrange-mode chord move without mutating the song. Lyrics stay in
  // their original bars; only their ownership by entries is rebuilt. A target
  // is a flat syllable boundary in the destination bar (0..syllable count).
  //
  // Return:
  //   { changes: [{si, bi, bar}], selection: {si, bi, ei} } on success
  //   { error: "..." } for invalid or unsafe moves
  //   null for a genuine no-op
  function planLyricAnchorMove(song, from, to) {
    const sections = song && song.sections;
    const coordOk = (c, needsEntry) => {
      if (!c || !Number.isInteger(c.si) || !Number.isInteger(c.bi)) return false;
      const section = sections && sections[c.si];
      const bar = section && Array.isArray(section.bars) && section.bars[c.bi];
      return Array.isArray(bar) && (!needsEntry ||
        (Number.isInteger(c.ei) && c.ei >= 0 && c.ei < bar.length));
    };
    if (!coordOk(from, true)) return { error: "The source chord no longer exists." };
    if (!coordOk(to, false)) return { error: "The destination bar no longer exists." };
    if (!Number.isInteger(to.syllable)) {
      return { error: "Choose a valid destination syllable." };
    }

    const sourceBar = sections[from.si].bars[from.bi];
    const destinationBar = sections[to.si].bars[to.bi];
    const movedEntry = sourceBar[from.ei];
    if (!movedEntry || !movedEntry.chord || movedEntry.chord === "%") {
      return { error: "Only named chords can be arranged; % continuations cannot be moved." };
    }

    const destinationModel = lyBarModel(destinationBar);
    const soleDestinationCarry = destinationBar.length === 1 && destinationBar[0].chord === "%";
    if (soleDestinationCarry && to.syllable !== 0) {
      return { error: "A continuation bar can only be replaced at its first syllable." };
    }
    if (to.syllable < 0 || to.syllable > destinationModel.syllables.length) {
      return { error: "That syllable is outside the destination bar." };
    }

    const sameBar = from.si === to.si && from.bi === to.bi;
    if (sameBar) {
      const model = destinationModel;
      const moved = model.chords[from.ei];
      const alreadyOwnsTie = moved.idx === to.syllable &&
        !model.chords.slice(from.ei + 1).some((c) => c.idx === to.syllable);
      if (alreadyOwnsTie) return null;

      // Reinsert last so a tied target gives the moved chord the lyric run.
      model.chords.splice(from.ei, 1);
      moved.idx = to.syllable;
      model.chords.push(moved);
      const ordered = model.chords.map((c, i) => ({ c, i }))
        .sort((a, b) => a.c.idx - b.c.idx || a.i - b.i);
      if (to.syllable > 0 && ordered[0].c === moved) {
        return { error: "That move would put leading lyrics before their chord." };
      }
      const bar = lyRebuildBar(model);
      return {
        changes: [{ si: from.si, bi: from.bi, bar }],
        selection: { si: from.si, bi: from.bi, ei: ordered.findIndex((x) => x.c === moved) },
      };
    }

    const sourceModel = lyBarModel(sourceBar);
    const [moved] = sourceModel.chords.splice(from.ei, 1);
    if (soleDestinationCarry) destinationModel.chords.length = 0;
    // The current four-beat renderer needs at least one beat per chord.
    if (destinationModel.chords.length >= 4) {
      return { error: "Choose a bar with room for another chord. The renderer needs one beat per chord." };
    }
    moved.idx = to.syllable;
    // Appending makes the moved chord last among target ties, so it owns text.
    destinationModel.chords.push(moved);
    const destinationOrder = destinationModel.chords.map((c, i) => ({ c, i }))
      .sort((a, b) => a.c.idx - b.c.idx || a.i - b.i);
    if (to.syllable > 0 && destinationOrder[0].c === moved) {
      return { error: "That move would put leading lyrics before their chord." };
    }

    const coordBefore = (si, bi, otherSi, otherBi) =>
      si < otherSi || (si === otherSi && bi < otherBi);
    const precedingRealChordAfterMove = () => {
      for (let si = 0; si < sections.length; si++) {
        const bars = sections[si] && sections[si].bars;
        if (!Array.isArray(bars)) continue;
        for (let bi = 0; bi < bars.length; bi++) {
          if (!coordBefore(si, bi, from.si, from.bi)) return false;
          if (si === to.si && bi === to.bi) return true; // moved chord is now here
          if (bars[bi].some((entry) => entry && entry.chord && entry.chord !== "%")) return true;
        }
      }
      return false;
    };
    const leavesLeadingContinuation = () => {
      for (let si = from.si; si < sections.length; si++) {
        const bars = sections[si].bars || [];
        for (let bi = si === from.si ? from.bi + 1 : 0; bi < bars.length; bi++) {
          if (si === to.si && bi === to.bi) return false;
          const first = bars[bi][0]?.chord;
          if (first) return first === "%";
        }
      }
      return false;
    };

    const sourceHasRealChord = sourceModel.chords.some((c) => c.chord && c.chord !== "%");
    let rebuiltSource;
    if (sourceHasRealChord) {
      rebuiltSource = lyRebuildBar(sourceModel);
    } else {
      if (sourceModel.chords.length > 1) {
        return { error: "That move would leave multiple continuations in the source bar." };
      }
      const hasPrecedingChord = precedingRealChordAfterMove();
      if (sourceModel.syllables.length && !hasPrecedingChord) {
        return { error: "That move would orphan lyrics before the first real chord." };
      }
      if (!hasPrecedingChord && (sourceModel.chords.length || leavesLeadingContinuation())) {
        return { error: "That move would leave a continuation before the first real chord." };
      }
      if (sourceModel.chords.length) {
        rebuiltSource = lyRebuildBar(sourceModel);
      } else if (hasPrecedingChord) {
        const text = sourceModel.syllables.map((s) => s.text).join(" ");
        rebuiltSource = [{ chord: "%", ...(text ? { text } : {}) }];
      } else {
        rebuiltSource = [];
      }
    }

    const rebuiltDestination = lyRebuildBar(destinationModel);
    const changes = [
      { si: from.si, bi: from.bi, bar: rebuiltSource },
      { si: to.si, bi: to.bi, bar: rebuiltDestination },
    ].sort((a, b) => a.si - b.si || a.bi - b.bi);
    return {
      changes,
      selection: {
        si: to.si,
        bi: to.bi,
        ei: destinationOrder.findIndex((x) => x.c === moved),
      },
    };
  }

  const api = {
    canMoveChord, moveChord,
    canReorderChord, reorderChord,
    canAddBarAfter, addBarAfter, canAddBarBefore, addBarBefore,
    deleteBar, canSplitBar, splitBar,
    canMergeBarWithNext, mergeBarWithNext,
    addSectionAfter, deleteSection,
    lySyllables, lyBarModel, lyRebuildBar, sylIndexInBar, reanchoredBar,
    planLyricAnchorMove,
    replaceTextToken,
    buildLyricFlow, wrapLyricFlow,
    lyDisplayText, buildLyricLine, parseLyricLine,
  };
  if (typeof window !== "undefined") window.DocOps = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
