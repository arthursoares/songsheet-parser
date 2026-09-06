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
import copy
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from importlib import metadata
from pathlib import Path

from extraction_provenance import attach_observations, file_sha256, json_sha256
from songsheet_io import write_json_artifact
from songsheet_version import SCHEMA_VERSION, stamp

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
   - "chord": the chord name EXACTLY as printed (e.g. "Dm7", "F7+5", "C#m7/G#").
     - Copy any ♯/# or ♭/b after the root letter exactly: do NOT drop one that is
       printed, and do NOT add one that isn't ("Cdim7" stays "Cdim7").
     - A lowercase m BEFORE maj7/M7 is minor-major ("F#mmaj7", "AmM7") — keep it.
     - Emit a slash bass ("/G#") ONLY if a slash is actually printed. Never invent one.
   - "voicing": the fingering read from THAT chord's diagram, as 6 comma-separated
     strings, low E string first: each is "x" (muted) or a fret NUMBER 0-24.
     Example: "x,5,7,5,6,x".
     DIAGRAM FORMAT — these are HORIZONTAL fretboard grids:
     - The 6 HORIZONTAL lines are the strings. TOP line = high e (1st string),
       BOTTOM line = low E (6th string).
     - Vertical lines separate frets; fret columns run LEFT to RIGHT. A thick
       left edge is the nut (leftmost column = fret 1).
     - POSITION: a SHADED column with a small number under the grid (e.g. "5")
       means that column IS that fret — number every column from it. Many chords
       are not open position; frets can be two digits (e.g. "x,9,11,10,11,9").
     - A black dot = fretted note at (that string line, that fret column).
     - A small "o" at the LEFT edge of a string line = open string -> 0.
     - A string line with NO dot and NO "o" = muted -> "x". Never invent a fret
       on an unmarked string: non-x values = (number of dots) + (number of "o").
     - Build the 6 values reading the BOTTOM line first (low E), then upward
       to the TOP line (high e).
     - READ, DON'T RECALL: never output the textbook fingering for the chord
       NAME from memory — these books use NON-standard voicings (open strings
       inside closed shapes, omitted strings). Trust only the printed dots and
       "o" marks. If your result equals the standard barre shape for that chord
       name, you are probably reciting, not reading — look at the diagram again.
     This is PER OCCURRENCE: the same chord name can have different voicings on
     different placements. Omit "voicing" only if no diagram is drawn for that placement.

3. CONTINUATION — if a chord sounds through the next bar with no new chord
   struck in that next bar, emit that next bar as [ { "chord": "%" } ].
   ("%" = measure repeat: keep playing the previous chord.)

4. LYRICS — "text" is the syllables sung from that chord's onset until the next
   chord. Assign syllables by HORIZONTAL POSITION: a syllable belongs to the most
   recent chord tick at or before it on the staff — do not shift syllables into
   the neighboring chord's segment, and do not distribute them evenly.
   PRESERVE word-continuation dashes: the source prints them as spacing
   (e.g. "Vai mi - nha"). A syllable that CONTINUES its word ends with a trailing
   hyphen; the LAST syllable of a word has none. Example: printed
   "tris - te - za e" -> "tris- te- za e" (tristeza is one word, "e" is the next).
   Separate complete words with a single space. Omit "text" for instrumental bars.
   These are PORTUGUESE lyrics: preserve every diacritic exactly as printed
   (é ã õ ç â ê á í ó ú à — e.g. "Solidão", "tão", "é"). Never strip accents.

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

    response = model.generate_content(
        [
            {"mime_type": mime_type, "data": image_data},
            PARSE_PROMPT,
        ]
    )

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


