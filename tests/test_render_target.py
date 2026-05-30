import render_target as rt


def test_diagram_open_chord_has_nut_no_position():
    svg = rt.diagram("0,2,2,1,0,0")  # E major, open
    assert svg.startswith("<svg")
    assert 'class="nut"' in svg          # open position shows a nut
    assert 'class="pos"' not in svg      # no Roman position label
    assert svg.count('class="dot"') == 3
    assert svg.count(">×<") == 0    # no muted strings here


def test_diagram_up_neck_shows_roman_position_and_mutes():
    svg = rt.diagram("x,5,7,5,6,5")      # Dm7 at 5th fret, low E muted
    assert 'class="pos"' in svg          # position label instead of nut
    assert ">V<" in svg                  # 5th fret -> Roman V
    assert ">×<" in svg             # muted low E


def test_diagram_detects_barre():
    svg = rt.diagram("1,3,3,2,1,1")      # F-style barre at fret 1 (4 strings on 1)
    assert 'class="barre"' in svg


def test_diagram_invalid_voicing_is_empty():
    assert rt.diagram("x,9") == ""


def test_render_bar_chord_over_syllable():
    bar = [{"chord": "Dm7", "voicing": "x,5,7,5,6,x", "text": "Vai"}]
    out = rt.render_bar_html(bar)
    assert "Dm7" in out
    assert "Vai" in out


def test_render_bar_held_shows_dot():
    bar = [{"chord": "%", "text": "mi- nha"}]
    out = rt.render_bar_html(bar)
    assert 'class="cn">.<' in out
    assert "mi-" in out and "nha" in out


def test_render_bar_dim_uses_degree_sign():
    bar = [{"chord": "Bdim7", "voicing": "x,7,8,7,8,x", "text": "te-"}]
    out = rt.render_bar_html(bar)
    assert "°" in out          # Bdim7 -> B°7 region
    assert "dim" not in out         # the literal 'dim' should be gone
