import copy
import json

import pytest
from review_state import (
    REVIEW_FIELDS,
    field_fingerprint,
    record_review,
    review_summary,
)


def _doc():
    return {
        "document": {"title": "Album", "status": "done"},
        "songs": [
            {
                "title": "Song",
                "key": "Dm",
                "sections": [
                    {
                        "label": "A",
                        "bars": [
                            [
                                {
                                    "chord": "Dm7",
                                    "text": "Vai",
                                    "voicing": "x,5,7,5,6,x",
                                    "voicing_printed": "x,5,7,5,6,5",
                                    "observation_id": "reading-1",
                                }
                            ]
                        ],
                    }
                ],
            }
        ],
        "_meta": {
            "source_pdf": "book.pdf",
            "extraction_sources": {"source": {"provider": "test"}},
            "observations": {"reading-1": {"value": {"chord": "Dm7"}}},
        },
    }


def test_legacy_done_document_does_not_claim_field_verification():
    summary = review_summary(_doc())
    assert tuple(summary["fields"]) == REVIEW_FIELDS
    assert {item["status"] for item in summary["fields"].values()} == {"pending"}


def test_verified_field_becomes_stale_only_for_its_relevant_values():
    reviewed = record_review(_doc(), "chords", "verified", "AS", "checked scan")
    assert review_summary(reviewed)["fields"]["chords"]["status"] == "verified"

    irrelevant = copy.deepcopy(reviewed)
    irrelevant["songs"][0]["sections"][0]["bars"][0][0]["text"] = "Vem"
    irrelevant["songs"][0]["note"] = "editorial note"
    assert review_summary(irrelevant)["fields"]["chords"]["status"] == "verified"

    changed = copy.deepcopy(reviewed)
    changed["songs"][0]["sections"][0]["bars"][0][0]["chord"] = "Am7"
    assert review_summary(changed)["fields"]["chords"]["status"] == "stale"


def test_structural_positions_are_part_of_each_entry_field_fingerprint():
    doc = _doc()
    before = field_fingerprint(doc, "lyrics")
    doc["songs"][0]["sections"][0]["bars"].insert(0, [])
    assert field_fingerprint(doc, "lyrics") != before


def test_empty_structural_addition_changes_every_field_fingerprint():
    doc = _doc()
    before = {field: field_fingerprint(doc, field) for field in REVIEW_FIELDS}
    doc["songs"][0]["sections"][0]["bars"].append([])
    after = {field: field_fingerprint(doc, field) for field in REVIEW_FIELDS}
    assert all(before[field] != after[field] for field in REVIEW_FIELDS)


def test_each_canonical_value_affects_only_its_field():
    doc = _doc()
    before = {field: field_fingerprint(doc, field) for field in REVIEW_FIELDS}
    doc["songs"][0]["sections"][0]["bars"][0][0]["voicing_printed"] = "x,5,7,5,6,x"
    after = {field: field_fingerprint(doc, field) for field in REVIEW_FIELDS}
    assert {field for field in REVIEW_FIELDS if before[field] != after[field]} == {
        "voicing_printed"
    }


def test_section_label_change_affects_only_structure():
    doc = _doc()
    before = {field: field_fingerprint(doc, field) for field in REVIEW_FIELDS}
    doc["songs"][0]["sections"][0]["label"] = "Verse"
    after = {field: field_fingerprint(doc, field) for field in REVIEW_FIELDS}
    assert {field for field in REVIEW_FIELDS if before[field] != after[field]} == {"structure"}


@pytest.mark.parametrize("key", [None, "", "H", "C dorian"])
def test_verified_key_refuses_missing_or_unsupported_stored_key(key):
    doc = _doc()
    doc["songs"][0]["key"] = key
    with pytest.raises(ValueError, match="valid nonempty stored key"):
        record_review(doc, "key", "verified", "AS", "checked printed key")


@pytest.mark.parametrize("key", ["C", "F#", "Bbm", "A minor"])
def test_verified_key_accepts_existing_harmony_major_and_minor_names(key):
    doc = _doc()
    doc["songs"][0]["key"] = key
    reviewed = record_review(doc, "key", "verified", "AS", "checked score")
    assert review_summary(reviewed)["fields"]["key"]["status"] == "verified"


def test_verified_requires_attributed_evidence_and_invalid_inputs_are_rejected():
    with pytest.raises(ValueError, match="nonblank"):
        record_review(_doc(), "lyrics", "verified", "", "checked scan")
    with pytest.raises(ValueError, match="nonblank"):
        record_review(_doc(), "lyrics", "verified", "AS", "  ")
    with pytest.raises(ValueError, match="unknown review field"):
        record_review(_doc(), "tempo", "pending")
    with pytest.raises(ValueError, match="unknown review status"):
        record_review(_doc(), "lyrics", "done")


def test_malformed_or_dangling_metadata_never_reports_verified():
    malformed = _doc()
    malformed["_meta"]["review"] = {"version": 1, "fields": {"tempo": {}}}
    assert {item["status"] for item in review_summary(malformed)["fields"].values()} == {"invalid"}

    dangling = record_review(_doc(), "lyrics", "verified", "AS", "checked scan")
    del dangling["_meta"]["review"]["fields"]["lyrics"]["fingerprint"]
    assert review_summary(dangling)["fields"]["lyrics"]["status"] == "invalid"


@pytest.mark.parametrize("version", [True, 1.0])
def test_non_integer_review_version_is_invalid_and_cannot_be_extended(version):
    doc = _doc()
    doc["_meta"]["review"] = {"version": version, "fields": {}}
    assert {item["status"] for item in review_summary(doc)["fields"].values()} == {"invalid"}
    with pytest.raises(ValueError, match="existing review metadata is malformed"):
        record_review(doc, "lyrics", "pending")


def test_record_review_returns_copy_and_preserves_source_observations_exactly():
    doc = _doc()
    source_meta = json.dumps(doc["_meta"], ensure_ascii=False, separators=(",", ":"))
    reviewed = record_review(doc, "lyrics", "in_progress", "AS", "page 1")

    assert "review" not in doc["_meta"]
    assert reviewed is not doc
    assert reviewed["songs"] is not doc["songs"]
    for key in ("source_pdf", "extraction_sources", "observations"):
        assert reviewed["_meta"][key] == doc["_meta"][key]
    without_review = dict(reviewed["_meta"])
    del without_review["review"]
    assert json.dumps(without_review, ensure_ascii=False, separators=(",", ":")) == source_meta
