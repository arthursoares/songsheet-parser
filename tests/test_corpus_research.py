import copy
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import corpus_research as C


def _entry(chord, voicing=None, printed=None):
    item = {"chord": chord}
    if voicing is not None:
        item["voicing"] = voicing
    if printed is not None:
        item["voicing_printed"] = printed
    return item


def _write_song(root, relative, *, title="Unsafe <song>", status="done", key=None, entries=None):
    document = {
        "document": {"title": "Album & One", "source_pdf": "source.pdf", "page_count": 12},
        "songs": [
            {
                "title": title,
                "composers": ["A. Writer"],
                "pages": [3],
                "key": key,
                "sections": [{"label": None, "bars": [[e] for e in (entries or [_entry("C")])]}],
            }
        ],
    }
    if status is not None:
        document["document"]["status"] = status
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document), encoding="utf-8")
    return path


def _manifest(assignments=None):
    assignment = {"work_id": "work:eclipse"}
    return {
        "schema_version": 1,
        "works": {"work:eclipse": {"title": "Eclipse", "composers": ["A. Writer"]}},
        "assignments": ({"album-a/song.json": assignment} if assignments is None else assignments),
    }


def test_catalog_identity_hash_eligibility_and_observed_unknowns(tmp_path):
    path = _write_song(tmp_path, "album-a/song.json", status=None)
    first = C.build_catalog(tmp_path, _manifest(), include_unreviewed=True)
    arrangement = first["arrangements"][0]
    assert arrangement["arrangement_id"] == "album-a/song.json"
    assert arrangement["document_status"] == "pending"
    assert arrangement["provisional"] is True
    assert arrangement["observed_album"]["release_date"] is None
    assert arrangement["observed_album"]["recording_date"] is None
    old_hash = arrangement["revision_sha256"]

    path.write_text(path.read_text().replace("Unsafe <song>", "Changed title"), encoding="utf-8")
    changed = C.build_catalog(tmp_path, _manifest(), include_unreviewed=True)["arrangements"][0]
    assert changed["arrangement_id"] == arrangement["arrangement_id"]
    assert changed["revision_sha256"] != old_hash

    default = C.build_catalog(tmp_path, _manifest())
    assert default["summary"]["arrangements_included"] == 0
    assert default["summary"]["excluded_by_status"] == {"pending": 1}


def test_normalization_suggests_candidates_but_never_assigns(tmp_path):
    _write_song(tmp_path, "a/one.json", title="Água de Beber", status="done")
    _write_song(tmp_path, "b/two.json", title="agua-de beber", status="done")
    catalog = C.build_catalog(tmp_path, _manifest({}))
    assert all(a["work_id"] is None for a in catalog["arrangements"])
    assert catalog["candidate_groups"][0]["arrangement_ids"] == ["a/one.json", "b/two.json"]
    assert "candidate only" in catalog["candidate_groups"][0]["note"]


def test_printed_comparison_keeps_missing_values_missing(tmp_path):
    a = _entry("Cmaj7", "x,3,5,4,5,3", None)
    b = _entry("C7M", "8,x,9,9,8,x", "8,x,9,9,8,x")
    _write_song(tmp_path, "a/one.json", status="done", entries=[a])
    _write_song(tmp_path, "b/two.json", status="done", entries=[b])
    assignments = {
        "a/one.json": {"work_id": "work:eclipse"},
        "b/two.json": {"work_id": "work:eclipse"},
    }
    catalog = C.build_catalog(tmp_path, _manifest(assignments))
    left, right = catalog["arrangements"]
    result = C.compare_arrangements(tmp_path, left, right, "voicing_printed")
    aligned = result["aligned_events"][0]
    assert aligned["chord_relation"] == "harmonically_equivalent_spelling"
    assert aligned["left"]["voicing"] is None
    assert aligned["voicing_relation"] == "missing"
    assert result["counts"]["voicing_missing_left"] == 1


def test_comparison_reports_unaligned_spans_voicing_and_physical_bass(tmp_path):
    _write_song(
        tmp_path,
        "a/one.json",
        status="done",
        entries=[_entry("C", "x,3,5,5,5,3"), _entry("G7", "3,5,3,4,3,3")],
    )
    _write_song(
        tmp_path,
        "b/two.json",
        status="done",
        entries=[_entry("C", "0,3,2,0,1,0"), _entry("F#m", "2,4,4,2,2,2")],
    )
    assignments = {
        "a/one.json": {"work_id": "work:eclipse"},
        "b/two.json": {"work_id": "work:eclipse"},
    }
    left, right = C.build_catalog(tmp_path, _manifest(assignments))["arrangements"]
    result = C.compare_arrangements(tmp_path, left, right)
    assert result["counts"]["harmonically_aligned"] == 1
    assert result["counts"]["voicing_differences"] == 1
    assert result["counts"]["physical_bass_differences"] == 1
    assert result["unaligned_spans"][0]["left"][0]["chord"] == "G7"
    assert result["unaligned_spans"][0]["right"][0]["chord"] == "F#m"


