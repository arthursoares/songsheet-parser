# QA / Correction Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local browser tool to review each extracted song side-by-side with its scanned pages and correct chord names, voicings, and anchored lyrics, with reverse chord detection (tonal.js) validated through ChordMark's parser (chord-symbol), saving schema-validated JSON back to a committed per-song corpus.

**Architecture:** A one-time `materialize_songs.py` promotes scratch assembled docs into a committed `data/joao-gilberto/songs/<album>/<NN>-<song>.json` corpus with page PNGs. A stdlib-only Python HTTP server (`qa_server.py`) serves songs + page images and accepts schema-validated saves. A vanilla-JS browser app (`qa_static/`) renders the side-by-side editor; all music logic (detect + validate) runs client-side via vendored tonal.js + chord-symbol.

**Tech Stack:** Python 3.14 stdlib (`http.server`, `json`, `pathlib`), `jsonschema` + `fitz` (already deps), vanilla JS, vendored `tonal` and `chord-symbol` browser builds. Tests: `pytest`.

**Spec:** `docs/superpowers/specs/2026-05-29-qa-correction-tool-design.md`

---

## Prerequisites (not code tasks — verify before starting)

1. **Decimal voicing format must be live** — `schemas/songsheet.schema.json` voicing pattern is
   `^(x|\d{1,2})(,(x|\d{1,2})){5}$` (frets 0–24). If the schema still has `^[0-9x]{6}$`, the
   voicing-encoding change is a separate prerequisite and must land first. Task 3 below assumes
   the decimal pattern; if it is not yet in the schema, do that change first.
2. **Materialized corpus needs the validation run's output** — `materialize_songs.py` (Task 1)
   reads `/tmp/ssv/<pdf-stem>/_assembled.json`. Those exist only for PDFs the validation run has
   finished. Task 1 is testable with a synthetic fixture regardless; running it over the real
   corpus requires the run to be complete.

---

## File structure

| File | Responsibility | Action |
|------|----------------|--------|
| `scripts/materialize_songs.py` | promote scratch assembled docs → per-song corpus + page copies | Create |
| `tests/test_materialize_songs.py` | unit tests for split/slug/copy logic | Create |
| `scripts/qa_server.py` | stdlib HTTP server: list/get/save songs, serve page PNGs, validate-on-save | Create |
| `tests/test_qa_server.py` | request-level tests (list, get, save-valid, save-invalid) | Create |
| `scripts/qa_static/index.html` | UI shell: top bar, two columns, edit panel | Create |
| `scripts/qa_static/app.js` | load/render songs+chips, edit panel, save | Create |
| `scripts/qa_static/fretboard.js` | dual-mode voicing editor (diagram ↔ decimal text, 0–24) | Create |
| `scripts/qa_static/chord_naming.js` | `suggestNames(voicing)` + `validateName(name)` via tonal+chord-symbol | Create |
| `scripts/qa_static/vendor/tonal.min.js` | reverse chord detection | Vendor |
| `scripts/qa_static/vendor/chord-symbol.min.js` | ChordMark-grade parse/normalize | Vendor |

The Python pieces (materialize, server) are unit-tested with pytest. The browser JS is verified
by a manual smoke checklist (Task 9) — no JS test runner is introduced (YAGNI; none exists in repo).

---

## Task 1: materialize_songs.py — split one assembled doc into per-song files

**Files:**
- Create: `scripts/materialize_songs.py`
- Create: `tests/test_materialize_songs.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_materialize_songs.py`:

```python
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import materialize_songs as M


def test_song_filename_uses_track_number_and_slug():
    assert M.song_filename(0, "Chega de Saudade") == "01-chega-de-saudade.json"
    assert M.song_filename(11, "É luxo só") == "12-e-luxo-so.json"


def test_album_slug_strips_and_slugs():
    assert M.album_slug("1 - Chega de Saudade") == "1-chega-de-saudade"


def test_split_songs_returns_one_doc_per_song():
    assembled = {
        "document": {"title": "Album", "source_pdf": "A.pdf", "page_count": 3},
        "songs": [
            {"title": "Song One", "pages": [1], "sections": [{"label": None, "bars": []}]},
            {"title": "Song Two", "pages": [2, 3], "sections": [{"label": None, "bars": []}]},
        ],
    }
    docs = M.split_songs(assembled)
    assert [d["filename"] for d in docs] == ["01-song-one.json", "02-song-two.json"]
    # each per-song doc keeps the document block + exactly one song
    assert docs[0]["doc"]["document"]["title"] == "Album"
    assert len(docs[0]["doc"]["songs"]) == 1
    assert docs[1]["doc"]["songs"][0]["title"] == "Song Two"
    assert docs[1]["pages"] == [2, 3]
```

- [ ] **Step 2: Run to verify it fails**

Run: `./.venv/bin/python -m pytest tests/test_materialize_songs.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'materialize_songs'`.

- [ ] **Step 3: Implement the split/slug helpers**

Create `scripts/materialize_songs.py`:

```python
#!/usr/bin/env python3
"""Promote scratch assembled docs into a committed per-song corpus with page images.

Reads /tmp/ssv/<pdf-stem>/_assembled.json (produced by validate_extraction.py),
splits each into one document-per-song under
data/<artist>/songs/<album-slug>/<NN>-<song-slug>.json, and copies that song's
page PNGs into a sibling pages/ folder.

Usage:
    python materialize_songs.py --workdir /tmp/ssv --out data/joao-gilberto/songs
    python materialize_songs.py --workdir /tmp/ssv --out data/joao-gilberto/songs --only "1 - Chega de Saudade"
"""

import argparse
import json
import re
import shutil
import unicodedata
from pathlib import Path


def slugify(text: str) -> str:
    nfkd = unicodedata.normalize("NFKD", text or "")
    ascii_str = nfkd.encode("ascii", "ignore").decode("ascii").lower()
    ascii_str = re.sub(r"[^\w\s-]", "", ascii_str)
    return re.sub(r"[-\s]+", "-", ascii_str).strip("-")


def album_slug(pdf_stem: str) -> str:
    return slugify(pdf_stem)


def song_filename(index: int, title: str) -> str:
    return f"{index + 1:02d}-{slugify(title)}.json"


def split_songs(assembled: dict) -> list[dict]:
    """Return [{filename, doc, pages}] — one self-contained document per song."""
    document = assembled.get("document", {})
    out = []
    for i, song in enumerate(assembled.get("songs", [])):
        doc = {"document": document, "songs": [song]}
        out.append({
            "filename": song_filename(i, song.get("title") or f"song-{i + 1}"),
            "doc": doc,
            "pages": list(song.get("pages", [])),
        })
    return out
```

