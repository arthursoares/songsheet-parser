import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import qa_server as S


def _corpus(tmp_path):
    songs = tmp_path / "songs"
    album = songs / "1-album"
    (album / "pages").mkdir(parents=True)
    doc = {"document": {"title": "Album"},
           "songs": [{"title": "Song One", "pages": [1],
                      "sections": [{"label": None, "bars": [[{"chord": "Dm7"}]]}]}]}
    (album / "01-song-one.json").write_text(json.dumps(doc))
    (album / "pages" / "01-song-one-p1.png").write_bytes(b"\x89PNG")
    return songs


def test_list_albums(tmp_path):
    root = _corpus(tmp_path)
    status, ctype, body = S.handle("GET", "/api/albums", b"", root)
    assert status == 200
    data = json.loads(body)
    assert data == [{"album": "1-album", "songs": ["01-song-one.json"]}]


def test_get_song(tmp_path):
    root = _corpus(tmp_path)
    status, ctype, body = S.handle("GET", "/api/song/1-album/01-song-one.json", b"", root)
    assert status == 200
    assert json.loads(body)["songs"][0]["title"] == "Song One"


def test_get_missing_song_404(tmp_path):
    root = _corpus(tmp_path)
    status, _, _ = S.handle("GET", "/api/song/1-album/nope.json", b"", root)
    assert status == 404
