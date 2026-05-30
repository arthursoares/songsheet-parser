#!/usr/bin/env python3
"""Seed word-continuation dashes into existing songs' lyric text via the LLM.

The source text is bare syllables ("tris te za e"); a proper lead sheet needs
continuation hyphens ("tris- te- za e"). This batches each song's lyric
fragments through the Codex LLM (it knows Portuguese) and writes the hyphenated
text back. Idempotent: songs already containing '-' are skipped.

Usage:
    python migrate_hyphenation.py data/joao-gilberto/songs/<album>/<song>.json
    python migrate_hyphenation.py data/joao-gilberto/songs/ --dry-run
"""

import argparse
import json
from pathlib import Path


def collect_fragments(song):
    """All non-empty `text` fragments, in reading order."""
    out = []
    for sec in song.get("sections", []):
        for bar in sec.get("bars", []):
            for entry in bar:
                t = entry.get("text")
                if t:
                    out.append(t)
    return out


def needs_migration(song):
    """True if the song has lyric text and none of it contains a hyphen yet."""
    frags = collect_fragments(song)
    return bool(frags) and not any("-" in f for f in frags)


def apply_fragments(song, hyphenated):
    """Write hyphenated fragments back in order. Each replacement must keep the
    same whitespace-token count as the original (only dashes added)."""
    it = iter(hyphenated)
    for sec in song.get("sections", []):
        for bar in sec.get("bars", []):
            for entry in bar:
                if not entry.get("text"):
                    continue
                new = next(it)
                if len(new.split()) != len(entry["text"].split()):
                    raise ValueError(
                        f"token count changed: {entry['text']!r} -> {new!r}")
                entry["text"] = new
    return song


_PROMPT = """You are adding word-continuation hyphens to Brazilian Portuguese song lyrics.

Each line below is a fragment of syllables separated by spaces. A syllable that
CONTINUES its word must end with a trailing hyphen "-"; the LAST syllable of a
word has no hyphen. Keep every token and the spaces exactly as given — only add
trailing hyphens. Do not merge, split, reorder, or change tokens.

Example:
  in:  tris te za e
  out: tris- te- za e

Return EXACTLY one output line per input line, in order, nothing else.

INPUT:
{fragments}
"""


def hyphenate_via_llm(fragments):
    """Call the Codex LLM to hyphenate fragments; return a same-length list."""
    import codex_client

    prompt = _PROMPT.format(fragments="\n".join(fragments))
    text = codex_client.complete_text(prompt)
    lines = [ln for ln in text.splitlines() if ln.strip() != ""]
    if len(lines) != len(fragments):
        raise ValueError(
            f"LLM returned {len(lines)} lines for {len(fragments)} fragments")
    return lines


def migrate_file(path, hyphenator, dry_run=False):
    """Migrate one song JSON. hyphenator(fragments)->lines. Returns True if changed."""
    doc = json.loads(Path(path).read_text())
    changed = False
    for song in doc.get("songs", []):
        if not needs_migration(song):
            continue
        frags = collect_fragments(song)
        hyph = hyphenator(frags)
        apply_fragments(song, hyph)
        changed = True
    if changed and not dry_run:
        Path(path).write_text(json.dumps(doc, ensure_ascii=False, indent=2))
    return changed


def main():
    ap = argparse.ArgumentParser(description="Seed lyric continuation hyphens via LLM")
    ap.add_argument("paths", nargs="+", type=Path)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    files = []
    for p in args.paths:
        files.extend(sorted(p.rglob("*.json")) if p.is_dir() else [p])

    for f in files:
        try:
            changed = migrate_file(f, hyphenate_via_llm, dry_run=args.dry_run)
            label = ("WOULD CHANGE" if (changed and args.dry_run)
                     else ("CHANGED" if changed else "skip"))
            print(f"{label}  {f}")
        except Exception as e:  # noqa: BLE001
            print(f"ERROR  {f}: {e}")


if __name__ == "__main__":
    main()
