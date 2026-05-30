#!/usr/bin/env python3
"""
Parse songsheet images using vision models.

Usage:
    python parse_songsheet.py image.png --output data/artist/json/
    python parse_songsheet.py data/artist/png/*.png --output data/artist/json/
    
Providers:
    codex   - OpenAI vision (default, e.g. gpt-5.5) via your ChatGPT/Codex
              subscription. Requires `codex login` (reads ~/.codex/auth.json).
    claude  - Anthropic Claude (ANTHROPIC_API_KEY)
    gemini  - Google Gemini (GEMINI_API_KEY)
    openai  - OpenAI via paid API key (OPENAI_API_KEY)
"""

import argparse
import base64
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

PARSE_PROMPT = """Analyze this Brazilian songsheet image (one page) and extract a structured JSON object.

Return ONLY JSON, no markdown fences, in this exact shape:

{
  "document": { "title": "<book/song title on page>" },
  "songs": [
    {
      "title": "<song title>",
      "composers": ["<composer>", "..."],
      "pages": [<this page number if known, else omit>],
      "key": "<key if shown, else null>",
      "chords": {},
      "sections": [
        {
          "label": null,
          "bars": [
            [ { "chord": "Dm7", "voicing": "x,5,7,5,6,x", "text": "Vai mi- nha" } ]
          ]
        }
      ]
    }
  ]
}

CRITICAL RULES:

1. BARS ARE DELIMITED BY VERTICAL TICK MARKS on the horizontal staff line.
   - Each segment between ticks is ONE bar.
   - A "bar" in the JSON is an ARRAY of chord entries, left to right.
   - Two chord diagrams drawn close together may still be in SEPARATE bars —
     decide bar membership by the tick marks, NEVER by visual proximity.

2. CHORD ENTRIES — one object per chord placement in the bar:
   - "chord": the chord name as printed (e.g. "Dm7", "F7+5", "C#m7/G#").
   - "voicing": the fingering read from THAT chord's diagram, as 6 comma-separated
     strings, low E string first: each is "x" (muted) or a fret NUMBER 0-24.
     Example: "x,5,7,5,6,x". Read the position marker (e.g. "5fr") — many chords
     are NOT open position, so frets can be two digits (e.g. "x,9,11,10,11,9").
     This is PER OCCURRENCE: the same chord name can have different voicings on
     different placements. Omit "voicing" only if no diagram is drawn for that placement.

3. CONTINUATION — if a chord sounds through the next bar with no new chord
   struck in that next bar, emit that next bar as [ { "chord": "%" } ].
   ("%" = measure repeat: keep playing the previous chord.)

4. LYRICS — "text" is the syllables sung from that chord's onset until the next
   chord. PRESERVE word-continuation dashes: the source prints them as spacing
   (e.g. "Vai mi - nha"). A syllable that CONTINUES its word ends with a trailing
   hyphen; the LAST syllable of a word has none. Example: printed
   "tris - te - za e" -> "tris- te- za e" (tristeza is one word, "e" is the next).
   Separate complete words with a single space. Omit "text" for instrumental bars.

5. Leave "chords" as an empty object {} — it is generated later, not by you.

6. OMIT any field whose value is unknown rather than emitting null for it.
   In particular do NOT emit "page_count": null — leave the key out entirely.
   ("key" may be null if no key is shown.)

Return ONLY the JSON object."""


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


def parse_with_codex(image_path: Path, model: str = None) -> dict:
    """Parse using an OpenAI vision model via the Codex/ChatGPT subscription."""
    import codex_client

    model = model or codex_client.DEFAULT_MODEL
    return codex_client.codex_vision_json(image_path, PARSE_PROMPT, model=model)


def parse_songsheet(image_path: Path, provider: str = "codex", model: str = None) -> dict:
    """Parse a songsheet image and return structured JSON."""

    import codex_client

    parsers = {
        "codex": (parse_with_codex, codex_client.DEFAULT_MODEL),
        "claude": (parse_with_claude, "claude-sonnet-4-20250514"),
        "gemini": (parse_with_gemini, "gemini-2.0-flash"),
        "openai": (parse_with_openai, "gpt-4o"),
    }
    
    if provider not in parsers:
        raise ValueError(f"Unknown provider: {provider}. Use: {list(parsers.keys())}")
    
    parser_fn, default_model = parsers[provider]
    model = model or default_model
    
    result = parser_fn(image_path, model)

    # Add provenance metadata (kept alongside the document/songs payload)
    result.setdefault("_meta", {})
    result["_meta"]["source"] = image_path.name
    result["_meta"]["parsed_at"] = datetime.now(timezone.utc).isoformat()
    result["_meta"]["model"] = f"{provider}/{model}"

    return result


def main():
    parser = argparse.ArgumentParser(description="Parse songsheet images to JSON")
    parser.add_argument("images", nargs="+", type=Path, help="Image files to parse")
    parser.add_argument("-o", "--output", type=Path, required=True, help="Output directory")
    parser.add_argument("-p", "--provider", default="codex", choices=["codex", "claude", "gemini", "openai"])
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
