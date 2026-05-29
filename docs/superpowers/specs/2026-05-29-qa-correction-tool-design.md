# Songsheet QA / Correction Tool — Design

**Date:** 2026-05-29
**Status:** Approved design — ready for implementation planning
**Author:** Arthur Soares (with Claude)

## Problem

Vision extraction (gpt-5.5 via Codex) produces a chord-anchored song model, but full-corpus
validation showed real accuracy gaps that only a human can fix: misread chord names, wrong
fingerings/voicings, and lyric-anchoring errors. There is no way to review the extracted data
against the source page and correct it. We need a manual QA pass: a tool to inspect each song
side-by-side with its scanned pages and correct chords voicing-by-voicing.

## Goal

A local browser tool, launched from the project venv, that lets Arthur:
- See a song's scanned page images beside its extracted data.
- Click any chord and correct its **name**, **voicing/fingering**, and **anchored lyric text**.
- Get **chord-name suggestions** from a fingering (reverse lookup) and a **name↔voicing
  consistency check**, to fix the most common error (misread voicings/names).
- Save corrections back to a durable per-song JSON file (schema-validated).

This is a correctness/review tool, not an authoring tool — bar structure editing and ChordMark
playback are explicitly out of scope for v1.

## Architecture

A small **local Python server** + a **browser UI**, launched with
`./.venv/bin/python scripts/qa_server.py` → `http://localhost:8000`.

```
scripts/qa_server.py        # stdlib http.server — no new Python deps
  GET  /                              → serves the browser app (qa_static/index.html)
  GET  /api/albums                    → list albums + songs from the songs/ corpus
  GET  /api/song/{album}/{file}       → one song's JSON document
  GET  /api/page/{album}/{file}/{n}   → that song's page image (PNG) n
  POST /api/song/{album}/{file}       → schema-validate, then write JSON back to disk
scripts/qa_static/
  index.html, app.js, fretboard.js
  vendor/tonal.min.js                 # vendored, browser-side reverse chord detection
scripts/materialize_songs.py          # one-time: promote /tmp scratch → committed corpus
```

- **Server is a thin data/file layer.** It serves song JSON + page PNGs and accepts validated
  saves. It runs no music logic. On POST it re-validates against
  `schemas/songsheet.schema.json` (incl. the decimal voicing rule) and refuses to write invalid
  data, returning the validation error to the UI.
- **All music logic is browser-side** (tonal.js): voicing→pitches→chord detection, and the
  name↔voicing consistency badge. No server round-trip when editing a voicing.
- **No new Python dependencies** — stdlib `http.server` + the existing `jsonschema`/`fitz`.

## On-disk layout & the materialize step

The new chord-anchored corpus currently exists only as scratch
(`/tmp/ssv/<pdf-stem>/_assembled.json`). A new script **`scripts/materialize_songs.py`**
promotes it into a durable, committed, self-contained per-song structure that the QA tool
reads and writes:

```
data/joao-gilberto/songs/
  <album-slug>/                          # e.g. 01-chega-de-saudade
    <NN>-<song-slug>.json                # one document-song; NN = track order
    pages/
      <NN>-<song-slug>-p<page>.png       # the source page images for that song
```

`materialize_songs.py`:
1. Reads each `/tmp/ssv/<stem>/_assembled.json`.
2. Splits it into per-song documents (track number from order, slug from normalized title).
3. Copies that song's page PNGs (already rendered under `/tmp/ssv/<stem>/`) into `pages/`.
4. Writes the song JSON. Each song JSON keeps its `pages` list; the QA tool shows exactly
   those images.

After materialization, `data/joao-gilberto/songs/` is the canonical corpus. `/tmp` stays
disposable. (Re-running extraction + materialize overwrites; corrections live in git history.)

## Save contract

`POST /api/song/{album}/{file}` with the full song JSON:
- Validate against `schemas/songsheet.schema.json` (document/song shape + decimal voicing
  pattern + 0–24 fret range).
- On success: write the file in place, return `{ok: true}`.
- On failure: do **not** write; return `{ok: false, error: "<validation message>"}` which the
  UI surfaces inline.
- **JSON only** — saving does not regenerate `.chordmark` (that stays a separate
  `json_to_chordmark.py` step).

## Browser UI (Section 4)

Side-by-side, **song-at-a-time**:

- **Top bar:** album picker, song picker, "N chords flagged" count, Save button, save status.
- **Left column:** the song's page PNGs stacked and scrollable (multi-page songs show all
  their pages, captioned `page N of M`).
- **Right column:** the song's bars in reading order. Each chord entry is a clickable chip
  showing **name / decimal voicing / anchored lyric**. A `%` continuation renders as a distinct
  chip. A chip with a name↔voicing mismatch (or other flag) shows a warning dot.
