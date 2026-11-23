import base64
import hashlib
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import repeated_chord_crops as crops
from extraction_provenance import file_sha256


def _song(entry):
    return {"sections": [{"bars": [[entry]]}], "pages": [1]}


def test_recorded_crop_verifies_pdf_and_native_pixels(tmp_path, monkeypatch):
    pdfs = tmp_path / "pdfs"
    pdfs.mkdir()
    pdf = pdfs / "album.pdf"
    pdf.write_bytes(b"pdf")
    song_path = tmp_path / "album" / "song.json"
    song_path.parent.mkdir()
    song_path.write_bytes(b"song")
    page = np.zeros((40, 50), dtype=int)
    observation_id = "a" * 64
    entry = {
        "chord": "Em9",
        "observation_id": observation_id,
        "voicing": "0,2,0,0,3,2",
        "voicing_printed": "0,2,x,0,3,2",
    }
    doc = {
        "songs": [_song(entry)],
        "_meta": {
            "diagram_evidence": {
                observation_id: {
                    "record": {
                        "observation_id": observation_id,
                        "voicing_printed": entry["voicing_printed"],
                        "source_pdf": {"name": pdf.name, "sha256": file_sha256(pdf)},
                        "page": 1,
                        "crop_box": [2, 3, 12, 18],
                        "native_image": {
                            "width": 50,
                            "height": 40,
                            "sha256": hashlib.sha256(page.astype("uint8").tobytes()).hexdigest(),
                        },
                    }
                }
            }
        },
    }
    loads = []
    monkeypatch.setattr(crops, "load_document", lambda _path: doc)
    monkeypatch.setattr(crops, "load_page_image", lambda *_args: loads.append(1) or page)

    reader = crops.CropReader(pdfs, tmp_path / "cache")
    result = reader.crop_for(song_path, 0, 0, 0, 0)
    assert result["basis"] == crops.RECORDED_BASIS
    assert result["page"] == 1 and result["pdf"] == "album.pdf"
    assert base64.b64decode(result["image"].split(",", 1)[1]).startswith(b"\x89PNG")
    assert reader.crop_for(song_path, 0, 0, 0, 0) == result
    assert (
        reader.crop_for(song_path, 0, 0, 0, 0, expected=("Em9", entry["voicing"], "0,0,0,0,0,0"))
        is None
    )
    assert loads == [1]


@pytest.mark.parametrize("changed", ["pdf", "pixels", "printed"])
def test_recorded_crop_refuses_changed_evidence(tmp_path, monkeypatch, changed):
    pdfs = tmp_path / "pdfs"
    pdfs.mkdir()
    pdf = pdfs / "album.pdf"
    pdf.write_bytes(b"current")
    song_path = tmp_path / "album" / "song.json"
    song_path.parent.mkdir()
    song_path.write_bytes(b"song")
    page = np.zeros((20, 20), dtype=int)
    observation_id = "b" * 64
    source_hash = "0" * 64 if changed == "pdf" else file_sha256(pdf)
    pixel_hash = "0" * 64 if changed == "pixels" else hashlib.sha256(bytes(400)).hexdigest()
    entry = {"chord": "Em9", "observation_id": observation_id, "voicing_printed": "0,2,x,0,3,2"}
    doc = {
        "songs": [_song(entry)],
        "_meta": {
            "diagram_evidence": {
                observation_id: {
                    "record": {
                        "observation_id": observation_id,
                        "voicing_printed": "0,2,0,0,3,2"
                        if changed == "printed"
                        else entry["voicing_printed"],
                        "source_pdf": {"name": pdf.name, "sha256": source_hash},
                        "page": 1,
                        "crop_box": [1, 1, 5, 5],
                        "native_image": {"width": 20, "height": 20, "sha256": pixel_hash},
                    }
                }
            }
        },
    }
    document_loads = []
    monkeypatch.setattr(crops, "load_document", lambda _path: document_loads.append(1) or doc)
    monkeypatch.setattr(crops, "load_page_image", lambda *_args: page)
    reader = crops.CropReader(pdfs, tmp_path / "cache")

    assert reader.crop_for(song_path, 0, 0, 0, 0) is None
    assert reader.crop_for(song_path, 0, 0, 0, 0) is None
    assert document_loads == [1]


@pytest.mark.parametrize(
    ("mode", "decoded", "expected"),
    [
        ("voiced", "0,2,0,0,0,2", crops.LEGACY_BASIS),
        ("all-entries", "0,2,0,0,0,2", crops.LEGACY_BASIS),
        ("fuzzy", "0,2,0,0,0,2", None),
        ("offset", "0,2,0,0,0,2", None),
        ("voiced", "0,2,0,0,3,2", None),
    ],
)
def test_legacy_crop_requires_exact_pairing_and_matching_printed_voicing(
    tmp_path, monkeypatch, mode, decoded, expected
):
    pdfs = tmp_path / "pdfs"
    pdfs.mkdir()
    pdf = pdfs / "album.pdf"
    pdf.write_bytes(b"pdf")
    song_path = tmp_path / "1-album" / "song.json"
    song_path.parent.mkdir()
    song_path.write_bytes(b"song")
    entry = {"chord": "Em9", "voicing_printed": "0,2,0,0,0,2"}
    song = _song(entry)
    data = (decoded, None, 1, [1, 1, 5, 5])
    monkeypatch.setattr(crops, "load_document", lambda _path: {"songs": [song]})
    monkeypatch.setattr(crops.audit_voicings, "pdf_for_album", lambda *_args: pdf)
    monkeypatch.setattr(crops.audit_voicings, "song_diagram_data", lambda *_args: [data])
    monkeypatch.setattr(crops.audit_voicings, "pair_song", lambda *_args: ([(entry, data)], mode))
    monkeypatch.setattr(crops, "load_page_image", lambda *_args: np.zeros((20, 20), dtype=int))

    result = crops.CropReader(pdfs, tmp_path / "cache").crop_for(song_path, 0, 0, 0, 0)
    assert (result or {}).get("basis") == expected