def extraction_settings(image_path: Path, provider: str = "codex", model: str = None) -> dict:
    """Fingerprint effective inputs/settings without reading credentials or calling a provider."""
    import codex_client

    defaults = {
        "codex": codex_client.DEFAULT_MODEL,
        "claude": "claude-sonnet-4-20250514",
        "gemini": "gemini-2.0-flash",
        "openai": "gpt-4o",
    }
    if provider not in defaults:
        raise ValueError(f"Unknown provider: {provider}. Use: {list(defaults)}")
    package = {
        "codex": "openai",
        "openai": "openai",
        "claude": "anthropic",
        "gemini": "google-generativeai",
    }[provider]
    try:
        sdk_version = metadata.version(package)
    except metadata.PackageNotFoundError:
        sdk_version = None
    scripts = Path(__file__).resolve().parent
    code = [Path(__file__), scripts / "extraction_provenance.py"]
    if provider == "codex":
        code.append(scripts / "codex_client.py")
    settings = {
        "image": {"name": Path(image_path).name, "sha256": file_sha256(image_path)},
        "provider": provider,
        "model": model or defaults[provider],
        "prompt_sha256": json_sha256(PARSE_PROMPT),
        "implementation": {p.name: file_sha256(p) for p in code},
        "schema_sha256": file_sha256(scripts.parent / "schemas" / "songsheet.schema.json"),
        "schema_version": SCHEMA_VERSION,
        "sdk": {"package": package, "version": sdk_version},
        "request_options": {"max_tokens": 4096} if provider in ("claude", "openai") else {},
    }
    if provider == "codex":
        settings["request_options"] = {"image_detail": "high", "store": False, "stream": True}
    return settings


def parse_songsheet(image_path: Path, provider: str = "codex", model: str = None) -> dict:
    """Parse one image and preserve its exact readings alongside editable entries."""
    settings = extraction_settings(image_path, provider, model)
    parser_fn = {
        "codex": parse_with_codex,
        "claude": parse_with_claude,
        "gemini": parse_with_gemini,
        "openai": parse_with_openai,
    }[provider]
    result = parser_fn(image_path, settings["model"])
    result.setdefault("_meta", {})
    result["_meta"]["source"] = image_path.name
    result["_meta"]["parsed_at"] = datetime.now(timezone.utc).isoformat()
    result["_meta"]["model"] = f"{provider}/{settings['model']}"
    result["_meta"]["extraction"] = settings
    source = {
        "kind": "vision",
        "extraction": settings,
        "parsed_at": result["_meta"]["parsed_at"],
        "response_id": None,
    }
    return stamp(attach_observations(result, source))


def parse_cached(
    image_path: Path,
    output: Path,
    *,
    force: bool = False,
    provider: str = "codex",
    model: str = None,
) -> dict:
    """Shared fingerprinted cache and append-only snapshots for every extraction CLI."""
    output.mkdir(parents=True, exist_ok=True)
    settings = extraction_settings(image_path, provider, model)
    cache = output / f"{image_path.stem}.json"
    if cache.exists() and not force:
        try:
            result = json.loads(cache.read_text())
            cached = result.get("_meta", {}).get("cache", {})
            if cached.get("settings_sha256") == json_sha256(settings):
                payload = copy.deepcopy(result)
                payload["_meta"].pop("cache", None)
                if cached.get("payload_sha256") == json_sha256(payload):
                    return result
        except (OSError, ValueError, TypeError, AttributeError):
            pass
    result = parse_songsheet(image_path, provider=provider, model=model)
    snapshots = output / "extractions"
    snapshots.mkdir(exist_ok=True)
    result["_meta"].pop("cache", None)
    result["_meta"]["cache"] = {
        "settings_sha256": json_sha256(settings),
        "payload_sha256": json_sha256(result),
    }
    # JSON content with a reserved suffix: recursive *.json song exporters must
    # consume only the latest aliases, never historical extraction attempts.
    write_json_artifact(snapshots / f"{image_path.stem}-{uuid.uuid4().hex}.snapshot", result)
    write_json_artifact(cache, result, overwrite=True)
    return result


def main():
    parser = argparse.ArgumentParser(description="Parse songsheet images to JSON")
    parser.add_argument("images", nargs="+", type=Path, help="Image files to parse")
    parser.add_argument("-o", "--output", type=Path, required=True, help="Output directory")
    parser.add_argument(
        "-p", "--provider", default="codex", choices=["codex", "claude", "gemini", "openai"]
    )
    parser.add_argument("-m", "--model", help="Override model name")
    parser.add_argument(
        "--force", action="store_true", help="make a new extraction despite a matching cache"
    )
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
            result = parse_cached(
                image_path, args.output, provider=args.provider, model=args.model, force=args.force
            )

            confidence = result.get("_confidence", "?")
            flags = len(result.get("_flags", []))
            print(f"✓ {result.get('title', 'Unknown')} (confidence: {confidence}, flags: {flags})")

        except Exception as e:
            print(f"✗ Error: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
