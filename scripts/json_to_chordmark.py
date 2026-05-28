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
