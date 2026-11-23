import base64
import copy
import json
import stat
from pathlib import Path

import pytest
import qa_shape_edits as edits
from extraction_provenance import attach_observations, file_sha256, json_sha256
from songsheet_io import load_document, save_document

OLD = "0,2,0,0,3,2"
NEW = "0,2,x,0,3,2"
MANUAL = "x,7,5,7,7,x"
MANUAL_LATER = "x,7,5,7,8,x"


def _write_song(root: Path, album: str, file: str, title: str, *, two=False):
    path = root / album / file
    path.parent.mkdir(parents=True, exist_ok=True)
    entries = [
        {
            "chord": "Em9",
            "voicing": OLD,
            "voicing_printed": NEW,
            "text": "keep lyric",
        }
    ]
    if two:
        entries.append(
            {
                "chord": "Em7/9",
                "voicing": OLD,
                "voicing_printed": NEW,
                "text": "also keep",
                "chord_review": {
                    "status": "deferred",
                    "snapshot": {
                        "chord": "Em7/9",
                        "voicing": OLD,
                        "voicing_printed": NEW,
                        "observation_id": None,
                    },
                },
            }
        )
    doc = {
        "document": {"title": "Album", "status": "in_progress"},
        "songs": [
            {
                "title": title,
                "note": "preserve song note",
                "sections": [{"label": "Verse", "bars": [entries]}],
            }
        ],
    }
    doc = attach_observations(doc, {"kind": "shape-edit-test", "file": file})
    # attach_observations snapshots the pre-link entry, so make an existing
    # review refer to the actual durable observation before initial save.
    if two:
        second = doc["songs"][0]["sections"][0]["bars"][0][1]
        second["chord_review"]["snapshot"]["observation_id"] = second["observation_id"]
    save_document(path, doc)
    return path


def _row(path: Path, root: Path, *, bi=0, ei=0, occurrence_id=None):
    doc = load_document(path)
    song = doc["songs"][0]
    entry = song["sections"][0]["bars"][bi][ei]
    return {
        "id": occurrence_id or f"occ-{path.parent.name}-{path.stem}-{ei}",
        "album": path.parent.name,
        "file": path.name,
        "title": song["title"],
        "song_index": 0,
        "si": 0,
        "bi": bi,
        "ei": ei,
        "label": entry["chord"],
        "editorial": entry["voicing"],
        "printed": entry["voicing_printed"],
        "document_sha256": file_sha256(path),
        "observation_id": entry.get("observation_id"),
        "editable": True,
        "page": None,
        "pdf": None,
        "pdf_sha256": None,
        "box": None,
        "basis": "Recorded observation evidence",
    }


def _group(*rows):
    return {"id": "shape-em9", "voicing": NEW, "occurrences": list(rows)}


def _entry(path, ei=0):
    return load_document(path)["songs"][0]["sections"][0]["bars"][0][ei]


def _attach_crop(path: Path) -> None:
    doc = load_document(path)
    entry = doc["songs"][0]["sections"][0]["bars"][0][0]
    observation_id = entry["observation_id"]
    record = {
        "observation_id": observation_id,
        "source_pdf": {"name": "Album.pdf", "sha256": "a" * 64},
        "page": 2,
        "native_image": {"width": 100, "height": 100, "sha256": "b" * 64},
        "crop_box": [10, 20, 30, 40],
        "voicing_printed": NEW,
        "original_symbol": "Em9",
    }
    doc["_meta"]["diagram_evidence"] = {
        observation_id: {"record": record, "record_sha256": json_sha256(record)}
    }
    save_document(path, doc, overwrite=True)


