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

In the browser: pick an album + song; the scan shows on the left, editable chord chips on the
right. Click a chord to fix its **name**, **voicing** (clickable fretboard *or* type
`x,5,7,5,6,x`), and **lyric**. Reverse chord detection ([tonal.js](https://github.com/tonaljs/tonal))
suggests names, validated through ChordMark's parser
([chord-symbol](https://github.com/no-chris/chord-symbol)); a badge flags name↔voicing
mismatches. **Save** writes schema-validated JSON back to disk.

## Voicing format

A fingering is 6 comma-separated strings, low‑E→high‑e, each `x` (muted) or a fret number
**0–24**: `x,5,7,5,6,x`. The ChordMark converter renders these as inline voicings
(`Name[...]`, frets 10–24 → letters `a`–`o`) for Arthur's ChordMark fork.

## Artists

- `joao-gilberto/` — João Gilberto songbook (in progress)

## License

Tool is open. Song data is for personal use only — original songsheets are copyrighted.
