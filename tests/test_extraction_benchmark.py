import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import extraction_benchmark as B


def _write_song(root, rel, chord="C", status="done"):
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "document": {"status": status},
                "songs": [
                    {
                        "title": path.stem,
                        "sections": [{"bars": [[{"chord": chord, "text": "word"}]]}],
                    }
                ],
            }
        )
    )
    return path


def test_manifest_is_deterministic_and_records_review_provenance(tmp_path):
    golden = tmp_path / "golden"
    _write_song(golden, "album/b.json")
    _write_song(golden, "album/a.json")
    _write_song(golden, "album/c.json")
    kwargs = {
        "golden_root": golden,
        "development": ["album/b.json", "album/a.json"],
        "held_out": ["album/c.json"],
        "label_type": "human_reviewed",
        "review_provenance": "manual scan comparison by AS",
    }
    first = B.create_manifest(**kwargs)
    second = B.create_manifest(**kwargs)
    assert first == second
    assert [r["path"] for r in first["splits"]["development"]] == [
        "album/a.json",
        "album/b.json",
    ]
    assert first["splits"]["development"][0]["label_type"] == "human_reviewed"
    assert first["splits"]["development"][0]["review_provenance"] == (
        "manual scan comparison by AS"
    )
    assert len(first["splits"]["development"][0]["sha256"]) == 64


def test_manifest_rejects_duplicates_and_split_overlap(tmp_path):
    golden = tmp_path / "golden"
    _write_song(golden, "album/a.json")
    _write_song(golden, "album/b.json")
    with pytest.raises(ValueError, match="duplicate"):
        B.create_manifest(
            golden,
            ["album/a.json", "album/a.json"],
            ["album/b.json"],
            "human_reviewed",
            "manual review",
        )
    with pytest.raises(ValueError, match="both splits"):
        B.create_manifest(
            golden,
            ["album/a.json"],
            ["album/a.json"],
            "human_reviewed",
            "manual review",
        )


def test_human_reviewed_manifest_rejects_pending_document(tmp_path):
    golden = tmp_path / "golden"
    _write_song(golden, "album/pending.json", status="pending")
    _write_song(golden, "album/done.json")
    with pytest.raises(ValueError, match="document.status=done"):
        B.create_manifest(
            golden,
            ["album/pending.json"],
            ["album/done.json"],
            "human_reviewed",
            "manual review",
        )


def test_score_rejects_changed_or_unreviewed_gold(tmp_path):
    golden, candidate = tmp_path / "golden", tmp_path / "candidate"
    gold = _write_song(golden, "album/a.json")
    _write_song(golden, "album/b.json")
    _write_song(candidate, "album/a.json")
    manifest = B.create_manifest(
        golden,
        ["album/a.json"],
        ["album/b.json"],
        "human_reviewed",
        "manual review",
    )
    gold.write_text(gold.read_text() + "\n")
    with pytest.raises(ValueError, match="hash mismatch"):
        B.score_split(manifest, golden, candidate, "development")

    unreviewed = B.create_manifest(
        golden, ["album/a.json"], ["album/b.json"], "unreviewed", "automated import"
    )
    with pytest.raises(ValueError, match="not eligible as ground truth"):
        B.score_split(unreviewed, golden, candidate, "development")


def test_score_rechecks_done_status_even_when_manifest_hash_matches(tmp_path):
    golden, candidate = tmp_path / "golden", tmp_path / "candidate"
    gold = _write_song(golden, "album/a.json")
    _write_song(golden, "album/b.json")
    _write_song(candidate, "album/a.json")
    manifest = B.create_manifest(
        golden,
        ["album/a.json"],
        ["album/b.json"],
        "human_reviewed",
        "manual review",
    )
    doc = json.loads(gold.read_text())
    doc["document"]["status"] = "pending"
    gold.write_text(json.dumps(doc))
    manifest["splits"]["development"][0]["sha256"] = hashlib.sha256(gold.read_bytes()).hexdigest()
    with pytest.raises(ValueError, match="document.status=done"):
        B.score_split(manifest, golden, candidate, "development")


def test_score_split_counts_missing_and_extra_candidates(tmp_path):
    golden, candidate = tmp_path / "golden", tmp_path / "candidate"
    _write_song(golden, "album/a.json")
    _write_song(golden, "album/b.json", chord="Dm")
    _write_song(golden, "album/held.json")
    _write_song(candidate, "album/a.json")
    _write_song(candidate, "album/extra.json")
    manifest = B.create_manifest(
        golden,
        ["album/a.json", "album/b.json"],
        ["album/held.json"],
        "human_reviewed",
        "manual review",
    )
    report = B.score_split(manifest, golden, candidate, "development")
    assert report["benchmark"]["split"] == "development"
    assert report["benchmark"]["references_verified"] == 2
    assert report["aggregate"]["chord_recall"] == 0.5
    assert report["coverage"]["missing_songs"] == ["album/b.json"]
    assert report["coverage"]["extra_candidate_songs"] == ["album/extra.json"]


def test_cli_creates_manifest_and_scores_selected_split(tmp_path):
    golden, candidate = tmp_path / "golden", tmp_path / "candidate"
    _write_song(golden, "album/dev.json")
    _write_song(golden, "album/hold.json")
    _write_song(candidate, "album/dev.json")
    manifest, report = tmp_path / "benchmark.json", tmp_path / "report.json"
    script = Path(__file__).resolve().parent.parent / "scripts" / "extraction_benchmark.py"
    created = subprocess.run(
        [
            sys.executable,
            str(script),
            "create",
            "--golden",
            str(golden),
            "--development",
            "album/dev.json",
            "--held-out",
            "album/hold.json",
            "--label-type",
            "human_reviewed",
            "--review-provenance",
            "manual scan review",
            "--output",
            str(manifest),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    assert created.returncode == 0, created.stderr
    scored = subprocess.run(
        [
            sys.executable,
            str(script),
            "score",
            "--manifest",
            str(manifest),
            "--golden",
            str(golden),
            "--candidate",
            str(candidate),
            "--split",
            "development",
            "--report-json",
            str(report),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    assert scored.returncode == 0, scored.stderr
    assert json.loads(report.read_text())["aggregate"]["chord_recall"] == 1.0
