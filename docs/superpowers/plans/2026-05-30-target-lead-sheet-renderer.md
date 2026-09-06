# Target Lead-Sheet Renderer + Lyric Hyphenation Implementation Plan

**Goal:** Add a polished "target" lead-sheet renderer (pure Python, reads the new chord-anchored model) wired into the QA Preview tab, plus word-continuation dashes in lyric data (LLM-seeded for existing songs, preserved by the parse prompt going forward).

**Architecture:** A new pure module `render_target.py` turns a song dict into bespoke HTML (title, top diagram dictionary, two-column chord-over-syllable body, Roman fret positions, barres, `°`). Hyphenation lives as trailing `-` inside the `text` field (no schema change); a one-time `migrate_hyphenation.py` seeds it via the existing Codex LLM client, and the parse prompt preserves it. The QA server gains style/dict/inline params on `/api/render`; the Preview tab gets controls.

**Tech Stack:** Python 3.14 (`.venv`), pytest, stdlib HTTP server, `codex_client` (LLM), vanilla JS. Pure render functions are unit-tested; LLM migration is tested with a stubbed client.

**Spec:** `docs/superpowers/specs/2026-05-30-target-lead-sheet-renderer-design.md`

---

## File structure

| File | Responsibility | Action |
|------|----------------|--------|
| `scripts/render_target.py` | pure: song dict → target-look HTML (diagram, barre, hyphenation, held `.`) | Create |
| `tests/test_render_target.py` | unit tests for render_target | Create |
| `scripts/migrate_hyphenation.py` | LLM-seed continuation dashes into existing songs' `text` | Create |
| `tests/test_migrate_hyphenation.py` | idempotence + token-preservation (stubbed LLM) | Create |
| `scripts/parse_songsheet.py` | PARSE_PROMPT: preserve continuation dashes | Modify |
| `scripts/qa_server.py` | `/api/render` style/dict/inline params | Modify |
| `scripts/qa_static/index.html` | Preview style/dict/inline controls + styles | Modify |
| `scripts/qa_static/app.js` | wire Preview controls into the render URL | Modify |

Render logic is pure and isolated in `render_target.py` (testable headlessly, like
`chordmark_render.py`). The server only adds query-param plumbing.

---

## Task 1: Diagram SVG with barre + Roman position

**Files:**
- Create: `scripts/render_target.py`
- Create: `tests/test_render_target.py`

Build `diagram(voicing)` → an SVG string for one comma fret-number voicing, matching the prototype:
vertical box, ×/○ markers, nut OR Roman-numeral position label when up the neck, and a **barre line**
when ≥2 strings sound the start fret.

- [ ] **Step 1: Write the failing test**

Create `tests/test_render_target.py`:

```python
import render_target as rt


def test_diagram_open_chord_has_nut_no_position():
    svg = rt.diagram("0,2,2,1,0,0")  # E major, open
    assert svg.startswith("<svg")
    assert 'class="nut"' in svg          # open position shows a nut
    assert 'class="pos"' not in svg      # no Roman position label
    assert svg.count('class="dot"') == 3
    assert svg.count(">×<") == 0    # no muted strings here


def test_diagram_up_neck_shows_roman_position_and_mutes():
    svg = rt.diagram("x,5,7,5,6,5")      # Dm7 at 5th fret, low E muted
    assert 'class="pos"' in svg          # position label instead of nut
    assert ">V<" in svg                  # 5th fret -> Roman V
    assert ">×<" in svg             # muted low E


def test_diagram_detects_barre():
    svg = rt.diagram("1,3,3,2,1,1")      # F-style barre at fret 1 (4 strings on 1)
    assert 'class="barre"' in svg


def test_diagram_invalid_voicing_is_empty():
    assert rt.diagram("x,9") == ""
```

- [ ] **Step 2: Run to verify it fails**

Run: `./.venv/bin/python -m pytest tests/test_render_target.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'render_target'`.

- [ ] **Step 3: Implement `diagram` (ported from the prototype)**

Create `scripts/render_target.py`:

