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
import threading
from pathlib import Path

from songsheet_io import DocumentError, save_document

SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parent
STATIC_DIR = SCRIPTS / "qa_static"
PDF_DIR: Path | None = None  # set in main(); sibling pdf/ of --songs by default
CV_CACHE_DIR = Path("/tmp/cv-cache")  # shared with audit_voicings runs

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
    from urllib.parse import parse_qs, urlparse

    q = urlparse(path).query
    return {k: v[-1] for k, v in parse_qs(q).items()}


def _bars_per_line(params):
    """The bars-per-line layout guide from ?bars=, restricted to 4/6/8 (default 4)."""
    try:
        n = int(params.get("bars", 4))
    except (TypeError, ValueError):
        n = 4
    return n if n in (4, 6, 8) else 4


def _song_meta(path: Path):
    """Status + voicing-audit summary for the sidebar. Never raises.

    print_diffs counts entries where the stored voicing differs from (or is
    missing against) voicing_printed; audited says whether the CV audit has
    touched this song at all (so 0 diffs is meaningful).
    """
    try:
        doc = json.loads(path.read_text())
        status = doc.get("document", {}).get("status") or "pending"
        diffs, audited = 0, False
        for song in doc.get("songs", []):
            for sec in song.get("sections", []):
                for bar in sec.get("bars", []):
                    for e in bar:
                        vp = e.get("voicing_printed")
                        if not vp:
                            continue
                        audited = True
                        if vp != e.get("voicing"):
                            diffs += 1
        return status, diffs, audited
    except Exception:
        return "pending", 0, False


def list_albums(root: Path):
    out = []
    for album in sorted(p for p in root.iterdir() if p.is_dir()):
        songs = []
        for f in sorted(album.glob("*.json")):
            status, diffs, audited = _song_meta(f)
            songs.append(
                {"file": f.name, "status": status, "print_diffs": diffs, "audited": audited}
            )
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


# Serialize headless-Chrome conversions: the server is a ThreadingHTTPServer,
# so concurrent exports would otherwise collide and 500 under burst.
_CHROME_LOCK = threading.Lock()


def _chrome_convert(html: str, fmt: str):
    """Render an HTML string to PDF or PNG bytes via headless Chrome.

    fmt is "pdf" or "png". Returns the bytes, or raises RuntimeError if Chrome is
    missing or the conversion fails / times out. Conversions are serialized
    (one Chrome process at a time) so concurrent exports don't collide.
    """
    import subprocess
    import tempfile

    with _CHROME_LOCK:
        chrome = _chrome()
        if not chrome:
            raise RuntimeError("Chrome not found")

        with tempfile.TemporaryDirectory() as tmp:
            in_html = Path(tmp) / "in.html"
            in_html.write_text(html, encoding="utf-8")
            if fmt == "pdf":
                out = Path(tmp) / "out.pdf"
                cmd = [
                    chrome,
                    "--headless",
                    "--disable-gpu",
                    "--no-pdf-header-footer",
                    f"--print-to-pdf={out}",
                    str(in_html),
                ]
            else:
                out = Path(tmp) / "out.png"
                cmd = [
                    chrome,
                    "--headless",
                    "--disable-gpu",
                    f"--screenshot={out}",
                    "--window-size=1100,1600",
                    str(in_html),
                ]
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


def _existing_song(root: Path, album: str, fname: str):
    """Resolve root/album/fname for read routes: (target, None) or (None, error response)."""
    target = _safe_under(root, album, fname)
    if target is None:
        return None, _json(400, {"error": "bad path"})
    if not target.exists():
        return None, _json(404, {"error": "not found"})
    return target, None


# --- route handlers -------------------------------------------------------
# Each takes (req, **path_args) where req has .root, .body, .params, and
# returns (status, ctype, body) or (status, ctype, body, headers).


def _h_albums(req):
    return _json(200, list_albums(req.root))


def _h_song_get(req, album, file):
    target, err = _existing_song(req.root, album, file)
    if err is not None:
        return err
    return 200, "application/json", target.read_bytes()


def _h_song_post(req, album, file):
    # No existence check: a save may (re)create the file.
    target = _safe_under(req.root, album, file)
    if target is None:
        return _json(400, {"error": "bad path"})
    return save_song(target, req.body)


def _h_chordmark(req, album, file):
    """The generated ChordMark source text for a saved song."""
    target, err = _existing_song(req.root, album, file)
    if err is not None:
        return err
    try:
        text = _build_chordmark(target, _bars_per_line(req.params))
    except Exception as e:  # noqa: BLE001
        return _json(500, {"error": f"chordmark build failed: {e}"})
    return 200, "text/plain; charset=utf-8", text.encode()