def test_apply_and_undo_multiple_files_preserve_nonselected_content(tmp_path):
    root, history = tmp_path / "songs", tmp_path / "history"
    first = _write_song(root, "a", "01.json", "First", two=True)
    second = _write_song(root, "b", "02.json", "Second")
    before = {first: first.read_bytes(), second: second.read_bytes()}
    first_row, second_row = _row(first, root), _row(second, root)
    unselected_before = copy.deepcopy(_entry(first, 1))

    result = edits.apply_shape_batch(
        root, history, _group(first_row, second_row), [first_row["id"], second_row["id"]]
    )

    assert result == {
        "ok": True,
        "batch_id": result["batch_id"],
        "songs": 2,
        "entries": 2,
        "files": [{"album": "a", "file": "01.json"}, {"album": "b", "file": "02.json"}],
    }
    for path in (first, second):
        entry = _entry(path)
        assert entry["voicing"] == NEW
        assert entry["voicing_printed"] == NEW
        assert entry["text"] == "keep lyric"
        assert entry["chord_review"] == {
            "status": "reviewed",
            "snapshot": {
                "chord": "Em9",
                "voicing": NEW,
                "voicing_printed": NEW,
                "observation_id": entry["observation_id"],
            },
        }
        assert load_document(path)["songs"][0]["note"] == "preserve song note"
    assert _entry(first, 1) == unselected_before

    batch_dir = history / result["batch_id"]
    assert stat.S_IMODE(history.stat().st_mode) == 0o700
    assert stat.S_IMODE(batch_dir.stat().st_mode) == 0o700
    assert stat.S_IMODE((batch_dir / "manifest.json").stat().st_mode) == 0o600

    undone = edits.undo_shape_batch(root, history, result["batch_id"])
    assert undone == result
    assert {path: path.read_bytes() for path in (first, second)} == before
    with pytest.raises(edits.ShapeEditError, match="not currently applied"):
        edits.undo_shape_batch(root, history, result["batch_id"])


def test_apply_rejects_stale_original_before_creating_history(tmp_path):
    root, history = tmp_path / "songs", tmp_path / "history"
    path = _write_song(root, "a", "01.json", "First")
    row = _row(path, root)
    doc = load_document(path)
    doc["songs"][0]["note"] = "changed concurrently"
    save_document(path, doc, overwrite=True)
    changed = path.read_bytes()

    with pytest.raises(edits.ShapeEditError, match="stale song document"):
        edits.apply_shape_batch(root, history, _group(row), [row["id"]])

    assert path.read_bytes() == changed
    assert not history.exists()


def test_apply_verifies_absent_observation_identity_for_trusted_legacy_row(tmp_path):
    root, history = tmp_path / "songs", tmp_path / "history"
    path = root / "a" / "01.json"
    path.parent.mkdir(parents=True)
    save_document(
        path,
        {
            "document": {"title": "Album"},
            "songs": [
                {
                    "title": "Legacy",
                    "sections": [
                        {
                            "bars": [
                                [
                                    {
                                        "chord": "Em9",
                                        "voicing": OLD,
                                        "voicing_printed": NEW,
                                    }
                                ]
                            ]
                        }
                    ],
                }
            ],
        },
    )
    row = _row(path, root)
    assert row["observation_id"] is None
    row["basis"] = "legacy_exact_count"

    result = edits.apply_shape_batch(root, history, _group(row), [row["id"]])

    assert result["entries"] == 1
    assert _entry(path)["chord_review"]["snapshot"]["observation_id"] is None


def test_manual_override_can_replace_editorial_voicing_that_already_matches_print(tmp_path):
    root, history = tmp_path / "songs", tmp_path / "history"
    path = _write_song(root, "a", "01.json", "First")
    doc = load_document(path)
    entry = doc["songs"][0]["sections"][0]["bars"][0][0]
    entry["voicing"] = NEW
    save_document(path, doc, overwrite=True)
    row = _row(path, root)

    result = edits.apply_shape_batch(root, history, _group(row), [row["id"]], voicing=MANUAL)

    corrected = _entry(path)
    assert result["entries"] == 1
    assert corrected["chord"] == "Em9"
    assert corrected["voicing"] == MANUAL
    assert corrected["voicing_printed"] == NEW
    assert corrected["text"] == "keep lyric"
    assert corrected["chord_review"]["snapshot"] == {
        "chord": "Em9",
        "voicing": MANUAL,
        "voicing_printed": NEW,
        "observation_id": corrected["observation_id"],
    }


def test_explicit_chord_can_rename_without_changing_fingering(tmp_path):
    root, history = tmp_path / "songs", tmp_path / "history"
    path = _write_song(root, "a", "01.json", "First")
    doc = load_document(path)
    entry = doc["songs"][0]["sections"][0]["bars"][0][0]
    entry["voicing"] = NEW
    save_document(path, doc, overwrite=True)
    row = _row(path, root)

    result = edits.apply_shape_batch(root, history, _group(row), [row["id"]], chord="Em7/9")

    corrected = _entry(path)
    assert result["entries"] == 1
    assert corrected["chord"] == "Em7/9"
    assert corrected["voicing"] == NEW
    assert corrected["voicing_printed"] == NEW
    assert corrected["text"] == "keep lyric"
    assert corrected["chord_review"] == {
        "status": "reviewed",
        "snapshot": {
            "chord": "Em7/9",
            "voicing": NEW,
            "voicing_printed": NEW,
            "observation_id": corrected["observation_id"],
        },
    }


