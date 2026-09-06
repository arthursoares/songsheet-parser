"""Content fingerprints and immutable observations alongside editable song entries."""

import copy
import hashlib
import json
from pathlib import Path


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def json_sha256(value) -> str:
    encoded = json.dumps(
        value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    )
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def entries(doc):
    for song_i, song in enumerate(doc.get("songs", [])):
        for section_i, section in enumerate(song.get("sections", [])):
            for bar_i, bar in enumerate(section.get("bars", [])):
                for entry_i, entry in enumerate(bar):
                    yield (song_i, section_i, bar_i, entry_i), entry


def attach_observations(doc: dict, source: dict) -> dict:
    """Return a copy with durable links to exact per-entry readings, never aliases."""
    result = copy.deepcopy(doc)
    source = copy.deepcopy(source)
    source["payload_sha256"] = json_sha256(
        {"document": doc.get("document"), "songs": doc.get("songs")}
    )
    source_id = json_sha256(source)
    meta = result.setdefault("_meta", {})
    meta["extraction_sources"] = {source_id: source}
    meta["observations"] = {}
    for position, entry in entries(result):
        value = {k: copy.deepcopy(v) for k, v in entry.items() if k != "observation_id"}
        observation = {"source_id": source_id, "position": list(position), "value": value}
        observation_id = json_sha256(observation)
        meta["observations"][observation_id] = observation
        entry["observation_id"] = observation_id
    return result


def has_observations(doc: dict) -> bool:
    meta = doc.get("_meta", {})
    observations = meta.get("observations", {})
    sources = meta.get("extraction_sources", {})
    return bool(sources) and all(
        entry.get("observation_id") in observations
        and observations[entry["observation_id"]].get("source_id") in sources
        for _, entry in entries(doc)
    )


def validate_observations(doc: dict) -> None:
    """Detect damaged evidence and dangling links while allowing editorial changes."""
    meta = doc.get("_meta", {})
    linked = [entry["observation_id"] for _, entry in entries(doc) if "observation_id" in entry]
    if not isinstance(meta, dict):
        if linked:
            raise ValueError("observation links require _meta evidence")
        return
    if not linked and not any(k in meta for k in ("observations", "extraction_sources")):
        return
    observations = meta.get("observations", {})
    sources = meta.get("extraction_sources", {})
    if not isinstance(observations, dict) or not isinstance(sources, dict):
        raise ValueError("observations and extraction_sources must be objects")
    for source_id, source in sources.items():
        if not isinstance(source, dict) or json_sha256(source) != source_id:
            raise ValueError("extraction source fingerprint mismatch")
    for observation_id, observation in observations.items():
        if not isinstance(observation, dict) or json_sha256(observation) != observation_id:
            raise ValueError("observation fingerprint mismatch")
        if observation.get("source_id") not in sources:
            raise ValueError("observation refers to a missing extraction source")
    if any(observation_id not in observations for observation_id in linked):
        raise ValueError("entry refers to a missing observation")
    if "page_sources" in meta:
        contexts = meta["page_sources"]
        if not isinstance(contexts, dict) or contexts.keys() != sources.keys():
            raise ValueError("page context must identify every extraction source")
        for context in contexts.values():
            if (
                not isinstance(context, dict)
                or type(context.get("page")) is not int
                or context["page"] < 1
            ):
                raise ValueError("page context needs a positive page number")
            if context.get("source_pdf") != meta.get("source_pdf"):
                raise ValueError("page context refers to a different source PDF")
        expected = json_sha256({"source_pdf": meta.get("source_pdf"), "page_sources": contexts})
        if meta.get("assembly_fingerprint") != expected:
            raise ValueError("assembly source/page fingerprint mismatch")


def seal_page_sources(meta: dict) -> None:
    if "page_sources" in meta:
        meta["assembly_fingerprint"] = json_sha256(
            {"source_pdf": meta.get("source_pdf"), "page_sources": meta["page_sources"]}
        )


def preserve_evidence(existing: dict, candidate: dict) -> None:
    """Reject destructive edits to previously persisted, content-addressed evidence."""
    old, new = existing.get("_meta", {}), candidate.get("_meta", {})
    if not isinstance(old, dict):
        return
    if "page_sources" in old and (
        not isinstance(new, dict) or new.get("source_pdf") != old.get("source_pdf")
    ):
        raise ValueError("cannot remove or alter the preserved source PDF")
    for key in ("extraction_sources", "observations", "page_sources"):
        records = old.get(key, {})
        if not isinstance(records, dict):
            raise ValueError("existing extraction evidence is malformed")
        replacement = new.get(key, {}) if isinstance(new, dict) else {}
        if any(replacement.get(k) != v for k, v in records.items()):
            raise ValueError(
                "cannot remove or alter preserved extraction evidence; use a new candidate file"
            )


def metadata_for_song(meta: dict, song: dict) -> dict:
    """Keep document metadata and only the observations referenced by this song."""
    result = copy.deepcopy(meta)
    if "observations" not in result:
        return result
    ids = {entry.get("observation_id") for _, entry in entries({"songs": [song]})}
    result["observations"] = {k: v for k, v in result["observations"].items() if k in ids}
    source_ids = {o["source_id"] for o in result["observations"].values()}
    for key in ("extraction_sources", "page_sources"):
        if key in result:
            result[key] = {k: v for k, v in result[key].items() if k in source_ids}
    seal_page_sources(result)
    return result