- [ ] **Step 4: Run to verify it passes**

Run: `./.venv/bin/python -m pytest tests/test_materialize_songs.py -v`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/materialize_songs.py tests/test_materialize_songs.py
git commit -m "feat: materialize_songs split/slug helpers"
```

---

## Task 2: materialize_songs.py — write files + copy page images

**Files:**
- Modify: `scripts/materialize_songs.py`
- Modify: `tests/test_materialize_songs.py`

- [ ] **Step 1: Add failing test for the writer**

Append to `tests/test_materialize_songs.py`:

```python
def test_materialize_one_writes_json_and_copies_pages(tmp_path):
    # fake scratch workdir: <work>/<stem>/_assembled.json + page PNGs
    stem = "1 - Album"
    work = tmp_path / "ssv" / stem
    work.mkdir(parents=True)
    assembled = {
        "document": {"title": "Album", "source_pdf": "Album.pdf"},
        "songs": [{"title": "Song Two", "pages": [2, 3],
                   "sections": [{"label": None, "bars": []}]}],
    }
    (work / "_assembled.json").write_text(json.dumps(assembled))
    for n in (1, 2, 3):
        (work / f"page-{n:03d}.png").write_bytes(b"PNG" + bytes([n]))

    out = tmp_path / "songs"
    written = M.materialize_one(work / "_assembled.json", out)

    song_json = out / "1-album" / "01-song-two.json"
    assert song_json.exists()
    assert song_json in written
    # only this song's pages (2,3) copied, named by slug+page
    pages_dir = out / "1-album" / "pages"
    assert (pages_dir / "01-song-two-p2.png").exists()
    assert (pages_dir / "01-song-two-p3.png").exists()
    assert not (pages_dir / "01-song-two-p1.png").exists()
```

- [ ] **Step 2: Run to verify it fails**

Run: `./.venv/bin/python -m pytest tests/test_materialize_songs.py::test_materialize_one_writes_json_and_copies_pages -v`
Expected: FAIL — `AttributeError: module 'materialize_songs' has no attribute 'materialize_one'`.

- [ ] **Step 3: Implement `materialize_one` + `main`**

Append to `scripts/materialize_songs.py`:

```python
def materialize_one(assembled_path: Path, out_root: Path) -> list[Path]:
    """Materialize one album's _assembled.json into out_root/<album>/. Return written JSON paths."""
    assembled = json.loads(Path(assembled_path).read_text())
    src_dir = Path(assembled_path).parent
    stem = src_dir.name
    album_dir = out_root / album_slug(stem)
    pages_dir = album_dir / "pages"
    album_dir.mkdir(parents=True, exist_ok=True)
    pages_dir.mkdir(parents=True, exist_ok=True)

    written = []
    for entry in split_songs(assembled):
        json_path = album_dir / entry["filename"]
        json_path.write_text(json.dumps(entry["doc"], ensure_ascii=False, indent=2))
        written.append(json_path)

        slug = entry["filename"][:-5]  # drop ".json"
        for page in entry["pages"]:
            src_png = src_dir / f"page-{page:03d}.png"
            if src_png.exists():
                shutil.copyfile(src_png, pages_dir / f"{slug}-p{page}.png")
    return written


def main():
    ap = argparse.ArgumentParser(description="Materialize per-song corpus from scratch assembled docs")
    ap.add_argument("--workdir", type=Path, default=Path("/tmp/ssv"))
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--only", help="Only this PDF stem (folder name under workdir)")
    args = ap.parse_args()

    assembled_files = sorted(args.workdir.glob("*/_assembled.json"))
    if args.only:
        assembled_files = [f for f in assembled_files if f.parent.name == args.only]
    if not assembled_files:
        print("No _assembled.json files found.")
        return

    for f in assembled_files:
        written = materialize_one(f, args.out)
        print(f"  {f.parent.name}: {len(written)} songs")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run to verify it passes**

Run: `./.venv/bin/python -m pytest tests/test_materialize_songs.py -v`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/materialize_songs.py tests/test_materialize_songs.py
git commit -m "feat: materialize per-song JSON and copy page images"
```

---

## Task 3: qa_server.py — list albums/songs + serve a song JSON

**Files:**
- Create: `scripts/qa_server.py`
- Create: `tests/test_qa_server.py`

The server uses stdlib `http.server`. To keep it testable without sockets, put all routing logic
in a pure `handle(method, path, body, root)` function that returns `(status, content_type, bytes)`;
the `HTTPServer` handler is a thin wrapper. Tests call `handle()` directly.

- [ ] **Step 1: Write the failing test**

Create `tests/test_qa_server.py`:

```python
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import qa_server as S


def _corpus(tmp_path):
    songs = tmp_path / "songs"
    album = songs / "1-album"
    (album / "pages").mkdir(parents=True)
    doc = {"document": {"title": "Album"},
           "songs": [{"title": "Song One", "pages": [1],
                      "sections": [{"label": None, "bars": [[{"chord": "Dm7"}]]}]}]}
    (album / "01-song-one.json").write_text(json.dumps(doc))
    (album / "pages" / "01-song-one-p1.png").write_bytes(b"\x89PNG")
    return songs


