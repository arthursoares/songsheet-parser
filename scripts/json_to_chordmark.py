#!/usr/bin/env python3
"""Convert a chord-anchored songsheet document JSON to ChordMark files.

One .chordmark file is written per song. Directories are walked recursively and
their layout is mirrored into the output directory, so the per-album corpus
(songs/<album>/<NN>-<song>.json) converts to chordmark/<album>/<NN>-<song>.chordmark.
Multi-page songs are already unified into a single song object, so there is no
page-merge step.

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
    """Return (json_path, subdir) pairs; subdir mirrors a dir input's layout."""
    files = []
    for p in inputs:
        if p.is_dir():
            files.extend((f, f.parent.relative_to(p)) for f in sorted(p.rglob("*.json")))
        elif p.suffix == ".json":
            files.append((p, Path(".")))
    return files


def convert_document(doc_path, output_dir):
    """Render every song in one document JSON; return list of written paths.

    A single-song document is named after the document file itself (corpus stems
    carry an `NN-` track prefix, so repeated titles across albums don't collide);
    multi-song documents fall back to slugified titles.
    """
    data = json.loads(Path(doc_path).read_text())
    songs = data.get("songs", [])
    written = []
    for song in songs:
        title = song.get("title") or Path(doc_path).stem
        stem = Path(doc_path).stem if len(songs) == 1 else slugify(title)
        chordmark = chordmark_render.render_song(song)
        output_dir.mkdir(parents=True, exist_ok=True)
        out_path = output_dir / f"{stem}.chordmark"
        out_path.write_text(chordmark)
        written.append(out_path)
        print(f"  ✓ {title} → {out_path.name}")
    return written


def main():
    parser = argparse.ArgumentParser(description="Convert songsheet JSON to ChordMark")
    parser.add_argument("input", nargs="+", type=Path, help="Document JSON files or dirs")
    parser.add_argument("-o", "--output", type=Path, required=True, help="Output directory")
    args = parser.parse_args()

    json_files = collect_json_files(args.input)
    if not json_files:
        print("No JSON files found.")
        return

    for doc_path, subdir in json_files:
        convert_document(doc_path, args.output / subdir)


if __name__ == "__main__":
    main()
