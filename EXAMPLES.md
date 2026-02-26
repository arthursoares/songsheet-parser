# Position Marker Examples

Visual examples of the two-stage hybrid alignment in action.

---

## Example 1: Bar 7 from "Não vou pra casa" (sample-11)

### Source JSON (after Stage 1)
```json
{
  "lyrics": "um a-mor a- en tao nao vou pra ca",
  "chords": ["Bmaj7", null, "Fdim7", null],
  "beats": 4
}
```

### Enhanced JSON (after Stage 2)
```json
{
  "lyrics": "um a-mor a- en tao nao vou pra ca",
  "chords": ["Bmaj7", null, "Fdim7", null],
  "beats": 4,
  "chord_positions": [
    {"chord": "Bmaj7", "at_syllable": "um"},
    {"chord": "Fdim7", "at_syllable": "en"}
  ]
}
```

### ChordMark Output
```
Bmaj7.. Fdim7..
_um a-mor a- _en tao nao vou pra ca
```

**Interpretation:**
- `Bmaj7` strikes at syllable "um" (marked with `_um`)
- `Fdim7` strikes at syllable "en" (marked with `_en`)

---

## Example 2: Bar 9 - Three Chord Changes! (sample-11)

### Enhanced JSON
```json
{
  "lyrics": "nao vou So vou pra ca sa",
  "chords": ["Bmaj7", null, "F#7+5", null],
  "beats": 4,
  "chord_positions": [
    {"chord": "Bmaj7", "at_syllable": "nao"},
    {"chord": "F#7+5", "at_syllable": "So"},
    {"chord": "F#7+5", "at_syllable": "ca"}
  ]
}
```

### ChordMark Output
```
Bmaj7.. F#7+5..
_nao vou _So vou pra _ca sa
```

**Interpretation:**
- `Bmaj7` strikes at "nao"
- First `F#7+5` at "So"
- Second `F#7+5` at "ca" (chord continues but changes rhythm)

---

## Example 3: Bar 2 - Complex Syllables (sample-11)

### Enhanced JSON
```json
{
  "lyrics": "que dei xa a gen te can-sa do",
  "chords": ["G#7", null, "C#m7/G#", null],
  "beats": 4,
  "chord_positions": [
    {"chord": "G#7", "at_syllable": "que"},
    {"chord": "C#m7/G#", "at_syllable": "gen"}
  ]
}
```

### ChordMark Output
```
G#7.. C#m7/G#..
_que dei xa a _gen te can-sa do
```

**Interpretation:**
- `G#7` strikes at first syllable "que"
- `C#m7/G#` strikes at "gen" (middle of phrase)
- Notice hyphenated syllables "can-sa" work correctly

---

## Example 4: Bar Without Positions (no multiple chords)

### JSON (Stage 1 only)
```json
{
  "lyrics": "de ba tu- car",
  "chords": ["F#7", null, null, null],
  "beats": 4
}
```

### ChordMark Output
```
F#7
de ba tu- car
```

**No position markers needed** - single chord holds entire bar.

---

## Why Position Markers Matter

### Without Markers (ambiguous)
```
Bmaj7.. Fdim7..
um a-mor a- en tao nao vou pra ca
```

**Problem:** Where does Fdim7 start? Could be:
- At "a-" (beat 2)?
- At "en" (beat 3)?
- At "tao" (beat 4)?

### With Markers (precise)
```
Bmaj7.. Fdim7..
_um a-mor a- _en tao nao vou pra ca
```

**Clear:** Bmaj7 at "um", Fdim7 at "en" - no ambiguity!

---

## Edge Cases Handled

### Syllable appears multiple times
```json
{
  "lyrics": "nao vou nao vou nao",
  "chord_positions": [
    {"chord": "Am", "at_syllable": "nao"},
    {"chord": "G", "at_syllable": "vou"}
  ]
}
```
→ Uses **first occurrence** of each syllable: `_nao _vou nao vou nao`

### Syllable with hyphen
```json
{
  "lyrics": "can-sa do",
  "chord_positions": [
    {"chord": "Dm", "at_syllable": "can"}
  ]
}
```
→ Finds "can" in "can-sa": `_can-sa do`

### Syllable not found (graceful degradation)
```json
{
  "lyrics": "sa nao se nhor",
  "chord_positions": [
    {"chord": "C", "at_syllable": "ca"}  // OCR mismatch
  ]
}
```
→ Skips position marker, outputs lyrics unchanged: `sa nao se nhor`

---

## Full Song Example

**Sample 11: "Não vou pra casa" - First verse**

```
chord Bmaj7 x21332
chord G#7 464544
chord C#m7/G# 442454
chord F#7 242322
chord Fdim7 121212
chord C#m7 442454
chord F#7+5 232332
chord Bmaj9 x21322

Bmaj7
rit ma do

G#7.. C#m7/G#..
_que dei xa a _gen te can-sa do

F#7
de ba tu- car

G#7.. C#m7/G#..
mas se _na ro _da de sam

Bmaj7.. Fdim7..
_um a-mor a- _en tao nao vou pra ca

C#m7.. F#7+5..
sa nao _se nhor nao vou

Bmaj7.. F#7+5..
_nao vou _So vou pra _ca sa

Bmaj9.. Fdim7..
_quan-do o _dia a cla re ar
```

**Result:** Playable ChordMark file with precise chord-syllable alignment! 🎵