def _h_render_doc(req):
    """?style=target|fork&dict=&inline=&bars= — render from a POSTed doc.

    Live preview of UNSAVED edits: body is the in-memory document. Never writes.
    """
    doc, err = _load_doc(req.body)
    if err is not None:
        return err
    bars = _bars_per_line(req.params)
    if req.params.get("style") == "fork":
        return render_song_doc(doc, bars_per_line=bars)
    return render_target_doc(
        doc,
        dictionary=req.params.get("dict", "per_voicing"),
        inline=req.params.get("inline") == "1",
        bars_per_line=bars,
    )


def _h_chordmark_doc(req):
    """?bars= — the generated ChordMark source from a POSTed doc."""
    doc, err = _load_doc(req.body)
    if err is not None:
        return err
    try:
        text = _build_chordmark_doc(doc, _bars_per_line(req.params))
    except Exception as e:  # noqa: BLE001
        return _json(500, {"error": f"chordmark build failed: {e}"})
    return 200, "text/plain; charset=utf-8", text.encode()


def _h_harmony(req, album, file):
    """Harmonic analysis of a saved song."""
    target, err = _existing_song(req.root, album, file)
    if err is not None:
        return err
    try:
        doc = json.loads(target.read_text())
    except Exception as e:  # noqa: BLE001
        return _json(500, {"error": f"bad song file: {e}"})
    return harmony_doc(doc)


def _h_harmony_doc(req):
    """Harmonic analysis of a POSTed (unsaved) document.

    Live analysis of in-memory edits, same contract as /api/render-doc.
    """
    doc, err = _load_doc(req.body)
    if err is not None:
        return err
    return harmony_doc(doc)


def _h_convert(req):
    """?fmt=pdf|png&name=<stem> — body is an HTML document, returns it converted
    by headless Chrome as a downloadable attachment. Used by the Harmony tab's
    PDF export (the snapshot HTML is built client-side so it reflects unsaved edits).
    """
    fmt = req.params.get("fmt", "pdf")
    if fmt not in ("pdf", "png"):
        return _json(400, {"error": f"unsupported fmt {fmt!r}"})
    try:
        html = req.body.decode("utf-8")
    except UnicodeDecodeError:
        return _json(400, {"error": "body must be utf-8 HTML"})
    if not html.strip():
        return _json(400, {"error": "empty body"})
    try:
        data = _chrome_convert(html, fmt)
    except RuntimeError as e:
        return _json(500, {"error": str(e)})
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", req.params.get("name", "export")) or "export"
    ctype = "application/pdf" if fmt == "pdf" else "image/png"
    return 200, ctype, data, _attach(stem, fmt)


def _h_render(req, album, file):
    """ChordMark HTML rendered via the fork (or style=target)."""
    target, err = _existing_song(req.root, album, file)
    if err is not None:
        return err
    bars = _bars_per_line(req.params)
    if req.params.get("style") == "target":
        return render_target_html(
            target,
            dictionary=req.params.get("dict", "per_voicing"),
            inline=req.params.get("inline") == "1",
            bars_per_line=bars,
        )
    return render_song_html(target, bars_per_line=bars)


def _h_export(req, album, file):
    """?fmt=chordmark|chordpro|html|pdf|png — downloadable file for one song."""
    target, err = _existing_song(req.root, album, file)
    if err is not None:
        return err
    fmt = req.params.get("fmt", "html")
    stem = file[:-5] if file.endswith(".json") else file

    if fmt == "chordmark":
        try:
            text = _build_chordmark(target, _bars_per_line(req.params))
        except Exception as e:  # noqa: BLE001
            return _json(500, {"error": f"chordmark build failed: {e}"})
        return (200, "text/plain; charset=utf-8", text.encode(), _attach(stem, "chordmark"))

    if fmt == "chordpro":
        try:
            text = _build_chordpro(target)
        except Exception as e:  # noqa: BLE001
            return _json(500, {"error": f"chordpro build failed: {e}"})
        return (200, "text/plain; charset=utf-8", text.encode(), _attach(stem, "chordpro"))

    html, err = _render_html_for_export(target, req.params)
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


def _h_export_album(req, album):
    """?fmt=pdf|html — whole-album songbook (one document)."""
    album_dir = _safe_under(req.root, album)
    if album_dir is None:
        return _json(400, {"error": "bad path"})
    if not album_dir.is_dir():
        return _json(404, {"error": "not found"})
    fmt = req.params.get("fmt", "pdf")
    html, err = _render_album_songbook_html(album_dir, album, req.params)
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


