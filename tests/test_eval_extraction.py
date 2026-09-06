import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import eval_extraction as E


def _song(bars_by_section):
    """bars_by_section: list of lists of bars (a bar = list of entry dicts)."""
    return {
        "title": "T",
        "sections": [{"label": None, "bars": bars} for bars in bars_by_section],
    }


TRUTH = _song(
    [
        [
            [
                {"chord": "Dm7", "voicing": "x,5,7,5,6,x", "text": "Vai mi"},
                {"chord": "G7", "text": "nha"},
            ],
            [{"chord": "Cmaj7", "voicing": "x,3,5,4,5,3", "text": "teza"}],
            [{"chord": "%"}],
        ]
    ]
)


def test_perfect_candidate_scores_one():
    s = E.score_song(TRUTH, TRUTH)
    assert s["chord_acc"] == 1.0
    assert s["spelling_acc"] == 1.0
    assert s["voicing_acc"] == 1.0
    assert s["text_acc"] == 1.0
    assert s["anchor_acc"] == 1.0
    assert s["truth_bars"] == s["cand_bars"] == 3


def test_spelling_convention_counts_as_correct_chord():
    # Golden says Cmaj7 (Brazilian corpus might say C7+); candidate prints C7M.
    # Harmonically identical -> chord_acc stays 1.0, spelling_acc drops.
    cand = _song(
        [
            [
                [
                    {"chord": "Dm7", "voicing": "x,5,7,5,6,x", "text": "Vai mi"},
                    {"chord": "G7", "text": "nha"},
                ],
                [{"chord": "C7M", "voicing": "x,3,5,4,5,3", "text": "teza"}],
                [{"chord": "%"}],
            ]
        ]
    )
    s = E.score_song(TRUTH, cand)
    assert s["chord_acc"] == 1.0
    assert s["spelling_acc"] == 0.75  # 3 of 4 aligned names spelled identically
    assert s["voicing_acc"] == 1.0


def test_harm_key_equates_conventions():
    assert E.harm_key("Cmaj7") == E.harm_key("C7M")
    assert E.harm_key("Amaj7") == E.harm_key("A7+")
    assert E.harm_key("Adim7") == E.harm_key("A°7")
    assert E.harm_key("Cmaj7") != E.harm_key("C7")
    assert E.harm_key("%") == ("raw", "%")


def test_wrong_chord_name_lowers_chord_acc_only_for_that_entry():
    cand = _song(
        [
            [
                [
                    {"chord": "Dm7", "voicing": "x,5,7,5,6,x", "text": "Vai mi"},
                    {"chord": "G7b9", "text": "nha"},
                ],
                [{"chord": "Cmaj7", "voicing": "x,3,5,4,5,3", "text": "teza"}],
                [{"chord": "%"}],
            ]
        ]
    )
    s = E.score_song(TRUTH, cand)
    assert s["chord_acc"] == 0.75  # 3 of 4 names align
    assert s["voicing_acc"] == 1.0  # the aligned ones are right


def test_end_to_end_metrics_count_wrong_chords_against_field_recovery():
    cand = _song(
        [
            [
                [
                    {"chord": "Em7", "voicing": "x,5,7,5,6,x", "text": "Vai mi"},
                    {"chord": "G7", "text": "nha"},
                ],
                [{"chord": "Cmaj7", "voicing": "x,3,5,4,5,3", "text": "teza"}],
                [{"chord": "%"}],
                [{"chord": "A7"}],
            ]
        ]
    )
    s = E.score_song(TRUTH, cand)
    assert s["chord_precision"] == 0.6
    assert s["chord_recall"] == 0.75
    assert s["chord_acc"] == s["chord_recall"]  # compatibility alias
    assert s["voicing_acc"] == 1.0  # conditional on matching chords
    assert s["voicing_recovery"] == 0.5  # all truth voicing events
    assert s["text_acc"] == 1.0  # conditional on matching chords
    assert s["text_recovery"] == round(2 / 3, 4)  # all truth text events
    assert s["metric_denominators"]["voicing_acc"] == "matched_chords_with_reference_voicing"
    assert s["metric_denominators"]["voicing_recovery"] == "truth_voicing_events"


def test_printed_and_editorial_voicing_references_are_explicit():
    truth = _song([[[{"chord": "C", "voicing": "editorial", "voicing_printed": "printed"}]]])
    cand = _song([[[{"chord": "C", "voicing": "printed"}]]])
    editorial = E.score_song(truth, cand, voicing_reference_field="voicing")
    printed = E.score_song(truth, cand, voicing_reference_field="voicing_printed")
    assert editorial["voicing_reference_field"] == "voicing"
    assert editorial["voicing_recovery"] == 0.0
    assert printed["voicing_reference_field"] == "voicing_printed"
    assert printed["voicing_recovery"] == 1.0


