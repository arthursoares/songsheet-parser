#!/usr/bin/env python3
"""Build a conservative, shape-first index of printed chord diagrams.

The index is intentionally read-only.  A diagram's identity comes from the
pixels (string state, dot columns, and a visually supported base fret), never
from its chord label.  Observation-linked evidence is preferred; older songs
are included only when their diagrams and entries have identical counts and a
fresh decode agrees exactly with the stored printed voicing.
"""

from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path

import audit_voicings
import numpy as np
from diagram_reader import (
    decode_diagram,
    detect_diagrams,
    load_digit_templates,
    load_page_image,
    match_digit,
    voicing_for_base,
)
from extraction_provenance import file_sha256
from songsheet_io import load_document

RECORDED_BASIS = "recorded_evidence"
LEGACY_BASIS = "legacy_exact_count"
LEGACY_ALIGNED_BASIS = "legacy_unique_alignment"
LEGACY_EDITORIAL_BASIS = "legacy_editorial_fallback"
REMATCHED_BASIS = "rematched_evidence"
_READER_PATH = Path(__file__).resolve().with_name("diagram_reader.py")
_TEMPLATES_PATH = Path(__file__).resolve().with_name("diagram_digits.json")


def _entries(song: dict):
    for si, section in enumerate(song.get("sections", [])):
        for bi, bar in enumerate(section.get("bars", [])):
            for ei, entry in enumerate(bar):
                if isinstance(entry, dict):
                    yield si, bi, ei, entry


def _eligible(song: dict):
    all_entries = []
    voiced_entries = []
    for si, bi, ei, entry in _entries(song):
        if entry.get("chord") == "%":
            continue
        item = (si, bi, ei, entry)
        all_entries.append(item)
        if entry.get("voicing"):
            voiced_entries.append(item)
    return voiced_entries, all_entries


def _pixel_info(page) -> dict:
    pixels = np.asarray(page).astype("uint8")
    return {
        "width": int(pixels.shape[1]),
        "height": int(pixels.shape[0]),
        "sha256": hashlib.sha256(pixels.tobytes()).hexdigest(),
    }


def _normalized_columns(decoded: dict) -> list:
    """Return one dot-column slot per string, tolerating old decoder output.

    Some historical decoder versions emitted a second ``None`` for an open
    string.  Non-null columns are nevertheless in string order, so rebuilding
    the list from the pattern is lossless for shape identity.
    """
    pattern = decoded.get("pattern")
    raw = decoded.get("dot_cols")
    if not isinstance(pattern, str) or len(pattern) != 6 or any(c not in "FOM" for c in pattern):
        raise ValueError("diagram has no six-string pattern")
    if not isinstance(raw, list):
        raise ValueError("diagram has no dot columns")
    fretted = [value for value in raw if type(value) is int and value >= 0]
    if len(fretted) != pattern.count("F"):
        raise ValueError("diagram dot columns do not match its pattern")
    iterator = iter(fretted)
    return [next(iterator) if state == "F" else None for state in pattern]


def _visual_shape(decoded: dict) -> dict:
    """Shape fields derived without consulting a chord name.

    A thick nut fixes base 1.  Otherwise a close template match for the
    printed position digit fixes the base.  With neither visual cue the
    relative shape remains useful, but is deliberately non-editable.
    """
    columns = _normalized_columns(decoded)
    normalized = copy.copy(decoded)
    normalized["dot_cols"] = columns
    base = None
    if decoded.get("nut") is True:
        base = 1
    elif decoded.get("digit_bitmap") is not None and type(decoded.get("digit_col")) is int:
        value, distance = match_digit(decoded["digit_bitmap"], load_digit_templates())
        candidate = value - decoded["digit_col"] if value is not None else None
        if (
            distance is not None
            and distance <= 6
            and type(candidate) is int
            and 1 <= candidate <= 24
        ):
            base = candidate
    return {
        "pattern": decoded["pattern"],
        "columns": columns,
        "base": base,
        "voicing": voicing_for_base(normalized, base) if base is not None else None,
        "editable": base is not None,
    }


