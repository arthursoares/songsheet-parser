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
    assert strict_harm_key(name) == ("h", parsed["root_pc"], parsed["quality"], parsed["bass_pc"])


@pytest.mark.parametrize(
    "case", FIXTURE["agreed"] + FIXTURE["divergent"], ids=lambda c: c["symbol"]
)
@pytest.mark.parametrize("suffix", ["junk", "!", "/H", "(b9"])
def test_recognized_prefix_never_hides_an_invalid_suffix(case, suffix):
    name = case["symbol"] + suffix
    assert strict_harm_key(name) == ("raw", name)


@pytest.mark.parametrize(
    "name,quality,bass",
    [
        ("C7+", "maj7", None),
        ("C7M", "maj7", None),
        ("CM7", "maj7", None),
        ("CM7/F#", "maj7", 6),
        ("CM7(b5)", "maj7♭5", None),
        ("CmM7(b5)", "mMaj7♭5", None),
        ("C7sus", "7sus4", None),
        ("C6/9", "6/9", None),
        ("C7+5", "7♯5", None),
        ("C7-9", "7♭9", None),
        ("C7-5", "7♭5", None),
        ("Cm7-5", "m7♭5", None),
        ("C13-9", "13♭9", None),
        ("C13,9", "13", None),
        ("Cm7/9", "m9", None),
        ("Cm79", "m9", None),
        ("Cm7(9)", "m9", None),
        ("Cmmaj7", "mMaj7", None),
        ("CmMaj7", "mMaj7", None),
        ("Cm7+", "mMaj7", None),
        ("Cm7M", "mMaj7", None),
        ("C479", "9sus4", None),
        ("C/E", "", 4),
        ("Cm7/9/A#", "m9", 10),
        ("C13/G", "13", 7),
        ("C°7", "°7", None),
        ("Cº7", "°7", None),
        ("C+", "aug", None),
        ("C7(b9,#11)", "7♭9♯11", None),
        ("C7(♭9/♯11)", "7♭9♯11", None),
        ("C7+11", "7♯11", None),
        ("C7-13", "7♭13", None),
        ("C7+9", "7♯9", None),
    ],
)
def test_brazilian_notation_and_balanced_alterations(name, quality, bass):
    assert strict_harm_key(name) == ("h", 0, quality, bass)


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