```python
#!/usr/bin/env python3
"""Render a chord-anchored song to a polished lead-sheet HTML (the "target look").

Pure functions: a song dict -> HTML string. No file or network I/O, so unit-testable.
Reads the new model: document -> songs -> sections -> bars -> [{chord, voicing?, text?}].
"""

import html as _html

ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI",
         "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX",
         "XXI", "XXII", "XXIII", "XXIV"]


def _roman(n):
    return ROMAN[n] if 0 <= n < len(ROMAN) else str(n)


def _parse_voicing(voicing):
    """'x,5,7,5,6,x' -> [None,5,7,5,6,None]; returns None if malformed (not 6 valid)."""
    toks = [t.strip() for t in str(voicing).split(",")]
    if len(toks) != 6:
        return None
    out = []
    for t in toks:
        if t == "x":
            out.append(None)
        elif t.isdigit() and 0 <= int(t) <= 24:
            out.append(int(t))
        else:
            return None
    return out


def nice_name(name):
    """Display form of a chord name: dim/dim7 -> the degree sign."""
    return name.replace("dim7", "°").replace("dim", "°")


def diagram(voicing):
    """SVG chord diagram for a comma voicing, or '' if malformed."""
    frets = _parse_voicing(voicing)
    if frets is None:
        return ""
    NS, NF = 6, 5
    W, H = 60, 74
    padL, padR, padT, padB = 15, 7, 13, 4
    gw, gh = W - padL - padR, H - padT - padB
    sx, fy = gw / (NS - 1), gh / NF
    nz = [f for f in frets if f and f > 0]
    max_f = max(nz) if nz else 0
    min_f = min(nz) if nz else 0
    start = min_f if max_f > NF else 1

    def x(i):
        return padL + i * sx

    def yf(r):
        return padT + r * fy

    el = []
    for r in range(NF + 1):
        el.append(f'<line class="fl" x1="{x(0):.1f}" y1="{yf(r):.1f}" '
                  f'x2="{x(NS-1):.1f}" y2="{yf(r):.1f}"/>')
    for i in range(NS):
        el.append(f'<line class="sl" x1="{x(i):.1f}" y1="{padT}" '
                  f'x2="{x(i):.1f}" y2="{padT+gh:.1f}"/>')
    if start == 1:
        el.append(f'<line class="nut" x1="{x(0):.1f}" y1="{padT}" '
                  f'x2="{x(NS-1):.1f}" y2="{padT}"/>')
    else:
        el.append(f'<text class="pos" x="{padL-5:.1f}" y="{padT+fy*0.72:.1f}" '
                  f'text-anchor="end">{_roman(start)}</text>')

    barred = [i for i, f in enumerate(frets) if f == start]
    if start > 0 and len(barred) >= 2:
        x1, x2 = x(min(barred)), x(max(barred))
        yb = padT + 0.5 * fy
        el.append(f'<line class="barre" x1="{x1:.1f}" y1="{yb:.1f}" '
                  f'x2="{x2:.1f}" y2="{yb:.1f}"/>')

    for i, f in enumerate(frets):
        if f is None:
            el.append(f'<text class="mk" x="{x(i):.1f}" y="{padT-4}" '
                      f'text-anchor="middle">×</text>')
        elif f == 0:
            el.append(f'<text class="mk" x="{x(i):.1f}" y="{padT-4}" '
                      f'text-anchor="middle">○</text>')
        else:
            row = f - start + 1
            el.append(f'<circle class="dot" cx="{x(i):.1f}" '
                      f'cy="{padT+(row-0.5)*fy:.1f}" r="{fy*0.32:.1f}"/>')

    return (f'<svg class="diag" viewBox="0 0 {W} {H}">' + "".join(el) + "</svg>")
```

- [ ] **Step 4: Run to verify it passes**

Run: `./.venv/bin/python -m pytest tests/test_render_target.py -v`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/render_target.py tests/test_render_target.py
git commit -m "feat(target): chord diagram SVG with barre + Roman position"
```

---

## Task 2: Render one body line (chord-over-syllable, held `.`, hyphenation)

**Files:**
- Modify: `scripts/render_target.py`
- Modify: `tests/test_render_target.py`

A "line" is a group of bars (reuse grouping from `chordmark_render`). For each bar render the chord
name over its syllable(s); a `%` (held) bar shows a `.` in the chord slot; hyphenation comes straight
from trailing `-` already in `text` (renderer does not infer boundaries).

- [ ] **Step 1: Add failing tests**

Append to `tests/test_render_target.py`:

```python
def test_render_bar_chord_over_syllable():
    bar = [{"chord": "Dm7", "voicing": "x,5,7,5,6,x", "text": "Vai"}]
    out = rt.render_bar_html(bar)
    assert "Dm7" in out
    assert "Vai" in out


def test_render_bar_held_shows_dot():
    bar = [{"chord": "%", "text": "mi- nha"}]
    out = rt.render_bar_html(bar)
    # held chord slot renders a "." not a chord name
    assert ">.</" in out or ">.<" in out or "class=\"cn\">.<" in out
    assert "mi-" in out and "nha" in out


def test_render_bar_dim_uses_degree_sign():
    bar = [{"chord": "Bdim7", "voicing": "x,7,8,7,8,x", "text": "te-"}]
    out = rt.render_bar_html(bar)
    assert "°" in out          # Bdim7 -> B°7 region
    assert "dim" not in out         # the literal 'dim' should be gone
```

- [ ] **Step 2: Run to verify they fail**

Run: `./.venv/bin/python -m pytest tests/test_render_target.py -k render_bar -v`
Expected: FAIL — `AttributeError: ... has no attribute 'render_bar_html'`.

- [ ] **Step 3: Implement `render_bar_html`**

Add to `scripts/render_target.py`:

```python
def render_bar_html(bar):
    """Render one bar as a sequence of chord-over-syllable slots.

    Each chord entry becomes a slot: the chord name (or '.' if it is a held '%'
    bar) above, its syllables below. Hyphenation is taken verbatim from `text`
    (a trailing '-' on a syllable is a word continuation).
    """
    slots = []
    for entry in bar:
        chord = entry.get("chord", "")
        label = "." if chord == "%" else nice_name(chord)
        text = entry.get("text") or ""
        slots.append(
            '<span class="slot">'
            f'<span class="ch"><b class="cn">{_html.escape(label)}</b></span>'
            f'<span class="ly">{_html.escape(text)}</span>'
            "</span>"
        )
    return "".join(slots)
