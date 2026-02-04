#!/usr/bin/env python3
"""
Parse songsheet images using vision models.

Usage:
    python parse_songsheet.py image.png --output data/artist/json/
    python parse_songsheet.py data/artist/png/*.png --output data/artist/json/
    
Environment:
    ANTHROPIC_API_KEY - for Claude
    GEMINI_API_KEY    - for Gemini  
    OPENAI_API_KEY    - for GPT-4V
"""

import argparse
import base64
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

PARSE_PROMPT = """Analyze this Brazilian songsheet image and extract structured data.

Return a JSON object with:

{
  "title": "Song title",
  "composer": "Composer name (if visible)",
  "key": "Key signature (if indicated)",
  
  "chords": {
    "ChordName": {
      "fingering": "6 characters for 6 strings (low E to high e): x=muted, 0=open, or fret number",
      "fret": starting_fret_position
    }
  },
  
  "bars": [
    {
      "lyrics": "lyrics for this bar only",
      "chords": ["ChordName"],
      "beats": 4
    }
  ],
  
  "_flags": ["any uncertainties or unclear elements"],
  "_confidence": 0.0 to 1.0
}

CRITICAL INSTRUCTIONS:

1. CHORD DIAGRAMS - Read carefully:
   - Look for a fret position number (e.g., "3fr", "5") on the side — this is the starting fret
   - Many chords are NOT in open position — they may be at 3rd, 5th, 7th fret etc.
   - Count dots relative to the position marker
   - Format: 6 characters, low E string first. Example: 5x665x means E=5th fret, A=muted, D=6th, G=6th, B=5th, e=muted
   - Barre chords: if a barre spans strings, all those strings get the same fret number

2. BAR STRUCTURE - This is essential:
   - There is a thin horizontal line between the chord diagrams and the lyrics
   - Small VERTICAL lines on that horizontal line mark BAR DIVISIONS
   - Each segment between vertical lines is ONE BAR (one measure)
   - Typically 4 bars per line, like: |——|——|——|——|
   - Each bar usually has ONE chord and a few syllables of lyrics
   - Do NOT treat each text line as one bar — look for the vertical bar lines!

3. LYRICS:
   - Split lyrics by bar — only include the syllables that fall within each bar
   - Hyphens indicate syllable breaks within words

Return ONLY the JSON, no markdown or explanation."""


def encode_image(image_path: Path) -> str:
    """Encode image to base64."""
    with open(image_path, "rb") as f:
        return base64.standard_b64encode(f.read()).decode("utf-8")


def get_mime_type(image_path: Path) -> str:
    """Get MIME type from extension."""
    ext = image_path.suffix.lower()
    return {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
    }.get(ext, "image/png")


def parse_with_claude(image_path: Path, model: str = "claude-sonnet-4-20250514") -> dict:
    """Parse using Anthropic Claude."""
    import anthropic
    
    client = anthropic.Anthropic()
    
    image_data = encode_image(image_path)
    mime_type = get_mime_type(image_path)
    
    response = client.messages.create(
        model=model,
        max_tokens=4096,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": mime_type,
                            "data": image_data,
                        },
                    },
                    {
                        "type": "text",
                        "text": PARSE_PROMPT,
                    },
                ],
            }
        ],
    )
    
    return json.loads(response.content[0].text)


def parse_with_gemini(image_path: Path, model: str = "gemini-2.0-flash") -> dict:
    """Parse using Google Gemini."""
    import google.generativeai as genai
    
    genai.configure(api_key=os.environ["GEMINI_API_KEY"])
    
    model = genai.GenerativeModel(model)
    
    image_data = encode_image(image_path)
    mime_type = get_mime_type(image_path)
    
    response = model.generate_content([
        {"mime_type": mime_type, "data": image_data},
        PARSE_PROMPT,
    ])
    
    # Extract JSON from response (may have markdown wrapper)
    text = response.text
    if "```json" in text:
        text = text.split("```json")[1].split("```")[0]
    elif "```" in text:
        text = text.split("```")[1].split("```")[0]
    
    return json.loads(text.strip())


def parse_with_openai(image_path: Path, model: str = "gpt-4o") -> dict:
    """Parse using OpenAI GPT-4V."""
    import openai
    
    client = openai.OpenAI()
    
    image_data = encode_image(image_path)
    mime_type = get_mime_type(image_path)
    
    response = client.chat.completions.create(
        model=model,
        max_tokens=4096,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{mime_type};base64,{image_data}",
                        },
                    },
                    {
                        "type": "text",
                        "text": PARSE_PROMPT,
                    },
                ],
            }
        ],
    )
    
    text = response.choices[0].message.content
    if "```json" in text:
        text = text.split("```json")[1].split("```")[0]
    elif "```" in text:
        text = text.split("```")[1].split("```")[0]
    
    return json.loads(text.strip())


def parse_songsheet(image_path: Path, provider: str = "gemini", model: str = None) -> dict:
    """Parse a songsheet image and return structured JSON."""
    
    parsers = {
        "claude": (parse_with_claude, "claude-sonnet-4-20250514"),
        "gemini": (parse_with_gemini, "gemini-2.0-flash"),
        "openai": (parse_with_openai, "gpt-4o"),
    }
    
    if provider not in parsers:
        raise ValueError(f"Unknown provider: {provider}. Use: {list(parsers.keys())}")
    
    parser_fn, default_model = parsers[provider]
    model = model or default_model
    
    result = parser_fn(image_path, model)
    
    # Add metadata
    result["source"] = image_path.name
    result["_parsed_at"] = datetime.now(timezone.utc).isoformat()
    result["_model"] = f"{provider}/{model}"
    
    return result


def main():
    parser = argparse.ArgumentParser(description="Parse songsheet images to JSON")
    parser.add_argument("images", nargs="+", type=Path, help="Image files to parse")
    parser.add_argument("-o", "--output", type=Path, required=True, help="Output directory")
    parser.add_argument("-p", "--provider", default="gemini", choices=["claude", "gemini", "openai"])
    parser.add_argument("-m", "--model", help="Override model name")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be done")
    
    args = parser.parse_args()
    
    args.output.mkdir(parents=True, exist_ok=True)
    
    for image_path in args.images:
        if not image_path.exists():
            print(f"⚠️  Skipping {image_path}: not found", file=sys.stderr)
            continue
            
        output_path = args.output / f"{image_path.stem}.json"
        
        if args.dry_run:
            print(f"Would parse: {image_path} → {output_path}")
            continue
        
        print(f"Parsing: {image_path.name}...", end=" ", flush=True)
        
        try:
            result = parse_songsheet(image_path, args.provider, args.model)
            
            with open(output_path, "w") as f:
                json.dump(result, f, indent=2, ensure_ascii=False)
            
            confidence = result.get("_confidence", "?")
            flags = len(result.get("_flags", []))
            print(f"✓ {result.get('title', 'Unknown')} (confidence: {confidence}, flags: {flags})")
            
        except Exception as e:
            print(f"✗ Error: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
