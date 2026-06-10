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
        cm.voicing_to_inline("x,9,11")  # wrong count
    with pytest.raises(ValueError):
        cm.voicing_to_inline("x,9,25,1,1,1")  # out of range
    with pytest.raises(ValueError):
        cm.voicing_to_inline("x,9,z,1,1,1")  # non-numeric


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
    assert out == ("chord Dm7 x,5,7,5,6,x\n\nDm7[x,5,7,5,6,x] %\n_Vai mi nha _tris\n")


def test_render_song_groups_instrumental_separately_from_sung():
    song = {
        "title": "T",
        "chords": {},
        "sections": [
            {
                "label": None,
                "bars": [
                    [{"chord": "Gm7/9"}],
                    [{"chord": "%"}],  # instrumental run
                    [{"chord": "Dm7", "text": "Vai"}],
                    [{"chord": "%", "text": "mi"}],  # sung run
                ],
            }
        ],
    }
    out = cm.render_song(song)
    assert out == (
        "Gm9 %\n"  # instrumental bars grouped, no lyric line
        "Dm7 %\n"  # sung bars grouped
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
    assert out == "#Intro\nGm9\n"


def test_leading_percent_is_resolved_to_real_chord():
    # A chord line must not start with "%" (ChordMark would misparse it as lyric).
    # A held chord that lands first on a grouped line is de-referenced to the
    # actual sounding chord, carrying its voicing + text.
    song = {
        "title": "T",
        "chords": {},
        "sections": [
            {
                "label": None,
                "bars": [
                    [{"chord": "Dm7", "voicing": "x,5,7,5,6,x"}],  # establishes the chord
                    [{"chord": "A7"}],
                    [{"chord": "G7"}],
                    [{"chord": "C7"}],  # fill bar 1's line
                    [{"chord": "%", "text": "held"}],  # would start a new line as "%"
                ],
            }
        ],
    }
    out = cm.render_song(song)
    for line in out.splitlines():
        assert not line.startswith("%"), f"chord line starts with %: {line!r}"
    # the resolved chord (Dm7 with its voicing) appears on the continued line
    assert "Dm7[x,5,7,5,6,x]" in out


def test_render_song_emits_composer_and_key_declarations():
    song = {
        "title": "Chega de Saudade",
        "composers": ["T. Jobim", "Vinicius de Moraes"],
        "key": "Dm",
        "chords": {},
        "sections": [{"label": None, "bars": [[{"chord": "Dm7", "text": "Vai"}]]}],
    }
    out = cm.render_song(song)
    lines = out.splitlines()
    assert lines[0] == "composer T. Jobim, Vinicius de Moraes"
    assert lines[1] == "key Dm"
    assert lines[2] == ""  # blank line before the body


def test_render_song_skips_invalid_key_and_empty_composers():
    song = {
        "title": "X",
        "composers": [],
        "key": "F#69",  # a misparsed chord, not a key
        "chords": {},
        "sections": [{"label": None, "bars": [[{"chord": "A"}]]}],
    }
    out = cm.render_song(song)
    assert "composer" not in out
    assert "key" not in out
    assert out.startswith("A")


def test_render_song_drops_empty_bars():
    song = {
        "title": "X",
        "chords": {},
        "sections": [{"label": None, "bars": [[], [{"chord": "Dm7", "text": "Vai"}], []]}],
    }
    out = cm.render_song(song)
    assert out == "Dm7\n_Vai\n"


def test_normalize_chord_name_brazilian_tension_stacks():
    cases = {
        "E13,9": "E13",
        "E13.9/D": "E13/D",
        "A9,13": "A13",
        "A13,♭9": "A13-9",
        "E13,-9": "E13-9",
        "A13,4": "A13sus4",
        "C#4/9": "C#9sus4",
        "Em4/79": "Em9sus4",
        "A9/4": "A9sus4",
        "A7/4/9": "A9sus4",
        "G7/4": "G7sus4",
        "F#m7-9": "F#m7b9",
        "Bm7-9/F#": "Bm7b9/F#",
        # the original rules still apply
        "C7/9": "C9",
        "C6/9": "C69",
    }
    for raw, expected in cases.items():
        assert cm.normalize_chord_name(raw) == expected, raw
