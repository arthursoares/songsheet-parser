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
