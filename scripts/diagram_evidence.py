#!/usr/bin/env python3
"""Attach deterministic chord-diagram evidence to an extracted page result.

This module deliberately treats CV output as unreviewed source evidence.  It
only pairs diagrams to entries when a page has exactly one readable diagram
for every eligible source observation, in reading order.  Failures and count
mismatches are retained as diagnostics; they never trigger a guessed offset.

Offline usage (the input is never modified and OUTPUT must not exist):

    python scripts/diagram_evidence.py PAGE.json ALBUM.pdf --page 8 --output enriched.json
"""

import argparse
import copy
from pathlib import Path

from extraction_provenance import file_sha256, json_sha256, validate_observations
from songsheet_io import load_document, save_document
from songsheet_version import version_error

PAIRING_POLICY = "page_local_reading_order_exact_count"
COORDINATE_SPACE = "native_embedded_raster_pixels_inclusive_box"
REVIEW_STATUS = "unreviewed"
READER_PATH = Path(__file__).resolve().with_name("diagram_reader.py")
DIGIT_TEMPLATES_PATH = READER_PATH.with_name("diagram_digits.json")


class DiagramEvidenceError(ValueError):
    """The candidate cannot safely receive diagram evidence."""


def _entries(document: dict):
    for song_i, song in enumerate(document.get("songs", [])):
        for section_i, section in enumerate(song.get("sections", [])):
            for bar_i, bar in enumerate(section.get("bars", [])):
                for entry_i, entry in enumerate(bar):
                    yield [song_i, section_i, bar_i, entry_i], entry


def _eligible_entries(document: dict) -> list[dict]:
    observations = document.get("_meta", {}).get("observations", {})
    eligible = []
    for position, entry in _entries(document):
        observation_id = entry.get("observation_id")
        observation = observations.get(observation_id)
        if not isinstance(observation, dict):
            raise DiagramEvidenceError("every diagram candidate needs a source observation")
        value = observation.get("value")
        if not isinstance(value, dict):
            raise DiagramEvidenceError("diagram candidate observation value must be an object")
        symbol = value.get("chord")
        if (
            symbol != "%"
            or value.get("voicing") is not None
            or value.get("voicing_printed") is not None
        ):
            eligible.append(
                {
                    "position": position,
                    "entry": entry,
                    "observation_id": observation_id,
                    "original_symbol": symbol,
                }
            )
    return eligible


def _hashed(payload: dict) -> dict:
    return {"record": payload, "record_sha256": json_sha256(payload)}


def _diagnostic(
    *,
    pdf: dict,
    page_number: int,
    status: str,
    message: str,
    native_image=None,
    diagrams=None,
    eligible=None,
) -> dict:
    payload = {
        "source_pdf": pdf,
        "page": page_number,
        "status": status,
        "message": message,
        "pairing_policy": PAIRING_POLICY,
        "review_status": REVIEW_STATUS,
    }
    if native_image is not None:
        payload["native_image"] = native_image
    if diagrams is not None:
        payload["diagrams"] = copy.deepcopy(diagrams)
    if eligible is not None:
        payload["eligible_observation_ids"] = [item["observation_id"] for item in eligible]
    return _hashed(payload)


def _add_diagnostic(document: dict, diagnostic: dict) -> None:
    diagnostic_id = diagnostic["record_sha256"]
    diagnostics = document.setdefault("_meta", {}).setdefault("diagram_diagnostics", {})
    previous = diagnostics.get(diagnostic_id)
    if previous is not None and previous != diagnostic:
        raise DiagramEvidenceError(f"conflicting diagram diagnostic: {diagnostic_id}")
    diagnostics[diagnostic_id] = diagnostic


def record_page_failure(
    candidate: dict, pdf_path: Path, page_number: int, status: str, message: str
) -> dict:
    """Return a copy carrying a stable diagnostic for an integration failure."""
    result = copy.deepcopy(candidate)
    pdf_path = Path(pdf_path)
    pdf = {
        "name": pdf_path.name,
        "sha256": file_sha256(pdf_path) if pdf_path.is_file() else None,
    }
    _add_diagnostic(
        result,
        _diagnostic(
            pdf=pdf,
            page_number=page_number,
            status=status,
            message=message,
        ),
    )
    return result


