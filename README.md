# Songsheet Parser

Convert scanned songbook pages (chord charts with diagrams) into structured, machine-readable formats.

## Pipeline

```
PDF Songbooks → PNG Pages → Vision Parse → JSON → Review → ChordMark
                    ↓                         ↓
              (not committed)            (committed)
```

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

- **JSON** — Intermediate format for review/correction
- **[ChordMark](https://chordmark.netlify.app/)** — Encodes rhythm, lyrics, chord positions

## Usage

```bash
# Extract pages from PDF
python scripts/extract_pages.py songbook.pdf --output data/artist-name/png/

# Parse with vision model
python scripts/parse_songsheet.py data/artist-name/png/*.png --output data/artist-name/json/

# Review JSONs, fix errors...

# Convert to ChordMark
python scripts/json_to_chordmark.py data/artist-name/json/*.json --output data/artist-name/chordmark/
```

## Artists

- `joao-gilberto/` — João Gilberto songbook (in progress)

## License

Tool is open. Song data is for personal use only — original songsheets are copyrighted.
