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

import jsonschema  # imported at startup so a save never fails on a lazy import

SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parent
SCHEMA_PATH = ROOT / "schemas" / "songsheet.schema.json"
STATIC_DIR = SCRIPTS / "qa_static"

SAFE = re.compile(r"^[A-Za-z0-9._-]+$")  # path-segment guard (no traversal)


def _safe_under(root: Path, *segments) -> Path | None:
    """Resolve root/segments and return it only if it stays inside root; else None."""
    for seg in segments:
        if seg in ("", ".", "..") or not SAFE.match(seg):
            return None
    candidate = (root / Path(*segments)).resolve()
    root_resolved = root.resolve()
    if candidate == root_resolved or root_resolved in candidate.parents:
        return candidate
    return None


def _json(status, obj):
    return status, "application/json", json.dumps(obj, ensure_ascii=False).encode()


def _query_params(path):
    """Parse the query string of a raw path into a flat dict (last value wins)."""
    from urllib.parse import urlparse, parse_qs
    q = urlparse(path).query
    return {k: v[-1] for k, v in parse_qs(q).items()}


def _bars_per_line(params):
    """The bars-per-line layout guide from ?bars=, restricted to 4/6/8 (default 4)."""
    try:
        n = int(params.get("bars", 4))
    except (TypeError, ValueError):
        n = 4
    return n if n in (4, 6, 8) else 4


def _song_status(path: Path):
    """Read document.status from a song JSON; default 'pending'. Never raises."""
    try:
        doc = json.loads(path.read_text())
        return doc.get("document", {}).get("status") or "pending"
    except Exception:
        return "pending"


def list_albums(root: Path):
    out = []
    for album in sorted(p for p in root.iterdir() if p.is_dir()):
        songs = [
            {"file": f.name, "status": _song_status(f)}
            for f in sorted(album.glob("*.json"))
        ]
        out.append({"album": album.name, "songs": songs})
    return out


def _chrome():
    """Path to a headless-capable Chrome/Chromium binary, or None if not found."""
    import shutil
    for c in ("google-chrome", "chromium", "chromium-browser"):
        p = shutil.which(c)
        if p:
            return p
    mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    return mac if Path(mac).exists() else None


def _chrome_convert(html: str, fmt: str):
    """Render an HTML string to PDF or PNG bytes via headless Chrome.

    fmt is "pdf" or "png". Returns the bytes, or raises RuntimeError if Chrome is
    missing or the conversion fails / times out.
    """
    import subprocess
    import tempfile

    chrome = _chrome()
    if not chrome:
        raise RuntimeError("Chrome not found")

    with tempfile.TemporaryDirectory() as tmp:
        in_html = Path(tmp) / "in.html"
        in_html.write_text(html, encoding="utf-8")
        if fmt == "pdf":
            out = Path(tmp) / "out.pdf"
            cmd = [chrome, "--headless", "--disable-gpu", "--no-pdf-header-footer",
                   f"--print-to-pdf={out}", str(in_html)]
        else:
            out = Path(tmp) / "out.png"
            cmd = [chrome, "--headless", "--disable-gpu", f"--screenshot={out}",
                   "--window-size=1100,1600", str(in_html)]
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        except subprocess.TimeoutExpired as e:
            raise RuntimeError("Chrome conversion timed out") from e
        if not out.exists():
            raise RuntimeError(f"Chrome conversion failed: {r.stderr or r.stdout}")
        return out.read_bytes()


def _attach(stem: str, ext: str):
    """A Content-Disposition attachment header dict for <stem>.<ext>."""
    return {"Content-Disposition": f'attachment; filename="{stem}.{ext}"'}


def _render_html_for_export(target: Path, params):
    """Build the export HTML for a single song (style=target default, or fork).

    Returns (html_str, None) on success or (None, error_3tuple) on failure.
    """
    bars = _bars_per_line(params)
    if params.get("style") == "fork":
        result = render_song_html(target, bars_per_line=bars)
    else:
        result = render_target_html(
            target,
            dictionary=params.get("dict", "per_voicing"),
            inline=params.get("inline") == "1",
            bars_per_line=bars,
        )
    # render_*_html return (200, "text/html", bytes); surface any non-200 as error
    if result[0] != 200:
        return None, result
    return result[2].decode("utf-8"), None


