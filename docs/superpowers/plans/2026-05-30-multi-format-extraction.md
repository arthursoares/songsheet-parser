# Multi-Format Extraction Implementation Plan

> **STATUS UPDATE 2026-06-10:** still not started as a whole, but one building block landed
> ahead of schedule and changes the architecture assumptions below: **`scripts/diagram_reader.py`**
> reads chord diagrams DETERMINISTICALLY from page rasters (~98% print-faithful vs the vision
> model's ~40% exact on voicings — see `eval_extraction.py` + `audit_voicings.py`). For format B
> (Rousseau chord grids) this likely replaces vision for the voicing dots entirely (the plan
> below assumed "vision is still the reliable route for actual frets" — no longer true for
> consistently-typeset diagrams). Any new profile should plan a per-element split: deterministic
> CV for diagram geometry, LLM for lyrics/structure, PDF text layer where present. The reader's
> grayscale bands + horizontal-grid geometry are calibrated to the Lumiar/João-Gilberto
> rendering; new formats need re-calibration (the golden-corpus auto-calibration approach in
> `diagram_digits.json` generalizes).

**Goal:** Extend the PDF → JSON extraction pipeline to support multiple songbook formats via pluggable **format profiles**, normalizing every format into the existing chord-anchored model (`document → songs → sections → bars`, each bar an ordered list of `{chord, voicing?, text?}`). First two new formats: the **Lumiar/Chediak scanned songbook** (Caetano Veloso vol. 1) and the **Christophe Rousseau digital chord-grid arrangement** (Deixar Você).

**Architecture:** Only `parse_songsheet.py`'s prompt is truly format-specific today. Make it a `--format <profile>` selector backed by a profiles registry; add a **spread-splitter** to `extract_pages.py` for two-up scans; add an optional **digital text cross-check** for vector PDFs. The data model, schema, QA tool, renderers, and exports are already format-agnostic and do **not** change. Every output stamps `_meta.format`.

**Tech stack:** Python 3 (existing scripts), the `codex` vision provider (OpenAI gpt-5.5 via ChatGPT/Codex), Pillow for image ops, PyMuPDF (`fitz`) for PDF text/geometry (note: poppler/`pdftotext` is NOT installed on this machine — the existing `extract_pages.py` uses pdf2image/poppler **or** pymupdf; prefer pymupdf for the new text-extraction step). Tests via pytest.

---

## Background: the two sample formats (analyzed 2026-05-30)

Samples live outside the repo (copyright):
- **A** = `…/Songbooks/Caetano Veloso - Volume 1.pdf`
- **B** = `…/Songbooks/Cristophe Rousseau/6DEIXAR_VOCE_V.pdf`

**A — Lumiar/Chediak "Songbook" (Caetano Veloso vol. 1)**
- **Scanned** (0 text layer; each PDF page is one ~4800×3200 JPEG). 54 pages.
- Interior pages are **two-up book spreads** (two printed pages per PDF page).
- Per song, three stacked layers: (1) **chord-diagram boxes** with names + Roman fret positions; (2) a **melody staff** (5-line notation) with chord symbols above; (3) a **chord-over-lyric** block with measure slashes `/`.
- Portuguese lyrics; repeats as `1ª/2ª vez`, `D.C.`; ~45 songs; no machine-readable TOC.
- **Fit:** strong — same class as the João Gilberto pipeline. Chord + voicing + lyric all present. **Ignore the melody staff** (chords there are redundant with the lyric block); melody = OMR = out of scope.

**B — Christophe Rousseau chord-grid arrangement (Deixar Você, in G)**
- **Digital** (XeTeX/`xdvipdfmx`, vector, extractable text). 2 pages, **one song**.
- A grid of **guitar chord-box diagrams in playing order** (voicing dots + Roman fret position + a strum glyph + chord name), grouped under `Intro / Tema / Puente`, with `x2` and `1vez/2vez` repeats.
- **No lyrics, no staff, no TAB.**
- **Fit:** partial — maps to the model as a **voicing + section sequence with empty `text`** (legal; `text` is optional). Great for the diagram/dictionary side of the QA tool; the Lyrics tab would be empty. The text layer gives chord names + section labels in order (high-confidence cross-check); the voicing dots are vector paths, so vision is still the reliable route for actual frets.

---

## File structure

- **Modify** `scripts/parse_songsheet.py` — add `--format/--profile` (default `jg`); look the prompt + options up from the registry; stamp `_meta.format`.
- **Create** `scripts/formats/__init__.py` — `PROFILES` registry + `get_profile(name)`; each profile is a dataclass/dict: `{name, prompt, expects_lyrics, expects_diagrams, language, page_layout: "single"|"spread", text_crosscheck: bool}`.
- **Create** `scripts/formats/jg.py`, `scripts/formats/lumiar.py`, `scripts/formats/chord_grid.py` — one module per profile (prompt string + options). Move the current `PARSE_PROMPT` verbatim into `jg.py`.
- **Modify** `scripts/extract_pages.py` — add `--split-spreads` (detect/forced landscape; cut each page into left/right halves; emit `page-001a.png`, `page-001b.png`, … in reading order).
- **Create** `scripts/pdf_text.py` — pure-ish helper using PyMuPDF: `extract_page_text(pdf, n) -> {text, spans}`; used by the chord-grid cross-check; degrade gracefully if a page has no text layer.
- **Modify** `scripts/validate_extraction.py` — profile-aware (pass `--format` through); for multi-song spreads (A) keep title-header song splitting; B is single-song.
- **No schema change required** (`voicing`/`text` already optional; top-level `_meta` is open). Optional: document `_meta.format`.
- **Tests:** `tests/test_formats.py` (registry: default `jg`, unknown raises, profile carries a prompt), `tests/test_extract_spreads.py` (a wide synthetic image splits into 2 correctly-ordered halves), `tests/test_pdf_text.py` (text extraction returns strings; missing-text page returns empty, no raise).

---

## Tasks

### Task 1: Format-profile registry (refactor, no behavior change)
**Files:** Create `scripts/formats/__init__.py`, `scripts/formats/jg.py`; Modify `scripts/parse_songsheet.py`; Test `tests/test_formats.py`.

- [ ] Move the current `PARSE_PROMPT` text verbatim into `scripts/formats/jg.py` as `PROMPT`, with `OPTIONS = {"expects_lyrics": True, "expects_diagrams": True, "language": "pt", "page_layout": "single", "text_crosscheck": False}`.
- [ ] In `scripts/formats/__init__.py` build `PROFILES = {"jg": ...}` and `get_profile(name)` (raises `KeyError`/`ValueError` with a helpful message listing valid names on miss).
- [ ] In `parse_songsheet.py`: add `--format` (default `"jg"`); fetch the prompt+options from `get_profile`; stamp `doc.setdefault("_meta", {})["format"] = name` on output.
- [ ] **Test:** default profile is `jg`; its prompt is non-empty and equals the old `PARSE_PROMPT`; `get_profile("nope")` raises.
- [ ] **Verify:** re-run an existing JG page end-to-end → identical JSON to before (the refactor is behavior-preserving). Commit.

### Task 2: Spread-splitter in extract_pages (for A)
**Files:** Modify `scripts/extract_pages.py`; Test `tests/test_extract_spreads.py`.

- [ ] Add `--split-spreads`. When set, after rendering each page to an image, if `width > height * 1.2` (landscape ⇒ spread) cut it into left/right halves and write both (`-a`/`-b` suffix), preserving reading order in the output filenames.
- [ ] Factor the cut into a pure function `split_spread(img) -> [left, right]` so it's unit-testable.
- [ ] **Test:** a 2000×1000 synthetic image (left half red, right half blue) → two 1000×1000 halves in correct order. Commit.

### Task 3: `lumiar` profile + smoke test on Caetano (A)
**Files:** Create `scripts/formats/lumiar.py`; Modify `scripts/formats/__init__.py`.

- [ ] Write `lumiar.PROMPT`: same chord-anchored output as `jg`, but tell the model: this is a Brazilian Lumiar/Chediak lead sheet; **read chords from the chord-diagram boxes (name + fingering→voicing comma form) and from the chord-over-lyric block**; **ignore the melody staff entirely**; lyrics are Portuguese with measure slashes `/`; capture section labels (Intro/Tema/Refrão/…) and repeats (`1ª/2ª vez`, `D.C.`) as section labels. `OPTIONS = {expects_lyrics: True, expects_diagrams: True, language: "pt", page_layout: "spread", text_crosscheck: False}`.
- [ ] **Smoke test (manual, billable — for the picker-upper):** `extract_pages.py "<Caetano>.pdf" --split-spreads --output /tmp/cv/png/` then `parse_songsheet.py /tmp/cv/png/page-003*.png --format lumiar --output /tmp/cv/json/`; open the JSON in the QA tool beside the scan and eyeball anchoring/voicing accuracy on 2–3 songs. Iterate the prompt.
- [ ] Decide melody-staff handling stays "ignore". Commit the profile.

### Task 4: `chord_grid` profile + smoke test on Rousseau (B)
**Files:** Create `scripts/formats/chord_grid.py`; Modify registry.

- [ ] Write `chord_grid.PROMPT`: output the chord-anchored model as a **voicing/section sequence** — each box → one entry `{chord, voicing}` (no `text`); group by the printed section labels (Intro/Tema/Puente); one entry per box in playing order; bars: put one entry per bar OR group per the visual rows (keep simple; the picker-upper can refine). `OPTIONS = {expects_lyrics: False, expects_diagrams: True, language: "mixed", page_layout: "single", text_crosscheck: True}`.
- [ ] **Smoke test:** render `6DEIXAR_VOCE_V.pdf` pages and parse with `--format chord_grid`; eyeball voicings + section grouping in the QA tool (Lyrics tab will be empty — expected).
- [ ] Commit.

### Task 5: Digital text cross-check (optional, improves B)
**Files:** Create `scripts/pdf_text.py`; Modify `parse_songsheet.py` (use it when `text_crosscheck` and the PDF has a text layer).

- [ ] `pdf_text.extract_page_text(pdf_path, page_index)` via PyMuPDF → `{text, spans:[{text,bbox}]}`; empty result (no raise) when there's no text layer.
- [ ] When a profile has `text_crosscheck: True` and the source is digital, pass the extracted chord-name/section tokens to the vision prompt (or post-validate the vision output's chord names/labels against them), flagging mismatches in `_meta`.
- [ ] **Test:** extraction returns expected tokens on a tiny digital fixture; returns `""`/`[]` on an image-only page. Commit.

### Task 6: Wire through validate/materialize + docs
- [ ] `validate_extraction.py`: accept/pass `--format`; A is multi-song-per-spread (keep title-header splitting); B is single-song (trivial). Stamp `_meta.format` end-to-end.
- [ ] Update README/CLAUDE: document `--format` profiles, `--split-spreads`, and the per-artist convention (`data/<artist>/…`, with format recorded in `_meta`). Commit.

---

## Open decisions (for the picker-upper)

1. **Voicing-only arrangements (B) in the main corpus?** They have no lyrics — useful for the diagram/dictionary/Review side, but the Lyrics/Preview-lyrics features stay empty. Either keep them in the same corpus (fine) or a separate `data/<artist>/arrangements/` area.
2. **Repeats** (`1ª/2ª vez`, `D.C.`, `x2`): captured as free-text section labels now; a structured repeats field is a later model/schema extension if you want playback-accurate expansion.
3. **Spread splitting** heuristic vs. forced (`--split-spreads` always vs. auto-detect by aspect ratio) — A's interior pages are landscape spreads but the cover is not; auto-detect by aspect ratio handles both.
4. **Melody staff (A):** ignored (chords are redundant with the lyric block). Revisit only if melody capture is ever wanted (that's OMR — separate effort).
5. **Chord-grid bar grouping (B):** one entry per box vs. grouping boxes into bars by the printed rhythm — start with one-per-bar and refine.

## Out of scope
Full guitar **TAB** and piano/guitar **staff (OMR)** — different problem from chord-charts; not handled by this model.