def _printed_consistent(shape: dict, printed) -> bool:
    """Whether an absolute printed voicing is exactly this decoded shape."""
    if not isinstance(printed, str):
        return False
    parts = printed.split(",")
    if len(parts) != 6:
        return False
    inferred = set()
    for state, column, value in zip(shape["pattern"], shape["columns"], parts):
        if state == "M":
            if value != "x":
                return False
        elif state == "O":
            if value != "0":
                return False
        else:
            try:
                fret = int(value)
            except (TypeError, ValueError):
                return False
            if fret < 0:
                return False
            inferred.add(fret - column)
    if shape["base"] is not None:
        return inferred in ({shape["base"]}, set()) and printed == shape["voicing"]
    return len(inferred) == 1


class _SourceReader:
    def __init__(self, pdf_dir: Path, cache_dir: Path):
        self.pdf_dir = Path(pdf_dir)
        self.cache_dir = Path(cache_dir)
        self._pdf_digests = {}
        self._pages = {}
        self._decoded = {}
        self._decoder_sha = file_sha256(_READER_PATH)
        self._templates_sha = file_sha256(_TEMPLATES_PATH) if _TEMPLATES_PATH.is_file() else None

    def digest(self, pdf: Path) -> str:
        signature = (pdf.stat().st_size, pdf.stat().st_mtime_ns)
        key = (pdf, signature)
        if key not in self._pdf_digests:
            self._pdf_digests[key] = file_sha256(pdf)
        return self._pdf_digests[key]

    def safe_recorded_pdf(self, source) -> Path | None:
        if not isinstance(source, dict):
            return None
        name, expected = source.get("name"), source.get("sha256")
        if not isinstance(name, str) or not name or Path(name).name != name:
            return None
        if not isinstance(expected, str) or len(expected) != 64:
            return None
        try:
            root = self.pdf_dir.resolve(strict=True)
            pdf = (root / name).resolve(strict=True)
        except OSError:
            return None
        if (
            not root.is_dir()
            or not pdf.is_relative_to(root)
            or pdf.suffix.lower() != ".pdf"
            or not pdf.is_file()
        ):
            return None
        return pdf if self.digest(pdf) == expected else None

    def legacy_pdf(self, album: str) -> Path | None:
        try:
            root = self.pdf_dir.resolve(strict=True)
            candidate = audit_voicings.pdf_for_album(album, root)
            pdf = Path(candidate).resolve(strict=True) if candidate is not None else None
        except (OSError, TypeError):
            return None
        if (
            pdf is None
            or not pdf.is_relative_to(root)
            or pdf.suffix.lower() != ".pdf"
            or not pdf.is_file()
        ):
            return None
        return pdf

    def page(self, pdf: Path, page_number: int):
        key = (pdf, self.digest(pdf), page_number)
        if key not in self._pages:
            self._pages[key] = load_page_image(pdf, page_number)
        return self._pages[key]

    def diagrams(self, pdf: Path, page_number: int) -> list:
        """Current decoded diagrams, cached with source and decoder fingerprints."""
        pdf_sha = self.digest(pdf)
        key = (pdf, pdf_sha, page_number, self._decoder_sha, self._templates_sha)
        if key in self._decoded:
            return self._decoded[key]
        page = self.page(pdf, page_number)
        native = _pixel_info(page)
        fingerprint = hashlib.sha256(
            json.dumps(
                [pdf_sha, page_number, self._decoder_sha, self._templates_sha],
                separators=(",", ":"),
            ).encode()
        ).hexdigest()
        cache = self.cache_dir / f"qa-shapes-{fingerprint}.json"
        rows = None
        try:
            payload = json.loads(cache.read_text())
            if payload.get("native_image") == native and isinstance(payload.get("diagrams"), list):
                rows = payload["diagrams"]
        except (OSError, ValueError, TypeError):
            pass
        if rows is None:
            rows = []
            for box in detect_diagrams(page):
                decoded, error = decode_diagram(page, box)
                rows.append({"box": list(box), "decoded": decoded, "error": error})
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            cache.write_text(
                json.dumps(
                    {
                        "pdf_sha256": pdf_sha,
                        "decoder_sha256": self._decoder_sha,
                        "templates_sha256": self._templates_sha,
                        "native_image": native,
                        "diagrams": rows,
                    },
                    separators=(",", ":"),
                )
            )
        self._decoded[key] = rows
        return rows


def _valid_box(box, native: dict) -> bool:
    return (
        isinstance(box, list)
        and len(box) == 4
        and all(type(value) is int for value in box)
        and 0 <= box[0] <= box[2] < native["width"]
        and 0 <= box[1] <= box[3] < native["height"]
    )


