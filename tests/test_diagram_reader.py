import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import diagram_reader as D

# ---------------------------------------------------------------------------
# synthetic diagram rendering (mimics the Lumiar grayscale bands)
# ---------------------------------------------------------------------------

# SHADE sits between LINE (220) and INK (235): real shading is mottled grey
# that doesn't register as grid-line ink but is darker than white
THIN, BOLD, NUT, DOT, SHADE = 199, 80, 50, 40, 228


def make_page(pattern, dot_frets, nut=True, base_col0=1, shaded=None):
    """Render one synthetic diagram on a white page.

    pattern: 6 chars low-E..high-e of F/O/M; dot_frets: fret column index
    (0-based) per F string, low-E first.
    """
    page = np.full((60, 80), 255, dtype=int)
    gx0, gy0 = 20, 15
    n_cells, cw, sp = 5, 6, 4
    gx1 = gx0 + n_cells * cw
    ys = [gy0 + i * sp for i in range(6)]
    # vertical fret lines
    for j in range(n_cells + 1):
        page[gy0 : ys[-1] + 1, gx0 + j * cw] = THIN
    if nut:
        page[gy0 : ys[-1] + 1, gx0 : gx0 + 2] = NUT
    if shaded is not None:
        page[gy0 : ys[-1] + 1, gx0 + shaded * cw + 1 : gx0 + (shaded + 1) * cw] = SHADE
    # string lines: top = high e. pattern is low-E first -> reverse for rows.
    rows = list(reversed(pattern))
    fret_rows = list(reversed(dot_frets))
    for i, (y, p) in enumerate(zip(ys, rows)):
        page[y, gx0 : gx1 + 1] = THIN if p == "M" else BOLD
    # dots: ~0.7 of the cell width in, 5px tall (overhanging the line)
    for i, (y, p) in enumerate(zip(ys, rows)):
        if p != "F":
            continue
        col = fret_rows[i]
        cx = gx0 + int((col + 0.7) * cw)
        page[max(0, y - 2) : y + 3, cx - 1 : cx + 2] = DOT
    return page


def test_synthetic_nut_diagram_round_trips():
    # Bm7/F#-style: 2,x,0,2,0,x -> dots at fret 2 (col 1) on low-E and G
    page = make_page("FMOFOM", [1, None, None, 1, None, None], nut=True)
    boxes = D.detect_diagrams(page)
    assert len(boxes) == 1
    dec, err = D.decode_diagram(page, boxes[0])
    assert err is None
    assert dec["pattern"] == "FMOFOM"
    assert dec["nut"] is True
    assert dec["dot_cols"][0] == 1 and dec["dot_cols"][3] == 1
    v, base, scored = D.resolve_voicing(dec, "Bm7/F#")
    assert (v, base, scored) == ("2,x,0,2,0,x", 1, False)


def test_synthetic_position_diagram_resolves_base_harmonically():
    # Amaj7-style 5,x,6,6,5,x: dots at cols 0,1,1,0 (base 5), shaded col 0
    page = make_page("FMFFFM", [0, None, 1, 1, 0, None], nut=False, shaded=0)
    boxes = D.detect_diagrams(page)
    assert len(boxes) == 1
    dec, err = D.decode_diagram(page, boxes[0])
    assert err is None
    assert dec["pattern"] == "FMFFFM"
    v, base, scored = D.resolve_voicing(dec, "Amaj7")
    assert scored is True
    assert v == "5,x,6,6,5,x" and base == 5


def test_spurious_nut_falls_back_to_harmonic_base():
    # G#7-style 4,x,4,5,4,x drawn WITH a (spurious) nut: fret-1 reading has no
    # G# in it, so the resolver must ignore the nut and search bases.
    page = make_page("FMFFFM", [0, None, 0, 1, 0, None], nut=True)
    dec, _ = D.decode_diagram(page, D.detect_diagrams(page)[0])
    v, base, scored = D.resolve_voicing(dec, "G#7")
    assert scored is True
    assert v == "4,x,4,5,4,x" and base == 4


def test_voicing_for_base_and_pcs():
    dec = {"pattern": "FMOFOM", "dot_cols": [1, None, None, 1, None, None]}
    assert D.voicing_for_base(dec, 1) == "2,x,0,2,0,x"
    assert D._pcs("2,x,0,2,0,x") == {6, 2, 9, 11}  # F# D A B = Bm7/F#


def test_resolve_without_name_returns_none_for_position_diagrams():
    dec = {
        "pattern": "FMFFFM",
        "dot_cols": [0, None, 1, 1, 0, None],
        "nut": False,
        "digit_bitmap": None,
        "digit_col": None,
    }
    assert D.resolve_voicing(dec, None) == (None, None, False)


def test_glyph_distance_and_match():
    five = [[1, 1, 1], [1, 0, 0], [1, 1, 1], [0, 0, 1], [1, 1, 1]]
    two = [[1, 1, 1], [0, 0, 1], [1, 1, 1], [1, 0, 0], [1, 1, 1]]
    assert D._glyph_distance(five, five) == 0
    assert D._glyph_distance(five, two) == 4
    templates = {"5": [five], "2": [two]}
    smudged = [r[:] for r in five]
    smudged[1][1] = 1
    value, dist = D.match_digit(smudged, templates)
    assert value == 5 and dist == 1
    assert D.match_digit(None, templates) == (None, None)


def test_digit_templates_file_loads():
    t = D.load_digit_templates()
    assert isinstance(t, dict)
    # calibrated bank ships with the repo; spot-check shape if present
    for glyphs in t.values():
        for g in glyphs:
            assert all(v in (0, 1) for row in g for v in row)
