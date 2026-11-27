import argparse
import json
import os
import sys
import threading
from contextlib import contextmanager
from datetime import UTC, datetime
from http.client import HTTPConnection
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import qa_server as S
from songsheet_version import SCHEMA_VERSION


@contextmanager
def _live_server(root, allowed_origins=()):
    server = S._make_server(root, 0, "127.0.0.1", frozenset(allowed_origins))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_port
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def _post(port, *, host=None, origin=None):
    headers = {"Content-Type": "application/json"}
    if host is not None:
        headers["Host"] = host
    if origin is not None:
        headers["Origin"] = origin
    connection = HTTPConnection("127.0.0.1", port, timeout=2)
    try:
        connection.request("POST", "/api/not-a-route", body=b"{}", headers=headers)
        response = connection.getresponse()
        response.read()
        return response.status
    finally:
        connection.close()


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


def test_recorded_crop_uses_observation_id_and_refuses_changed_pdf(tmp_path, monkeypatch):
    import audit_voicings
    import diagram_evidence
    import diagram_reader
    import numpy as np
    from extraction_provenance import attach_observations
    from songsheet_io import save_document

    root = _corpus(tmp_path)
    path = root / "1-album" / "01-song-one.json"
    pdfs = tmp_path / "pdfs"
    pdfs.mkdir()
    pdf = pdfs / "source.pdf"
    pdf.write_bytes(b"source PDF bytes")
    image = np.zeros((32, 32), dtype=int)
    doc = attach_observations(json.loads(path.read_text()), {"kind": "test"})
    doc = diagram_evidence.enrich_page_result(
        doc,
        pdf,
        1,
        image_loader=lambda *_: image,
        detector=lambda _: [(1, 1, 10, 10)],
        page_reader=lambda *_: [
            {
                "box": [1, 1, 10, 10],
                "voicing": "x,5,7,5,6,x",
                "base": 5,
                "harmonic_base": True,
                "pattern": "MFFFFM",
                "error": None,
            }
        ],
    )
    save_document(path, doc, overwrite=True)
    observation_id = doc["songs"][0]["sections"][0]["bars"][0][0]["observation_id"]
    monkeypatch.setattr(S, "PDF_DIR", pdfs)
    monkeypatch.setattr(diagram_reader, "load_page_image", lambda *_: image)
    monkeypatch.setattr(
        audit_voicings, "song_diagram_data", lambda *_: pytest.fail("must not guess pairing")
    )
    route = f"/api/diagram-crop/1-album/01-song-one.json?observation_id={observation_id}"
    status, ctype, body = S.handle("GET", route, b"", root)
    assert status == 200 and ctype == "image/png" and body.startswith(b"\x89PNG")
    pdf.write_bytes(b"changed source")
    status, _, body = S.handle("GET", route, b"", root)
    assert status == 409 and "source PDF changed" in json.loads(body)["error"]


def test_unpaired_observation_does_not_fall_back_to_guessed_crop(tmp_path, monkeypatch):
    from extraction_provenance import attach_observations
    from songsheet_io import save_document

    root = _corpus(tmp_path)
    path = root / "1-album" / "01-song-one.json"
    doc = attach_observations(json.loads(path.read_text()), {"kind": "test"})
    save_document(path, doc, overwrite=True)
    monkeypatch.setattr(S, "PDF_DIR", tmp_path)
    status, _, body = S.handle(
        "GET", "/api/diagram-crop/1-album/01-song-one.json?si=0&bi=0&ei=0", b"", root
    )
    assert status == 404 and "no recorded diagram" in json.loads(body)["error"]