def test_explicit_chord_and_voicing_apply_and_undo_across_files(tmp_path):
    root, history = tmp_path / "songs", tmp_path / "history"
    first = _write_song(root, "a", "01.json", "First")
    second = _write_song(root, "b", "02.json", "Second")
    before = {first: first.read_bytes(), second: second.read_bytes()}
    rows = [_row(first, root), _row(second, root)]

    result = edits.apply_shape_batch(
        root,
        history,
        _group(*rows),
        [row["id"] for row in rows],
        chord="Em7/9",
        voicing=MANUAL,
    )

    for path in (first, second):
        corrected = _entry(path)
        assert corrected["chord"] == "Em7/9"
        assert corrected["voicing"] == MANUAL
        assert corrected["voicing_printed"] == NEW
        assert corrected["text"] == "keep lyric"
        assert corrected["chord_review"]["snapshot"]["chord"] == "Em7/9"
        assert corrected["chord_review"]["snapshot"]["voicing"] == MANUAL

    shape = json.loads((history / result["batch_id"] / "shape.json").read_text())
    assert set(shape) == {"version", "group_id", "voicing", "created_order"}
    assert shape["voicing"] == MANUAL

    assert edits.undo_shape_batch(root, history, result["batch_id"]) == result
    assert {path: path.read_bytes() for path in (first, second)} == before


def test_omitted_chord_preserves_selected_occurrence_name(tmp_path):
    root, history = tmp_path / "songs", tmp_path / "history"
    path = _write_song(root, "a", "01.json", "First")
    row = _row(path, root)

    edits.apply_shape_batch(root, history, _group(row), [row["id"]], voicing=MANUAL)

    corrected = _entry(path)
    assert corrected["chord"] == "Em9"
    assert corrected["chord_review"]["snapshot"]["chord"] == "Em9"


@pytest.mark.parametrize(
    "chord",
    ["", 7, True, " Em7", "Em 7", "Em7%", "Em7\n", "H7", "Em7\u200b"],
)
def test_explicit_chord_rejects_invalid_target(tmp_path, chord):
    root, history = tmp_path / "songs", tmp_path / "history"
    path = _write_song(root, "a", "01.json", "First")
    row = _row(path, root)
    before = path.read_bytes()

    with pytest.raises(edits.ShapeEditError, match="invalid target chord"):
        edits.apply_shape_batch(root, history, _group(row), [row["id"]], chord=chord)

    assert path.read_bytes() == before
    assert not history.exists()


@pytest.mark.parametrize("chord", ["Gm7/9", "C7+", "Dm7(♭5)", "F#maj7/A#", "A13(b9)"])
def test_explicit_chord_accepts_supported_brazilian_and_chordmark_dialects(chord):
    assert edits._valid_chord(chord)


def test_explicit_chord_and_voicing_both_unchanged_is_rejected(tmp_path):
    root, history = tmp_path / "songs", tmp_path / "history"
    path = _write_song(root, "a", "01.json", "First")
    row = _row(path, root)
    before = path.read_bytes()

    with pytest.raises(edits.ShapeEditError, match="does not need correction"):
        edits.apply_shape_batch(root, history, _group(row), [row["id"]], chord="Em9", voicing=OLD)

    assert path.read_bytes() == before
    assert not history.exists()


def test_linked_observation_remains_valid_after_entry_moves(tmp_path):
    root, history = tmp_path / "songs", tmp_path / "history"
    path = _write_song(root, "a", "01.json", "First")
    _attach_crop(path)
    doc = load_document(path)
    section = doc["songs"][0]["sections"][0]
    section["bars"].insert(0, [])
    save_document(path, doc, overwrite=True)
    row = _row(path, root, bi=1)
    row.update(page=2, pdf="/source/Album.pdf", pdf_sha256="a" * 64, box=[10, 20, 30, 40])
    observation = load_document(path)["_meta"]["observations"][row["observation_id"]]
    assert observation["position"] == [0, 0, 0, 0]

    result = edits.apply_shape_batch(root, history, _group(row), [row["id"]])

    assert result["entries"] == 1
    assert load_document(path)["songs"][0]["sections"][0]["bars"][1][0]["voicing"] == NEW


@pytest.mark.parametrize("voicing", ["", "0,1,2,3,4", "0,1,2,3,4,25", "0,1,2,3,-1,x"])
def test_manual_override_rejects_invalid_target(tmp_path, voicing):
    root, history = tmp_path / "songs", tmp_path / "history"
    path = _write_song(root, "a", "01.json", "First")
    row = _row(path, root)
    before = path.read_bytes()

    with pytest.raises(edits.ShapeEditError, match="invalid target voicing"):
        edits.apply_shape_batch(root, history, _group(row), [row["id"]], voicing=voicing)

    assert path.read_bytes() == before
    assert not history.exists()


