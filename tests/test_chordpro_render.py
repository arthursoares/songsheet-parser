import chordpro_render as cp


def test_render_chordpro_title_inline_chord_and_section_comment():
    song = {
        "title": "Chega de Saudade",
        "composers": ["Tom Jobim", "Vinicius de Moraes"],
        "sections": [
            {
                "label": "Verse",
                "bars": [
                    [{"chord": "Dm7", "voicing": "x,5,7,5,6,x", "text": "Vai"}],
                    [{"chord": "%", "text": "mi nha"}],
                ],
            },
        ],
    }
    out = cp.render_chordpro(song)
    assert "{title: Chega de Saudade}" in out
    assert "{composer: Tom Jobim, Vinicius de Moraes}" in out
    assert "{comment: Verse}" in out
    assert "[Dm7]Vai" in out  # inline chord tag before its syllable
    assert "[Dm7]mi nha" in out  # % re-states the sounding chord


def test_render_chordpro_instrumental_bar_bare_tags():
    song = {
        "title": "T",
        "sections": [
            {
                "label": None,
                "bars": [
                    [{"chord": "Gm7"}, {"chord": "A7"}],
                ],
            }
        ],
    }
    out = cp.render_chordpro(song)
    assert "[Gm7] [A7]" in out  # instrumental bar -> bare chord tokens
    assert "{title: T}" in out


def test_render_chordpro_multi_chord_lyric_line_anchors_in_order():
    song = {
        "title": "T",
        "sections": [
            {
                "label": None,
                "bars": [
                    [{"chord": "F", "text": "But"}, {"chord": "G", "text": "you"}],
                ],
            }
        ],
    }
    out = cp.render_chordpro(song)
    assert "[F]But[G]you" in out
