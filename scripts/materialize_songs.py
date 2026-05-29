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