def test_list_albums(tmp_path):
    root = _corpus(tmp_path)
    status, ctype, body = S.handle("GET", "/api/albums", b"", root)
    assert status == 200
    data = json.loads(body)
    assert data == [{"album": "1-album", "songs": ["01-song-one.json"]}]


def test_get_song(tmp_path):
    root = _corpus(tmp_path)
    status, ctype, body = S.handle("GET", "/api/song/1-album/01-song-one.json", b"", root)
    assert status == 200
    assert json.loads(body)["songs"][0]["title"] == "Song One"


def test_get_missing_song_404(tmp_path):
    root = _corpus(tmp_path)
    status, _, _ = S.handle("GET", "/api/song/1-album/nope.json", b"", root)
    assert status == 404
```

- [ ] **Step 2: Run to verify it fails**

Run: `./.venv/bin/python -m pytest tests/test_qa_server.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'qa_server'`.

- [ ] **Step 3: Implement routing + GET handlers**

Create `scripts/qa_server.py`:

```python
#!/usr/bin/env python3
"""Local QA correction server for the songsheet per-song corpus.

Serves the browser app and a small JSON API for listing, reading, and saving
songs, plus page images. Saves are validated against the songsheet schema and
refused if invalid.

Usage:
    python qa_server.py --songs data/joao-gilberto/songs --port 8000
"""

import argparse
import json
import re
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parent
SCHEMA_PATH = ROOT / "schemas" / "songsheet.schema.json"
STATIC_DIR = SCRIPTS / "qa_static"

SAFE = re.compile(r"^[A-Za-z0-9._-]+$")  # path-segment guard (no traversal)


def _json(status, obj):
    return status, "application/json", json.dumps(obj, ensure_ascii=False).encode()


def list_albums(root: Path):
    out = []
    for album in sorted(p for p in root.iterdir() if p.is_dir()):
        songs = sorted(f.name for f in album.glob("*.json"))
        out.append({"album": album.name, "songs": songs})
    return out


def handle(method: str, path: str, body: bytes, root: Path):
    """Pure router. Returns (status:int, content_type:str, body:bytes)."""
    parts = [p for p in path.split("/") if p != ""]

    if method == "GET" and path == "/api/albums":
        return _json(200, list_albums(root))

    # /api/song/{album}/{file}
    if parts[:2] == ["api", "song"] and len(parts) == 4:
        album, fname = parts[2], parts[3]
        if not (SAFE.match(album) and SAFE.match(fname)):
            return _json(400, {"error": "bad path"})
        target = root / album / fname
        if method == "GET":
            if not target.exists():
                return _json(404, {"error": "not found"})
            return 200, "application/json", target.read_bytes()
        if method == "POST":
            return save_song(target, body)

    # /api/page/{album}/{file}/{n}  -> pages/<file-stem>-p<n>.png
    if parts[:2] == ["api", "page"] and len(parts) == 5 and method == "GET":
        album, fname, n = parts[2], parts[3], parts[4]
        if not (SAFE.match(album) and SAFE.match(fname) and n.isdigit()):
            return _json(400, {"error": "bad path"})
        slug = fname[:-5] if fname.endswith(".json") else fname
        png = root / album / "pages" / f"{slug}-p{n}.png"
        if not png.exists():
            return _json(404, {"error": "no page"})
        return 200, "image/png", png.read_bytes()

    return _json(404, {"error": "unknown route"})


def save_song(target: Path, body: bytes):
    return _json(501, {"error": "not implemented"})  # Task 4
```

- [ ] **Step 4: Run to verify it passes**

Run: `./.venv/bin/python -m pytest tests/test_qa_server.py -v`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/qa_server.py tests/test_qa_server.py
git commit -m "feat: qa_server routing, list albums, get song/page"
```

---

## Task 4: qa_server.py — validated save

**Files:**
- Modify: `scripts/qa_server.py`
- Modify: `tests/test_qa_server.py`

- [ ] **Step 1: Add failing tests for save**

Append to `tests/test_qa_server.py`:

```python
def test_save_valid_song_writes(tmp_path):
    root = _corpus(tmp_path)
    doc = json.loads((root / "1-album" / "01-song-one.json").read_text())
    doc["songs"][0]["sections"][0]["bars"][0][0]["chord"] = "Am7"  # an edit
    status, _, body = S.handle("POST", "/api/song/1-album/01-song-one.json",
                               json.dumps(doc).encode(), root)
    assert status == 200
    assert json.loads(body)["ok"] is True
    on_disk = json.loads((root / "1-album" / "01-song-one.json").read_text())
    assert on_disk["songs"][0]["sections"][0]["bars"][0][0]["chord"] == "Am7"


def test_save_invalid_song_rejected(tmp_path):
    root = _corpus(tmp_path)
    doc = json.loads((root / "1-album" / "01-song-one.json").read_text())
    # break the schema: a chord entry with no "chord" key
    doc["songs"][0]["sections"][0]["bars"][0][0] = {"voicing": "x,5,7,5,6,5"}
    status, _, body = S.handle("POST", "/api/song/1-album/01-song-one.json",
                               json.dumps(doc).encode(), root)
    assert status == 422
    assert json.loads(body)["ok"] is False
    # original file unchanged
    on_disk = json.loads((root / "1-album" / "01-song-one.json").read_text())
    assert on_disk["songs"][0]["sections"][0]["bars"][0][0]["chord"] == "Dm7"
```

- [ ] **Step 2: Run to verify it fails**

Run: `./.venv/bin/python -m pytest tests/test_qa_server.py -k save -v`
Expected: FAIL — current `save_song` returns 501.

- [ ] **Step 3: Implement validated save**

In `scripts/qa_server.py`, replace the placeholder `save_song` with:

