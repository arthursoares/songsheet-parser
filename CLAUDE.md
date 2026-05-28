# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A pipeline that digitizes Brazilian songbook chord charts (built for a João Gilberto
harmonic-analysis project) into machine-readable formats:

```
PDF → extract_pages.py → PNG → parse_songsheet.py → JSON → json_to_chordmark.py → .chordmark
                                  (OpenAI vision)
```

JSON is the **intermediate review layer** — it is committed and meant to be hand-corrected
before conversion. PNG/PDF sources are **not** committed (copyright; see `.gitignore`).

The data model is **chord-anchored** (see `docs/superpowers/specs/2026-05-28-songsheet-data-model-design.md`):
chord↔text alignment is intrinsic to the JSON, so there is no separate alignment stage.

## Commands

Scripts are `argparse` CLIs under `scripts/`. Run with the project venv: `./.venv/bin/python scripts/...`.
Tests: `./.venv/bin/python -m pytest` (schema + render + CLI).

```bash
# Stage 1 — PDF to PNG pages (page-001.png, ...). Needs poppler.
python scripts/extract_pages.py songbook.pdf --output data/<artist>/png/ [--dpi 200]

# Stage 2 — PNG to JSON via vision model. Default provider is codex (OpenAI gpt-5.5).
#   Emits the chord-anchored document model directly (anchoring is intrinsic; no later stage).
python scripts/parse_songsheet.py data/<artist>/png/*.png --output data/<artist>/json/ \
  [--provider codex|claude|gemini|openai] [--model NAME] [--dry-run]

# Stage 3 — JSON document → one .chordmark per song.
python scripts/json_to_chordmark.py data/<artist>/json/ --output data/<artist>/chordmark/
```

Single page end-to-end: render a PNG, run stage 2 then stage 3.

### Setup & auth

```bash
python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt
brew install poppler                      # for extract_pages.py
codex login                               # creates ~/.codex/auth.json (for default provider)
```

Default vision provider is **`codex`**: OpenAI models (default `gpt-5.5`) reached through your
**ChatGPT/Codex subscription**, *not* a paid `OPENAI_API_KEY`. `scripts/codex_client.py`
borrows the OAuth token from `~/.codex/auth.json`, auto-refreshes it, and calls the Codex
backend (`chatgpt.com/backend-api/codex`) via the Responses API with image input. Smoke-test
auth + vision with `./.venv/bin/python scripts/codex_client.py`.

Fallback providers need their own keys: `--provider gemini` → `GEMINI_API_KEY` (+ install
`google-generativeai`), `--provider claude` → `ANTHROPIC_API_KEY`, `--provider openai` (paid
api.openai.com) → `OPENAI_API_KEY`.

## Architecture: chord-anchored model

`scripts/parse_songsheet.py` does the whole extraction in one vision pass; `scripts/chordmark_render.py`
(pure, I/O-free) turns the model into ChordMark and `scripts/json_to_chordmark.py` is a thin CLI over it.
The model (full reference: `docs/superpowers/specs/2026-05-28-songsheet-data-model-design.md`):

```
document → songs[] → sections[] → bars[]
```

- **A bar IS an ordered array of chord entries** — `[{ "chord", "voicing"?, "text"? }, ...]`. There is
  no wrapper object and no beat-grid. **Entry order is the chord↔text anchor** — the Nth chord aligns to
  the Nth `text` fragment. No `at_syllable`, no substring lookup.
- **`chord: "%"`** = measure-repeat: the previous chord keeps playing into this bar (not a piano "hold" —
  the guitar re-strums). This is how a chord spanning multiple bars is expressed.
- **`voicing` is per-occurrence** (6 chars, low-E first) — the same chord name recurs with different
  diagrams, so voicing lives on the entry, rendered as inline `Name[xxxxxx]` in ChordMark.
- **`text`** = syllables sung from that chord's onset, source dashes stripped. Omitted for instrumental bars.
- **No durations in the JSON** — timing is interpreter-derived. `chordmark_render.render_chord_line`
  distributes a bar's beats across its chords (largest-remainder, earliest-wins) and emits `.` dots.
- **`chords`** (per song) is an optional, parser-*generated* index `name → [{voicing, confidence}]` — a
  convenience for dictionary rendering, never source of truth.

## Conventions that bite

- **`chord` directive, not `#chord`.** ChordMark output uses bare `chord <Name> <voicing>` dictionary
  lines and inline `Name[xxxxxx]` voicings — both match Arthur's ChordMark fork
  (https://github.com/arthursoares/chord-mark), not upstream. The fork's parser models a chord as
  `{model, duration, beat, isInSubBeatGroup}` and uses `%` for bar-repeat and `[A B]` for sub-beat groups.
- **Don't reintroduce `beats`/durations into the JSON.** Timing is the converter's job by deliberate
  design — placement-only data, interpreter derives rhythm.
- **Voicing is per-occurrence, never per-name.** Don't collapse to one voicing per chord name.
- **`render_*` functions are pure.** Keep `scripts/chordmark_render.py` free of file/network I/O so it
  stays unit-testable; `json_to_chordmark.py` is the only file that touches disk.
- **The `codex` provider is a subscription backdoor, not the public OpenAI API.**
  `scripts/codex_client.py` reads `~/.codex/auth.json` (`auth_mode: chatgpt`), refreshes the
  OAuth token against `auth.openai.com`, and hits `chatgpt.com/backend-api/codex` with the
  **Responses API** (`client.responses.create`, `store=False`, streaming). Images go as
  `input_image` parts. This mirrors Simon Willison's `llm-openai-via-codex`. If it breaks
  after an OpenAI change, that endpoint/format is the first suspect; `--provider gemini` is
  the fallback. Available model slugs come from your subscription tier (gpt-5.5, gpt-5.4,
  gpt-5.4-mini, gpt-5.2 confirmed); `DEFAULT_MODEL` in `codex_client.py` is `gpt-5.5`.

## Schema

`schemas/songsheet.schema.json` (draft-07) defines the document model. Required top-level:
`document` (only `title` required within it) and `songs`. Each song requires `title` and
`sections`. A chord entry requires `chord` (string; `%` allowed), with optional `voicing`
(`^[0-9x]{6}$`) and `text`; `document`/song/section objects are closed
(`additionalProperties: false`), top-level is open (`_meta` provenance is added there).
`tests/test_schema.py` + `tests/fixtures/chega-page1.json` exercise it.

Data lives per-artist under `data/<artist>/{pdf,json,chordmark}/` (only `joao-gilberto` exists).
Note: `ARCHITECTURE.md`, `TWO_STAGE_HYBRID_IMPLEMENTATION.md`, `EXAMPLES.md`, and `QUICKSTART.md`
describe the **old** model and are stale — the spec above supersedes them.
