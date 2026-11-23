import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import qa_shapes as shapes


def _decoded(pattern, columns):
    return {
        "pattern": pattern,
        "dot_cols": list(columns),
        "nut": True,
        "digit_bitmap": None,
        "digit_col": None,
    }


A = _decoded("MFFFFM", (None, 0, 1, 2, 3, None))
B = _decoded("OMMMMO", (None, None, None, None, None, None))
C = _decoded("FMMMMM", (2, None, None, None, None, None))


def _entry(label, voicing, *, printed=True):
    item = {"chord": label, "voicing": voicing}
    if printed:
        item["voicing_printed"] = voicing
    return item


def _document(entries, *, changed=False):
    doc = {
        "songs": [
            {
                "title": "Song",
                "pages": [1],
                "sections": [{"label": None, "bars": [[entry] for entry in entries]}],
            }
        ]
    }
    if changed:
        doc["_meta"] = {"legacy_scan_order_changed": True}
    return doc


def _records(tmp_path, monkeypatch, entries, decoded_rows, *, changed=False):
    pdf_dir = tmp_path / "pdfs"
    pdf_dir.mkdir()
    pdf = pdf_dir / "album.pdf"
    pdf.write_bytes(b"pdf")
    rows = []
    for index, decoded in enumerate(decoded_rows):
        rows.append(
            {
                "box": [index * 10, 2, index * 10 + 8, 12],
                "decoded": decoded,
                "error": None if decoded is not None else "unreadable",
            }
        )
    monkeypatch.setattr(shapes.audit_voicings, "pdf_for_album", lambda *_args: pdf)
    monkeypatch.setattr(shapes._SourceReader, "diagrams", lambda *_args: rows)
    monkeypatch.setattr(
        shapes._SourceReader, "page", lambda *_args: np.zeros((30, 100), dtype="uint8")
    )
    return shapes.legacy_page_records(
        _document(entries, changed=changed), "album", pdf_dir, tmp_path / "cache"
    )


def _flatten(groups):
    return [record for records in groups.values() for record in records]


def test_exact_count_keeps_positional_basis_and_labels_editorial_fallback(tmp_path, monkeypatch):
    entries = [
        _entry("A", "x,1,2,3,4,x"),
        _entry("B", "0,x,x,x,x,0", printed=False),
    ]

    records = _flatten(_records(tmp_path, monkeypatch, entries, [A, B]))

    assert [(record["observation_id"], record["basis"]) for record in records] == [
        ("0:0:0", shapes.LEGACY_BASIS),
        ("0:1:0", shapes.LEGACY_EDITORIAL_BASIS),
    ]


def test_extra_diagram_uses_only_forced_monotone_matches(tmp_path, monkeypatch):
    entries = [
        _entry("A", "x,1,2,3,4,x"),
        _entry("B", "0,x,x,x,x,0"),
    ]

    records = _flatten(_records(tmp_path, monkeypatch, entries, [A, None, B]))

    assert [
        (record["observation_id"], record["crop_box"], record["basis"]) for record in records
    ] == [
        ("0:0:0", [0, 2, 8, 12], shapes.LEGACY_ALIGNED_BASIS),
        ("0:1:0", [20, 2, 28, 12], shapes.LEGACY_ALIGNED_BASIS),
    ]


def test_missing_diagram_preserves_unique_matches_around_gap(tmp_path, monkeypatch):
    entries = [
        _entry("A", "x,1,2,3,4,x"),
        _entry("B", "0,x,x,x,x,0"),
        _entry("C", "3,x,x,x,x,x"),
    ]

    records = _flatten(_records(tmp_path, monkeypatch, entries, [A, C]))

    assert [(record["observation_id"], record["crop_box"]) for record in records] == [
        ("0:0:0", [0, 2, 8, 12]),
        ("0:2:0", [10, 2, 18, 12]),
    ]
    assert {record["basis"] for record in records} == {shapes.LEGACY_ALIGNED_BASIS}


def test_duplicate_alignment_ambiguity_is_not_exposed(tmp_path, monkeypatch):
    entries = [
        _entry("A1", "x,1,2,3,4,x"),
        _entry("A2", "x,1,2,3,4,x"),
    ]

    assert _records(tmp_path, monkeypatch, entries, [A]) == {}


def test_scan_only_alignment_does_not_widen_shape_index_eligibility():
    song = _document(
        [
            _entry("A", "x,1,2,3,4,x"),
            _entry("B", "0,x,x,x,x,0"),
        ]
    )["songs"][0]

    class Reader:
        def legacy_pdf(self, _album):
            return Path("album.pdf")

        def diagrams(self, _pdf, _page):
            return [
                {"box": [0, 2, 8, 12], "decoded": A, "error": None},
                {"box": [10, 2, 18, 12], "decoded": None, "error": "unreadable"},
                {"box": [20, 2, 28, 12], "decoded": B, "error": None},
            ]

    assert shapes._legacy_items(Reader(), "album", song) == []


def test_saved_scan_reorder_disqualifies_fresh_pairing(tmp_path, monkeypatch):
    entries = [_entry("A", "x,1,2,3,4,x")]

    records = _records(tmp_path, monkeypatch, entries, [A], changed=True)

    assert records == {}