```python
def save_song(target: Path, body: bytes):
    import jsonschema

    try:
        doc = json.loads(body)
    except json.JSONDecodeError as e:
        return _json(400, {"ok": False, "error": f"invalid JSON: {e}"})

    schema = json.loads(SCHEMA_PATH.read_text())
    try:
        jsonschema.validate(doc, schema)
    except jsonschema.ValidationError as e:
        loc = list(e.absolute_path)
        return _json(422, {"ok": False, "error": f"{loc}: {e.message}"})

    target.write_text(json.dumps(doc, ensure_ascii=False, indent=2))
    return _json(200, {"ok": True})
```

- [ ] **Step 4: Run to verify it passes**

Run: `./.venv/bin/python -m pytest tests/test_qa_server.py -v`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/qa_server.py tests/test_qa_server.py
git commit -m "feat: qa_server validated save (422 on schema failure)"
```

---

## Task 5: qa_server.py — static file serving + HTTP wiring

**Files:**
- Modify: `scripts/qa_server.py`
- Modify: `tests/test_qa_server.py`

- [ ] **Step 1: Add failing test for static serving**

Append to `tests/test_qa_server.py`:

```python
def test_serves_index_html(tmp_path, monkeypatch):
    root = _corpus(tmp_path)
    # point STATIC_DIR at a temp dir with an index.html
    static = tmp_path / "static"
    (static / "vendor").mkdir(parents=True)
    (static / "index.html").write_text("<html>QA</html>")
    monkeypatch.setattr(S, "STATIC_DIR", static)
    status, ctype, body = S.handle("GET", "/", b"", root)
    assert status == 200
    assert ctype == "text/html"
    assert b"QA" in body


def test_serves_static_js(tmp_path, monkeypatch):
    root = _corpus(tmp_path)
    static = tmp_path / "static"
    static.mkdir()
    (static / "app.js").write_text("// app")
    monkeypatch.setattr(S, "STATIC_DIR", static)
    status, ctype, body = S.handle("GET", "/app.js", b"", root)
    assert status == 200
    assert "javascript" in ctype
```

- [ ] **Step 2: Run to verify it fails**

Run: `./.venv/bin/python -m pytest tests/test_qa_server.py -k static -v`
Expected: FAIL — `/` and `/app.js` currently return 404 "unknown route".

- [ ] **Step 3: Add static serving to `handle` + the HTTP server wrapper**

In `scripts/qa_server.py`, add this block inside `handle()` **before** the final
`return _json(404, ...)`:

```python
    # static files (index.html at "/", else by name under STATIC_DIR)
    if method == "GET":
        rel = "index.html" if path == "/" else path.lstrip("/")
        # only simple relative paths, no traversal
        if ".." not in rel and all(SAFE.match(seg) for seg in rel.split("/")):
            f = STATIC_DIR / rel
            if f.exists() and f.is_file():
                ext = f.suffix.lower()
                ctype = {".html": "text/html", ".js": "text/javascript",
                         ".css": "text/css", ".png": "image/png",
                         ".json": "application/json"}.get(ext, "application/octet-stream")
                return 200, ctype, f.read_bytes()
```

Then append the HTTP wrapper + main at the end of the file:

```python
def serve(songs_root: Path, port: int):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class Handler(BaseHTTPRequestHandler):
        def _run(self, method):
            length = int(self.headers.get("Content-Length", 0) or 0)
            body = self.rfile.read(length) if length else b""
            status, ctype, payload = handle(method, self.path, body, songs_root)
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):
            self._run("GET")

        def do_POST(self):
            self._run("POST")

        def log_message(self, *a):
            pass

    print(f"QA server on http://localhost:{port}  (songs: {songs_root})")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


def main():
    ap = argparse.ArgumentParser(description="Songsheet QA correction server")
    ap.add_argument("--songs", type=Path, default=ROOT / "data" / "joao-gilberto" / "songs")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    serve(args.songs, args.port)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run to verify it passes**

Run: `./.venv/bin/python -m pytest tests/test_qa_server.py -v`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/qa_server.py tests/test_qa_server.py
git commit -m "feat: qa_server static file serving and HTTP wiring"
```

---

## Task 6: Vendor tonal + chord-symbol; build chord_naming.js

**Files:**
- Create: `scripts/qa_static/vendor/tonal.min.js`
- Create: `scripts/qa_static/vendor/chord-symbol.min.js`
- Create: `scripts/qa_static/chord_naming.js`

There is no JS test runner in this repo; this task is verified by a Node one-liner that exercises
the pure functions, then by the manual smoke checklist in Task 9.

- [ ] **Step 1: Vendor the libraries (UMD/global browser builds)**

Fetch browser builds into `scripts/qa_static/vendor/`:

```bash
mkdir -p scripts/qa_static/vendor
curl -L -o scripts/qa_static/vendor/tonal.min.js https://unpkg.com/@tonaljs/tonal/browser/tonal.min.js
curl -L -o scripts/qa_static/vendor/chord-symbol.min.js https://unpkg.com/chord-symbol/lib/chord-symbol.min.js
```

Verify both downloaded non-empty:

```bash
wc -c scripts/qa_static/vendor/tonal.min.js scripts/qa_static/vendor/chord-symbol.min.js
```
Expected: both > 1000 bytes. If a URL 404s, find the correct browser/UMD build path on unpkc
for that package (`https://unpkg.com/<pkg>/` lists files) and use it; the requirement is a global
`Tonal` (or `Tonal.Chord`) and a `chordSymbol`/`chordParserFactory` global.

- [ ] **Step 2: Write `chord_naming.js`**

Create `scripts/qa_static/chord_naming.js`:

