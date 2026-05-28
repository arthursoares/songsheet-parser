# Songsheet Data Model Redesign

**Date:** 2026-05-28
**Status:** Approved design — ready for implementation planning
**Author:** Arthur Soares (with Claude)

## Problem

The current JSON model (`schemas/songsheet.schema.json`) does too much and fails at
the one thing that matters most: **anchoring chords to the text they sit over.**

It encodes chord placement three overlapping, mutually-disagreeing ways:

1. `bars[].chords: ["Dm7", null, null, null]` — a beat-grid where `null` means
   "previous chord continues."
2. `bars[].beats` — a separate rhythm count.
3. `bars[].chord_positions: [{chord, at_syllable}]` — the actual anchor, bolted on
   later by a second tool (`add_positions.py`).

The anchor — which matters most — is the *weakest* link: `at_syllable` is a string
resolved at ChordMark-generation time by substring search into the lyric line. When a
syllable repeats, the converter guesses "first occurrence." Meanwhile redundant rhythm
scaffolding (`chords` grid + `beats`) is treated as primary truth. The result: fuzzy
anchoring, three sources that can contradict, and a separate alignment stage that exists
only to patch the gap.

## Goal

The JSON serves three downstream consumers, in priority order:

1. **Clean ChordMark output** — the immediate goal: convert João Gilberto (and other)
   songbooks to ChordMark (Arthur's fork) or another structured format.
2. **Harmonic analysis** — ordered chords with key/section context.
3. **Faithful score reconstruction** — bars, sections, chord diagrams.

Across all three, the chord↔text anchor must be **intrinsic** (not a derived lookup),
and the author/parser must place as little as possible — **timing is the interpreter's
job, not the data's.**

## Source material reality (grounded in `data/joao-gilberto/pdf/1 - Chega de Saudade.pdf`)

The 28-page PDF is image scans (zero embedded text — vision parsing is the only route).
Observed on real pages:

- **Bar lines (ticks) are authoritative**; a system is divided into bars by vertical ticks.
- **Beats are never printed.** Duration is implied by horizontal spacing only.
- **A single chord frequently spans multiple bars** (page 1 moves in 2-bar harmonic
  blocks: `Gm7/9` over bars 1–2, `Dm7` over bars 3–4 → 8 beats each).
- **Multiple chords share one bar** (page 2, bar 4: `Em7` + `A13` split one 4/4 bar).
- **Instrumental bars** (intro) have chords but no lyrics.
- **Dashes in lyrics are pure spacing typography** ("Vai mi - nha" = *minha*), carry no
  musical meaning, and must be stripped.
- **Section labels are often absent** (no Verse/Chorus markers).
- **Adjacent chords sitting close together are a parsing trap**: the old model crammed
  two adjacent-bar chords into one bar. Bar ticks — not visual proximity — decide bar
  membership.

## Design

### Hierarchy

```
document               { title, source_pdf, page_count }
└── songs[]            { title, composers[], pages[], key, chords{}, sections[] }
    └── sections[]     { label, bars[] }
        └── bars[]     (each bar IS an array of chord entries)
            └── [ { chord, text? }, ... ]
```

A multi-song PDF is one `document` with many `songs`. This replaces the old
"one JSON per page + merge-by-normalized-title" hack.

### A bar is its chords (the core fix)

A bar is **literally an array of chord entries** — no wrapper object, no `events` key.
A chord entry is:

```json
{ "chord": "Dm7", "voicing": "x5756x", "text": "Vai mi nha" }
```

- `chord` (string, required) — the chord name, OR the **`%` continuation symbol**.
- `voicing` (string, optional) — the **per-occurrence** fingering for THIS placement
  (6 chars low-E→high-e, `x`/`0`/fret). See "Voicing is per-occurrence" below.
- `text` (string, optional) — the syllables sung from this chord's onset, **dashes
  stripped**, space-separated as sung. Omitted for instrumental/lyric-less chords.

**Order is the anchor.** The Nth chord in the bar aligns to the Nth `text` fragment.
No `at_syllable`, no substring search, no repeat ambiguity, no separate lyric line.

### Voicing is per-occurrence (not per-name)

The source draws a chord diagram **at each placement**, and the same chord name recurs
with **different voicings** within one song (confirmed in `13 - João.pdf`: e.g. `F69`
appears multiple times at different fret positions; layouts there routinely put two
chords — each with its own diagram — inside a single bar). Voicing is therefore a
property of the *occurrence*, not the name.

So `voicing` lives on the chord entry, traveling with the chord exactly where its diagram
is drawn. This maps 1:1 to Arthur's ChordMark fork's **inline voicing syntax**
`Dm7[x5756x]` (parser commit `93e775f`), so the converter emits inline voicings directly.

The song-level `chords` dict (below) becomes an **optional, generated convenience index**
(name → list of distinct voicings seen) for review/diagram-dictionary rendering — it is
NOT the source of truth for what is played, and is never hand-authored. The authoritative
voicing is always the one on the occurrence.

### The four cases, all in one uniform shape

**1. One chord fills a bar:**
```json
[ { "chord": "Dm7", "text": "Vai mi nha" } ]
```

**2. Chord continues across the bar line — `%` (measure-repeat / simile).**
This is *not* "hold" (the guitar keeps re-strumming the chord, it doesn't ring like a
piano). `%` is the standard lead-sheet measure-repeat sign.
```json
[ { "chord": "Dm7", "text": "Vai mi nha" } ],
[ { "chord": "%",   "text": "tris" } ]
```
→ `Dm7` sounds across both bars (8 beats in 4/4).

**3. Multiple chords in one bar — just list them. No durations.**
(Common in `13 - João.pdf`, where two chords — each with its own diagram — share a bar.)
```json
[ { "chord": "F69", "voicing": "1x321x", "text": "..." }, { "chord": "F7+5", "voicing": "1x322x", "text": "..." } ]
[ { "chord": "A" }, { "chord": "B" }, { "chord": "C" } ]
```
The **interpreter** distributes the bar's beats across the chords. The data never states
beats. (Uneven splits render as the interpreter's best distribution; if wrong, fix the
ChordMark output, not the JSON.)

**4. Instrumental bar (no lyrics):** omit `text`.
```json
[ { "chord": "Gm7/9" } ], [ { "chord": "%" } ]
```

### Chord dictionary — optional, generated index (NOT source of truth)

The source-of-truth voicing is always the per-occurrence `voicing` on the chord entry
(see "Voicing is per-occurrence" above). The song-level `chords` field is an **optional,
parser-generated** convenience index — name → the distinct voicings seen for that name —
used only for review and dictionary-style diagram rendering. It is never hand-authored and
never overrides an occurrence.

```json
"chords": {
  "F69":  [ { "voicing": "1x321x", "confidence": 0.7 }, { "voicing": "x8785x", "confidence": 0.6 } ],
  "Gm6":  [ { "voicing": "3x223x", "confidence": 0.7 } ]
}
```

- `voicing` (string) — 6 chars low-E→high-e, `x`/`0`/fret. May be wrong (vision model
  misreads fret markers); `confidence` flags low-trust diagrams for review.
- `confidence` (number 0–1, optional) — parser confidence in the diagram reading.

### What is deliberately NOT in the model

- **No `beats`/durations** anywhere — timing is interpreter-derived.
- **No `chord_positions` / `at_syllable`** — anchoring is intrinsic to entry order.
- **No `null` continuation grid** — `%` handles cross-bar continuation explicitly.
- **No pixel coordinates / bounding boxes** — no overlay-UI consumer needs them.
- **No sub-beat / off-beat-onset construct yet** — can be added later (a nested group
  mapping to ChordMark `[A B]`) if a real need appears; out of scope now.

## Worked example — page 1, first sung system

Source: `Dm7` over "Vai mi-nha" + "tris" (2 bars), `Bdim7` over "te-za e" + "di-za" (2 bars).

```json
"sections": [{
  "label": null,
  "bars": [
    [ { "chord": "Gm7/9",  "voicing": "3x332x" } ],
    [ { "chord": "%" } ],
    [ { "chord": "Dm7",    "voicing": "x5756x" } ],
    [ { "chord": "%" } ],
    [ { "chord": "Bdim7",  "voicing": "x7878x" } ],
    [ { "chord": "A#m6",   "voicing": "x1312x" } ],
    [ { "chord": "Dm7",    "voicing": "x5756x" } ],
    [ { "chord": "D#7/9-5", "voicing": "x67770" } ],
    [ { "chord": "Dm7",    "voicing": "x5756x", "text": "Vai mi nha" } ],
    [ { "chord": "%",                          "text": "tris" } ],
    [ { "chord": "Bdim7",  "voicing": "x7878x", "text": "te za e" } ],
    [ { "chord": "%",                          "text": "di za" } ]
  ]
}]
```
(Voicing strings above are illustrative — the parser fills the actual diagrams.)

Generated ChordMark — inline voicings on first occurrence, `_`-anchored lyric line,
`%` for continuation:
```
Gm7/9[3x332x] % Dm7[x5756x] %
Bdim7[x7878x] A#m6[x1312x] Dm7[x5756x] D#7/9-5[x67770]
Dm7[x5756x] %
_Vai mi nha _tris
Bdim7[x7878x] %
_te za e _di za
```

## Components to build / change

This spec covers three pieces (model + prompt + converter); the prompt is included
because the model is only as good as what fills it.

### 1. Schema — `schemas/songsheet.schema.json` (rewrite)

New JSON Schema for the document→songs→sections→bars(→chord array) hierarchy above.
A bar is an `array` of chord-entry objects. Validation:
- `chord` required on every entry; `%` is a legal value.
- `voicing` optional string; if present, 6 chars matching `^[0-9x]{6}$`.
- `text` optional string.
- a `%` entry should follow a bar that establishes a chord (validator flags an orphan
  `%` with no prior chord).
- `chords` index (if present) is optional and parser-generated; not required.

### 2. Stage-1 vision parse prompt — `scripts/parse_songsheet.py` (rewrite prompt + output shape)

The prompt must instruct the model to:
- Treat **bar ticks as authoritative** for bar boundaries — never group chords by visual
  proximity. (Two chords drawn close together may still be in separate bars.)
- Emit each bar as an ordered chord array, anchoring `text` per chord.
- Attach the diagram's fingering as that occurrence's `voicing` — **per placement**, since
  the same chord name recurs with different voicings.
- Use `%` when a chord continues into the next bar with no new chord struck.
- **Strip lyric dashes** (spacing only) and emit syllables as sung.
- Omit `text` for instrumental bars.

**`add_positions.py` is absorbed and removed** — anchoring is now intrinsic to stage 1,
so the separate alignment stage no longer exists.

### 3. ChordMark converter — `scripts/json_to_chordmark.py` (rewrite)

- Walk `songs → sections → bars`.
- Per bar: emit chords; a `%` entry → ChordMark `%`. Multiple chords in a bar → distribute
  the bar's beats across them (reuse existing proportional/largest-remainder logic) and
  emit dots accordingly.
- Emit each chord's `voicing` as **inline voicing** `Name[xxxxxx]` (Arthur's fork,
  commit `93e775f`), so per-occurrence voicings render correctly. Optionally also emit
  `chord <name> <voicing>` dictionary directives (no `#`, per the fork) from the generated
  index for diagram-dictionary rendering.
- Build the `_`-anchored lyric line from per-chord `text`.
- Multi-page songs already unified under one `song`, so no title-merge step.

## Migration

- The 32 existing per-page sample JSONs are in the old model and would be **re-parsed**
  under the new prompt, not converted in place.
- Old schema, `add_positions.py`, and the merge-by-title path in `json_to_chordmark.py`
  are retired.

## Open questions / future (out of scope)

- Sub-beat / off-beat onset construct (ChordMark `[A B]`) — add only when real data needs
  finer-than-bar onset precision.
- Fingering→notes→chord-name validation (`docs/chord-naming.md`) — independent effort.
