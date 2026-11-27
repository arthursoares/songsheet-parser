import hashlib
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import qa_shapes as shapes
from extraction_provenance import file_sha256


def _document(entries, *, pages=(1,), title="Song"):
    return {
        "schema_version": 3,
        "document": {"title": "Album", "source_pdf": "album.pdf"},
        "songs": [
            {
                "title": title,
                "pages": list(pages),
                "sections": [{"label": None, "bars": [[entry] for entry in entries]}],
            }
        ],
    }


def _decoded(pattern="MFFFFM", columns=(None, 0, 2, 0, 1, None), *, nut=True):
    return {
        "pattern": pattern,
        "dot_cols": list(columns),
        "nut": nut,
        "digit_bitmap": None,
        "digit_col": None,
    }


def test_groups_identical_shapes_across_labels_and_keeps_copies_separate(tmp_path, monkeypatch):
    songs = tmp_path / "songs"
    album = songs / "1-album"
    album.mkdir(parents=True)
    pdfs = tmp_path / "pdfs"
    pdfs.mkdir()
    pdf = pdfs / "album.pdf"
    pdf.write_bytes(b"pdf")
    for filename, label in (("01-song.json", "Dm7"), ("01-qa-song.json", "F6")):
        entry = {"chord": label, "voicing": "x,1,3,1,2,x", "voicing_printed": "x,1,3,1,2,x"}
        (album / filename).write_text(json.dumps(_document([entry])))

    monkeypatch.setattr(shapes.audit_voicings, "pdf_for_album", lambda *_: pdf)
    monkeypatch.setattr(
        shapes._SourceReader,
        "diagrams",
        lambda *_: [{"box": [1, 2, 9, 12], "decoded": _decoded(), "error": None}],
    )

    result = shapes.build_shape_index(songs, pdfs, tmp_path / "cache")

    assert result["counts"]["groups"] == 1
    assert result["counts"]["occurrences"] == 2
    group = result["groups"][0]
    assert group["voicing"] == "x,1,3,1,2,x" and group["base"] == 1
    assert {item["label"] for item in group["occurrences"]} == {"Dm7", "F6"}
    assert {item["file"] for item in group["occurrences"]} == {
        "01-song.json",
        "01-qa-song.json",
    }
    assert len({item["id"] for item in group["occurrences"]}) == 2


def test_shape_separates_dot_columns_and_unresolved_base_is_not_editable(tmp_path, monkeypatch):
    songs = tmp_path / "songs"
    album = songs / "1-album"
    album.mkdir(parents=True)
    pdfs = tmp_path / "pdfs"
    pdfs.mkdir()
    pdf = pdfs / "album.pdf"
    pdf.write_bytes(b"pdf")
    entries = [
        {"chord": "A", "voicing": "x,2,4,2,3,x", "voicing_printed": "x,2,4,2,3,x"},
        {"chord": "A", "voicing": "x,2,3,2,4,x", "voicing_printed": "x,2,3,2,4,x"},
    ]
    (album / "song.json").write_text(json.dumps(_document(entries)))
    first = _decoded(nut=False)
    second = _decoded(columns=(None, 0, 1, 0, 2, None), nut=False)
    monkeypatch.setattr(shapes.audit_voicings, "pdf_for_album", lambda *_: pdf)
    monkeypatch.setattr(
        shapes._SourceReader,
        "diagrams",
        lambda *_: [
            {"box": [1, 2, 9, 12], "decoded": first, "error": None},
            {"box": [11, 2, 19, 12], "decoded": second, "error": None},
        ],
    )

    result = shapes.build_shape_index(songs, pdfs, tmp_path / "cache")

    assert len(result["groups"]) == 2
    assert {tuple(group["columns"]) for group in result["groups"]} == {
        (None, 0, 2, 0, 1, None),
        (None, 0, 1, 0, 2, None),
    }
    assert all(group["base"] is None and group["voicing"] is None for group in result["groups"])
    assert result["counts"]["unresolved"] == 2
    assert all(not group["occurrences"][0]["editable"] for group in result["groups"])


def test_visual_digit_fixes_base_without_a_chord_label(monkeypatch):
    decoded = _decoded(nut=False)
    decoded["digit_bitmap"] = [[1]]
    decoded["digit_col"] = 2
    monkeypatch.setattr(shapes, "load_digit_templates", lambda: {"7": [[[1]]]})

    shape = shapes._visual_shape(decoded)

    assert shape["base"] == 5
    assert shape["voicing"] == "x,5,7,5,6,x"
    assert shape["editable"] is True