def test_diagram_locations_map_native_box_through_image_placement(tmp_path, monkeypatch):
    import diagram_evidence
    import fitz
    import numpy as np
    from extraction_provenance import attach_observations
    from PIL import Image
    from songsheet_io import save_document

    root = _corpus(tmp_path)
    path = root / "1-album" / "01-song-one.json"
    pdfs = tmp_path / "pdfs"
    pdfs.mkdir()
    raster_path = tmp_path / "page.png"
    raster = np.arange(50 * 100, dtype=np.uint8).reshape(50, 100)
    Image.fromarray(raster).save(raster_path)
    pdf = pdfs / "source.pdf"
    with fitz.open() as document:
        page = document.new_page(width=300, height=400)
        page.insert_image(fitz.Rect(20, 30, 220, 130), filename=raster_path, rotate=90)
        page.set_cropbox(fitz.Rect(10, 20, 280, 380))
        page.set_rotation(90)
        document.save(pdf)

    doc = attach_observations(json.loads(path.read_text()), {"kind": "test"})
    doc = diagram_evidence.enrich_page_result(
        doc,
        pdf,
        1,
        image_loader=lambda *_: raster,
        detector=lambda _: [(10, 5, 29, 14)],
        page_reader=lambda *_: [
            {
                "box": [10, 5, 29, 14],
                "voicing": "x,5,7,5,6,x",
                "base": 5,
                "harmonic_base": True,
                "pattern": "MFFFFM",
                "error": None,
            }
        ],
    )
    save_document(path, doc, overwrite=True)
    observation_id = doc["songs"][0]["sections"][0]["bars"][0][0]["observation_id"]
    monkeypatch.setattr(S, "PDF_DIR", pdfs)

    status, ctype, body = S.handle(
        "GET", "/api/diagram-location/1-album/01-song-one.json", b"", root
    )

    assert status == 200 and ctype == "application/json"
    location = json.loads(body)["locations"][observation_id]
    assert location["page"] == 1
    # The image is offset, rotated within its placement, cropped by the page,
    # and then the page itself is rotated. Raw pixel/page normalization cannot
    # produce these rendered-page fractions.
    assert location["box"] == pytest.approx([260 / 360, 90 / 270, 280 / 360, 100 / 270], abs=1e-9)

    def unavailable(*_args):
        raise RuntimeError("placement unavailable")

    monkeypatch.setattr(S, "_page_diagram_boxes", unavailable)
    status, _, body = S.handle("GET", "/api/diagram-location/1-album/01-song-one.json", b"", root)
    assert status == 200
    assert json.loads(body)["locations"][observation_id] == {"page": 1, "box": None}


def test_diagram_locations_return_page_only_for_unpaired_link(tmp_path, monkeypatch):
    import fitz
    from extraction_provenance import attach_observations, file_sha256, seal_page_sources
    from songsheet_io import save_document

    root = _corpus(tmp_path)
    path = root / "1-album" / "01-song-one.json"
    pdfs = tmp_path / "pdfs"
    pdfs.mkdir()
    pdf = pdfs / "source.pdf"
    with fitz.open() as document:
        document.new_page()
        document.new_page()
        document.save(pdf)
    source_pdf = {"name": pdf.name, "sha256": file_sha256(pdf)}
    doc = attach_observations(
        json.loads(path.read_text()), {"kind": "test", "source_pdf": source_pdf, "page": 2}
    )
    source_id = next(iter(doc["_meta"]["extraction_sources"]))
    doc["_meta"]["source_pdf"] = source_pdf
    doc["_meta"]["page_sources"] = {source_id: {"source_pdf": source_pdf, "page": 2}}
    seal_page_sources(doc["_meta"])
    save_document(path, doc, overwrite=True)
    observation_id = doc["songs"][0]["sections"][0]["bars"][0][0]["observation_id"]
    monkeypatch.setattr(S, "PDF_DIR", pdfs)

    status, _, body = S.handle("GET", "/api/diagram-location/1-album/01-song-one.json", b"", root)

    assert status == 200
    assert json.loads(body) == {"locations": {observation_id: {"page": 2, "box": None}}}


def test_diagram_locations_do_not_guess_legacy_entries(tmp_path, monkeypatch):
    root = _corpus(tmp_path)
    monkeypatch.setattr(S, "PDF_DIR", tmp_path)

    status, _, body = S.handle("GET", "/api/diagram-location/1-album/01-song-one.json", b"", root)

    assert status == 404
    assert "no linked source" in json.loads(body)["error"]