# entry-keyed cache of rendered crops (song mtime in the key invalidates)
_CROP_CACHE: dict = {}


def _h_diagram_crop(req, album, file):
    """?si=&bi=&ei= — magnified PNG of the PRINTED diagram for one chord entry.

    Pairs the song's entries with the CV reader's diagram boxes (same
    alignment as audit_voicings) and crops the PDF's native page image.
    """
    if PDF_DIR is None or not PDF_DIR.is_dir():
        return _json(404, {"error": "no pdf directory configured"})
    target, err = _existing_song(req.root, album, file)
    if err is not None:
        return err
    try:
        si, bi, ei = (int(req.params[k]) for k in ("si", "bi", "ei"))
    except (KeyError, ValueError):
        return _json(400, {"error": "si/bi/ei query params required"})

    key = (album, file, si, bi, ei, target.stat().st_mtime)
    if key in _CROP_CACHE:
        return 200, "image/png", _CROP_CACHE[key]

    import audit_voicings as av

    pdf = av.pdf_for_album(album, PDF_DIR)
    if pdf is None:
        return _json(404, {"error": f"no PDF for album {album}"})
    doc = json.loads(target.read_text())
    song = doc["songs"][0]
    try:
        entry = song["sections"][si]["bars"][bi][ei]
    except (IndexError, KeyError, TypeError):
        return _json(404, {"error": "no such entry"})
    try:
        diagrams = av.song_diagram_data(song, pdf, CV_CACHE_DIR)
        pairs, _mode = av.pair_song(song, diagrams)
    except Exception as e:  # noqa: BLE001
        return _json(500, {"error": f"diagram pairing failed: {e}"})
    hit = next((d for e2, d in pairs if e2 is entry), None)
    if hit is None:
        return _json(404, {"error": "entry has no paired diagram"})
    _v, _derr, page_num, box = hit

    import io

    import numpy as np
    from diagram_reader import load_page_image
    from PIL import Image

    page = load_page_image(pdf, page_num)
    x0, y0, x1, y1 = box
    m = 4
    crop = np.asarray(page[max(0, y0 - m) : y1 + m + 1, max(0, x0 - m) : x1 + m + 1]).astype(
        "uint8"
    )
    im = Image.fromarray(crop).resize((crop.shape[1] * 8, crop.shape[0] * 8), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "PNG")
    data = buf.getvalue()
    _CROP_CACHE[key] = data
    return 200, "image/png", data


def _h_page(req, album, file, n):
    """pages/<file-stem>-p<n>.png"""
    if not n.isdigit():
        return _json(400, {"error": "bad path"})
    slug = file[:-5] if file.endswith(".json") else file
    png = _safe_under(req.root, album, "pages", f"{slug}-p{n}.png")
    if png is None:
        return _json(400, {"error": "bad path"})
    if not png.exists():
        return _json(404, {"error": "no page"})
    return 200, "image/png", png.read_bytes()


def _static_file(path: str):
    """Static files: index.html at "/", else by name under STATIC_DIR. None if no match."""
    rel = "index.html" if path == "/" else path.lstrip("/")
    if ".." in rel or not all(SAFE.match(seg) for seg in rel.split("/")):
        return None
    f = STATIC_DIR / rel
    if not (f.exists() and f.is_file()):
        return None
    ctype = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".png": "image/png",
        ".json": "application/json",
    }.get(f.suffix.lower(), "application/octet-stream")
    return 200, ctype, f.read_bytes()


# (method, /pattern/with/{params}, handler) — matched in order, segment-exact.
_ROUTES = [
    ("GET", "/api/albums", _h_albums),
    ("GET", "/api/song/{album}/{file}", _h_song_get),
    ("POST", "/api/song/{album}/{file}", _h_song_post),
    ("GET", "/api/chordmark/{album}/{file}", _h_chordmark),
    ("POST", "/api/render-doc", _h_render_doc),
    ("POST", "/api/chordmark-doc", _h_chordmark_doc),
    ("GET", "/api/harmony/{album}/{file}", _h_harmony),
    ("POST", "/api/harmony-doc", _h_harmony_doc),
    ("POST", "/api/convert", _h_convert),
    ("GET", "/api/render/{album}/{file}", _h_render),
    ("GET", "/api/export/{album}/{file}", _h_export),
    ("GET", "/api/export-album/{album}", _h_export_album),
    ("GET", "/api/page/{album}/{file}/{n}", _h_page),
    ("GET", "/api/diagram-crop/{album}/{file}", _h_diagram_crop),
]
_COMPILED_ROUTES = [(m, p.strip("/").split("/"), fn) for m, p, fn in _ROUTES]