```

- [ ] **Step 4: Run to verify they pass**

Run: `./.venv/bin/python -m pytest tests/test_render_target.py -k render_bar -v`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/render_target.py tests/test_render_target.py
git commit -m "feat(target): render bar as chord-over-syllable with held dot + degree sign"
```

---

## Task 3: Dictionary (per-voicing / per-name)

**Files:**
- Modify: `scripts/render_target.py`
- Modify: `tests/test_render_target.py`

Build the top diagram dictionary from the song's actual chord occurrences.

- [ ] **Step 1: Add failing tests**

Append to `tests/test_render_target.py`:

```python
def _song_two_dm7_voicings():
    return {"title": "T", "sections": [{"label": None, "bars": [
        [{"chord": "Dm7", "voicing": "x,5,7,5,6,x"}],
        [{"chord": "Dm7", "voicing": "x,x,0,2,2,1"}],   # different voicing, same name
        [{"chord": "Dm7", "voicing": "x,5,7,5,6,x"}],   # repeat of the first
        [{"chord": "%"}],                                # held -> not a dictionary entry
    ]}]}


def test_dictionary_per_voicing_lists_distinct_voicings():
    entries = rt.dictionary_entries(_song_two_dm7_voicings()["sections"], mode="per_voicing")
    voicings = sorted(e["voicing"] for e in entries)
    assert voicings == ["x,5,7,5,6,x", "x,x,0,2,2,1"]   # both, % excluded


def test_dictionary_per_name_collapses_to_most_common():
    entries = rt.dictionary_entries(_song_two_dm7_voicings()["sections"], mode="per_name")
    assert len(entries) == 1
    assert entries[0]["chord"] == "Dm7"
    assert entries[0]["voicing"] == "x,5,7,5,6,x"        # most frequent wins
```

- [ ] **Step 2: Run to verify they fail**

Run: `./.venv/bin/python -m pytest tests/test_render_target.py -k dictionary -v`
Expected: FAIL — no `dictionary_entries`.

- [ ] **Step 3: Implement `dictionary_entries`**

Add to `scripts/render_target.py`:

```python
def _iter_entries(sections):
    for sec in sections or []:
        for bar in sec.get("bars", []):
            for entry in bar:
                yield entry


def dictionary_entries(sections, mode="per_voicing"):
    """Distinct chord diagrams for the dictionary.

    per_voicing: one entry per distinct (chord, voicing), most-frequent first.
    per_name:    one entry per chord name, using its most-common voicing.
    Entries without a voicing, and '%' held bars, are excluded.
    """
    counts = {}   # key -> {chord, voicing, count}
    order = []
    for entry in _iter_entries(sections):
        chord = entry.get("chord")
        voicing = entry.get("voicing")
        if not chord or chord == "%" or not voicing:
            continue
        key = (chord, voicing)
        if key not in counts:
            counts[key] = {"chord": chord, "voicing": voicing, "count": 0}
            order.append(key)
        counts[key]["count"] += 1

    if mode == "per_name":
        best = {}  # chord -> entry (highest count)
        for key in order:
            e = counts[key]
            cur = best.get(e["chord"])
            if cur is None or e["count"] > cur["count"]:
                best[e["chord"]] = e
        # preserve first-seen order of names
        seen, result = set(), []
        for key in order:
            name = counts[key]["chord"]
            if name not in seen:
                seen.add(name)
                result.append(best[name])
        return result

    return [counts[key] for key in order]
```

- [ ] **Step 4: Run to verify they pass**

Run: `./.venv/bin/python -m pytest tests/test_render_target.py -k dictionary -v`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/render_target.py tests/test_render_target.py
git commit -m "feat(target): dictionary entries (per-voicing / per-name)"
```

---

## Task 4: Full page render (title, dictionary, 2-column body, inline option)

**Files:**
- Modify: `scripts/render_target.py`
- Modify: `tests/test_render_target.py`

Assemble the full HTML page. Reuse phrase-grouping from `chordmark_render._group_bars`.

- [ ] **Step 1: Add failing test**

Append to `tests/test_render_target.py`:

```python
def test_render_song_full_page():
    song = {
        "title": "Chega de Saudade",
        "composers": ["Tom Jobim", "Vinicius de Moraes"],
        "sections": [{"label": None, "bars": [
            [{"chord": "Dm7", "voicing": "x,5,7,5,6,x", "text": "Vai"}],
            [{"chord": "%", "text": "mi- nha"}],
        ]}],
    }
    out = rt.render_song(song)
    assert out.startswith("<!doctype html>")
    assert "Chega de Saudade" in out
    assert "Tom Jobim" in out
    assert 'class="dict"' in out          # top dictionary present
    assert 'class="body"' in out          # two-column body present
    assert "<svg" in out                  # at least one diagram
    assert "mi-" in out                    # hyphenated continuation preserved


