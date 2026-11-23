"""HTTP plumbing for the library-wide Shapes workspace."""

import hashlib
import io
import json
import re
import threading
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from extraction_provenance import file_sha256

CACHE_ROOT = Path(__file__).resolve().parent.parent / ".local" / "shapes"
PAGE_SIZE = 60
MAX_SELECTION = 2000
_INDEX_LOCK = threading.Lock()
_INDEXES = {}
_EDITED_FILES = set()
_RECOVERY_ERRORS = {}


def requires_revision(root, album, file):
    return (root.resolve(), album, file) in _EDITED_FILES


def recovery_problem(root):
    return _RECOVERY_ERRORS.get(root.resolve())


def _track_edited_files(root, result):
    _EDITED_FILES.update((root.resolve(), row["album"], row["file"]) for row in result["files"])
    return result


def recover_library(root, write_lock):
    from qa_shape_edits import ShapeEditError, recover_shape_batches

    key = root.resolve()
    with write_lock:
        try:
            result = recover_shape_batches(root, _cache_path(root) / "batches")
        except ShapeEditError as exc:
            _RECOVERY_ERRORS[key] = str(exc)
            return f"Shapes batch recovery needs attention: {exc}"
        _RECOVERY_ERRORS.pop(key, None)
        for manifest in (_cache_path(root) / "batches").glob("shape-*/manifest.json"):
            if manifest.is_symlink() or manifest.parent.is_symlink():
                continue
            try:
                files = json.loads(manifest.read_bytes())["files"]
                for row in files:
                    if isinstance(row["album"], str) and isinstance(row["file"], str):
                        _EDITED_FILES.add((key, row["album"], row["file"]))
            except (OSError, KeyError, TypeError, ValueError):
                continue
    if result["batches"]:
        return f"Recovered {result['batches']} interrupted Shapes batches."
    return ""


def _json(status, value):
    return (
        status,
        "application/json",
        json.dumps(value, ensure_ascii=False).encode(),
        {"Cache-Control": "no-store"},
    )


def _stat(path):
    info = path.stat()
    return info.st_ino, info.st_size, info.st_mtime_ns


def _signature(root, pdf_dir):
    return tuple(
        (path, _stat(path)) for path in sorted([*root.glob("*/*.json"), *pdf_dir.glob("*.pdf")])
    )


def _cache_path(root):
    scope = hashlib.sha256(str(root.resolve()).encode()).hexdigest()[:20]
    return CACHE_ROOT / scope


@dataclass
class Index:
    signature: tuple
    groups: dict
    occurrences: dict
    counts: dict


def _get_index(root, pdf_dir, pdf_lock):
    from qa_shapes import build_shape_index

    key = (root.resolve(), pdf_dir.resolve())
    with _INDEX_LOCK:
        signature = _signature(*key)
        current = _INDEXES.get(key)
        if current and current.signature == signature:
            return current
        with pdf_lock:
            result = build_shape_index(*key, _cache_path(root) / "pages")
        if _signature(*key) != signature:
            raise ValueError("The library changed during indexing. Refresh Shapes.")
        groups = {group["id"]: group for group in result["groups"]}
        occurrences = {row["id"]: row for group in groups.values() for row in group["occurrences"]}
        current = Index(signature, groups, occurrences, result["counts"])
        _INDEXES[key] = current
        return current


def _song_key(row):
    file = re.sub(r"^(\d+-)qa-", r"\1", row["file"], count=1)
    return row["album"], file, row["song_index"]


def _summary(group, rows, corrections):
    correction = corrections.get(group["id"])
    target = correction or group["voicing"]
    disagreements = [
        row
        for row in rows
        if (target or row["printed"]) and (target or row["printed"]) != row["editorial"]
    ]
    sample = next(iter(disagreements), rows[0])
    return {
        "id": group["id"],
        "pattern": group["pattern"],
        "columns": group["columns"],
        "base": group["base"],
        "voicing": group["voicing"],
        "correction": correction if correction != group["voicing"] else None,
        "songs": len({_song_key(row) for row in rows}),
        "matches": len(rows),
        "disagreements": len(disagreements),
        "affected_songs": len({_song_key(row) for row in disagreements}),
        "labels": sorted({row["label"] for row in rows}),
        "sample_id": sample["id"],
    }


