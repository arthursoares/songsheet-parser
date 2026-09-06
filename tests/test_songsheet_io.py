import json
import os
import stat

import pytest
import songsheet_io as IO
from songsheet_version import SCHEMA_VERSION


@pytest.fixture
def document():
    return {
        "document": {"title": "Album", "status": "done"},
        "songs": [{"title": "Canção", "sections": [{"bars": [[{"chord": "C"}]]}]}],
        "_meta": {"source": "test"},
    }


def test_save_publishes_complete_document_and_preserves_permissions(
    tmp_path, document, monkeypatch
):
    path = tmp_path / "song.json"
    original = json.dumps(document).encode()
    path.write_bytes(original)
    path.chmod(0o640)
    document["songs"][0]["note"] = "Reviewed"
    replace = os.replace

    def inspect_replace(source, target):
        assert source.parent == target.parent
        assert target.read_bytes() == original
        candidate = json.loads(source.read_bytes())
        assert candidate["schema_version"] == SCHEMA_VERSION
        assert candidate["songs"][0]["note"] == "Reviewed"
        replace(source, target)

    monkeypatch.setattr(os, "replace", inspect_replace)
    IO.save_document(path, document, overwrite=True)
    saved = IO.load_document(path)
    assert saved == {**document, "schema_version": SCHEMA_VERSION}
    assert "schema_version" not in document
    assert stat.S_IMODE(path.stat().st_mode) == 0o640
    assert list(tmp_path.iterdir()) == [path]


def test_failed_flush_preserves_original_and_removes_temp(tmp_path, document, monkeypatch):
    path = tmp_path / "song.json"
    original = json.dumps(document).encode()
    path.write_bytes(original)
    document["songs"][0]["title"] = "Edited"

    def fail_flush(fd):
        raise OSError("simulated flush failure")

    monkeypatch.setattr(os, "fsync", fail_flush)
    with pytest.raises(OSError, match="flush failure"):
        IO.save_document(path, document, overwrite=True)
    assert path.read_bytes() == original
    assert list(tmp_path.iterdir()) == [path]


def test_create_only_cannot_clobber_file_created_after_preflight(tmp_path, document, monkeypatch):
    path = tmp_path / "song.json"
    competing = json.dumps({**document, "_meta": {"source": "another writer"}}).encode()
    link = os.link

    def create_competing_file(source, target):
        target.write_bytes(competing)
        link(source, target)

    monkeypatch.setattr(os, "link", create_competing_file)
    with pytest.raises(FileExistsError):
        IO.save_document(path, document)
    assert path.read_bytes() == competing
    assert list(tmp_path.iterdir()) == [path]


def test_create_only_does_not_replace_existing_file(tmp_path, document):
    path = tmp_path / "song.json"
    IO.save_document(path, document)
    original = path.read_bytes()
    document["songs"][0]["title"] = "Edited"
    with pytest.raises(FileExistsError):
        IO.save_document(path, document)
    assert path.read_bytes() == original


def test_new_document_uses_normal_file_creation_permissions(tmp_path, document):
    ordinary = tmp_path / "ordinary.json"
    ordinary.write_text("{}")
    path = tmp_path / "song.json"
    IO.save_document(path, document)
    assert stat.S_IMODE(path.stat().st_mode) == stat.S_IMODE(ordinary.stat().st_mode)


@pytest.mark.parametrize("original", [b'{"schema_version":99}', b'{"schema_version":false}', b"{"])
def test_overwrite_does_not_destroy_unsupported_or_unreadable_file(tmp_path, document, original):
    path = tmp_path / "song.json"
    path.write_bytes(original)
    with pytest.raises(IO.DocumentError):
        IO.save_document(path, document, overwrite=True)
    assert path.read_bytes() == original
    assert list(tmp_path.iterdir()) == [path]


@pytest.mark.parametrize("invalid_value", [float("nan"), object(), "\ud800"])
def test_unserializable_metadata_is_rejected_before_touching_file(
    tmp_path, document, invalid_value
):
    path = tmp_path / "song.json"
    IO.save_document(path, document)
    original = path.read_bytes()
    document["_meta"]["bad"] = invalid_value
    with pytest.raises(IO.DocumentError, match="serializable"):
        IO.save_document(path, document, overwrite=True)
    assert path.read_bytes() == original
    assert list(tmp_path.iterdir()) == [path]
