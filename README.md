# João Gilberto Harmonic Analysis

Mapping the harmonic language of João Gilberto — his voicings, chord progressions, and substitution patterns.

## Goal

Create a model/algorithm of how João Gilberto harmonized songs. His specific chord voicings define bossa nova, and this project aims to systematically document and analyze them.

## Pipeline

```
PDF Songsheets → PNG Pages → Vision Parse → JSON → Review → ChordMark
                    ↓                         ↓
              (not committed)            (committed)
```

See [docs/pipeline.md](docs/pipeline.md) for details.

## Structure

```
├── docs/           # Documentation
├── schemas/        # JSON validation schemas
├── scripts/        # Processing pipeline
├── data/
│   ├── json/       # Intermediate parsed data
│   └── chordmark/  # Final output files
└── analysis/       # Pattern analysis (future)
```

## Output Format

Uses [ChordMark](https://chordmark.netlify.app/) for final representation — encodes rhythm, lyrics, and chord positions.

## Status

- [x] Proof of concept (2 songs manually converted)
- [ ] Pipeline scripts
- [ ] Batch processing
- [ ] Pattern analysis

## License

Analysis and derived data only. Original songsheets are copyrighted material and not included.
