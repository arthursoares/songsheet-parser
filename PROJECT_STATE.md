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
- **QA correction tool v2** (`qa_server.py` + `qa_static/`):
  - Song-list **sidebar** (search, status filter, status badges, click-to-load with dirty-guard,
    current-song highlight); provenance + per-song **note** in the footer.
  - Tabs **Bars / Lyrics / Review / Dictionary / Preview / JSON**. Bars: per-chord edit
    (name/voicing/lyric), move-between-bars, plus **structural editing** (add/delete bar,
    split/merge bar, add/delete section, inline section-label rename). Review: worklist of flagged
    chords + Next-flagged. Dictionary: batch-edit/merge, alphabetical or by count. Preview: live
    render of unsaved edits + a Source toggle for the generated ChordMark.
  - **JSON** tab: a CodeMirror 5 editor over the raw song JSON (vendored at
    `qa_static/vendor/codemirror/`) — Tab indent (2-space soft tabs), syntax coloring, live
    validation with line/col + lint gutter marker; Apply parse-guards + is undoable, plus
    Format / Reload.
  - **Lyrics** tab (**prototype**): chords render above their anchored syllables per section; drag a
    chord token onto a different syllable to re-anchor it (per-bar rebuild, wired into undo / dirty /
    Save). Documented limits: re-anchor is within a single bar (cross-bar drops no-op), whitespace
    syllable splitting.
  - Reverse detection (tonal) validated through chord-symbol, key-aware Roman intervals, ♯/♭
    toggle, per-song status + album progress, **undo/redo**, dirty-state guard, keyboard shortcuts
    (⌘S save, Esc, n/p songs, ] next-flagged, Enter apply, ⌘Z/⌘⇧Z undo/redo).
  - **In-app exports** from Preview: PDF / PNG / HTML / .chordmark / ChordPro per song, plus a
    whole-album **songbook PDF** (PDF/PNG via headless Chrome on the server).
- **Three render modules:** `chordmark_render.py` (→ ChordMark via the fork), `render_target.py`
  (pure-Python lead sheet + `render_songbook`), and `chordpro_render.py` (→ ChordPro). Round-trip
  to the fork verified end-to-end.
- Lyric hyphenation: parse prompt preserves dashes; `migrate_hyphenation.py` LLM-seeds existing songs.
- Test suite: 89 passing (pytest). JS verified via `node --check` + Node smoke harnesses.

### In progress / next
- **Hyphenation seeded for only 1 song** so far (Chega de Saudade). Run
  `migrate_hyphenation.py data/joao-gilberto/songs/` to do the rest (~190 LLM calls).
- Per-chord accuracy: voicings/fingerings from vision are often wrong — the QA tool is the fix;
  most of the corpus is unreviewed.
- Continuation-song splits: a song spanning pages can appear as two entries when the title-page name
  differs from the running header (e.g. "Brigas, nunca mais" / "Brigas Nunca Mais"). Assembler matches
  exact normalized titles; fuzzy merge is a future improvement.
- Multi-format extraction (pluggable format profiles) — planned; two samples analyzed (Lumiar/Caetano
  scanned songbook ≈ current pipeline; Rousseau digital chord-grid arrangement, lyric-less). See
  `docs/superpowers/plans/2026-05-30-multi-format-extraction.md`.
- Harmonic analysis & visualization (engine + Harmony tab + corpus insights) — planned; experiments
  validated (notes-first quality, cadence-based key, device/tonicization detection, interactive
  harmony×lyrics + audio prototype). See `docs/superpowers/plans/2026-06-02-harmonic-analysis.md`.

### Deferred (QA tool roadmap)
- **MusicXML export** (alongside PDF/PNG/HTML/.chordmark/ChordPro).
- **Full transpose** of a song, including voicings.
- **Corpus-wide chord rename** (the Dictionary batch-edit is per-song today).
- **Lyrics tab**: cross-bar re-anchor + intra-word (syllable-level) splitting (currently within-bar,
  whitespace-only — see prototype limits above).
- **Section reorder** in the UI.
- **favicon** (one 404 on load; cosmetic).

## Stale docs

`ARCHITECTURE.md`, `TWO_STAGE_HYBRID_IMPLEMENTATION.md`, `EXAMPLES.md`, `QUICKSTART.md`, and
`docs/pipeline.md` describe the **old** model and two-stage approach — superseded by this file,
`README.md`, `CLAUDE.md`, and the specs under `docs/superpowers/specs/`.
