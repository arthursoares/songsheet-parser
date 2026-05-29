import chordmark_render as cm


def test_single_chord_fills_bar_no_dots():
    bar = [{"chord": "Dm7"}]
    assert cm.render_chord_line(bar) == "Dm7"


def test_single_chord_with_voicing_is_inline():
    bar = [{"chord": "Dm7", "voicing": "x,5,7,5,6,x"}]
    assert cm.render_chord_line(bar) == "Dm7[x,5,7,5,6,x]"


def test_voicing_to_inline_normalizes_comma_form():
    assert cm.voicing_to_inline("x, 5,7, 5,6,x") == "x,5,7,5,6,x"  # whitespace trimmed
    assert cm.voicing_to_inline("0,2,2,1,0,0") == "0,2,2,1,0,0"


def test_voicing_to_inline_keeps_two_digit_frets():
    # the fret>=10 case that the old 6-char format could not represent; fork
    # now accepts the comma form natively, so it passes straight through.
    assert cm.voicing_to_inline("x,9,11,10,11,9") == "x,9,11,10,11,9"
    assert cm.voicing_to_inline("12,12,14,14,14,12") == "12,12,14,14,14,12"


def test_voicing_to_inline_rejects_bad_input():
    import pytest

    with pytest.raises(ValueError):
        cm.voicing_to_inline("x,9,11")          # wrong count
    with pytest.raises(ValueError):
        cm.voicing_to_inline("x,9,25,1,1,1")     # out of range
    with pytest.raises(ValueError):
        cm.voicing_to_inline("x,9,z,1,1,1")      # non-numeric


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


def test_lyric_line_anchors_each_chord_text():
    bar = [
        {"chord": "Dm7", "text": "Vai mi nha"},
        {"chord": "Bdim7", "text": "tris"},
    ]
    assert cm.render_lyric_line(bar) == "_Vai mi nha _tris"


def test_lyric_line_none_when_no_text():
    bar = [{"chord": "Gm7/9"}, {"chord": "%"}]
    assert cm.render_lyric_line(bar) is None


def test_lyric_line_percent_entry_with_text():
    bar = [{"chord": "%", "text": "tris"}]
    assert cm.render_lyric_line(bar) == "_tris"


def test_lyric_line_skips_missing_text_entries():
    bar = [{"chord": "Dm7", "text": "Vai"}, {"chord": "A7"}]
    assert cm.render_lyric_line(bar) == "_Vai"


def test_render_song_full():
    song = {
        "title": "T",
        "chords": {"Dm7": [{"voicing": "x,5,7,5,6,x"}]},
        "sections": [
            {
                "label": None,
                "bars": [
                    [{"chord": "Dm7", "voicing": "x,5,7,5,6,x", "text": "Vai mi nha"}],
                    [{"chord": "%", "text": "tris"}],
                ],
            }
        ],
    }
    out = cm.render_song(song)
    # both bars carry lyrics, so they group onto one chord line + one lyric line
    assert out == (
        "chord Dm7 x,5,7,5,6,x\n"
        "\n"
        "Dm7[x,5,7,5,6,x] %\n"
        "_Vai mi nha _tris\n"
    )


def test_render_song_groups_instrumental_separately_from_sung():
    song = {"title": "T", "chords": {}, "sections": [{"label": None, "bars": [
        [{"chord": "Gm7/9"}], [{"chord": "%"}],            # instrumental run
        [{"chord": "Dm7", "text": "Vai"}], [{"chord": "%", "text": "mi"}],  # sung run
    ]}]}
    out = cm.render_song(song)
    assert out == (
        "Gm7/9 %\n"          # instrumental bars grouped, no lyric line
        "Dm7 %\n"            # sung bars grouped
        "_Vai _mi\n"
    )


def test_render_song_emits_section_label():
    song = {
        "title": "T",
        "chords": {},
        "sections": [
            {"label": "Intro", "bars": [[{"chord": "Gm7/9"}]]},
        ],
    }
    out = cm.render_song(song)
    assert out == "#Intro\nGm7/9\n"
