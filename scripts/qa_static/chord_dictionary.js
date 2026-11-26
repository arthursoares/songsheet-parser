// Per-song chord dictionary: pure functions over a song object (no DOM).
// A song is { sections: [ { bars: [ [ {chord, voicing?, text?}, ... ], ... ] } ] }.
// Grouping key is exact (chord name + voicing). "%" continuation entries are excluded.

(function () {
  function entryKey(chord, voicing) {
    return chord + " " + (voicing || "");
  }

  // Walk every chord occurrence; callback(entry, si, bi, ei).
  function eachOccurrence(song, cb) {
    (song.sections || []).forEach((sec, si) =>
      (sec.bars || []).forEach((bar, bi) =>
        bar.forEach((e, ei) => cb(e, si, bi, ei))));
  }

  // Build the dictionary: ordered list of groups, most frequent first.
  function buildDictionary(song) {
    const map = new Map();
    eachOccurrence(song, (e, si, bi, ei) => {
      if (!e.chord || e.chord === "%") return;
      const key = entryKey(e.chord, e.voicing);
      if (!map.has(key)) {
        map.set(key, { key, chord: e.chord, voicing: e.voicing || null, occurrences: [],
                       _printed: new Set() });
      }
      const g = map.get(key);
      g.occurrences.push({ si, bi, ei });
      if (e.voicing_printed) g._printed.add(e.voicing_printed);
    });

    const CN = (typeof window !== "undefined") && window.ChordNaming;
    const entries = [...map.values()].map((g) => {
      const { _printed, ...rest } = g;
      const v = g.voicing;
      const parsed = v ? v.split(",").map((t) => (t === "x" ? "x" : parseInt(t, 10))) : null;
      return {
        ...rest,
        count: g.occurrences.length,
        // the page's reading, when every occurrence in the group prints the same
        printed: _printed.size === 1 ? [..._printed][0] : null,
        notes: (CN && parsed) ? CN.pcNotes(parsed) : [],
        suggestions: (CN && parsed) ? CN.suggestNames(parsed).slice(0, 4) : [],
        nameMatchesVoicing: (CN && parsed) ? CN.nameMatchesVoicing(g.chord, parsed) : null,
      };
    });
    entries.sort((a, b) => b.count - a.count);
    return entries;
  }

  // Mutate every occurrence in group `key`, setting chord and/or voicing.
  // changes = {chord?, voicing?}. A voicing of "" or null deletes the voicing key.
  // Returns the number of occurrences changed.
  function applyEdit(song, key, changes) {
    let n = 0;
    eachOccurrence(song, (e) => {
      if (!e.chord || e.chord === "%") return;
      if (entryKey(e.chord, e.voicing) !== key) return;
      if ("chord" in changes && changes.chord) e.chord = changes.chord;
      if ("voicing" in changes) {
        if (changes.voicing) e.voicing = changes.voicing;
        else delete e.voicing;
      }
      n++;
    });
    return n;
  }

  // Validate a comma-separated 6-string voicing string ("x" or fret 0-24).
  // Blank ("") and all-muted ("x,x,x,x,x,x") normalize to "" (no voicing).
  function validateVoicing(raw) {
    const trimmed = String(raw ?? "").trim();
    if (!trimmed) return { valid: true, normalized: "" };
    const tokens = trimmed.split(",").map((t) => t.trim());
    if (tokens.length !== 6) {
      return { valid: false, error: "Voicing must be 6 comma-separated values (x or fret 0–24), or blank for none." };
    }
    const out = [];
    for (const tok of tokens) {
      if (tok === "x" || tok === "X") {
        out.push("x");
        continue;
      }
      if (!/^\d{1,2}$/.test(tok)) {
        return { valid: false, error: `Invalid voicing token "${tok}" (expected x or fret 0–24).` };
      }
      const fret = parseInt(tok, 10);
      if (fret < 0 || fret > 24) {
        return { valid: false, error: `Fret ${fret} out of range 0–24.` };
      }
      out.push(String(fret));
    }
    const joined = out.join(",");
    if (!/^(x|\d{1,2})(,(x|\d{1,2})){5}$/.test(joined)) {
      return { valid: false, error: "Invalid voicing format." };
    }
    const normalized = out.every((t) => t === "x") ? "" : joined;
    return { valid: true, normalized };
  }

  // Set chord+voicing on every occurrence across all groups in `keys` to the
  // canonical {chord, voicing}. Returns the number of occurrences changed.
  function mergeEntries(song, keys, canonical) {
    if (!canonical || !canonical.chord) return 0;
    const vc = validateVoicing(canonical.voicing);
    if (!vc.valid) return 0;
    const keySet = new Set(keys);
    let n = 0;
    eachOccurrence(song, (e) => {
      if (!e.chord || e.chord === "%") return;
      if (!keySet.has(entryKey(e.chord, e.voicing))) return;
      e.chord = canonical.chord;
      if (vc.normalized) e.voicing = vc.normalized;
      else delete e.voicing;
      n++;
    });
    return n;
  }

  const api = { buildDictionary, entryKey, eachOccurrence, applyEdit, mergeEntries, validateVoicing };
  if (typeof window !== "undefined") window.ChordDictionary = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
