# Pipeline Architecture

## Overview

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   PDF       │────▶│   PNG       │────▶│   JSON      │────▶│  ChordMark  │
│  Songbook   │     │   Pages     │     │ Intermediate│     │   Output    │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
                          │                    │
                    (not committed)      (committed)
                                               │
                                         ┌─────▼─────┐
                                         │  Human    │
                                         │  Review   │
                                         └───────────┘
```

## Stage 1: Extract Pages

**Script:** `scripts/extract_pages.py`

```bash
python scripts/extract_pages.py input.pdf --output data/{artist}/png/
```

- Input: PDF songbook
- Output: Individual PNG pages
- Tool: `pdf2image` (requires poppler)

## Stage 2: Vision Parse

**Script:** `scripts/parse_songsheet.py`

```bash
python scripts/parse_songsheet.py data/{artist}/png/*.png --output data/{artist}/json/
```

- Input: PNG images of songsheets
- Output: JSON files (one per song)
- Tool: Vision model (Claude, Gemini, or GPT-4V)

The vision model extracts:
- Song title and metadata
- Chord definitions with fingerings (e.g., `x32010` for C)
- Bar structure with lyrics and chord placements
- Confidence score and flags for unclear elements

### Prompt Strategy

The vision prompt asks the model to:
1. Identify all chord diagrams and transcribe fingerings
2. Extract lyrics with chord positions
3. Determine bar/measure boundaries
4. Flag uncertain elements

## Stage 3: Human Review

- Review JSON files for errors
- Fix chord names, bar splits, fingerings
- Clear `_flags` before proceeding

Future: Web UI for faster review

## Stage 4: Convert to ChordMark

**Script:** `scripts/json_to_chordmark.py`

```bash
python scripts/json_to_chordmark.py data/{artist}/json/*.json --output data/{artist}/chordmark/
```

- Input: Validated JSON
- Output: `.chordmark` files

## Cost Estimate

Vision parsing: ~$0.01-0.03 per page (model dependent)
- Gemini Flash: cheapest
- Claude Sonnet: mid-range
- GPT-4V: most expensive

For 200 songs: $2-6 total
