#!/usr/bin/env python3
"""
Add chord-syllable position markers to parsed songsheet JSON.

Two-stage hybrid approach:
- Stage 1 (already done): Reliable bar structure from vision parser
- Stage 2 (this script): Focused vision queries per bar for chord positions

Usage:
    python add_positions.py data/artist/json/sample-11.json --image output/songsheets/sample-11.png
    python add_positions.py data/artist/json/*.json --image-dir output/songsheets/
"""

import argparse
import base64
import json
import os
import re
from pathlib import Path
from typing import Optional

import google.generativeai as genai


def get_distinct_chords(chords: list) -> list[str]:
    """Extract distinct non-null chords from bar's chord array."""
    seen = []
    for c in chords:
        if c is not None and c not in seen:
            seen.append(c)
    return seen


def needs_position_query(bar: dict) -> bool:
    """Check if bar needs position alignment (2+ distinct chords AND lyrics)."""
    if not bar.get("lyrics"):
        return False
    
    distinct = get_distinct_chords(bar.get("chords", []))
    return len(distinct) >= 2


def build_position_prompt(bar: dict, bar_index: int) -> str:
    """Build focused prompt for chord-syllable alignment in a single bar."""
    lyrics = bar["lyrics"]
    distinct_chords = get_distinct_chords(bar["chords"])
    
    prompt = f"""You are analyzing a musical score bar-by-bar to determine chord-syllable alignment.

**Bar {bar_index + 1}:**
- Lyrics: "{lyrics}"
- Chords: {distinct_chords}

**Task:** Look at the image and identify EXACTLY which syllable each chord change occurs on.

Chord diagrams are positioned ABOVE the syllable where they strike. Look at the spatial positioning carefully.

**Response format:** JSON array only, no explanation:
[
  {{"chord": "Bmaj7", "at_syllable": "um"}},
  {{"chord": "Fdim7", "at_syllable": "en"}}
]

**Rules:**
1. List chords in the order they appear (left to right)
2. The "at_syllable" must be an EXACT substring from the lyrics
3. If a syllable is split with a dash (e.g., "a-mor"), use the part that appears directly under the chord
4. If unsure, make your best guess based on spatial positioning

Return ONLY the JSON array, no additional text."""
    
    return prompt


def query_gemini_for_positions(image_path: Path, bar: dict, bar_index: int, model) -> Optional[list]:
    """Query Gemini Flash for chord positions in a single bar."""
    try:
        # Read and encode image
        with open(image_path, "rb") as f:
            image_data = base64.b64encode(f.read()).decode()
        
        # Build prompt
        prompt = build_position_prompt(bar, bar_index)
        
        # Query model
        response = model.generate_content([
            {
                "mime_type": "image/png",
                "data": image_data
            },
            prompt
        ])
        
        # Parse response
        text = response.text.strip()
        
        # Extract JSON array from response (handle markdown code blocks)
        json_match = re.search(r'\[.*\]', text, re.DOTALL)
        if not json_match:
            print(f"  ⚠️  Bar {bar_index + 1}: Could not find JSON array in response")
            return None
        
        positions = json.loads(json_match.group(0))
        
        # Validate structure
        if not isinstance(positions, list):
            print(f"  ⚠️  Bar {bar_index + 1}: Response is not an array")
            return None
        
        for p in positions:
            if not isinstance(p, dict) or "chord" not in p or "at_syllable" not in p:
                print(f"  ⚠️  Bar {bar_index + 1}: Invalid position format: {p}")
                return None
        
        # Validate syllables exist in lyrics
        lyrics = bar["lyrics"].lower()
        for p in positions:
            syllable = p["at_syllable"].lower()
            if syllable not in lyrics:
                print(f"  ⚠️  Bar {bar_index + 1}: Syllable '{syllable}' not found in lyrics '{bar['lyrics']}'")
                # Don't fail - model might have stripped dashes or normalized
        
        return positions
        
    except Exception as e:
        print(f"  ❌ Bar {bar_index + 1}: Error querying Gemini: {e}")
        return None


def batch_bars_for_query(bars: list[dict]) -> list[list[int]]:
    """
    Group bars that need position queries into batches.
    
    For now, query each bar individually to keep prompts simple.
    Future optimization: batch bars from same page if context window allows.
    """
    batches = []
    for i, bar in enumerate(bars):
        if needs_position_query(bar):
            batches.append([i])
    return batches


