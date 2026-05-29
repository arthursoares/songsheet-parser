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