```javascript
// Reverse chord detection (tonal) validated through ChordMark's parser (chord-symbol).
// Loaded after vendor/tonal.min.js and vendor/chord-symbol.min.js (globals: Tonal, chordSymbol).

const TUNING_MIDI = [40, 45, 50, 55, 59, 64]; // E A D G B e (low->high), standard

// voicing: array of 6 entries, each "x" or fret number (0-24), low E -> high e
function voicingToNotes(voicing) {
  const notes = [];
  voicing.forEach((f, i) => {
    if (f === "x" || f === null || f === undefined) return;
    const midi = TUNING_MIDI[i] + Number(f);
    notes.push(Tonal.Midi.midiToNoteName(midi, { pitchClass: false }));
  });
  return notes; // ordered low->high; first is the bass
}

function parseChordmark(name) {
  // chord-symbol parser (same one ChordMark uses). Returns null if not parseable.
  const parse = chordSymbol.chordParserFactory();
  const res = parse(name);
  return res && !res.error ? res : null;
}

// Return ranked names that are BOTH detected from the notes AND valid ChordMark chords.
function suggestNames(voicing) {
  const notes = voicingToNotes(voicing);
  if (notes.length < 2) return [];
  const bass = notes[0];
  const detected = Tonal.Chord.detect(notes, { assumeBass: bass }) || [];
  const out = [];
  for (const cand of detected) {
    const parsed = parseChordmark(cand);
    if (parsed) out.push({ name: parsed.normalized || cand, raw: cand });
  }
  return out;
}

// Validate/normalize a user-typed name against ChordMark's parser.
function validateName(name) {
  const parsed = parseChordmark(name);
  if (!parsed) return { valid: false };
  return { valid: true, normalized: parsed.normalized || name };
}

// Does the typed name's pitch set match the voicing's pitch set?
function nameMatchesVoicing(name, voicing) {
  const parsed = parseChordmark(name);
  if (!parsed || !parsed.notes) return null; // can't tell
  const want = new Set(parsed.notes.map((n) => Tonal.Note.chroma(n)));
  const have = new Set(voicingToNotes(voicing).map((n) => Tonal.Note.chroma(n)));
  if (want.size !== have.size) return false;
  for (const c of want) if (!have.has(c)) return false;
  return true;
}

window.ChordNaming = { voicingToNotes, suggestNames, validateName, nameMatchesVoicing };
```

- [ ] **Step 3: Smoke-check the pure logic under Node**

Run (loads the vendored libs + module in a fake `window`, then asserts a known chord):

```bash
./node_or_skip.sh 2>/dev/null || node -e '
global.window = {};
require("./scripts/qa_static/vendor/tonal.min.js");
require("./scripts/qa_static/vendor/chord-symbol.min.js");
global.Tonal = window.Tonal || global.Tonal;
global.chordSymbol = window.chordSymbol || global.chordSymbol;
require("./scripts/qa_static/chord_naming.js");
const s = window.ChordNaming.suggestNames(["x",5,7,5,6,5]);
console.log("Dm7 voicing suggests:", s.map(x=>x.name));
if (!s.some(x=>/Dm7|Dmin7/.test(x.name))) { console.error("FAIL: expected Dm7"); process.exit(1); }
console.log("OK");
'
```
Expected: prints a suggestion list containing a `Dm7`-equivalent and `OK`.
Note: the exact global names (`window.Tonal`, `window.chordSymbol`) depend on the vendored
builds — if the globals differ, adjust the `global.X = ...` lines and the references in
`chord_naming.js` to match what the builds actually export. The contract that matters:
`suggestNames(["x",5,7,5,6,5])` yields a Dm7-equivalent.

- [ ] **Step 4: Commit**

```bash
git add scripts/qa_static/vendor scripts/qa_static/chord_naming.js
git commit -m "feat: vendor tonal+chord-symbol, add chord_naming (detect+validate)"
```

---

## Task 7: fretboard.js — dual-mode voicing editor

**Files:**
- Create: `scripts/qa_static/fretboard.js`

Verified manually (Task 9). This module exposes a factory that renders into a container and
calls back with the decimal voicing on every change; it owns both the clickable vertical diagram
and the decimal text field, kept in sync.

- [ ] **Step 1: Implement `fretboard.js`**

Create `scripts/qa_static/fretboard.js`:

```javascript
// Dual-mode voicing editor: vertical chord diagram <-> decimal text field, two-way bound.
// Usage: const fb = Fretboard(containerEl, onChange);  fb.set(["x",6,8,6,7,6]);
// onChange(voicingArray) fires on every valid change. Frets 0-24; "x" = muted.

const STRINGS = 6, WINDOW = 5;
const STRING_LABELS = ["E", "A", "D", "G", "B", "e"];

function Fretboard(container, onChange) {
  let voicing = ["x", "x", "x", "x", "x", "x"];
  let start = 1; // top fret of the visible window

  function fittedStart(v) {
    const fretted = v.filter((f) => f !== "x" && f !== 0).map(Number);
    if (!fretted.length) return 1;
    const lo = Math.min(...fretted);
    return lo >= 1 && lo <= 24 ? Math.max(1, Math.min(lo, 24 - WINDOW + 1)) : 1;
  }

  function parseText(raw) {
    const toks = raw.split(",").map((t) => t.trim());
    if (toks.length !== STRINGS) return { error: "need exactly 6 values" };
    const out = [];
    for (const t of toks) {
      if (t === "x" || t === "X") { out.push("x"); continue; }
      if (!/^\d{1,2}$/.test(t)) return { error: `bad value "${t}"` };
      const n = parseInt(t, 10);
      if (n < 0 || n > 24) return { error: `fret ${n} out of range 0-24` };
      out.push(n);
    }
    return { voicing: out };
  }

  function render() {
    container.innerHTML = "";
    // fret window controls
    const ctl = document.createElement("div");
    ctl.className = "fb-ctl";
    ctl.innerHTML = `<button data-act="dn">−</button><span>fret ${start}</span><button data-act="up">+</button>`;
    ctl.querySelector('[data-act=dn]').onclick = () => { if (start > 1) { start--; render(); } };
    ctl.querySelector('[data-act=up]').onclick = () => { if (start < 24 - WINDOW + 1) { start++; render(); } };
    container.appendChild(ctl);

    // SVG-free DOM grid
    const grid = document.createElement("div");
    grid.className = "fb-grid";
    for (let s = 0; s < STRINGS; s++) {
      const col = document.createElement("div");
      col.className = "fb-col";
      // marker (x / o / fretted)
      const mark = document.createElement("div");
      mark.className = "fb-mark";
      mark.textContent = voicing[s] === "x" ? "×" : voicing[s] === 0 ? "○" : "";
      mark.onclick = () => { voicing[s] = voicing[s] === "x" ? 0 : "x"; emit(); render(); };
      col.appendChild(mark);
      // fret cells
      for (let f = 0; f < WINDOW; f++) {
        const absFret = start + f;
        const cell = document.createElement("div");
        cell.className = "fb-cell" + (voicing[s] === absFret ? " on" : "");
        cell.title = `string ${STRING_LABELS[s]} fret ${absFret}`;
        cell.onclick = () => { voicing[s] = voicing[s] === absFret ? "x" : absFret; emit(); render(); };
        col.appendChild(cell);
      }
      const lbl = document.createElement("div");
      lbl.className = "fb-lbl";
      lbl.textContent = STRING_LABELS[s];
      col.appendChild(lbl);
      grid.appendChild(col);
    }
    container.appendChild(grid);

    // decimal text field
    const text = document.createElement("input");
    text.type = "text";
    text.className = "fb-text";
    text.value = voicing.join(",");
    const err = document.createElement("div");
    err.className = "fb-err";
    const apply = () => {
      const r = parseText(text.value);
      if (r.error) { err.textContent = r.error; return; }
      err.textContent = "";
      voicing = r.voicing;
      start = fittedStart(voicing);
      emit();
      render();
    };
    text.onchange = apply;
    text.onkeydown = (e) => { if (e.key === "Enter") apply(); };
    container.appendChild(text);
    container.appendChild(err);
  }

  function emit() { onChange(voicing.slice()); }

  render();
  return {
    set(v) { voicing = v.slice(); start = fittedStart(voicing); render(); },
    get() { return voicing.slice(); },
  };
}

window.Fretboard = Fretboard;
```

