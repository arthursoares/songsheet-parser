import copy
import json
import sys

import diagram_evidence as evidence
import diagram_reader
import materialize_songs
import numpy as np
import pytest
import validate_extraction
from extraction_provenance import attach_observations, json_sha256
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


def enrich(doc, pdf, readings, boxes=None):
    image = np.zeros((120, 80), dtype=int)
    boxes = boxes if boxes is not None else [item["box"] for item in readings]
    return evidence.enrich_page_result(
        doc,
        pdf,
        2,
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
    }
    assert record["original_symbol"] == "C"
    assert record["pairing"]["basis"] == "page_local_visual_reading_order"
    assert record["review_status"] == "unreviewed"
    assert record["evidence_role"] == "proposal"
    assert record["reader"]["implementation_sha256"]
    assert record["reader"]["digit_templates_sha256"]


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
    assert seen_names == ["C", "%"]
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
    assembled = validate_extraction.assemble_document(tmp_path / "album.pdf", [page])
    song = materialize_songs.split_songs(assembled)[0]["doc"]
    observation_id = song["songs"][0]["sections"][0]["bars"][0][0]["observation_id"]
    assert (
        song["_meta"]["diagram_evidence"][observation_id]
        == page["_meta"]["diagram_evidence"][observation_id]
    )
    evidence.validate_diagram_metadata(song)


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
