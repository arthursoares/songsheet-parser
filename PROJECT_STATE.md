# Songsheet Parser — Project State

**Last updated:** 2026-02-04 23:43

## What This Is

A pipeline to digitize Brazilian songbook chord charts (PDF → JSON → ChordMark format). Built for Arthur's João Gilberto harmonic analysis project.

**Repos:**
- Pipeline: https://github.com/arthursoares/songsheet-parser (public)
- ChordMark fork: https://github.com/arthursoares/chord-mark (Arthur's fork with chord diagram rendering)

## Pipeline

```
PDF → extract_pages.py → PNGs
PNGs → parse_songsheet.py → JSON (via Gemini Flash vision)
JSON → add_positions.py → JSON with chord-syllable alignment (via Gemini Flash)
JSON → json_to_chordmark.py → .chordmark files with `chord` voicing directives + `_` position markers
```

## Current State

### ✅ Done
- Full pipeline working end-to-end
- 32 João Gilberto sample pages parsed → 10 merged songs
- `chord` directive syntax (not `#chord`) — matches Arthur's ChordMark fork parser
- Beat count compliance: dots = beat duration, proportional distribution, sub-beat `[A B]` grouping
- Two-stage hybrid chord-lyric alignment: focused per-bar vision queries for `_` position markers
- Tested on sample-11 + sample-13 (Não vou pra casa) — 100% success rate

### 🔄 In Progress
- Arthur reviewing JSON chord fingerings (vision model gets fret positions wrong — defaults to open position)
- Only 2 of 32 samples have position markers so far (need to run `add_positions.py` on all)

### 🔧 Known Issues
- 14 invalid chord names from vision model (`Bm7/Fe`→`Bm7/F#`, `Fdim?`→`Fdim7`, etc.) — needs manual correction in JSON
- Chord fingerings often incorrect (vision model misses fret position markers on diagrams)
- Some bars have more chords than beats → handled with sub-beat grouping but may need review

## Key Files

- `scripts/extract_pages.py` — PDF → PNG
- `scripts/parse_songsheet.py` — PNG → JSON (Gemini Flash default)
- `scripts/add_positions.py` — Adds chord-syllable alignment via focused vision queries
- `scripts/json_to_chordmark.py` — JSON → ChordMark with voicings + position markers
- `schemas/songsheet.schema.json` — JSON schema
- `docs/chord-naming.md` — Chord naming bridge (fingering → notes → chord-symbol)
- `data/joao-gilberto/json/` — Parsed JSON (32 pages)
- `data/joao-gilberto/chordmark/` — Converted ChordMark (10 songs)

## Source Images

⚠️ NOT in repo (copyright). Located at: `/root/clawd/output/songsheets/sample-{01..32}.png`

## Key Decisions

- **Gemini Flash** as default: 16x faster, 10x cheaper than GPT-4o
- **JSON as intermediate layer** for human review/correction before ChordMark conversion
- **Fingering as source of truth** — chord names derived from fingerings
- **`chord` directive** (no `#` prefix) matches Arthur's ChordMark fork parser
- **Two-stage hybrid** for alignment: reliable bar parsing + focused per-bar position queries

## Arthur's ChordMark Fork

At `/root/clawd/projects/chord-mark/` — adds:
- `chord Cmaj7 x32000` directive for voicing definitions
- Inline `Cmaj7[x35453]` syntax
- SVG chord diagram renderer (dictionary + inline modes)
- Built with yarn, 1376 tests pass

## Next Steps

1. Run `add_positions.py` on all 32 samples
2. Arthur reviews/corrects chord fingerings in JSON files
3. Re-run `json_to_chordmark.py` after corrections
4. Test rendered output with Arthur's chord-mark fork
5. Implement chord name validation (fingering → notes → chord-symbol library)
6. Process additional songbooks