def test_diagram_locations_return_verified_legacy_boxes_with_revision(tmp_path, monkeypatch):
    import qa_shapes
    from extraction_provenance import file_sha256

    root = _corpus(tmp_path)
    pdf = tmp_path / "album.pdf"
    monkeypatch.setattr(S, "PDF_DIR", tmp_path)
    monkeypatch.setattr(
        qa_shapes,
        "legacy_page_records",
        lambda *_args: {(pdf, 4): [{"observation_id": "0:0:0", "crop_box": [1, 2, 3, 4]}]},
    )
    monkeypatch.setattr(S, "_page_diagram_boxes", lambda *_args: {"0:0:0": [0.1, 0.2, 0.3, 0.4]})

    status, _, body = S.handle("GET", "/api/diagram-location/1-album/01-song-one.json", b"", root)

    assert status == 200
    assert json.loads(body) == {
        "locations": {},
        "coordinates": {
            "0:0:0": {"page": 4, "box": [0.1, 0.2, 0.3, 0.4], "basis": "legacy_exact_count"}
        },
        "revision": file_sha256(root / "1-album" / "01-song-one.json"),
    }

    path = root / "1-album" / "01-song-one.json"
    query = f"?revision={file_sha256(path)}&legacy_scan_order=changed"
    status, _, _ = S.handle(
        "POST", f"/api/song/1-album/01-song-one.json{query}", path.read_bytes(), root
    )
    assert status == 200
    assert json.loads(path.read_text())["_meta"]["legacy_scan_order_changed"] is True
    status, _, _ = S.handle("GET", "/api/diagram-location/1-album/01-song-one.json", b"", root)
    assert status == 404


def test_reading_overlay_keeps_exact_boxes_and_exposes_only_supportable_target(
    tmp_path, monkeypatch
):
    import diagram_reader
    import numpy as np
    from extraction_provenance import file_sha256
    from songsheet_io import save_document

    root = _corpus(tmp_path)
    name = "01-song-one.json"
    path = root / "1-album" / name
    doc = json.loads(path.read_text())
    doc["songs"][0]["pages"] = [4]
    entry = {"chord": "Dm7", "voicing": "x,5,7,5,6,x", "voicing_printed": "x,5,7,5,6,x"}
    doc["songs"][0]["sections"][0]["bars"] = [[dict(entry)] for _ in range(3)]
    save_document(path, doc, overwrite=True)
    original = path.read_bytes()
    pdf = tmp_path / "source.pdf"
    pdf.write_bytes(b"source")
    revision = file_sha256(path)
    digest = file_sha256(pdf)
    proposal = "x,5,x,5,6,x"
    rows = [
        {
            "coordinate": f"0:{i}:0",
            "chord": "Dm7",
            "editorial": entry["voicing"],
            "printed": entry["voicing_printed"],
            "pdf": pdf.name,
            "pdf_sha256": digest,
            "page": 4,
            "box": [1, 2, 10, 20],
            "proposal": proposal if i != 2 else None,
        }
        for i in range(3)
    ]
    groups = {("1-album", name): {"revision": revision, "entries": rows}}
    exact = {"page": 4, "box": [0, 0, 0.1, 0.1], "basis": "legacy_exact_count"}
    monkeypatch.setattr(S, "PDF_DIR", tmp_path)
    monkeypatch.setattr(S, "READING_PROPOSALS", groups)
    monkeypatch.setattr(S, "_legacy_diagram_locations", lambda *_args: {"0:0:0": exact})
    monkeypatch.setattr(diagram_reader, "load_page_image", lambda *_args: np.zeros((70, 80)))
    monkeypatch.setattr(
        S,
        "_page_diagram_boxes",
        lambda _pdf, _page, records: {
            record["observation_id"]: [0.2, 0.2, 0.4, 0.4] for record in records
        },
    )

    url = f"/api/diagram-location/1-album/{name}"
    status, _, body = S.handle("GET", url, b"", root)
    coordinates = json.loads(body)["coordinates"]
    assert status == 200
    assert coordinates["0:0:0"] == exact
    assert coordinates["0:1:0"]["basis"] == "legacy_anchored_proposal"
    assert coordinates["0:1:0"]["proposal"] == proposal
    assert "proposal" not in coordinates["0:2:0"]
    assert path.read_bytes() == original

    groups["1-album", name]["revision"] = "0" * 64
    _, _, body = S.handle("GET", url, b"", root)
    assert json.loads(body)["coordinates"] == {"0:0:0": exact}


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


