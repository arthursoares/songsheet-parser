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
    assert data == [{"album": "1-album",
                     "songs": [{"file": "01-song-one.json", "status": "pending"}]}]


def test_list_albums_reads_status(tmp_path):
    root = _corpus(tmp_path)
    p = root / "1-album" / "01-song-one.json"
    doc = json.loads(p.read_text())
    doc["document"]["status"] = "done"
    p.write_text(json.dumps(doc))
    _, _, body = S.handle("GET", "/api/albums", b"", root)
    assert json.loads(body)[0]["songs"][0]["status"] == "done"


def test_get_song(tmp_path):
    root = _corpus(tmp_path)
    status, ctype, body = S.handle("GET", "/api/song/1-album/01-song-one.json", b"", root)
    assert status == 200
    assert json.loads(body)["songs"][0]["title"] == "Song One"


def test_get_missing_song_404(tmp_path):
    root = _corpus(tmp_path)
    status, _, _ = S.handle("GET", "/api/song/1-album/nope.json", b"", root)
    assert status == 404


def test_save_valid_song_writes(tmp_path):
    root = _corpus(tmp_path)
    doc = json.loads((root / "1-album" / "01-song-one.json").read_text())
    doc["songs"][0]["sections"][0]["bars"][0][0]["chord"] = "Am7"
    status, _, body = S.handle("POST", "/api/song/1-album/01-song-one.json",
                               json.dumps(doc).encode(), root)
    assert status == 200
    assert json.loads(body)["ok"] is True
    on_disk = json.loads((root / "1-album" / "01-song-one.json").read_text())
    assert on_disk["songs"][0]["sections"][0]["bars"][0][0]["chord"] == "Am7"


def test_save_invalid_song_rejected(tmp_path):
    root = _corpus(tmp_path)
    doc = json.loads((root / "1-album" / "01-song-one.json").read_text())
    doc["songs"][0]["sections"][0]["bars"][0][0] = {"voicing": "x,5,7,5,6,x"}
    status, _, body = S.handle("POST", "/api/song/1-album/01-song-one.json",
                               json.dumps(doc).encode(), root)
    assert status == 422
    assert json.loads(body)["ok"] is False
    on_disk = json.loads((root / "1-album" / "01-song-one.json").read_text())
    assert on_disk["songs"][0]["sections"][0]["bars"][0][0]["chord"] == "Dm7"


def test_save_rejects_path_traversal(tmp_path):
    root = _corpus(tmp_path)
    import json as _j
    body = _j.dumps({"document": {"title": "x"}, "songs": []}).encode()
    status, _, _ = S.handle("POST", "/api/song/../evil.json", body, root)
    assert status == 400
    assert not (tmp_path / "evil.json").exists()
    # also the page route
    status2, _, _ = S.handle("GET", "/api/page/../x/1", b"", root)
    assert status2 == 400


def test_serves_index_html(tmp_path, monkeypatch):
    root = _corpus(tmp_path)
    static = tmp_path / "static"
    (static / "vendor").mkdir(parents=True)
    (static / "index.html").write_text("<html>QA</html>")
    monkeypatch.setattr(S, "STATIC_DIR", static)
    status, ctype, body = S.handle("GET", "/", b"", root)
    assert status == 200
    assert ctype == "text/html"
    assert b"QA" in body


def test_serves_static_js(tmp_path, monkeypatch):
    root = _corpus(tmp_path)
    static = tmp_path / "static"
    static.mkdir()
    (static / "app.js").write_text("// app")
    monkeypatch.setattr(S, "STATIC_DIR", static)
    status, ctype, body = S.handle("GET", "/app.js", b"", root)
    assert status == 200
    assert "javascript" in ctype
