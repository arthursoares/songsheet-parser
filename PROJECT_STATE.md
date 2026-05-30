# Songsheet Parser — Project State

**Last updated:** 2026-05-30

## What this is

A pipeline to digitize Brazilian songbook chord charts (PDF → JSON → ChordMark / lead sheet),
built for Arthur's João Gilberto harmonic-analysis project.

- Pipeline repo: https://github.com/arthursoares/songsheet-parser
- ChordMark fork: https://github.com/arthursoares/chord-mark (sibling repo at `../chordmark/chord-mark`;
  adds inline chord-diagram rendering + comma-form inline voicings)

## Pipeline

```
PDF → extract_pages → PNG → parse_songsheet → JSON → [QA correction] → render
                            (OpenAI gpt-5.5 via Codex)   (browser)       (ChordMark or target lead sheet)
```

## Data model (current)

Chord-anchored: `document → songs → sections → bars`, where **a bar is an ordered array of
`{chord, voicing?, text?}` entries**. Entry order is the chord↔lyric anchor (no `at_syllable`).
`%` = measure-repeat (held chord). Voicing = 6 comma-separated frets `x,5,7,5,6,x` (0–24),
per-occurrence. Lyrics carry word-continuation dashes (`tris- te- za e`). Schema:
`schemas/songsheet.schema.json`. Full design: `docs/superpowers/specs/2026-05-28-songsheet-data-model-design.md`.

## State

### Done
- Vision parsing on **OpenAI gpt-5.5** via the ChatGPT/Codex subscription (`codex_client.py`).
- Full corpus parsed: **15 PDFs / 662 pages / ~195 songs** (validation run complete; report at
  `/tmp/ssv/full-report.json`). Materialized per-song under `data/joao-gilberto/songs/<album>/`
  (git-ignored — copyrighted scans + personal-use song data).
- Comma fret-number voicing format (fixes up-the-neck chords); migration built into materialize.
- **QA correction tool** (`qa_server.py` + `qa_static/`): Bars/Dictionary/Preview tabs, per-chord
  edit (name/voicing/lyric), move-between-bars, chord dictionary (batch-edit/merge, alphabetical or
  by count), reverse detection (tonal) validated through chord-symbol, key-aware Roman intervals,
  ♯/♭ toggle, per-song status + album progress.
- **Two render styles:** `render_chordmark.py` (→ ChordMark via the fork) and `render_target.py`
  (pure-Python polished lead sheet). Round-trip to the fork verified end-to-end.
- Lyric hyphenation: parse prompt preserves dashes; `migrate_hyphenation.py` LLM-seeds existing songs.
- Test suite: 59 passing (pytest). JS verified via `node --check` + Node smoke harnesses.

### In progress / next
- **Hyphenation seeded for only 1 song** so far (Chega de Saudade). Run
  `migrate_hyphenation.py data/joao-gilberto/songs/` to do the rest (~190 LLM calls).
- Per-chord accuracy: voicings/fingerings from vision are often wrong — the QA tool is the fix;
  most of the corpus is unreviewed.
- Continuation-song splits: a song spanning pages can appear as two entries when the title-page name
  differs from the running header (e.g. "Brigas, nunca mais" / "Brigas Nunca Mais"). Assembler matches
  exact normalized titles; fuzzy merge is a future improvement.
- No in-app export button — export via the `/api/render` URL (⌘P → PDF) or headless-Chrome PNG.

## Stale docs

`ARCHITECTURE.md`, `TWO_STAGE_HYBRID_IMPLEMENTATION.md`, `EXAMPLES.md`, `QUICKSTART.md`, and
`docs/pipeline.md` describe the **old** model and two-stage approach — superseded by this file,
`README.md`, `CLAUDE.md`, and the specs under `docs/superpowers/specs/`.