- [ ] **Step 2: Commit**

```bash
git add scripts/qa_static/fretboard.js
git commit -m "feat: dual-mode voicing editor (diagram + decimal text)"
```

---

## Task 8: index.html + app.js — the full UI

**Files:**
- Create: `scripts/qa_static/index.html`
- Create: `scripts/qa_static/app.js`

Verified manually (Task 9).

- [ ] **Step 1: Create `index.html`**

Create `scripts/qa_static/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Songsheet QA</title>
<style>
  body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f1115;color:#e6e8ee}
  header{display:flex;gap:12px;align-items:center;padding:10px 14px;background:#171a21;border-bottom:1px solid #2a2f3a;position:sticky;top:0}
  header select{background:#1e222b;color:#e6e8ee;border:1px solid #2a2f3a;border-radius:6px;padding:5px}
  header .spacer{flex:1}
  header button{background:#6ea8fe;color:#06132b;border:0;border-radius:6px;padding:7px 14px;font-weight:600;cursor:pointer}
  .layout{display:grid;grid-template-columns:1fr 1fr;height:calc(100vh - 49px)}
  .col{overflow:auto;padding:14px}
  .col.left{border-right:1px solid #2a2f3a;background:#0c0e12}
  .col.left img{width:100%;border:1px solid #2a2f3a;border-radius:8px;margin-bottom:6px;background:#fff}
  .pagecap{color:#9aa3b2;font-size:12px;margin-bottom:12px}
  .section-label{color:#9aa3b2;text-transform:uppercase;font-size:11px;letter-spacing:.08em;margin:16px 0 8px}
  .bar{border:1px solid #2a2f3a;border-radius:8px;padding:8px;margin-bottom:8px;background:#171a21}
  .barnum{color:#9aa3b2;font-size:11px;margin-bottom:6px}
  .chips{display:flex;flex-wrap:wrap;gap:6px}
  .chip{background:#222836;border:1px solid #2a2f3a;border-radius:7px;padding:6px 9px;cursor:pointer;min-width:60px}
  .chip:hover{border-color:#6ea8fe}.chip.sel{background:#2d3b5a;border-color:#6ea8fe}
  .chip .nm{font-weight:600}.chip.pct .nm{color:#6ea8fe}
  .chip .vc{font:11px ui-monospace,monospace;color:#9aa3b2}
  .chip .tx{font-size:12px;opacity:.85}
  .chip .warn{display:inline-block;width:8px;height:8px;border-radius:50%;background:#f85149;margin-left:5px}
  .editor{position:fixed;right:0;top:49px;bottom:0;width:360px;background:#1e222b;border-left:1px solid #2a2f3a;padding:16px;overflow:auto;transform:translateX(100%);transition:transform .15s}
  .editor.open{transform:none}
  .editor h2{font-size:13px;color:#9aa3b2;text-transform:uppercase;margin:0 0 12px}
  .editor label{display:block;font-size:12px;color:#9aa3b2;margin:12px 0 4px}
  .editor input[type=text]{width:100%;background:#11141b;border:1px solid #2a2f3a;color:#e6e8ee;border-radius:6px;padding:8px}
  .badge{display:inline-flex;gap:6px;font-size:12px;padding:3px 8px;border-radius:20px;margin-top:6px}
  .badge.ok{background:#10271a;color:#3fb950}.badge.bad{background:#2b1416;color:#f85149}
  .suggest .s{display:flex;justify-content:space-between;padding:6px 8px;border:1px solid #2a2f3a;border-radius:6px;margin:5px 0;cursor:pointer}
  .suggest .s:hover{border-color:#6ea8fe}
  .fb-ctl{display:flex;gap:8px;align-items:center;color:#9aa3b2;font-size:12px;margin-bottom:8px}
  .fb-ctl button{background:#171a21;border:1px solid #2a2f3a;color:#e6e8ee;border-radius:5px;width:24px;height:24px;cursor:pointer}
  .fb-grid{display:flex;gap:0;justify-content:center;background:#11141b;border:1px solid #2a2f3a;border-radius:8px;padding:10px}
  .fb-col{display:flex;flex-direction:column;align-items:center;width:30px}
  .fb-mark{height:18px;font:13px ui-monospace,monospace;cursor:pointer}
  .fb-cell{width:28px;height:30px;border-top:1px solid #48515f;border-left:1px solid #48515f;cursor:pointer;position:relative}
  .fb-col:last-child .fb-cell{border-right:1px solid #48515f}
  .fb-cell.on::after{content:"";position:absolute;inset:5px;border-radius:50%;background:#6ea8fe}
  .fb-lbl{font:10px ui-monospace,monospace;color:#9aa3b2;margin-top:4px}
  .fb-text{margin-top:10px}
  .fb-err{color:#f85149;font-size:12px;min-height:16px;margin-top:4px}
  .ed-actions{display:flex;gap:8px;margin-top:16px}
  .ed-actions button{flex:1;border-radius:6px;padding:9px;border:1px solid #2a2f3a;background:#171a21;color:#e6e8ee;cursor:pointer}
  .ed-actions .apply{background:#6ea8fe;color:#06132b;border:0;font-weight:600}
</style>
</head>
<body>
<header>
  <select id="albumSel"></select>
  <select id="songSel"></select>
  <span id="flagCount" style="color:#9aa3b2;font-size:12px"></span>
  <span class="spacer"></span>
  <span id="saveStatus" style="font-size:12px"></span>
  <button id="saveBtn">Save song</button>
</header>
<div class="layout">
  <div class="col left" id="pages"></div>
  <div class="col right" id="bars"></div>
</div>
<aside class="editor" id="editor"></aside>
<script src="vendor/tonal.min.js"></script>
<script src="vendor/chord-symbol.min.js"></script>
<script src="chord_naming.js"></script>
<script src="fretboard.js"></script>
<script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `app.js`**

Create `scripts/qa_static/app.js`:

```javascript
// Songsheet QA app: load albums/songs, render pages + editable chord chips, edit panel, save.
let state = { album: null, file: null, doc: null, sel: null };