def _occurrence(
    *,
    album: str,
    song_file: Path,
    document_sha: str,
    song: dict,
    song_index: int,
    position,
    entry: dict,
    pdf: Path,
    pdf_sha: str,
    page: int,
    box: list,
    basis: str,
    editable: bool,
) -> dict:
    si, bi, ei = position
    # Bind UI selections to the exact saved revision.  A rebuild after any
    # document edit therefore cannot leave a stale occurrence ID targeting a
    # different entry at the same coordinates.
    identity = [document_sha, album, song_file.name, song_index, si, bi, ei, pdf_sha, page, box]
    occurrence_id = (
        "occ-"
        + hashlib.sha256(
            json.dumps(identity, ensure_ascii=False, separators=(",", ":")).encode()
        ).hexdigest()[:24]
    )
    return {
        "id": occurrence_id,
        "album": album,
        "file": song_file.name,
        "title": song.get("title") or song_file.stem,
        "song_index": song_index,
        "si": si,
        "bi": bi,
        "ei": ei,
        "label": entry.get("chord") or "",
        "editorial": entry.get("voicing"),
        "printed": entry.get("voicing_printed"),
        "document_sha256": document_sha,
        "observation_id": entry.get("observation_id"),
        "page": page,
        "pdf": pdf.name,
        "pdf_sha256": pdf_sha,
        "box": list(box),
        "basis": basis,
        "editable": editable,
    }


def _recorded_item(reader, doc, entry):
    observation_id = entry.get("observation_id")
    wrapper = doc.get("_meta", {}).get("diagram_evidence", {}).get(observation_id)
    record = wrapper.get("record") if isinstance(wrapper, dict) else None
    if not isinstance(record, dict) or record.get("observation_id") != observation_id:
        return None
    printed = entry.get("voicing_printed")
    if not isinstance(printed, str) or record.get("voicing_printed") != printed:
        return None
    pdf = reader.safe_recorded_pdf(record.get("source_pdf"))
    page_number, box = record.get("page"), record.get("crop_box")
    if pdf is None or type(page_number) is not int or page_number < 1:
        return None
    try:
        page = reader.page(pdf, page_number)
        native = _pixel_info(page)
        expected_native = record.get("native_image")
        if not isinstance(expected_native, dict) or any(
            native[key] != expected_native.get(key) for key in ("width", "height", "sha256")
        ):
            return None
        if not _valid_box(box, native):
            return None
        decoded, error = decode_diagram(page, tuple(box))
        if error or decoded is None:
            return None
        shape = _visual_shape(decoded)
    except (Exception, SystemExit):
        return None
    if record.get("decoded_pattern") not in (None, shape["pattern"]):
        return None
    if not _printed_consistent(shape, printed):
        return None
    return shape, pdf, page_number, box


def _legacy_items(reader, album: str, song: dict):
    pdf = reader.legacy_pdf(album)
    if pdf is None:
        return []
    voiced, all_entries = _eligible(song)
    raw = []
    try:
        for page_number in song.get("pages", []):
            if type(page_number) is not int or page_number < 1:
                return []
            for row in reader.diagrams(pdf, page_number):
                raw.append((page_number, row))
    except (Exception, SystemExit):
        return []
    entries = (
        voiced if len(raw) == len(voiced) else all_entries if len(raw) == len(all_entries) else None
    )
    if entries is None:
        return []
    out = []
    for item, (page_number, row) in zip(entries, raw):
        si, bi, ei, entry = item
        if (
            entry.get("observation_id")
            or row.get("error")
            or not isinstance(row.get("decoded"), dict)
        ):
            continue
        try:
            shape = _visual_shape(row["decoded"])
        except (TypeError, ValueError):
            continue
        if _printed_consistent(shape, entry.get("voicing_printed")):
            out.append((shape, pdf, page_number, row["box"], (si, bi, ei), entry))
    return out


def _legacy_scan_rows(reader, album: str, song: dict):
    """Return the legacy PDF and its diagram rows without pairing entries."""
    pdf = reader.legacy_pdf(album)
    if pdf is None:
        return None, []
    raw = []
    try:
        for page_number in song.get("pages", []):
            if type(page_number) is not int or page_number < 1:
                return None, []
            for row in reader.diagrams(pdf, page_number):
                raw.append((page_number, row))
    except (Exception, SystemExit):
        return None, []
    return pdf, raw


