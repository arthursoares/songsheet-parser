#!/usr/bin/env python3
"""
Convert parsed JSON songsheets to ChordMark format.
Handles multi-page songs by merging pages with matching titles.

Usage:
    python json_to_chordmark.py data/artist/json/ --output data/artist/chordmark/
    python json_to_chordmark.py data/artist/json/*.json --output data/artist/chordmark/
"""

import argparse
import json
import re
import unicodedata
from collections import OrderedDict
from pathlib import Path


def normalize_title(title: str) -> str:
    """Normalize title for grouping (strip accents, lowercase)."""
    nfkd = unicodedata.normalize('NFKD', title)
    ascii_str = nfkd.encode('ASCII', 'ignore').decode('ASCII')
    return ascii_str.lower().strip()


def slugify(text: str) -> str:
    """Convert title to filename-safe slug."""
    text = text.lower()
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[-\s]+", "-", text).strip("-")
    return text


def group_pages(json_files: list[Path]) -> dict:
    """Group JSON files by song title, preserving page order."""
    groups = OrderedDict()
    
    for path in sorted(json_files):
        with open(path) as f:
            data = json.load(f)
        
        title = data.get("title", path.stem)
        key = normalize_title(title)
        
        if key not in groups:
            groups[key] = {
                "title": title,
                "pages": [],
            }
        
        groups[key]["pages"].append(data)
    
    return groups


def merge_song(pages: list[dict]) -> dict:
    """Merge multiple pages of the same song into one."""
    merged_chords = OrderedDict()
    merged_bars = []
    
    # Use first page for metadata
    title = pages[0].get("title", "Unknown")
    composer = pages[0].get("composer")
    key = pages[0].get("key")
    
    for page in pages:
        # Merge chord definitions (later pages may have same/different voicings)
        for name, info in page.get("chords", {}).items():
            if name not in merged_chords:
                merged_chords[name] = info
        
        # Append bars sequentially
        merged_bars.extend(page.get("bars", []))
    
    return {
        "title": title,
        "composer": composer,
        "key": key,
        "chords": merged_chords,
        "bars": merged_bars,
        "page_count": len(pages),
    }


def song_to_chordmark(song: dict) -> str:
    """Convert merged song dict to ChordMark format with #chord directives."""
    lines = []
    
    # Chord definitions using #chord directive
    for name, info in song.get("chords", {}).items():
        fingering = info.get("fingering", "")
        if fingering:
            lines.append(f"#chord {name} {fingering}")
    
    if song.get("chords"):
        lines.append("")
    
    # Bars
    current_section = None
    
    for bar in song.get("bars", []):
        # Section marker
        section = bar.get("section")
        if section and section != current_section:
            lines.append("")
            lines.append(section.title())
            current_section = section
        
        # Chord line
        chords = bar.get("chords", [])
        beats = bar.get("beats", 4)
        
        # Build ChordMark chord line: "Cmaj7.. Am7.."
        # Each chord followed by dots for duration
        if len(chords) == 1:
            # Single chord for whole bar
            chord_line = chords[0] + "." * (beats - 1) if chords[0] else "." * beats
        elif chords:
            # Multiple chords - distribute beats
            beats_per_chord = max(1, beats // len(chords))
            parts = []
            for c in chords:
                if c:
                    parts.append(c + "." * (beats_per_chord - 1))
                else:
                    parts.append("." * beats_per_chord)
            chord_line = " ".join(parts)
        else:
            chord_line = "." * beats
        
        # Lyrics line
        lyrics = (bar.get("lyrics") or "").strip()
        
        lines.append(chord_line)
        if lyrics:
            lines.append(lyrics)
    
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description="Convert JSON songsheets to ChordMark")
    parser.add_argument("input", nargs="+", type=Path, help="JSON files or directory")
    parser.add_argument("-o", "--output", type=Path, required=True, help="Output directory")
    parser.add_argument("--no-merge", action="store_true", help="Don't merge multi-page songs")
    
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    
    # Collect JSON files
    json_files = []
    for p in args.input:
        if p.is_dir():
            json_files.extend(sorted(p.glob("*.json")))
        elif p.suffix == ".json":
            json_files.append(p)
    
    if not json_files:
        print("No JSON files found.")
        return
    
    if args.no_merge:
        # Convert each file individually
        for path in json_files:
            with open(path) as f:
                data = json.load(f)
            
            chordmark = song_to_chordmark(data)
            title = data.get("title", path.stem)
            output_path = args.output / f"{slugify(title)}-{path.stem}.chordmark"
            
            with open(output_path, "w") as f:
                f.write(chordmark)
            
            print(f"  {path.name} → {output_path.name}")
    else:
        # Group and merge by title
        groups = group_pages(json_files)
        
        print(f"Found {len(json_files)} pages → {len(groups)} songs\n")
        
        for key, group in groups.items():
            song = merge_song(group["pages"])
            chordmark = song_to_chordmark(song)
            
            title = song["title"]
            output_path = args.output / f"{slugify(title)}.chordmark"
            
            with open(output_path, "w") as f:
                f.write(chordmark)
            
            chords = len(song.get("chords", {}))
            bars = len(song.get("bars", []))
            pages = song["page_count"]
            
            print(f"  ✓ {title} ({pages}p → {chords} chords, {bars} bars) → {output_path.name}")


if __name__ == "__main__":
    main()
