import json
import sys
from collections.abc import Callable
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import qa_server as server
import qa_shape_routes as routes
from extraction_provenance import file_sha256
from songsheet_io import load_document, save_document

EDITORIAL = "0,2,0,0,3,2"
PRINTED = "0,2,x,0,3,2"


def _chart(root, album, file, label, title):
    path = root / album / file
    path.parent.mkdir(parents=True, exist_ok=True)
    save_document(
        path,
        {
            "document": {"title": "Test album"},
            "songs": [
                {
                    "title": title,
                    "sections": [
                        {
                            "bars": [
                                [{"chord": label, "voicing": EDITORIAL, "voicing_printed": PRINTED}]
                            ]
                        }
                    ],
                }
            ],
        },
    )
    return {
        "id": file,
        "album": album,
        "file": file,
        "title": title,
        "song_index": 0,
        "si": 0,
        "bi": 0,
        "ei": 0,
        "label": label,
        "editorial": EDITORIAL,
        "printed": PRINTED,
        "document_sha256": file_sha256(path),
        "observation_id": None,
        "page": 1,
        "basis": "Legacy reading-order match",
        "editable": True,
    }


def _fixture(tmp_path, monkeypatch) -> tuple[Path, list[dict], Callable]:
    root = tmp_path / "songs"
    pdfs = tmp_path / "pdf"
    pdfs.mkdir()
    rows = [
        _chart(root, "album-a", "01-song-a.json", "Em9", "Song A"),
        _chart(root, "album-b", "01-song-b.json", "Em7/9", "Song B"),
    ]
    group = {
        "id": "em-family",
        "pattern": "OFMOFF",
        "columns": [None, 1, None, None, 2, 1],
        "base": 1,
        "voicing": PRINTED,
        "occurrences": rows,
    }
    index = routes.Index((), {group["id"]: group}, {r["id"]: r for r in rows}, {"songs": 2})
    monkeypatch.setattr(server, "PDF_DIR", pdfs)
    monkeypatch.setattr(routes, "CACHE_ROOT", tmp_path / "cache")
    monkeypatch.setattr(routes, "_EDITED_FILES", set())
    monkeypatch.setattr(routes, "_RECOVERY_ERRORS", {})
    monkeypatch.setattr(routes, "_get_index", lambda *_args: index)

    def request(method, url, data=None):
        status, _, body, *_headers = server.handle(method, url, json.dumps(data).encode(), root)
        return status, json.loads(body)

    return root, rows, request


def test_shape_status_filters_apply_before_pagination_and_respect_album(tmp_path, monkeypatch):
    root, rows, request = _fixture(tmp_path, monkeypatch)
    index = routes._get_index(root, None, None)
    original = index.groups["em-family"]
    for number in range(routes.PAGE_SIZE + 1):
        group = {
            **original,
            "id": f"resolved-{number}",
            "occurrences": [{**rows[0], "editorial": PRINTED}],
        }
        index.groups[group["id"]] = group
    index.groups["unresolved"] = {
        **original,
        "id": "unresolved",
        "voicing": None,
        "occurrences": [{**rows[1], "printed": None}],
    }

    status, body = request("GET", "/api/shapes?filter=disagreements")
    assert status == 200
    assert [group["id"] for group in body["groups"]] == ["em-family"]
    assert body["pages"] == 1
    assert body["counts"]["filtered_groups"] == 1

    status, body = request("GET", "/api/shapes?filter=unresolved")
    assert status == 200
    assert [group["id"] for group in body["groups"]] == ["unresolved"]
    status, body = request("GET", "/api/shapes?filter=unresolved&album=album-a")
    assert status == 200
    assert body["groups"] == []
    status, body = request("GET", "/api/shapes?filter=unresolved&q=missing")
    assert status == 200
    assert body["groups"] == []


def test_shape_routes_filter_rank_and_locate_exact_saved_entry(tmp_path, monkeypatch):
    _, rows, request = _fixture(tmp_path, monkeypatch)
    status, body = request("GET", "/api/shapes")
    assert status == 200
    assert body["groups"][0]["affected_songs"] == 2
    assert body["groups"][0]["disagreements"] == 2
    assert body["groups"][0]["labels"] == ["Em7/9", "Em9"]

    status, body = request("GET", "/api/shapes?q=Song%20B")
    assert status == 200
    assert body["groups"][0]["matches"] == 2

    status, body = request("GET", "/api/shapes?q=Song%20B&album=album-b")
    assert status == 200
    assert body["groups"][0]["labels"] == ["Em7/9"]
    assert body["groups"][0]["matches"] == 1

    status, body = request("GET", "/api/shapes/em-family")
    assert status == 200
    assert body["occurrences"] == rows

    status, body = request("GET", "/api/shapes/em-family?album=album-b")
    assert status == 200 and body["occurrences"] == rows[1:]

    path = "/api/shapes/entry?album=album-a&file=01-song-a.json&song_index=0&si=0&bi=0&ei=0"
    status, body = request("GET", f"{path}&revision={rows[0]['document_sha256']}")
    assert status == 200 and body["id"] == "em-family"
    status, _ = request("GET", f"{path}&revision=stale")
    assert status == 409


