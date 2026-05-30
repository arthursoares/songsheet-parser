# Songsheet Parser

Convert scanned songbook pages (chord charts with diagrams) into structured, machine-readable formats.

## Pipeline

```
PDF → extract_pages → PNG → parse_songsheet → JSON → [QA correction tool] → json_to_chordmark → ChordMark
                            (OpenAI vision)            (browser review/fix)
```

Chord↔lyric anchoring is intrinsic to the JSON (no separate alignment stage). Vision
extraction is imperfect (chord names, fingerings, lyrics), so a browser-based QA tool lets
you review each song beside its scan and correct it before converting.

## Structure

```
├── scripts/        # Processing pipeline
├── schemas/        # JSON validation schemas  
├── docs/           # Documentation
├── data/
│   └── {artist}/   # Per-artist organized
│       ├── json/       # Intermediate parsed data
│       └── chordmark/  # Final output files
└── analysis/       # Artist-specific analysis (future)
    └── {artist}/
```

## Supported Output

- **JSON** — Intermediate, chord-anchored format for review/correction. A document holds
  songs → sections → bars, where a bar is an ordered array of `{chord, voicing?, text?}`
  entries (entry order anchors each chord to its lyrics; `%` = chord continues; voicing is
  per-occurrence). See `docs/superpowers/specs/2026-05-28-songsheet-data-model-design.md`.
