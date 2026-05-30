#!/usr/bin/env python3
"""Render a chord-anchored song to a polished lead-sheet HTML (the "target look").

Pure functions: a song dict -> HTML string. No file or network I/O, so unit-testable.
Reads the new model: document -> songs -> sections -> bars -> [{chord, voicing?, text?}].
"""

import html as _html

ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI",
         "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX",
         "XXI", "XXII", "XXIII", "XXIV"]


def _roman(n):
    return ROMAN[n] if 0 <= n < len(ROMAN) else str(n)


def _parse_voicing(voicing):
    """'x,5,7,5,6,x' -> [None,5,7,5,6,None]; returns None if malformed (not 6 valid)."""
    toks = [t.strip() for t in str(voicing).split(",")]
    if len(toks) != 6:
        return None
    out = []
    for t in toks:
        if t == "x":
            out.append(None)
        elif t.isdigit() and 0 <= int(t) <= 24:
            out.append(int(t))
        else:
            return None
    return out


def nice_name(name):
    """Display form of a chord name: dim/dim7 -> the degree sign."""
    return name.replace("dim7", "°").replace("dim", "°")


def diagram(voicing):
    """SVG chord diagram for a comma voicing, or '' if malformed."""
    frets = _parse_voicing(voicing)
    if frets is None:
        return ""
    NS, NF = 6, 5
    W, H = 60, 74
    padL, padR, padT, padB = 15, 7, 13, 4
    gw, gh = W - padL - padR, H - padT - padB
    sx, fy = gw / (NS - 1), gh / NF
    nz = [f for f in frets if f and f > 0]
    max_f = max(nz) if nz else 0
    min_f = min(nz) if nz else 0
    start = min_f if max_f > NF else 1

    def x(i):
        return padL + i * sx

    def yf(r):
        return padT + r * fy

    el = []
    for r in range(NF + 1):
        el.append(f'<line class="fl" x1="{x(0):.1f}" y1="{yf(r):.1f}" '
                  f'x2="{x(NS-1):.1f}" y2="{yf(r):.1f}"/>')
    for i in range(NS):
        el.append(f'<line class="sl" x1="{x(i):.1f}" y1="{padT}" '
                  f'x2="{x(i):.1f}" y2="{padT+gh:.1f}"/>')
    if start == 1:
        el.append(f'<line class="nut" x1="{x(0):.1f}" y1="{padT}" '
                  f'x2="{x(NS-1):.1f}" y2="{padT}"/>')
    else:
        el.append(f'<text class="pos" x="{padL-5:.1f}" y="{padT+fy*0.72:.1f}" '
                  f'text-anchor="end">{_roman(start)}</text>')

    barred = [i for i, f in enumerate(frets) if f == start]
    if start > 0 and len(barred) >= 2:
        x1, x2 = x(min(barred)), x(max(barred))
        yb = padT + 0.5 * fy
        el.append(f'<line class="barre" x1="{x1:.1f}" y1="{yb:.1f}" '
                  f'x2="{x2:.1f}" y2="{yb:.1f}"/>')

    for i, f in enumerate(frets):
        if f is None:
            el.append(f'<text class="mk" x="{x(i):.1f}" y="{padT-4}" '
                      f'text-anchor="middle">×</text>')
        elif f == 0:
            el.append(f'<text class="mk" x="{x(i):.1f}" y="{padT-4}" '
                      f'text-anchor="middle">○</text>')
        else:
            row = f - start + 1
            el.append(f'<circle class="dot" cx="{x(i):.1f}" '
                      f'cy="{padT+(row-0.5)*fy:.1f}" r="{fy*0.32:.1f}"/>')

    return (f'<svg class="diag" viewBox="0 0 {W} {H}">' + "".join(el) + "</svg>")


def render_bar_html(bar, inline_diagrams=False):
    """Render one bar as chord-over-syllable slots (optionally with inline diagrams).

    Each chord entry becomes a slot: the chord name (or '.' if it is a held '%'
    bar) above, its syllables below. Hyphenation is taken verbatim from `text`
    (a trailing '-' on a syllable is a word continuation).
    """
    slots = []
    for entry in bar:
        chord = entry.get("chord", "")
        label = "." if chord == "%" else nice_name(chord)
        text = entry.get("text") or ""
        voicing = entry.get("voicing")
        idia = (f'<span class="idia">{diagram(voicing)}</span>'
                if inline_diagrams and voicing and chord != "%" else "")
        slots.append(
            '<span class="slot">'
            f'<span class="ch"><b class="cn">{_html.escape(label)}</b></span>'
            f'{idia}'
            f'<span class="ly">{_html.escape(text)}</span>'
            "</span>"
        )
    return "".join(slots)