async function api(path, opts) {
  const r = await fetch(path, opts);
  return r.json();
}

async function init() {
  const albums = await api("/api/albums");
  const albumSel = document.getElementById("albumSel");
  albumSel.innerHTML = albums.map((a) => `<option>${a.album}</option>`).join("");
  const songSel = document.getElementById("songSel");
  function fillSongs() {
    const a = albums.find((x) => x.album === albumSel.value);
    songSel.innerHTML = a.songs.map((s) => `<option>${s}</option>`).join("");
  }
  albumSel.onchange = () => { fillSongs(); loadSong(); };
  songSel.onchange = loadSong;
  document.getElementById("saveBtn").onclick = save;
  fillSongs();
  loadSong();
}

async function loadSong() {
  state.album = document.getElementById("albumSel").value;
  state.file = document.getElementById("songSel").value;
  state.doc = await api(`/api/song/${state.album}/${state.file}`);
  state.sel = null;
  renderPages();
  renderBars();
  document.getElementById("editor").classList.remove("open");
}

function song() { return state.doc.songs[0]; }

function renderPages() {
  const pages = song().pages || [];
  document.getElementById("pages").innerHTML = pages.map((n) =>
    `<img src="/api/page/${state.album}/${state.file}/${n}" alt="page ${n}">
     <div class="pagecap">page ${n}</div>`).join("");
}

function eachChord(cb) {
  song().sections.forEach((sec, si) =>
    sec.bars.forEach((bar, bi) =>
      bar.forEach((e, ei) => cb(e, si, bi, ei))));
}

function renderBars() {
  const root = document.getElementById("bars");
  root.innerHTML = "";
  let flags = 0;
  song().sections.forEach((sec, si) => {
    const lab = document.createElement("div");
    lab.className = "section-label";
    lab.textContent = sec.label || `Section ${si + 1}`;
    root.appendChild(lab);
    sec.bars.forEach((bar, bi) => {
      const bd = document.createElement("div");
      bd.className = "bar";
      bd.innerHTML = `<div class="barnum">bar ${bi + 1}${bar.length > 1 ? " · " + bar.length + " chords" : ""}</div>`;
      const chips = document.createElement("div");
      chips.className = "chips";
      bar.forEach((e, ei) => {
        const mismatch = e.chord !== "%" && e.voicing &&
          window.ChordNaming.nameMatchesVoicing(e.chord, parseVoicing(e.voicing)) === false;
        if (mismatch) flags++;
        const chip = document.createElement("div");
        chip.className = "chip" + (e.chord === "%" ? " pct" : "") +
          (state.sel && state.sel.si === si && state.sel.bi === bi && state.sel.ei === ei ? " sel" : "");
        chip.innerHTML =
          `<div class="nm">${e.chord}${mismatch ? '<span class="warn"></span>' : ""}</div>
           <div class="vc">${e.voicing || "—"}</div>
           <div class="tx">${e.text ? "_" + e.text : "—"}</div>`;
        chip.onclick = () => openEditor(si, bi, ei);
        chips.appendChild(chip);
      });
      bd.appendChild(chips);
      root.appendChild(bd);
    });
  });
  document.getElementById("flagCount").textContent = flags ? `${flags} flagged` : "";
}

function parseVoicing(s) {
  return s.split(",").map((t) => (t === "x" ? "x" : parseInt(t, 10)));
}