def test_latest_shape_correction_falls_back_after_undo(tmp_path, monkeypatch):
    root, history = tmp_path / "songs", tmp_path / "history"
    path = _write_song(root, "a", "01.json", "First")
    orders = iter((100, 200))
    monkeypatch.setattr(edits.time, "time_ns", lambda: next(orders))

    first_row = _row(path, root)
    first = edits.apply_shape_batch(
        root, history, _group(first_row), [first_row["id"]], voicing=MANUAL
    )
    assert edits.latest_shape_corrections(history) == {"shape-em9": MANUAL}
    first_sidecar = json.loads((history / first["batch_id"] / "shape.json").read_text())
    assert first_sidecar == {
        "version": 1,
        "group_id": "shape-em9",
        "voicing": MANUAL,
        "created_order": 100,
    }

    second_row = _row(path, root)
    second = edits.apply_shape_batch(
        root,
        history,
        _group(second_row),
        [second_row["id"]],
        voicing=MANUAL_LATER,
    )
    assert edits.latest_shape_corrections(history) == {"shape-em9": MANUAL_LATER}

    edits.undo_shape_batch(root, history, second["batch_id"])
    assert edits.latest_shape_corrections(history) == {"shape-em9": MANUAL}
    edits.undo_shape_batch(root, history, first["batch_id"])
    assert edits.latest_shape_corrections(history) == {}


def test_undo_rejects_stale_after_content_without_reverting_any_file(tmp_path):
    root, history = tmp_path / "songs", tmp_path / "history"
    first = _write_song(root, "a", "01.json", "First")
    second = _write_song(root, "b", "02.json", "Second")
    rows = [_row(first, root), _row(second, root)]
    result = edits.apply_shape_batch(root, history, _group(*rows), [row["id"] for row in rows])
    second_after = second.read_bytes()
    doc = load_document(first)
    doc["songs"][0]["note"] = "post-batch edit"
    save_document(first, doc, overwrite=True)
    first_changed = first.read_bytes()

    with pytest.raises(edits.ShapeEditError, match="stale song prevents undo"):
        edits.undo_shape_batch(root, history, result["batch_id"])

    assert first.read_bytes() == first_changed
    assert second.read_bytes() == second_after


@pytest.mark.parametrize(
    ("mutate", "selected", "message"),
    [
        (lambda row: row.update(album=".."), None, "unsafe song path"),
        (lambda row: row.update(file="../01.json"), None, "unsafe song path"),
        (lambda row: row.update(editable=False), None, "not editable"),
        (lambda row: row.update(printed="3,2,0,0,0,3"), None, "different shape group"),
        (lambda row: row.update(editorial="3,2,0,0,0,3"), None, "editorial voicing"),
        (lambda row: row.update(group_id="another-group"), None, "different shape group"),
        (lambda row: None, ["unknown"], "not in this shape group"),
    ],
)
def test_invalid_paths_selections_and_occurrence_claims_are_rejected(
    tmp_path, mutate, selected, message
):
    root, history = tmp_path / "songs", tmp_path / "history"
    path = _write_song(root, "a", "01.json", "First")
    row = _row(path, root)
    before = path.read_bytes()
    mutate(row)

    with pytest.raises(edits.ShapeEditError, match=message):
        edits.apply_shape_batch(root, history, _group(row), selected or [row["id"]])

    assert path.read_bytes() == before


def test_partial_write_failure_rolls_back_only_known_after_content(tmp_path, monkeypatch):
    root, history = tmp_path / "songs", tmp_path / "history"
    first = _write_song(root, "a", "01.json", "First")
    second = _write_song(root, "b", "02.json", "Second")
    before = {first: first.read_bytes(), second: second.read_bytes()}
    rows = [_row(first, root), _row(second, root)]
    real_save = edits.save_document
    calls = 0

    def fail_second(path, doc, *, overwrite=False):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("injected publication failure")
        return real_save(path, doc, overwrite=overwrite)

    monkeypatch.setattr(edits, "save_document", fail_second)
    with pytest.raises(edits.ShapeEditError, match="was not applied"):
        edits.apply_shape_batch(root, history, _group(*rows), [row["id"] for row in rows])

    assert {path: path.read_bytes() for path in (first, second)} == before
    state_files = list(history.glob("shape-*/state.json"))
    assert len(state_files) == 1
    assert json.loads(state_files[0].read_text()) == {"state": "rolled_back"}


