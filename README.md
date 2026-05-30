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

In the browser, pick an album + song; the scan shows on the left and three tabs on the right:

- **Bars** — chord chips in reading order, each showing name / voicing / a small chord-diagram
  thumbnail / notes / intervals. Click a chip to edit its **name**, **voicing** (clickable
  fretboard *or* type `x,5,7,5,6,x`), and **lyric**; **← →** move a chord to the adjacent bar.
  Reverse chord detection ([tonal.js](https://github.com/tonaljs/tonal)) suggests names,
  validated through ChordMark's parser ([chord-symbol](https://github.com/no-chris/chord-symbol));
  a red dot flags name↔voicing mismatches.
- **Dictionary** — the song's distinct chords grouped by (name + voicing), alphabetical or by
  count; batch-edit a chord across all its occurrences, or merge two groups that are the same
  chord misread two ways.
- **Preview** — renders the song two ways (see below).

Header controls: **key** selector (drives Roman-numeral interval analysis, major or minor),
**♯/♭** spelling toggle, per-song **status** (pending / in progress / done) with an album
progress count. **Save** writes schema-validated JSON back to disk.

### Preview & export

The **Preview** tab renders the *saved* song (re-renders on Save) in either of two styles, via
`GET /api/render/<album>/<file>?style=<fork|target>`:

- **fork** — through Arthur's ChordMark fork (inline diagrams, ChordMark layout); needs Node +
  the fork repo at `../chordmark/chord-mark`.
- **target** — a polished lead sheet (centered title, alphabetical diagram dictionary, two-column
  chord-over-syllable body, Roman fret positions, barres, `°` for diminished). Pure Python, no
  fork needed. Extra params: `dict=per_voicing|per_name`, `inline=0|1`.

**Exporting a render** (no in-app button yet — use the browser):

```bash
# open the render URL directly, then ⌘P → Save as PDF (target CSS is A4-ready):
open "http://localhost:8000/api/render/<album>/<file>?style=target"

# or screenshot to PNG headlessly:
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless \
  --screenshot=song.png --window-size=900,1300 \
  "http://localhost:8000/api/render/<album>/<file>?style=target"
```

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
