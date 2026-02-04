# Chord Naming from Fingerings

## The Problem

Chord diagrams show **fingerings** (which frets to press). The chord **name** in the songsheet is often:
- Inconsistent across books
- Using non-standard notation
- Sometimes just wrong

## Proposed Solution

Use fingering as source of truth, derive name programmatically.

```
Fingering → Notes → Chord Name
```

### Step 1: Fingering → Notes

Deterministic based on guitar tuning (standard EADGBE):

```javascript
const tuning = ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'];

function fingeringToNotes(fingering, startFret = 0) {
  // fingering: "5x665x" (6 chars, low E to high e)
  // x = muted, 0 = open, n = fret number (relative to startFret if > 0)
  
  return fingering.split('').map((f, i) => {
    if (f === 'x') return null;
    const fret = parseInt(f) + (startFret > 0 ? startFret - 1 : 0);
    return noteAtFret(tuning[i], fret);
  }).filter(Boolean);
}

// Example: "5x665x" at fret 5
// → ['A', 'E', 'G#', 'C#'] → Amaj7
```

### Step 2: Notes → Chord Name

Use [chord-symbol](https://github.com/no-chris/chord-symbol) or similar library.

```javascript
import { chordParserFactory } from 'chord-symbol';

// Given notes, find matching chord
function notesToChordName(notes, bass = null) {
  // This is the hard part — see challenges below
}
```

## Challenges

### 1. Inversions
Same notes, different bass:
- `C E G` with C bass → C
- `C E G` with E bass → C/E
- `C E G` with G bass → C/G

Need to track which string is the bass note (lowest non-muted string).

### 2. Voicings / Doubled Notes
Guitar voicings often double notes or omit the 5th:
- `Amaj7` as `A C# E G#` — but voicing might have two A's
- Need to dedupe before analysis

### 3. Context / Enharmonic
- `G#` vs `Ab` — same pitch, different name depending on key
- May need key context to choose correct spelling

### 4. Extended Chords
- Is `C E G Bb D` a C9 or C7(add9)?
- Conventions vary

## Recommendation

1. **Phase 1:** Keep original chord names from songsheet + store fingering
2. **Phase 2:** Build validation — flag when fingering doesn't match expected chord
3. **Phase 3:** Auto-derive names, use original as hint/context

## Libraries

- [chord-symbol](https://github.com/no-chris/chord-symbol) — Parse/render chord symbols
- [tonal](https://github.com/tonaljs/tonal) — Music theory primitives (notes, intervals, chords)
- [Teoria](https://github.com/saebekassebil/teoria) — Another music theory library

## Related

- ChordMark extension for fingering notation (in progress by Arthur)