function openEditor(si, bi, ei) {
  state.sel = { si, bi, ei };
  const e = song().sections[si].bars[bi][ei];
  const ed = document.getElementById("editor");
  ed.classList.add("open");
  ed.innerHTML = `
    <h2>Edit chord · bar ${bi + 1}</h2>
    <label>Chord name</label>
    <input type="text" id="edName" value="${e.chord}">
    <div id="edBadge"></div>
    <label>Anchored lyric</label>
    <input type="text" id="edText" value="${e.text || ""}">
    <label>Voicing</label>
    <div id="edFb"></div>
    <label>Suggestions</label>
    <div class="suggest" id="edSuggest"></div>
    <div class="ed-actions">
      <button class="apply" id="edApply">Apply</button>
      <button id="edCancel">Cancel</button>
    </div>`;
  let curVoicing = e.voicing ? parseVoicing(e.voicing) : ["x","x","x","x","x","x"];
  const fb = window.Fretboard(document.getElementById("edFb"), (v) => {
    curVoicing = v;
    refreshNaming();
  });
  fb.set(curVoicing);
  document.getElementById("edName").oninput = refreshNaming;

  function refreshNaming() {
    const name = document.getElementById("edName").value.trim();
    const badge = document.getElementById("edBadge");
    const match = window.ChordNaming.nameMatchesVoicing(name, curVoicing);
    if (match === true) { badge.className = "badge ok"; badge.textContent = "● matches voicing"; }
    else if (match === false) { badge.className = "badge bad"; badge.textContent = "● name ≠ voicing"; }
    else { badge.className = ""; badge.textContent = ""; }
    const sug = window.ChordNaming.suggestNames(curVoicing);
    document.getElementById("edSuggest").innerHTML = sug.length
      ? sug.map((s) => `<div class="s" data-n="${s.name}"><b>${s.name}</b><span>suggest</span></div>`).join("")
      : `<div class="s"><span>no detection</span></div>`;
    document.querySelectorAll("#edSuggest .s[data-n]").forEach((el) =>
      el.onclick = () => { document.getElementById("edName").value = el.dataset.n; refreshNaming(); });
  }
  refreshNaming();

  document.getElementById("edApply").onclick = () => {
    const name = document.getElementById("edName").value.trim();
    const v = window.ChordNaming.validateName(name);
    if (!v.valid && name !== "%") { alert("Not a valid ChordMark chord: " + name); return; }
    e.chord = name;
    const text = document.getElementById("edText").value.trim();
    if (text) e.text = text; else delete e.text;
    const vc = fb.get();
    if (vc.every((f) => f === "x")) delete e.voicing;
    else e.voicing = vc.join(",");
    renderBars();
  };
  document.getElementById("edCancel").onclick = () => {
    ed.classList.remove("open"); state.sel = null; renderBars();
  };
}

async function save() {
  const status = document.getElementById("saveStatus");
  status.textContent = "saving…"; status.style.color = "#9aa3b2";
  const res = await api(`/api/song/${state.album}/${state.file}`,
    { method: "POST", body: JSON.stringify(state.doc) });
  if (res.ok) { status.textContent = "✓ saved"; status.style.color = "#3fb950"; }
  else { status.textContent = "✗ " + res.error; status.style.color = "#f85149"; }
}

init();
```

- [ ] **Step 3: Commit**

```bash
git add scripts/qa_static/index.html scripts/qa_static/app.js
git commit -m "feat: QA UI shell + app (pages, chord chips, edit panel, save)"
```

---

## Task 9: End-to-end manual smoke test

**Files:** none (verification task)

- [ ] **Step 1: Materialize a small album from the validation run output**

Run (Chega de Saudade is fully cached from the validation run):

```bash
./.venv/bin/python scripts/materialize_songs.py --workdir /tmp/ssv \
  --out data/joao-gilberto/songs --only "1 - Chega de Saudade"
ls data/joao-gilberto/songs/1-chega-de-saudade/
ls data/joao-gilberto/songs/1-chega-de-saudade/pages/ | head
```
Expected: ~13 per-song JSON files + a `pages/` folder of PNGs.

- [ ] **Step 2: Start the server**

Run: `./.venv/bin/python scripts/qa_server.py --songs data/joao-gilberto/songs &`
Expected: prints `QA server on http://localhost:8000`.

- [ ] **Step 3: Manual checklist in the browser** (open http://localhost:8000)

Confirm each:
- Album + song dropdowns populate; selecting a song loads it.
- Left column shows the song's page scan(s); right column shows bars with chord chips
  (name / voicing / lyric), `%` chips styled distinctly.
- A chord with a name↔voicing mismatch shows a red warning dot; the header shows "N flagged".
- Clicking a chip opens the editor; the fretboard shows the current voicing as dots.
- Clicking grid cells changes the voicing AND the decimal text field updates; editing the
  decimal text field (e.g. `x,9,11,10,11,9`) redraws the diagram; an out-of-range value
  (e.g. `x,99,1,1,1,1`) shows an inline error and does not apply.
- Suggestions list populates from the voicing; clicking one sets the name; the badge flips
  green/red appropriately.
- Typing a nonstandard name (e.g. `A13,9`) and clicking Apply is rejected as invalid ChordMark.
- Save shows "✓ saved"; re-loading the song shows the edit persisted. Editing to break the
  schema is impossible via the UI, but a manual bad POST returns the 422 error in the status.

- [ ] **Step 4: Stop the server and commit any doc note**

```bash
kill %1 2>/dev/null
```
(No code commit unless the checklist surfaced a fix.)

---

## Self-review notes

- **Spec coverage:** materialize step (T1–2), server list/get/save/static (T3–5), reverse
  detection + chord-symbol validation (T6), dual-mode voicing editor (T7), side-by-side UI with
  name/voicing/lyric editing + flags (T8), e2e (T9). v1 non-goals (bar editing, ChordMark
  playback) are not implemented — correct.
- **Decimal voicing 0–24** enforced in both `fretboard.js` (`parseText`) and the schema (server
  save) — consistent with the voicing-encoding decision.
- **chord-symbol gate:** every suggested and typed name passes through `chordParserFactory`
  before it can be stored (T6 `suggestNames`/`validateName`, T8 Apply handler) — satisfies the
  "pass naming through ChordMark's parser" requirement.
- **Vendoring risk:** Task 6 Step 1/3 calls out that exact unpkg paths + global names may vary;
  the contract (a working `suggestNames(["x",5,7,5,6,5])`→Dm7) is the acceptance check.
```