def validate_diagram_metadata(document: dict) -> None:
    """Validate the internal hashes and observation links of diagram metadata."""
    meta = document.get("_meta", {})
    if not isinstance(meta, dict):
        return
    observations = meta.get("observations", {})
    evidence = meta.get("diagram_evidence", {})
    diagnostics = meta.get("diagram_diagnostics", {})
    if not isinstance(evidence, dict) or not isinstance(diagnostics, dict):
        raise DiagramEvidenceError("diagram evidence and diagnostics must be objects")
    for observation_id, wrapper in evidence.items():
        if observation_id not in observations:
            raise DiagramEvidenceError("diagram evidence refers to a missing observation")
        if not isinstance(wrapper, dict) or not isinstance(wrapper.get("record"), dict):
            raise DiagramEvidenceError("diagram evidence record must be an object")
        if wrapper.get("record_sha256") != json_sha256(wrapper["record"]):
            raise DiagramEvidenceError("diagram evidence fingerprint mismatch")
        if wrapper["record"].get("observation_id") != observation_id:
            raise DiagramEvidenceError("diagram evidence observation link mismatch")
    for diagnostic_id, wrapper in diagnostics.items():
        if not isinstance(wrapper, dict) or not isinstance(wrapper.get("record"), dict):
            raise DiagramEvidenceError("diagram diagnostic record must be an object")
        digest = json_sha256(wrapper["record"])
        if wrapper.get("record_sha256") != digest or diagnostic_id != digest:
            raise DiagramEvidenceError("diagram diagnostic fingerprint mismatch")


def _load_native_page(pdf_path: Path, page_number: int):
    import diagram_reader

    try:
        return diagram_reader.load_page_image(pdf_path, page_number)
    except SystemExit as exc:
        raise RuntimeError(str(exc)) from exc