def test_missing_song_is_a_miss_and_extra_candidates_are_reported():
    empty = _song([])
    r = E.score_corpus(
        [("present.json", TRUTH, TRUTH), ("missing.json", TRUTH, empty)],
        missing_songs=["missing.json"],
        extra_candidate_songs=["extra.json"],
    )
    assert r["aggregate"]["songs"] == 2
    assert r["aggregate"]["chord_recall"] == 0.5
    assert r["coverage"] == {
        "truth_songs": 2,
        "candidate_songs_found": 1,
        "song_recall": 0.5,
        "missing_songs": ["missing.json"],
        "extra_candidate_songs": ["extra.json"],
    }


def test_wrong_voicing_and_text_detected_on_aligned_entries():
    cand = _song(
        [
            [
                [
                    {"chord": "Dm7", "voicing": "x,5,7,5,6,5", "text": "Vai mi"},
                    {"chord": "G7", "text": "NHA"},
                ],
                [{"chord": "Cmaj7", "voicing": "x,3,5,4,5,3", "text": "tezza"}],
                [{"chord": "%"}],
            ]
        ]
    )
    s = E.score_song(TRUTH, cand)
    assert s["chord_acc"] == 1.0
    assert s["voicing_acc"] == 0.5  # Dm7 voicing wrong, Cmaj7 right
    # "NHA" matches case-insensitively; "tezza" does not -> 2 of 3
    assert s["text_acc"] == round(2 / 3, 4)


def test_missing_bar_does_not_cascade():
    # candidate lost the Cmaj7 bar entirely; Dm7/G7/% still align positionally
    cand = _song(
        [
            [
                [
                    {"chord": "Dm7", "voicing": "x,5,7,5,6,x", "text": "Vai mi"},
                    {"chord": "G7", "text": "nha"},
                ],
                [{"chord": "%"}],
            ]
        ]
    )
    s = E.score_song(TRUTH, cand)
    assert s["chord_acc"] == 0.75  # Cmaj7 missing, others still align
    assert s["cand_bars"] == 2 and s["truth_bars"] == 3


def test_score_corpus_aggregates_by_entry_weight():
    r = E.score_corpus([("a", TRUTH, TRUTH), ("b", TRUTH, TRUTH)])
    assert r["aggregate"]["songs"] == 2
    assert r["aggregate"]["chord_acc"] == 1.0
    assert r["aggregate"]["truth_entries"] == 8
    assert set(r["songs"]) == {"a", "b"}


def test_disagreements_identical_is_empty():
    assert E.disagreements(TRUTH, TRUTH) == []


def test_disagreements_reports_chords_voicings_text_structure():
    other = _song(
        [
            [
                [
                    {"chord": "Dm7", "voicing": "x,5,7,5,6,5", "text": "Vai mi"},
                    {"chord": "G7", "text": "nha"},
                ],
                [{"chord": "Am7", "voicing": "x,3,5,4,5,3", "text": "teza"}],
            ]
        ]
    )
    items = E.disagreements(TRUTH, other)
    fields = [(d["field"], d["si"], d["bi"]) for d in items]
    assert ("structure", 0, None) in fields  # 3 vs 2 bars
    assert ("voicings", 0, 0) in fields  # Dm7 voicing differs
    assert ("chords", 0, 1) in fields  # Cmaj7 vs Am7
    # chord mismatch in bar 1 suppresses its voicing/text comparison
    assert ("voicings", 0, 1) not in fields


def test_disagreements_same_harmony_is_spelling_not_chords():
    other = _song(
        [
            [
                [
                    {"chord": "Dm7", "voicing": "x,5,7,5,6,x", "text": "Vai mi"},
                    {"chord": "G7", "text": "nha"},
                ],
                [{"chord": "C7M", "voicing": "x,3,5,4,5,3", "text": "teza"}],
                [{"chord": "%"}],
            ]
        ]
    )
    items = E.disagreements(TRUTH, other)
    assert [(d["field"], d["si"], d["bi"]) for d in items] == [("spelling", 0, 1)]


def test_norm_text_dash_insensitive_but_accent_sensitive():
    assert E._norm_text("nho- ra,") == E._norm_text("nhora,")
    assert E._norm_text("tris- te- za e") == E._norm_text("tristeza e")
    assert E._norm_text("Soli-dao") != E._norm_text("Solidão")  # accents are real errors


def test_disagreements_text_normalized():
    other = _song(
        [
            [
                [
                    {"chord": "Dm7", "voicing": "x,5,7,5,6,x", "text": "VAI  mi"},
                    {"chord": "G7", "text": "nha"},
                ],
                [{"chord": "Cmaj7", "voicing": "x,3,5,4,5,3", "text": "teza"}],
                [{"chord": "%"}],
            ]
        ]
    )
    assert E.disagreements(TRUTH, other) == []  # case/whitespace-insensitive
