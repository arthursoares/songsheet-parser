"""Server-side chord-name and voicing compatibility checks for shape edits.

The browser's existing ChordNaming implementation is authoritative when Node
is available.  A deliberately narrow Python fallback covers common symbols;
symbols outside that small grammar remain unknown rather than being rejected.
"""

from __future__ import annotations

import json
import re
import subprocess
import unicodedata
from pathlib import Path

from chord_identity import strict_harm_key
from qa_shape_edits import ShapeEditError

_STATIC_DIR = Path(__file__).resolve().parent / "qa_static"
_NODE_PROGRAM = r"""
global.window = globalThis;
require('./vendor/tonal.bundle.js');
require('./vendor/chord-symbol.bundle.js');
require('./chord_naming.js');
const fs = require('fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const voicing = input.voicing.split(',');
const results = input.names.map((name) => ({
  valid: ChordNaming.validateName(name).valid,
  match: ChordNaming.nameMatchesVoicing(name, voicing),
}));
process.stdout.write(JSON.stringify(results));
""".strip()

_ROOTS = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
_TUNING = (4, 9, 2, 7, 11, 4)
_SIMPLE_CHORD = re.compile(r"^([A-G])([#b♯♭]?)(.*?)(?:/([A-G])([#b♯♭]?))?$")
_INTERVALS = {
    "": (0, 4, 7),
    "maj": (0, 4, 7),
    "m": (0, 3, 7),
    "min": (0, 3, 7),
    "dim": (0, 3, 6),
    "°": (0, 3, 6),
    "º": (0, 3, 6),
    "aug": (0, 4, 8),
    "+": (0, 4, 8),
    "sus": (0, 5, 7),
    "sus4": (0, 5, 7),
    "sus2": (0, 2, 7),
    "5": (0, 7),
    "7": (0, 4, 7, 10),
    "maj7": (0, 4, 7, 11),
    "M7": (0, 4, 7, 11),
    "7+": (0, 4, 7, 11),
    "m7": (0, 3, 7, 10),
    "min7": (0, 3, 7, 10),
    "m7b5": (0, 3, 6, 10),
    "m7♭5": (0, 3, 6, 10),
    "ø": (0, 3, 6, 10),
    "ø7": (0, 3, 6, 10),
    "Ø": (0, 3, 6, 10),
    "Ø7": (0, 3, 6, 10),
    "dim7": (0, 3, 6, 9),
    "°7": (0, 3, 6, 9),
    "º7": (0, 3, 6, 9),
    "6": (0, 4, 7, 9),
    "m6": (0, 3, 7, 9),
    "min6": (0, 3, 7, 9),
}


def _parse_voicing(voicing: str) -> frozenset[int]:
    if not isinstance(voicing, str):
        raise ShapeEditError("invalid target voicing")
    parts = voicing.split(",")
    if len(parts) != 6:
        raise ShapeEditError("invalid target voicing")
    pitches = set()
    for base, part in zip(_TUNING, parts, strict=True):
        if part == "x":
            continue
        if not part.isascii() or not part.isdigit() or int(part) > 24:
            raise ShapeEditError("invalid target voicing")
        pitches.add((base + int(part)) % 12)
    return frozenset(pitches)


def _safe_name(name: object) -> bool:
    return (
        isinstance(name, str)
        and bool(name)
        and "%" not in name
        and not any(char.isspace() or unicodedata.category(char).startswith("C") for char in name)
        and re.match(r"^[A-G][#b♯♭]?", name) is not None
    )


def _node_results(names: list[str], voicing: str) -> list[tuple[bool, bool | None]] | None:
    payload = json.dumps({"names": names, "voicing": voicing}, ensure_ascii=False)
    try:
        result = subprocess.run(
            ["node", "-e", _NODE_PROGRAM],
            cwd=_STATIC_DIR,
            input=payload,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    try:
        decoded = json.loads(result.stdout)
    except (TypeError, json.JSONDecodeError):
        return None
    if not isinstance(decoded, list) or len(decoded) != len(names):
        return None
    checked = []
    for item in decoded:
        if not isinstance(item, dict) or type(item.get("valid")) is not bool:
            return None
        match = item.get("match")
        if match is not None and type(match) is not bool:
            return None
        checked.append((item["valid"], match))
    return checked


def _root_pc(letter: str, accidental: str) -> int:
    adjustment = 1 if accidental in {"#", "♯"} else -1 if accidental in {"b", "♭"} else 0
    return (_ROOTS[letter] + adjustment) % 12


def _fallback_match(name: str, pitches: frozenset[int]) -> bool | None:
    if not pitches:
        return None
    match = _SIMPLE_CHORD.fullmatch(name)
    if match is None:
        return None
    root_letter, accidental, quality, bass_letter, bass_accidental = match.groups()
    intervals = _INTERVALS.get(quality)
    if intervals is None:
        return None
    root = _root_pc(root_letter, accidental)
    expected = {(root + interval) % 12 for interval in intervals}
    if bass_letter is not None:
        bass = _root_pc(bass_letter, bass_accidental)
        if bass not in expected:
            return None
    return pitches == expected


def check_shape_names(names: list[str], voicing: str, *, explicit: bool = False) -> None:
    """Reject invalid explicit names and definite name/voicing mismatches.

    Invalid legacy names and symbols the Python fallback cannot confidently
    interpret are left unchanged when the exact browser validator is absent.
    """
    if not isinstance(names, list) or any(not isinstance(name, str) for name in names):
        raise ShapeEditError("invalid target chord")
    pitches = _parse_voicing(voicing)
    unique_names = list(dict.fromkeys(names))
    browser = _node_results(unique_names, voicing)
    if browser is not None:
        for name, (valid, compatible) in zip(unique_names, browser, strict=True):
            if explicit and not valid:
                raise ShapeEditError(f"invalid target chord: {name}")
            if compatible is False:
                raise ShapeEditError(f"chord name does not match target voicing: {name}")
        return

    for name in unique_names:
        if explicit and (not _safe_name(name) or strict_harm_key(name)[0] != "h"):
            raise ShapeEditError(f"invalid target chord: {name}")
        compatible = _fallback_match(name, pitches) if _safe_name(name) else None
        if compatible is False:
            raise ShapeEditError(f"chord name does not match target voicing: {name}")