def _load_doc(body: bytes):
    """Parse a request body into a document dict.

    Returns (doc, None) on success or (None, error_3tuple) on a JSON parse error.
    """
    try:
        return json.loads(body), None
    except (json.JSONDecodeError, ValueError) as e:
        return None, _json(400, {"error": f"invalid JSON: {e}"})


def handle(method: str, path: str, body: bytes, root: Path):
    """Pure router. Returns (status, ctype, body) or (status, ctype, body, headers)."""
    orig_path = path
    path = path.split("?", 1)[0]  # drop query string (e.g. cache-bust ?t=)
    parts = [p for p in path.split("/") if p != ""]

    if method == "GET" and path == "/api/albums":
        return _json(200, list_albums(root))

    # /api/song/{album}/{file}
    if parts[:2] == ["api", "song"] and len(parts) == 4:
        album, fname = parts[2], parts[3]
        target = _safe_under(root, album, fname)
        if target is None:
            return _json(400, {"error": "bad path"})
        if method == "GET":
            if not target.exists():
                return _json(404, {"error": "not found"})
            return 200, "application/json", target.read_bytes()
        if method == "POST":
            return save_song(target, body)

    # /api/chordmark/{album}/{file}  -> the generated ChordMark source text
    if parts[:2] == ["api", "chordmark"] and len(parts) == 4 and method == "GET":
        album, fname = parts[2], parts[3]
        target = _safe_under(root, album, fname)
        if target is None:
            return _json(400, {"error": "bad path"})
        if not target.exists():
            return _json(404, {"error": "not found"})
        try:
            text = _build_chordmark(target, _bars_per_line(_query_params(orig_path)))
        except Exception as e:  # noqa: BLE001
            return _json(500, {"error": f"chordmark build failed: {e}"})
        return 200, "text/plain; charset=utf-8", text.encode()

    # /api/render-doc?style=target|fork&dict=&inline=&bars=  -> render from POSTed doc
    #   Live preview of UNSAVED edits: body is the in-memory document. Never writes.
    if path == "/api/render-doc" and method == "POST":
        doc, err = _load_doc(body)
        if err is not None:
            return err
        params = _query_params(orig_path)
        bars = _bars_per_line(params)
        if params.get("style") == "fork":
            return render_song_doc(doc, bars_per_line=bars)
        return render_target_doc(
            doc,
            dictionary=params.get("dict", "per_voicing"),
            inline=params.get("inline") == "1",
            bars_per_line=bars,
        )

    # /api/chordmark-doc?bars=  -> the generated ChordMark source from a POSTed doc
    if path == "/api/chordmark-doc" and method == "POST":
        doc, err = _load_doc(body)
        if err is not None:
            return err
        try:
            text = _build_chordmark_doc(doc, _bars_per_line(_query_params(orig_path)))
        except Exception as e:  # noqa: BLE001
            return _json(500, {"error": f"chordmark build failed: {e}"})
        return 200, "text/plain; charset=utf-8", text.encode()

    # /api/render/{album}/{file}  -> ChordMark HTML rendered via the fork
    if parts[:2] == ["api", "render"] and len(parts) == 4 and method == "GET":
        album, fname = parts[2], parts[3]
        target = _safe_under(root, album, fname)
        if target is None:
            return _json(400, {"error": "bad path"})
        if not target.exists():
            return _json(404, {"error": "not found"})
        params = _query_params(orig_path)
        bars = _bars_per_line(params)
        if params.get("style") == "target":
            return render_target_html(
                target,
                dictionary=params.get("dict", "per_voicing"),
                inline=params.get("inline") == "1",
                bars_per_line=bars,
            )
        return render_song_html(target, bars_per_line=bars)

    # /api/export/{album}/{file}?fmt=chordmark|html|pdf|png  -> downloadable file
    if parts[:2] == ["api", "export"] and len(parts) == 4 and method == "GET":
        album, fname = parts[2], parts[3]
        target = _safe_under(root, album, fname)
        if target is None:
            return _json(400, {"error": "bad path"})
        if not target.exists():
            return _json(404, {"error": "not found"})
        params = _query_params(orig_path)
        fmt = params.get("fmt", "html")
        stem = fname[:-5] if fname.endswith(".json") else fname

        if fmt == "chordmark":
            try:
                text = _build_chordmark(target, _bars_per_line(params))
            except Exception as e:  # noqa: BLE001
                return _json(500, {"error": f"chordmark build failed: {e}"})
            return (200, "text/plain; charset=utf-8", text.encode(),
                    _attach(stem, "chordmark"))

        if fmt == "chordpro":
            try:
                text = _build_chordpro(target)
            except Exception as e:  # noqa: BLE001
                return _json(500, {"error": f"chordpro build failed: {e}"})
            return (200, "text/plain; charset=utf-8", text.encode(),
                    _attach(stem, "chordpro"))

        html, err = _render_html_for_export(target, params)
        if err is not None:
            return err
        if fmt == "html":
            return 200, "text/html", html.encode(), _attach(stem, "html")
        if fmt in ("pdf", "png"):
            if _chrome() is None:
                return _json(500, {"error": "Chrome not found for PDF export"})
            try:
                blob = _chrome_convert(html, fmt)
            except RuntimeError as e:
                return _json(500, {"error": str(e)})
            ctype = "application/pdf" if fmt == "pdf" else "image/png"
            return 200, ctype, blob, _attach(stem, fmt)
        return _json(400, {"error": f"unknown fmt: {fmt}"})

    # /api/export-album/{album}?fmt=pdf|html  -> whole-album songbook (one document)
    if parts[:2] == ["api", "export-album"] and len(parts) == 3 and method == "GET":
        album = parts[2]
        album_dir = _safe_under(root, album)
        if album_dir is None:
            return _json(400, {"error": "bad path"})
        if not album_dir.is_dir():
            return _json(404, {"error": "not found"})
        params = _query_params(orig_path)
        fmt = params.get("fmt", "pdf")
        html, err = _render_album_songbook_html(album_dir, album, params)
        if err is not None:
            return err
        if fmt == "html":
            return 200, "text/html", html.encode(), _attach(f"{album}-songbook", "html")
        if fmt == "pdf":
            if _chrome() is None:
                return _json(500, {"error": "Chrome not found for PDF export"})
            try:
                blob = _chrome_convert(html, "pdf")
            except RuntimeError as e:
                return _json(500, {"error": str(e)})
            return 200, "application/pdf", blob, _attach(f"{album}-songbook", "pdf")
        return _json(400, {"error": f"unknown fmt: {fmt}"})

    # /api/page/{album}/{file}/{n}  -> pages/<file-stem>-p<n>.png
    if parts[:2] == ["api", "page"] and len(parts) == 5 and method == "GET":
        album, fname, n = parts[2], parts[3], parts[4]
        if not n.isdigit():
            return _json(400, {"error": "bad path"})
        slug = fname[:-5] if fname.endswith(".json") else fname
        png = _safe_under(root, album, "pages", f"{slug}-p{n}.png")
        if png is None:
            return _json(400, {"error": "bad path"})
        if not png.exists():
            return _json(404, {"error": "no page"})
        return 200, "image/png", png.read_bytes()

    # static files (index.html at "/", else by name under STATIC_DIR)
    if method == "GET":
        rel = "index.html" if path == "/" else path.lstrip("/")
        if ".." not in rel and all(SAFE.match(seg) for seg in rel.split("/")):
            f = STATIC_DIR / rel
            if f.exists() and f.is_file():
                ext = f.suffix.lower()
                ctype = {".html": "text/html", ".js": "text/javascript",
                         ".css": "text/css", ".png": "image/png",
                         ".json": "application/json"}.get(ext, "application/octet-stream")
                return 200, ctype, f.read_bytes()

    return _json(404, {"error": "unknown route"})


