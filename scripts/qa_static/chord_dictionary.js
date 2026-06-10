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

  // Set chord+voicing on every occurrence across all groups in `keys` to the
  // canonical {chord, voicing}. Returns the number of occurrences changed.
  function mergeEntries(song, keys, canonical) {
    const keySet = new Set(keys);
    let n = 0;
    eachOccurrence(song, (e) => {
      if (!e.chord || e.chord === "%") return;
      if (!keySet.has(entryKey(e.chord, e.voicing))) return;
      e.chord = canonical.chord;
      if (canonical.voicing) e.voicing = canonical.voicing;
      else delete e.voicing;
      n++;
    });
    return n;
  }

  const api = { buildDictionary, entryKey, eachOccurrence, applyEdit, mergeEntries };
  if (typeof window !== "undefined") window.ChordDictionary = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
