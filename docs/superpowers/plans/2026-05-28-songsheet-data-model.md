# Songsheet Data Model Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the songsheet JSON model with a chord-anchored model (a bar is an ordered array of `{chord, voicing?, text?}` entries) and rewrite the schema, vision parse prompt, and ChordMark converter to use it.

**Architecture:** Vision parsing (OpenAI via Codex, default `gpt-5.5`) emits the new hierarchy `document → songs → sections → bars → chord-entry[]`. Chord↔text anchoring is intrinsic to entry order (no `at_syllable` lookup). Timing is interpreter-derived in the converter (no `beats` in the data). Voicing is per-occurrence, rendered as ChordMark inline voicing `Name[xxxxxx]`. The separate `add_positions.py` stage is removed.

**Tech Stack:** Python 3.14 (project `.venv`), `pytest`, `jsonschema`, `openai` (Codex backend via `scripts/codex_client.py`), `pymupdf`/`pdf2image` for rendering.

**Spec:** `docs/superpowers/specs/2026-05-28-songsheet-data-model-design.md`

---

## File structure

| File | Responsibility | Action |
|------|----------------|--------|
| `requirements.txt` | add `pytest`, `jsonschema` | Modify |
| `schemas/songsheet.schema.json` | new chord-anchored JSON Schema | Rewrite |
| `tests/conftest.py` | pytest path setup so `scripts/` is importable | Create |
| `tests/test_schema.py` | schema accepts valid / rejects invalid docs | Create |
| `tests/fixtures/chega-page1.json` | hand-built valid sample (page 1) | Create |
| `scripts/chordmark_render.py` | pure model→ChordMark string functions (no I/O) | Create |
| `tests/test_chordmark_render.py` | unit tests for rendering rules | Create |
| `scripts/json_to_chordmark.py` | CLI wrapper over `chordmark_render` for new model | Rewrite |
| `scripts/parse_songsheet.py` | new prompt + new output shape | Modify |
| `scripts/add_positions.py` | delete (absorbed into stage 1) | Delete |

