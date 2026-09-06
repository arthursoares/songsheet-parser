"""Strict evaluation identity must not turn partly parsed labels into matches."""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from chord_identity import strict_harm_key
from harmony import parse_symbol

FIXTURE = json.loads(
    (Path(__file__).resolve().parent / "fixtures" / "chord_name_parity.json").read_text()
)


@pytest.mark.parametrize("invalid,valid", [("Cgarbage", "C"), ("C7wat", "C7"), ("Gmjunk", "Gm")])
def test_partially_parsed_chords_do_not_receive_harmonic_credit(invalid, valid):
    # The analysis interpreter remains lenient; evaluation adds its own boundary.
    assert parse_symbol(invalid)["quality"] == parse_symbol(valid)["quality"]
    assert strict_harm_key(invalid) == ("raw", invalid)
    assert strict_harm_key(invalid) != strict_harm_key(valid)


@pytest.mark.parametrize(
    "case", FIXTURE["agreed"] + FIXTURE["divergent"], ids=lambda c: c["symbol"]
)
def test_shared_vocabulary_preserves_existing_interpretation(case):
    name = case["symbol"]
    parsed = parse_symbol(name)
    intervals = tuple(case.get("pcs", case.get("python_pcs")))
    assert strict_harm_key(name) == ("h", parsed["root_pc"], intervals, parsed["bass_pc"])


@pytest.mark.parametrize(
    "case", FIXTURE["agreed"] + FIXTURE["divergent"], ids=lambda c: c["symbol"]
)
@pytest.mark.parametrize("suffix", ["junk", "!", "/H", "(b9"])
def test_recognized_prefix_never_hides_an_invalid_suffix(case, suffix):
    name = case["symbol"] + suffix
    assert strict_harm_key(name) == ("raw", name)


@pytest.mark.parametrize(
    "name,intervals,bass",
    [
        ("C7+", (0, 4, 7, 11), None),
        ("C7M", (0, 4, 7, 11), None),
        ("CM7", (0, 4, 7, 11), None),
        ("CM7/F#", (0, 4, 7, 11), 6),
        ("CM7(b5)", (0, 4, 6, 11), None),
        ("CmM7(b5)", (0, 3, 6, 11), None),
        ("C7sus", (0, 5, 7, 10), None),
        ("C6/9", (0, 2, 4, 7, 9), None),
        ("C7+5", (0, 4, 8, 10), None),
        ("C7-9", (0, 1, 4, 7, 10), None),
        ("C7-5", (0, 4, 6, 10), None),
        ("Cm7-5", (0, 3, 6, 10), None),
        ("C13-9", (0, 1, 4, 7, 9, 10), None),
        ("C13,9", (0, 2, 4, 7, 9, 10), None),
        ("Cm7/9", (0, 2, 3, 7, 10), None),
        ("Cm79", (0, 2, 3, 7, 10), None),
        ("Cm7(9)", (0, 2, 3, 7, 10), None),
        ("Cmmaj7", (0, 3, 7, 11), None),
        ("CmMaj7", (0, 3, 7, 11), None),
        ("Cm7+", (0, 3, 7, 11), None),
        ("Cm7M", (0, 3, 7, 11), None),
        ("C479", (0, 2, 5, 7, 10), None),
        ("C/E", (0, 4, 7), 4),
        ("Cm7/9/A#", (0, 2, 3, 7, 10), 10),
        ("C13/G", (0, 4, 7, 9, 10), 7),
        ("C°7", (0, 3, 6, 9), None),
        ("Cº7", (0, 3, 6, 9), None),
        ("C+", (0, 4, 8), None),
        ("C7(b9,#11)", (0, 1, 4, 6, 7, 10), None),
        ("C7(♭9/♯11)", (0, 1, 4, 6, 7, 10), None),
        ("C7+11", (0, 4, 6, 7, 10), None),
        ("C7-13", (0, 4, 7, 8, 10), None),
        ("C7+9", (0, 3, 4, 7, 10), None),
    ],
)
def test_brazilian_notation_and_balanced_alterations(name, intervals, bass):
    assert strict_harm_key(name) == ("h", 0, intervals, bass)


@pytest.mark.parametrize(
    "name",
    [
        None,
        "",
        "%",
        "  %  ",
        " ",
        "H7",
        "c7",
        "C##7",
        "Cbb7",
        "C♯#7",
        "C7xyz",
        "Cmajj7",
        "Cdimjunk",
        "Caugmented",
        "CmMaj7oops",
        "C7foo9",
        "C7/Bjunk",
        "C/H",
        "C7/B#junk",
        "C7/B/C",
        "C7//B",
        "C7/9/",
        "C7/",
        "C7//9",
        "C7,,9",
        "C7,",
        "C7.",
        "C7!",
        "C7?",
        "C7_",
        "C7;",
        "C7(b9",
        "C7b9)",
        "C7)b9(",
        "C7((b9))",
        "C7()",
        "C7(b9,)",
        "C7(,b9)",
        "C7(b9)(oops)",
        "C 7",
        "C7 /B",
        "C7\nB",
        "C7(b9)garbage",
        # These familiar spellings are not faithfully supported by harmony.py.
        "Cadd9",
        "Cm(add9)",
        "C5",
        "Csus2",
        "Cø7",
        "C7omit5",
        "C7alt",
    ],
)
def test_unsupported_or_malformed_notation_keeps_exact_raw_identity(name):
    assert strict_harm_key(name) == ("raw", name)


