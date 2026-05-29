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
