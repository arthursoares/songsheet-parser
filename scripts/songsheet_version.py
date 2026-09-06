"""Single source of truth for the songsheet document schema version.

Version history:
  1 — original model (6-char voicing strings, no hyphenation seeding)
  2 — comma-form voicings (x,5,7,5,6,x), lyric word-continuation dashes
  3 — optional observation_id links to immutable extraction evidence

Docs without a ``schema_version`` field predate stamping and are treated as
current (the v1→v2 voicing migration rewrote files in place without a marker).
Writers stamp the current version; loaders must refuse docs from the future.
"""

SCHEMA_VERSION = 3


def stamp(doc: dict) -> dict:
    """Set schema_version on a document (in place) and return it."""
    doc["schema_version"] = SCHEMA_VERSION
    return doc


def version_error(doc) -> str | None:
    """Reject non-documents and invalid or unsupported schema version markers."""
    if not isinstance(doc, dict):
        return "document must be a JSON object"
    v = doc.get("schema_version", SCHEMA_VERSION)
    if type(v) is not int or v < 1:
        return "document schema_version must be a positive integer"
    if v > SCHEMA_VERSION:
        return f"document schema_version {v} is newer than supported version {SCHEMA_VERSION}"
    return None
