# Target Lead-Sheet Renderer + Lyric Hyphenation — Design

**Date:** 2026-05-30
**Status:** Approved design — ready for implementation planning
**Author:** Arthur Soares (with Claude)

## Problem

The round-trip to ChordMark renders correctly now, but the default ChordMark look is plain.
Arthur prototyped a polished "target look" (`chord-mark/packages/chord-mark/tests/_renderTarget.spec.js`):
centered title, small-caps composer, a chord-diagram dictionary on top, a two-column
chord-over-syllable body, Roman-numeral fret positions, barres, `°` for diminished. But that
prototype reads the OLD per-page `sample-NN.json` model and hand-rolls HTML outside the pipeline,
so it ignores QA corrections.

Separately, the new model's lyrics are bare space-separated syllables with no word boundaries
(`"tris te za e"` = *tristeza* + *e*), so a proper lead sheet can't hyphenate continuations
(`tris- te- za e`).

## Goal

1. Carry **word-continuation dashes** in the lyric data (source of truth, QA-editable), seeded
   for existing songs and preserved for new parses.
2. A **target lead-sheet renderer** reading the NEW chord-anchored model, producing the polished
   look, wired into the QA Preview tab as an alternate style.

## Section 1 — Lyric hyphenation (data treatment)

### Representation
A syllable that continues its word ends in `-`. Word boundaries are plain spaces.
`"tris te za e"` → `"tris- te- za e"` (tristeza is one word; *e* is the next). Stored in the
`text` field of each chord entry; editable in the QA tool's existing text input. This is the
source of truth — renderers only read it.

The schema's `text` is a free string, so **no schema change** is required. (The voicing regex and
everything else are untouched.)

### Going forward — parse prompt
`scripts/parse_songsheet.py` PARSE_PROMPT currently instructs the model to STRIP dashes. Change it
to **preserve word-continuation dashes**: the songbook prints them as spacing ("Vai mi - nha"), so
the vision model can read them directly. A continuing syllable keeps a trailing `-`; the last
syllable of a word has none. Example output: `"text": "tris- te- za e"`.

### Existing 195 songs — migration
`scripts/migrate_hyphenation.py`: for each song, collect every chord entry's `text`, and for each
lyric run ask an LLM (via the existing `scripts/codex_client.py`) to re-insert continuation dashes
into the Portuguese syllables, preserving the exact tokens and spacing otherwise. Best-effort;
Arthur refines mistakes in the QA tool. Writes back in place (schema re-validated).
- Batch per song (one call per song, all its lyric fragments together with their order) to keep
  cost/latency reasonable.
- Idempotent: text already containing `-` is passed through unchanged.
- `--dry-run` prints proposed changes without writing.

No Portuguese word-list dependency — the model supplies the language knowledge.

## Section 2 — Target renderer

`scripts/render_target.py` — pure functions (dict → HTML string), no file/network I/O, unit-testable
(mirrors `chordmark_render.py`). Ported from the `_renderTarget.spec.js` look but reading the new
model `document → songs → sections → bars → [{chord, voicing?, text?}]`.

Layout:
- Centered **title**, small-caps **composer** (from `document`/song metadata).
- **Diagram dictionary** on top (Section 3).
- **Two-column** body of chord-over-syllable lines.
- Per chord: name (with `°` for `dim`/`dim7`), the syllable(s) beneath, hyphenation taken directly
  from dashes in `text`.
- **Held `%` bars** render as a **`.`** in the chord slot (chord shown once where it strikes; each
  held bar shows `.` over its continuing lyrics).
- **Diagrams** computed from the per-occurrence `voicing` (comma fret-number form), with Roman-numeral
  position label and **barre detection** (≥2 strings at the start fret → a barre line), reusing the
  geometry from the prototype's `diagram()`.

Body line grouping reuses the same phrase logic as `chordmark_render` (instrumental runs vs sung
runs) so lines read naturally.

## Section 3 — Dictionary modes + inline diagrams

Render options on `render_target`:
- `dictionary`: `"per_voicing"` (one box per distinct name+voicing — faithful to what's played) or
  `"per_name"` (one box per chord name, most-common voicing — compact). Default `per_voicing`.
- `inline_diagrams`: bool. When true, also render a small diagram at each chord occurrence in the
  body (the "inline voicing guide"), so alternate voicings are visible in context. Default false.

The per-song generated `chords` index already groups voicings; the renderer derives the dictionary
from the actual occurrences (not relying on the index being present).

## Section 4 — Preview wiring

- `qa_server.py` `/api/render/{album}/{file}` gains a `?style=` param: `fork` (current path:
  ChordMark via the fork) or `target` (new pure-Python renderer → HTML directly, no node/fork
  needed). Plus `?dict=` (per_voicing|per_name) and `?inline=` (0|1) forwarded to the target renderer.
- The QA Preview tab gets a small control row: **style** (Fork / Target), and when Target is
  selected, **dictionary mode** and an **inline diagrams** toggle. Re-renders on change and on save
  (reusing the existing cache-bust token).

## Components

| File | Responsibility | Action |
|------|----------------|--------|
| `scripts/render_target.py` | pure: new-model → target-look HTML; diagram/barre/hyphenation | Create |
| `scripts/migrate_hyphenation.py` | LLM-seed continuation dashes into existing songs' text | Create |
| `scripts/parse_songsheet.py` | PARSE_PROMPT: preserve continuation dashes | Modify |
| `scripts/qa_server.py` | `/api/render` style/dict/inline params → target renderer | Modify |
| `scripts/qa_static/index.html`, `app.js` | Preview style/dict/inline controls | Modify |
| `tests/test_render_target.py` | hyphenation passthrough, held `.`, barre, dictionary modes | Create |

## Testing

- `render_target` pure functions: unit tests for hyphenation rendering (dashes → `tris-`), held-`%`
  → `.`, barre detection from a known barre voicing, `°` substitution, per_voicing vs per_name
  dictionary, inline on/off. Verified headlessly (Python).
- `migrate_hyphenation`: unit-test the idempotence + token-preservation logic with a stubbed LLM
  call (don't hit the network in tests); the real LLM pass is a manual/CLI step.
- Manual: render a corrected song in the Preview Target style; compare to the prototype PNG.

## Non-goals

- No schema change (text stays a free string; dashes live inside it).
- No mass corpus re-parse (migration seeds dashes; prompt prevents recurrence going forward).
- Not replacing the fork renderer — Target is an additional style alongside it.
- Print/PDF export is out of scope (HTML preview only; the CSS already uses `@page` so browser
  print works, but no dedicated export pipeline).

## Dependencies / ordering

Builds on the QA tool, `codex_client` (for migration), the existing diagram geometry, and the
phrase-grouping logic in `chordmark_render`. The migration step needs the Codex subscription
available (same as parsing).