def test_batch_routes_prevent_stale_song_save_and_can_undo(tmp_path, monkeypatch):
    root, rows, request = _fixture(tmp_path, monkeypatch)
    song_path = root / rows[0]["album"] / rows[0]["file"]
    song_url = f"/api/song/{rows[0]['album']}/{rows[0]['file']}"
    original = load_document(song_path)
    status, body = request(
        "POST", "/api/shapes/em-family/apply", {"selected": [r["id"] for r in rows]}
    )
    assert status == 200, body
    assert body["songs"] == body["entries"] == 2
    batch_id = body["batch_id"]
    changed = load_document(song_path)["songs"][0]["sections"][0]["bars"][0][0]
    assert changed["voicing"] == PRINTED
    assert changed["voicing_printed"] == PRINTED

    routes._EDITED_FILES.clear()
    assert routes.recover_library(root, server._SONG_WRITE_LOCK) == ""
    status, _ = request("POST", song_url, original)
    assert status == 409
    status, _ = request("POST", f"{song_url}?revision={rows[0]['document_sha256']}", original)
    assert status == 409

    status, body = request("POST", f"/api/shapes/batch/{batch_id}/undo", {})
    assert status == 200, body
    assert body["entries"] == 2
    assert load_document(song_path) == original

    status, body = request("POST", f"{song_url}?revision={file_sha256(song_path)}", original)
    assert status == 200
    assert body["revision"] == file_sha256(song_path)


def test_shape_correction_updates_chart_and_remembers_proposal_until_undo(tmp_path, monkeypatch):
    root, rows, request = _fixture(tmp_path, monkeypatch)
    path = root / rows[0]["album"] / rows[0]["file"]
    original = load_document(path)
    custom = "0,2,x,0,3,14"
    status, body = request(
        "POST", "/api/shapes/em-family/apply", {"selected": [rows[0]["id"]], "voicing": custom}
    )
    assert status == 200, body
    after = load_document(path)["songs"][0]["sections"][0]["bars"][0][0]
    assert after["voicing"] == custom
    assert after["voicing_printed"] == PRINTED
    assert after["chord_review"]["snapshot"]["voicing"] == custom
    assert file_sha256(root / rows[1]["album"] / rows[1]["file"]) == rows[1]["document_sha256"]
    status, detail = request("GET", "/api/shapes/em-family")
    assert status == 200
    assert detail["voicing"] == PRINTED and detail["correction"] == custom
    status, listed = request("GET", "/api/shapes")
    assert status == 200 and listed["groups"][0]["correction"] == custom
    assert request("POST", f"/api/shapes/batch/{body['batch_id']}/undo", {})[0] == 200
    assert load_document(path) == original
    assert request("GET", "/api/shapes/em-family")[1]["correction"] is None


def test_null_shape_voicing_never_falls_back_to_detected(tmp_path, monkeypatch):
    root, rows, request = _fixture(tmp_path, monkeypatch)
    path = root / rows[0]["album"] / rows[0]["file"]
    before = path.read_bytes()
    assert (
        request(
            "POST", "/api/shapes/em-family/apply", {"selected": [rows[0]["id"]], "voicing": None}
        )[0]
        == 400
    )
    assert path.read_bytes() == before


