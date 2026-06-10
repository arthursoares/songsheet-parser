import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import audit_voicings as A


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
