import json
import sys
from pathlib import Path

import pytest

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
    assert all(d["doc"]["schema_version"] == M.stamp({})["schema_version"] for d in docs)
    assert docs[0]["doc"]["document"]["title"] == "Album"
    assert len(docs[0]["doc"]["songs"]) == 1
    assert docs[1]["doc"]["songs"][0]["title"] == "Song Two"
    assert docs[1]["pages"] == [2, 3]


def test_migrate_voicing_old_to_comma():
    assert M.migrate_voicing("x5756x") == "x,5,7,5,6,x"
    assert M.migrate_voicing("022100") == "0,2,2,1,0,0"


def test_migrate_voicing_passthrough_and_unmigratable():
    assert M.migrate_voicing("x,5,7,5,6,x") == "x,5,7,5,6,x"  # already comma
    assert M.migrate_voicing("x91110119") is None  # overflow, not splittable
    assert M.migrate_voicing(None) is None


def test_split_songs_migrates_voicings_and_drops_overflow():
    assembled = {
        "document": {"title": "A"},
        "songs": [
            {
                "title": "S",
                "pages": [1],
                "chords": {"Dm7": [{"voicing": "x5756x"}]},
                "sections": [
                    {
                        "label": None,
                        "bars": [
                            [{"chord": "Dm7", "voicing": "x5756x"}],
                            [{"chord": "F#maj7", "voicing": "x91110119"}],
                        ],
                    }
                ],
            }
        ],
    }
    docs = M.split_songs(assembled)
    bars = docs[0]["doc"]["songs"][0]["sections"][0]["bars"]
    assert bars[0][0]["voicing"] == "x,5,7,5,6,x"  # migrated
    assert "voicing" not in bars[1][0]  # overflow dropped
    assert docs[0]["doc"]["songs"][0]["chords"]["Dm7"][0]["voicing"] == "x,5,7,5,6,x"


def test_materialize_one_writes_json_and_copies_pages(tmp_path):
    stem = "1 - Album"
    work = tmp_path / "ssv" / stem
    work.mkdir(parents=True)
    assembled = {
        "document": {"title": "Album", "source_pdf": "Album.pdf"},
        "songs": [
            {"title": "Song Two", "pages": [2, 3], "sections": [{"label": None, "bars": []}]}
        ],
    }
    (work / "_assembled.json").write_text(json.dumps(assembled))
    for n in (1, 2, 3):
        (work / f"page-{n:03d}.png").write_bytes(b"PNG" + bytes([n]))

    out = tmp_path / "songs"
    written = M.materialize_one(work / "_assembled.json", out)

    song_json = out / "1-album" / "01-song-two.json"
    assert song_json.exists()
    assert song_json in written
    pages_dir = out / "1-album" / "pages"
    assert (pages_dir / "01-song-two-p2.png").exists()
    assert (pages_dir / "01-song-two-p3.png").exists()
    assert not (pages_dir / "01-song-two-p1.png").exists()


def _assembled_file(tmp_path, **extra):
    work = tmp_path / "work" / "Album"
    work.mkdir(parents=True)
    doc = {
        "document": {"title": "Album"},
        "songs": [
            {"title": "First", "pages": [1], "sections": [{"bars": [[{"chord": "C"}]]}]},
            {"title": "Second", "pages": [2], "sections": [{"bars": [[{"chord": "G"}]]}]},
        ],
        **extra,
    }
    source = work / "_assembled.json"
    source.write_text(json.dumps(doc))
    (work / "page-002.png").write_bytes(b"new scan")
    return source


def test_materialize_refuses_existing_corrections_before_writing_any_song(tmp_path):
    source = _assembled_file(tmp_path)
    out = tmp_path / "songs"
    album = out / "album"
    (album / "pages").mkdir(parents=True)
    existing = album / "02-second.json"
    original = b'{"document":{"title":"Album","status":"done"},"songs":[]}'
    existing.write_bytes(original)
    page = album / "pages" / "02-second-p2.png"
    page.write_bytes(b"reviewed scan")

    with pytest.raises(FileExistsError, match="overwrite"):
        M.materialize_one(source, out)

    assert existing.read_bytes() == original
    assert page.read_bytes() == b"reviewed scan"
    assert not (album / "01-first.json").exists()


