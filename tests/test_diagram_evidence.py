import copy
import hashlib
import json
import sys

import diagram_evidence as evidence
import diagram_reader
import materialize_songs
import numpy as np
import pytest
import validate_extraction
from extraction_provenance import attach_observations, json_sha256
from songsheet_io import DocumentError, save_document
from songsheet_version import stamp


def candidate(*entries):
    page = {
        "document": {"title": "Album"},
        "songs": [
            {
                "title": "Song",
                "sections": [{"bars": [[copy.deepcopy(entry) for entry in entries]]}],
            }
        ],
    }
    return stamp(attach_observations(page, {"kind": "test", "page": "candidate"}))


def fake_pdf(tmp_path):
    path = tmp_path / "album.pdf"
    path.write_bytes(b"pdf evidence bytes")
    return path


def reading(box, voicing="x,3,2,0,1,0", *, pattern="MFFOOO", error=None):
    return {
        "box": box,
        "pattern": pattern,
        "voicing": voicing,
        "base": 1 if voicing else None,
        "harmonic_base": False,
        "error": error,
    }


def enrich(doc, pdf, readings, boxes=None, *, page_number=2):
    image = np.zeros((120, 80), dtype=int)
    boxes = boxes if boxes is not None else [item["box"] for item in readings]
    return evidence.enrich_page_result(
        doc,
        pdf,
        page_number,
        image_loader=lambda *_: image,
        detector=lambda _: boxes,
        page_reader=lambda _image, names: readings,
    )


def test_exact_page_local_pairing_populates_printed_voicing_and_hashed_evidence(tmp_path):
    doc = candidate({"chord": "C", "voicing": "9,9,9,9,9,9"}, {"chord": "G"})
    original = copy.deepcopy(doc)
    readings = [reading((1, 2, 30, 22)), reading((40, 2, 70, 22), "3,2,0,0,0,3")]

    enriched = enrich(doc, fake_pdf(tmp_path), readings)
    entries = enriched["songs"][0]["sections"][0]["bars"][0]
    assert entries[0]["voicing"] == "9,9,9,9,9,9"
    assert [entry["voicing_printed"] for entry in entries] == [
        "x,3,2,0,1,0",
        "3,2,0,0,0,3",
    ]
    assert doc == original
    assert enriched["_meta"]["observations"] == original["_meta"]["observations"]

    first_id = entries[0]["observation_id"]
    wrapper = enriched["_meta"]["diagram_evidence"][first_id]
    record = wrapper["record"]
    assert wrapper["record_sha256"] == json_sha256(record)
    assert record["crop_box"] == [1, 2, 30, 22]
    assert record["native_image"] == {
        "width": 80,
        "height": 120,
        "coordinate_space": evidence.COORDINATE_SPACE,
        "selection": "first_embedded_page_image",
        "sha256": hashlib.sha256(bytes(120 * 80)).hexdigest(),
    }
    assert record["original_symbol"] == "C"
    assert record["pairing"]["basis"] == "page_local_visual_reading_order"
    assert record["review_status"] == "unreviewed"
    assert record["evidence_role"] == "proposal"
    assert record["reader"]["implementation_sha256"]
    assert record["reader"]["digit_templates_sha256"]
    assert set(record["reader"]["dependencies_sha256"]) == {"harmony.py", "chord_identity.py"}
    assert record["reader"]["integration_sha256"]


def test_existing_printed_value_is_preserved_and_disagreement_is_recorded(tmp_path):
    doc = candidate({"chord": "C", "voicing_printed": "8,8,8,8,8,8"})
    result = enrich(doc, fake_pdf(tmp_path), [reading((1, 2, 3, 4))])
    entry = result["songs"][0]["sections"][0]["bars"][0][0]
    assert entry["voicing_printed"] == "8,8,8,8,8,8"
    record = result["_meta"]["diagram_evidence"][entry["observation_id"]]["record"]
    assert record["voicing_printed"] == "x,3,2,0,1,0"
    assert record["errors"] == ["existing_voicing_printed_preserved"]


def test_percent_is_eligible_only_when_source_explicitly_includes_a_voicing(tmp_path):
    doc = candidate(
        {"chord": "C"},
        {"chord": "%"},
        {"chord": "%", "voicing": "3,2,0,0,0,3"},
    )
    seen_names = []
    readings = [reading((1, 1, 2, 2)), reading((3, 1, 4, 2), "3,2,0,0,0,3")]
    result = evidence.enrich_page_result(
        doc,
        fake_pdf(tmp_path),
        1,
        image_loader=lambda *_: np.zeros((10, 10), dtype=int),
        detector=lambda _: [r["box"] for r in readings],
        page_reader=lambda _image, names: seen_names.extend(names) or readings,
    )
    assert seen_names == ["C", None]
    entries = result["songs"][0]["sections"][0]["bars"][0]
    assert "voicing_printed" not in entries[1]
    assert entries[2]["voicing_printed"] == "3,2,0,0,0,3"


