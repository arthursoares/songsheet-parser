"""bars_per_line is the shared layout guide for both renderers."""

import chordmark_render as cr
import render_target as rt


def _instrumental_song(n):
    return {"sections": [{"label": None, "bars": [[{"chord": "C"}] for _ in range(n)]}]}


def test_chordmark_group_bars_respects_max():
    bars = [[{"chord": "C"}] for _ in range(6)]
    assert len(cr._group_bars(bars, 4)) == 2  # 6 bars, cap 4 -> 2 lines
    assert len(cr._group_bars(bars, 8)) == 1  # cap 8 -> 1 line


def test_chordmark_render_song_bars_per_line_changes_layout():
    song = _instrumental_song(8)
    out4 = cr.render_song(song, bars_per_line=4)
    out8 = cr.render_song(song, bars_per_line=8)
    # 8 instrumental bars: 4/line -> two chord lines; 8/line -> one
    assert out4.count("\n") > out8.count("\n")


def test_chordmark_render_song_default_is_four():
    song = _instrumental_song(8)
    assert cr.render_song(song) == cr.render_song(song, bars_per_line=4)


def test_target_bars_per_line_matches_chordmark_count():
    song = _instrumental_song(12)
    sections = song["sections"]
    assert rt._body_html(sections, False, bars_per_line=4).count('class="ln"') == 3
    assert rt._body_html(sections, False, bars_per_line=6).count('class="ln"') == 2
