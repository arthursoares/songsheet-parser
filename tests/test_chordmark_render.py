import chordmark_render as cm


def test_single_chord_fills_bar_no_dots():
    bar = [{"chord": "Dm7"}]
    assert cm.render_chord_line(bar) == "Dm7"


def test_single_chord_with_voicing_is_inline():
    bar = [{"chord": "Dm7", "voicing": "x5756x"}]
    assert cm.render_chord_line(bar) == "Dm7[x5756x]"


def test_percent_renders_as_percent():
    bar = [{"chord": "%"}]
    assert cm.render_chord_line(bar) == "%"


def test_two_chords_split_evenly():
    bar = [{"chord": "Em7"}, {"chord": "A13"}]
    assert cm.render_chord_line(bar) == "Em7.. A13.."


def test_three_chords_largest_remainder_sums_to_four():
    bar = [{"chord": "A"}, {"chord": "B"}, {"chord": "C"}]
    assert cm.render_chord_line(bar) == "A.. B. C."


def test_four_chords_one_beat_each():
    bar = [{"chord": "A"}, {"chord": "B"}, {"chord": "C"}, {"chord": "D"}]
    assert cm.render_chord_line(bar) == "A. B. C. D."