def test_count_mismatch_retains_every_diagram_and_never_guesses_an_offset(tmp_path):
    doc = candidate({"chord": "C"}, {"chord": "G"})
    readings = [reading((1, 1, 2, 2)), reading((3, 1, 4, 2)), reading((5, 1, 6, 2))]
    names_seen = []
    result = evidence.enrich_page_result(
        doc,
        fake_pdf(tmp_path),
        1,
        image_loader=lambda *_: np.zeros((10, 10), dtype=int),
        detector=lambda _: [r["box"] for r in readings],
        page_reader=lambda _image, names: names_seen.append(names) or readings,
    )
    assert names_seen == [None]
    assert "diagram_evidence" not in result["_meta"]
    assert all(
        "voicing_printed" not in entry for entry in result["songs"][0]["sections"][0]["bars"][0]
    )
    diagnostic = next(iter(result["_meta"]["diagram_diagnostics"].values()))
    assert diagnostic["record"]["status"] == "count_mismatch"
    assert len(diagnostic["record"]["diagrams"]) == 3


def test_unreadable_slot_blocks_all_pairing_and_is_retained(tmp_path):
    doc = candidate({"chord": "C"}, {"chord": "G"})
    readings = [reading((1, 1, 2, 2)), reading((3, 1, 4, 2), None, error="no lines")]
    result = enrich(doc, fake_pdf(tmp_path), readings)
    diagnostic = next(iter(result["_meta"]["diagram_diagnostics"].values()))["record"]
    assert diagnostic["status"] == "unreadable_diagram"
    assert diagnostic["diagrams"][1]["error"] == "no lines"
    assert "diagram_evidence" not in result["_meta"]


def test_missing_native_image_is_a_diagnostic_and_preserves_candidate(tmp_path):
    doc = candidate({"chord": "C"})

    def missing(*_):
        raise RuntimeError("page has no embedded image")

    result = evidence.enrich_page_result(doc, fake_pdf(tmp_path), 1, image_loader=missing)
    diagnostic = next(iter(result["_meta"]["diagram_diagnostics"].values()))["record"]
    assert diagnostic["status"] == "native_image_unavailable"
    assert "no embedded image" in diagnostic["message"]
    assert result["songs"] == doc["songs"]
    assert result["_meta"]["observations"] == doc["_meta"]["observations"]


def test_reader_failure_is_a_diagnostic_and_preserves_candidate(tmp_path):
    doc = candidate({"chord": "C"})

    def broken_reader(*_):
        raise ValueError("unsupported native layout")

    result = evidence.enrich_page_result(
        doc,
        fake_pdf(tmp_path),
        1,
        image_loader=lambda *_: np.zeros((10, 10), dtype=int),
        detector=lambda _: [(1, 1, 2, 2)],
        page_reader=broken_reader,
    )
    diagnostic = next(iter(result["_meta"]["diagram_diagnostics"].values()))["record"]
    assert diagnostic["status"] == "reader_error"
    assert "unsupported native layout" in diagnostic["message"]
    assert result["songs"] == doc["songs"]


def test_malformed_reader_result_is_a_diagnostic(tmp_path):
    doc = candidate({"chord": "C"})
    result = evidence.enrich_page_result(
        doc,
        fake_pdf(tmp_path),
        1,
        image_loader=lambda *_: np.zeros((10, 10), dtype=int),
        detector=lambda _: [(1, 1, 2, 2)],
        page_reader=lambda *_: [{"voicing": "x,3,2,0,1,0"}],
    )
    diagnostic = next(iter(result["_meta"]["diagram_diagnostics"].values()))["record"]
    assert diagnostic["status"] == "reader_error"
    assert "malformed" in diagnostic["message"]


def test_invalid_page_and_future_version_are_rejected(tmp_path):
    doc = candidate({"chord": "C"})
    with pytest.raises(evidence.DiagramEvidenceError, match="positive integer"):
        evidence.enrich_page_result(doc, fake_pdf(tmp_path), 0)
    doc["schema_version"] = 999
    with pytest.raises(evidence.DiagramEvidenceError, match="newer than supported"):
        evidence.enrich_page_result(doc, fake_pdf(tmp_path), 1)