def test_legacy_requires_exact_count_and_matching_printed_voicing(tmp_path, monkeypatch):
    songs = tmp_path / "songs"
    album = songs / "1-album"
    album.mkdir(parents=True)
    pdfs = tmp_path / "pdfs"
    pdfs.mkdir()
    pdf = pdfs / "album.pdf"
    pdf.write_bytes(b"pdf")
    entries = [{"chord": "Dm7", "voicing": "x,1,3,1,2,x", "voicing_printed": "x,1,3,1,2,x"}]
    (album / "good.json").write_text(json.dumps(_document(entries)))
    bad = [{"chord": "Dm7", "voicing": "x,1,3,1,2,x", "voicing_printed": "x,1,3,1,3,x"}]
    (album / "bad.json").write_text(json.dumps(_document(bad)))
    monkeypatch.setattr(shapes.audit_voicings, "pdf_for_album", lambda *_: pdf)
    monkeypatch.setattr(
        shapes._SourceReader,
        "diagrams",
        lambda *_: [{"box": [1, 2, 9, 12], "decoded": _decoded(), "error": None}],
    )

    result = shapes.build_shape_index(songs, pdfs, tmp_path / "cache")

    assert result["counts"]["occurrences"] == 1
    assert result["groups"][0]["occurrences"][0]["file"] == "good.json"


def test_recorded_evidence_verifies_pdf_and_native_raster(tmp_path, monkeypatch):
    songs = tmp_path / "songs"
    album = songs / "1-album"
    album.mkdir(parents=True)
    pdfs = tmp_path / "pdfs"
    pdfs.mkdir()
    pdf = pdfs / "source.pdf"
    pdf.write_bytes(b"pdf")
    page = np.zeros((30, 40), dtype=int)
    observation_id = "a" * 64
    entry = {
        "chord": "Wrong label on purpose",
        "voicing": "x,1,3,1,2,x",
        "voicing_printed": "x,1,3,1,2,x",
        "observation_id": observation_id,
    }
    doc = _document([entry])
    doc["_meta"] = {
        "diagram_evidence": {
            observation_id: {
                "record": {
                    "observation_id": observation_id,
                    "source_pdf": {"name": pdf.name, "sha256": file_sha256(pdf)},
                    "page": 1,
                    "native_image": {
                        "width": 40,
                        "height": 30,
                        "sha256": hashlib.sha256(page.astype("uint8").tobytes()).hexdigest(),
                    },
                    "crop_box": [1, 2, 9, 12],
                    "decoded_pattern": "MFFFFM",
                    "voicing_printed": entry["voicing_printed"],
                }
            }
        }
    }
    path = album / "song.json"
    path.write_text(json.dumps(doc))
    monkeypatch.setattr(shapes, "load_document", lambda _path: doc)
    monkeypatch.setattr(shapes, "load_page_image", lambda *_: page)
    monkeypatch.setattr(shapes, "decode_diagram", lambda *_: (_decoded(), None))

    result = shapes.build_shape_index(songs, pdfs, tmp_path / "cache")

    occurrence = result["groups"][0]["occurrences"][0]
    assert occurrence["basis"] == shapes.RECORDED_BASIS
    assert occurrence["observation_id"] == observation_id
    assert occurrence["pdf_sha256"] == file_sha256(pdf)
    assert occurrence["box"] == [1, 2, 9, 12]

    doc["_meta"]["diagram_evidence"][observation_id]["record"]["native_image"]["sha256"] = "0" * 64
    assert shapes.build_shape_index(songs, pdfs, tmp_path / "cache")["groups"] == []


def test_occurrence_id_is_revision_bound_while_group_id_is_shape_bound():
    shape = shapes._visual_shape(_decoded())
    common = {
        "album": "1-album",
        "song_file": Path("song.json"),
        "song": {"title": "Song"},
        "song_index": 0,
        "position": (0, 0, 0),
        "entry": {"chord": "Dm7"},
        "pdf": Path("album.pdf"),
        "pdf_sha": "p" * 64,
        "page": 1,
        "box": [1, 2, 9, 12],
        "basis": shapes.LEGACY_BASIS,
        "editable": True,
    }

    first = shapes._occurrence(document_sha="a" * 64, **common)
    second = shapes._occurrence(document_sha="b" * 64, **common)

    assert first["id"] != second["id"]
    assert shapes._shape_id(shape) == shapes._shape_id(shape | {"editable": False})


