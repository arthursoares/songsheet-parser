import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import audit_voicings as A
from songsheet_version import SCHEMA_VERSION

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "chega-page1.json"


def _fixture_doc():
    return json.loads(FIXTURE.read_text())


def _run_main(monkeypatch, songs, pdfs, *extra):
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "audit_voicings.py",
            "--songs",
            str(songs),
            "--pdfs",
            str(pdfs),
            "--cache",
            str(songs.parent / "cache"),
            *extra,
        ],
    )
    A.main()


def _song(entries):
    return {"sections": [{"label": None, "bars": [[e] for e in entries]}]}


SONG = _song(
    [
        {"chord": "Dm7", "voicing": "x,5,7,5,6,x"},
        {"chord": "%"},
        {"chord": "G7", "voicing": "3,x,3,4,3,x"},
        {"chord": "Cmaj7"},  # voicing lost in migration
    ]
)


def test_pair_song_prefers_voiced_entries():
    pairs, mode = A.pair_song(SONG, [("x,5,7,5,6,x", None), ("3,x,3,4,3,x", None)])
    assert mode == "voiced"
    assert [e["chord"] for e, _ in pairs] == ["Dm7", "G7"]


def test_pair_song_falls_back_to_all_non_pct_entries():
    diagrams = [("x,5,7,5,6,x", None), ("3,x,3,4,3,x", None), ("x,3,5,4,5,3", None)]
    pairs, mode = A.pair_song(SONG, diagrams)
    assert mode == "all-entries"
    assert [e["chord"] for e, _ in pairs] == ["Dm7", "G7", "Cmaj7"]


def test_pair_song_unalignable_returns_none_mode():
    pairs, mode = A.pair_song(SONG, [("x,5,7,5,6,x", None)])
    assert mode in (None, "fuzzy")  # a single agree anchor may fuzzy-pair


def test_pair_song_fuzzy_skips_a_spurious_diagram():
    # 3 diagrams vs 2 voiced entries: the extra diagram (middle) must be
    # skipped without shifting the G7 pairing.
    diagrams = [
        ("x,5,7,5,6,x", None),
        ("9,9,9,9,9,9", None),
        ("3,x,3,4,3,x", None),
        ("x,3,5,4,5,3", None),
    ]
    pairs, mode = A.pair_song(SONG, diagrams)
    assert mode == "fuzzy"
    paired = {e["chord"]: v for (e, (v, _err)) in pairs}
    assert paired["Dm7"] == "x,5,7,5,6,x"
    assert paired["G7"] == "3,x,3,4,3,x"


def test_audit_song_counts_agree_differ_missing():
    diagrams = [("x,5,7,5,6,x", None), ("3,x,3,4,4,x", None), ("x,3,5,4,5,3", None)]
    rep, pairs = A.audit_song(SONG, diagrams)
    assert rep["mode"] == "all-entries"
    assert rep["agree"] == 1  # Dm7 matches
    assert rep["differ"] == 1  # G7 differs on one string
    assert rep["missing_stored"] == 1  # Cmaj7 had no stored voicing
    assert rep["diffs"][0]["chord"] == "G7"
    assert rep["diffs"][1] == {"chord": "Cmaj7", "stored": None, "printed": "x,3,5,4,5,3"}


def test_audit_song_unreadable_diagrams_counted():
    rep, _ = A.audit_song(SONG, [(None, "lines"), ("3,x,3,4,3,x", None)])
    assert rep["mode"] == "voiced"
    assert rep["unreadable"] == 1
    assert rep["agree"] == 1


def test_main_rejects_future_document_before_cv_and_continues(tmp_path, monkeypatch, capsys):
    songs = tmp_path / "songs"
    album = songs / "album"
    album.mkdir(parents=True)
    pdfs = tmp_path / "pdfs"
    pdfs.mkdir()
    (pdfs / "album.pdf").touch()

    future = _fixture_doc()
    future["schema_version"] = 99
    future_path = album / "01-future.json"
    future_path.write_text(json.dumps(future))
    future_before = future_path.read_bytes()
    (album / "02-current.json").write_text(json.dumps(_fixture_doc()))

    calls = []

    def fake_diagrams(song, _pdf, _cache):
        calls.append(song["title"])
        return []

    monkeypatch.setattr(A, "song_diagram_voicings", fake_diagrams)
    _run_main(monkeypatch, songs, pdfs)

    assert calls == ["Chega de Saudade"]
    assert future_path.read_bytes() == future_before
    output = capsys.readouterr().out
    assert "01-future.json" in output
    assert "error" in output.lower()
    assert "1 errors" in output


def test_write_preserves_editorial_fields_and_stamps_version(tmp_path, monkeypatch):
    songs = tmp_path / "songs"
    album = songs / "album"
    album.mkdir(parents=True)
    pdfs = tmp_path / "pdfs"
    pdfs.mkdir()
    (pdfs / "album.pdf").touch()
    doc = _fixture_doc()
    doc["songs"][0]["note"] = "Keep this hand correction"
    path = album / "song.json"
    path.write_text(json.dumps(doc))

    printed = [(entry["voicing"], None) for entry in A.voiced_entries(doc["songs"][0])[0]]
    monkeypatch.setattr(A, "song_diagram_voicings", lambda *_args: printed)
    _run_main(monkeypatch, songs, pdfs, "--write")

    saved = json.loads(path.read_text())
    assert saved["schema_version"] == SCHEMA_VERSION
    assert saved["songs"][0]["note"] == "Keep this hand correction"
    entry = saved["songs"][0]["sections"][0]["bars"][0][0]
    assert entry["voicing"] == "3,x,3,3,2,x"
    assert entry["voicing_printed"] == "3,x,3,3,2,x"


def test_invalid_audit_output_does_not_damage_song_and_is_reported(tmp_path, monkeypatch, capsys):
    songs = tmp_path / "songs"
    album = songs / "album"
    album.mkdir(parents=True)
    pdfs = tmp_path / "pdfs"
    pdfs.mkdir()
    (pdfs / "album.pdf").touch()
    path = album / "song.json"
    path.write_text(json.dumps(_fixture_doc()))
    before = path.read_bytes()
    report = tmp_path / "report.json"

    count = len(A.voiced_entries(_fixture_doc()["songs"][0])[0])
    monkeypatch.setattr(A, "song_diagram_voicings", lambda *_args: [("invalid", None)] * count)
    _run_main(monkeypatch, songs, pdfs, "--write", "--report-json", str(report))

    assert path.read_bytes() == before
    rows = json.loads(report.read_text())
    assert len(rows) == 1
    assert "error" in rows[0]
    output = capsys.readouterr().out
    assert "ERROR" in output
    assert "1 errors" in output


def test_without_write_does_not_persist_printed_voicings(tmp_path, monkeypatch):
    songs = tmp_path / "songs"
    album = songs / "album"
    album.mkdir(parents=True)
    pdfs = tmp_path / "pdfs"
    pdfs.mkdir()
    (pdfs / "album.pdf").touch()
    path = album / "song.json"
    path.write_text(json.dumps(_fixture_doc()))
    before = path.read_bytes()

    count = len(A.voiced_entries(_fixture_doc()["songs"][0])[0])
    monkeypatch.setattr(
        A,
        "song_diagram_voicings",
        lambda *_args: [("x,5,7,5,6,x", None)] * count,
    )
    _run_main(monkeypatch, songs, pdfs)

    assert path.read_bytes() == before
