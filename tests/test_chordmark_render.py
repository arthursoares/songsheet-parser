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
        "chords": {"Dm7": [{"voicing": "x5756x"}]},
        "sections": [
            {
                "label": None,
                "bars": [
                    [{"chord": "Dm7", "voicing": "x5756x", "text": "Vai mi nha"}],
                    [{"chord": "%", "text": "tris"}],
                ],
            }
        ],
    }
    out = cm.render_song(song)
    assert out == (
        "chord Dm7 x5756x\n"
        "\n"
        "Dm7[x5756x]\n"
        "_Vai mi nha\n"
        "%\n"
        "_tris\n"
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