def _rank(summary):
    return -summary["affected_songs"], -summary["disagreements"], -summary["songs"], summary["id"]


def _matching_rows(group, params, corrections):
    album = params.get("album", "")
    query = params.get("q", "").casefold().strip()
    return [
        row
        for row in group["occurrences"]
        if (not album or row["album"] == album)
        and (
            not query
            or query
            in " ".join(
                (
                    row["label"],
                    row["title"],
                    row["file"],
                    row["album"],
                    group["voicing"] or "",
                    corrections.get(group["id"], ""),
                    row["editorial"] or "",
                    row["printed"] or "",
                )
            ).casefold()
        )
    ]


def _scope_rows(group, album):
    return [row for row in group["occurrences"] if not album or row["album"] == album]


def _list(index, params, corrections):
    summaries = []
    for group in index.groups.values():
        if _matching_rows(group, params, corrections):
            summaries.append(_summary(group, _scope_rows(group, params.get("album")), corrections))
    summaries.sort(key=_rank)
    pages = max(1, (len(summaries) + PAGE_SIZE - 1) // PAGE_SIZE)
    try:
        page = min(max(1, int(params.get("page", "1"))), pages)
    except ValueError:
        return _json(400, {"error": "Invalid page."})
    start = (page - 1) * PAGE_SIZE
    return _json(
        200,
        {
            "groups": summaries[start : start + PAGE_SIZE],
            "albums": sorted({row["album"] for row in index.occurrences.values()}),
            "counts": {
                **index.counts,
                "groups": len(index.groups),
                "filtered_groups": len(summaries),
            },
            "page": page,
            "pages": pages,
        },
    )


def _detail(index, group, params, corrections):
    album = params.get("album")
    rows = _scope_rows(group, album)
    if not rows:
        return _json(404, {"error": "This shape does not occur in the selected album."})
    similar = []
    shape = list(zip(group["pattern"], group["columns"], strict=True))
    for other in index.groups.values():
        if other is group or other["base"] != group["base"]:
            continue
        other_shape = zip(other["pattern"], other["columns"], strict=True)
        if sum(a != b for a, b in zip(shape, other_shape, strict=True)) == 1:
            scoped = _scope_rows(other, album)
            if scoped:
                similar.append(_summary(other, scoped, corrections))
    similar.sort(key=_rank)
    return _json(
        200,
        {
            **_summary(group, rows, corrections),
            "occurrences": [
                {
                    key: value
                    for key, value in row.items()
                    if key not in {"box", "pdf", "pdf_sha256"}
                }
                for row in rows
            ],
            "similar": similar[:12],
            "album": album,
        },
    )


@lru_cache(maxsize=64)
def _pdf_hash(pdf, _signature):
    return file_sha256(pdf)


def _crop(row, pdf_dir, pdf_lock):
    from diagram_reader import load_page_image
    from PIL import Image

    pdf = (pdf_dir / row["pdf"]).resolve()
    if not pdf.is_relative_to(pdf_dir.resolve()) or not pdf.is_file():
        return _json(404, {"error": "PDF source unavailable."})
    if _pdf_hash(pdf, _stat(pdf)) != row["pdf_sha256"]:
        return _json(409, {"error": "The PDF changed. Refresh Shapes."})
    with pdf_lock:
        source = load_page_image(pdf, row["page"])
    x0, y0, x1, y1 = row["box"]
    crop = source[max(0, y0 - 12) : y1 + 13, max(0, x0 - 8) : x1 + 9]
    if not crop.size:
        return _json(404, {"error": "Diagram crop unavailable."})
    native = Image.fromarray(crop.astype("uint8"))
    output = io.BytesIO()
    native.resize((native.width * 4, native.height * 4), Image.Resampling.LANCZOS).save(
        output, "PNG"
    )
    return 200, "image/png", output.getvalue(), {"Cache-Control": "private, max-age=300"}


def _entry(index, params):
    try:
        at = tuple(int(params[key]) for key in ("song_index", "si", "bi", "ei"))
    except (ValueError, KeyError):
        return _json(400, {"error": "A song and chord location are required."})
    for group in index.groups.values():
        for row in group["occurrences"]:
            if (
                row["album"] == params.get("album")
                and row["file"] == params.get("file")
                and tuple(row[k] for k in ("song_index", "si", "bi", "ei")) == at
            ):
                if params.get("revision") and params["revision"] != row["document_sha256"]:
                    return _json(
                        409, {"error": "The song changed. Reload it before finding its shape."}
                    )
                return _json(200, {"id": group["id"], "occurrence_id": row["id"]})
    return _json(404, {"error": "This chord has no reliably linked shape in the scan index."})


def handle_shapes(method, parts, req, pdf_dir, write_lock, pdf_lock):
    """Serve an index for this library or change explicitly selected chart entries."""
    from qa_shape_edits import (
        ShapeEditError,
        apply_shape_batch,
        latest_shape_corrections,
        undo_shape_batch,
    )

    history = _cache_path(req.root) / "batches"
    try:
        recovery_error = recovery_problem(req.root)
        if method == "POST" and recovery_error:
            return _json(
                409, {"error": f"Resolve the interrupted Shapes batch first. {recovery_error}"}
            )
        if method == "POST" and len(parts) == 3 and parts[0] == "batch" and parts[2] == "undo":
            with write_lock:
                result = undo_shape_batch(req.root, history, parts[1])
                return _json(200, _track_edited_files(req.root, result))
        if pdf_dir is None or not pdf_dir.is_dir():
            return _json(503, {"error": "Configure a source PDF directory to index shapes."})
        index = _get_index(req.root, pdf_dir, pdf_lock)
        if method == "GET" and not parts:
            return _list(index, req.params, latest_shape_corrections(history))
        if method == "GET" and parts == ["entry"]:
            return _entry(index, req.params)
        if method == "GET" and len(parts) == 2 and parts[0] == "crop":
            row = index.occurrences.get(parts[1])
            return (
                _crop(row, pdf_dir, pdf_lock) if row else _json(404, {"error": "Shape not found."})
            )
        group = index.groups.get(parts[0]) if parts else None
        if group is None:
            return _json(404, {"error": "Shape not found."})
        if method == "GET" and len(parts) == 1:
            return _detail(index, group, req.params, latest_shape_corrections(history))
        if method == "POST" and len(parts) == 2 and parts[1] == "apply":
            try:
                payload = json.loads(req.body)
                selected = payload.get("selected") if isinstance(payload, dict) else None
            except (UnicodeDecodeError, ValueError):
                return _json(400, {"error": "Invalid selection."})
            if not isinstance(selected, list) or not 0 < len(selected) <= MAX_SELECTION:
                return _json(400, {"error": "Select at least one occurrence to apply."})
            if any(not isinstance(value, str) for value in selected):
                return _json(400, {"error": "Invalid occurrence identifiers."})
            if "voicing" in payload and not isinstance(payload["voicing"], str):
                return _json(400, {"error": "Enter six string values for the corrected fingering."})
            if "chord" in payload and not isinstance(payload["chord"], str):
                return _json(400, {"error": "Enter a chord name or leave the name field blank."})
            from qa_shape_compat import check_shape_names

            selected_ids = set(selected)
            name = payload.get("chord")
            voicing = payload.get("voicing", group["voicing"])
            names = (
                [name]
                if name is not None
                else [row["label"] for row in group["occurrences"] if row["id"] in selected_ids]
            )
            if isinstance(voicing, str):
                check_shape_names(names, voicing, explicit=name is not None)
            with write_lock:
                result = apply_shape_batch(
                    req.root, history, group, selected, voicing=voicing, chord=name
                )
                return _json(200, _track_edited_files(req.root, result))
    except (ShapeEditError, ValueError) as exc:
        return _json(409, {"error": str(exc)})
    except (OSError, RuntimeError, SystemExit):
        return _json(503, {"error": "Source material is unavailable. Check the PDF directory."})
    return _json(404, {"error": "Unknown Shapes action."})