def test_review_doc_records_in_memory_without_mutating_disk(tmp_path):
    root = _corpus(tmp_path)
    target = root / "1-album" / "01-song-one.json"
    original = target.read_bytes()
    doc = json.loads(original)
    request = {
        "doc": doc,
        "field": "chords",
        "status": "verified",
        "reviewer": "AS",
        "evidence": "compared every chord with page 1",
    }

    status, _, body = S.handle("POST", "/api/review-doc", json.dumps(request).encode(), root)

    assert status == 200
    response = json.loads(body)
    assert response["ok"] is True
    assert response["review"]["fields"]["chords"]["status"] == "verified"
    assert response["doc"]["_meta"]["review"]["fields"]["chords"]["reviewer"] == "AS"
    timestamp = response["doc"]["_meta"]["review"]["fields"]["chords"]["timestamp"]
    assert datetime.fromisoformat(timestamp).tzinfo is UTC
    assert response["review"]["fields"]["chords"]["timestamp"] == timestamp
    assert target.read_bytes() == original


def test_review_doc_summary_does_not_infer_verification_from_legacy_done(tmp_path):
    root = _corpus(tmp_path)
    target = root / "1-album" / "01-song-one.json"
    doc = json.loads(target.read_text())
    doc["document"]["status"] = "done"

    status, _, body = S.handle("POST", "/api/review-doc", json.dumps({"doc": doc}).encode(), root)

    assert status == 200
    fields = json.loads(body)["review"]["fields"]
    assert {item["status"] for item in fields.values()} == {"pending"}


@pytest.mark.parametrize(
    "payload",
    [
        None,
        {},
        {"doc": []},
        {"doc": {"document": {"title": "x"}, "songs": []}, "field": "lyrics"},
    ],
)
def test_review_doc_rejects_invalid_request_without_disk_writes(tmp_path, payload):
    root = _corpus(tmp_path)
    target = root / "1-album" / "01-song-one.json"
    original = target.read_bytes()

    status, _, body = S.handle("POST", "/api/review-doc", json.dumps(payload).encode(), root)

    assert status == 422
    assert json.loads(body)["ok"] is False
    assert target.read_bytes() == original


def test_review_doc_refuses_verified_key_without_stored_key(tmp_path):
    root = _corpus(tmp_path)
    target = root / "1-album" / "01-song-one.json"
    original = target.read_bytes()
    request = {
        "doc": json.loads(original),
        "field": "key",
        "status": "verified",
        "reviewer": "AS",
        "evidence": "cadence review",
    }

    status, _, body = S.handle("POST", "/api/review-doc", json.dumps(request).encode(), root)

    assert status == 422
    assert "valid nonempty stored key" in json.loads(body)["error"]
    assert target.read_bytes() == original


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


def test_render_doc_uses_target_if_the_fork_fails(tmp_path, monkeypatch):
    root = _corpus(tmp_path)
    doc = json.loads((root / "1-album" / "01-song-one.json").read_text())
    doc["songs"][0]["sections"][0]["bars"][0][0]["voicing"] = "x,5,7,5,6,x"
    monkeypatch.setattr(
        S, "render_song_doc", lambda *_args, **_kwargs: S._html_error("Cannot find esbuild")
    )
    status, ctype, body, headers = S.handle(
        "POST", "/api/render-doc?style=fork&diagrams=inline", json.dumps(doc).encode(), root
    )
    assert status == 200
    assert ctype == "text/html"
    assert b'class="ln"' in body
    assert b'class="idia"' in body
    assert b'class="dict"' not in body
    assert headers["X-Songsheet-Preview-Style"] == "target"