def test_render_song_inline_diagrams_toggle():
    song = {"title": "T", "sections": [{"label": None, "bars": [
        [{"chord": "Dm7", "voicing": "x,5,7,5,6,x", "text": "a"}],
    ]}]}
    no_inline = rt.render_song(song, inline_diagrams=False)
    with_inline = rt.render_song(song, inline_diagrams=True)
    # inline adds diagrams inside the body, so more <svg> occurrences
    assert with_inline.count("<svg") > no_inline.count("<svg")
```

- [ ] **Step 2: Run to verify it fails**

Run: `./.venv/bin/python -m pytest tests/test_render_target.py -k render_song -v`
Expected: FAIL — no `render_song`.

- [ ] **Step 3: Implement `render_song` (+ CSS)**

Add to `scripts/render_target.py`:

```python
import chordmark_render  # reuse phrase-grouping


_CSS = """
@page { size: A4; margin: 1.4cm; } * { box-sizing: border-box; }
body { margin:0; background:#f0f0f1; color:#111;
  font-family: Georgia, "Times New Roman", serif; }
.page { max-width: 820px; margin: 1.5rem auto; background:#fff;
  padding: 2.4rem 2.6rem 3rem; box-shadow: 0 1px 6px rgba(0,0,0,.12); }
h1 { text-align:center; font-size: 2.4rem; font-weight:700; margin:0 0 .15rem; }
.composer { text-align:center; font-variant: small-caps; letter-spacing:1px;
  margin:0 0 1.3rem; font-size:.95rem; }
.dict { display:flex; flex-wrap:wrap; gap:.7rem 1rem; justify-content:center;
  padding:0 0 1.1rem; margin-bottom:1.3rem; border-bottom:1px solid #ddd; }
.dia { text-align:center; width:58px; }
.dn { font-weight:700; font-size:.82rem; margin-bottom:1px; white-space:nowrap; }
.diag { width:58px; height:auto; display:block; }
.diag .fl,.diag .sl { stroke:#333; stroke-width:.8; }
.diag .nut { stroke:#222; stroke-width:2.6; }
.diag .barre { stroke:#111; stroke-width:4.4; stroke-linecap:round; }
.diag .dot { fill:#111; }
.diag .mk { font:6.5px Georgia,serif; fill:#111; }
.diag .pos { font:italic 7.5px Georgia,serif; fill:#111; }
.body { columns: 2; column-gap: 2.4rem; font-size: 1.02rem; line-height: 1.15; }
.line { break-inside: avoid; margin: 0 0 1.05rem; }
.slot { display:inline-flex; flex-direction:column; vertical-align:bottom;
  padding-right:.8em; }
.slot .ch { height:1.3em; white-space:nowrap; } .slot .cn { font-weight:700; }
.slot .ly { white-space:pre; }
.slot .idia { display:block; }
.slot .idia svg { width:42px; height:auto; }
"""


def _dictionary_html(sections, mode):
    parts = []
    for e in dictionary_entries(sections, mode):
        parts.append(f'<div class="dia"><div class="dn">{_html.escape(nice_name(e["chord"]))}</div>'
                     f'{diagram(e["voicing"])}</div>')
    return '<div class="dict">' + "".join(parts) + "</div>"


def _body_html(sections, inline_diagrams):
    lines = []
    for sec in sections or []:
        label = sec.get("label")
        if label:
            lines.append(f'<div class="seclabel">{_html.escape(label)}</div>')
        for group in chordmark_render._group_bars(sec.get("bars", [])):
            slots = []
            for bar in group:
                slots.append(render_bar_html(bar, inline_diagrams=inline_diagrams))
            lines.append('<div class="line">' + "".join(slots) + "</div>")
    return '<div class="body">' + "".join(lines) + "</div>"


def render_song(song, dictionary="per_voicing", inline_diagrams=False):
    """Render a song dict to a full standalone target-look HTML page."""
    sections = song.get("sections", [])
    title = _html.escape(song.get("title") or "")
    composer = _html.escape(", ".join(song.get("composers") or []))
    return (
        "<!doctype html><html><head><meta charset=\"utf-8\">"
        f"<title>{title}</title><style>{_CSS}</style></head>"
        '<body><div class="page">'
        f"<h1>{title}</h1><div class=\"composer\">{composer}</div>"
        f"{_dictionary_html(sections, dictionary)}"
        f"{_body_html(sections, inline_diagrams)}"
        "</div></body></html>"
    )
