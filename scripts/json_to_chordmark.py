#!/usr/bin/env python3
"""
Convert parsed JSON songsheets to ChordMark format.

Usage:
    python json_to_chordmark.py data/artist/json/*.json --output data/artist/chordmark/
    
ChordMark format reference: https://chordmark.netlify.app/
"""

import argparse
import json
from pathlib import Path


def slugify(text: str) -> str:
    """Convert title to filename-safe slug."""
    import re
    text = text.lower()
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[-\s]+", "-", text).strip("-")
    return text


def json_to_chordmark(data: dict) -> str:
    """Convert parsed JSON to ChordMark format."""
    lines = []
    
    # Header
    title = data.get("title", "Unknown")
    lines.append(f"# {title}")
    
    if composer := data.get("composer"):
        lines.append(f"## {composer}")
    
    lines.append("")
    
    # Chord definitions (as comments for reference)
    if chords := data.get("chords"):
        lines.append("# Chord voicings:")
        for name, info in chords.items():
            fingering = info.get("fingering", "?")
            fret = info.get("fret", 1)
            fret_note = f" (fret {fret})" if fret > 1 else ""
            lines.append(f"# {name}: {fingering}{fret_note}")
        lines.append("")
    
    # Bars
    current_section = None
    
    for bar in data.get("bars", []):
        # Section marker
        if section := bar.get("section"):
            if section != current_section:
                lines.append("")
                lines.append(f"## {section.title()}")
                current_section = section
        
        # Build chord line
        chords = bar.get("chords", [])
        beats = bar.get("beats", 4)
        
        # ChordMark uses dots for beats: "C . . ." = C held for 4 beats
        chord_parts = []
        for i, chord in enumerate(chords):
            if chord:
                chord_parts.append(chord)
            elif i == 0:
                # First beat with no chord - use previous or skip
                chord_parts.append(".")
            else:
                chord_parts.append(".")
        
        # Pad to beat count
        while len(chord_parts) < beats:
            chord_parts.append(".")
        
        chord_line = " ".join(chord_parts)
        lyrics = bar.get("lyrics", "")
        
        # Format: chord line, then lyrics (or combined if short)
        if lyrics:
            lines.append(f"{chord_line}")
            lines.append(f"{lyrics}")
        else:
            lines.append(f"{chord_line}")
    
    return "\n".join(lines)


def convert_file(json_path: Path, output_dir: Path) -> Path:
    """Convert a single JSON file to ChordMark."""
    with open(json_path) as f:
        data = json.load(f)
    
    # Check for unresolved flags
    flags = data.get("_flags", [])
    if flags:
        print(f"  ⚠️  Has {len(flags)} flags: {flags[:2]}...")
    
    chordmark = json_to_chordmark(data)
    
    title = data.get("title", json_path.stem)
    output_path = output_dir / f"{slugify(title)}.chordmark"
    
    with open(output_path, "w") as f:
        f.write(chordmark)
    
    return output_path


def main():
    parser = argparse.ArgumentParser(description="Convert JSON songsheets to ChordMark")
    parser.add_argument("files", nargs="+", type=Path, help="JSON files to convert")
    parser.add_argument("-o", "--output", type=Path, required=True, help="Output directory")
    parser.add_argument("--skip-flagged", action="store_true", help="Skip files with unresolved flags")
    
    args = parser.parse_args()
    
    args.output.mkdir(parents=True, exist_ok=True)
    
    for json_path in args.files:
        if not json_path.exists():
            print(f"⚠️  Skipping {json_path}: not found")
            continue
        
        print(f"Converting: {json_path.name}...", end=" ")
        
        try:
            # Check for flags if skip-flagged
            if args.skip_flagged:
                with open(json_path) as f:
                    data = json.load(f)
                if data.get("_flags"):
                    print("⏭️  Skipped (has flags)")
                    continue
            
            output_path = convert_file(json_path, args.output)
            print(f"✓ → {output_path.name}")
            
        except Exception as e:
            print(f"✗ Error: {e}")


if __name__ == "__main__":
    main()
