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
# Stage 1 — PDF to PNG pages (page-001.png, ...). Uses PyMuPDF (no poppler needed).
python scripts/extract_pages.py songbook.pdf --output data/<artist>/png/ [--dpi 200]

# Stage 2 — PNG to JSON via vision model. Default provider is codex (OpenAI gpt-5.5).
#   Emits the chord-anchored document model directly (anchoring is intrinsic; no later stage).
python scripts/parse_songsheet.py data/<artist>/png/*.png --output data/<artist>/json/ \
  [--provider codex|claude|gemini|openai] [--model NAME] [--dry-run]

# Stage 3 — JSON document → one .chordmark per song.
python scripts/json_to_chordmark.py data/<artist>/json/ --output data/<artist>/chordmark/

# Validate a whole PDF: render→parse→assemble pages into songs, schema-check, report.
#   Caches per-page JSON under --workdir for resumable runs (parsing is the slow part).
python scripts/validate_extraction.py "data/<artist>/pdf/Album.pdf" --workdir /tmp/ssv --report-json /tmp/r.json

# Promote assembled docs (from a validation run's workdir) into a per-song corpus + page PNGs.
#   Migrates old 6-char voicings → comma form; this is what the QA tool reads/writes.
#   Refuses existing songs; use a fresh --out for candidates, or explicitly --overwrite.
python scripts/materialize_songs.py --workdir /tmp/ssv --out data/<artist>/songs [--only "<pdf stem>"]

# QA correction tool: review songs beside scans; song-list sidebar + Bars / Lyrics / Review /
#   Dictionary / Preview / JSON tabs; structural edit, undo/redo, per-song note, live preview,
#   in-app exports.
python scripts/qa_server.py --songs data/<artist>/songs [--port 8000]   # open localhost:8000

# Seed lyric word-continuation dashes into existing songs (LLM, idempotent).
python scripts/migrate_hyphenation.py data/<artist>/songs/ [--dry-run]

# Parser eval: score a fresh parse against the hand-corrected golden songs
#   (status=done = ground truth; per-field chord/voicing/text/anchor accuracy),
#   or diff two parses of one song — disagreeing bars are where QA time goes.
#   reparse = the whole prompt-improvement loop for one golden song (parse its
#   page PNGs fresh, cached per page; score + print disagreements).
python scripts/eval_extraction.py score --golden data/<artist>/songs --candidate <fresh>/songs
python scripts/eval_extraction.py diff a.json b.json [--report-json out.json]
python scripts/eval_extraction.py reparse data/<artist>/songs/<album>/<song>.json [--force]

# CV diagram reader — reads chord diagrams DETERMINISTICALLY from the PDFs'
#   native ~72dpi embedded images (the vision LLM tops out ~40% exact on
#   voicings; this hits ~82% vs golden / ~97% print-faithful). Geometry:
#   horizontal grids, bold line = played, dots via vertical ink thickness,
#   base fret = harmonic fit to the chord name + calibrated 4x5px digit
#   templates (scripts/diagram_digits.json) as tie-breaker.
python scripts/diagram_reader.py "data/<artist>/pdf/Album.pdf" --page 1 [--names Am7,D7,...]

# Corpus voicing audit: diff the CV reader against every stored voicing;
#   --write persists what the page prints as `voicing_printed` on each entry
#   (NEVER touches `voicing`). agree = two independent sources -> skip in
#   review; differ = ranked worklist; the QA chord editor shows a
#   "print reads ... [use]" hint wherever they differ.
python scripts/audit_voicings.py --songs data/<artist>/songs --pdfs data/<artist>/pdf --write

# Render a .chordmark to HTML via Arthur's fork (needs ../chordmark/chord-mark + node).
node scripts/render_chordmark.js in.chordmark out.html [--chordmark-repo PATH]
```

Single page end-to-end: render a PNG, run stage 2 then stage 3.

**QA tool internals** (`scripts/qa_static/`, pure-JS, no build — classic scripts sharing
globals, explicit load order in index.html):
- The app is split into `app_core.js` (state, undo/redo, shared helpers), `app_songs.js`
  (sidebar, load/save, dirty-guard nav), `app_bars.js` (Bars view, chord editor, structural-edit
  wrappers), `app_lyrics.js` (Lyrics prototype), `app_views.js` (tabs, Review, Preview + exports,
  JSON/CodeMirror), `app_dict.js` (Dictionary view), and `app.js` (entry: init/keyboard/layout —
  load LAST). `doc_ops.js` = the PURE document mutations (structural ops + lyric re-anchor model;
  UMD, node-testable via `node --test tests/js/`); `chord_naming.js` = detect (tonal) + validate
  (chord-symbol) + intervals; `chord_dictionary.js` = group/batch-edit/merge (also UMD + tested);
  `fretboard.js` = dual-mode voicing editor; `diagram.js` = SVG chord thumbnail; `harmony.js` =
  the **Harmony** tab (renders `/api/harmony-doc` output; reads app globals — why these stay
  classic scripts rather than ES modules); `vendor/` = bundled tonal + chord-symbol, plus
  `vendor/codemirror/` (vendored CodeMirror 5) backing the **JSON** tab's code editor.
- **Seven tabs:** Bars / Lyrics / Review / Dictionary / Harmony / Preview / JSON. Bars also does
  structural editing (add/delete bar, split/merge bar, add/delete section, inline section-label
  rename). Review is a worklist of flagged chords (name↔voicing mismatch or invalid name).
  **Harmony** shows the live (unsaved) doc's harmonic analysis (engine: `scripts/harmony.py`):
  function-colored chord cells with Roman numerals + lyrics (`%` holds as ties, confidence
  shading), tension/bass/tonicization lanes, device brackets with pedagogical tooltips,
  spotlight chips (functions + devices dim non-matching), a rich click panel (diagram, why,
  confidence/discrepancy, Edit-chord jump into the Bars editor — double-click does the same),
  an inline key-confirm bar (stores the inferred key on the song via the normal
  undo/dirty/save path; Romans re-derive live), and a Web Audio **player** (▶ + tempo slider:
  real voicings, beat-accurate, gliding playhead over the lanes, panel follows; stops on tab
  switch), and **export buttons** (JSON / CSV / standalone HTML snapshot / PDF — all of the
  LIVE analysis incl. unsaved edits). Header has **layout focus toggles** (☰ songs / ⊞ scan, `\` key) that collapse the
  song list and/or PDF-scan pane when the three-pane layout gets cramped. Preview has a
  **Source** toggle (shows the generated `.chordmark` beside the render) and the export buttons.
  **JSON** is a CodeMirror 5 editor over the raw song JSON (Tab indent / syntax coloring / live
  lint with line·col + gutter marker; Apply parse-guards + is undoable, Format / Reload).
  **Lyrics** has two modes (toggle, persisted): **text** (default) = free-form ChordMark lyric
  lines — read-only chord line above an editable line with one `_` marker per entry; gluing a
  marker into a word (`tris_te`) stores a trailing continuation dash, a space before it removes
  it; marker count is validated on commit (Enter/blur; Esc reverts); leading text flows to the
  previous entry. **grid** = the original prototype: drag a chord onto a syllable to re-anchor
  (within one bar), double-click a syllable to edit (space splits, empty deletes).
- **Keyboard:** ⌘S/Ctrl+S save, Esc close editor, `n`/`p` prev/next song, `]`/`[` next/prev CHORD
  (full sequential review; skips `%`), `}`/`{` next/prev flagged, Enter
  applies in the chord editor, ⌘Z/⌘⇧Z (Ctrl+Y) undo/redo.
- `qa_server.py` (stdlib HTTP), exact routes in the `_ROUTES` table (one `_h_*` handler each):
  - `GET /api/albums`
  - `GET|POST /api/song/<album>/<file>` (POST is schema-validated)
  - `GET /api/chordmark/<album>/<file>?bars=` — generated ChordMark source for a saved song
  - `GET /api/render/<album>/<file>?style=fork|target&dict=&inline=&bars=` — HTML of a saved song
  - `POST /api/render-doc?style=&dict=&inline=&bars=` — render HTML from a POSTed (unsaved) doc
  - `POST /api/chordmark-doc?bars=` — ChordMark source from a POSTed (unsaved) doc
  - `GET /api/harmony/<album>/<file>` — harmonic analysis (JSON) of a saved song
  - `POST /api/harmony-doc` — analysis of a POSTed (unsaved) doc; analyzes `songs[0]` only
  - `POST /api/convert?fmt=pdf|png&name=` — body is HTML, returns it Chrome-converted (Harmony exports)
  - `GET /api/export/<album>/<file>?fmt=chordmark|html|pdf|png|chordpro&...` — downloadable file
  - `GET /api/export-album/<album>?fmt=pdf|html&...` — whole-album songbook (one document)
  - `GET /api/page/<album>/<file>/<n>` — page PNG
  (`style=target` extras: `dict=per_voicing|per_name`, `inline=0|1`; `bars` is 4/6/8, default 4.)
- **Corpus persistence:** `scripts/songsheet_io.py` is the shared boundary for QA saves,
  materialization, voicing-audit writes, and lyric migration. `load_document` validates before
  editing; `save_document` checks version/schema before stamping a copy and publishing complete
  UTF-8 JSON atomically. Creation refuses collisions; replacement is explicit and checks the
  existing version too. The materializer alone migrates legacy six-character voicings and
  preflights every song in an album before writing. Keep all editable-corpus writers on this
  boundary. Atomicity is per JSON file; it does not provide album rollback or concurrent-edit
  conflict resolution.
- **Live preview & export:** the Preview tab renders the *in-memory* edits via `/api/render-doc`
  (and `/api/chordmark-doc` for Source) — no Save needed. Export buttons hit `/api/export…`;
  PDF/PNG are produced by headless Chrome on the server (`render_song_doc`/`_chrome_convert`).
- **Three render modules** (pure, I/O-free): `chordmark_render.py` (→ ChordMark via the fork;
  needs node), `render_target.py` (pure-Python lead sheet: alphabetical diagram dictionary, 2-col
  chord-over-syllable, Roman positions, barres, `°`, held bars as `.`; exposes `render_song` and
  `render_songbook` for the whole-album PDF), and `chordpro_render.py`
  (`render_chordpro`, → ChordPro).

### Setup & auth

```bash
python3 -m venv .venv && ./.venv/bin/pip install --group dev
# extract_pages.py renders PDFs via PyMuPDF (pymupdf) — no poppler needed.
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

The parser is currently **single-format** — tuned to the João Gilberto guitar-diagram songbook. A
plan to support other songbook PDF layouts via pluggable `--format` profiles (plus `extract_pages.py
--split-spreads` for two-up scans and a PyMuPDF digital-text cross-check) lives in
`docs/superpowers/plans/2026-05-30-multi-format-extraction.md` (not yet implemented).

```
document → songs[] → sections[] → bars[]
```

- **A bar IS an ordered array of chord entries** — `[{ "chord", "voicing"?, "text"? }, ...]`. There is
  no wrapper object and no beat-grid. **Entry order is the chord↔text anchor** — the Nth chord aligns to
  the Nth `text` fragment. No `at_syllable`, no substring lookup.
- **`chord: "%"`** = measure-repeat: the previous chord keeps playing into this bar (not a piano "hold" —
  the guitar re-strums). This is how a chord spanning multiple bars is expressed.
- **`voicing` is per-occurrence** — 6 comma-separated strings low-E→high-e, each `x` (muted) or a
  fret number 0–24 (e.g. `x,5,7,5,6,x`). The same chord name recurs with different diagrams, so
  voicing lives on the entry. The converter renders it inline as `Name[...]` (frets 10–24 → `a`–`o`).
- **`voicing_printed`** (optional, same format) — what the PAGE prints, written by the CV diagram
  reader via `audit_voicings.py`. Kept separate from `voicing` by design: hand corrections are
  editorial (the books omit markings — unmarked opens, unprinted barre dots), and the print
  evidence must survive them. Renderers ignore it; the QA editor surfaces it as a hint.
- **`text`** = syllables sung from that chord's onset, source dashes stripped. Omitted for instrumental bars.
- **No durations in the JSON** — timing is interpreter-derived. `chordmark_render.render_chord_line`
  distributes a bar's beats across its chords (largest-remainder, earliest-wins) and emits `.` dots.
- **`chords`** (per song) is an optional, parser-*generated* index `name → [{voicing, confidence}]` — a
  convenience for dictionary rendering, never source of truth.

**Correction workflow:** `validate_extraction.py` assembles a PDF's per-page parses into songs
(stitching across page breaks) under a scratch workdir; `materialize_songs.py` promotes those into a
committed-shape per-song corpus at `data/<artist>/songs/<album>/<NN>-<song>.json` (+ `pages/` PNGs),
migrating old voicings to comma form. `qa_server.py` + `scripts/qa_static/` is a localhost browser tool
to review each song beside its scan and fix name/voicing/lyric; reverse chord detection (tonal.js) is
validated through chord-symbol (the fork's parser), and saves are schema-checked. The song corpus and
page images are git-ignored here (copyright / personal-use song data), but `data/` is its **own
private git repo** — github.com/arthursoares/songsheet-data — versioning the corrected corpus, source
PDFs, and intermediates (page PNGs / rendered HTML excluded as re-derivable). Commit + push there
after meaningful QA sessions; it is the only backup of the hand-corrections.

**Harmonic analysis** (in progress): the pure engine `scripts/harmony.py` (no I/O; event
normalization, voicing→pitch decoding, **notes-first** quality with an ambiguity path, symbol
reconciliation + per-event confidence/discrepancy, cadence-based key with stored-key precedence,
Roman numerals, function classification, device detectors — ii–V(–I), secondary dominants,
tritone subs, chromatic-bass runs, maj7 tonics) feeds `GET /api/harmony` / `POST /api/harmony-doc`
and the QA tool's **Harmony** tab (C1–C4 + the C7 key-confirm edit loop done). Symbol quality is derived by converting the
printed quality text to an interval set and running it through the same `quality_from_pitches`
as the voicing path, so both paths share one naming vocabulary (incl. Brazilian forms: `7+5`,
`7-9`, `13,9`, `479`, trailing `7+`/`7M` = maj7). Remaining: circle-of-fifths (C6),
corpus report (D), prediction (E) — checkboxes in
`docs/superpowers/plans/2026-06-02-harmonic-analysis.md`.

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
`sections`, and accepts optional `note` (free-text QA note) and `status`
(`pending`/`in_progress`/`done`) strings — both written by the QA tool. A chord entry requires
`chord` (string; `%` allowed), with optional `voicing`
(`^(x|\d{1,2})(,(x|\d{1,2})){5}$`, frets 0–24) and `text`; `document`/song/section objects are closed
(`additionalProperties: false`), top-level is open (`_meta` provenance is added there).
`tests/test_schema.py` + `tests/fixtures/chega-page1.json` exercise it.

Data lives per-artist under `data/<artist>/{pdf,png,json,songs,chordmark}/` (only `joao-gilberto`
exists). Docs: `README.md` (user-facing), `PROJECT_STATE.md` (state snapshot), this file, and
`docs/superpowers/` specs + plans — the old February docs were deleted 2026-06-09.
