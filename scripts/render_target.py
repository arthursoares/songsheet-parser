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


def _iter_entries(sections):
    for sec in sections or []:
        for bar in sec.get("bars", []):
            for entry in bar:
                yield entry


def dictionary_entries(sections, mode="per_voicing"):
    """Distinct chord diagrams for the dictionary.

    per_voicing: one entry per distinct (chord, voicing), most-frequent first.
    per_name:    one entry per chord name, using its most-common voicing.
    Entries without a voicing, and '%' held bars, are excluded.
    """
    counts = {}
    order = []
    for entry in _iter_entries(sections):
        chord = entry.get("chord")
        voicing = entry.get("voicing")
        if not chord or chord == "%" or not voicing:
            continue
        key = (chord, voicing)
        if key not in counts:
            counts[key] = {"chord": chord, "voicing": voicing, "count": 0}
            order.append(key)
        counts[key]["count"] += 1

    if mode == "per_name":
        best = {}
        for key in order:
            e = counts[key]
            cur = best.get(e["chord"])
            if cur is None or e["count"] > cur["count"]:
                best[e["chord"]] = e
        seen, result = set(), []
        for key in order:
            name = counts[key]["chord"]
            if name not in seen:
                seen.add(name)
                result.append(best[name])
        return result

    return [counts[key] for key in order]


import chordmark_render  # reuse phrase-grouping  # noqa: E402


_CSS = """
@page { size: A4; margin: 1.4cm; } * { box-sizing: border-box; }
body { margin:0; background:#f0f0f1; color:#111;
  font-family: Georgia, "Times New Roman", serif; }
.page { max-width: 820px; margin: 1.5rem auto; background:#fff;
  padding: 2.4rem 2.6rem 3rem; box-shadow: 0 1px 6px rgba(0,0,0,.12); }
h1 { text-align:center; font-size: 2.4rem; font-weight:700; margin:0 0 .15rem; }
.composer { text-align:center; font-variant: small-caps; letter-spacing:1px;
  margin:0 0 1.3rem; font-size:.95rem; }
.dict { display:flex; flex-wrap:wrap; gap:.7rem 1rem; justify-content:center;
  padding:0 0 1.1rem; margin-bottom:1.3rem; border-bottom:1px solid #ddd; }
.dia { text-align:center; width:58px; }
.dn { font-weight:700; font-size:.82rem; margin-bottom:1px; white-space:nowrap; }
.diag { width:58px; height:auto; display:block; }
.diag .fl,.diag .sl { stroke:#333; stroke-width:.8; }
.diag .nut { stroke:#222; stroke-width:2.6; }
.diag .barre { stroke:#111; stroke-width:4.4; stroke-linecap:round; }
.diag .dot { fill:#111; }
.diag .mk { font:6.5px Georgia,serif; fill:#111; }
.diag .pos { font:italic 7.5px Georgia,serif; fill:#111; }
.seclabel { font-weight:700; text-decoration:underline; margin:.6rem 0 .4rem; }
.body { columns: 2; column-gap: 2.4rem; font-size: 1.02rem; line-height: 1.15; }
.line { break-inside: avoid; margin: 0 0 1.05rem; }
.slot { display:inline-flex; flex-direction:column; vertical-align:bottom;
  padding-right:.8em; }
.slot .ch { height:1.3em; white-space:nowrap; } .slot .cn { font-weight:700; }
.slot .ly { white-space:pre; }
.slot .idia { display:block; }
.slot .idia svg { width:42px; height:auto; }
"""


def _dictionary_html(sections, mode):
    parts = []
    for e in dictionary_entries(sections, mode):
        parts.append(f'<div class="dia"><div class="dn">{_html.escape(nice_name(e["chord"]))}</div>'
                     f'{diagram(e["voicing"])}</div>')
    return '<div class="dict">' + "".join(parts) + "</div>"


def _body_html(sections, inline_diagrams):
    lines = []
    for sec in sections or []:
        label = sec.get("label")
        if label:
            lines.append(f'<div class="seclabel">{_html.escape(label)}</div>')
        for group in chordmark_render._group_bars(sec.get("bars", [])):
            slots = []
            for bar in group:
                slots.append(render_bar_html(bar, inline_diagrams=inline_diagrams))
            lines.append('<div class="line">' + "".join(slots) + "</div>")
    return '<div class="body">' + "".join(lines) + "</div>"


def render_song(song, dictionary="per_voicing", inline_diagrams=False):
    """Render a song dict to a full standalone target-look HTML page."""
    sections = song.get("sections", [])
    title = _html.escape(song.get("title") or "")
    composer = _html.escape(", ".join(song.get("composers") or []))
    return (
        "<!doctype html><html><head><meta charset=\"utf-8\">"
        f"<title>{title}</title><style>{_CSS}</style></head>"
        '<body><div class="page">'
        f"<h1>{title}</h1><div class=\"composer\">{composer}</div>"
        f"{_dictionary_html(sections, dictionary)}"
        f"{_body_html(sections, inline_diagrams)}"
        "</div></body></html>"
    )
