import json

from qa_reading_proposals import load_reading_proposals

DIGEST = "a" * 64
PDF_DIGEST = "b" * 64


def _row(**changes):
    row = {
        "file": "album/01-song.json",
        "coordinate": "0:1:2",
        "chord": "Dm7",
        "stored_printed": "x,5,7,5,6,x",
        "current_chart": "x,5,7,5,6,x",
        "fresh_candidate": "x,3,5,3,4,x",
        "pdf": "Songbook.pdf",
        "page": 7,
        "native_box": [10, 20, 40, 60],
        "basis": "single gap between two agreeing scan anchors",
        "review": "required",
        "compatibility": "fresh_only",
    }
    row.update(changes)
    return row


def _write_run(tmp_path, proposals, *, charts=None, pdfs=None):
    (tmp_path / "chart-report.json").write_text(
        json.dumps({"charts": charts or [{"file": "album/01-song.json", "sha256": DIGEST}]})
    )
    (tmp_path / "pages-report.json").write_text(
        json.dumps({"pdfs": pdfs or [{"pdf": "Songbook.pdf", "pdf_sha256": PDF_DIGEST}]})
    )
    (tmp_path / "prioritized-proposals.json").write_text(json.dumps({"proposals": proposals}))


def test_loads_actual_report_shape_and_joins_revision_and_pdf(tmp_path):
    _write_run(tmp_path, [_row()])

    result = load_reading_proposals(tmp_path)

    assert result == {
        ("album", "01-song.json"): {
            "revision": DIGEST,
            "entries": [
                {
                    "coordinate": "0:1:2",
                    "chord": "Dm7",
                    "editorial": "x,5,7,5,6,x",
                    "printed": "x,5,7,5,6,x",
                    "pdf": "Songbook.pdf",
                    "pdf_sha256": PDF_DIGEST,
                    "page": 7,
                    "box": [10, 20, 40, 60],
                    "proposal": "x,3,5,3,4,x",
                }
            ],
        }
    }


def test_rejects_unsafe_malformed_and_ambiguous_rows(tmp_path):
    rows = [
        _row(file="../01-song.json", coordinate="0:2:0"),
        _row(coordinate="0:-1:0"),
        _row(coordinate="0:3:0", page=True),
        _row(coordinate="0:4:0", native_box=[40, 20, 10, 60]),
        _row(coordinate="0:5:0", pdf="../Songbook.pdf"),
        _row(coordinate="0:6:0", basis="approximate"),
        _row(coordinate="0:7:0", review="optional"),
        _row(coordinate="0:8:0", fresh_candidate="x,3,5,3,25,x"),
        _row(coordinate="0:9:0"),
        _row(coordinate="0:9:0", chord="D7"),
        _row(coordinate="0:10:0"),
    ]
    _write_run(tmp_path, rows)

    entries = load_reading_proposals(tmp_path)[("album", "01-song.json")]["entries"]

    assert [entry["coordinate"] for entry in entries] == ["0:10:0"]


def test_weak_compatibility_keeps_location_without_edit_target(tmp_path):
    rows = [
        _row(
            coordinate="0:1:0",
            compatibility="stored_only",
            current_chart=None,
            fresh_candidate="not-a-voicing",
        ),
        _row(coordinate="0:2:0", compatibility="unknown"),
    ]
    _write_run(tmp_path, rows)

    entries = load_reading_proposals(tmp_path)[("album", "01-song.json")]["entries"]

    assert [entry["coordinate"] for entry in entries] == ["0:1:0", "0:2:0"]
    assert [entry["proposal"] for entry in entries] == [None, None]
    assert entries[0]["editorial"] is None


def test_duplicate_chart_or_pdf_metadata_is_not_guessed(tmp_path):
    _write_run(
        tmp_path,
        [_row()],
        charts=[
            {"file": "album/01-song.json", "sha256": DIGEST},
            {"file": "album/01-song.json", "sha256": "c" * 64},
        ],
    )
    assert load_reading_proposals(tmp_path) == {}

    _write_run(
        tmp_path,
        [_row()],
        pdfs=[
            {"pdf": "Songbook.pdf", "pdf_sha256": PDF_DIGEST},
            {"pdf": "Songbook.pdf", "pdf_sha256": "c" * 64},
        ],
    )
    assert load_reading_proposals(tmp_path) == {}
