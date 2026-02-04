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

- Input: PDF songbook
- Output: Individual PNG pages in `data/png/`
- Tool: `pdf2image` or `pdfimages`

## Stage 2: Vision Parse

**Script:** `scripts/parse_songsheet.py`

- Input: PNG image of songsheet
- Output: JSON in `data/json/`
- Tool: Vision model (Claude, Gemini, or GPT-4V)

The vision model extracts:
- Song title and metadata
- Chord definitions with fingerings
- Bar structure with lyrics and chord placements
- Confidence score and flags for unclear elements

## Stage 3: Human Review

- Review JSON files for errors
- Fix chord names, bar splits, fingerings
- Clear flags before proceeding

Optional: Web UI for faster review (future)

## Stage 4: Convert to ChordMark

**Script:** `scripts/json_to_chordmark.py`

- Input: Validated JSON
- Output: `.chordmark` file in `data/chordmark/`

## Cost Estimate

Vision parsing: ~$0.01-0.03 per page
For 200 songs: $2-6 total