def test_diagram_metadata_round_trips_through_assembly_and_materialization(tmp_path):
    page = enrich(candidate({"chord": "C"}), fake_pdf(tmp_path), [reading((1, 2, 3, 4))])
    assembled = validate_extraction.assemble_document(
        tmp_path / "album.pdf", [page], page_numbers=[2]
    )
    song = materialize_songs.split_songs(assembled)[0]["doc"]
    observation_id = song["songs"][0]["sections"][0]["bars"][0][0]["observation_id"]
    assert (
        song["_meta"]["diagram_evidence"][observation_id]
        == page["_meta"]["diagram_evidence"][observation_id]
    )
    evidence.validate_diagram_metadata(song)


def test_diagram_pairing_uses_immutable_source_order_after_editorial_reorder(tmp_path):
    doc = candidate({"chord": "C"}, {"chord": "G"})
    doc["songs"][0]["sections"][0]["bars"][0].reverse()
    result = enrich(
        doc, fake_pdf(tmp_path), [reading((1, 2, 30, 22)), reading((40, 2, 70, 22), "3,2,0,0,0,3")]
    )
    entries = result["songs"][0]["sections"][0]["bars"][0]
    assert entries[0]["chord"] == "G"
    assert entries[0]["voicing_printed"] == "3,2,0,0,0,3"
    assert entries[1]["voicing_printed"] == "x,3,2,0,1,0"


def test_diagram_evidence_cannot_be_altered_or_removed_on_save(tmp_path):
    doc = enrich(candidate({"chord": "C"}), fake_pdf(tmp_path), [reading((1, 2, 3, 4))])
    path = tmp_path / "candidate.json"
    save_document(path, doc)
    before = path.read_bytes()
    altered = copy.deepcopy(doc)
    next(iter(altered["_meta"]["diagram_evidence"].values()))["record"]["base"] = 20
    with pytest.raises(DocumentError, match="fingerprint mismatch"):
        save_document(path, altered, overwrite=True)
    doc["_meta"].pop("diagram_evidence")
    with pytest.raises(DocumentError, match="preserved extraction evidence"):
        save_document(path, doc, overwrite=True)
    assert path.read_bytes() == before


def test_materialization_filters_diagram_evidence_by_song(tmp_path):
    pdf = fake_pdf(tmp_path)
    first = candidate({"chord": "C"})
    second = candidate({"chord": "G"})
    first["songs"][0]["title"] = "One"
    second["songs"][0]["title"] = "Two"
    first = enrich(first, pdf, [reading((1, 2, 3, 4))], page_number=2)
    second = enrich(second, pdf, [reading((1, 2, 3, 4), "3,2,0,0,0,3")], page_number=3)
    assembled = validate_extraction.assemble_document(pdf, [first, second], page_numbers=[2, 3])
    split = materialize_songs.split_songs(assembled)
    assert len(split) == 2
    left, right = (item["doc"]["_meta"]["diagram_evidence"] for item in split)
    assert len(left) == len(right) == 1
    assert left.keys().isdisjoint(right)


def test_materialization_keeps_only_relevant_page_diagnostics(tmp_path):
    pdf = fake_pdf(tmp_path)
    first, second = candidate({"chord": "C"}), candidate({"chord": "G"})
    first["songs"][0]["title"] = "One"
    second["songs"][0]["title"] = "Two"
    first = enrich(first, pdf, [], page_number=2)
    second = enrich(second, pdf, [], page_number=3)
    assembled = validate_extraction.assemble_document(pdf, [first, second], page_numbers=[2, 3])
    for item in materialize_songs.split_songs(assembled):
        doc = item["doc"]
        diagnostics = doc["_meta"]["diagram_diagnostics"]
        assert len(diagnostics) == 1
        assert next(iter(diagnostics.values()))["record"]["page"] in doc["songs"][0]["pages"]


def test_same_page_diagnostic_is_scoped_to_each_song_without_dangling_ids(tmp_path):
    doc = candidate({"chord": "C"})
    doc["songs"].append({"title": "Other", "sections": [{"bars": [[{"chord": "G"}]]}]})
    doc = stamp(attach_observations(doc, {"kind": "test-two-songs"}))
    pdf = fake_pdf(tmp_path)
    doc = enrich(doc, pdf, [])
    assembled = validate_extraction.assemble_document(pdf, [doc], page_numbers=[2])
    for item in materialize_songs.split_songs(assembled):
        meta = item["doc"]["_meta"]
        record = next(iter(meta["diagram_diagnostics"].values()))["record"]
        assert set(record["eligible_observation_ids"]) <= meta["observations"].keys()
        evidence.validate_diagram_metadata(item["doc"])


def test_assembly_rejects_diagram_diagnostic_from_a_different_page(tmp_path):
    pdf = fake_pdf(tmp_path)
    doc = enrich(candidate({"chord": "C"}), pdf, [], page_number=2)
    with pytest.raises(ValueError, match="source page"):
        validate_extraction.assemble_document(pdf, [doc], page_numbers=[3])


