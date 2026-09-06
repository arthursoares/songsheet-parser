import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import qa_server as S
from songsheet_version import SCHEMA_VERSION


def _corpus(tmp_path):
    songs = tmp_path / "songs"
    album = songs / "1-album"
    (album / "pages").mkdir(parents=True)
    doc = {
        "document": {"title": "Album"},
        "songs": [
            {
                "title": "Song One",
                "pages": [1],
                "sections": [{"label": None, "bars": [[{"chord": "Dm7"}]]}],
            }
        ],
    }
    (album / "01-song-one.json").write_text(json.dumps(doc))
    (album / "pages" / "01-song-one-p1.png").write_bytes(b"\x89PNG")
    return songs


def test_list_albums(tmp_path):
    root = _corpus(tmp_path)
    status, ctype, body = S.handle("GET", "/api/albums", b"", root)
    assert status == 200
    data = json.loads(body)
    assert data == [
        {
            "album": "1-album",
            "songs": [
                {
                    "file": "01-song-one.json",
                    "status": "pending",
                    "print_diffs": 0,
                    "audited": False,
                }
            ],
        }
    ]


def test_list_albums_counts_print_diffs(tmp_path):
    root = _corpus(tmp_path)
    p = root / "1-album" / "01-song-one.json"
    doc = json.loads(p.read_text())
    e = doc["songs"][0]["sections"][0]["bars"][0][0]
    e["voicing"] = "x,5,7,5,6,x"
    e["voicing_printed"] = "x,5,7,5,6,5"  # differs -> 1 diff, audited
    p.write_text(json.dumps(doc))
    _, _, body = S.handle("GET", "/api/albums", b"", root)
    s = json.loads(body)[0]["songs"][0]
    assert s["print_diffs"] == 1 and s["audited"] is True


def test_diagram_crop_without_pdf_dir_404(tmp_path, monkeypatch):
    root = _corpus(tmp_path)
    monkeypatch.setattr(S, "PDF_DIR", None)
    status, _, _ = S.handle(
        "GET", "/api/diagram-crop/1-album/01-song-one.json?si=0&bi=0&ei=0", b"", root
    )
    assert status == 404


def test_diagram_crop_requires_coords(tmp_path, monkeypatch):
    root = _corpus(tmp_path)
    monkeypatch.setattr(S, "PDF_DIR", tmp_path)  # exists but has no PDFs
    status, _, _ = S.handle("GET", "/api/diagram-crop/1-album/01-song-one.json", b"", root)
    assert status == 400
    status2, _, body = S.handle(
        "GET", "/api/diagram-crop/1-album/01-song-one.json?si=0&bi=0&ei=0", b"", root
    )
    assert status2 == 404  # no matching PDF
    assert "no PDF" in json.loads(body)["error"]


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


def test_query_string_is_ignored(tmp_path):
    root = _corpus(tmp_path)
    status, _, body = S.handle("GET", "/api/song/1-album/01-song-one.json?t=7", b"", root)
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
    status, _, body = S.handle(
        "POST", "/api/song/1-album/01-song-one.json", json.dumps(doc).encode(), root
    )
    assert status == 200
    assert json.loads(body)["ok"] is True
    on_disk = json.loads((root / "1-album" / "01-song-one.json").read_text())
    assert on_disk["songs"][0]["sections"][0]["bars"][0][0]["chord"] == "Am7"


def test_save_stamps_schema_version(tmp_path):
    root = _corpus(tmp_path)
    doc = json.loads((root / "1-album" / "01-song-one.json").read_text())
    assert "schema_version" not in doc  # fixture predates stamping
    status, _, _ = S.handle(
        "POST", "/api/song/1-album/01-song-one.json", json.dumps(doc).encode(), root
    )
    assert status == 200
    on_disk = json.loads((root / "1-album" / "01-song-one.json").read_text())
    assert on_disk["schema_version"] == SCHEMA_VERSION


