#!/usr/bin/env python3
"""Load a reviewed local scan-reading run as a read-only QA overlay.

The run is deliberately treated as untrusted, stale-able input.  This module
only joins its three reports and returns revision-bound locations; callers are
responsible for checking the current chart revision and PDF geometry before
showing a crop or applying any proposal.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path

_DIGEST = re.compile(r"[0-9a-f]{64}\Z")
_COORDINATE = re.compile(r"(0|[1-9][0-9]*):(0|[1-9][0-9]*):(0|[1-9][0-9]*)\Z")
_BASIS = "single gap between two agreeing scan anchors"
_COMPATIBILITY = {"fresh_only", "stored_only", "neither", "both", "unknown"}
_MAX_INDEX = 1_000_000
_MAX_PAGE = 100_000
_MAX_PIXEL = 1_000_000


def _read_object(path: Path) -> dict | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _digest(value) -> bool:
    return isinstance(value, str) and _DIGEST.fullmatch(value) is not None


def _safe_name(value, suffix: str) -> bool:
    return (
        isinstance(value, str)
        and bool(value)
        and value not in {".", ".."}
        and not value.startswith(".")
        and Path(value).name == value
        and "/" not in value
        and "\\" not in value
        and "\x00" not in value
        and value.lower().endswith(suffix)
    )


def _song_parts(value) -> tuple[str, str] | None:
    if not isinstance(value, str) or "\\" in value or "\x00" in value:
        return None
    parts = value.split("/")
    if len(parts) != 2:
        return None
    album, file = parts
    if not _safe_name(album, "") or not _safe_name(file, ".json"):
        return None
    return album, file


def _coordinate(value) -> bool:
    if not isinstance(value, str) or len(value) > 23:
        return False
    match = _COORDINATE.fullmatch(value)
    return match is not None and all(int(part) <= _MAX_INDEX for part in match.groups())


def _voicing(value) -> bool:
    if not isinstance(value, str):
        return False
    strings = value.split(",")
    return len(strings) == 6 and all(
        string == "x"
        or len(string) <= 2
        and string.isascii()
        and string.isdigit()
        and str(int(string)) == string
        and int(string) <= 24
        for string in strings
    )


def _box(value) -> bool:
    return (
        isinstance(value, list)
        and len(value) == 4
        and all(type(part) is int and 0 <= part <= _MAX_PIXEL for part in value)
        and value[0] < value[2]
        and value[1] < value[3]
    )


def _unique_lookup(rows, key_name: str, value_name: str, key_validator) -> dict:
    if not isinstance(rows, list):
        return {}
    candidates = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        key, value = row.get(key_name), row.get(value_name)
        if key_validator(key) and _digest(value):
            candidates.append((key, value))
    counts = Counter(key for key, _value in candidates)
    return {key: value for key, value in candidates if counts[key] == 1}


def load_reading_proposals(run_dir: Path) -> dict:
    """Return valid, revision-bound proposal rows keyed by ``(album, file)``.

    Malformed or ambiguous input is omitted.  In particular, every duplicate
    chart, PDF, or chart-coordinate identity is rejected rather than resolved
    by report order.  Non-``fresh_only`` rows remain useful review locations,
    but never carry an edit target.
    """
    root = Path(run_dir)
    charts_report = _read_object(root / "chart-report.json")
    pages_report = _read_object(root / "pages-report.json")
    proposals_report = _read_object(root / "prioritized-proposals.json")
    if charts_report is None or pages_report is None or proposals_report is None:
        return {}

    chart_revisions = _unique_lookup(
        charts_report.get("charts"), "file", "sha256", lambda value: _song_parts(value) is not None
    )
    pdf_digests = _unique_lookup(
        pages_report.get("pdfs"), "pdf", "pdf_sha256", lambda value: _safe_name(value, ".pdf")
    )
    source_rows = proposals_report.get("proposals")
    if not isinstance(source_rows, list):
        return {}

    identities = []
    for row in source_rows:
        if not isinstance(row, dict):
            identities.append(None)
            continue
        file, coordinate = row.get("file"), row.get("coordinate")
        identities.append(
            (file, coordinate) if _song_parts(file) and _coordinate(coordinate) else None
        )
    duplicate_counts = Counter(identity for identity in identities if identity is not None)

    result = {}
    for row, identity in zip(source_rows, identities, strict=True):
        if identity is None or duplicate_counts[identity] != 1:
            continue
        file, coordinate = identity
        revision = chart_revisions.get(file)
        pdf = row.get("pdf")
        pdf_sha256 = pdf_digests.get(pdf) if _safe_name(pdf, ".pdf") else None
        compatibility = row.get("compatibility")
        current = row.get("current_chart")
        printed = row.get("stored_printed")
        fresh = row.get("fresh_candidate")
        chord = row.get("chord")
        page = row.get("page")
        box = row.get("native_box")
        if (
            revision is None
            or pdf_sha256 is None
            or row.get("basis") != _BASIS
            or row.get("review") != "required"
            or not isinstance(compatibility, str)
            or compatibility not in _COMPATIBILITY
            or not isinstance(chord, str)
            or not chord
            or len(chord) > 256
            or any(ord(character) < 32 for character in chord)
            or current is not None
            and not _voicing(current)
            or not _voicing(printed)
            or type(page) is not int
            or not 1 <= page <= _MAX_PAGE
            or not _box(box)
            or compatibility == "fresh_only"
            and not _voicing(fresh)
        ):
            continue
        album, song_file = _song_parts(file)  # validated above
        group = result.setdefault((album, song_file), {"revision": revision, "entries": []})
        group["entries"].append(
            {
                "coordinate": coordinate,
                "chord": chord,
                "editorial": current,
                "printed": printed,
                "pdf": pdf,
                "pdf_sha256": pdf_sha256,
                "page": page,
                "box": list(box),
                "proposal": fresh if compatibility == "fresh_only" else None,
            }
        )
    return result