def test_render_doc_falls_back_when_fork_cannot_preserve_bar_layout(tmp_path, monkeypatch):
    root = _corpus(tmp_path)
    doc = json.loads((root / "1-album" / "01-song-one.json").read_text())
    section = doc["songs"][0]["sections"][0]
    section["bars"] = [[{"chord": "C"} for _ in range(17)]] + section["bars"] * 4
    monkeypatch.setattr("shutil.which", lambda _name: "/fixture/node")
    status, _, body, headers = S.handle(
        "POST", "/api/render-doc?style=fork&bars=4", json.dumps(doc).encode(), root
    )
    assert status == 200
    assert headers["X-Songsheet-Preview-Style"] == "target"
    assert headers["X-Songsheet-Preview-Reason"] == "bar-layout"
    assert body.count(b'class="ln"') == 2
    assert body.count(b'class="bar"') == 5


def test_render_doc_counts_blank_measures_when_checking_the_fork(tmp_path, monkeypatch):
    from subprocess import CompletedProcess

    root = _corpus(tmp_path)
    doc = json.loads((root / "1-album" / "01-song-one.json").read_text())
    doc["songs"][0]["sections"][0]["bars"] = [
        [],
        [{"chord": "C"}],
        [{"chord": "G"}],
        [{"chord": "F"}],
    ]

    calls = []

    def fork_drops_blank(command, **_kwargs):
        calls.append(command)
        assert command[command.index("--expected-bars") + 1] == "4"
        if "--chart-data" not in command:
            return CompletedProcess(command, 3)
        rows = json.loads(Path(command[command.index("--chart-data") + 1]).read_text())
        assert rows[0][0] == [{"name": "", "voicing": None}]
        assert len(rows[0]) == 4
        Path(command[3]).write_text("<html>Four bars</html>")
        return CompletedProcess(command, 0)

    monkeypatch.setattr("shutil.which", lambda _name: "/fixture/node")
    monkeypatch.setattr("subprocess.run", fork_drops_blank)
    status, _, body = S.handle(
        "POST", "/api/render-doc?style=fork&bars=4", json.dumps(doc).encode(), root
    )
    assert status == 200
    assert body == b"<html>Four bars</html>"
    assert len(calls) == 2


def test_render_doc_prefers_the_fork_when_it_succeeds(tmp_path, monkeypatch):
    root = _corpus(tmp_path)
    doc = json.loads((root / "1-album" / "01-song-one.json").read_text())
    fork = (200, "text/html", b"<html>Fork</html>")
    monkeypatch.setattr(S, "render_song_doc", lambda *_args, **_kwargs: fork)
    monkeypatch.setattr(
        S, "render_target_doc", lambda *_args, **_kwargs: pytest.fail("unexpected fallback")
    )
    assert S.handle("POST", "/api/render-doc?style=fork", json.dumps(doc).encode(), root) == fork


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


@pytest.mark.parametrize(
    ("fmt", "edited_marker", "saved_marker"),
    [
        ("html", b"Am7", b"Dm7"),
        ("chordmark", b"Am7", b"Dm7"),
        ("chordpro", b"[Am7]", b"[Dm7]"),
    ],
)
def test_export_doc_uses_posted_snapshot_without_mutating_saved_song(
    tmp_path, fmt, edited_marker, saved_marker
):
    root = _corpus(tmp_path)
    target = root / "1-album" / "01-song-one.json"
    original = target.read_bytes()
    doc = json.loads(original)
    doc["songs"][0]["sections"][0]["bars"][0][0]["chord"] = "Am7"

    result = S.handle(
        "POST",
        f"/api/export-doc/1-album/01-song-one.json?fmt={fmt}&style=target",
        json.dumps(doc).encode(),
        root,
    )

    status, body, headers = result[0], result[2], result[3]
    assert status == 200
    assert edited_marker in body
    assert saved_marker not in body
    assert f".{fmt}" in headers["Content-Disposition"]
    assert target.read_bytes() == original