def _legacy_match_basis(shape: dict, entry: dict, aligned: bool) -> str | None:
    """Return the evidence basis for an exact decoded-shape match.

    Printed evidence always wins.  Editorial voicings are considered only
    when printed evidence is absent, and are labelled separately so callers
    cannot mistake the weaker fallback for a reviewed transcription.
    """
    printed = entry.get("voicing_printed")
    if isinstance(printed, str):
        if _printed_consistent(shape, printed):
            return LEGACY_ALIGNED_BASIS if aligned else LEGACY_BASIS
        return None
    editorial = entry.get("voicing")
    if isinstance(editorial, str) and _printed_consistent(shape, editorial):
        return LEGACY_EDITORIAL_BASIS
    return None


def _decoded_legacy_rows(raw: list) -> list:
    """Decode shape identity while retaining unmatchable rows as gaps."""
    decoded = []
    for page_number, row in raw:
        shape = None
        if not row.get("error") and isinstance(row.get("decoded"), dict):
            try:
                shape = _visual_shape(row["decoded"])
            except (TypeError, ValueError):
                pass
        decoded.append((page_number, row, shape))
    return decoded


def _mandatory_legacy_alignment(entries: list, rows: list) -> list:
    """Return pairs forced in every maximum monotone shape alignment.

    This is an LCS over exact per-string shape compatibility.  Every edge on
    an optimal path has a fixed LCS rank; an edge is mandatory exactly when it
    is the sole optimal edge at that rank.  Ambiguous duplicates therefore do
    not acquire arbitrary entry coordinates.
    """
    entry_count, row_count = len(entries), len(rows)
    matches = [[None] * row_count for _ in range(entry_count)]
    for entry_index, item in enumerate(entries):
        entry = item[3]
        if entry.get("observation_id"):
            continue
        for row_index, (_page, _row, shape) in enumerate(rows):
            if shape is not None:
                matches[entry_index][row_index] = _legacy_match_basis(shape, entry, True)

    prefix = [[0] * (row_count + 1) for _ in range(entry_count + 1)]
    for entry_index in range(entry_count):
        for row_index in range(row_count):
            prefix[entry_index + 1][row_index + 1] = max(
                prefix[entry_index][row_index + 1],
                prefix[entry_index + 1][row_index],
                prefix[entry_index][row_index] + bool(matches[entry_index][row_index]),
            )
    optimum = prefix[entry_count][row_count]
    if not optimum:
        return []

    suffix = [[0] * (row_count + 1) for _ in range(entry_count + 1)]
    for entry_index in range(entry_count - 1, -1, -1):
        for row_index in range(row_count - 1, -1, -1):
            suffix[entry_index][row_index] = max(
                suffix[entry_index + 1][row_index],
                suffix[entry_index][row_index + 1],
                suffix[entry_index + 1][row_index + 1] + bool(matches[entry_index][row_index]),
            )

    by_rank = {}
    for entry_index in range(entry_count):
        for row_index in range(row_count):
            basis = matches[entry_index][row_index]
            if basis and (
                prefix[entry_index][row_index] + 1 + suffix[entry_index + 1][row_index + 1]
                == optimum
            ):
                by_rank.setdefault(prefix[entry_index][row_index], []).append(
                    (entry_index, row_index, basis)
                )
    return [candidates[0] for candidates in by_rank.values() if len(candidates) == 1]


def legacy_page_records(doc: dict, album: str, pdf_dir: Path, cache_dir: Path) -> dict:
    """Conservative per-song legacy map in the scan geometry input format."""
    if not doc["songs"] or doc.get("_meta", {}).get("legacy_scan_order_changed"):
        return {}
    reader = _SourceReader(pdf_dir, cache_dir)
    song = doc["songs"][0]
    pdf, raw = _legacy_scan_rows(reader, album, song)
    if pdf is None:
        return {}
    rows = _decoded_legacy_rows(raw)
    voiced, all_entries = _eligible(song)
    exact_entries = (
        voiced if len(raw) == len(voiced) else all_entries if len(raw) == len(all_entries) else None
    )
    pairs = []
    if exact_entries is not None:
        for entry_index, (item, (_page, _row, shape)) in enumerate(zip(exact_entries, rows)):
            entry = item[3]
            if shape is None or entry.get("observation_id"):
                continue
            basis = _legacy_match_basis(shape, entry, False)
            if basis:
                pairs.append((entry_index, entry_index, basis))
    else:
        pairs = _mandatory_legacy_alignment(all_entries, rows)

    groups = {}
    entries = exact_entries if exact_entries is not None else all_entries
    for entry_index, row_index, basis in pairs:
        si, bi, ei, _entry = entries[entry_index]
        page, row, _shape = rows[row_index]
        box = row.get("box")
        page_image = reader.page(pdf, page)
        height, width = page_image.shape
        if not _valid_box(box, {"height": int(height), "width": int(width)}):
            continue
        groups.setdefault((pdf, page), []).append(
            {
                "observation_id": ":".join(map(str, (si, bi, ei))),
                "crop_box": box,
                "native_image": {"height": int(height), "width": int(width)},
                "basis": basis,
            }
        )
    return groups