def test_malformed_context_with_diagrams_is_a_document_error(tmp_path):
    pdf = fake_pdf(tmp_path)
    doc = enrich(candidate({"chord": "C"}), pdf, [reading((1, 2, 3, 4))])
    doc = validate_extraction.assemble_document(pdf, [doc], page_numbers=[2])
    context_id = next(iter(doc["_meta"]["page_sources"]))
    doc["_meta"]["page_sources"][context_id] = "malformed"
    with pytest.raises(DocumentError, match="context"):
        save_document(tmp_path / "invalid.json", doc)


def test_diagnostic_with_malformed_observation_is_a_document_error(tmp_path):
    pdf = fake_pdf(tmp_path)
    doc = enrich(candidate({"chord": "C"}), pdf, [])
    observation = next(iter(doc["_meta"]["observations"].values()))
    observation.pop("source_id")
    with pytest.raises(DocumentError):
        save_document(tmp_path / "invalid.json", doc)


@pytest.mark.parametrize("missing", ["pdf_name", "pixel_hash"])
def test_incomplete_crop_record_is_rejected_before_serving(tmp_path, missing):
    doc = enrich(candidate({"chord": "C"}), fake_pdf(tmp_path), [reading((1, 2, 3, 4))])
    wrapper = next(iter(doc["_meta"]["diagram_evidence"].values()))
    if missing == "pdf_name":
        wrapper["record"]["source_pdf"].pop("name")
    else:
        wrapper["record"]["native_image"].pop("sha256")
    wrapper["record_sha256"] = json_sha256(wrapper["record"])
    with pytest.raises(DocumentError):
        save_document(tmp_path / "invalid.json", doc)


def test_validate_pdf_can_disable_diagram_enrichment(tmp_path, monkeypatch):
    pdf = fake_pdf(tmp_path)
    png = tmp_path / "page-001.png"
    png.write_bytes(b"png")
    (tmp_path / "work" / "album").mkdir(parents=True)
    doc = candidate({"chord": "C", "text": "word"})
    monkeypatch.setattr(validate_extraction, "render_pages", lambda *_: [png])
    monkeypatch.setattr(validate_extraction, "parse_page", lambda *_: doc)
    monkeypatch.setattr(
        validate_extraction.diagram_evidence,
        "enrich_page_result",
        lambda *_: pytest.fail("diagram enrichment should be disabled"),
    )
    report = validate_extraction.validate_pdf(pdf, tmp_path / "work", 200, False, diagrams=False)
    assert report["diagram_diagnostics"] == []
    assert report["diagrams_enabled"] is False
    assert report["diagram_status"] == "disabled"


def test_validate_pdf_reports_diagram_worklist_as_an_issue(tmp_path, monkeypatch):
    pdf = fake_pdf(tmp_path)
    png = tmp_path / "page-001.png"
    png.write_bytes(b"png")
    (tmp_path / "work" / "album").mkdir(parents=True)
    doc = candidate({"chord": "C", "text": "word"})
    monkeypatch.setattr(validate_extraction, "render_pages", lambda *_: [png])
    monkeypatch.setattr(validate_extraction, "parse_page", lambda *_: doc)
    monkeypatch.setattr(
        validate_extraction.diagram_evidence,
        "enrich_page_result",
        lambda result, source, page: evidence.record_page_failure(
            result, source, page, "count_mismatch", "detected=2 eligible_entries=1"
        ),
    )
    report = validate_extraction.validate_pdf(pdf, tmp_path / "work", 200, False)
    assert report["passed"] is False
    assert report["diagram_diagnostics"][0]["record"]["status"] == "count_mismatch"


def test_offline_cli_writes_create_only_and_keeps_input_unchanged(tmp_path, monkeypatch):
    source = tmp_path / "page.json"
    source.write_text(json.dumps(candidate({"chord": "C"})))
    before = source.read_bytes()
    pdf = fake_pdf(tmp_path)
    output = tmp_path / "enriched.json"
    monkeypatch.setattr(evidence, "_load_native_page", lambda *_: np.zeros((10, 10), dtype=int))
    monkeypatch.setattr(diagram_reader, "detect_diagrams", lambda _: [(1, 1, 2, 2)])
    monkeypatch.setattr(
        diagram_reader,
        "read_page",
        lambda _image, _names: [reading((1, 1, 2, 2))],
    )
    monkeypatch.setattr(
        sys,
        "argv",
        ["diagram_evidence", str(source), str(pdf), "--page", "1", "--output", str(output)],
    )
    evidence.main()
    assert source.read_bytes() == before
    assert (
        json.loads(output.read_text())["songs"][0]["sections"][0]["bars"][0][0]["voicing_printed"]
        == "x,3,2,0,1,0"
    )
    with pytest.raises(FileExistsError):
        evidence.main()