def test_roman_comparison_requires_manifest_confirmed_keys(tmp_path):
    _write_song(tmp_path, "a/one.json", status="done", key="C", entries=[_entry("C")])
    _write_song(tmp_path, "b/two.json", status="done", key="C", entries=[_entry("C")])
    base_assignments = {
        "a/one.json": {"work_id": "work:eclipse"},
        "b/two.json": {"work_id": "work:eclipse"},
    }
    left, right = C.build_catalog(tmp_path, _manifest(base_assignments))["arrangements"]
    assert C.compare_arrangements(tmp_path, left, right)["roman_comparison"]["enabled"] is False

    confirmed = _manifest(copy.deepcopy(base_assignments))
    for assignment in confirmed["assignments"].values():
        assignment["confirmed_key"] = {
            "tonic": "C",
            "mode": "major",
            "evidence": "reviewed against page",
        }
    left, right = C.build_catalog(tmp_path, confirmed)["arrangements"]
    result = C.compare_arrangements(tmp_path, left, right)
    assert result["roman_comparison"]["enabled"] is True
    assert result["roman_comparison"]["left_events"] == 1
    assert result["roman_comparison"]["right_events"] == 1
    assert result["roman_comparison"]["aligned_events"] == 1
    assert result["roman_comparison"]["unaligned_spans"] == []


def test_confirmed_keys_enable_transposed_roman_alignment(tmp_path):
    _write_song(tmp_path, "a/one.json", status="done", entries=[_entry("Cmaj7")])
    _write_song(tmp_path, "b/two.json", status="done", entries=[_entry("Gmaj7")])
    assignments = {
        "a/one.json": {
            "work_id": "work:eclipse",
            "confirmed_key": {"tonic": "C", "mode": "major", "evidence": "reviewed page"},
        },
        "b/two.json": {
            "work_id": "work:eclipse",
            "confirmed_key": {"tonic": "G", "mode": "major", "evidence": "reviewed page"},
        },
    }
    left, right = C.build_catalog(tmp_path, _manifest(assignments))["arrangements"]
    result = C.compare_arrangements(tmp_path, left, right)
    assert result["counts"]["harmonically_aligned"] == 0
    assert result["roman_comparison"]["aligned_events"] == 1
    assert result["roman_comparison"]["unaligned_spans"] == []
    output = C.render_html(C.build_report(tmp_path, _manifest(assignments)))
    assert "Absolute harmonic alignment: 0 matches; 1 gap span" in output
    assert "Confirmed-key Roman alignment: 1 match; 0 gap spans" in output
    assert "Confirmed-key Roman matches and gaps" in output
    assert "&quot;roman&quot;: &quot;Imaj7&quot;" in output


def test_manifest_rejects_key_confirmation_without_evidence(tmp_path):
    manifest = _manifest()
    manifest["assignments"]["album-a/song.json"]["confirmed_key"] = {"tonic": "C"}
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(ValueError, match="non-blank evidence"):
        C.load_manifest(path)


@pytest.mark.parametrize(
    "confirmed,match",
    [
        ({"tonic": "H", "evidence": "reviewed page"}, "invalid tonic"),
        ({"tonic": "C", "evidence": "   \t"}, "non-blank evidence"),
    ],
)
def test_manifest_rejects_invalid_confirmed_key_evidence(tmp_path, confirmed, match):
    manifest = _manifest()
    manifest["assignments"]["album-a/song.json"]["confirmed_key"] = confirmed
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(ValueError, match=match):
        C.load_manifest(path)
    with pytest.raises(ValueError, match=match):
        C.build_catalog(tmp_path, manifest)


def test_confirmed_keys_do_not_enable_empty_roman_comparison(tmp_path):
    _write_song(tmp_path, "a/one.json", status="done", entries=[_entry("not-a-chord")])
    _write_song(tmp_path, "b/two.json", status="done", entries=[_entry("also-not-a-chord")])
    assignments = {
        path: {
            "work_id": "work:eclipse",
            "confirmed_key": {"tonic": "C", "evidence": "reviewed page"},
        }
        for path in ("a/one.json", "b/two.json")
    }
    left, right = C.build_catalog(tmp_path, _manifest(assignments))["arrangements"]
    roman_result = C.compare_arrangements(tmp_path, left, right)["roman_comparison"]
    assert roman_result["enabled"] is False
    assert "no comparable Roman events" in roman_result["reason"]


def test_html_escapes_data_and_explains_priority_points(tmp_path):
    _write_song(tmp_path, "album-a/song.json", status="done")
    (tmp_path / "bad<script>.json").write_text("{", encoding="utf-8")
    report = C.build_report(tmp_path, _manifest())
    output = C.render_html(report)
    assert "Unsafe &lt;song&gt;" in output
    assert "Album &amp; One" in output
    assert "<script>" not in output
    assert "not probabilities" in output
    assert "album-a/song.json" in output
    assert "Sources attempted 2: 1 valid, 1 invalid" in output
    assert "bad&lt;script&gt;.json" in output
    assert "Expecting property name" in output