def test_save_rejects_future_schema_version(tmp_path):
    root = _corpus(tmp_path)
    doc = json.loads((root / "1-album" / "01-song-one.json").read_text())
    doc["schema_version"] = 99
    status, _, body = S.handle(
        "POST", "/api/song/1-album/01-song-one.json", json.dumps(doc).encode(), root
    )
    assert status == 422
    assert "newer than supported" in json.loads(body)["error"]
    on_disk = json.loads((root / "1-album" / "01-song-one.json").read_text())
    assert "schema_version" not in on_disk  # original untouched


def test_save_invalid_song_rejected(tmp_path):
    root = _corpus(tmp_path)
    doc = json.loads((root / "1-album" / "01-song-one.json").read_text())
    doc["songs"][0]["sections"][0]["bars"][0][0] = {"voicing": "x,5,7,5,6,x"}
    status, _, body = S.handle(
        "POST", "/api/song/1-album/01-song-one.json", json.dumps(doc).encode(), root
    )
    assert status == 422
    assert json.loads(body)["ok"] is False
    on_disk = json.loads((root / "1-album" / "01-song-one.json").read_text())
    assert on_disk["songs"][0]["sections"][0]["bars"][0][0]["chord"] == "Dm7"


@pytest.mark.parametrize("payload", [None, [], "song", 1, True])
def test_save_non_object_rejected_without_touching_file(tmp_path, payload):
    root = _corpus(tmp_path)
    target = root / "1-album" / "01-song-one.json"
    original = target.read_bytes()
    status, _, body = S.handle(
        "POST", "/api/song/1-album/01-song-one.json", json.dumps(payload).encode(), root
    )
    assert status == 422
    assert json.loads(body)["ok"] is False
    assert target.read_bytes() == original


def test_save_refuses_to_replace_future_document_on_disk(tmp_path):
    root = _corpus(tmp_path)
    target = root / "1-album" / "01-song-one.json"
    candidate = target.read_bytes()
    future = json.loads(candidate)
    future["schema_version"] = 99
    target.write_text(json.dumps(future))
    original = target.read_bytes()

    status, _, body = S.handle("POST", "/api/song/1-album/01-song-one.json", candidate, root)
    assert status == 422
    assert "newer than supported" in json.loads(body)["error"]
    assert target.read_bytes() == original


def test_save_failed_atomic_replace_preserves_original(tmp_path, monkeypatch):
    root = _corpus(tmp_path)
    target = root / "1-album" / "01-song-one.json"
    original = target.read_bytes()
    doc = json.loads(original)
    doc["songs"][0]["title"] = "Edited"

    def fail_replace(*args):
        raise OSError("simulated replace failure")

    monkeypatch.setattr(os, "replace", fail_replace)
    status, _, body = S.handle(
        "POST", "/api/song/1-album/01-song-one.json", json.dumps(doc).encode(), root
    )
    assert status == 500
    assert "simulated replace failure" in json.loads(body)["error"]
    assert target.read_bytes() == original
    assert sorted(p.name for p in target.parent.iterdir()) == [target.name, "pages"]


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


def test_chordmark_source(tmp_path):
    root = _corpus(tmp_path)
    status, ctype, body = S.handle("GET", "/api/chordmark/1-album/01-song-one.json", b"", root)
    assert status == 200
    assert ctype.startswith("text/plain")
    assert b"Dm7" in body


def test_chordmark_source_ignores_query(tmp_path):
    root = _corpus(tmp_path)
    status, _, body = S.handle("GET", "/api/chordmark/1-album/01-song-one.json?t=9", b"", root)
    assert status == 200
    assert b"Dm7" in body


def test_chordmark_missing_404(tmp_path):
    root = _corpus(tmp_path)
    status, _, _ = S.handle("GET", "/api/chordmark/1-album/nope.json", b"", root)
    assert status == 404


