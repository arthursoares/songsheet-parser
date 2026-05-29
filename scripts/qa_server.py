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


def handle(method: str, path: str, body: bytes, root: Path):
    """Pure router. Returns (status:int, content_type:str, body:bytes)."""
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