def test_shapes_route_applies_only_explicit_chord_name_and_can_undo(tmp_path, monkeypatch):
    root, rows, request = _fixture(tmp_path, monkeypatch)
    first, second = (root / row["album"] / row["file"] for row in rows)
    original = first.read_bytes()
    assert (
        request(
            "POST", "/api/shapes/em-family/apply", {"selected": [rows[0]["id"]], "chord": None}
        )[0]
        == 400
    )
    for invalid in ("C", "C77/9garbage"):
        status, _ = request(
            "POST",
            "/api/shapes/em-family/apply",
            {"selected": [rows[0]["id"]], "voicing": PRINTED, "chord": invalid},
        )
        assert status == 409
        assert first.read_bytes() == original
    status, applied = request(
        "POST",
        "/api/shapes/em-family/apply",
        {"selected": [rows[0]["id"]], "voicing": PRINTED, "chord": "Em7/9"},
    )
    assert status == 200, applied
    chord = load_document(first)["songs"][0]["sections"][0]["bars"][0][0]
    assert (chord["chord"], chord["voicing"], chord["voicing_printed"]) == (
        "Em7/9",
        PRINTED,
        PRINTED,
    )
    assert chord["chord_review"]["snapshot"]["chord"] == "Em7/9"
    assert file_sha256(second) == rows[1]["document_sha256"]
    assert request("POST", f"/api/shapes/batch/{applied['batch_id']}/undo", {})[0] == 200
    assert first.read_bytes() == original


def test_library_startup_recovers_interrupted_batch(tmp_path, monkeypatch):
    root, rows, request = _fixture(tmp_path, monkeypatch)
    before = {root / row["album"] / row["file"]: row["document_sha256"] for row in rows}
    status, applied = request(
        "POST", "/api/shapes/em-family/apply", {"selected": [row["id"] for row in rows]}
    )
    assert status == 200
    batch = routes._cache_path(root) / "batches" / applied["batch_id"]
    (batch / "state.json").write_text('{"state":"prepared"}', encoding="utf-8")

    recovery = routes.recover_library(root, server._SONG_WRITE_LOCK)

    assert "Recovered 1 interrupted Shapes batches" in recovery
    assert json.loads((batch / "state.json").read_text()) == {"state": "rolled_back"}
    assert all(file_sha256(path) == sha for path, sha in before.items())


def test_recovery_conflict_protects_regular_song_saves(tmp_path, monkeypatch):
    root, rows, request = _fixture(tmp_path, monkeypatch)
    status, applied = request(
        "POST", "/api/shapes/em-family/apply", {"selected": [row["id"] for row in rows]}
    )
    assert status == 200
    batch = routes._cache_path(root) / "batches" / applied["batch_id"]
    (batch / "state.json").write_text('{"state":"prepared"}', encoding="utf-8")
    original = rows[0]
    path = root / original["album"] / original["file"]
    external = load_document(path)
    external["songs"][0]["note"] = "Separately edited"
    save_document(path, external, overwrite=True)

    recovery = routes.recover_library(root, server._SONG_WRITE_LOCK)

    assert "recovery conflict" in recovery
    route = f"/api/song/{original['album']}/{original['file']}"
    status, _ = request("POST", f"{route}?revision={file_sha256(path)}", external)
    assert status == 409
    assert load_document(path) == external
    assert request("GET", route)[0] == 200


def test_unresolved_route_requires_explicit_compatible_voicing(tmp_path, monkeypatch):
    root, rows, request = _fixture(tmp_path, monkeypatch)
    group = routes._get_index(root, None, None).groups["em-family"]
    group["voicing"] = group["base"] = None
    for row in rows:
        row["editable"] = False
    assert request("POST", "/api/shapes/em-family/apply", {"selected": [rows[0]["id"]]})[0] == 409
    assert (
        request(
            "POST",
            "/api/shapes/em-family/apply",
            {"selected": [rows[0]["id"]], "voicing": "0,2,2,1,0,0", "chord": "C"},
        )[0]
        == 409
    )
    status, result = request(
        "POST", "/api/shapes/em-family/apply", {"selected": [rows[0]["id"]], "voicing": PRINTED}
    )
    assert status == 200, result
    from qa_shape_edits import latest_shape_corrections

    assert latest_shape_corrections(routes._cache_path(root) / "batches") == {}


def test_exclusion_route_preserves_marker_through_normal_save(tmp_path, monkeypatch):
    root, rows, request = _fixture(tmp_path, monkeypatch)
    status, result = request("POST", "/api/shapes/em-family/exclude", {"selected": [rows[0]["id"]]})
    assert status == 200, result
    assert result["songs"] == result["entries"] == 1
    row = rows[0]
    path = root / row["album"] / row["file"]
    doc = load_document(path)
    marker = doc["songs"][0]["sections"][0]["bars"][0][0]["shape_exclusion"]
    doc["songs"][0]["note"] = "Ordinary save after removal"
    status, body = request(
        "POST", f"/api/song/{row['album']}/{row['file']}?revision={file_sha256(path)}", doc
    )
    assert status == 200, body
    assert load_document(path)["songs"][0]["sections"][0]["bars"][0][0]["shape_exclusion"] == marker