def test_chordmark_rejects_path_traversal(tmp_path):
    root = _corpus(tmp_path)
    status, _, _ = S.handle("GET", "/api/chordmark/../evil.json", b"", root)
    assert status == 400


def test_export_chordmark(tmp_path):
    root = _corpus(tmp_path)
    result = S.handle("GET", "/api/export/1-album/01-song-one.json?fmt=chordmark", b"", root)
    status, ctype, body = result[0], result[1], result[2]
    headers = result[3]
    assert status == 200
    assert ctype.startswith("text/plain")
    assert b"Dm7" in body
    assert ".chordmark" in headers["Content-Disposition"]
    assert "attachment" in headers["Content-Disposition"]


def test_export_chordpro(tmp_path):
    root = _corpus(tmp_path)
    result = S.handle("GET", "/api/export/1-album/01-song-one.json?fmt=chordpro", b"", root)
    status, ctype, body = result[0], result[1], result[2]
    headers = result[3]
    assert status == 200
    assert ctype.startswith("text/plain")
    assert b"{title:" in body
    assert b"[Dm7]" in body
    assert ".chordpro" in headers["Content-Disposition"]
    assert "attachment" in headers["Content-Disposition"]


def test_render_doc_target(tmp_path):
    root = _corpus(tmp_path)
    doc = json.loads((root / "1-album" / "01-song-one.json").read_text())
    status, ctype, body = S.handle(
        "POST", "/api/render-doc?style=target&bars=4", json.dumps(doc).encode(), root
    )
    assert status == 200
    assert ctype == "text/html"
    assert b'class="ln"' in body


def test_render_doc_bad_json_400(tmp_path):
    root = _corpus(tmp_path)
    status, _, _ = S.handle("POST", "/api/render-doc?style=target", b"{not json", root)
    assert status == 400


def test_chordmark_doc(tmp_path):
    root = _corpus(tmp_path)
    doc = json.loads((root / "1-album" / "01-song-one.json").read_text())
    status, ctype, body = S.handle("POST", "/api/chordmark-doc", json.dumps(doc).encode(), root)
    assert status == 200
    assert ctype.startswith("text/plain")
    assert b"Dm7" in body


def test_chordmark_doc_bad_json_400(tmp_path):
    root = _corpus(tmp_path)
    status, _, _ = S.handle("POST", "/api/chordmark-doc", b"{not json", root)
    assert status == 400


def test_export_html(tmp_path):
    root = _corpus(tmp_path)
    result = S.handle(
        "GET", "/api/export/1-album/01-song-one.json?fmt=html&style=target", b"", root
    )
    status, ctype, body = result[0], result[1], result[2]
    headers = result[3]
    assert status == 200
    assert ctype == "text/html"
    assert b"<!doctype html>" in body
    assert ".html" in headers["Content-Disposition"]
    assert "attachment" in headers["Content-Disposition"]


def test_export_rejects_path_traversal(tmp_path):
    root = _corpus(tmp_path)
    status, _, _ = S.handle("GET", "/api/export/../x.json?fmt=html", b"", root)
    assert status == 400


def test_render_target_style(tmp_path):
    root = _corpus(tmp_path)
    status, ctype, body = S.handle(
        "GET", "/api/render/1-album/01-song-one.json?style=target", b"", root
    )
    assert status == 200
    assert ctype == "text/html"
    assert b"<!doctype html>" in body
    assert b"Song One" in body


# ---------------------------------------------------------------------------
# /api/harmony — harmonic analysis (Phase B)
# ---------------------------------------------------------------------------


def test_harmony_get(tmp_path):
    root = _corpus(tmp_path)
    status, ctype, body = S.handle("GET", "/api/harmony/1-album/01-song-one.json", b"", root)
    assert status == 200
    assert ctype == "application/json"
    data = json.loads(body)
    assert set(data) == {"key", "events", "devices", "summary"}
    assert data["events"][0]["symbol"] == "Dm7"
    assert data["events"][0]["confidence"] in ("high", "medium", "low")