```

Also update `render_bar_html` from Task 2 to accept the inline flag — replace its signature/body with:

```python
def render_bar_html(bar, inline_diagrams=False):
    """Render one bar as chord-over-syllable slots (optionally with inline diagrams)."""
    slots = []
    for entry in bar:
        chord = entry.get("chord", "")
        label = "." if chord == "%" else nice_name(chord)
        text = entry.get("text") or ""
        voicing = entry.get("voicing")
        idia = (f'<span class="idia">{diagram(voicing)}</span>'
                if inline_diagrams and voicing and chord != "%" else "")
        slots.append(
            '<span class="slot">'
            f'<span class="ch"><b class="cn">{_html.escape(label)}</b></span>'
            f'{idia}'
            f'<span class="ly">{_html.escape(text)}</span>'
            "</span>"
        )
    return "".join(slots)
```

- [ ] **Step 4: Run to verify it passes**

Run: `./.venv/bin/python -m pytest tests/test_render_target.py -v`
Expected: all passed (Tasks 1–4 tests).

- [ ] **Step 5: Smoke-render a real corrected song**

Run:
```bash
./.venv/bin/python -c "import sys,json; sys.path.insert(0,'scripts'); import render_target as rt; d=json.load(open('data/joao-gilberto/songs/1-chega-de-saudade/01-chega-de-saudade.json')); open('/tmp/target_new.html','w').write(rt.render_song(d['songs'][0])); print('ok', d['songs'][0]['title'])"
```
Expected: prints `ok Chega de Saudade`; `/tmp/target_new.html` exists.

- [ ] **Step 6: Commit**

```bash
git add scripts/render_target.py tests/test_render_target.py
git commit -m "feat(target): full page render (title, dictionary, 2-col body, inline option)"
```

---

## Task 5: Wire target style into the QA server

**Files:**
- Modify: `scripts/qa_server.py`
- Modify: `tests/test_qa_server.py`

`/api/render` already serves the fork render. Add a `style` query param: `target` returns the new
pure-Python HTML directly (no node/fork); `fork` keeps current behavior. Forward `dict` and `inline`.

- [ ] **Step 1: Add failing test**

Append to `tests/test_qa_server.py`:

```python
def test_render_target_style(tmp_path):
    root = _corpus(tmp_path)
    status, ctype, body = S.handle(
        "GET", "/api/render/1-album/01-song-one.json?style=target", b"", root)
    assert status == 200
    assert ctype == "text/html"
    assert b"<!doctype html>" in body
    assert b"Song One" in body  # title from the fixture
```

(The `_corpus` fixture's song already has `document.title`/`songs[0].title` "Song One" and one bar.)

- [ ] **Step 2: Run to verify it fails**

Run: `./.venv/bin/python -m pytest tests/test_qa_server.py -k render_target -v`
Expected: FAIL — current handler ignores `style` and runs the fork path (no node in test → error HTML, no "Song One" title, or wrong content).

- [ ] **Step 3: Implement the style branch**

In `scripts/qa_server.py`, the render route currently reads:

```python
    # /api/render/{album}/{file}  -> ChordMark HTML rendered via the fork
    if parts[:2] == ["api", "render"] and len(parts) == 4 and method == "GET":
        album, fname = parts[2], parts[3]
        target = _safe_under(root, album, fname)
        if target is None:
            return _json(400, {"error": "bad path"})
        if not target.exists():
            return _json(404, {"error": "not found"})
        return render_song_html(target)
```

Replace the final `return render_song_html(target)` line with:

```python
        params = _query_params(orig_path)
        if params.get("style") == "target":
            return render_target_html(
                target,
                dictionary=params.get("dict", "per_voicing"),
                inline=params.get("inline") == "1",
            )
        return render_song_html(target)
```

`handle` strips the query string at the top (existing line `path = path.split("?", 1)[0]`). Capture
the original first: at the very top of `handle`, immediately before that strip line, add:

```python
    orig_path = path
```

Add a query parser near `_json` (top of file):

```python
def _query_params(path):
    """Parse the query string of a raw path into a flat dict (last value wins)."""
    from urllib.parse import urlparse, parse_qs
    q = urlparse(path).query
    return {k: v[-1] for k, v in parse_qs(q).items()}
```

Add the target renderer near `render_song_html`:

```python
def render_target_html(song_path, dictionary="per_voicing", inline=False):
    """Render a saved song to the target lead-sheet HTML (pure Python, no fork)."""
    import render_target

    try:
        doc = json.loads(song_path.read_text())
        songs = doc.get("songs", [])
        if not songs:
            return _html_error("no songs in document")
        html = render_target.render_song(songs[0], dictionary=dictionary, inline_diagrams=inline)
        return 200, "text/html", html.encode()
    except Exception as e:  # noqa: BLE001
        return _html_error(f"target render failed: {e}")