@pytest.mark.parametrize(
    "first,second",
    [
        ("Cmaj7", "C7M"),
        ("Amaj7", "A7+"),
        ("Adim7", "A°7"),
        ("D#m7/9/A#", "E♭m79/B♭"),
        ("  C7  ", "C7"),
    ],
)
def test_recognized_equivalences(first, second):
    assert strict_harm_key(first)[0] == "h"
    assert strict_harm_key(first) == strict_harm_key(second)


def test_bass_and_quality_remain_part_of_identity():
    assert strict_harm_key("C/E") != strict_harm_key("C/G")
    assert strict_harm_key("C") != strict_harm_key("C/E")
    assert strict_harm_key("Cmaj7") != strict_harm_key("C7")


def test_unknown_labels_only_match_the_exact_same_raw_label():
    assert strict_harm_key("Cgarbage") == strict_harm_key("Cgarbage")
    assert strict_harm_key("Cgarbage") != strict_harm_key("Cgarbage ")
    assert strict_harm_key("Cgarbage") != strict_harm_key("Cothergarbage")


@pytest.mark.parametrize(
    "first,second",
    [
        ("A9sus4", "Asus4"),
        ("C6sus4", "Csus4"),
        ("F46", "Fsus4"),
        ("C13", "C13,9"),
        ("CmMaj7", "CmMaj7(9)"),
        ("C7", "C7(11)"),
        ("C6/9sus4", "C9sus4"),
        ("Cmaj9sus4", "C9sus4"),
    ],
)
def test_explicit_intervals_are_not_lost_to_coarse_quality_names(first, second):
    assert strict_harm_key(first)[0] == strict_harm_key(second)[0] == "h"
    assert strict_harm_key(first) != strict_harm_key(second)


@pytest.mark.parametrize("name", ["A9sus4", "Asus4(9)", "A9/4", "A4/9", "A7sus4(9)"])
def test_suspended_ninth_dialect_variants_match(name):
    assert strict_harm_key(name) == strict_harm_key("A749")


def test_suspended_sixth_dialect_variants_match():
    assert strict_harm_key("C6sus4") == strict_harm_key("C46")
    assert strict_harm_key("C6/9sus4") == strict_harm_key("Csus4(6/9)")


@pytest.mark.parametrize(
    "name,valid",
    [
        ("C77", "C7"),
        ("C99", "C9"),
        ("C66", "C6"),
        ("C7sus4sus4", "C7sus4"),
        ("C7#5#5", "C7#5"),
        ("Cmaj77", "Cmaj7"),
        ("CmMaj77", "CmMaj7"),
        ("Cdim77", "Cdim7"),
        ("C°77", "C°7"),
        ("C7M7", "C7M"),
        ("C7+7", "C7+"),
        ("Csus44", "Csus4"),
        ("C7sus4(4)", "C7sus4"),
        ("C47sus", "C47"),
        ("C7sus(sus4)", "C7sus4"),
        ("C7b9b9", "C7b9"),
        ("C7+5(#5)", "C7#5"),
        ("C7♭9(-9)", "C7b9"),
        ("C7(9)/9/E", "C7/9/E"),
        ("C13,9(13)", "C13,9"),
        ("C7(11)/11", "C7(11)"),
    ],
)
def test_duplicate_extensions_or_qualifiers_keep_raw_identity(name, valid):
    assert strict_harm_key(name) == ("raw", name)
    assert strict_harm_key(valid)[0] == "h"
    assert strict_harm_key(name) != strict_harm_key(valid)


@pytest.mark.parametrize(
    "name,intervals",
    [
        ("C69", (0, 2, 4, 7, 9)),
        ("C479", (0, 2, 5, 7, 10)),
        ("C749", (0, 2, 5, 7, 10)),
        ("C7/9", (0, 2, 4, 7, 10)),
        ("C7+/9", (0, 2, 4, 7, 11)),
        ("C7M(9)", (0, 2, 4, 7, 11)),
        ("C7b9#9", (0, 1, 3, 4, 7, 10)),
        ("C7b5#5", (0, 4, 6, 8, 10)),
        ("C7(b9,#11)", (0, 1, 4, 6, 7, 10)),
        ("C7(9/11)", (0, 2, 4, 5, 7, 10)),
        ("C13,9", (0, 2, 4, 7, 9, 10)),
        # A qualifier may restate an implied tone: only repeated notation
        # tokens are rejected, not every way to spell the same pitch set.
        ("Caug#5", (0, 4, 8)),
        ("Cdim(b5)", (0, 3, 6)),
    ],
)
def test_distinct_extensions_and_compact_dialect_still_receive_identity(name, intervals):
    assert strict_harm_key(name) == ("h", 0, intervals, None)