def save_song(target: Path, body: bytes):
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


def _html_error(msg):
    body = (f"<!doctype html><meta charset='utf-8'>"
            f"<body style='font:14px sans-serif;color:#b00;padding:20px'>"
            f"ChordMark preview unavailable:<br><pre>{msg}</pre></body>")
    return 200, "text/html", body.encode()


def render_target_doc(doc, dictionary="per_voicing", inline=False, bars_per_line=4):
    """Render a document dict to the target lead-sheet HTML (pure Python, no fork).

    The doc-based core shared by the GET (from path) and POST (from body) routes.
    """
    import render_target

    try:
        songs = doc.get("songs", [])
        if not songs:
            return _html_error("no songs in document")
        html = render_target.render_song(songs[0], dictionary=dictionary,
                                         inline_diagrams=inline, bars_per_line=bars_per_line)
        return 200, "text/html", html.encode()
    except Exception as e:  # noqa: BLE001
        return _html_error(f"target render failed: {e}")


def render_target_html(song_path: Path, dictionary="per_voicing", inline=False, bars_per_line=4):
    """Render a saved song to the target lead-sheet HTML (pure Python, no fork)."""
    try:
        doc = json.loads(song_path.read_text())
    except Exception as e:  # noqa: BLE001
        return _html_error(f"target render failed: {e}")
    return render_target_doc(doc, dictionary=dictionary, inline=inline,
                             bars_per_line=bars_per_line)