```

- [ ] **Step 4: Run to verify it passes**

Run: `./.venv/bin/python -m pytest tests/test_qa_server.py -v`
Expected: all passed (existing + new).

- [ ] **Step 5: Commit**

```bash
git add scripts/qa_server.py tests/test_qa_server.py
git commit -m "feat(qa): /api/render style=target (pure-Python lead sheet) + dict/inline params"
```

---

## Task 6: Preview tab controls (style / dictionary / inline)

**Files:**
- Modify: `scripts/qa_static/index.html`
- Modify: `scripts/qa_static/app.js`

- [ ] **Step 1: Add the controls markup**

In `scripts/qa_static/index.html`, the preview container is:

```html
    <div id="preview" style="display:none">
      <iframe id="previewFrame" ...></iframe>
    </div>
```

Insert a control row immediately before the `<iframe ...>` line:

```html
      <div class="pvctl">
        <label>style
          <select id="pvStyle"><option value="fork">Fork</option><option value="target">Target</option></select>
        </label>
        <label>dictionary
          <select id="pvDict"><option value="per_voicing">per voicing</option><option value="per_name">per name</option></select>
        </label>
        <label><input type="checkbox" id="pvInline"> inline diagrams</label>
      </div>
```

Add styles to the `<style>` block:

```css
  .pvctl{display:flex;gap:14px;align-items:center;margin-bottom:8px;font-size:12px;color:#9aa3b2}
  .pvctl select{background:#1e222b;color:#e6e8ee;border:1px solid #2a2f3a;border-radius:5px;padding:3px}
```

- [ ] **Step 2: Wire the controls in `app.js`**

In `scripts/qa_static/app.js`, replace the existing `renderPreview` function:

```javascript
function renderPreview() {
  const frame = document.getElementById("previewFrame");
  frame.src = `/api/render/${state.album}/${state.file}?t=${state._previewToken || 0}`;
}
```

with:

```javascript
function renderPreview() {
  const frame = document.getElementById("previewFrame");
  const style = document.getElementById("pvStyle").value;
  const dict = document.getElementById("pvDict").value;
  const inline = document.getElementById("pvInline").checked ? "1" : "0";
  const t = state._previewToken || 0;
  frame.src = `/api/render/${state.album}/${state.file}`
    + `?style=${style}&dict=${dict}&inline=${inline}&t=${t}`;
}
```

Then, inside `init()`, after the existing
`document.getElementById("tabPreview").onclick = () => showView("preview");` line, add:

```javascript
  ["pvStyle", "pvDict", "pvInline"].forEach((id) =>
    document.getElementById(id).addEventListener("change", () => {
      if (document.getElementById("preview").style.display !== "none") renderPreview();
    }));
```

- [ ] **Step 3: Syntax check + manual smoke**

Run: `node --check scripts/qa_static/app.js`
Expected: no output (valid).

Then restart the server and check both styles render:
```bash
pkill -f qa_server.py 2>/dev/null; sleep 1
./.venv/bin/python scripts/qa_server.py --songs data/joao-gilberto/songs --port 8000 &
sleep 2
curl -s -o /dev/null -w "fork:   %{http_code}\n" "localhost:8000/api/render/1-chega-de-saudade/01-chega-de-saudade.json?style=fork"
curl -s -o /dev/null -w "target: %{http_code}\n" "localhost:8000/api/render/1-chega-de-saudade/01-chega-de-saudade.json?style=target"
```
Expected: both `200`.

- [ ] **Step 4: Commit**

```bash
git add scripts/qa_static/index.html scripts/qa_static/app.js
git commit -m "feat(qa): Preview controls for style (fork/target), dictionary mode, inline diagrams"
```

---

## Task 7: Parse prompt — preserve continuation dashes

**Files:**
- Modify: `scripts/parse_songsheet.py`

- [ ] **Step 1: Update the LYRICS rule in PARSE_PROMPT**

In `scripts/parse_songsheet.py`, the PARSE_PROMPT currently tells the model to strip dashes
(rule 4, the LYRICS rule). Find that rule (it contains "Dashes in the source are SPACING ONLY:
strip them") and replace that rule's text with:

```
4. LYRICS — "text" is the syllables sung from that chord's onset until the next
   chord. The source prints word continuations with dashes (e.g. "Vai mi - nha").
   PRESERVE these as word-continuation markers: a syllable that continues its
   word ends with a trailing hyphen, the last syllable of a word does NOT.
   Example: printed "tris - te - za e" -> "tris- te- za e" (tristeza is one word,
   "e" is the next word). Separate complete words with a single space. Omit
   "text" for instrumental bars with no lyrics.
```

- [ ] **Step 2: Verify the example in the prompt's JSON shape matches**

In the same prompt, the example song JSON shows `"text": "Vai mi nha"`. Change that example value to
`"text": "Vai mi- nha"` so the shape and the rule agree.

- [ ] **Step 3: Sanity check (no parse run needed)**

Run: `./.venv/bin/python -c "import sys; sys.path.insert(0,'scripts'); import parse_songsheet as p; assert 'continuation' in p.PARSE_PROMPT.lower() and 'tris- te- za' in p.PARSE_PROMPT; print('prompt updated')"`
Expected: `prompt updated`.

- [ ] **Step 4: Commit**

```bash
git add scripts/parse_songsheet.py
git commit -m "feat(parse): preserve word-continuation dashes in lyrics"
```

---

## Task 8: Migrate hyphenation into existing songs (LLM-seeded)

**Files:**
- Create: `scripts/migrate_hyphenation.py`
- Create: `tests/test_migrate_hyphenation.py`

Seed continuation dashes into the existing corpus' `text` via the Codex LLM. The pure
re-application logic (idempotence, token preservation) is unit-tested with a stubbed hyphenator;
the real LLM call is the CLI path.

- [ ] **Step 1: Write the failing test**

Create `tests/test_migrate_hyphenation.py`:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import migrate_hyphenation as M


def test_collect_lyric_fragments_in_order():
    song = {"sections": [{"bars": [
        [{"chord": "Dm7", "text": "Vai"}],
        [{"chord": "%", "text": "mi nha"}],
        [{"chord": "A7"}],                       # no text -> skipped
        [{"chord": "Bdim7", "text": "tris te za e"}],
    ]}]}
    assert M.collect_fragments(song) == ["Vai", "mi nha", "tris te za e"]


def test_apply_fragments_writes_back_in_order():
    song = {"sections": [{"bars": [
        [{"chord": "Dm7", "text": "Vai"}],
        [{"chord": "%", "text": "mi nha"}],
        [{"chord": "A7"}],
        [{"chord": "Bdim7", "text": "tris te za e"}],
    ]}]}
    M.apply_fragments(song, ["Vai", "mi- nha", "tris- te- za e"])
    texts = [e.get("text") for bar in song["sections"][0]["bars"] for e in bar]
    assert texts == ["Vai", "mi- nha", None, "tris- te- za e"]


def test_already_hyphenated_is_skipped():
    # if any fragment already has a '-', migration treats the song as done
    song = {"sections": [{"bars": [[{"chord": "Dm7", "text": "mi- nha"}]]}]}
    assert M.needs_migration(song) is False
    song2 = {"sections": [{"bars": [[{"chord": "Dm7", "text": "mi nha"}]]}]}
    assert M.needs_migration(song2) is True


def test_apply_fragments_rejects_token_mismatch():
    # a hyphenated fragment must keep the same whitespace-split token count
    song = {"sections": [{"bars": [[{"chord": "Dm7", "text": "mi nha"}]]}]}
    import pytest
    with pytest.raises(ValueError):
        M.apply_fragments(song, ["mi- nha do"])   # 3 tokens vs original 2
```

- [ ] **Step 2: Run to verify it fails**

Run: `./.venv/bin/python -m pytest tests/test_migrate_hyphenation.py -v`
Expected: FAIL — no module.

- [ ] **Step 3: Implement the pure logic + CLI**

Create `scripts/migrate_hyphenation.py`:

```python
#!/usr/bin/env python3
"""Seed word-continuation dashes into existing songs' lyric text via the LLM.

The source text is bare syllables ("tris te za e"); a proper lead sheet needs
continuation hyphens ("tris- te- za e"). This batches each song's lyric
fragments through the Codex LLM (it knows Portuguese) and writes the hyphenated
text back. Idempotent: songs already containing '-' are skipped.

Usage:
    python migrate_hyphenation.py data/joao-gilberto/songs/<album>/<song>.json
    python migrate_hyphenation.py data/joao-gilberto/songs/ --dry-run
"""

import argparse
import json
from pathlib import Path


def collect_fragments(song):
    """All non-empty `text` fragments, in reading order."""
    out = []
    for sec in song.get("sections", []):
        for bar in sec.get("bars", []):
            for entry in bar:
                t = entry.get("text")
                if t:
                    out.append(t)
    return out


def needs_migration(song):
    """True if the song has lyric text and none of it contains a hyphen yet."""
    frags = collect_fragments(song)
    return bool(frags) and not any("-" in f for f in frags)


def apply_fragments(song, hyphenated):
    """Write hyphenated fragments back in order. Each replacement must keep the
    same whitespace-token count as the original (only dashes added)."""
    it = iter(hyphenated)
    for sec in song.get("sections", []):
        for bar in sec.get("bars", []):
            for entry in bar:
                if not entry.get("text"):
                    continue
                new = next(it)
                if len(new.split()) != len(entry["text"].split()):
                    raise ValueError(
                        f"token count changed: {entry['text']!r} -> {new!r}")
                entry["text"] = new
    return song


_PROMPT = """You are adding word-continuation hyphens to Brazilian Portuguese song lyrics.

Each line below is a fragment of syllables separated by spaces. A syllable that
CONTINUES its word must end with a trailing hyphen "-"; the LAST syllable of a
word has no hyphen. Keep every token and the spaces exactly as given — only add
trailing hyphens. Do not merge, split, reorder, or change tokens.

Example:
  in:  tris te za e
  out: tris- te- za e

Return EXACTLY one output line per input line, in order, nothing else.

INPUT:
{fragments}
"""


def hyphenate_via_llm(fragments):
    """Call the Codex LLM to hyphenate fragments; return a same-length list."""
    import codex_client

    prompt = _PROMPT.format(fragments="\n".join(fragments))
    text = codex_client.complete_text(prompt)
    lines = [ln for ln in text.splitlines() if ln.strip() != ""]
    if len(lines) != len(fragments):
        raise ValueError(
            f"LLM returned {len(lines)} lines for {len(fragments)} fragments")
    return lines


def migrate_file(path, hyphenator, dry_run=False):
    """Migrate one song JSON. hyphenator(fragments)->lines. Returns True if changed."""
    doc = json.loads(Path(path).read_text())
    changed = False
    for song in doc.get("songs", []):
        if not needs_migration(song):
            continue
        frags = collect_fragments(song)
        hyph = hyphenator(frags)
        apply_fragments(song, hyph)
        changed = True
    if changed and not dry_run:
        Path(path).write_text(json.dumps(doc, ensure_ascii=False, indent=2))
    return changed


def main():
    ap = argparse.ArgumentParser(description="Seed lyric continuation hyphens via LLM")
    ap.add_argument("paths", nargs="+", type=Path)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    files = []
    for p in args.paths:
        files.extend(sorted(p.rglob("*.json")) if p.is_dir() else [p])

    for f in files:
        try:
            changed = migrate_file(f, hyphenate_via_llm, dry_run=args.dry_run)
            print(f"{'WOULD CHANGE' if (changed and args.dry_run) else ('CHANGED' if changed else 'skip')}  {f}")
        except Exception as e:  # noqa: BLE001
            print(f"ERROR  {f}: {e}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run to verify it passes**

Run: `./.venv/bin/python -m pytest tests/test_migrate_hyphenation.py -v`
Expected: 4 passed.

- [ ] **Step 5: Verify `codex_client.complete_text` exists (the migration depends on it)**

Run: `./.venv/bin/python -c "import sys; sys.path.insert(0,'scripts'); import codex_client; print('has complete_text:', hasattr(codex_client, 'complete_text'))"`
Expected: `has complete_text: True`.

If it prints `False`, add a minimal text-completion helper to `scripts/codex_client.py` that sends a
plain prompt (no image) and returns the model's text, reusing the existing client/token plumbing in
that file (mirror the existing vision call but text-only). Then re-run Step 5.

- [ ] **Step 6: Commit**

```bash
git add scripts/migrate_hyphenation.py tests/test_migrate_hyphenation.py scripts/codex_client.py
git commit -m "feat: migrate_hyphenation — LLM-seed lyric continuation dashes"
```

---

## Task 9: End-to-end manual check

**Files:** none (verification)

- [ ] **Step 1: Migrate one song and render it Target style**

```bash
./.venv/bin/python scripts/migrate_hyphenation.py data/joao-gilberto/songs/1-chega-de-saudade/01-chega-de-saudade.json
pkill -f qa_server.py 2>/dev/null; sleep 1
./.venv/bin/python scripts/qa_server.py --songs data/joao-gilberto/songs --port 8000 &
sleep 2
```
Open http://localhost:8000 → Preview tab → set **style = Target**.

- [ ] **Step 2: Visual checklist**

Confirm:
- Centered title + small-caps composer; chord-diagram dictionary on top.
- Two-column chord-over-syllable body; `°` shown for diminished chords.
- Held bars show `.` (not a repeated chord name).
- Continuations hyphenated (e.g. `mi-`, `tris- te- za`).
- Up-the-neck chords show a Roman position number; barre chords show a barre line.
- Switching **dictionary** per-voicing/per-name changes the top palette; **inline diagrams** toggle
  adds small diagrams in the body. Switching back to **Fork** still renders the ChordMark view.

- [ ] **Step 3: Stop the server**

Run: `pkill -f qa_server.py`
(No commit unless the checklist surfaced a fix.)

---

## Self-review notes

- **Spec coverage:** §1 hyphenation data (Task 7 prompt + Task 8 migration; representation is dashes
  in `text`, no schema change); §2 target renderer (Tasks 1–4: diagram/barre, chord-over-syllable,
  held `.`, full page); §3 dictionary modes + inline (Tasks 3, 4); §4 Preview wiring (Tasks 5, 6).
  All covered.
- **No-schema-change** honored — `text` stays a free string; tests assert dashes pass through.
- **Reuse:** `chordmark_render._group_bars` for phrase grouping; `codex_client` for the LLM.
- **Naming consistency:** `render_target.{diagram,nice_name,render_bar_html,dictionary_entries,render_song}`;
  `render_bar_html(bar, inline_diagrams=False)`; server `render_target_html(path, dictionary, inline)`;
  `migrate_hyphenation.{collect_fragments,needs_migration,apply_fragments,hyphenate_via_llm,migrate_file}`.
- **Known dependency:** Task 8 needs `codex_client.complete_text` (text-only completion). Step 5
  checks for it and adds it if missing — flagged rather than assumed.
- **Held `.` test** uses a tolerant assertion (`class="cn">.<`) since exact HTML spacing may vary;
  acceptable for a render smoke assertion.