def test_harmony_get_missing_404(tmp_path):
    root = _corpus(tmp_path)
    status, _, _ = S.handle("GET", "/api/harmony/1-album/nope.json", b"", root)
    assert status == 404


def test_harmony_rejects_path_traversal(tmp_path):
    root = _corpus(tmp_path)
    status, _, _ = S.handle("GET", "/api/harmony/../x.json", b"", root)
    assert status == 400


def test_harmony_doc_post(tmp_path):
    root = _corpus(tmp_path)
    doc = {
        "document": {"title": "t"},
        "songs": [
            {
                "title": "s",
                "key": "C",
                "sections": [
                    {
                        "label": None,
                        "bars": [[{"chord": "Dm7"}], [{"chord": "G7"}], [{"chord": "Cmaj7"}]],
                    }
                ],
            }
        ],
    }
    status, ctype, body = S.handle("POST", "/api/harmony-doc", json.dumps(doc).encode(), root)
    assert status == 200
    data = json.loads(body)
    assert data["key"]["tonic_name"] == "C" and data["key"]["how"] == "stored"
    assert any(d["type"] == "ii-V-I" for d in data["devices"])


def test_harmony_doc_bad_json_400(tmp_path):
    root = _corpus(tmp_path)
    status, _, _ = S.handle("POST", "/api/harmony-doc", b"{nope", root)
    assert status == 400


def test_harmony_doc_no_songs_400(tmp_path):
    root = _corpus(tmp_path)
    status, _, _ = S.handle(
        "POST", "/api/harmony-doc", b'{"document": {"title": "t"}, "songs": []}', root
    )
    assert status == 400


def test_harmony_doc_analyzes_first_song_only(tmp_path):
    root = _corpus(tmp_path)
    doc = {
        "document": {"title": "t"},
        "songs": [
            {"title": "first", "sections": [{"label": None, "bars": [[{"chord": "C"}]]}]},
            {
                "title": "second",
                "sections": [{"label": None, "bars": [[{"chord": "D"}], [{"chord": "E"}]]}],
            },
        ],
    }
    status, _, body = S.handle("POST", "/api/harmony-doc", json.dumps(doc).encode(), root)
    assert status == 200
    assert json.loads(body)["summary"]["events"] == 1  # songs[0] only


# ---------------------------------------------------------------------------
# /api/convert — HTML body -> PDF/PNG via headless Chrome (Harmony exports)
# ---------------------------------------------------------------------------


def test_convert_pdf(tmp_path, monkeypatch):
    root = _corpus(tmp_path)
    monkeypatch.setattr(S, "_chrome_convert", lambda html, fmt: b"%PDF-fake")
    result = S.handle("POST", "/api/convert?fmt=pdf&name=my song", b"<html>x</html>", root)
    status, ctype, body, headers = result
    assert status == 200
    assert ctype == "application/pdf"
    assert body == b"%PDF-fake"
    assert 'filename="my-song.pdf"' in headers["Content-Disposition"]


def test_convert_bad_fmt_400(tmp_path):
    root = _corpus(tmp_path)
    status, _, _ = S.handle("POST", "/api/convert?fmt=exe", b"<html>x</html>", root)
    assert status == 400


def test_convert_empty_body_400(tmp_path):
    root = _corpus(tmp_path)
    status, _, _ = S.handle("POST", "/api/convert?fmt=pdf", b"", root)
    assert status == 400


def test_convert_chrome_failure_500(tmp_path, monkeypatch):
    root = _corpus(tmp_path)

    def boom(html, fmt):
        raise RuntimeError("Chrome not found")

    monkeypatch.setattr(S, "_chrome_convert", boom)
    status, _, _ = S.handle("POST", "/api/convert?fmt=pdf", b"<html>x</html>", root)
    assert status == 500