def test_export_doc_passes_target_layout_options_to_snapshot_renderer(tmp_path, monkeypatch):
    root = _corpus(tmp_path)
    doc = json.loads((root / "1-album" / "01-song-one.json").read_text())
    rendered = {}

    def render(snapshot, **options):
        rendered["snapshot"] = snapshot
        rendered["options"] = options
        return 200, "text/html", b"<html>posted target</html>"

    monkeypatch.setattr(S, "render_target_doc", render)
    monkeypatch.setattr(S, "_chrome", lambda: "/fake/chrome")
    monkeypatch.setattr(
        S,
        "_chrome_convert",
        lambda html, fmt: rendered.update(html=html, fmt=fmt) or b"png-snapshot",
    )

    result = S.handle(
        "POST",
        "/api/export-doc/1-album/01-song-one.json"
        "?fmt=png&style=target&diagrams=both&dict=per_name&bars=6",
        json.dumps(doc).encode(),
        root,
    )

    assert result[:3] == (200, "image/png", b"png-snapshot")
    assert rendered == {
        "snapshot": doc,
        "options": {
            "dictionary": "per_name",
            "inline": False,
            "bars_per_line": 6,
            "diagram_layout": "both",
        },
        "html": "<html>posted target</html>",
        "fmt": "png",
    }
    assert 'filename="01-song-one.png"' in result[3]["Content-Disposition"]


def test_export_doc_passes_fork_layout_options_to_snapshot_renderer(tmp_path, monkeypatch):
    root = _corpus(tmp_path)
    doc = json.loads((root / "1-album" / "01-song-one.json").read_text())
    rendered = {}

    def render(snapshot, **options):
        rendered["snapshot"] = snapshot
        rendered["options"] = options
        return 200, "text/html", b"<html>posted fork</html>"

    monkeypatch.setattr(S, "render_song_doc", render)
    monkeypatch.setattr(
        S, "render_target_doc", lambda *_args, **_kwargs: pytest.fail("unexpected target render")
    )

    result = S.handle(
        "POST",
        "/api/export-doc/1-album/01-song-one.json?fmt=html&style=fork&diagrams=inline&bars=8",
        json.dumps(doc).encode(),
        root,
    )

    assert result[:3] == (200, "text/html", b"<html>posted fork</html>")
    assert rendered == {
        "snapshot": doc,
        "options": {"bars_per_line": 8, "diagram_layout": "inline"},
    }


@pytest.mark.parametrize(
    ("payload", "expected_status"),
    [
        (b"{not json", 400),
        (b"\xff", 400),
        (json.dumps([]).encode(), 422),
        (json.dumps({"document": {"title": "Album"}, "songs": [{}]}).encode(), 422),
    ],
)
def test_export_doc_rejects_invalid_payload_without_mutating_saved_song(
    tmp_path, payload, expected_status
):
    root = _corpus(tmp_path)
    target = root / "1-album" / "01-song-one.json"
    original = target.read_bytes()

    status, _, body = S.handle(
        "POST", "/api/export-doc/1-album/01-song-one.json?fmt=html", payload, root
    )

    assert status == expected_status
    assert "error" in json.loads(body)
    assert target.read_bytes() == original


def test_export_doc_requires_existing_safe_filename(tmp_path):
    root = _corpus(tmp_path)
    doc = (root / "1-album" / "01-song-one.json").read_bytes()
    assert S.handle("POST", "/api/export-doc/1-album/missing.json?fmt=html", doc, root)[0] == 404
    assert S.handle("POST", "/api/export-doc/../evil.json?fmt=html", doc, root)[0] == 400