def test_undo_rejects_tampered_private_snapshot(tmp_path):
    root, history = tmp_path / "songs", tmp_path / "history"
    path = _write_song(root, "a", "01.json", "First")
    row = _row(path, root)
    result = edits.apply_shape_batch(root, history, _group(row), [row["id"]])
    after = path.read_bytes()
    manifest_path = history / result["batch_id"] / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["files"][0]["before_base64"] = "YmFk"
    manifest_path.write_text(json.dumps(manifest))

    with pytest.raises(edits.ShapeEditError, match="snapshot digest mismatch"):
        edits.undo_shape_batch(root, history, result["batch_id"])

    assert path.read_bytes() == after


def _batch_manifest(history, batch_id):
    batch_dir = history / batch_id
    return batch_dir, json.loads((batch_dir / "manifest.json").read_text())


def _snapshot(saved, which):
    return base64.b64decode(saved[f"{which}_base64"])


def test_recover_rolls_back_interrupted_partial_apply(tmp_path):
    root, history = tmp_path / "songs", tmp_path / "history"
    first = _write_song(root, "a", "01.json", "First")
    second = _write_song(root, "b", "02.json", "Second")
    rows = [_row(first, root), _row(second, root)]
    result = edits.apply_shape_batch(root, history, _group(*rows), [row["id"] for row in rows])
    batch_dir, manifest = _batch_manifest(history, result["batch_id"])
    saved = {(item["album"], item["file"]): item for item in manifest["files"]}
    # Simulate death after the first replacement: the apply intent is still
    # prepared, one file is after, and the other remains before.
    second.write_bytes(_snapshot(saved[("b", "02.json")], "before"))
    (batch_dir / "state.json").write_text(json.dumps({"state": "prepared"}))

    recovered = edits.recover_shape_batches(root, history)

    assert recovered == {
        "ok": True,
        "batches": 1,
        "files": 1,
        "recovered": [{"batch_id": result["batch_id"], "state": "rolled_back"}],
    }
    assert first.read_bytes() == _snapshot(saved[("a", "01.json")], "before")
    assert second.read_bytes() == _snapshot(saved[("b", "02.json")], "before")
    assert json.loads((batch_dir / "state.json").read_text()) == {"state": "rolled_back"}
    assert edits.recover_shape_batches(root, history)["batches"] == 0


def test_recover_completes_interrupted_partial_undo(tmp_path):
    root, history = tmp_path / "songs", tmp_path / "history"
    first = _write_song(root, "a", "01.json", "First")
    second = _write_song(root, "b", "02.json", "Second")
    rows = [_row(first, root), _row(second, root)]
    result = edits.apply_shape_batch(root, history, _group(*rows), [row["id"] for row in rows])
    batch_dir, manifest = _batch_manifest(history, result["batch_id"])
    saved = {(item["album"], item["file"]): item for item in manifest["files"]}
    # Undo intent is durable before the first replacement. Simulate death with
    # one restored file and one still-applied file.
    first.write_bytes(_snapshot(saved[("a", "01.json")], "before"))
    (batch_dir / "state.json").write_text(json.dumps({"state": "undoing"}))

    recovered = edits.recover_shape_batches(root, history)

    assert recovered["recovered"] == [{"batch_id": result["batch_id"], "state": "undone"}]
    assert recovered["files"] == 1
    assert first.read_bytes() == _snapshot(saved[("a", "01.json")], "before")
    assert second.read_bytes() == _snapshot(saved[("b", "02.json")], "before")
    assert json.loads((batch_dir / "state.json").read_text()) == {"state": "undone"}


def test_recovery_conflict_is_surfaced_before_any_recovery_write(tmp_path):
    root, history = tmp_path / "songs", tmp_path / "history"
    first = _write_song(root, "a", "01.json", "First")
    second = _write_song(root, "b", "02.json", "Second")
    rows = [_row(first, root), _row(second, root)]
    result = edits.apply_shape_batch(root, history, _group(*rows), [row["id"] for row in rows])
    batch_dir, _manifest = _batch_manifest(history, result["batch_id"])
    first_after = first.read_bytes()
    second.write_bytes(b"external content")
    (batch_dir / "state.json").write_text(json.dumps({"state": "prepared"}))

    with pytest.raises(edits.ShapeEditError, match="batch recovery conflict"):
        edits.recover_shape_batches(root, history)

    assert first.read_bytes() == first_after
    assert second.read_bytes() == b"external content"
    assert json.loads((batch_dir / "state.json").read_text()) == {"state": "prepared"}
