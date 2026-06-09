# Songsheet Parser — Project State

**Last updated:** 2026-06-09

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
- **Harmonic analysis (2026-06-09):** pure engine `scripts/harmony.py` — event normalization with
  `%` carry + beat distribution, voicing→pitch decoding, **notes-first chord quality** with an
  ambiguity path (symbol text converted to an interval set and named by the same function, so
  both paths share one vocabulary incl. Brazilian forms `7-9`/`m7/9`/`13,9`/`479`/trailing
  `7+`=maj7), cadence-based key with stored-key precedence (Krumhansl as cross-check only),
  spelled Roman numerals, context-aware function classification, device detectors (ii–V–I,
  secondary dominants, tritone subs, chromatic-bass runs, maj7 tonics, tonicization spans), and
  per-event **confidence/discrepancy**. Whole corpus (~24.7k events) analyzes in ~0.8 s.
- **Harmony tab** (`qa_static/harmony.js` + `GET /api/harmony` / `POST /api/harmony-doc`):
  function-colored cells with Roman numerals + lyrics, tension/bass/tonicization lanes, device
  brackets with pedagogical tooltips (in a dedicated 44px band so nothing overlaps), spotlight
  chips, rich click panel (diagram / why / confidence) with **Edit chord →** jump into the Bars
  editor, inline **key-confirm bar** (stores the inferred key, undoable; Romans re-derive live),
  **Web Audio player** (beat-accurate voicings, gliding playhead, panel follows), and **exports**
  of the live analysis as JSON / CSV / standalone HTML / PDF (`POST /api/convert`).
- **Layout focus mode:** header toggles (☰ songs / ⊞ scan, `\` key, persisted) collapse the song
  list and/or scan pane.
- ChordMark output carries `composer`/`key` metadata directives; `json_to_chordmark.py` walks
  directories recursively, mirroring the per-album corpus layout.
- Test suite: 227 passing (pytest). JS verified via `node --check` + Playwright smoke.

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
- **Harmonic analysis next step: D1 corpus report** (`harmony_report.py` — device quantification
  over all songs, functional stats over confirmed-key songs, key-suggestions worklist). Gate:
  only **7/185 songs have stored keys**; the cadence estimator is high-confidence on 135 of the
  178 missing (low on 43) — a batch key-seeder plus the Harmony tab's Confirm-key pass closes it.
  Then C6 circle-of-fifths (deferred polish), D2 harmony×lyrics insights, E prediction. See
  `docs/superpowers/plans/2026-06-02-harmonic-analysis.md` (15/22 checkboxes done).

### Deferred (QA tool roadmap)
- **MusicXML export** (alongside PDF/PNG/HTML/.chordmark/ChordPro).
- **Full transpose** of a song, including voicings.
- **Corpus-wide chord rename** (the Dictionary batch-edit is per-song today).
- **Lyrics tab**: cross-bar re-anchor + intra-word (syllable-level) splitting (currently within-bar,
  whitespace-only — see prototype limits above).
- **Section reorder** in the UI.
- **favicon** (one 404 on load; cosmetic).

## Documentation map

Current docs: `README.md` (user-facing overview), `CLAUDE.md` (working reference: model, tool
internals, routes, conventions), this file (state snapshot), and `docs/superpowers/` (design
specs + implementation plans with live checkboxes). The February-era docs that described the
old pre-chord-anchored model (`ARCHITECTURE.md`, `QUICKSTART.md`, `EXAMPLES.md`,
`TWO_STAGE_HYBRID_IMPLEMENTATION.md`, `docs/pipeline.md`, `docs/chord-naming.md`) were deleted
on 2026-06-09.