def _rematch_fixture(tmp_path, monkeypatch, *, recorded=False, alternate_count=1, claimed=False):
    from extraction_provenance import attach_observations, json_sha256
    from songsheet_io import save_document

    songs, pdfs = tmp_path / "songs", tmp_path / "pdfs"
    pdfs.mkdir()
    path = songs / "album" / "song.json"
    path.parent.mkdir(parents=True)
    pdf = pdfs / "album.pdf"
    pdf.write_bytes(b"source PDF")
    original = _decoded(nut=False)
    alternate = _decoded(pattern="OMFFFM", columns=(None, None, 1, 1, 0, None))
    target = shapes._visual_shape(alternate)["voicing"]
    entries = [{"chord": "Em", "voicing": target, "voicing_printed": "x,2,4,2,3,x"}]
    # Extra chart entries retain exact legacy count, but do not falsely claim
    # alternative crops. One variant deliberately claims the replacement.
    for i in range(alternate_count):
        entries.append(
            {
                "chord": "Em",
                "voicing": target,
                "voicing_printed": target if claimed and i == 0 else "x,9,9,9,9,x",
            }
        )
    doc = _document(entries)
    page = np.zeros((40, 100), dtype=int)
    raw = [{"box": [1, 2, 9, 12], "decoded": original, "error": None}]
    raw.extend(
        {"box": [11 + i * 10, 2, 19 + i * 10, 12], "decoded": alternate, "error": None}
        for i in range(alternate_count)
    )
    if recorded:
        doc = attach_observations(doc, {"kind": "rematch-test"})
        entry = doc["songs"][0]["sections"][0]["bars"][0][0]
        record = {
            "observation_id": entry["observation_id"],
            "source_pdf": {"name": pdf.name, "sha256": file_sha256(pdf)},
            "page": 1,
            "native_image": {
                "width": 100,
                "height": 40,
                "sha256": hashlib.sha256(page.astype("uint8").tobytes()).hexdigest(),
            },
            "crop_box": raw[0]["box"],
            "voicing_printed": entry["voicing_printed"],
            "original_symbol": "Em",
        }
        doc["_meta"]["diagram_evidence"] = {
            entry["observation_id"]: {"record": record, "record_sha256": json_sha256(record)}
        }
    save_document(path, doc)
    monkeypatch.setattr(shapes.audit_voicings, "pdf_for_album", lambda *_: pdf)
    monkeypatch.setattr(shapes._SourceReader, "diagrams", lambda *_: raw)
    monkeypatch.setattr(shapes._SourceReader, "page", lambda *_: page)
    monkeypatch.setattr(shapes, "decode_diagram", lambda *_: (original, None))

    def index():
        return shapes.build_shape_index(songs, pdfs, tmp_path / "cache")

    return songs, path, pdf, raw, index


def test_exclusion_rematches_refreshes_and_undo_restores_legacy_pairing(tmp_path, monkeypatch):
    from qa_shape_edits import exclude_shape_batch, undo_shape_batch
    from songsheet_io import load_document

    songs, path, _, _, index = _rematch_fixture(tmp_path, monkeypatch)
    before = path.read_bytes()
    group = index()["groups"][0]
    row = group["occurrences"][0]
    result = exclude_shape_batch(songs, tmp_path / "history", group, [row["id"]])
    rebuilt = index()
    assert rebuilt["counts"]["occurrences"] == rebuilt["counts"]["editable"] == 1
    assert rebuilt["counts"]["unresolved"] == 0
    replacement_group = rebuilt["groups"][0]
    replacement = replacement_group["occurrences"][0]
    assert replacement_group["id"] != group["id"]
    assert replacement["basis"] == "rematched_evidence"
    assert replacement["box"] == [11, 2, 19, 12]
    assert replacement["printed"] == replacement["editorial"] == replacement_group["voicing"]
    assert replacement["source_evidence"]["printed"] == row["printed"]
    doc = load_document(path)
    entry = doc["songs"][0]["sections"][0]["bars"][0][0]
    entry.pop("shape_exclusion")
    assert doc == json.loads(before)
    assert index() == rebuilt
    undo_shape_batch(songs, tmp_path / "history", result["batch_id"])
    assert path.read_bytes() == before
    assert index()["groups"][0]["id"] == group["id"]