- **Edit panel** (opens on chip click), three editable fields:
  1. **Chord name** — text input. A live badge shows green "matches voicing" or red
     "name ≠ voicing (<detected>?)" using tonal.js detection on the current voicing.
  2. **Anchored lyric** — text input.
  3. **Voicing — dual-mode, two-way bound:**
     - A **vertical chord diagram** (6 vertical string lines low E→high e, horizontal fret
       rows, starting-fret number at the side, ×/○ markers on top per string). Click a cell to
       fret a string; click a set dot to clear it; click the top marker to toggle mute/open;
       −/+ shifts the fret window for up-the-neck chords.
     - A **decimal voicing text field** (`x,6,8,6,7,6`) editable directly; on change it parses,
       validates (exactly 6 tokens, each `x` or fret 0–24), and redraws the diagram (auto-fitting
       the window). Invalid input shows an inline error and does not apply.
     - Grid edits update the text field and vice-versa — one source of truth.
  4. **Chord-finder:** ranked tonal.js `Chord.detect()` suggestions computed from the voicing's
     pitches (standard tuning EADGBE; lowest sounding string = bass for slash chords). Click a
     suggestion to set the name, or keep a manually typed name.
  - **Apply** updates the in-memory song; **Save song** persists via POST.

**v1 scope guards (explicitly deferred):** no bar add/remove/split/merge, no `%`/structure
editing, no ChordMark rendering or playback, no audio.

## Reverse chord detection + ChordMark validation

Two libraries, each authoritative for its half:

**1. tonal.js (vendored `vendor/tonal.min.js`) — detection / suggestions.** Confirmed by
research as a drop-in notes→name capability (handles inversions/slash chords). Pipeline:
`decimal voicing → per-string MIDI/pitch via standard tuning + fret offset → dedupe pitch
classes → Chord.detect(pitches, {assumeBass: lowestString}) → ranked candidate names`.

**2. chord-symbol — ChordMark validation/normalization (REQUIRED).** Every candidate name
from tonal AND every name the user types/accepts must be passed through **`chord-symbol`**
(`chordParserFactory` — the exact parser Arthur's ChordMark fork uses; see
`chord-mark/src/parser/parseChord.js`). This guarantees the QA tool only ever writes chord
names that ChordMark will parse and render, and normalizes them to ChordMark's canonical form.
Concretely:
- **Suggestions:** each tonal candidate is run through `chord-symbol`; show the normalized
  (parseable) form, and drop/flag any candidate `chord-symbol` rejects. So the suggestion list
  is "names that are both musically correct AND valid ChordMark."
- **Manual names:** when the user types a name, parse it with `chord-symbol`; if it fails, show
  an inline "not a valid ChordMark chord" error (this is exactly what catches the nonstandard
  book notation like `A13,9`, `E79`, `Dø`, steering the user to a valid equivalent).
- **Consistency badge:** compare the typed name's pitch set (from `chord-symbol` name→notes)
  against the voicing's pitch set (from tonal); green if they match, red with the detected
  alternative otherwise.

`chord-symbol` is already a dependency of the ChordMark fork; vendor its browser build alongside
tonal so both run client-side with no server round-trip. Net effect: detection (tonal) →
ChordMark-validation/normalization (chord-symbol) → only valid, canonical names reach the JSON.

## Components to build

1. `scripts/materialize_songs.py` — promote scratch assembled docs → committed per-song corpus
   with page images. (Depends on a completed validation run providing `_assembled.json`.)
2. `scripts/qa_server.py` — stdlib HTTP server: list/get/save songs, serve page images,
   schema-validate on save.
3. `scripts/qa_static/` — browser app:
   - `index.html` — layout (top bar, two columns, edit panel).
   - `app.js` — load albums/songs, render bars+chips, edit panel, save.
   - `fretboard.js` — the dual-mode vertical-diagram + decimal-text voicing editor (two-way
     bound, 0–24 validation).
   - `chord_naming.js` — wraps tonal (detect) + chord-symbol (validate/normalize) into
     `suggestNames(voicing)` and `validateName(name)` used by the edit panel.
   - `vendor/tonal.min.js` — reverse chord detection (notes→name).
   - `vendor/chord-symbol.min.js` — ChordMark-grade chord parse/normalize (validation).

## Non-goals / future

- Bar-structure editing, `%` editing, section relabeling.
- ChordMark generation/playback inside the tool.
- Continuation-song re-merging (the validation found split songs, e.g. "Brigas, nunca mais" vs
  running header — a separate assembler/materialize concern, not the QA UI).
- Multi-user / auth (single local user).

## Dependencies / ordering

- Requires the decimal-voicing format decision (`schemas/songsheet.schema.json` pattern
  `^(x|\d{1,2})(,(x|\d{1,2})){5}$`, frets 0–24) — see the voicing-encoding work; the QA tool's
  validation and editor assume that format.
- Requires materialized per-song corpus, which depends on a completed extraction/validation run.