def add_positions_to_json(json_path: Path, image_path: Path, api_key: str, dry_run: bool = False) -> dict:
    """
    Add chord_positions to bars in a JSON file.
    
    Returns dict with stats.
    """
    # Load JSON
    with open(json_path) as f:
        data = json.load(f)
    
    bars = data.get("bars", [])
    
    # Identify bars that need queries
    needs_query = [i for i, bar in enumerate(bars) if needs_position_query(bar)]
    
    if not needs_query:
        return {
            "file": json_path.name,
            "bars_total": len(bars),
            "bars_queried": 0,
            "bars_success": 0,
            "bars_failed": 0,
        }
    
    print(f"\n📄 {json_path.name}")
    print(f"   {len(needs_query)} bars need position alignment")
    
    if dry_run:
        return {
            "file": json_path.name,
            "bars_total": len(bars),
            "bars_queried": len(needs_query),
            "bars_success": 0,
            "bars_failed": 0,
        }
    
    # Initialize Gemini
    genai.configure(api_key=api_key)
    model = genai.GenerativeModel("gemini-2.0-flash")
    
    # Query each bar
    success_count = 0
    failed_count = 0
    
    for bar_idx in needs_query:
        bar = bars[bar_idx]
        positions = query_gemini_for_positions(image_path, bar, bar_idx, model)
        
        if positions:
            bar["chord_positions"] = positions
            success_count += 1
            print(f"   ✓ Bar {bar_idx + 1}: {len(positions)} positions")
        else:
            failed_count += 1
    
    # Save updated JSON
    if success_count > 0:
        with open(json_path, "w") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        print(f"   💾 Saved {success_count} position annotations")
    
    return {
        "file": json_path.name,
        "bars_total": len(bars),
        "bars_queried": len(needs_query),
        "bars_success": success_count,
        "bars_failed": failed_count,
    }


def find_image_for_json(json_path: Path, image_dir: Optional[Path] = None) -> Optional[Path]:
    """Find corresponding image file for a JSON file."""
    # Try same-name PNG in provided dir
    if image_dir:
        img_path = image_dir / json_path.with_suffix(".png").name
        if img_path.exists():
            return img_path
    
    # Try source field in JSON
    with open(json_path) as f:
        data = json.load(f)
    
    source = data.get("source")
    if source:
        # Try relative to JSON
        img_path = json_path.parent.parent.parent / "output" / "songsheets" / source
        if img_path.exists():
            return img_path
        
        # Try absolute
        img_path = Path(source)
        if img_path.exists():
            return img_path
    
    return None


def main():
    parser = argparse.ArgumentParser(description="Add chord-syllable positions to songsheet JSON")
    parser.add_argument("input", nargs="+", type=Path, help="JSON files or directory")
    parser.add_argument("--image", type=Path, help="Single image file (when processing one JSON)")
    parser.add_argument("--image-dir", type=Path, help="Directory with images (for batch processing)")
    parser.add_argument("--api-key", help="Gemini API key (or use GEMINI_API_KEY env var)")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be processed without querying")
    
    args = parser.parse_args()
    
    # Get API key
    api_key = args.api_key or os.environ.get("GEMINI_API_KEY")
    if not api_key and not args.dry_run:
        print("❌ No API key provided. Use --api-key or set GEMINI_API_KEY")
        return 1
    
    # Collect JSON files
    json_files = []
    for p in args.input:
        if p.is_dir():
            json_files.extend(sorted(p.glob("*.json")))
        elif p.suffix == ".json":
            json_files.append(p)
    
    if not json_files:
        print("❌ No JSON files found")
        return 1
    
    print(f"🎵 Processing {len(json_files)} files")
    
    # Process each file
    stats = []
    for json_path in json_files:
        # Find image
        if args.image:
            image_path = args.image
        else:
            image_path = find_image_for_json(json_path, args.image_dir)
        
        if not image_path:
            print(f"\n⚠️  {json_path.name}: No image found, skipping")
            continue
        
        if not image_path.exists():
            print(f"\n⚠️  {json_path.name}: Image not found at {image_path}, skipping")
            continue
        
        # Process file
        file_stats = add_positions_to_json(json_path, image_path, api_key, args.dry_run)
        stats.append(file_stats)
    
    # Summary
    if stats:
        print("\n" + "=" * 60)
        print("📊 Summary")
        print("=" * 60)
        
        total_files = len(stats)
        total_bars = sum(s["bars_queried"] for s in stats)
        total_success = sum(s["bars_success"] for s in stats)
        total_failed = sum(s["bars_failed"] for s in stats)
        
        print(f"Files processed: {total_files}")
        print(f"Bars queried: {total_bars}")
        print(f"Positions added: {total_success}")
        print(f"Failed queries: {total_failed}")
        
        if total_bars > 0:
            success_rate = (total_success / total_bars) * 100
            print(f"Success rate: {success_rate:.1f}%")


if __name__ == "__main__":
    main()