def test_recorded_rematch_keeps_evidence_and_snapshot_and_repeated_exclusion_stays_removed(
    tmp_path, monkeypatch
):
    from qa_shape_edits import apply_shape_batch, exclude_shape_batch, undo_shape_batch
    from songsheet_io import load_document, save_document

    songs, path, _, _, index = _rematch_fixture(tmp_path, monkeypatch, recorded=True)
    original = load_document(path)
    group = index()["groups"][0]
    exclude_shape_batch(songs, tmp_path / "history", group, [group["occurrences"][0]["id"]])
    replacement = index()["groups"][0]
    row = replacement["occurrences"][0]
    # Applying to a rematched crop validates original recorded evidence without
    # pretending that the alternate printed voicing was in that record.
    apply_shape_batch(songs, tmp_path / "history", replacement, [row["id"]], chord="Em7")
    assert load_document(path)["_meta"] == original["_meta"]
    doc = load_document(path)
    doc["songs"][0]["sections"][0]["bars"][0][0]["voicing"] = "0,2,2,0,0,0"
    save_document(path, doc, overwrite=True)
    replacement = index()["groups"][0]
    assert replacement["occurrences"][0]["basis"] == "rematched_evidence"
    before_second = path.read_bytes()
    result = exclude_shape_batch(
        songs, tmp_path / "history", replacement, [replacement["occurrences"][0]["id"]]
    )
    assert index()["groups"] == []
    assert index()["counts"]["occurrences"] == 0
    entry = load_document(path)["songs"][0]["sections"][0]["bars"][0][0]
    assert len(entry["shape_exclusion"]["rejected"]) == 2
    assert load_document(path)["_meta"] == original["_meta"]
    undo_shape_batch(songs, tmp_path / "history", result["batch_id"])
    assert path.read_bytes() == before_second
    assert index()["groups"][0]["id"] == replacement["id"]


def test_exclusion_does_not_choose_ambiguous_or_claimed_crop(tmp_path, monkeypatch):
    from qa_shape_edits import exclude_shape_batch

    for name, count, claimed in (("ambiguous", 2, False), ("claimed", 1, True)):
        root = tmp_path / name
        root.mkdir()
        songs, _, _, _, index = _rematch_fixture(
            root, monkeypatch, alternate_count=count, claimed=claimed
        )
        result = index()
        group = next(group for group in result["groups"] if group["voicing"] is None)
        exclude_shape_batch(songs, root / "history", group, [group["occurrences"][0]["id"]])
        rebuilt = index()
        assert all(row["bi"] != 0 for group in rebuilt["groups"] for row in group["occurrences"])
        assert rebuilt["counts"]["occurrences"] == int(claimed)


def test_exclusion_is_bound_to_pdf_revision_and_stale_id_cannot_move(tmp_path, monkeypatch):
    import pytest
    from qa_shape_edits import ShapeEditError, exclude_shape_batch

    songs, _, pdf, _, index = _rematch_fixture(tmp_path, monkeypatch)
    group = index()["groups"][0]
    old_id = group["occurrences"][0]["id"]
    exclude_shape_batch(songs, tmp_path / "history", group, [old_id])
    pdf.write_bytes(b"new source revision")
    rebuilt = index()["groups"][0]
    assert rebuilt["id"] == group["id"]  # Old rejection does not hide new source evidence.
    assert rebuilt["occurrences"][0]["id"] != old_id
    with pytest.raises(ShapeEditError, match="not in this shape group"):
        exclude_shape_batch(songs, tmp_path / "history", rebuilt, [old_id])