def test_export_doc_rejects_unknown_format_before_rendering(tmp_path, monkeypatch):
    root = _corpus(tmp_path)
    doc = (root / "1-album" / "01-song-one.json").read_bytes()
    monkeypatch.setattr(
        S, "render_target_doc", lambda *_args, **_kwargs: pytest.fail("unexpected render")
    )

    status, _, body = S.handle(
        "POST", "/api/export-doc/1-album/01-song-one.json?fmt=exe", doc, root
    )

    assert status == 400
    assert "unknown fmt" in json.loads(body)["error"]


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


def test_default_export_renderer_never_searches_for_desktop_chrome(monkeypatch):
    import shutil

    searched = []

    def which(name):
        searched.append(name)
        return None

    monkeypatch.delenv("SONGSHEET_CHROME_BIN", raising=False)
    monkeypatch.setattr(shutil, "which", which)

    assert S._chrome() is None
    assert searched == ["chrome-headless-shell", "chromium-headless-shell"]


def test_chrome_convert_png_contains_every_printed_page(tmp_path, monkeypatch):
    from subprocess import CompletedProcess

    import fitz
    from PIL import Image

    commands = []

    def render_pdf(command, **_kwargs):
        commands.append(command)
        output_arg = next(arg for arg in command if arg.startswith("--print-to-pdf="))
        output = Path(output_arg.split("=", 1)[1])
        with fitz.open() as document:
            document.new_page(width=100, height=120)
            document.new_page(width=100, height=80)
            document.save(output)
        return CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(S, "_chrome", lambda: "/fixture/chrome")
    monkeypatch.setattr("subprocess.run", render_pdf)

    png = S._chrome_convert("<html><body>long chart</body></html>", "png")

    output = tmp_path / "complete.png"
    output.write_bytes(png)
    with Image.open(output) as image:
        assert image.size == (200, 400)
    assert png.startswith(b"\x89PNG\r\n\x1a\n")
    assert not any(arg.startswith("--screenshot=") for arg in commands[0])
    assert any(arg.startswith("--user-data-dir=") for arg in commands[0])
    assert commands[0][-1].startswith("file://")


def test_chrome_convert_reports_signal_when_chrome_aborts(monkeypatch):
    from subprocess import CompletedProcess

    monkeypatch.setattr(S, "_chrome", lambda: "/fixture/chrome")
    monkeypatch.setattr(
        "subprocess.run", lambda command, **_kwargs: CompletedProcess(command, -6, "", "")
    )

    with pytest.raises(RuntimeError, match=r"Chrome conversion failed \(terminated by SIGABRT\)"):
        S._chrome_convert("<html></html>", "pdf")


def test_chrome_convert_rejects_invalid_output(monkeypatch):
    from subprocess import CompletedProcess

    def write_invalid_output(command, **_kwargs):
        output_arg = next(arg for arg in command if arg.startswith("--print-to-pdf="))
        Path(output_arg.split("=", 1)[1]).write_bytes(b"")
        return CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(S, "_chrome", lambda: "/fixture/chrome")
    monkeypatch.setattr("subprocess.run", write_invalid_output)

    with pytest.raises(RuntimeError, match="invalid PDF output"):
        S._chrome_convert("<html></html>", "pdf")


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


def test_http_write_origin_accepts_remapped_loopback_authority(tmp_path):
    root = _corpus(tmp_path)
    with _live_server(root) as port:
        assert _post(port, host="localhost:43123", origin="http://localhost:43123") == 404
        assert _post(port, host="[::1]:43123", origin="http://[::1]:43123") == 404
        assert _post(port, host=f"127.0.0.1:{port}", origin=f"http://localhost:{port}") == 404
        assert _post(port) == 404


def test_http_write_origin_rejects_external_and_untrusted_host_authorities(tmp_path):
    root = _corpus(tmp_path)
    with _live_server(root) as port:
        assert _post(port, host="qa.example:43123", origin="http://qa.example:43123") == 403
        assert _post(port, host="evil.example:43123", origin="http://localhost:43123") == 403
        assert _post(port, host="localhost:43123", origin="null") == 403