def _shape_id(shape: dict) -> str:
    identity = [shape["pattern"], shape["columns"], shape["base"]]
    return (
        "shape-"
        + hashlib.sha256(json.dumps(identity, separators=(",", ":")).encode()).hexdigest()[:24]
    )


def shape_exclusion_key(group_id: str, row: dict) -> str:
    """Identify a rejected group under the exact source PDF revision."""
    identity = [
        group_id,
        row.get("pdf"),
        row.get("pdf_sha256"),
    ]
    return hashlib.sha256(
        json.dumps(identity, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()


def _rematch_items(reader, song, items):
    """Replace rejected pairings only with unique, unclaimed editorial matches.

    Original matches remain anchors. Conflicting order, duplicate candidates,
    and competing claims leave the rejected entry unmatched.
    """
    kept, pending = [], []
    for shape, row, entry in items:
        exclusion = entry.get("shape_exclusion", {})
        rejected = exclusion.get("rejected", [])
        if shape_exclusion_key(_shape_id(shape), row) in rejected:
            pending.append((shape, row, entry))
        else:
            kept.append((shape, row, entry))
    if not pending:
        return kept

    def crop_key(row):
        return row["pdf"], row["pdf_sha256"], row["page"], tuple(row["box"])

    def position(row):
        return row["si"], row["bi"], row["ei"]

    claimed = {crop_key(row) for _, row, _ in kept}
    proposals = []
    candidate_order = {}
    for _, original, entry in pending:
        pdf = reader.safe_recorded_pdf({"name": original["pdf"], "sha256": original["pdf_sha256"]})
        if pdf is None:
            continue
        pages = song.get("pages") or [original["page"]]
        if any(type(page) is not int or page < 1 for page in pages):
            continue
        try:
            raw = [(page, row) for page in sorted(set(pages)) for row in reader.diagrams(pdf, page)]
        except (Exception, SystemExit):
            continue
        decoded = _decoded_legacy_rows(raw)
        scan_positions = {(page, tuple(row["box"])): i for i, (page, row, _) in enumerate(decoded)}
        anchors = sorted(
            (position(row), scan_positions[(row["page"], tuple(row["box"]))])
            for _, row, _ in kept
            if row["pdf"] == original["pdf"]
            and row["pdf_sha256"] == original["pdf_sha256"]
            and (row["page"], tuple(row["box"])) in scan_positions
        )
        if any(left[1] >= right[1] for left, right in zip(anchors, anchors[1:])):
            continue
        before = [i for at, i in anchors if at < position(original)]
        after = [i for at, i in anchors if at > position(original)]
        lower, upper = max(before, default=-1), min(after, default=len(decoded))
        exclusion = entry["shape_exclusion"]
        candidates = []
        for i, (page, raw_row, shape) in enumerate(decoded):
            if not lower < i < upper or shape is None or not shape["editable"]:
                continue
            if shape["voicing"] != exclusion["voicing"]:
                continue
            row = {
                **original,
                "page": page,
                "box": list(raw_row["box"]),
                "printed": shape["voicing"],
                "editable": True,
                "basis": REMATCHED_BASIS,
                "source_evidence": original,
            }
            if (
                crop_key(row) in claimed
                or shape_exclusion_key(_shape_id(shape), row) in exclusion["rejected"]
            ):
                continue
            # Include the newly selected crop in the revision-bound UI identity.
            row["id"] = (
                "occ-"
                + hashlib.sha256(
                    json.dumps([original["id"], _shape_id(shape), page, row["box"]]).encode()
                ).hexdigest()[:24]
            )
            candidate_order[crop_key(row)] = (page, i)
            candidates.append((shape, row, entry))
        proposals.append(candidates)
    unique = []
    for candidates in proposals:
        if len(candidates) != 1:
            continue
        item = candidates[0]
        key = crop_key(item[1])
        if sum(any(crop_key(row) == key for _, row, _ in rows) for rows in proposals) == 1:
            unique.append(item)
    for item in unique:
        row = item[1]
        key = crop_key(row)
        if any(
            other is not row
            and crop_key(other)[:2] == key[:2]
            and (position(row) < position(other))
            != (candidate_order[key] < candidate_order[crop_key(other)])
            for _, other, _ in unique
        ):
            continue
        kept.append(item)
    return kept


def build_shape_index(songs_root: Path, pdf_dir: Path, cache_dir: Path) -> dict:
    """Return deterministic diagram groups for the Songsheet QA interface."""
    songs_root, pdf_dir, cache_dir = map(Path, (songs_root, pdf_dir, cache_dir))
    reader = _SourceReader(pdf_dir, cache_dir)
    groups = {}
    counts = {
        "documents": 0,
        "songs": 0,
        "groups": 0,
        "occurrences": 0,
        "editable": 0,
        "unresolved": 0,
        "recorded": 0,
        "legacy": 0,
    }

    def add(shape, occurrence):
        group_id = _shape_id(shape)
        group = groups.setdefault(
            group_id,
            {
                "id": group_id,
                "pattern": shape["pattern"],
                "columns": shape["columns"],
                "base": shape["base"],
                "voicing": shape["voicing"],
                "occurrences": [],
            },
        )
        group["occurrences"].append(occurrence)
        counts["occurrences"] += 1
        counts["editable" if occurrence["editable"] else "unresolved"] += 1
        evidence = occurrence.get("source_evidence", occurrence)
        counts["recorded" if evidence["basis"] == RECORDED_BASIS else "legacy"] += 1

    for song_file in sorted(songs_root.rglob("*.json")):
        if not song_file.is_file():
            continue
        try:
            doc = load_document(song_file)
            document_sha = file_sha256(song_file)
        except (OSError, TypeError, ValueError):
            continue
        counts["documents"] += 1
        try:
            album = song_file.relative_to(songs_root).parts[0]
        except (ValueError, IndexError):
            continue
        for song_index, song in enumerate(doc.get("songs", [])):
            if not isinstance(song, dict):
                continue
            counts["songs"] += 1
            items = []
            for si, bi, ei, entry in _entries(song):
                if not entry.get("observation_id"):
                    continue
                recorded = _recorded_item(reader, doc, entry)
                if recorded is None:
                    continue
                shape, pdf, page_number, box = recorded
                items.append(
                    (
                        shape,
                        _occurrence(
                            album=album,
                            song_file=song_file,
                            document_sha=document_sha,
                            song=song,
                            song_index=song_index,
                            position=(si, bi, ei),
                            entry=entry,
                            pdf=pdf,
                            pdf_sha=reader.digest(pdf),
                            page=page_number,
                            box=box,
                            basis=RECORDED_BASIS,
                            editable=shape["editable"],
                        ),
                        entry,
                    )
                )
            legacy = (
                []
                if doc.get("_meta", {}).get("legacy_scan_order_changed")
                else _legacy_items(reader, album, song)
            )
            for shape, pdf, page_number, box, position, entry in legacy:
                items.append(
                    (
                        shape,
                        _occurrence(
                            album=album,
                            song_file=song_file,
                            document_sha=document_sha,
                            song=song,
                            song_index=song_index,
                            position=position,
                            entry=entry,
                            pdf=pdf,
                            pdf_sha=reader.digest(pdf),
                            page=page_number,
                            box=box,
                            basis=LEGACY_BASIS,
                            editable=shape["editable"],
                        ),
                        entry,
                    )
                )
            for shape, occurrence, _entry in _rematch_items(reader, song, items):
                add(shape, occurrence)

    ordered = []
    for group_id in sorted(groups):
        group = groups[group_id]
        group["occurrences"].sort(
            key=lambda item: (
                item["album"],
                item["file"],
                item["song_index"],
                item["si"],
                item["bi"],
                item["ei"],
            )
        )
        ordered.append(group)
    counts["groups"] = len(ordered)
    return {"groups": ordered, "counts": counts}