def _match_route(pattern_parts: list[str], parts: list[str]):
    """Match path segments against a pattern; dict of {param} captures, or None."""
    if len(pattern_parts) != len(parts):
        return None
    args = {}
    for pat, seg in zip(pattern_parts, parts):
        if pat.startswith("{") and pat.endswith("}"):
            args[pat[1:-1]] = seg
        elif pat != seg:
            return None
    return args


class _Request:
    """What a route handler sees: corpus root, raw body, parsed query params."""

    __slots__ = ("root", "body", "params")

    def __init__(self, root: Path, body: bytes, params: dict):
        self.root = root
        self.body = body
        self.params = params


def handle(method: str, path: str, body: bytes, root: Path):
    """Pure router. Returns (status, ctype, body) or (status, ctype, body, headers)."""
    params = _query_params(path)
    path = path.split("?", 1)[0]  # drop query string (e.g. cache-bust ?t=)
    parts = [p for p in path.split("/") if p != ""]
    req = _Request(root, body, params)

    for route_method, pattern_parts, handler in _COMPILED_ROUTES:
        if route_method != method:
            continue
        args = _match_route(pattern_parts, parts)
        if args is not None:
            return handler(req, **args)

    if method == "GET":
        hit = _static_file(path)
        if hit is not None:
            return hit

    return _json(404, {"error": "unknown route"})


def save_song(target: Path, body: bytes):
    try:
        doc = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        return _json(400, {"ok": False, "error": f"invalid JSON: {e}"})

    try:
        save_document(target, doc, overwrite=True)
    except DocumentError as e:
        return _json(422, {"ok": False, "error": str(e)})
    except OSError as e:
        return _json(500, {"ok": False, "error": f"could not save song: {e}"})
    return _json(200, {"ok": True})


def _html_error(msg):
    body = (
        f"<!doctype html><meta charset='utf-8'>"
        f"<body style='font:14px sans-serif;color:#b00;padding:20px'>"
        f"ChordMark preview unavailable:<br><pre>{msg}</pre></body>"
    )
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
        html = render_target.render_song(
            songs[0], dictionary=dictionary, inline_diagrams=inline, bars_per_line=bars_per_line
        )
        return 200, "text/html", html.encode()
    except Exception as e:  # noqa: BLE001
        return _html_error(f"target render failed: {e}")


def render_target_html(song_path: Path, dictionary="per_voicing", inline=False, bars_per_line=4):
    """Render a saved song to the target lead-sheet HTML (pure Python, no fork)."""
    try:
        doc = json.loads(song_path.read_text())
    except Exception as e:  # noqa: BLE001
        return _html_error(f"target render failed: {e}")
    return render_target_doc(doc, dictionary=dictionary, inline=inline, bars_per_line=bars_per_line)


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


def harmony_doc(doc):
    """Harmonic analysis of a document dict, as a JSON response 3-tuple.

    Analyzes songs[0] only, matching render_target_doc's multi-song behavior
    (the corpus is one song per file; callers wanting another song slice the
    doc before POSTing).
    """
    import harmony

    songs = doc.get("songs", [])
    if not songs:
        return _json(400, {"error": "no songs in document"})
    try:
        return _json(200, harmony.analyze_song(songs[0]))
    except Exception as e:  # noqa: BLE001
        return _json(500, {"error": f"harmony analysis failed: {e}"})


def _build_chordmark_doc(doc, bars_per_line=4) -> str:
    """Build ChordMark source text for every song in a document dict."""
    import chordmark_render

    songs = doc.get("songs", [])
    return "\n\n".join(chordmark_render.render_song(s, bars_per_line=bars_per_line) for s in songs)


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
            r = subprocess.run(
                [node, str(render_js), str(cm_path), str(html_path)],
                capture_output=True,
                text=True,
                timeout=60,
            )
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
    global PDF_DIR
    ap = argparse.ArgumentParser(description="Songsheet QA correction server")
    ap.add_argument("--songs", type=Path, default=ROOT / "data" / "joao-gilberto" / "songs")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument(
        "--pdfs",
        type=Path,
        help="album PDF dir for printed-diagram crops (default: sibling pdf/ of --songs)",
    )
    args = ap.parse_args()
    PDF_DIR = args.pdfs or args.songs.parent / "pdf"
    serve(args.songs, args.port)


if __name__ == "__main__":
    main()