- **[ChordMark](https://chordmark.netlify.app/)** — Encodes rhythm, lyrics, chord positions.
  One `.chordmark` file is written per song.
- **Lead sheet / ChordPro** — the QA tool can also export a polished lead sheet (PDF/PNG/HTML) or
  a `.chordpro` file per song, plus a whole-album songbook PDF (see the QA tool section).

## Setup

```bash
python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt
codex login          # default vision provider uses your ChatGPT/Codex subscription
./.venv/bin/python -m pytest    # run the test suite
```

## Usage

Run scripts with the project venv (`./.venv/bin/python`).

```bash
# 1. Extract pages from a PDF (needs poppler, or pymupdf)
python scripts/extract_pages.py songbook.pdf --output data/<artist>/png/

# 2. Parse pages to chord-anchored JSON (default provider: codex / OpenAI gpt-5.5)
python scripts/parse_songsheet.py data/<artist>/png/*.png --output data/<artist>/json/

# 3. Convert JSON to ChordMark (one .chordmark per song)
python scripts/json_to_chordmark.py data/<artist>/json/ --output data/<artist>/chordmark/
```

### Validating a whole PDF

`validate_extraction.py` renders → parses → assembles a PDF's pages into songs, schema-validates,
and reports structural issues (per-page JSON is cached under a workdir for resumable runs):

```bash
python scripts/validate_extraction.py "data/<artist>/pdf/Album.pdf" \
  --workdir /tmp/ssv --report-json /tmp/report.json
```

### QA correction tool (browser)

Review each extracted song beside its scanned pages and fix chord names, fingerings, and lyrics.

```bash
# one-time: promote assembled docs into a per-song corpus with page images
python scripts/materialize_songs.py --workdir /tmp/ssv --out data/<artist>/songs

# launch the local review server, then open http://localhost:8000
python scripts/qa_server.py --songs data/<artist>/songs
```

The window has three columns: a **song-list sidebar** (left), the **scanned pages** (middle), and
the **editor tabs** (right).

The **sidebar** lists every song in the current album with a status badge, a search box, and a
status filter (All / Pending / In progress / Done). Click a song to load it (guarded by an
unsaved-changes confirm); the current song is highlighted. The sidebar footer shows the song's
**provenance** (source page numbers) and a free-text **per-song note** that persists with the song.

The right column has six tabs:

- **Bars** — chord chips in reading order, each showing name / voicing / a small chord-diagram
  thumbnail / notes / intervals. Click a chip to edit its **name**, **voicing** (clickable
  fretboard *or* type `x,5,7,5,6,x`), and **lyric**; **← →** move a chord to the adjacent bar.
  Reverse chord detection ([tonal.js](https://github.com/tonaljs/tonal)) suggests names,
  validated through ChordMark's parser ([chord-symbol](https://github.com/no-chris/chord-symbol));
  a red dot flags name↔voicing mismatches. Also supports **structural editing**: add/delete a bar,
  split/merge a bar, add/delete a section, and inline section-label rename.
- **Lyrics** *(prototype)* — a lyrics-first layout where each chord renders above its anchored
  syllable, per section. **Drag a chord token onto a different syllable to re-anchor it** (per-bar
  rebuild, wired into undo / dirty-state / Save). Known prototype limits: re-anchoring is scoped to
  **within a single bar** (cross-bar drops no-op), and syllable splitting is whitespace-based.
- **Review** — a worklist of the current song's flagged chords (name↔voicing mismatch or invalid
  name) with section·bar·reason. Click a row to jump to the chip and open its editor; a header
  **Next-flagged** action steps through them.
- **Dictionary** — the song's distinct chords grouped by (name + voicing), alphabetical or by
  count; batch-edit a chord across all its occurrences, or merge two groups that are the same
  chord misread two ways.
- **Preview** — renders the song (see below), with in-app export.
- **JSON** — a [CodeMirror 5](https://codemirror.net/5/) code editor over the song's raw JSON:
  Tab indents (2-space soft tabs), JSON syntax coloring, and live validation (parse errors show
  line/col plus a lint gutter marker). **Apply** parse-guards the text and pushes it onto the
  model (undoable); **Format** pretty-prints and **Reload** re-reads from the in-memory model.
  CodeMirror is vendored under `qa_static/vendor/codemirror/`.

Header controls: **key** selector (drives Roman-numeral interval analysis, major or minor),
**♯/♭** spelling toggle, per-song **status** (pending / in progress / done) with an album
progress count. **Save** writes schema-validated JSON back to disk. Edits support **undo/redo**,
and a dirty-state guard warns before navigating away or switching songs with unsaved edits.

**Keyboard shortcuts:** ⌘S/Ctrl+S save · Esc close editor · `n`/`p` next/previous song ·
`]` next-flagged chord · Enter applies in the chord editor · ⌘Z/Ctrl+Z undo · ⌘⇧Z/Ctrl+Y redo.

### Preview & export

The **Preview** tab renders a live view of the **current in-memory edits** (no Save required), in
either of two styles, by POSTing the document to `POST /api/render-doc?style=<fork|target>`:

- **fork** — through Arthur's ChordMark fork (inline diagrams, ChordMark layout); needs Node +
  the fork repo at `../chordmark/chord-mark`.
- **target** — a polished lead sheet (centered title, alphabetical diagram dictionary, two-column
  chord-over-syllable body, Roman fret positions, barres, `°` for diminished). Pure Python, no
  fork needed. Extra params: `dict=per_voicing|per_name`, `inline=0|1`, `bars=4|6|8`.

A **Source** toggle shows the generated `.chordmark` text (also for the current edits, via
`POST /api/chordmark-doc`) beside the render.

**In-app export** buttons (in the Preview tab) download the rendered song as **PDF, PNG, HTML,
.chordmark, or ChordPro**, plus **Export album → songbook PDF** for the whole album as one
document. PDF and PNG are produced by headless Chrome on the server (Google Chrome / Chromium must
be on `PATH`, or installed at the standard macOS location); a download shows an "Exported ✓" toast.

`scripts/render_chordmark.js` renders a `.chordmark` file to standalone HTML via the fork if you
want that path outside the server.

### Lyric hyphenation

Lyrics carry word-continuation dashes (`tris- te- za e`) for proper lead-sheet rendering. New
parses preserve the dashes the songbook prints; seed existing songs with:

```bash
python scripts/migrate_hyphenation.py data/<artist>/songs/   # LLM-seeded, idempotent
```

## Voicing format

A fingering is 6 comma-separated strings, low‑E→high‑e, each `x` (muted) or a fret number
**0–24**: `x,5,7,5,6,x`. The ChordMark converter renders these as inline voicings
(`Name[...]`, frets 10–24 → letters `a`–`o`) for Arthur's ChordMark fork.

## Artists

- `joao-gilberto/` — João Gilberto songbook (in progress)

## License

Tool is open. Song data is for personal use only — original songsheets are copyrighted.
