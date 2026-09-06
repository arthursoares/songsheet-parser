import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import migrate_hyphenation as M
from songsheet_version import SCHEMA_VERSION

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "chega-page1.json"


def _fixture_doc():
    return json.loads(FIXTURE.read_text())


def test_collect_lyric_fragments_in_order():
    song = {
        "sections": [
            {
                "bars": [
                    [{"chord": "Dm7", "text": "Vai"}],
                    [{"chord": "%", "text": "mi nha"}],
                    [{"chord": "A7"}],  # no text -> skipped
                    [{"chord": "Bdim7", "text": "tris te za e"}],
                ]
            }
        ]
    }
    assert M.collect_fragments(song) == ["Vai", "mi nha", "tris te za e"]


def test_apply_fragments_writes_back_in_order():
    song = {
        "sections": [
            {
                "bars": [
                    [{"chord": "Dm7", "text": "Vai"}],
                    [{"chord": "%", "text": "mi nha"}],
                    [{"chord": "A7"}],
                    [{"chord": "Bdim7", "text": "tris te za e"}],
                ]
            }
        ]
    }
    M.apply_fragments(song, ["Vai", "mi- nha", "tris- te- za e"])
    texts = [e.get("text") for bar in song["sections"][0]["bars"] for e in bar]
    assert texts == ["Vai", "mi- nha", None, "tris- te- za e"]


def test_already_hyphenated_is_skipped():
    song = {"sections": [{"bars": [[{"chord": "Dm7", "text": "mi- nha"}]]}]}
    assert M.needs_migration(song) is False
    song2 = {"sections": [{"bars": [[{"chord": "Dm7", "text": "mi nha"}]]}]}
    assert M.needs_migration(song2) is True


def test_apply_fragments_rejects_token_mismatch():
    song = {"sections": [{"bars": [[{"chord": "Dm7", "text": "mi nha"}]]}]}
    with pytest.raises(ValueError):
        M.apply_fragments(song, ["mi- nha do"])  # 3 tokens vs original 2


def test_future_document_is_rejected_before_hyphenator(tmp_path):
    doc = _fixture_doc()
    doc["schema_version"] = 99
    path = tmp_path / "future.json"
    path.write_text(json.dumps(doc))
    before = path.read_bytes()
    called = False

    def hyphenator(_fragments):
        nonlocal called
        called = True
        return []

    with pytest.raises(ValueError, match="newer than supported"):
        M.migrate_file(path, hyphenator)

    assert called is False
    assert path.read_bytes() == before


def test_migrate_write_preserves_editorial_fields_and_stamps_version(tmp_path):
    doc = _fixture_doc()
    doc["songs"][0]["note"] = "Do not lose the reviewed voicing"
    path = tmp_path / "song.json"
    path.write_text(json.dumps(doc))

    changed = M.migrate_file(
        path, lambda fragments: [fragment.replace(" ", "- ") for fragment in fragments]
    )

    assert changed is True
    saved = json.loads(path.read_text())
    assert saved["schema_version"] == SCHEMA_VERSION
    assert saved["songs"][0]["note"] == "Do not lose the reviewed voicing"
    assert saved["songs"][0]["sections"][0]["bars"][2][0]["voicing"] == "x,5,7,5,6,x"


def test_schema_invalid_migration_does_not_damage_existing_file(tmp_path, monkeypatch):
    path = tmp_path / "song.json"
    path.write_text(json.dumps(_fixture_doc()))
    before = path.read_bytes()
    original_apply = M.apply_fragments

    def corrupt_output(song, hyphenated):
        original_apply(song, hyphenated)
        song.pop("title")
        return song

    monkeypatch.setattr(M, "apply_fragments", corrupt_output)

    with pytest.raises(ValueError):
        M.migrate_file(path, lambda fragments: fragments)

    assert path.read_bytes() == before


def test_dry_run_does_not_persist_migration(tmp_path):
    path = tmp_path / "song.json"
    path.write_text(json.dumps(_fixture_doc()))
    before = path.read_bytes()

    changed = M.migrate_file(path, lambda fragments: fragments, dry_run=True)

    assert changed is True
    assert path.read_bytes() == before
