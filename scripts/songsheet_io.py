"""Validated, atomic persistence for the editable songsheet corpus.

New files are published without clobbering an existing path. Replacing a file
requires overwrite=True and refuses unsupported versions already on disk.
Atomic publication prevents partial JSON; it does not merge concurrent edits.
Legacy voicing conversion remains the materializer's responsibility.
"""

import json
import os
import secrets
import stat
from pathlib import Path

import jsonschema
from extraction_provenance import preserve_evidence, validate_observations
from songsheet_version import stamp, version_error

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schemas" / "songsheet.schema.json"
_VALIDATOR = jsonschema.Draft7Validator(json.loads(SCHEMA_PATH.read_text(encoding="utf-8")))


class DocumentError(ValueError):
    """A document cannot be safely read or persisted by this version of the tool."""


def validate_document(doc) -> None:
    """Check version and schema before any writer stamps or serializes a document."""
    err = version_error(doc)
    if err:
        raise DocumentError(err)
    try:
        _VALIDATOR.validate(doc)
    except jsonschema.ValidationError as exc:
        raise DocumentError(f"{list(exc.absolute_path)}: {exc.message}") from exc
    try:
        validate_observations(doc)
    except (ValueError, TypeError) as exc:
        raise DocumentError(str(exc)) from exc


def _read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise DocumentError(f"{path}: invalid JSON: {exc}") from exc


def load_document(path: Path) -> dict:
    """Read and validate a corpus document before editing or expensive extraction."""
    doc = _read_json(Path(path))
    validate_document(doc)
    return doc


def check_destination(path: Path, *, overwrite: bool = False) -> dict | None:
    """Preflight a destination; create-only publication also checks atomically."""
    path = Path(path)
    if not path.exists():
        return
    if not overwrite:
        raise FileExistsError(f"{path} already exists; use a new output directory or --overwrite")
    # Permit repairing schema-invalid content, but never downgrade a future or
    # malformed version marker, nor silently replace an unreadable document.
    existing = _read_json(path)
    err = version_error(existing)
    if err:
        raise DocumentError(f"{path}: {err}")
    return existing


def save_document(path: Path, doc: dict, *, overwrite: bool = False) -> None:
    """Validate, stamp a copy, and publish complete UTF-8 JSON in one operation.

    The sibling temp file is flushed before publication and removed on failure.
    Existing file permissions are preserved. Parent directories must exist.
    """
    path = Path(path)
    validate_document(doc)
    try:
        payload = json.dumps(stamp(dict(doc)), ensure_ascii=False, indent=2, allow_nan=False)
        payload = payload.encode("utf-8")
    except (TypeError, ValueError, UnicodeEncodeError) as exc:
        raise DocumentError(f"document is not serializable as JSON: {exc}") from exc
    existing = check_destination(path, overwrite=overwrite)
    if existing is not None:
        try:
            preserve_evidence(existing, doc)
        except (ValueError, TypeError) as exc:
            raise DocumentError(str(exc)) from exc
    publish_bytes(path, payload, overwrite=overwrite)


def write_json_artifact(path: Path, value, *, overwrite: bool = False) -> None:
    """Publish a cache/report/manifest; editable songs must use save_document."""
    payload = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False).encode("utf-8")
    publish_bytes(Path(path), payload, overwrite=overwrite)


def publish_bytes(path: Path, payload: bytes, *, overwrite: bool = False) -> None:
    """Atomically publish bytes for an artifact on the same filesystem."""
    path = Path(path)
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else None
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
    # Exclusive creation honors the normal umask for new documents without
    # changing the process-global umask in the threaded QA server.
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o666)
    try:
        with os.fdopen(fd, "wb") as stream:
            if mode is not None:
                os.fchmod(stream.fileno(), mode)
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        if overwrite:
            os.replace(temporary, path)
        else:
            # A hard link publishes the complete file but fails if another
            # writer created the destination after the preflight check.
            os.link(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
