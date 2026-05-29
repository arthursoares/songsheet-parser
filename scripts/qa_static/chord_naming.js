// Reverse chord detection (tonal) validated through ChordMark's parser (chord-symbol).
// Loaded after vendor/tonal.bundle.js and vendor/chord-symbol.bundle.js, which set
// globals window.Tonal and window.chordSymbol ({chordParserFactory, chordRendererFactory}).

(function () {
  const TUNING_MIDI = [40, 45, 50, 55, 59, 64]; // E A D G B e (low->high), standard

  const _parse = window.chordSymbol.chordParserFactory();
  const _render = window.chordSymbol.chordRendererFactory({ useShortNamings: true });

  // Global enharmonic spelling preference: "flat" or "sharp". Set via setSpelling().
  let _spelling = "sharp";
  function setSpelling(mode) { _spelling = mode === "flat" ? "flat" : "sharp"; }
  function getSpelling() { return _spelling; }

  // Global key tonic (e.g. "C") for interval analysis; "" = none. Set by the app.
  let _keyTonic = "";
  function setKeyTonic(t) { _keyTonic = t || ""; }
  function getKeyTonic() { return _keyTonic; }

  // Respell a note name to the chosen accidental (e.g. "A#"<->"Bb"); naturals unchanged.
  function spell(note) {
    const pc = note.replace(/[0-9]/g, "");
    if (!pc.includes("#") && !pc.includes("b")) return pc;
    const enh = window.Tonal.Note.enharmonic(pc);
    if (_spelling === "flat") return pc.includes("b") ? pc : enh;
    return pc.includes("#") ? pc : enh;
  }

  // Deduped pitch-class names for a voicing, in playing order, in the chosen spelling.
  function pcNotes(voicing) {
    const out = [], seen = new Set();
    voicingToNotes(voicing).forEach((n) => {
      const s = spell(n);
      if (!seen.has(s)) { seen.add(s); out.push(s); }
    });
    return out;
  }

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

  // Roman-numeral scale degree of one note relative to a major-key tonic.
  // Case reflects the diatonic triad quality in major (I ii iii IV V vi vii);
  // chromatic notes get a flat/sharp prefix. Dedup-free, inversion-proof (per note).
  const _MAJOR_QUAL = ["I", "ii", "iii", "IV", "V", "vi", "vii"];
  const _DEGREE_MAP = {
    0: [0, ""], 2: [1, ""], 4: [2, ""], 5: [3, ""], 7: [4, ""], 9: [5, ""], 11: [6, ""],
    1: [1, "b"], 3: [2, "b"], 6: [3, "#"], 8: [5, "b"], 10: [6, "b"],
  };
  function degree(tonic, note) {
    const T = window.Tonal;
    const semis = ((T.Note.chroma(note) - T.Note.chroma(tonic)) % 12 + 12) % 12;
    const [idx, acc] = _DEGREE_MAP[semis];
    return acc + _MAJOR_QUAL[idx];
  }

  // For a voicing + key tonic (e.g. "C"), return the per-note degrees in playing
  // order, deduped to match pcNotes. Empty if no tonic or no notes.
  function intervalsInKey(voicing, tonic) {
    if (!tonic) return [];
    const T = window.Tonal;
    if (!T.Note.chroma(tonic) && tonic !== "C") {
      // tonic might be a chord/garbage; take just the note part
      const m = String(tonic).match(/^[A-Ga-g][#b]?/);
      if (!m) return [];
      tonic = m[0];
    }
    const seen = new Set(), out = [];
    voicingToNotes(voicing).forEach((n) => {
      const pc = n.replace(/[0-9]/g, "");
      if (seen.has(pc)) return;
      seen.add(pc);
      out.push(degree(tonic, n));
    });
    return out;
  }

  // Parse a name with chord-symbol (the ChordMark parser). Returns the result
  // object on success (with .normalized.notes), or null if not a valid ChordMark chord.
  function _parseChordmark(name) {
    const res = _parse(name);
    return res && !res.error ? res : null;
  }

  // Respell the root (and slash-bass) of a chord name to the chosen accidental,
  // leaving the quality/extensions untouched. e.g. "Bb7/D" -> "A#7/D" under sharp.
  function _respellName(name) {
    return name.replace(/^([A-G][#b]?)/, (_, r) => spell(r))
               .replace(/\/([A-G][#b]?)/, (_, b) => "/" + spell(b));
  }

  // Ranked names that are BOTH detected from the notes AND valid ChordMark chords.
  // Each entry: {name: <ChordMark string, respelled to current accidental>, raw}.
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
      const name = _respellName(_render(parsed)); // canonical, then respelled
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

  window.ChordNaming = {
    voicingToNotes, pcNotes, suggestNames, validateName, nameMatchesVoicing,
    setSpelling, getSpelling, spell, degree, intervalsInKey,
    setKeyTonic, getKeyTonic,
  };
})();