def test_rematch_obeys_neighbor_order_and_does_not_assign_competing_crop(tmp_path, monkeypatch):
    from qa_shape_edits import exclude_shape_batch
    from songsheet_io import load_document, save_document

    songs, path, _, raw, index = _rematch_fixture(tmp_path, monkeypatch, alternate_count=2)
    doc = load_document(path)
    entries = doc["songs"][0]["sections"][0]["bars"]
    # Keep a verified neighbor between the removed entry and the only alternate.
    raw[1]["decoded"] = _decoded(columns=(None, 0, 1, 0, 2, None))
    entries[1][0]["voicing_printed"] = shapes._visual_shape(raw[1]["decoded"])["voicing"]
    save_document(path, doc, overwrite=True)
    initial = index()
    group = next(group for group in initial["groups"] if group["base"] is None)
    exclude_shape_batch(songs, tmp_path / "history", group, [group["occurrences"][0]["id"]])
    rebuilt = index()
    assert rebuilt["counts"]["occurrences"] == 1
    assert rebuilt["groups"][0]["occurrences"][0]["bi"] == 1

    # Two excluded entries both claiming one alternate must both remain unmatched.
    doc = load_document(path)
    entries = doc["songs"][0]["sections"][0]["bars"]
    raw[1]["decoded"] = raw[0]["decoded"]
    entries[1][0]["voicing_printed"] = entries[0][0]["voicing_printed"]
    entries[1][0]["shape_exclusion"] = entries[0][0]["shape_exclusion"].copy()
    save_document(path, doc, overwrite=True)
    assert index()["groups"] == []


def test_exclude_http_refresh_lookup_and_undo(tmp_path, monkeypatch):
    import qa_server as server
    import qa_shape_routes as routes

    songs, _, pdf, _, _ = _rematch_fixture(tmp_path, monkeypatch)
    monkeypatch.setattr(server, "PDF_DIR", pdf.parent)
    monkeypatch.setattr(routes, "CACHE_ROOT", tmp_path / "http-cache")
    monkeypatch.setattr(routes, "_INDEXES", {})
    monkeypatch.setattr(routes, "_EDITED_FILES", set())
    monkeypatch.setattr(routes, "_RECOVERY_ERRORS", {})

    def request(method, url, data=None):
        status, _, body, *_ = server.handle(method, url, json.dumps(data).encode(), songs)
        return status, json.loads(body)

    _, listing = request("GET", "/api/shapes")
    group_id = listing["groups"][0]["id"]
    _, detail = request("GET", f"/api/shapes/{group_id}")
    selected = [detail["occurrences"][0]["id"]]
    status, first = request("POST", f"/api/shapes/{group_id}/exclude", {"selected": selected})
    assert status == 200, first
    lookup = "/api/shapes/entry?album=album&file=song.json&song_index=0&si=0&bi=0&ei=0"
    status, found = request("GET", lookup)
    assert status == 200 and found["id"] != group_id
    _, replacement = request("GET", f"/api/shapes/{found['id']}")
    assert replacement["occurrences"][0]["basis"] == "rematched_evidence"
    assert "source_evidence" not in replacement["occurrences"][0]
    status, second = request(
        "POST", f"/api/shapes/{found['id']}/exclude", {"selected": [found["occurrence_id"]]}
    )
    assert status == 200, second
    status, missing = request("GET", lookup)
    assert status == 404 and missing["unmatched"] is True
    _, listing = request("GET", "/api/shapes")
    assert listing["groups"] == []
    assert listing["counts"]["occurrences"] == 0
    assert request("POST", f"/api/shapes/batch/{second['batch_id']}/undo")[0] == 200
    assert request("GET", lookup)[1]["id"] == found["id"]
    assert request("POST", f"/api/shapes/batch/{first['batch_id']}/undo")[0] == 200
    assert request("GET", lookup)[1]["id"] == group_id


def test_rematch_rejects_crossing_unique_alternates(tmp_path, monkeypatch):
    from qa_shape_edits import exclude_shape_batch
    from songsheet_io import load_document, save_document

    songs, path, _, raw, index = _rematch_fixture(tmp_path, monkeypatch, alternate_count=3)
    doc = load_document(path)
    entries = doc["songs"][0]["sections"][0]["bars"]
    # Two rejected entries share their original group, then have one unique
    # replacement each in opposite scan order with no retained anchor between.
    raw[1]["decoded"] = raw[0]["decoded"]
    raw[3]["decoded"] = _decoded(pattern="OMFFFM", columns=(None, None, 2, 1, 0, None))
    entries[0][0]["voicing"] = shapes._visual_shape(raw[3]["decoded"])["voicing"]
    entries[1][0]["voicing"] = shapes._visual_shape(raw[2]["decoded"])["voicing"]
    entries[1][0]["voicing_printed"] = entries[0][0]["voicing_printed"]
    save_document(path, doc, overwrite=True)
    group = index()["groups"][0]
    assert len(group["occurrences"]) == 2
    exclude_shape_batch(
        songs, tmp_path / "history", group, [row["id"] for row in group["occurrences"]]
    )
    assert index()["groups"] == []
