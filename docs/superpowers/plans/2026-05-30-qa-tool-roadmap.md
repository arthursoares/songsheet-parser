# QA tool roadmap

**Date:** 2026-05-30
**Status:** standing roadmap (QA v2 shipped; items below are deferred / next)

The browser QA correction tool (`scripts/qa_server.py` + `scripts/qa_static/`) is now a six-tab
reviewer: **Bars / Lyrics / Review / Dictionary / Preview / JSON**. This note records what shipped
in QA v2 and the deferred work, so there's a single place to pick up the next slice.

## Shipped (QA v2)

- **Song-list sidebar** — search, status filter, status badges, click-to-load with dirty-guard,
  current-song highlight; provenance + per-song note in the footer.
- **Bars tab** — per-chord edit (name / voicing / lyric), move-between-bars, plus structural editing
  (add/delete bar, split/merge bar, add/delete section, inline section-label rename). Reverse
  detection (tonal) validated through chord-symbol; red-dot name↔voicing mismatch flag.
- **Review tab** — worklist of flagged chords (name↔voicing mismatch or invalid name) + Next-flagged.
- **Dictionary tab** — distinct chords grouped by (name + voicing), batch-edit / merge,
  alphabetical or by count.
- **Preview tab** — live render of the current unsaved edits in two styles (fork / target), Source
  toggle, and in-app export to PDF / PNG / HTML / .chordmark / ChordPro + whole-album songbook PDF.
- **JSON tab** — CodeMirror 5 code editor over the raw song JSON (vendored at
  `qa_static/vendor/codemirror/`): Tab indent (2-space soft tabs), JSON syntax coloring, live
  validation (parse error line/col + lint gutter marker). Apply parse-guards and is undoable;
  Format pretty-prints; Reload re-reads from the in-memory model.
- **Lyrics tab (prototype)** — chords render above their anchored syllables per section; drag a
  chord token onto a different syllable to re-anchor it (per-bar rebuild, wired into undo / dirty /
  Save). Prototype limits: re-anchor is within a single bar (cross-bar drops no-op); syllable
  splitting is whitespace-based.
- Cross-cutting: key-aware Roman intervals, ♯/♭ toggle, per-song status + album progress,
  undo/redo, dirty-state guard, keyboard shortcuts. Saves are schema-validated server-side.
- Tests: 89 passing (pytest); JS verified via `node --check` + Node smoke harnesses.

## Deferred / next

- **MusicXML export** alongside the existing export formats.
- **Full transpose** of a song, including its voicings.
- **Corpus-wide chord rename** (Dictionary batch-edit is per-song today).
- **Lyrics tab**: cross-bar re-anchor + intra-word (syllable-level) splitting, lifting the current
  within-bar / whitespace-only prototype limits.
- **Section reorder** in the UI.
- **favicon** — one 404 on load; cosmetic.
