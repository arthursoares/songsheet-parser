import copy
import json
import os
import sys
from types import SimpleNamespace

import eval_extraction
import fitz
import json_to_chordmark
import materialize_songs as materialize
import parse_songsheet as parser
import pytest
import validate_extraction as extraction
from songsheet_io import DocumentError, save_document


def page(title="Song", chord="C"):
    return {
        "document": {"title": "Album"},
        "songs": [{"title": title, "sections": [{"bars": [[{"chord": chord}]]}]}],
        "_meta": {"source": "page.png", "model": "test/model", "parsed_at": "test-time"},
    }


def test_page_evidence_survives_assembly_and_materialization(tmp_path):
    pages = [page(chord="C"), page(chord="G")]
    originals = copy.deepcopy(pages)
    assembled = extraction.assemble_document(tmp_path / "Album.pdf", pages)
    doc = materialize.split_songs(assembled)[0]["doc"]
    entries = [e for s in doc["songs"][0]["sections"] for b in s["bars"] for e in b]
    ids = [e["observation_id"] for e in entries]
    assert len(set(ids)) == 2
    assert [doc["_meta"]["observations"][i]["value"]["chord"] for i in ids] == ["C", "G"]
    assert {s["page"] for s in doc["_meta"]["page_sources"].values()} == {1, 2}
    entries[0]["chord"] = "Am"
    assert doc["_meta"]["observations"][ids[0]]["value"]["chord"] == "C"
    assert pages == originals


def test_editorial_save_preserves_evidence_and_rejects_source_mutation(tmp_path):
    doc = extraction.assemble_document(tmp_path / "Album.pdf", [page()])
    entry = doc["songs"][0]["sections"][0]["bars"][0][0]
    entry["chord"] = "Am"
    target = tmp_path / "song.json"
    save_document(target, doc)
    before = target.read_bytes()
    doc["_meta"]["observations"][entry["observation_id"]]["value"]["chord"] = "Am"
    with pytest.raises(DocumentError, match="fingerprint mismatch"):
        save_document(target, doc, overwrite=True)
    assert target.read_bytes() == before


def test_materialization_keeps_only_that_songs_evidence(tmp_path):
    assembled = extraction.assemble_document(tmp_path / "Album.pdf", [page("One"), page("Two")])
    first, second = materialize.split_songs(assembled)
    first_meta, second_meta = first["doc"]["_meta"], second["doc"]["_meta"]
    assert len(first_meta["observations"]) == len(second_meta["observations"]) == 1
    assert first_meta["observations"].keys().isdisjoint(second_meta["observations"])
    assert first_meta["page_sources"] != second_meta["page_sources"]


def test_render_cache_is_invalidated_by_dpi_and_pdf_content(tmp_path):
    pdf = tmp_path / "test.pdf"
    with fitz.open() as document:
        document.new_page(width=72, height=72)
        document.save(pdf)
    out = tmp_path / "out"
    first = extraction.render_pages(pdf, out, 72, False)[0]
    before = first.read_bytes()
    extraction.render_pages(pdf, out, 144, False)
    assert first.read_bytes() != before
    with fitz.open() as document:
        document.new_page(width=144, height=72)
        document.save(pdf)
    extraction.render_pages(pdf, out, 144, False)
    assert fitz.Pixmap(first).width == 288


def test_parse_cache_tracks_image_and_prompt_and_preserves_snapshots(tmp_path, monkeypatch):
    png = tmp_path / "page-001.png"
    png.write_bytes(b"first image")
    out = tmp_path / "out"
    out.mkdir()
    calls = []

    def fake_parse(image_path, model):
        calls.append((image_path.read_bytes(), parser.PARSE_PROMPT, model))
        return page()

    monkeypatch.setattr(parser, "parse_with_codex", fake_parse)
    first = extraction.parse_page(png, out, False)
    extraction.parse_page(png, out, False)
    assert len(calls) == 1
    png.write_bytes(b"second image")
    extraction.parse_page(png, out, False)
    monkeypatch.setattr(parser, "PARSE_PROMPT", parser.PARSE_PROMPT + "\nChanged prompt")
    last = extraction.parse_page(png, out, False)
    assert len(calls) == 3
    assert first["_meta"]["extraction"] != last["_meta"]["extraction"]
    snapshots = list((out / "extractions").glob("*.snapshot"))
    assert len(snapshots) == 3
    assert any(json.loads(p.read_text()) == first for p in snapshots)


def test_cache_rejects_edited_results_and_force_keeps_previous_snapshot(tmp_path, monkeypatch):
    png = tmp_path / "page.png"
    png.write_bytes(b"image")
    calls = []
    monkeypatch.setattr(parser, "parse_with_codex", lambda *_: calls.append(1) or page())
    out = tmp_path / "out"
    extraction.parse_page(png, out, False)
    cache = out / "page.json"
    modified = json.loads(cache.read_text())
    modified["songs"][0]["title"] = "Changed"
    cache.write_text(json.dumps(modified))
    assert extraction.parse_page(png, out, False)["songs"][0]["title"] == "Song"
    extraction.parse_page(png, out, True)
    assert len(calls) == 3
    assert len(list((out / "extractions").glob("*.snapshot"))) == 3
    assert [p for p, _ in json_to_chordmark.collect_json_files([out])] == [cache]


