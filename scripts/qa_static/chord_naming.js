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

  // Global key for interval analysis, full string incl. mode (e.g. "C" or "Dm");
  // "" = none. Set by the app.
  let _key = "";
  function setKeyTonic(k) { _key = k || ""; }
  function getKeyTonic() { return _key; }

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

  // Per-string note name for each of the 6 strings, "x" for muted/unplayed.
  // Aligns 1:1 with the voicing array (no dedup). Uses current flat/sharp spelling.
  function perStringNotes(voicing) {
    return voicing.map((f, i) => {
      if (f === "x" || f === null || f === undefined) return "x";
      return spell(window.Tonal.Midi.midiToNoteName(TUNING_MIDI[i] + Number(f),
        { pitchClass: false }));
    });
  }

  // Roman-numeral scale degree of one note relative to a key tonic + mode.
  // Case reflects the diatonic triad quality of the mode; chromatic notes get a
  // flat/sharp prefix. Inversion-proof (computed per note from the tonic).
  // Major:        I  ii  iii IV V  vi  vii        (scale 0 2 4 5 7 9 11)
  // Minor (nat.): i  ii° III iv v  VI  VII         (scale 0 2 3 5 7 8 10)
  const _QUAL = {
    major: ["I", "ii", "iii", "IV", "V", "vi", "vii"],
    minor: ["i", "ii°", "III", "iv", "v", "VI", "VII"],
  };
  // semitone-from-tonic -> [degree index, accidental]
  const _DEGREE_MAP = {
    major: {
      0: [0, ""], 2: [1, ""], 4: [2, ""], 5: [3, ""], 7: [4, ""], 9: [5, ""], 11: [6, ""],
      1: [1, "b"], 3: [2, "b"], 6: [3, "#"], 8: [5, "b"], 10: [6, "b"],
    },
    minor: {
      0: [0, ""], 2: [1, ""], 3: [2, ""], 5: [3, ""], 7: [4, ""], 8: [5, ""], 10: [6, ""],
      1: [1, "b"], 4: [2, "#"], 6: [3, "#"], 9: [5, "#"], 11: [6, "#"],
    },
  };
  function degree(tonic, note, mode) {
    const T = window.Tonal;
    mode = mode === "minor" ? "minor" : "major";
    const semis = ((T.Note.chroma(note) - T.Note.chroma(tonic)) % 12 + 12) % 12;
    const [idx, acc] = _DEGREE_MAP[mode][semis];
    return acc + _QUAL[mode][idx];
  }

  // Parse a key string into {tonic, mode}. "Dm"/"Dmin"/"D minor" -> minor; "D" -> major.
  // Returns null if no usable tonic note can be found.
  function parseKey(key) {
    if (!key) return null;
    const m = String(key).match(/^([A-Ga-g][#b]?)\s*(m(?!aj)|min|minor|-)?/);
    if (!m) return null;
    const tonic = m[1][0].toUpperCase() + m[1].slice(1);
    return { tonic, mode: m[2] ? "minor" : "major" };
  }

  // Per-string scale degrees, "x" for muted. Aligns 1:1 with the voicing.
  function perStringInKey(voicing, key) {
    const parsed = parseKey(key);
    if (!parsed) return [];
    return voicing.map((f, i) => {
      if (f === "x" || f === null || f === undefined) return "x";
      const note = window.Tonal.Midi.midiToNoteName(TUNING_MIDI[i] + Number(f), { pitchClass: false });
      return degree(parsed.tonic, note, parsed.mode);
    });
  }

  // Parse a name with chord-symbol (the ChordMark parser). Returns the result
  // object on success (with .normalized.notes), or null if not a valid ChordMark chord.
  function _parseChordmark(name) {
    const res = _parse(name);
    return res && !res.error ? res : null;
  }

  // Interval shorthand for each semitone distance from a chord root (numeric +
  // accidentals). Upper structure prefers extension labels (9/11/13).
  const _CHORD_INTERVAL = {
    0: "1", 1: "b9", 2: "9", 3: "b3", 4: "3", 5: "11",
    6: "b5", 7: "5", 8: "b13", 9: "13", 10: "b7", 11: "7",
  };
  // Within the basic triad/7th range some semitones read better as the lower form.
  const _CHORD_INTERVAL_BASIC = { 1: "b2", 2: "2", 5: "4", 8: "#5", 9: "6" };

  // Per-string chord intervals, "x" for muted. Aligns 1:1 with the voicing.
  function perStringChordIntervals(voicing, chordName, upper = true) {
    if (!chordName || chordName === "%") return [];
    const parsed = _parseChordmark(chordName);
    const root = parsed && parsed.normalized && parsed.normalized.rootNote;
    if (!root) return [];
    const T = window.Tonal;
    const map = upper ? _CHORD_INTERVAL : { ..._CHORD_INTERVAL, ..._CHORD_INTERVAL_BASIC };
    return voicing.map((f, i) => {
      if (f === "x" || f === null || f === undefined) return "x";
      const note = T.Midi.midiToNoteName(TUNING_MIDI[i] + Number(f), { pitchClass: false });
      const semis = ((T.Note.chroma(note) - T.Note.chroma(root)) % 12 + 12) % 12;
      return map[semis];
    });
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
    pcNotes, suggestNames, validateName, nameMatchesVoicing,
    setSpelling, getSpelling, parseKey, setKeyTonic, getKeyTonic,
    perStringNotes, perStringInKey, perStringChordIntervals,
  };
})();
