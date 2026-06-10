import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import migrate_hyphenation as M


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