def _render_album_songbook_html(album_dir: Path, album: str, params):
    """Render every song JSON in an album into one songbook HTML document.

    Returns (html_str, None) on success or (None, error_3tuple) on failure.
    """
    import render_target

    try:
        songs = []
        for f in sorted(album_dir.glob("*.json")):
            doc = json.loads(f.read_text())
            for s in doc.get("songs", []):
                songs.append(s)
        html = render_target.render_songbook(
            songs,
            title=album,
            dictionary=params.get("dict", "per_voicing"),
            inline_diagrams=params.get("inline") == "1",
            bars_per_line=_bars_per_line(params),
        )
        return html, None
    except Exception as e:  # noqa: BLE001
        return None, _html_error(f"songbook render failed: {e}")


def _build_chordmark_doc(doc, bars_per_line=4) -> str:
    """Build ChordMark source text for every song in a document dict."""
    import chordmark_render

    songs = doc.get("songs", [])
    return "\n\n".join(chordmark_render.render_song(s, bars_per_line=bars_per_line)
                       for s in songs)


def _build_chordmark(song_path: Path, bars_per_line=4) -> str:
    """Build ChordMark source text for every song in a saved document."""
    doc = json.loads(song_path.read_text())
    return _build_chordmark_doc(doc, bars_per_line=bars_per_line)


def _build_chordpro(song_path: Path) -> str:
    """Build ChordPro source text for every song in a saved document."""
    import chordpro_render

    doc = json.loads(song_path.read_text())
    songs = doc.get("songs", [])
    return "\n\n".join(chordpro_render.render_chordpro(s) for s in songs)


def render_song_doc(doc, bars_per_line=4):
    """Render a document dict to ChordMark HTML via the fork (node render_chordmark.js).

    The doc-based core shared by the GET (from path) and POST (from body) routes.
    """
    import shutil
    import subprocess
    import tempfile

    node = shutil.which("node")
    render_js = SCRIPTS / "render_chordmark.js"
    if not node or not render_js.exists():
        return _html_error("node or render_chordmark.js not found")

    try:
        chordmark = _build_chordmark_doc(doc, bars_per_line)
    except Exception as e:  # noqa: BLE001
        return _html_error(f"failed to build ChordMark: {e}")

    with tempfile.TemporaryDirectory() as tmp:
        cm_path = Path(tmp) / "song.chordmark"
        html_path = Path(tmp) / "song.html"
        cm_path.write_text(chordmark)
        try:
            r = subprocess.run([node, str(render_js), str(cm_path), str(html_path)],
                               capture_output=True, text=True, timeout=60)
        except subprocess.TimeoutExpired:
            return _html_error("fork render timed out")
        if r.returncode != 0 or not html_path.exists():
            return _html_error(f"fork render failed:\n{r.stderr or r.stdout}")
        return 200, "text/html", html_path.read_bytes()


def render_song_html(song_path: Path, bars_per_line=4):
    """Render a saved song to ChordMark HTML via the fork (node render_chordmark.js)."""
    try:
        doc = json.loads(song_path.read_text())
    except Exception as e:  # noqa: BLE001
        return _html_error(f"failed to build ChordMark: {e}")
    return render_song_doc(doc, bars_per_line=bars_per_line)


def serve(songs_root: Path, port: int):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class Handler(BaseHTTPRequestHandler):
        def _run(self, method):
            length = int(self.headers.get("Content-Length", 0) or 0)
            body = self.rfile.read(length) if length else b""
            result = handle(method, self.path, body, songs_root)
            status, ctype, payload = result[0], result[1], result[2]
            extra = result[3] if len(result) > 3 else {}
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(payload)))
            for k, v in extra.items():
                self.send_header(k, v)
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
