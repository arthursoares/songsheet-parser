# Songsheet Parser

Convert scanned songbook pages (chord charts with diagrams) into structured, machine-readable formats.

## Pipeline

```
PDF → extract_pages → PNG → parse_songsheet → JSON → [QA correction tool] → json_to_chordmark → ChordMark
                            (OpenAI vision)            (browser review/fix)
```

Chord↔lyric anchoring is intrinsic to the JSON (no separate alignment stage). Vision
extraction is imperfect (chord names, fingerings, lyrics), so a browser-based QA tool lets
you review each song beside its scan and correct it before converting.

## Structure

```
├── scripts/        # Processing pipeline + QA server + pure render/analysis modules
│   └── qa_static/  # Browser QA tool (pure JS, no build step)
├── schemas/        # JSON validation schemas
├── docs/
│   └── superpowers/  # Design specs + implementation plans (current)
├── tests/          # pytest suite
└── data/
    └── {artist}/
        ├── pdf/ png/   # Source scans (git-ignored, copyright)
        ├── json/       # Intermediate parsed documents
        ├── songs/      # Per-song QA corpus + page images (git-ignored)
        └── chordmark/  # Converted .chordmark output
```

## Supported Output

- **JSON** — Intermediate, chord-anchored format for review/correction. A document holds
  songs → sections → bars, where a bar is an ordered array of `{chord, voicing?, text?}`
  entries (entry order anchors each chord to its lyrics; `%` = chord continues; voicing is
  per-occurrence). See `docs/superpowers/specs/2026-05-28-songsheet-data-model-design.md`.