def test_http_write_origin_honors_only_exact_configured_origin(tmp_path):
    root = _corpus(tmp_path)
    with _live_server(root, {"https://qa.example"}) as port:
        assert _post(port, host="internal:8001", origin="https://qa.example") == 404
        assert _post(port, host="internal:8001", origin="https://qa.example/") == 403


@pytest.mark.parametrize(
    "origin",
    [
        "http://localhost",
        "http://127.0.0.1:8001",
        "http://[::1]:8001",
        "https://qa.example",
    ],
)
def test_origin_configuration_accepts_http_authorities(origin):
    assert S._validated_origin(origin) == origin


@pytest.mark.parametrize(
    "origin",
    [
        "null",
        "*",
        "https://*.example",
        "ftp://qa.example",
        "https://user@qa.example",
        "https://qa.example/path",
        "https://qa.example\\path",
        "https://qa.example?query",
        "https://qa.example#fragment",
        "https://qa.example:99999",
    ],
)
def test_origin_configuration_rejects_non_origins(origin):
    with pytest.raises(argparse.ArgumentTypeError):
        S._validated_origin(origin)


def test_configured_origins_support_repeatable_and_comma_separated_values():
    assert S._configured_origins(
        ["https://one.example, http://127.0.0.1:8001", "http://[::1]:8001"]
    ) == (
        "https://one.example",
        "http://127.0.0.1:8001",
        "http://[::1]:8001",
    )


def test_explicit_state_dir_persists_shapes_and_cv_cache(tmp_path, monkeypatch):
    import qa_shape_routes as routes

    state = tmp_path / "state"
    songs = tmp_path / "songs"
    monkeypatch.setattr(routes, "CACHE_ROOT", tmp_path / "native-shapes")
    monkeypatch.setattr(S, "CV_CACHE_DIR", tmp_path / "native-cv")

    S._configure_state_dir(state)
    batch = routes._cache_path(songs) / "batches" / "shape-test"
    batch.mkdir(parents=True)
    (batch / "state.json").write_text('{"state":"committed"}', encoding="utf-8")
    (S.CV_CACHE_DIR / "cached-page").write_bytes(b"cache")

    S._configure_state_dir(state)

    assert routes.CACHE_ROOT == state / "shapes"
    assert (batch / "state.json").is_file()
    assert S.CV_CACHE_DIR == state / "cv-cache"
    assert (S.CV_CACHE_DIR / "cached-page").read_bytes() == b"cache"


def test_main_uses_container_environment_defaults_and_combines_cli_origins(tmp_path, monkeypatch):
    import qa_reading_proposals

    captured = {}
    proposals = tmp_path / "proposals"
    monkeypatch.setenv("SONGSHEET_HOST", "0.0.0.0")
    monkeypatch.setenv("SONGSHEET_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("SONGSHEET_READING_PROPOSALS", str(proposals))
    monkeypatch.setenv("SONGSHEET_ALLOWED_ORIGINS", "https://one.example,http://127.0.0.1:8001")
    monkeypatch.setattr(sys, "argv", ["qa_server.py", "--allow-origin", "http://[::1]:8001"])
    monkeypatch.setattr(S, "READING_PROPOSALS", {})
    monkeypatch.setattr(
        qa_reading_proposals,
        "load_reading_proposals",
        lambda path: {("album", "song.json"): {"path": path}},
    )
    monkeypatch.setattr(S, "_configure_state_dir", lambda path: captured.update(state=path))
    monkeypatch.setattr(
        S,
        "serve",
        lambda songs, port, **options: captured.update(songs=songs, port=port, options=options),
    )

    S.main()

    assert captured["state"] == tmp_path / "state"
    assert captured["options"] == {
        "host": "0.0.0.0",
        "allowed_origins": (
            "https://one.example",
            "http://127.0.0.1:8001",
            "http://[::1]:8001",
        ),
    }
    assert S.READING_PROPOSALS[("album", "song.json")]["path"] == proposals