**Decomposition rationale:** rendering logic (the part with real rules to test — beat distribution, `%`, inline voicings, `_` anchoring) is split into a pure, I/O-free module `chordmark_render.py` so it can be unit-tested without files or API calls. `json_to_chordmark.py` becomes a thin CLI shell. The schema is locked first (it's the contract every other piece depends on).

---

## Task 1: Add test + validation dependencies

**Files:**
- Modify: `requirements.txt`

- [ ] **Step 1: Add deps to requirements.txt**

Add these lines under the `# Core` section of `requirements.txt`:

```
jsonschema>=4.0        # validate songsheet JSON against schema
pytest>=8.0            # test runner
```

- [ ] **Step 2: Install into the project venv**

Run: `./.venv/bin/pip install jsonschema pytest`
Expected: ends with `Successfully installed ... jsonschema-... pytest-...`

- [ ] **Step 3: Verify import**

Run: `./.venv/bin/python -c "import jsonschema, pytest; print('ok')"`
Expected: `ok`

- [ ] **Step 4: Commit**

```bash
git add requirements.txt
git commit -m "build: add pytest and jsonschema dependencies"
```

---

## Task 2: pytest bootstrap (conftest)

**Files:**
- Create: `tests/conftest.py`
- Create: `tests/__init__.py` (empty)

- [ ] **Step 1: Create empty package marker**

Create `tests/__init__.py` with no content (empty file).

- [ ] **Step 2: Create conftest so `scripts/` is importable**

Create `tests/conftest.py`:

```python
"""Pytest setup: make scripts/ importable as top-level modules."""
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
```

- [ ] **Step 3: Verify pytest collects nothing yet without error**

Run: `./.venv/bin/python -m pytest -q`
Expected: `no tests ran` (exit code 5) — confirms pytest runs and conftest imports cleanly.

- [ ] **Step 4: Commit**

```bash
git add tests/__init__.py tests/conftest.py
git commit -m "test: add pytest bootstrap with scripts/ on path"
```

---

## Task 3: New JSON Schema

**Files:**
- Rewrite: `schemas/songsheet.schema.json`
- Create: `tests/fixtures/chega-page1.json`
- Create: `tests/test_schema.py`

- [ ] **Step 1: Write the valid fixture**

Create `tests/fixtures/chega-page1.json` (a minimal valid document — page 1 first sung system, abbreviated):

```json
{
  "document": {
    "title": "Chega de Saudade",
    "source_pdf": "1 - Chega de Saudade.pdf",
    "page_count": 28
  },
  "songs": [
    {
      "title": "Chega de Saudade",
      "composers": ["Tom Jobim", "Vinícius de Moraes"],
      "pages": [1],
      "key": "Dm",
      "chords": {
        "Dm7": [{ "voicing": "x5756x", "confidence": 0.7 }],
        "Bdim7": [{ "voicing": "x7878x", "confidence": 0.7 }]
      },
      "sections": [
        {
          "label": null,
          "bars": [
            [{ "chord": "Gm7/9", "voicing": "3x332x" }],
            [{ "chord": "%" }],
            [{ "chord": "Dm7", "voicing": "x5756x", "text": "Vai mi nha" }],
            [{ "chord": "%", "text": "tris" }],
            [
              { "chord": "Em7", "voicing": "020030", "text": "te za e" },
              { "chord": "A13", "voicing": "x02022", "text": "di za" }
            ]
          ]
        }
      ]
    }
  ]
}
```

- [ ] **Step 2: Write the failing schema test**

Create `tests/test_schema.py`:

```python
import json
from pathlib import Path

import jsonschema
import pytest

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_PATH = ROOT / "schemas" / "songsheet.schema.json"
FIXTURE = ROOT / "tests" / "fixtures" / "chega-page1.json"


def load_schema():
    return json.loads(SCHEMA_PATH.read_text())


def test_valid_document_passes():
    schema = load_schema()
    doc = json.loads(FIXTURE.read_text())
    jsonschema.validate(doc, schema)  # raises on failure


def test_chord_entry_requires_chord():
    schema = load_schema()
    doc = json.loads(FIXTURE.read_text())
    # bar entry missing the required "chord" key
    doc["songs"][0]["sections"][0]["bars"][0] = [{"voicing": "x5756x"}]
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(doc, schema)


def test_voicing_must_be_six_chars():
    schema = load_schema()
    doc = json.loads(FIXTURE.read_text())
    doc["songs"][0]["sections"][0]["bars"][0] = [{"chord": "Dm7", "voicing": "xx"}]
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(doc, schema)


def test_percent_continuation_is_valid_chord():
    schema = load_schema()
    doc = json.loads(FIXTURE.read_text())
    doc["songs"][0]["sections"][0]["bars"][0] = [{"chord": "%"}]
    jsonschema.validate(doc, schema)  # must not raise
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `./.venv/bin/python -m pytest tests/test_schema.py -v`
Expected: FAIL — the old schema is still in place, so `test_valid_document_passes` errors (old schema requires `source`/`title`/`bars` at top level).

- [ ] **Step 4: Rewrite the schema**

Replace the entire contents of `schemas/songsheet.schema.json` with:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Songsheet Document",
  "description": "Chord-anchored songsheet model: document -> songs -> sections -> bars -> chord entries",
  "type": "object",
  "required": ["document", "songs"],
  "additionalProperties": true,
  "definitions": {
    "voicing": {
      "type": "string",
      "pattern": "^[0-9x]{6}$",
      "description": "6 chars low-E to high-e: x=muted, 0=open, or fret digit"
    },
    "chordEntry": {
      "type": "object",
      "required": ["chord"],
      "additionalProperties": false,
      "properties": {
        "chord": {
          "type": "string",
          "description": "Chord name, or '%' for measure-repeat (continued chord)"
        },
        "voicing": { "$ref": "#/definitions/voicing" },
        "text": {
          "type": "string",
          "description": "Syllables sung from this chord's onset, dashes stripped"
        }
      }
    },
    "bar": {
      "type": "array",
      "description": "A bar is an ordered array of chord entries",
      "items": { "$ref": "#/definitions/chordEntry" }
    },
    "voicingIndexEntry": {
      "type": "object",
      "required": ["voicing"],
      "additionalProperties": false,
      "properties": {
        "voicing": { "$ref": "#/definitions/voicing" },
        "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
      }
    }
  },
  "properties": {
    "document": {
      "type": "object",
      "required": ["title"],
      "properties": {
        "title": { "type": "string" },
        "source_pdf": { "type": "string" },
        "page_count": { "type": "integer", "minimum": 1 }
      }
    },
    "songs": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["title", "sections"],
        "properties": {
          "title": { "type": "string" },
          "composers": { "type": "array", "items": { "type": "string" } },
          "pages": { "type": "array", "items": { "type": "integer" } },
          "key": { "type": ["string", "null"] },
          "chords": {
            "type": "object",
            "description": "Optional, parser-generated index: name -> distinct voicings seen",
            "additionalProperties": {
              "type": "array",
              "items": { "$ref": "#/definitions/voicingIndexEntry" }
            }
          },
          "sections": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["bars"],
              "properties": {
                "label": { "type": ["string", "null"] },
                "bars": {
                  "type": "array",
                  "items": { "$ref": "#/definitions/bar" }
                }
              }
            }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `./.venv/bin/python -m pytest tests/test_schema.py -v`
Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add schemas/songsheet.schema.json tests/test_schema.py tests/fixtures/chega-page1.json
git commit -m "feat: chord-anchored songsheet JSON schema"
```

---

## Task 4: Render a bar's chord line (beat distribution + %)

**Files:**
- Create: `scripts/chordmark_render.py`
- Create: `tests/test_chordmark_render.py`

This task builds `render_chord_line(bar)`: given one bar (array of entries), produce the ChordMark chord-line token string. Rules from the spec: one chord → bare name; N chords → distribute `beat_count` (default 4) across them with `.` dots using largest-remainder rounding; `%` entry → literal `%`; inline voicing appended as `Name[voicing]`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_chordmark_render.py`:

```python
import chordmark_render as cm


def test_single_chord_fills_bar_no_dots():
    bar = [{"chord": "Dm7"}]
    assert cm.render_chord_line(bar) == "Dm7"


def test_single_chord_with_voicing_is_inline():
    bar = [{"chord": "Dm7", "voicing": "x5756x"}]
    assert cm.render_chord_line(bar) == "Dm7[x5756x]"


def test_percent_renders_as_percent():
    bar = [{"chord": "%"}]
    assert cm.render_chord_line(bar) == "%"


def test_two_chords_split_evenly():
    bar = [{"chord": "Em7"}, {"chord": "A13"}]
    assert cm.render_chord_line(bar) == "Em7.. A13.."


def test_three_chords_largest_remainder_sums_to_four():
    bar = [{"chord": "A"}, {"chord": "B"}, {"chord": "C"}]
    # 4 beats / 3 -> 2,1,1 (largest remainder gives the extra beat to the first)
    assert cm.render_chord_line(bar) == "A.. B. C."


def test_four_chords_one_beat_each():
    bar = [{"chord": "A"}, {"chord": "B"}, {"chord": "C"}, {"chord": "D"}]
    assert cm.render_chord_line(bar) == "A. B. C. D."
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./.venv/bin/python -m pytest tests/test_chordmark_render.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'chordmark_render'`.

- [ ] **Step 3: Implement `render_chord_line`**

Create `scripts/chordmark_render.py`:

```python
"""Pure functions converting the chord-anchored songsheet model to ChordMark text.

No file or network I/O — all functions take plain dicts/lists and return strings,
so they are directly unit-testable.
"""

DEFAULT_BEATS = 4
PERCENT = "%"


def _chord_token(entry):
    """Render one chord entry's name with optional inline voicing (no dots)."""
    name = entry["chord"]
    voicing = entry.get("voicing")
    if voicing:
        return f"{name}[{voicing}]"
    return name


def _distribute_beats(n, beats):
    """Split `beats` across `n` chords using largest-remainder rounding.

    Returns a list of n positive integers summing to `beats`.
    """
    base = beats // n
    remainder = beats - base * n
    # give one extra beat to the first `remainder` chords (largest-remainder,
    # earliest-wins for the equal fractional parts produced by an even division)
    return [base + 1 if i < remainder else base for i in range(n)]


def render_chord_line(bar, beats=DEFAULT_BEATS):
    """Render one bar (list of chord entries) to a ChordMark chord-line string."""
    if len(bar) == 1:
        entry = bar[0]
        if entry["chord"] == PERCENT:
            return PERCENT
        return _chord_token(entry)

    durations = _distribute_beats(len(bar), beats)
    tokens = []
    for entry, dur in zip(bar, durations):
        tokens.append(_chord_token(entry) + "." * dur)
    return " ".join(tokens)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./.venv/bin/python -m pytest tests/test_chordmark_render.py -v`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/chordmark_render.py tests/test_chordmark_render.py
git commit -m "feat: render bar chord line with beat distribution and inline voicings"
```

---

## Task 5: Render a section's lyric line with `_` anchors

**Files:**
- Modify: `scripts/chordmark_render.py`
- Modify: `tests/test_chordmark_render.py`

Build `render_lyric_line(bar)`: for a bar whose entries carry `text`, produce the ChordMark lyric line where each chord's text is prefixed with `_` (the position marker). A bar with no `text` on any entry yields `None` (no lyric line emitted).

- [ ] **Step 1: Add failing tests**

Append to `tests/test_chordmark_render.py`:

```python
def test_lyric_line_anchors_each_chord_text():
    bar = [
        {"chord": "Dm7", "text": "Vai mi nha"},
        {"chord": "Bdim7", "text": "tris"},
    ]
    assert cm.render_lyric_line(bar) == "_Vai mi nha _tris"


def test_lyric_line_none_when_no_text():
    bar = [{"chord": "Gm7/9"}, {"chord": "%"}]
    assert cm.render_lyric_line(bar) is None


def test_lyric_line_percent_entry_with_text():
    bar = [{"chord": "%", "text": "tris"}]
    assert cm.render_lyric_line(bar) == "_tris"


def test_lyric_line_skips_missing_text_entries():
    bar = [{"chord": "Dm7", "text": "Vai"}, {"chord": "A7"}]
    # entry without text contributes no anchor
    assert cm.render_lyric_line(bar) == "_Vai"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./.venv/bin/python -m pytest tests/test_chordmark_render.py -k lyric -v`
Expected: FAIL with `AttributeError: module 'chordmark_render' has no attribute 'render_lyric_line'`.

- [ ] **Step 3: Implement `render_lyric_line`**

Add to `scripts/chordmark_render.py`:

```python
def render_lyric_line(bar):
    """Render the `_`-anchored lyric line for a bar, or None if no entry has text."""
    parts = []
    for entry in bar:
        text = entry.get("text")
        if text:
            parts.append("_" + text.strip())
    if not parts:
        return None
    return " ".join(parts)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./.venv/bin/python -m pytest tests/test_chordmark_render.py -k lyric -v`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/chordmark_render.py tests/test_chordmark_render.py
git commit -m "feat: render _-anchored lyric line from per-chord text"
```

---

## Task 6: Render a full song (chord definitions + sections)

**Files:**
- Modify: `scripts/chordmark_render.py`
- Modify: `tests/test_chordmark_render.py`

Build `render_song(song)`: emit, in order: optional `chord <name> <voicing>` dictionary directives (one per distinct voicing in the generated `chords` index, no `#` prefix per Arthur's fork); a blank line; then for each section an optional `# label` line, and for each bar the chord line followed by the lyric line (if any). Bars within a section are emitted one per line (chord line, then lyric line if present).

- [ ] **Step 1: Add failing test**

Append to `tests/test_chordmark_render.py`:

```python
def test_render_song_full():
    song = {
        "title": "T",
        "chords": {"Dm7": [{"voicing": "x5756x"}]},
        "sections": [
            {
                "label": None,
                "bars": [
                    [{"chord": "Dm7", "voicing": "x5756x", "text": "Vai mi nha"}],
                    [{"chord": "%", "text": "tris"}],
                ],
            }
        ],
    }
    out = cm.render_song(song)
    assert out == (
        "chord Dm7 x5756x\n"
        "\n"
        "Dm7[x5756x]\n"
        "_Vai mi nha\n"
        "%\n"
        "_tris\n"
    )


def test_render_song_emits_section_label():
    song = {
        "title": "T",
        "chords": {},
        "sections": [
            {"label": "Intro", "bars": [[{"chord": "Gm7/9"}]]},
        ],
    }
    out = cm.render_song(song)
    assert out == "#Intro\nGm7/9\n"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./.venv/bin/python -m pytest tests/test_chordmark_render.py -k render_song -v`
Expected: FAIL with `AttributeError: ... has no attribute 'render_song'`.

- [ ] **Step 3: Implement `render_song`**

Add to `scripts/chordmark_render.py`:

```python
def _render_chord_definitions(chords_index):
    """Emit `chord <name> <voicing>` lines for each distinct voicing in the index."""
    lines = []
    for name, voicings in (chords_index or {}).items():
        for v in voicings:
            voicing = v.get("voicing")
            if voicing:
                lines.append(f"chord {name} {voicing}")
    return lines


def render_song(song):
    """Render one song dict to a ChordMark string."""
    lines = []

    definitions = _render_chord_definitions(song.get("chords"))
    if definitions:
        lines.extend(definitions)
        lines.append("")

    for section in song.get("sections", []):
        label = section.get("label")
        if label:
            lines.append("#" + label)
        for bar in section.get("bars", []):
            lines.append(render_chord_line(bar))
            lyric = render_lyric_line(bar)
            if lyric is not None:
                lines.append(lyric)

    return "\n".join(lines) + "\n"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./.venv/bin/python -m pytest tests/test_chordmark_render.py -k render_song -v`
Expected: 2 passed.

- [ ] **Step 5: Run the whole render suite**

Run: `./.venv/bin/python -m pytest tests/test_chordmark_render.py -v`
Expected: all passed (12 tests).

- [ ] **Step 6: Commit**

```bash
git add scripts/chordmark_render.py tests/test_chordmark_render.py
git commit -m "feat: render full song with chord definitions and sections"
```

---

## Task 7: Rewrite `json_to_chordmark.py` CLI over the new model

**Files:**
- Rewrite: `scripts/json_to_chordmark.py`
- Create: `tests/test_json_to_chordmark.py`

The CLI loads a document JSON, renders each song with `render_song`, and writes one `.chordmark` file per song (slugified title). Multi-page songs are already unified in one `song`, so there is no merge step.

- [ ] **Step 1: Write the failing CLI test**

Create `tests/test_json_to_chordmark.py`:

```python
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "json_to_chordmark.py"
PY = ROOT / ".venv" / "bin" / "python"


def test_cli_writes_one_chordmark_per_song(tmp_path):
    doc = {
        "document": {"title": "Doc"},
        "songs": [
            {
                "title": "Chega de Saudade",
                "chords": {},
                "sections": [
                    {"label": None, "bars": [[{"chord": "Dm7", "text": "Vai"}]]}
                ],
            }
        ],
    }
    in_path = tmp_path / "doc.json"
    in_path.write_text(json.dumps(doc))
    out_dir = tmp_path / "out"

    result = subprocess.run(
        [str(PY), str(SCRIPT), str(in_path), "--output", str(out_dir)],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr

    produced = out_dir / "chega-de-saudade.chordmark"
    assert produced.exists()
    content = produced.read_text()
    assert "Dm7" in content
    assert "_Vai" in content
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./.venv/bin/python -m pytest tests/test_json_to_chordmark.py -v`
Expected: FAIL — current `json_to_chordmark.py` expects the old per-bar model, so it errors or writes nothing.

- [ ] **Step 3: Rewrite the CLI**

Replace the entire contents of `scripts/json_to_chordmark.py` with:

```python
#!/usr/bin/env python3
"""Convert a chord-anchored songsheet document JSON to ChordMark files.

One .chordmark file is written per song (slugified title). Multi-page songs are
already unified into a single song object, so there is no page-merge step.

Usage:
    python json_to_chordmark.py document.json --output out/
    python json_to_chordmark.py dir/ --output out/
"""

import argparse
import json
import re
from pathlib import Path

import chordmark_render


def slugify(text):
    text = text.lower()
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[-\s]+", "-", text).strip("-")
    return text


def collect_json_files(inputs):
    files = []
    for p in inputs:
        if p.is_dir():
            files.extend(sorted(p.glob("*.json")))
        elif p.suffix == ".json":
            files.append(p)
    return files


def convert_document(doc_path, output_dir):
    """Render every song in one document JSON; return list of written paths."""
    data = json.loads(Path(doc_path).read_text())
    written = []
    for song in data.get("songs", []):
        chordmark = chordmark_render.render_song(song)
        title = song.get("title") or Path(doc_path).stem
        out_path = output_dir / f"{slugify(title)}.chordmark"
        out_path.write_text(chordmark)
        written.append(out_path)
        print(f"  ✓ {title} → {out_path.name}")
    return written


def main():
    parser = argparse.ArgumentParser(description="Convert songsheet JSON to ChordMark")
    parser.add_argument("input", nargs="+", type=Path, help="Document JSON files or dirs")
    parser.add_argument("-o", "--output", type=Path, required=True, help="Output directory")
    args = parser.parse_args()

    args.output.mkdir(parents=True, exist_ok=True)
    json_files = collect_json_files(args.input)
    if not json_files:
        print("No JSON files found.")
        return

    for doc_path in json_files:
        convert_document(doc_path, args.output)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./.venv/bin/python -m pytest tests/test_json_to_chordmark.py -v`
Expected: 1 passed.

- [ ] **Step 5: Smoke-test against the schema fixture**

Run: `./.venv/bin/python scripts/json_to_chordmark.py tests/fixtures/chega-page1.json --output /tmp/cm_out && cat /tmp/cm_out/chega-de-saudade.chordmark`
Expected: prints a ChordMark file containing `chord Dm7 x5756x`, `Dm7[x5756x]`, `_Vai mi nha`, `%`, `_tris`, and the `Em7.. A13..` split bar.

- [ ] **Step 6: Commit**

```bash
git add scripts/json_to_chordmark.py tests/test_json_to_chordmark.py
git commit -m "feat: rewrite json_to_chordmark CLI for chord-anchored model"
```

---

## Task 8: New Stage-1 vision parse prompt + output shape

**Files:**
- Modify: `scripts/parse_songsheet.py` (the `PARSE_PROMPT` constant and the metadata-wrapping in `parse_songsheet`)

The vision model must emit the new document/song shape directly. Because the prompt is hard to unit-test deterministically, this task validates the *prompt's declared output* by parsing one real page and checking the result against the schema.

- [ ] **Step 1: Replace `PARSE_PROMPT`**

In `scripts/parse_songsheet.py`, replace the entire `PARSE_PROMPT = """..."""` string (currently around lines 23–72) with:

```python
PARSE_PROMPT = """Analyze this Brazilian songsheet image (one page) and extract a structured JSON object.

Return ONLY JSON, no markdown fences, in this exact shape:

{
  "document": { "title": "<book/song title on page>", "page_count": null },
  "songs": [
    {
      "title": "<song title>",
      "composers": ["<composer>", "..."],
      "pages": [<this page number if known, else omit>],
      "key": "<key if shown, else null>",
      "chords": {},
      "sections": [
        {
          "label": null,
          "bars": [
            [ { "chord": "Dm7", "voicing": "x5756x", "text": "Vai mi nha" } ]
          ]
        }
      ]
    }
  ]
}

CRITICAL RULES:

1. BARS ARE DELIMITED BY VERTICAL TICK MARKS on the horizontal staff line.
   - Each segment between ticks is ONE bar.
   - A "bar" in the JSON is an ARRAY of chord entries, left to right.
   - Two chord diagrams drawn close together may still be in SEPARATE bars —
     decide bar membership by the tick marks, NEVER by visual proximity.

2. CHORD ENTRIES — one object per chord placement in the bar:
   - "chord": the chord name as printed (e.g. "Dm7", "F7+5", "C#m7/G#").
   - "voicing": the fingering read from THAT chord's diagram — 6 chars, low E
     string first: x=muted, 0=open, or fret number. Read the position marker
     (e.g. "5fr") — many chords are NOT open position. This is PER OCCURRENCE:
     the same chord name can have different voicings on different placements.
     Omit "voicing" only if no diagram is drawn for that placement.

3. CONTINUATION — if a chord sounds through the next bar with no new chord
   struck in that next bar, emit that next bar as [ { "chord": "%" } ].
   ("%" = measure repeat: keep playing the previous chord.)

4. LYRICS — "text" is the syllables sung from that chord's onset until the next
   chord. Dashes in the source are SPACING ONLY: strip them and join syllables
   with single spaces (e.g. printed "mi - nha" becomes "mi nha"). Omit "text"
   for instrumental bars with no lyrics.

5. Leave "chords" as an empty object {} — it is generated later, not by you.

Return ONLY the JSON object."""
```

- [ ] **Step 2: Simplify metadata wrapping**

In `scripts/parse_songsheet.py`, the `parse_songsheet()` function currently adds
`result["source"]`, `result["_parsed_at"]`, `result["_model"]`. Keep those three
metadata lines, but if the model returned a `document` block, set its `page_count`
is left as-is. Locate the block (around lines 210–217):

```python
    result = parser_fn(image_path, model)

    # Add metadata
    result["source"] = image_path.name
    result["_parsed_at"] = datetime.now(timezone.utc).isoformat()
    result["_model"] = f"{provider}/{model}"

    return result
```

Replace with:

```python
    result = parser_fn(image_path, model)

    # Add provenance metadata (kept alongside the document/songs payload)
    result.setdefault("_meta", {})
    result["_meta"]["source"] = image_path.name
    result["_meta"]["parsed_at"] = datetime.now(timezone.utc).isoformat()
    result["_meta"]["model"] = f"{provider}/{model}"

    return result
```

- [ ] **Step 3: Render page 1 of the sample PDF to PNG**

Run:
```bash
./.venv/bin/python -c "import fitz; d=fitz.open('data/joao-gilberto/pdf/1 - Chega de Saudade.pdf'); d[0].get_pixmap(dpi=200).save('/tmp/chega-p1.png')"
```
Expected: no output, `/tmp/chega-p1.png` created.

- [ ] **Step 4: Parse the page and validate against the schema**

Run:
```bash
./.venv/bin/python scripts/parse_songsheet.py /tmp/chega-p1.png --output /tmp/parse_out && \
./.venv/bin/python -c "import json,jsonschema; s=json.load(open('schemas/songsheet.schema.json')); d=json.load(open('/tmp/parse_out/chega-p1.json')); jsonschema.validate(d,s); print('VALID, songs:', len(d['songs']), 'bars in s0:', len(d['songs'][0]['sections'][0]['bars']))"
```
Expected: prints `VALID, songs: 1 bars in s0: <N>` (N ≥ 8). If validation fails, adjust the prompt wording and re-run — do not change the schema.

- [ ] **Step 5: Eyeball the anchoring**

Run: `./.venv/bin/python scripts/json_to_chordmark.py /tmp/parse_out/chega-p1.json --output /tmp/parse_cm && cat /tmp/parse_cm/*.chordmark`
Expected: the first sung line shows `Dm7` continuing via `%` and lyrics anchored with `_` (e.g. `_Vai mi nha`). Manual check against the page — exact OCR will vary.

- [ ] **Step 6: Commit**

```bash
git add scripts/parse_songsheet.py
git commit -m "feat: emit chord-anchored document model from vision parse"
```

---

## Task 9: Remove the absorbed `add_positions.py` stage

**Files:**
- Delete: `scripts/add_positions.py`

Anchoring is now intrinsic to Stage 1, so the separate alignment stage no longer exists.

- [ ] **Step 1: Confirm nothing imports it**

Run: `grep -rn "add_positions" scripts/ tests/ docs/ README.md QUICKSTART.md PROJECT_STATE.md 2>/dev/null | grep -v "docs/superpowers"`
Expected: only doc mentions (READMEs), no code imports. If any `scripts/*.py` imports `add_positions`, stop and resolve first.

- [ ] **Step 2: Delete the file**

Run: `git rm scripts/add_positions.py`
Expected: `rm 'scripts/add_positions.py'`

- [ ] **Step 3: Run the full test suite**

Run: `./.venv/bin/python -m pytest -q`
Expected: all tests pass (schema + render + cli).

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor: remove add_positions stage (anchoring now intrinsic to parse)"
```

---

## Task 10: Update project docs to the new model

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: Update CLAUDE.md pipeline + conventions**

In `CLAUDE.md`:
- In the pipeline diagram, remove the `add_positions.py` stage; the flow is now
  `PDF → extract_pages.py → PNG → parse_songsheet.py → JSON → json_to_chordmark.py → .chordmark`.
- Replace the "at_syllable is the schema key" bullet with: the model is chord-anchored —
  a bar is an ordered array of `{chord, voicing?, text?}`; order is the anchor; `%` =
  measure-repeat continuation; voicing is per-occurrence (rendered inline `Name[xxxxxx]`).
- Note timing is interpreter-derived (no `beats` in JSON), and `chords` is a generated index.
- Point to `docs/superpowers/specs/2026-05-28-songsheet-data-model-design.md` as the model reference.

- [ ] **Step 2: Update README.md**

In `README.md`, update the pipeline section to drop the `add_positions` step and reflect
the document→songs→sections→bars model and per-song `.chordmark` output.

- [ ] **Step 3: Verify no stale references remain**

Run: `grep -rn "chord_positions\|at_syllable\|add_positions" CLAUDE.md README.md`
Expected: no matches (or only historical notes explicitly marked as such).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: update pipeline and conventions for chord-anchored model"
```

---

## Final verification

- [ ] **Run the full suite**

Run: `./.venv/bin/python -m pytest -v`
Expected: all tests pass.

- [ ] **End-to-end smoke (real page)**

Run:
```bash
./.venv/bin/python -c "import fitz; d=fitz.open('data/joao-gilberto/pdf/1 - Chega de Saudade.pdf'); d[0].get_pixmap(dpi=200).save('/tmp/e2e.png')" && \
./.venv/bin/python scripts/parse_songsheet.py /tmp/e2e.png --output /tmp/e2e_json && \
./.venv/bin/python -c "import json,jsonschema; jsonschema.validate(json.load(open('/tmp/e2e_json/e2e.json')), json.load(open('schemas/songsheet.schema.json'))); print('schema OK')" && \
./.venv/bin/python scripts/json_to_chordmark.py /tmp/e2e_json/e2e.json --output /tmp/e2e_cm && cat /tmp/e2e_cm/*.chordmark
```
Expected: `schema OK`, then a ChordMark file with `%` continuations, inline voicings, and `_`-anchored lyrics.

---

## Notes for the implementer

- **Largest-remainder tie-break:** `_distribute_beats` gives the extra beat(s) to the *earliest* chords. This matches `test_three_chords_largest_remainder_sums_to_four` (`A.. B. C.`). If you later find real bars where a different split reads better, that's a converter tweak — the JSON stays unannotated by design.
- **Don't reintroduce `beats` into the JSON.** Timing is the interpreter's job (explicit decision in the spec).
- **Voicing is per-occurrence.** Never collapse to one-per-name; the `chords` index is generated for convenience only.
- **The vision prompt is not deterministic.** Its task (Task 8) verifies *schema validity and structure*, not exact OCR. Accuracy tuning of the prompt is iterative and expected.
- **`%` orphan check** (a `%` with no preceding chord) is noted in the spec as a validator nicety; it is not enforced by the JSON Schema in Task 3. Add it as a follow-up if review surfaces real orphans.
