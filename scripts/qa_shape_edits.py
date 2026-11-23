"""Recoverable, revision-guarded batch edits for repeated chord shapes.

The QA server must serialize calls to this module with its ordinary song POST
writer.  There is deliberately no process-wide or cross-process lock here.
Every destination is nevertheless checked against its expected byte digest
immediately before publication, and rollback only replaces content whose
digest is one of the transaction's known states.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
import time
import unicodedata
from pathlib import Path

from extraction_provenance import preserve_evidence
from harmony import parse_symbol
from songsheet_io import load_document, publish_bytes, save_document, validate_document
from songsheet_version import stamp


class ShapeEditError(ValueError):
    """A requested shape edit is invalid, stale, or unsafe to recover."""


_DIGEST = re.compile(r"[0-9a-f]{64}\Z")
_BATCH_ID = re.compile(r"shape-[0-9a-f]{32}\Z")


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _valid_digest(value) -> bool:
    return isinstance(value, str) and _DIGEST.fullmatch(value) is not None


def _valid_voicing(value) -> bool:
    if not isinstance(value, str):
        return False
    parts = value.split(",")
    return len(parts) == 6 and all(
        part == "x" or part.isascii() and part.isdigit() and int(part) <= 24 for part in parts
    )


def _valid_chord(value) -> bool:
    if not isinstance(value, str) or not value or "%" in value:
        return False
    if any(char.isspace() or unicodedata.category(char).startswith("C") for char in value):
        return False
    return parse_symbol(value) is not None


def _safe_target(root: Path, album, file) -> tuple[Path, str, str]:
    if not isinstance(album, str) or not isinstance(file, str):
        raise ShapeEditError("album and file must be strings")
    if (
        not album
        or not file
        or album in {".", ".."}
        or file in {".", ".."}
        or Path(album).name != album
        or Path(file).name != file
        or "\\" in album
        or "\\" in file
        or "\x00" in album
        or "\x00" in file
        or file.startswith(".")
        or not file.endswith(".json")
    ):
        raise ShapeEditError("unsafe song path")
    try:
        resolved_root = root.resolve(strict=True)
        unresolved_album = resolved_root / album
        unresolved_target = unresolved_album / file
        if unresolved_album.is_symlink() or unresolved_target.is_symlink():
            raise ShapeEditError("song path must not use symbolic links")
        album_path = unresolved_album.resolve(strict=True)
        target = unresolved_target.resolve(strict=True)
    except OSError as exc:
        raise ShapeEditError(f"song path is unavailable: {album}/{file}") from exc
    if (
        not resolved_root.is_dir()
        or album_path.parent != resolved_root
        or target.parent != album_path
        or not target.is_file()
        or not target.is_relative_to(resolved_root)
    ):
        raise ShapeEditError("song path escapes the corpus root")
    return target, album, file


def _entry_at(doc: dict, row: dict) -> tuple[dict, dict]:
    indexes = [row.get(name) for name in ("song_index", "si", "bi", "ei")]
    if any(type(value) is not int or value < 0 for value in indexes):
        raise ShapeEditError("occurrence coordinates must be non-negative integers")
    song_index, si, bi, ei = indexes
    try:
        song = doc["songs"][song_index]
        entry = song["sections"][si]["bars"][bi][ei]
    except (IndexError, KeyError, TypeError) as exc:
        raise ShapeEditError("occurrence coordinates are stale") from exc
    if not isinstance(song, dict) or not isinstance(entry, dict):
        raise ShapeEditError("occurrence coordinates do not identify a chord")
    return song, entry


def _verify_occurrence(doc: dict, row: dict, printed_voicing: str) -> tuple[dict, int]:
    song, entry = _entry_at(doc, row)
    if not isinstance(row.get("title"), str) or song.get("title") != row["title"]:
        raise ShapeEditError("song title no longer matches the reviewed occurrence")
    if not isinstance(row.get("label"), str) or entry.get("chord") != row["label"]:
        raise ShapeEditError("chord label no longer matches the reviewed occurrence")
    if entry.get("voicing") != row.get("editorial"):
        raise ShapeEditError("editorial voicing no longer matches the reviewed occurrence")
    if row.get("printed") != printed_voicing:
        raise ShapeEditError("occurrence belongs to a different shape group")
    if entry.get("voicing_printed") != row.get("printed"):
        raise ShapeEditError("printed voicing no longer matches the reviewed occurrence")
    observation_id = row.get("observation_id")
    if observation_id is not None and not _valid_digest(observation_id):
        raise ShapeEditError("invalid observation identity")
    if entry.get("observation_id") != observation_id:
        raise ShapeEditError("observation identity no longer matches")
    if observation_id is not None:
        observation = doc.get("_meta", {}).get("observations", {}).get(observation_id)
        if not isinstance(observation, dict):
            raise ShapeEditError("observation evidence is missing")
        wrapper = doc.get("_meta", {}).get("diagram_evidence", {}).get(observation_id)
        record = wrapper.get("record") if isinstance(wrapper, dict) else None
        if isinstance(record, dict):
            source = record.get("source_pdf", {})
            expected_pdf = row.get("pdf")
            if expected_pdf is not None and source.get("name") != Path(str(expected_pdf)).name:
                raise ShapeEditError("PDF evidence no longer matches")
            if row.get("pdf_sha256") is not None and source.get("sha256") != row["pdf_sha256"]:
                raise ShapeEditError("PDF digest no longer matches")
            if row.get("page") is not None and record.get("page") != row["page"]:
                raise ShapeEditError("PDF page evidence no longer matches")
            if row.get("box") is not None and record.get("crop_box") != row["box"]:
                raise ShapeEditError("diagram crop evidence no longer matches")
            if record.get("voicing_printed") != row.get("printed"):
                raise ShapeEditError("diagram reading no longer matches")
    return entry, row["song_index"]


def _serialized_document(doc: dict) -> bytes:
    validate_document(doc)
    try:
        value = stamp(dict(doc))
        return json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, UnicodeEncodeError) as exc:
        raise ShapeEditError(f"edited document is not serializable: {exc}") from exc


def _review_snapshot(entry: dict) -> dict:
    return {
        "chord": entry["chord"],
        "voicing": entry.get("voicing"),
        "voicing_printed": entry.get("voicing_printed"),
        "observation_id": entry.get("observation_id"),
    }


def _private_dir(path: Path) -> None:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.is_symlink() or not path.is_dir():
        raise ShapeEditError("history path must be a directory")
    try:
        os.chmod(path, 0o700)
    except OSError as exc:
        raise ShapeEditError("could not make history directory private") from exc


def _write_private(path: Path, payload: bytes, *, overwrite: bool = False) -> None:
    publish_bytes(path, payload, overwrite=overwrite)
    os.chmod(path, 0o600)


def _state_payload(state: str) -> bytes:
    return json.dumps({"state": state}, indent=2).encode("utf-8")


def _set_state(batch_dir: Path, state: str, *, create: bool = False) -> None:
    _write_private(batch_dir / "state.json", _state_payload(state), overwrite=not create)


def _current_digest(path: Path) -> str:
    try:
        return _sha256(path.read_bytes())
    except OSError as exc:
        raise ShapeEditError(f"could not read song during transaction: {path.name}") from exc


def _guarded_restore(records: list[dict], *, restore: str, expected: str) -> list[str]:
    failures = []
    for record in reversed(records):
        path = record["path"]
        try:
            digest = _current_digest(path)
            if digest == record[f"{restore}_sha256"]:
                continue
            if digest != record[f"{expected}_sha256"]:
                failures.append(f"{record['album']}/{record['file']}: unexpected content")
                continue
            publish_bytes(path, record[restore], overwrite=True)
            if _current_digest(path) != record[f"{restore}_sha256"]:
                failures.append(f"{record['album']}/{record['file']}: verification failed")
        except (OSError, ShapeEditError) as exc:
            failures.append(f"{record['album']}/{record['file']}: {exc}")
    return failures


def _result(
    batch_id: str, records: list[dict], songs: set[tuple[str, str, int]], entries: int
) -> dict:
    return {
        "ok": True,
        "batch_id": batch_id,
        "songs": len(songs),
        "entries": entries,
        "files": [{"album": record["album"], "file": record["file"]} for record in records],
    }


def apply_shape_batch(
    root: Path,
    history: Path,
    group: dict,
    selected: list[str],
    *,
    chord: str | None = None,
    voicing: str | None = None,
) -> dict:
    """Apply explicitly selected corrections as one recoverable batch.

    ``group`` is expected to come from the server's trusted, revision-bound
    shape index.  Callers must not accept a client-authored replacement group.
    """
    root, history = Path(root), Path(history)
    if not isinstance(group, dict) or not isinstance(group.get("id"), str) or not group["id"]:
        raise ShapeEditError("invalid shape group")
    printed_voicing = group.get("voicing")
    if not _valid_voicing(printed_voicing):
        raise ShapeEditError("invalid target voicing")
    if chord is not None and not _valid_chord(chord):
        raise ShapeEditError("invalid target chord")
    effective_voicing = printed_voicing if voicing is None else voicing
    if not _valid_voicing(effective_voicing):
        raise ShapeEditError("invalid target voicing")
    occurrences = group.get("occurrences")
    if not isinstance(occurrences, list) or any(not isinstance(row, dict) for row in occurrences):
        raise ShapeEditError("invalid shape occurrences")
    if (
        not isinstance(selected, list)
        or not selected
        or any(not isinstance(item, str) for item in selected)
    ):
        raise ShapeEditError("selected occurrence IDs must be a non-empty string list")
    if len(selected) != len(set(selected)):
        raise ShapeEditError("duplicate selected occurrence ID")

    by_id = {}
    for row in occurrences:
        occurrence_id = row.get("id")
        if not isinstance(occurrence_id, str) or not occurrence_id or occurrence_id in by_id:
            raise ShapeEditError("shape occurrence IDs must be unique strings")
        if row.get("group_id", group["id"]) != group["id"]:
            raise ShapeEditError("occurrence belongs to a different shape group")
        by_id[occurrence_id] = row
    unknown = [item for item in selected if item not in by_id]
    if unknown:
        raise ShapeEditError("selected occurrence is not in this shape group")

    selected_rows = [by_id[item] for item in selected]
    if any(row.get("editable") is not True for row in selected_rows):
        raise ShapeEditError("selected occurrence is not editable")

    documents: dict[Path, dict] = {}
    records_by_path: dict[Path, dict] = {}
    songs: set[tuple[str, str, int]] = set()
    coordinates = set()
    for row in selected_rows:
        path, album, file = _safe_target(root, row.get("album"), row.get("file"))
        expected_digest = row.get("document_sha256")
        if not _valid_digest(expected_digest):
            raise ShapeEditError("invalid document digest")
        if path not in documents:
            before = path.read_bytes()
            if _sha256(before) != expected_digest:
                raise ShapeEditError(f"stale song document: {album}/{file}")
            try:
                documents[path] = load_document(path)
            except (OSError, ValueError) as exc:
                raise ShapeEditError(f"invalid song document: {album}/{file}: {exc}") from exc
            records_by_path[path] = {
                "path": path,
                "album": album,
                "file": file,
                "before": before,
                "before_sha256": expected_digest,
            }
        elif records_by_path[path]["before_sha256"] != expected_digest:
            raise ShapeEditError("occurrences disagree about the document revision")
        coord = (path, row.get("song_index"), row.get("si"), row.get("bi"), row.get("ei"))
        if coord in coordinates:
            raise ShapeEditError("multiple selected IDs identify the same occurrence")
        coordinates.add(coord)
        entry, song_index = _verify_occurrence(documents[path], row, printed_voicing)
        if entry.get("voicing") == effective_voicing and (
            chord is None or entry.get("chord") == chord
        ):
            raise ShapeEditError("selected occurrence does not need correction")
        if chord is not None:
            entry["chord"] = chord
        entry["voicing"] = effective_voicing
        entry["chord_review"] = {"status": "reviewed", "snapshot": _review_snapshot(entry)}
        songs.add((album, file, song_index))

    records = []
    for path in sorted(
        records_by_path,
        key=lambda item: (records_by_path[item]["album"], records_by_path[item]["file"]),
    ):
        record = records_by_path[path]
        record["after"] = _serialized_document(documents[path])
        record["after_sha256"] = _sha256(record["after"])
        records.append(record)

    batch_id = f"shape-{secrets.token_hex(16)}"
    manifest = {
        "version": 1,
        "batch_id": batch_id,
        "group_id": group["id"],
        "songs": len(songs),
        "entries": len(selected_rows),
        "files": [
            {
                "album": record["album"],
                "file": record["file"],
                "before_sha256": record["before_sha256"],
                "after_sha256": record["after_sha256"],
                "before_base64": base64.b64encode(record["before"]).decode("ascii"),
                "after_base64": base64.b64encode(record["after"]).decode("ascii"),
            }
            for record in records
        ],
    }
    shape = {
        "version": 1,
        "group_id": group["id"],
        "voicing": effective_voicing,
        "created_order": time.time_ns(),
    }

    _private_dir(history)
    batch_dir = history / batch_id
    try:
        batch_dir.mkdir(mode=0o700)
        _write_private(
            batch_dir / "manifest.json",
            json.dumps(manifest, ensure_ascii=False, indent=2, allow_nan=False).encode("utf-8"),
        )
        _write_private(
            batch_dir / "shape.json",
            json.dumps(shape, ensure_ascii=False, indent=2, allow_nan=False).encode("utf-8"),
        )
        _set_state(batch_dir, "prepared", create=True)
    except (OSError, ValueError) as exc:
        raise ShapeEditError(f"could not prepare batch history: {exc}") from exc

    written = []
    try:
        for record in records:
            if _current_digest(record["path"]) != record["before_sha256"]:
                raise ShapeEditError(
                    f"song changed before batch write: {record['album']}/{record['file']}"
                )
            written.append(record)
            save_document(record["path"], documents[record["path"]], overwrite=True)
            if _current_digest(record["path"]) != record["after_sha256"]:
                raise ShapeEditError(
                    f"song write did not match prepared batch: {record['album']}/{record['file']}"
                )
        _set_state(batch_dir, "applied")
    except (OSError, ValueError) as exc:
        failures = _guarded_restore(written, restore="before", expected="after")
        try:
            _set_state(batch_dir, "rollback_failed" if failures else "rolled_back")
        except (OSError, ValueError):
            failures.append("could not record rollback state")
        suffix = f"; rollback problems: {'; '.join(failures)}" if failures else ""
        raise ShapeEditError(f"shape batch was not applied: {exc}{suffix}") from exc

    return _result(batch_id, records, songs, len(selected_rows))


def latest_shape_corrections(history: Path) -> dict[str, str]:
    """Return the newest still-applied manual voicing for each shape group.

    The deliberately small sidecars keep this lookup independent of the batch
    manifests, which contain complete before/after document snapshots.
    """
    history = Path(history)
    if not history.exists():
        return {}
    if history.is_symlink() or not history.is_dir():
        raise ShapeEditError("history path must be a directory")

    newest: dict[str, tuple[int, str, str]] = {}
    try:
        batch_dirs = history.iterdir()
        for batch_dir in batch_dirs:
            if (
                batch_dir.is_symlink()
                or not batch_dir.is_dir()
                or _BATCH_ID.fullmatch(batch_dir.name) is None
            ):
                continue
            state_path = batch_dir / "state.json"
            shape_path = batch_dir / "shape.json"
            if (
                not state_path.is_file()
                or state_path.is_symlink()
                or not shape_path.is_file()
                or shape_path.is_symlink()
            ):
                continue
            try:
                state = json.loads(state_path.read_text(encoding="utf-8"))
                shape = json.loads(shape_path.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                continue
            if state != {"state": "applied"} or not isinstance(shape, dict):
                continue
            if set(shape) != {"version", "group_id", "voicing", "created_order"}:
                continue
            group_id = shape.get("group_id")
            effective_voicing = shape.get("voicing")
            created_order = shape.get("created_order")
            if (
                shape.get("version") != 1
                or not isinstance(group_id, str)
                or not group_id
                or not _valid_voicing(effective_voicing)
                or type(created_order) is not int
                or created_order < 0
            ):
                continue
            candidate = (created_order, batch_dir.name, effective_voicing)
            if group_id not in newest or candidate[:2] > newest[group_id][:2]:
                newest[group_id] = candidate
    except OSError as exc:
        raise ShapeEditError("could not inspect batch history") from exc

    return {group_id: saved[2] for group_id, saved in newest.items()}


def _read_batch(
    root: Path, history: Path, batch_id: str, *, required_state: str | None = None
) -> tuple[Path, str, dict, list[dict]]:
    if not isinstance(batch_id, str) or _BATCH_ID.fullmatch(batch_id) is None:
        raise ShapeEditError("invalid batch ID")
    try:
        history_root = history.resolve(strict=True)
        unresolved_batch = history_root / batch_id
        if unresolved_batch.is_symlink():
            raise ShapeEditError("unsafe batch history path")
        batch_dir = unresolved_batch.resolve(strict=True)
    except OSError as exc:
        raise ShapeEditError("batch history does not exist") from exc
    if batch_dir.parent != history_root or not batch_dir.is_dir() or batch_dir.is_symlink():
        raise ShapeEditError("unsafe batch history path")
    try:
        state = json.loads((batch_dir / "state.json").read_text(encoding="utf-8"))
        manifest = json.loads((batch_dir / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ShapeEditError("batch history is unreadable") from exc
    if (
        not isinstance(state, dict)
        or set(state) != {"state"}
        or not isinstance(state["state"], str)
    ):
        raise ShapeEditError("batch state is malformed")
    state_name = state["state"]
    if required_state is not None and state_name != required_state:
        raise ShapeEditError(f"batch is not currently {required_state}")
    if (
        not isinstance(manifest, dict)
        or manifest.get("version") != 1
        or manifest.get("batch_id") != batch_id
        or not isinstance(manifest.get("files"), list)
        or not manifest["files"]
    ):
        raise ShapeEditError("batch history is malformed")
    songs, entries = manifest.get("songs"), manifest.get("entries")
    if type(songs) is not int or songs < 0 or type(entries) is not int or entries < 1:
        raise ShapeEditError("batch history counters are malformed")

    records = []
    seen = set()
    for saved in manifest["files"]:
        if not isinstance(saved, dict):
            raise ShapeEditError("batch history is malformed")
        path, album, file = _safe_target(root, saved.get("album"), saved.get("file"))
        if path in seen:
            raise ShapeEditError("batch history contains a duplicate file")
        seen.add(path)
        try:
            before = base64.b64decode(saved["before_base64"], validate=True)
            after = base64.b64decode(saved["after_base64"], validate=True)
        except (KeyError, TypeError, ValueError) as exc:
            raise ShapeEditError("batch content snapshot is malformed") from exc
        before_digest, after_digest = saved.get("before_sha256"), saved.get("after_sha256")
        if (
            not _valid_digest(before_digest)
            or not _valid_digest(after_digest)
            or _sha256(before) != before_digest
            or _sha256(after) != after_digest
        ):
            raise ShapeEditError("batch content snapshot digest mismatch")
        try:
            before_doc = json.loads(before)
            after_doc = json.loads(after)
            validate_document(before_doc)
            validate_document(after_doc)
            preserve_evidence(after_doc, before_doc)
        except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError) as exc:
            raise ShapeEditError("batch content snapshot is not a valid document") from exc
        records.append(
            {
                "path": path,
                "album": album,
                "file": file,
                "before": before,
                "after": after,
                "before_sha256": before_digest,
                "after_sha256": after_digest,
            }
        )
    return batch_dir, state_name, manifest, records


def undo_shape_batch(root: Path, history: Path, batch_id: str) -> dict:
    """Restore every file in an applied batch after an all-files stale check."""
    root, history = Path(root), Path(history)
    batch_dir, _state, manifest, records = _read_batch(
        root, history, batch_id, required_state="applied"
    )
    for record in records:
        if _current_digest(record["path"]) != record["after_sha256"]:
            raise ShapeEditError(f"stale song prevents undo: {record['album']}/{record['file']}")

    reverted = []
    try:
        # Persist intent before touching a song.  Startup recovery can now
        # distinguish an interrupted undo from an ordinarily applied batch.
        _set_state(batch_dir, "undoing")
        for record in records:
            if _current_digest(record["path"]) != record["after_sha256"]:
                raise ShapeEditError(
                    f"song changed before undo write: {record['album']}/{record['file']}"
                )
            reverted.append(record)
            publish_bytes(record["path"], record["before"], overwrite=True)
            if _current_digest(record["path"]) != record["before_sha256"]:
                raise ShapeEditError(
                    f"undo write did not match history: {record['album']}/{record['file']}"
                )
        _set_state(batch_dir, "undone")
    except (OSError, ValueError) as exc:
        failures = _guarded_restore(reverted, restore="after", expected="before")
        try:
            _set_state(batch_dir, "undo_rollback_failed" if failures else "applied")
        except (OSError, ValueError):
            failures.append("could not record undo rollback state")
        suffix = f"; rollback problems: {'; '.join(failures)}" if failures else ""
        raise ShapeEditError(f"shape batch was not undone: {exc}{suffix}") from exc

    return {
        "ok": True,
        "batch_id": batch_id,
        "songs": manifest["songs"],
        "entries": manifest["entries"],
        "files": [{"album": item["album"], "file": item["file"]} for item in records],
    }


def recover_shape_batches(root: Path, history: Path) -> dict:
    """Recover batches interrupted by process death.

    Callers must hold the same writer lock used for song POST and batch
    operations.  A ``prepared`` batch is always rolled back, making a missing
    apply response safe to retry.  An ``undoing`` batch is always completed.
    All unfinished journals and current files are validated before any recovery
    write; a file matching neither snapshot stops recovery without mutation.
    """
    root, history = Path(root), Path(history)
    if not history.exists():
        return {"ok": True, "batches": 0, "files": 0, "recovered": []}
    if history.is_symlink() or not history.is_dir():
        raise ShapeEditError("history path must be a directory")

    plans = []
    try:
        batch_ids = sorted(
            path.name
            for path in history.iterdir()
            if path.is_dir() and _BATCH_ID.fullmatch(path.name) is not None
        )
    except OSError as exc:
        raise ShapeEditError("could not inspect batch history") from exc
    for batch_id in batch_ids:
        state_path = history / batch_id / "state.json"
        # The state marker arms a journal and is created only after its
        # manifest.  A crash before that marker cannot have changed a song.
        if not state_path.exists():
            continue
        if state_path.is_symlink():
            raise ShapeEditError("unsafe batch state path")
        try:
            state_value = json.loads(state_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ShapeEditError("batch state is unreadable") from exc
        if (
            not isinstance(state_value, dict)
            or set(state_value) != {"state"}
            or not isinstance(state_value["state"], str)
        ):
            raise ShapeEditError("batch state is malformed")
        state = state_value["state"]
        if state in {"applied", "undone", "rolled_back"}:
            continue
        if state not in {"prepared", "undoing"}:
            raise ShapeEditError(f"batch requires manual recovery: {batch_id}: {state}")
        batch_dir, loaded_state, _manifest, records = _read_batch(root, history, batch_id)
        if loaded_state != state:
            raise ShapeEditError("batch state changed during recovery preflight")
        plans.append((batch_id, batch_dir, state, records))

    seen_paths = set()
    for batch_id, _batch_dir, _state, records in plans:
        for record in records:
            path = record["path"]
            if path in seen_paths:
                raise ShapeEditError("unfinished batches overlap the same song")
            seen_paths.add(path)
            digest = _current_digest(path)
            if digest not in {record["before_sha256"], record["after_sha256"]}:
                raise ShapeEditError(
                    f"batch recovery conflict: {batch_id}: "
                    f"{record['album']}/{record['file']} has unexpected content"
                )

    recovered = []
    file_count = 0
    for batch_id, batch_dir, state, records in plans:
        for record in records:
            digest = _current_digest(record["path"])
            if digest == record["before_sha256"]:
                continue
            if digest != record["after_sha256"]:
                raise ShapeEditError(
                    f"batch recovery conflict: {batch_id}: "
                    f"{record['album']}/{record['file']} changed during recovery"
                )
            publish_bytes(record["path"], record["before"], overwrite=True)
            if _current_digest(record["path"]) != record["before_sha256"]:
                raise ShapeEditError(
                    f"batch recovery write failed: {record['album']}/{record['file']}"
                )
            file_count += 1
        final_state = "rolled_back" if state == "prepared" else "undone"
        _set_state(batch_dir, final_state)
        recovered.append({"batch_id": batch_id, "state": final_state})

    return {
        "ok": True,
        "batches": len(recovered),
        "files": file_count,
        "recovered": recovered,
    }
