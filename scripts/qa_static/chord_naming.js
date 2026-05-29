// Reverse chord detection (tonal) validated through ChordMark's parser (chord-symbol).
// Loaded after vendor/tonal.bundle.js and vendor/chord-symbol.bundle.js, which set
// globals window.Tonal and window.chordSymbol ({chordParserFactory, chordRendererFactory}).

(function () {
  const TUNING_MIDI = [40, 45, 50, 55, 59, 64]; // E A D G B e (low->high), standard

  const _parse = window.chordSymbol.chordParserFactory();
  const _render = window.chordSymbol.chordRendererFactory({ useShortNamings: true });

  // voicing: array of 6 entries, each "x" or fret number (0-24), low E -> high e.
  // Returns notes ordered low->high (first is the bass).
  function voicingToNotes(voicing) {
    const notes = [];
    voicing.forEach((f, i) => {
      if (f === "x" || f === null || f === undefined) return;
      const midi = TUNING_MIDI[i] + Number(f);
      notes.push(window.Tonal.Midi.midiToNoteName(midi, { pitchClass: false }));
    });
    return notes;
  }

  // Parse a name with chord-symbol (the ChordMark parser). Returns the result
  // object on success (with .normalized.notes), or null if not a valid ChordMark chord.
  function _parseChordmark(name) {
    const res = _parse(name);
    return res && !res.error ? res : null;
  }

  // Ranked names that are BOTH detected from the notes AND valid ChordMark chords.
  // Each entry: {name: <canonical ChordMark string>, raw: <tonal candidate>}.
  function suggestNames(voicing) {
    const notes = voicingToNotes(voicing);
    if (notes.length < 2) return [];
    const bass = notes[0];
    const detected = window.Tonal.Chord.detect(notes, { assumeBass: bass }) || [];
    const out = [];
    const seen = new Set();
    for (const cand of detected) {
      const parsed = _parseChordmark(cand);
      if (!parsed) continue;
      const name = _render(parsed); // canonical ChordMark form
      if (!seen.has(name)) {
        seen.add(name);
        out.push({ name, raw: cand });
      }
    }
    return out;
  }

  // Validate/normalize a user-typed name against ChordMark's parser.
  function validateName(name) {
    const parsed = _parseChordmark(name);
    if (!parsed) return { valid: false };
    return { valid: true, normalized: _render(parsed) };
  }

  // Does the typed name's pitch set match the voicing's pitch set?
  // Returns true / false, or null when it can't be determined.
  function nameMatchesVoicing(name, voicing) {
    const parsed = _parseChordmark(name);
    const want = parsed && parsed.normalized && parsed.normalized.notes;
    if (!want) return null;
    const chroma = (n) => window.Tonal.Note.chroma(n);
    const wantSet = new Set(want.map(chroma));
    const haveSet = new Set(voicingToNotes(voicing).map(chroma));
    if (wantSet.size === 0 || haveSet.size === 0) return null;
    if (wantSet.size !== haveSet.size) return false;
    for (const c of wantSet) if (!haveSet.has(c)) return false;
    return true;
  }

  window.ChordNaming = { voicingToNotes, suggestNames, validateName, nameMatchesVoicing };
})();