def test_materialize_refuses_existing_page_without_song_json(tmp_path):
    source = _assembled_file(tmp_path)
    out = tmp_path / "songs"
    pages = out / "album" / "pages"
    pages.mkdir(parents=True)
    existing = pages / "02-second-p2.png"
    existing.write_bytes(b"reviewed scan")
    with pytest.raises(FileExistsError, match="overwrite"):
        M.materialize_one(source, out)
    assert existing.read_bytes() == b"reviewed scan"
    assert not list(out.rglob("*.json"))


def test_materialize_preserves_page_created_after_preflight(tmp_path, monkeypatch):
    source = _assembled_file(tmp_path)
    out = tmp_path / "songs"
    page = out / "album" / "pages" / "02-second-p2.png"
    save = M.save_document

    def save_then_create_page(*args, **kwargs):
        save(*args, **kwargs)
        page.write_bytes(b"another writer's scan")

    monkeypatch.setattr(M, "save_document", save_then_create_page)
    with pytest.raises(FileExistsError):
        M.materialize_one(source, out)
    assert page.read_bytes() == b"another writer's scan"


def test_materialize_copies_repeated_page_reference_once(tmp_path):
    source = _assembled_file(tmp_path)
    doc = json.loads(source.read_text())
    doc["songs"][1]["pages"] = [2, 2]
    source.write_text(json.dumps(doc))
    out = tmp_path / "songs"
    assert len(M.materialize_one(source, out)) == 2
    assert (out / "album" / "pages" / "02-second-p2.png").read_bytes() == b"new scan"


@pytest.mark.parametrize("version", [99, "99", True, 0])
def test_materialize_rejects_unsupported_source_version(tmp_path, version):
    source = _assembled_file(tmp_path, schema_version=version)
    out = tmp_path / "songs"
    with pytest.raises(ValueError, match="schema_version"):
        M.materialize_one(source, out)
    assert not list(out.rglob("*.json"))


def test_materialize_validates_all_songs_before_writing(tmp_path):
    source = _assembled_file(tmp_path)
    doc = json.loads(source.read_text())
    doc["songs"][1]["sections"][0]["bars"][0][0] = {"text": "missing chord"}
    source.write_text(json.dumps(doc))
    out = tmp_path / "songs"
    with pytest.raises(ValueError, match="chord"):
        M.materialize_one(source, out)
    assert not list(out.rglob("*.json"))


def test_materialize_cli_requires_explicit_overwrite(tmp_path, monkeypatch, capsys):
    source = _assembled_file(tmp_path)
    out = tmp_path / "songs"
    written = M.materialize_one(source, out)
    existing = written[1]
    reviewed = json.loads(existing.read_text())
    reviewed["document"]["status"] = "done"
    reviewed["songs"][0]["note"] = "manual correction"
    existing.write_text(json.dumps(reviewed))
    original = existing.read_bytes()
    page = existing.parent / "pages" / "02-second-p2.png"
    page.write_bytes(b"reviewed scan")
    argv = ["materialize_songs", "--workdir", str(source.parent.parent), "--out", str(out)]
    monkeypatch.setattr(sys, "argv", argv)
    with pytest.raises(SystemExit) as exc:
        M.main()
    assert exc.value.code == 1
    assert "--overwrite" in capsys.readouterr().err
    assert existing.read_bytes() == original
    assert page.read_bytes() == b"reviewed scan"

    monkeypatch.setattr(sys, "argv", [*argv, "--overwrite"])
    M.main()
    assert (
        json.loads(existing.read_text())["songs"][0] == json.loads(source.read_text())["songs"][1]
    )
    assert page.read_bytes() == b"new scan"


def test_materialize_overwrite_refuses_future_destination_before_any_writes(tmp_path):
    source = _assembled_file(tmp_path)
    out = tmp_path / "songs"
    album = out / "album"
    album.mkdir(parents=True)
    existing = album / "02-second.json"
    original = b'{"schema_version":99,"document":{"title":"Future"},"songs":[]}'
    existing.write_bytes(original)
    with pytest.raises(ValueError, match="newer than supported"):
        M.materialize_one(source, out, overwrite=True)
    assert existing.read_bytes() == original
    assert not (album / "01-first.json").exists()