def test_selected_page_numbers_are_preserved(tmp_path):
    doc = extraction.assemble_document(
        tmp_path / "Album.pdf", [page(), page()], page_numbers=[8, 9]
    )
    assert doc["songs"][0]["pages"] == [8, 9]
    assert {p["page"] for p in doc["_meta"]["page_sources"].values()} == {8, 9}


@pytest.mark.parametrize("field", ["page", "pdf", "remove_context"])
def test_source_context_mutations_are_rejected(tmp_path, field):
    doc = extraction.assemble_document(tmp_path / "Album.pdf", [page()])
    context_id = next(iter(doc["_meta"]["page_sources"]))
    if field == "page":
        doc["_meta"]["page_sources"][context_id]["page"] = 999
    elif field == "pdf":
        doc["_meta"]["source_pdf"]["sha256"] = "invented"
    else:
        doc["_meta"]["page_sources"].pop(context_id)
    with pytest.raises(DocumentError):
        save_document(tmp_path / "song.json", doc)


def test_save_cannot_erase_previously_persisted_evidence(tmp_path):
    doc = extraction.assemble_document(tmp_path / "Album.pdf", [page()])
    target = tmp_path / "song.json"
    save_document(target, doc)
    before = target.read_bytes()
    doc.pop("_meta")
    doc["songs"][0]["sections"][0]["bars"][0][0].pop("observation_id")
    with pytest.raises(DocumentError, match="preserved"):
        save_document(target, doc, overwrite=True)
    assert target.read_bytes() == before


def test_damaged_provenance_is_not_relabelled_as_legacy(tmp_path):
    doc = extraction.assemble_document(tmp_path / "Album.pdf", [page()])
    doc["_meta"]["observations"].clear()
    with pytest.raises(ValueError, match="missing observation"):
        extraction.assemble_document(tmp_path / "Album.pdf", [doc])


def test_direct_cli_preserves_snapshots_and_failed_alias_keeps_previous_result(
    tmp_path, monkeypatch
):
    png = tmp_path / "page.png"
    png.write_bytes(b"image")
    out = tmp_path / "out"
    monkeypatch.setattr(parser, "parse_with_codex", lambda *_: page())
    monkeypatch.setattr(sys, "argv", ["parse_songsheet", str(png), "--output", str(out), "--force"])
    parser.main()
    before = (out / "page.json").read_bytes()

    def fail_replace(*_):
        raise OSError("simulated alias failure")

    monkeypatch.setattr(os, "replace", fail_replace)
    parser.main()
    assert (out / "page.json").read_bytes() == before
    assert len(list((out / "extractions").glob("*.snapshot"))) == 2


def test_materialize_preflights_later_evidence_conflict(tmp_path):
    work = tmp_path / "work" / "Album"
    work.mkdir(parents=True)
    fresh = page("One")
    fresh["songs"].append(page("Two")["songs"][0])
    source = work / "_assembled.json"
    source.write_text(json.dumps(fresh))
    out = tmp_path / "songs"
    album = out / "album"
    album.mkdir(parents=True)
    first = album / "01-one.json"
    reviewed = page("One")
    reviewed["songs"][0]["note"] = "KEEP"
    first.write_text(json.dumps(reviewed))
    before = first.read_bytes()
    save_document(
        album / "02-two.json", extraction.assemble_document(tmp_path / "Album.pdf", [page("Two")])
    )
    with pytest.raises(ValueError, match="preserved"):
        materialize.materialize_one(source, out, overwrite=True)
    assert first.read_bytes() == before


def test_reparse_cli_invalidates_model_cache_and_keeps_actual_page_numbers(tmp_path, monkeypatch):
    golden = tmp_path / "song.json"
    golden.write_text(json.dumps(page()))
    scans = tmp_path / "pages"
    scans.mkdir()
    (scans / "song-p8.png").write_bytes(b"image")
    calls = []
    monkeypatch.setattr(
        parser, "parse_with_codex", lambda _image, model: calls.append(model) or page()
    )
    args = SimpleNamespace(
        golden=golden,
        workdir=tmp_path / "work",
        force=False,
        provider="codex",
        model="model-one",
        show_diff=False,
        report_json=None,
    )
    assert eval_extraction.cmd_reparse(args) == 0
    assert eval_extraction.cmd_reparse(args) == 0
    args.model = "model-two"
    assert eval_extraction.cmd_reparse(args) == 0
    assert calls == ["model-one", "model-two"]
    candidate = json.loads((args.workdir / "song" / "_candidate.json").read_text())
    assert candidate["songs"][0]["pages"] == [8]