def enrich_page_result(
    candidate: dict,
    pdf_path: Path,
    page_number: int,
    *,
    image_loader=None,
    detector=None,
    page_reader=None,
) -> dict:
    """Return an enriched copy of one page result without changing source readings."""
    if type(page_number) is not int or page_number < 1:
        raise DiagramEvidenceError("page must be a positive integer")
    error = version_error(candidate)
    if error:
        raise DiagramEvidenceError(error)
    try:
        validate_observations(candidate)
    except (TypeError, ValueError) as exc:
        raise DiagramEvidenceError(str(exc)) from exc
    result = copy.deepcopy(candidate)
    eligible = _eligible_entries(result)
    if detector is None or page_reader is None:
        import diagram_reader

        detector = detector or diagram_reader.detect_diagrams
        page_reader = page_reader or diagram_reader.read_page
    image_loader = image_loader or _load_native_page
    pdf_path = Path(pdf_path)
    if not pdf_path.is_file():
        raise DiagramEvidenceError(f"PDF does not exist: {pdf_path}")
    pdf = {"name": pdf_path.name, "sha256": file_sha256(pdf_path)}

    try:
        image = image_loader(pdf_path, page_number)
        if getattr(image, "ndim", None) != 2:
            raise RuntimeError("native page image is not grayscale")
    except (IndexError, OSError, RuntimeError, ValueError) as exc:
        _add_diagnostic(
            result,
            _diagnostic(
                pdf=pdf,
                page_number=page_number,
                status="native_image_unavailable",
                message=str(exc),
                eligible=eligible,
            ),
        )
        validate_diagram_metadata(result)
        return result

    native_image = {
        "width": int(image.shape[1]),
        "height": int(image.shape[0]),
        "coordinate_space": COORDINATE_SPACE,
        "selection": "first_embedded_page_image",
    }
    try:
        boxes = detector(image)
        exact_slots = len(boxes) == len(eligible)
        names = [item["original_symbol"] for item in eligible] if exact_slots else None
        readings = page_reader(image, names)
        if not isinstance(readings, list) or any(
            not isinstance(reading, dict) or "box" not in reading for reading in readings
        ):
            raise ValueError("diagram reader returned malformed results")
    except (IndexError, RuntimeError, TypeError, ValueError) as exc:
        _add_diagnostic(
            result,
            _diagnostic(
                pdf=pdf,
                page_number=page_number,
                status="reader_error",
                message=str(exc),
                native_image=native_image,
                eligible=eligible,
            ),
        )
        validate_diagram_metadata(result)
        return result
    readable = [r for r in readings if not r.get("error") and r.get("voicing")]
    safe_pairing = exact_slots and len(readings) == len(eligible) and len(readable) == len(eligible)

    if not safe_pairing:
        _add_diagnostic(
            result,
            _diagnostic(
                pdf=pdf,
                page_number=page_number,
                status="count_mismatch" if len(boxes) != len(eligible) else "unreadable_diagram",
                message=(
                    f"detected={len(boxes)} readable={len(readable)} "
                    f"eligible_entries={len(eligible)}; no diagrams paired"
                ),
                native_image=native_image,
                diagrams=readings,
                eligible=eligible,
            ),
        )
        validate_diagram_metadata(result)
        return result

    reader = {
        "implementation_sha256": file_sha256(READER_PATH),
        "digit_templates_sha256": (
            file_sha256(DIGIT_TEMPLATES_PATH) if DIGIT_TEMPLATES_PATH.is_file() else None
        ),
    }
    evidence = result.setdefault("_meta", {}).setdefault("diagram_evidence", {})
    for diagram_index, (item, reading) in enumerate(zip(eligible, readings)):
        entry = item["entry"]
        observation_id = item["observation_id"]
        prior_printed = entry.get("voicing_printed")
        errors = []
        if prior_printed is not None and prior_printed != reading["voicing"]:
            errors.append("existing_voicing_printed_preserved")
        payload = {
            "observation_id": observation_id,
            "source_pdf": pdf,
            "page": page_number,
            "native_image": native_image,
            "crop_box": list(reading["box"]),
            "decoded_pattern": reading.get("pattern"),
            "voicing_printed": reading["voicing"],
            "base": reading.get("base"),
            "base_resolution": (
                "harmonic_symbol" if reading.get("harmonic_base") else "nut_absolute"
            ),
            "harmonic_base": bool(reading.get("harmonic_base")),
            "name_dependent": bool(reading.get("harmonic_base")),
            "original_symbol": item["original_symbol"],
            "reader": reader,
            "pairing": {
                "policy": PAIRING_POLICY,
                "basis": "page_local_visual_reading_order",
                "diagram_index": diagram_index,
                "entry_position": item["position"],
            },
            "errors": errors,
            "review_status": REVIEW_STATUS,
            "evidence_role": "proposal",
        }
        wrapper = _hashed(payload)
        previous = evidence.get(observation_id)
        if previous is not None and previous != wrapper:
            raise DiagramEvidenceError(
                f"refusing to replace diagram evidence for observation {observation_id}"
            )
        evidence[observation_id] = wrapper
        # Existing evidence/editorial data wins. A fresh CV run only fills an absent field.
        entry.setdefault("voicing_printed", reading["voicing"])

    validate_diagram_metadata(result)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Attach native-image chord-diagram evidence")
    parser.add_argument("candidate", type=Path, help="existing extracted page JSON")
    parser.add_argument("pdf", type=Path, help="source PDF")
    parser.add_argument("--page", type=int, required=True, help="1-based PDF page number")
    parser.add_argument("--output", type=Path, required=True, help="new output JSON path")
    args = parser.parse_args()

    candidate = load_document(args.candidate)
    enriched = enrich_page_result(candidate, args.pdf, args.page)
    save_document(args.output, enriched)
    print(args.output)


if __name__ == "__main__":
    main()
