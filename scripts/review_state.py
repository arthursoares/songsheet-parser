"""Field-level human-review annotations for songsheet documents.

Review records are declarations by a reviewer.  A content fingerprint binds a
declaration to the canonical values that were inspected; it is not a confidence
score.  The functions in this module are pure and never infer or persist data.
"""

import copy
import hashlib
import json
import re

from harmony import parse_key_name

REVIEW_VERSION = 1
REVIEW_FIELDS = (
    "structure",
    "chords",
    "lyrics",
    "voicing",
    "voicing_printed",
    "key",
)
FIELD_LABELS = {
    "structure": "Structure",
    "chords": "Chord names",
    "lyrics": "Lyrics",
    "voicing": "Editorial voicings",
    "voicing_printed": "Printed diagrams",
    "key": "Key",
}
RECORD_STATUSES = ("pending", "in_progress", "verified")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


def _digest(value) -> str:
    encoded = json.dumps(
        value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    )
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _sections(doc):
    for song_i, song in enumerate(doc.get("songs", [])):
        for section_i, section in enumerate(song.get("sections", [])):
            yield song_i, section_i, section


def _entries(doc):
    for song_i, section_i, section in _sections(doc):
        for bar_i, bar in enumerate(section.get("bars", [])):
            for entry_i, entry in enumerate(bar):
                yield [song_i, section_i, bar_i, entry_i], entry


def _field_value(doc: dict, field: str):
    """Return only the reviewed values and the positions that give them meaning."""
    section_positions = []
    section_labels = []
    bars = []
    entries = []
    for song_i, section_i, section in _sections(doc):
        position = [song_i, section_i]
        section_positions.append(position)
        section_labels.append({"position": position, "value": section.get("label")})
        for bar_i, bar in enumerate(section.get("bars", [])):
            bars.append([song_i, section_i, bar_i])
            entries.extend([song_i, section_i, bar_i, entry_i] for entry_i in range(len(bar)))
    positions = {
        "songs": [[song_i] for song_i, _song in enumerate(doc.get("songs", []))],
        "sections": section_positions,
        "bars": bars,
        "entries": entries,
    }
    if field == "structure":
        return {"positions": positions, "section_labels": section_labels}
    if field == "key":
        values = [
            {"position": [song_i], "value": song.get("key")}
            for song_i, song in enumerate(doc.get("songs", []))
        ]
        return {"positions": positions, "values": values}
    entry_key = {
        "chords": "chord",
        "lyrics": "text",
        "voicing": "voicing",
        "voicing_printed": "voicing_printed",
    }[field]
    values = [
        {"position": position, "value": entry.get(entry_key)}
        for position, entry in _entries(doc)
    ]
    return {"positions": positions, "values": values}


def field_fingerprint(doc: dict, field: str) -> str:
    """Fingerprint one canonical field without including review or source metadata."""
    if not isinstance(doc, dict):
        raise ValueError("document must be an object")
    if field not in REVIEW_FIELDS:
        raise ValueError(f"unknown review field: {field!r}")
    try:
        return _digest({"field": field, "value": _field_value(doc, field)})
    except (AttributeError, TypeError, ValueError) as exc:
        raise ValueError(f"cannot fingerprint {field}: malformed document structure") from exc


def _valid_stored_keys(doc: dict) -> bool:
    songs = doc.get("songs")
    return bool(songs) and all(
        isinstance(song, dict)
        and isinstance(song.get("key"), str)
        and bool(song["key"].strip())
        and parse_key_name(song["key"]) is not None
        for song in songs
    )


def _empty_summary(status="pending"):
    return {
        field: {
            "label": FIELD_LABELS[field],
            "status": status,
            "reviewer": "",
            "evidence": "",
            "fingerprint": None,
            "timestamp": None,
        }
        for field in REVIEW_FIELDS
    }


