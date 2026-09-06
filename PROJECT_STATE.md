# Songsheet Parser — Project State

**Last updated:** 2026-09-06

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
- **Hardening pass (2026-06-10):** `data/` is its own **private git repo**
  (github.com/arthursoares/songsheet-data — corpus + scans backed up off-machine);
  `pyproject.toml` with PEP 735 dep groups + ruff (lint/format applied repo-wide); GitHub Actions
  CI (ruff + pytest + `node --test`); `schema_version` field (current 2, stamped on save, future
  versions refused); qa_server routes as a `_ROUTES` table; app.js split into six `app_*.js`
  files (classic-script idiom — harmony.js shares globals, so ES modules deferred deliberately);
  pure doc mutations extracted to `doc_ops.js` with node tests (caught + fixed a real data-loss
  bug: re-anchoring a bar's first chord deleted leading syllables); chord-naming **parity
  fixture** pinned in both pytest and node (also caught: harmony.py read `Caug`/`C+` as a major
  triad — fixed).
- **Parser eval harness (2026-06-10):** `eval_extraction.py` — `score` (candidate corpus vs
  status=done golden songs; chord accuracy is HARMONIC equivalence via harmony.py with spelling
  tracked separately; text comparison dash-insensitive; alignment-based so dropped bars don't
  cascade), `diff` (bar-level disagreements between two parses), `reparse` (the whole
  prompt-improvement loop for one golden song, page parses cached). Measured baseline on the
  golden song (gpt-5.5): structure/anchor ~100%, chords ~81% (plus ~20% spelling-convention
  deltas), lyrics 49→55-62% after prompt fixes (diacritics + positional anchoring), **voicings
  26–43% across ALL prompt variants and a hi-DPI test — perception-bound, not prompt-bound**
  (the model recites textbook shapes for the chord name; those evade the name≠voicing flag, so
  the prompt now has a read-don't-recall rule making errors detectable).
- **CV diagram reader (2026-06-10):** `diagram_reader.py` reads the diagrams DETERMINISTICALLY
  from the PDFs' native embedded images (all 15 albums are ~592×840 ≈ 72 dpi rasters; each
  diagram ~36×22 px — the root cause of the vision ceiling). Geometry: horizontal grids
  (top = high e), bold string line = played / thin = muted (bold + no dot = open), dots as ≥4 px
  vertical ink runs, uniform fret-grid reconstruction, 'o'-under-nut open marker; absolute base
  fret = harmonic fit of the chord name, tie-broken by auto-calibrated 4×5 px digit templates
  (`diagram_digits.json`). **82.5% exact vs golden / ~97.6% print-faithful** (residuals are
  editorial corrections beyond the print: unmarked opens, unprinted barre dots).
- **Corpus voicing audit (2026-06-10):** `audit_voicings.py` diffed the reader against every
  stored voicing — 175/185 songs aligned, **5,865 voicings double-confirmed, 12,748 in a ranked
  review worklist, 598 missing voicings recovered from print** (report in the songsheet-data
  repo). Every aligned entry carries **`voicing_printed`** (optional schema field — print
  evidence kept separate from editorial `voicing`).
- **QA tool v3 (2026-06-10):** chord editor shows the **magnified printed diagram**
  (`/api/diagram-crop`) + "print reads … use / use + next"; `]`/`[` cycle EVERY chord for full
  sequential review (`}`/`{` keep flagged-only jumps); `≠ print` flag reason; Dictionary
  "print → N×" batch-apply; sidebar per-song audit badges (count or ✓); **Lyrics text mode**
  (default): free-form ChordMark lyric lines — read-only chord line above, editable `_`-marker
  line below; gluing a marker mid-word (`tris_te`) stores the continuation dash, marker count
  validated on commit; grid mode (drag + dblclick syllable edit) kept as toggle.
- **Corpus persistence hardening (2026-09-06):** QA saves, materialization, the voicing audit,
  and lyric migration share `songsheet_io.py` for schema/version validation and atomic JSON
  writes. Unsupported versions are checked before stamping or CV/LLM work. Materialization
  preflights each album and refuses existing songs or copied pages unless `--overwrite` is explicit;
  use a fresh `--out` directory for extraction candidates. Existing file permissions are preserved.
  Audit load/save errors are reported per song without stopping the remaining songs. Atomicity
  is per JSON file, not an album transaction or concurrent-edit conflict resolution.
- Test suite: **326 pytest + 51 node tests** passing; CI runs both plus ruff.

### In progress / next
- **Full manual review of the corpus** — the active campaign, now instrumented: the audit ranks
  all 185 songs by disagreement count (12,748 voicings to look at; 5,865 pre-confirmed), the
  editor shows the printed diagram next to the fretboard, `]`/`[` walk every chord, and the
  Lyrics text mode fixes words/splits as plain typing (each fused word also upgrades the corpus
  to proper hyphenation — same gesture). Songs marked **done** grow the golden eval set
  (currently 1) which feeds the eval and the reader's digit templates.
- **Wire the diagram reader into fresh parses** (enrich step in `validate_extraction.py`):
  override vision voicings with reader voicings at parse time — fresh extractions jump from
  ~40% to ~95%+ voicing accuracy. The corpus audit already proved the pairing.
- **10 unalignable songs** from the audit (diagram/entry counts differ by 4–9) need structural
  attention (likely missing/extra bars).
- Continuation-song splits: a song spanning pages can appear as two entries when the title-page name
  differs from the running header. Assembler matches exact normalized titles; fuzzy merge is a
  future improvement.
- Multi-format extraction (pluggable format profiles) — planned; the CV diagram reader is the
  first concrete per-element extractor in that direction. See
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
- **Lyrics grid mode**: cross-bar drag re-anchor (the TEXT mode already moves lyrics across bars
  and rows freely; the drag prototype remains within-bar).
- **Section reorder** in the UI.
- **favicon** (one 404 on load; cosmetic).

## Documentation map

Current docs: `README.md` (user-facing overview), `CLAUDE.md` (working reference: model, tool
internals, routes, conventions), this file (state snapshot), and `docs/superpowers/` (design
specs + implementation plans with live checkboxes). The February-era docs that described the
old pre-chord-anchored model (`ARCHITECTURE.md`, `QUICKSTART.md`, `EXAMPLES.md`,
`TWO_STAGE_HYBRID_IMPLEMENTATION.md`, `docs/pipeline.md`, `docs/chord-naming.md`) were deleted
on 2026-06-09.