- **[ChordMark](https://chordmark.netlify.app/)** — Encodes rhythm, lyrics, chord positions.
  One `.chordmark` file is written per song.
- **Lead sheet / ChordPro** — the QA tool can also export a polished lead sheet (PDF/PNG/HTML) or
  a `.chordpro` file per song, plus a whole-album songbook PDF (see the QA tool section).

## Setup

```bash
python3 -m venv .venv && ./.venv/bin/pip install --group dev
codex login          # default vision provider uses your ChatGPT/Codex subscription
./.venv/bin/python -m pytest    # run the test suite
```

Optional, for the ChordMark-fork render style: clone
[arthursoares/chord-mark](https://github.com/arthursoares/chord-mark) (adds inline chord
diagrams + comma-form voicings to upstream ChordMark) as a sibling at `../chordmark/chord-mark`
and have Node installed. For server API PDF/PNG export, use `chrome-headless-shell` or
`chromium-headless-shell` on `PATH`, or set `SONGSHEET_CHROME_BIN` to a separate headless renderer.

## Run QA with Docker

CI builds and smoke-tests the QA image on Linux amd64 and arm64. Successful
builds on `main` publish to the public `ghcr.io/arthursoares/songsheet-qa`
package using the built-in GitHub Actions token. Use `latest` or the
`sha-<commit>` tag to pin a release. Docker can pull the image anonymously.

Run these commands from the repository checkout.

```sh
export LIBRARY_PATH=/absolute/path/to/joao-gilberto
docker compose pull
docker compose up -d
```

`LIBRARY_PATH` must contain the existing `songs/` and `pdf/` directories. Open
[QA on port 18491](http://127.0.0.1:18491/) on the Docker host. Set `QA_PORT`
to remap the host port, or `QA_IMAGE` to select a release.

The container runs as UID/GID 1000. Give that user write access to `songs/` so
**Save song** and Shapes batches can write each chart. The PDFs are mounted
read-only. The named `qa-state` volume keeps caches and the Shapes undo
journal across container replacement. Use a separate Compose project (for
example, `docker compose -p sheets-test`) for a different library so it has its
own state. Run one writing instance per library.

For the optional review overlay, mount the local reading report directory.

```sh
export QA_PROPOSALS_PATH=/absolute/path/to/reading-report
docker compose -f compose.yaml -f compose.proposals.yaml up -d
```

The image bundles the ChordMark runtime for **Chord Chart**. Review runs with
the mounted library and needs no extraction credentials. Run vision extraction
separately when you want a new reading report.

On a remote host, an SSH tunnel can forward the loopback-only port
(`ssh -N -L 18491:127.0.0.1:18491 user@host`). If you use an authenticated
reverse proxy instead, set `QA_ALLOWED_ORIGINS` to the exact browser origin
(for example, `https://songs.example.net`). The origin setting validates browser
writes. Put authentication at the proxy.

For a local build, run `docker build -t songsheet-qa:local .` and start
Compose with `QA_IMAGE=songsheet-qa:local docker compose up -d --pull never`.

## Usage

Run scripts with the project venv (`./.venv/bin/python`).

```bash
# 1. Extract pages from a PDF (uses PyMuPDF; no poppler needed)
python scripts/extract_pages.py songbook.pdf --output data/<artist>/png/

# 2. Parse pages to chord-anchored JSON (default provider: codex / OpenAI gpt-5.5)
python scripts/parse_songsheet.py data/<artist>/png/*.png --output data/<artist>/json/

# 3. Convert JSON to ChordMark (one .chordmark per song)
python scripts/json_to_chordmark.py data/<artist>/json/ --output data/<artist>/chordmark/
```

Extraction retains immutable source readings beside editable entries. All parsing commands
share content/settings-based cache checks and preserve historical JSON snapshots; `--force`
requests a new attempt. See [provenance and candidate runs](docs/extraction-provenance.md).

### Validating a whole PDF

`validate_extraction.py` renders → parses → assembles a PDF's pages into songs, schema-validates,
and reports structural issues (per-page JSON is cached under a workdir for resumable runs):

```bash
python scripts/validate_extraction.py "data/<artist>/pdf/Album.pdf" \
  --workdir /tmp/ssv --report-json /tmp/report.json
```

### Extraction evaluation

For a reproducible benchmark, freeze explicit whole-song development and held-out splits. Each
reference records its content hash, label type, and review provenance. Creation and scoring require
every `human_reviewed` reference to have canonical `document.status=done`, verify every hash, and
refuse other label types. The CLI label flag therefore cannot promote a pending song to ground
truth.

```bash
python scripts/extraction_benchmark.py create \
  --golden data/<artist>/songs \
  --development <album/dev-song.json> \
  --held-out <album/held-out-song.json> \
  --label-type human_reviewed \
  --review-provenance "manual comparison with source scans by <reviewer>" \
  --output benchmark.json

python scripts/extraction_benchmark.py score \
  --manifest benchmark.json \
  --golden data/<artist>/songs \
  --candidate /tmp/fresh-parse/songs \
  --split held_out \
  --voicing-reference printed \
  --candidate-voicing-field voicing_printed \
  --report-json /tmp/held-out-report.json
```

Repeat `--development` or `--held-out` for each song. `printed` selects the reference's explicit
`voicing_printed` field; `editorial` selects `voicing`. Candidate scoring defaults to `voicing`;
choose `--candidate-voicing-field voicing_printed` for fresh CV proposals. Both selected fields
are recorded in the report, and missing CV proposals count against recovery.
The `done` status is the editorial song-review gate; it does not independently certify that the
CV-derived `voicing_printed` values were checked by a person. Printed scoring requires a current
**Printed diagrams** field review in the gold document's Review tab; manifest provenance text
alone is insufficient. Explicit stale or incomplete required field checks also prevent a `done`
document from becoming benchmark ground truth. Manifests are create-only and belong outside the
golden corpus.
The report includes chord precision and recall plus voicing and text recovery over all applicable
truth events. Compatibility keys (`chord_acc`, `voicing_acc`, `text_acc`, `spelling_acc`, and
`anchor_acc`) remain, with their conditional denominators named in `metric_denominators`. Missing
candidate songs count as misses, while extra candidate files appear under coverage and do not
enter accuracy calculations.

`eval_extraction.py score` remains useful for exploratory checks based on corpus status. A song
used while tuning the parser is calibration data; its score is not evidence of historical reader
accuracy. Report generalization only from an untouched, human-reviewed held-out split.

### Repeated chord disagreements

Find guitar-fingering disagreements that recur across songs and review representative
source crops. The standalone HTML ranks groups by affected songs and highlights the
strings that differ between the current chart and the recorded diagram reading.

```sh
.venv/bin/python scripts/repeated_chord_review.py \
  --songs data/joao-gilberto/songs --pdfs data/joao-gilberto/pdf \
  --out .local/repeated-chords.html
```

The report uses exact fingering pairs and preserves each occurrence's label. It
excludes `-qa-` copies from the counts. Crops are optional and include their pairing
basis. Keep reports with embedded scan crops in the ignored `.local/` directory.

In QA, open **Shapes** for a library-wide view indexed from the PDF diagrams.
The first index can take a minute. Search for a chord or song to find matching shapes,
and use the album selector to narrow which occurrences appear. Exact groups use the
decoded string states, dot positions, and the visually resolved base fret.

Review the source crops and use **Edit fingering to apply** to adjust the proposed
fingering. Enter a **Chord name** to rename the selected entries, or leave it blank
to keep each chart's name. The occurrence list previews the result and identifies
name and fingering conflicts. Select the chart entries to update and check the
affected files before applying. Saved edits appear in the selected songs, and the
latest applied fingering is offered the next time you open that shape. Entries whose
base fret is unresolved are available for individual inspection. **Undo most recent
batch** restores the prior files when their saved revisions still match. The index
cache and undo journal live under `.local/shapes/`.

### QA correction tool (browser)

Review each extracted song beside its scanned pages and fix chord names, fingerings, and lyrics.

```bash
# one-time: promote assembled docs into a per-song corpus with page images
python scripts/materialize_songs.py --workdir /tmp/ssv --out data/<artist>/songs

# launch the local review server, then open http://localhost:8000
python scripts/qa_server.py --songs data/<artist>/songs
```

Materialization refuses to replace existing song files or copied page images. For a new
extraction, use a fresh `--out` directory so the candidates can be compared with your corrections.
Add `--overwrite`
only when intentionally replacing existing songs and their copied page images; unsupported
schema versions are refused even with this flag.

QA saves, materialization, the voicing audit, and lyric migration share schema/version
validation and atomic JSON writes. A failed write leaves the previous JSON intact. This is
per-file protection: an album is not saved as one transaction, and simultaneous edits are
not merged.

The window has three columns: a **song-list sidebar** (left), the **scanned pages** (middle), and
the **editor tabs** (right).

The **sidebar** lists every song in the current album with a status badge, a search box, and a
status filter (All / Pending / In progress / Done). Click a song to load it (guarded by an
unsaved-changes confirm); the current song is highlighted. The sidebar footer shows the song's
**provenance** (source pages plus source/reading counts) and a free-text **per-song note** that
persists with the song.

The right column has seven tabs:

- **Bars** — chord chips in reading order, each showing name / voicing / a small chord-diagram
  thumbnail / notes / intervals. Click a chip to edit its **name**, **voicing** (clickable
  fretboard *or* type `x,5,7,5,6,x`), and **lyric**; **← →** move a chord to the adjacent bar.
  Reverse chord detection ([tonal.js](https://github.com/tonaljs/tonal)) suggests names,
  validated through ChordMark's parser ([chord-symbol](https://github.com/no-chris/chord-symbol));
  a red dot flags name↔voicing mismatches. Also supports **structural editing**: add/delete a bar,
  split/merge a bar, add/delete a section, and inline section-label rename.
  Use **Split before** or **Split after** in the chord editor to set the boundary around
  the selected chord. **+ before** and **+ after** insert an empty bar beside that bar.
  Both operations keep the same chord selected.
- **Lyrics · Flow** shows continuous lyrics with chords above their syllables, joining
  continued words across bars and unlabelled sections. **Arrange** retains the bar
  grid and offers bar starts as drop targets. Drag a chord to a lyric, or select the
  chord and click its destination. Double-click a lyric to edit it. The scan follows
  the selected chord where source links are available. **Text** mode edits whole lyric
  lines using ChordMark anchors.
- **Verification** — records separate whole-song review states for **Structure**, **Chord names**,
  **Lyrics**, **Editorial voicings**, **Printed diagrams**, and **Key**, with reviewer and evidence.
  Verification is bound to the reviewed field values and their structural positions; later edits
  display that field as stale. A key can be verified only when a supported major/minor key is
  explicitly stored. Recording is undoable and remains in memory until **Save song**. This does
  not automatically mark the legacy document status done. The flagged-chord worklist remains
  below the field table; click a row to jump to its editor.
- **Dictionary** — the song's distinct chords grouped by (name + voicing), alphabetical or by
  count; batch-edit a chord across all its occurrences, or merge two groups that are the same
  chord misread two ways.
- **Harmony** — live harmonic analysis of the current edits (see the Harmonic analysis
  section below).
- **Preview** — renders the song (see below), with in-app export.
- **JSON** — a [CodeMirror 5](https://codemirror.net/5/) code editor over the song's raw JSON:
  Tab indents (2-space soft tabs), JSON syntax coloring, and live validation (parse errors show
  line/col plus a lint gutter marker). **Apply** parse-guards the text and pushes it onto the
  model (undoable); **Format** pretty-prints and **Reload** re-reads from the in-memory model.
  CodeMirror is vendored under `qa_static/vendor/codemirror/`.

Header controls: **key** selector (drives Roman-numeral interval analysis, major or minor),
**♯/♭** spelling toggle, per-song **status** (pending / in progress / done) with an album
progress count, and **layout focus toggles** (**☰ songs** / **⊞ scan**) that collapse the song
list and/or the scanned-pages pane when you want the full width for one tab. **Save** writes
schema-validated JSON back to disk. Edits support **undo/redo**, and a dirty-state guard warns
before navigating away or switching songs with unsaved edits.

**Keyboard shortcuts** · ⌘S/Ctrl+S save · Esc close editor · `n`/`p` next/previous song ·
`[`/`]` previous/next chord · `{`/`}` previous/next flagged chord · `\` toggle the scan pane ·
Enter applies in the chord editor ·
⌘Z/Ctrl+Z undo · ⌘⇧Z/Ctrl+Y redo.

In **Bars** and **Chord review**, use `h`/`l` or ←/→ to step through chords, and
`j`/`k` or ↓/↑ to step through bars. Shift+←/→ jumps between flags. Shift+`h`/`l`
reorders the selected chord within its bar, and Shift+`j`/`k` moves it to the
next/previous bar. Press `1`–`4` to apply the corresponding chord-name suggestion.
Press `?` or `/` to open the shortcut reference.

In the chord editor, **Apply** also marks the resulting chord reviewed. In
**Bars** and **Chord review**, press `R` to mark a selected chord reviewed and
stay on it, or Space to mark it reviewed and advance.
In Bars, Space applies the current draft before advancing. Press `A` to use the
printed fingering while applying the draft. Enter applies edits in the chord name
or anchored lyric field.

**Chord review** hides the song list and focuses the selected chord in the chord list.
Press `A` to use the printed fingering and mark the chord reviewed, or `S` to defer.
Each advances to the next chord.
**Save song** stores those decisions with the chord. Editing a reviewed chord name,
fingering, or linked source makes the decision stale. In the same browser, Chord
Review remembers the last selected chord for each song.

The scan follows the selected chord to its recorded source page. When the source
diagram has a recorded location, the scan shows the chord's review state and lets
you click the diagram to select the chord. The selected outline keeps the chord's
review color. Older charts highlight exact-count or unambiguous ordered scan matches
tied to the saved song revision.

Pass `--reading-proposals <local-run-directory>` to the QA server to display provisional
positions and supported fingering suggestions from a library reading run. The overlay
checks both the song revision and the PDF fingerprint. **Use proposed fingering** loads
the suggestion into the chord editor, where it can be inspected and applied.
Turn on **Show edits** to see corrected chord names, voicing and lyric changes, and
new bar starts at their source positions. Select a chord to compare **As extracted**
with **Current**. Dashed badges track unsaved edits and become solid after saving.

### Preview & export

The **Preview** tab renders a live view of the **current in-memory edits** (no Save required), in
either of two styles, by POSTing the document to `POST /api/render-doc?style=<fork|target>`:

- **Chord Chart** — through Arthur's ChordMark fork. Requires Node and the installed fork toolchain
  at `../chordmark/chord-mark`, or a workspace-local copy at `.local/chordmark-runtime`.
- **Lead Sheet** — a polished lead sheet (centered title, alphabetical diagram dictionary, two-column
  chord-over-syllable body, Roman fret positions, barres, `°` for diminished). Pure Python, no
  fork needed. The dictionary can group entries per voicing or per name.

Choose **Dictionary**, **Inline**, or **Both** from the Diagrams menu. Either renderer
accepts `diagrams=dictionary|inline|both` and `bars=4|6|8`.

If Chord Chart cannot render, Preview shows the built-in Lead Sheet and keeps your style selection.

**Bars per line** counts measures, including measures with several chord symbols.
Named sections and the end of a song can have a shorter final row. Chord Chart
preserves blank measures and crowded bars when rendering the preview.

A **Source** toggle shows the generated `.chordmark` text (also for the current edits, via
`POST /api/chordmark-doc`) beside the render.

**In-app export** uses the current Preview, including unsaved edits. **Print / Save PDF** opens
the browser print dialog and **Export PNG** captures the full chart in the same browser.
HTML, ChordMark, and ChordPro download directly. **Print saved album** builds a songbook from
the saved songs. The server API can use a separate headless renderer configured with
`SONGSHEET_CHROME_BIN`.

`scripts/render_chordmark.js` renders a `.chordmark` file to standalone HTML via the fork if you
want that path outside the server.

### Harmonic analysis (Harmony tab)

The project's original purpose: a pure analysis engine, `scripts/harmony.py` (no I/O, fully
unit-tested), turns a song into an annotated harmonic stream. Per chord event it derives:

- **Quality, notes-first** — decoded from the voicing's actual pitches, so alterations survive
  (`A7+5` → `7♯5`); when the notes are under-determined (no 3rd, rootless) it says `ambiguous`
  and falls back to the printed symbol rather than guessing. Symbol text is converted to an
  interval set and run through the *same* naming function, so the two paths share one vocabulary
  (including Brazilian forms: `7-9`, `m7/9`, `13,9`, `69`, `479`, trailing `7+`/`7M` = maj7).
- **Key** — the stored key when present, else a cadence-based estimate (the pitch most targeted
  by V→I / ii–V–I resolutions; Krumhansl correlation only as a cross-check, since it favors the
  relative minor on bossa).
- **Roman numeral + harmonic function** (tonic / subdominant / dominant / secondary / passing /
  chromatic) with the rule that fired as a human-readable "why".
- **Devices** — ii–V(–I), secondary dominants (only on a real down-a-fifth resolution), tritone
  substitutions, chromatic descending-bass runs, maj7 tonics, and tonicization spans.
- **Confidence** per event (notes↔symbol disagreements surface as flagged discrepancies — which
  also catches real extraction errors worth fixing).

The **Harmony** tab renders this live for the current (unsaved) edits: function-colored chord
cells with Roman numerals and lyrics, tension/bass/tonicization lanes, device brackets with
explanatory tooltips, spotlight chips that dim everything but one function or device, and a
click panel (chord diagram, why, confidence) with an **Edit chord →** jump straight into the
Bars editor. An inline bar proposes the estimated key (**Confirm key** stores it on the song,
undoably). A **player** (▶ + tempo) plays the voicings using inferred timing with a gliding
playhead (four beats per bar by default; this is not recorded-performance timing).
**Export** buttons download the analysis as **JSON**, **CSV** (one row per chord
event), or a standalone **HTML** snapshot. **Print / Save PDF** opens the browser print dialog.

Server endpoints: `GET /api/harmony/<album>/<file>`, `POST /api/harmony-doc` (in-memory doc),
`POST /api/convert?fmt=pdf|png` (HTML → file). Roadmap (corpus-wide reports, prediction):
`docs/superpowers/plans/2026-06-02-harmonic-analysis.md`.

### Lyric hyphenation

Lyrics carry word-continuation dashes (`tris- te- za e`) for proper lead-sheet rendering. New
parses preserve the dashes the songbook prints; seed existing songs with:

```bash
python scripts/migrate_hyphenation.py data/<artist>/songs/   # LLM-seeded, idempotent
```

## Voicing format

A fingering is 6 comma-separated strings, low‑E→high‑e, each `x` (muted) or a fret number
**0–24**: `x,5,7,5,6,x`. The ChordMark converter renders these as inline voicings
(`Name[...]`, frets 10–24 → letters `a`–`o`) for Arthur's ChordMark fork.

## Artists

- `joao-gilberto/` — João Gilberto songbook (in progress)

## License

Tool is open. Song data is for personal use only — original songsheets are copyrighted.
