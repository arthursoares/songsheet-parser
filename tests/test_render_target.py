import render_target as rt


def test_diagram_open_chord_has_nut_no_position():
    svg = rt.diagram("0,2,2,1,0,0")  # E major, open
    assert svg.startswith("<svg")
    assert 'class="nut"' in svg  # open position shows a nut
    assert 'class="pos"' not in svg  # no Roman position label
    assert svg.count('class="dot"') == 3
    assert svg.count(">×<") == 0  # no muted strings here


def test_diagram_up_neck_shows_roman_position_and_mutes():
    svg = rt.diagram("x,5,7,5,6,5")  # Dm7 at 5th fret, low E muted
    assert 'class="pos"' in svg  # position label instead of nut
    assert ">V<" in svg  # 5th fret -> Roman V
    assert ">×<" in svg  # muted low E


def test_diagram_detects_barre():
    svg = rt.diagram("1,3,3,2,1,1")  # F-style barre at fret 1 (4 strings on 1)
    assert 'class="barre"' in svg


def test_diagram_invalid_voicing_is_empty():
    assert rt.diagram("x,9") == ""


def test_render_bar_chord_over_syllable():
    bar = [{"chord": "Dm7", "voicing": "x,5,7,5,6,x", "text": "Vai"}]
    out = rt.render_bar_html(bar)
    assert "Dm7" in out
    assert "Vai" in out


def test_render_bar_held_shows_percent():
    bar = [{"chord": "%", "text": "mi- nha"}]
    out = rt.render_bar_html(bar)
    assert 'class="cn">%<' in out  # held entry uses the % bar-repeat glyph
    assert "mi-" in out and "nha" in out


def test_render_bar_wrapped_in_cell():
    out = rt.render_bar_html([{"chord": "C", "text": "I"}])
    assert 'class="bar"' in out  # each bar is its own grid cell (CSS draws the |)


def test_render_bar_multichord_has_beat_dots():
    bar = [{"chord": "F", "text": "But"}, {"chord": "G", "text": "you"}]
    out = rt.render_bar_html(bar)
    assert "F.." in out and "G.." in out  # two chords over four beats -> 2 + 2


def test_render_bar_single_chord_no_dots():
    assert "C." not in rt.render_bar_html([{"chord": "C"}])


def test_body_bars_per_line_chunks_lines():
    sections = [{"label": None, "bars": [[{"chord": "C"}] for _ in range(8)]}]
    assert rt._body_html(sections, False, bars_per_line=4).count('class="ln"') == 2
    assert rt._body_html(sections, False, bars_per_line=8).count('class="ln"') == 1


def test_render_bar_dim_uses_degree_sign():
    bar = [{"chord": "Bdim7", "voicing": "x,7,8,7,8,x", "text": "te-"}]
    out = rt.render_bar_html(bar)
    assert "°" in out  # Bdim7 -> B°7 region
    assert "dim" not in out  # the literal 'dim' should be gone


def _song_two_dm7_voicings():
    return {
        "title": "T",
        "sections": [
            {
                "label": None,
                "bars": [
                    [{"chord": "Dm7", "voicing": "x,5,7,5,6,x"}],
                    [{"chord": "Dm7", "voicing": "x,x,0,2,2,1"}],
                    [{"chord": "Dm7", "voicing": "x,5,7,5,6,x"}],
                    [{"chord": "%"}],
                ],
            }
        ],
    }


def test_dictionary_per_voicing_lists_distinct_voicings():
    entries = rt.dictionary_entries(_song_two_dm7_voicings()["sections"], mode="per_voicing")
    voicings = sorted(e["voicing"] for e in entries)
    assert voicings == ["x,5,7,5,6,x", "x,x,0,2,2,1"]


def test_dictionary_per_name_collapses_to_most_common():
    entries = rt.dictionary_entries(_song_two_dm7_voicings()["sections"], mode="per_name")
    assert len(entries) == 1
    assert entries[0]["chord"] == "Dm7"
    assert entries[0]["voicing"] == "x,5,7,5,6,x"


def test_render_song_full_page():
    song = {
        "title": "Chega de Saudade",
        "composers": ["Tom Jobim", "Vinicius de Moraes"],
        "sections": [
            {
                "label": None,
                "bars": [
                    [{"chord": "Dm7", "voicing": "x,5,7,5,6,x", "text": "Vai"}],
                    [{"chord": "%", "text": "mi- nha"}],
                ],
            }
        ],
    }
    out = rt.render_song(song)
    assert out.startswith("<!doctype html>")
    assert "Chega de Saudade" in out
    assert "Tom Jobim" in out
    assert 'class="dict"' in out
    assert 'class="body"' in out
    assert "<svg" in out
    assert "mi-" in out


def test_render_song_inline_diagrams_toggle():
    song = {
        "title": "T",
        "sections": [
            {
                "label": None,
                "bars": [
                    [{"chord": "Dm7", "voicing": "x,5,7,5,6,x", "text": "a"}],
                ],
            }
        ],
    }
    no_inline = rt.render_song(song, inline_diagrams=False)
    with_inline = rt.render_song(song, inline_diagrams=True)
    assert with_inline.count("<svg") > no_inline.count("<svg")


def test_render_songbook_one_doc_many_songs():
    songA = {
        "title": "Song A",
        "sections": [
            {
                "label": None,
                "bars": [
                    [{"chord": "Dm7", "voicing": "x,5,7,5,6,x", "text": "a"}],
                ],
            }
        ],
    }
    songB = {
        "title": "Song B",
        "sections": [
            {
                "label": None,
                "bars": [
                    [{"chord": "G7", "voicing": "3,5,3,4,3,3", "text": "b"}],
                ],
            }
        ],
    }
    out = rt.render_songbook([songA, songB], title="Album")
    assert out.count("<style>") == 1  # exactly one style block
    assert "Song A" in out and "Song B" in out  # both titles present
    assert "break-before: page" in out  # page break between songs
    assert out.count('class="song"') == 2  # each song is its own section


def test_dictionary_is_alphabetical():
    sections = [
        {
            "label": None,
            "bars": [
                [{"chord": "Gm7", "voicing": "3,x,3,3,3,x"}],
                [{"chord": "A7", "voicing": "x,0,2,0,2,0"}],
                [{"chord": "Bdim7", "voicing": "x,2,3,1,3,x"}],
                [{"chord": "Am7", "voicing": "x,0,2,0,1,0"}],
            ],
        }
    ]
    names = [e["chord"] for e in rt.dictionary_entries(sections, mode="per_name")]
    assert names == ["A7", "Am7", "Bdim7", "Gm7"]
