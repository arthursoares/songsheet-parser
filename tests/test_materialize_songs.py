import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import materialize_songs as M


def test_song_filename_uses_track_number_and_slug():
    assert M.song_filename(0, "Chega de Saudade") == "01-chega-de-saudade.json"
    assert M.song_filename(11, "É luxo só") == "12-e-luxo-so.json"


def test_album_slug_strips_and_slugs():
    assert M.album_slug("1 - Chega de Saudade") == "1-chega-de-saudade"


def test_split_songs_returns_one_doc_per_song():
    assembled = {
        "document": {"title": "Album", "source_pdf": "A.pdf", "page_count": 3},
        "songs": [
            {"title": "Song One", "pages": [1], "sections": [{"label": None, "bars": []}]},
            {"title": "Song Two", "pages": [2, 3], "sections": [{"label": None, "bars": []}]},
        ],
    }
    docs = M.split_songs(assembled)
    assert [d["filename"] for d in docs] == ["01-song-one.json", "02-song-two.json"]
    assert docs[0]["doc"]["document"]["title"] == "Album"
    assert len(docs[0]["doc"]["songs"]) == 1
    assert docs[1]["doc"]["songs"][0]["title"] == "Song Two"
    assert docs[1]["pages"] == [2, 3]
