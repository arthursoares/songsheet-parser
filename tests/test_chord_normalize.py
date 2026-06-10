"""ChordMark output normalizes Brazilian tension-slash names for the fork parser."""

import chordmark_render as cr


def test_normalize_tension_infix_to_extension():
    assert cr.normalize_chord_name("D#m7/9/A#") == "D#m9/A#"  # m7/9 -> m9, bass kept
    assert cr.normalize_chord_name("D#7/9/A#") == "D#9/A#"  # 7/9 -> 9, bass kept
    assert cr.normalize_chord_name("C7/13") == "C13"
    assert cr.normalize_chord_name("Am7/11") == "Am11"
    assert cr.normalize_chord_name("C6/9") == "C69"


def test_normalize_leaves_parseable_names_untouched():
    for name in ["C#69/G#", "D#m9/A#", "G#7", "Dmaj7", "A#7-5", "D69/A"]:
        assert cr.normalize_chord_name(name) == name


def test_normalize_passes_through_percent_and_empty():
    assert cr.normalize_chord_name("%") == "%"
    assert cr.normalize_chord_name("") == ""


def test_chord_token_normalizes_in_chordmark_output():
    bar = [{"chord": "D#m7/9/A#", "voicing": "6,x,4,4,6,6"}]
    assert "D#m9/A#[6,x,4,4,6,6]" in cr.render_chord_line(bar)
    assert "D#m7/9/A#" not in cr.render_chord_line(bar)
