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
            lines.append(f"chord {name} {fingering}")
    
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
        
        # Build ChordMark chord line
        # ChordMark beat rules (in N/M time):
        #   - Chord with 0 dots = full bar — ONLY for single-chord bars
        #   - Chord with N dots = N beats
        #   - Total beats per bar must equal time signature (default 4)
        # JSON: ["Bmaj7", null, null, null] = Bmaj7 for 4 beats
        #   null = continuation of previous chord
        # Vision model produces variable-length arrays, so we distribute
        # beats proportionally based on each chord's weight (entry count).
        
        if not chords:
            chord_line = "." * beats
        else:
            # Step 1: Group entries into (chord_name, weight) pairs
            # Weight = 1 (the chord itself) + count of following nulls
            chord_weights = []  # list of [name, weight]
            
            for c in chords:
                if c is not None:
                    chord_weights.append([c, 1])
                else:
                    if chord_weights:
                        chord_weights[-1][1] += 1
                    # else: leading null — skip
            
            # Step 1b: Merge consecutive identical chords
            # (ChordMark doesn't allow same chord repeated in same bar)
            merged = []
            for name, weight in chord_weights:
                if merged and merged[-1][0] == name:
                    merged[-1][1] += weight
                else:
                    merged.append([name, weight])
            chord_weights = merged
            
            # Step 2: Distribute beats proportionally
            if len(chord_weights) == 1:
                # Single chord — no dots needed (gets full bar automatically)
                chord_line = chord_weights[0][0]
            else:
                # Proportional distribution with largest-remainder rounding
                total_weight = sum(w for _, w in chord_weights)
                raw_beats = [(name, w / total_weight * beats) for name, w in chord_weights]
                
                # Floor all, then distribute remainders to get exact total
                floored = [(name, max(1, int(b))) for name, b in raw_beats]
                remainders = [(i, b - int(b)) for i, (name, b) in enumerate(raw_beats)]
                
                current_total = sum(b for _, b in floored)
                deficit = beats - current_total
                
                # Give extra beats to chords with largest fractional remainders
                remainders.sort(key=lambda x: -x[1])
                for i, _ in remainders:
                    if deficit <= 0:
                        break
                    floored[i] = (floored[i][0], floored[i][1] + 1)
                    deficit -= 1
                
                # Handle surplus: more chords than beats
                # Use ChordMark sub-beat syntax [A B] for chords sharing a beat
                final_total = sum(b for _, b in floored)
                surplus = final_total - beats
                
                if surplus > 0:
                    # First try trimming chords that have >1 beat
                    for i in sorted(range(len(floored)), key=lambda i: -floored[i][1]):
                        if surplus <= 0:
                            break
                        if floored[i][1] > 1:
                            floored[i] = (floored[i][0], floored[i][1] - 1)
                            surplus -= 1
                
                if surplus > 0:
                    # Overflow — group adjacent 1-beat chords into sub-beats [A B]
                    # Each sub-beat group shares 1 beat, reducing total by (group_size - 1)
                    # Strategy: scan from end, greedily pair/triple adjacent 1-beat chords
                    grouped = []  # list of (names_list, dur)
                    i = len(floored) - 1
                    while i >= 0:
                        if surplus > 0 and floored[i][1] == 1:
                            # Collect consecutive 1-beat chords for sub-beat group
                            group = [floored[i][0]]
                            i -= 1
                            # Add up to 3 more (max 4 per sub-beat group in ChordMark)
                            while i >= 0 and surplus > 0 and floored[i][1] == 1 and len(group) < 4:
                                group.insert(0, floored[i][0])
                                surplus -= 1
                                i -= 1
                            grouped.insert(0, (group, 1))
                        else:
                            grouped.insert(0, ([floored[i][0]], floored[i][1]))
                            i -= 1
                    
                    tokens = []
                    for names, dur in grouped:
                        if len(names) > 1:
                            tokens.append("[" + " ".join(names) + "]")
                        else:
                            tokens.append(names[0] + "." * dur)
                    chord_line = " ".join(tokens)
                else:
                    tokens = []
                    for name, dur in floored:
                        tokens.append(name + "." * dur)
                    chord_line = " ".join(tokens)
        
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