def _record_valid(record) -> bool:
    if not isinstance(record, dict):
        return False
    if record.get("status") not in RECORD_STATUSES:
        return False
    if not isinstance(record.get("fingerprint"), str) or not _SHA256.fullmatch(
        record["fingerprint"]
    ):
        return False
    if not isinstance(record.get("reviewer", ""), str) or not isinstance(
        record.get("evidence", ""), str
    ):
        return False
    if "timestamp" in record and not isinstance(record["timestamp"], str):
        return False
    return record["status"] != "verified" or (
        bool(record.get("reviewer", "").strip()) and bool(record.get("evidence", "").strip())
    )


def review_summary(doc: dict) -> dict:
    """Return the effective status of every review field.

    ``stale`` is derived only when a well-formed verified record no longer
    matches the current canonical field values.  Missing records, including
    legacy ``document.status=done`` documents, remain pending.
    """
    if not isinstance(doc, dict):
        raise ValueError("document must be an object")
    fields = _empty_summary()
    meta = doc.get("_meta", {})
    if not isinstance(meta, dict):
        return {"version": REVIEW_VERSION, "fields": _empty_summary("invalid")}
    review = meta.get("review")
    if review is None:
        return {"version": REVIEW_VERSION, "fields": fields}
    if (
        not isinstance(review, dict)
        or type(review.get("version")) is not int
        or review["version"] != REVIEW_VERSION
        or not isinstance(review.get("fields"), dict)
        or any(field not in REVIEW_FIELDS for field in review.get("fields", {}))
    ):
        return {"version": REVIEW_VERSION, "fields": _empty_summary("invalid")}

    for field in REVIEW_FIELDS:
        record = review["fields"].get(field)
        if record is None:
            continue
        if not _record_valid(record):
            fields[field]["status"] = "invalid"
            continue
        summary = {
            "label": FIELD_LABELS[field],
            "status": record["status"],
            "reviewer": record.get("reviewer", ""),
            "evidence": record.get("evidence", ""),
            "fingerprint": record["fingerprint"],
            "timestamp": record.get("timestamp"),
        }
        try:
            current = field_fingerprint(doc, field)
        except ValueError:
            summary["status"] = "invalid"
        else:
            if field == "key" and record["status"] == "verified" and not _valid_stored_keys(doc):
                summary["status"] = "invalid"
            elif record["status"] == "verified" and record["fingerprint"] != current:
                summary["status"] = "stale"
        fields[field] = summary
    return {"version": REVIEW_VERSION, "fields": fields}


def record_review(doc: dict, field: str, status: str, reviewer="", evidence="") -> dict:
    """Return a deep copy with one field-review record added or replaced."""
    if not isinstance(doc, dict):
        raise ValueError("document must be an object")
    if field not in REVIEW_FIELDS:
        raise ValueError(f"unknown review field: {field!r}")
    if status not in RECORD_STATUSES:
        raise ValueError(f"unknown review status: {status!r}")
    if not isinstance(reviewer, str) or not isinstance(evidence, str):
        raise ValueError("reviewer and evidence must be strings")
    if status == "verified" and (not reviewer.strip() or not evidence.strip()):
        raise ValueError("verified review requires a nonblank reviewer and evidence")
    if field == "key" and status == "verified" and not _valid_stored_keys(doc):
        raise ValueError("key review requires a valid nonempty stored key for every song")
    meta = doc.get("_meta")
    if meta is not None and not isinstance(meta, dict):
        raise ValueError("_meta must be an object")
    if isinstance(meta, dict) and "review" in meta:
        existing = meta["review"]
        if (
            not isinstance(existing, dict)
            or type(existing.get("version")) is not int
            or existing["version"] != REVIEW_VERSION
            or not isinstance(existing.get("fields"), dict)
            or any(name not in REVIEW_FIELDS for name in existing.get("fields", {}))
        ):
            raise ValueError("existing review metadata is malformed")

    result = copy.deepcopy(doc)
    review = result.setdefault("_meta", {}).setdefault(
        "review", {"version": REVIEW_VERSION, "fields": {}}
    )
    review["fields"][field] = {
        "status": status,
        "reviewer": reviewer,
        "evidence": evidence,
        "fingerprint": field_fingerprint(doc, field),
    }
    return result
