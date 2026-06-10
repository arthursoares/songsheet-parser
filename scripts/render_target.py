#!/usr/bin/env python3
"""Render a chord-anchored song to a polished lead-sheet HTML (the "target look").

Pure functions: a song dict -> HTML string. No file or network I/O, so unit-testable.
Reads the new model: document -> songs -> sections -> bars -> [{chord, voicing?, text?}].
"""

import html as _html

ROMAN = [
    "",
    "I",
    "II",
    "III",
    "IV",
    "V",
    "VI",
    "VII",
    "VIII",
    "IX",
    "X",
    "XI",
    "XII",
    "XIII",
    "XIV",
    "XV",
    "XVI",
    "XVII",
    "XVIII",
    "XIX",
    "XX",
    "XXI",
    "XXII",
    "XXIII",
    "XXIV",
]


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
        el.append(
            f'<line class="fl" x1="{x(0):.1f}" y1="{yf(r):.1f}" '
            f'x2="{x(NS - 1):.1f}" y2="{yf(r):.1f}"/>'
        )
    for i in range(NS):
        el.append(
            f'<line class="sl" x1="{x(i):.1f}" y1="{padT}" x2="{x(i):.1f}" y2="{padT + gh:.1f}"/>'
        )
    if start == 1:
        el.append(
            f'<line class="nut" x1="{x(0):.1f}" y1="{padT}" x2="{x(NS - 1):.1f}" y2="{padT}"/>'
        )
    else:
        el.append(
            f'<text class="pos" x="{padL - 5:.1f}" y="{padT + fy * 0.72:.1f}" '
            f'text-anchor="end">{_roman(start)}</text>'
        )

    barred = [i for i, f in enumerate(frets) if f == start]
    if start > 0 and len(barred) >= 2:
        x1, x2 = x(min(barred)), x(max(barred))
        yb = padT + 0.5 * fy
        el.append(f'<line class="barre" x1="{x1:.1f}" y1="{yb:.1f}" x2="{x2:.1f}" y2="{yb:.1f}"/>')

    for i, f in enumerate(frets):
        if f is None:
            el.append(
                f'<text class="mk" x="{x(i):.1f}" y="{padT - 4}" text-anchor="middle">×</text>'
            )
        elif f == 0:
            el.append(
                f'<text class="mk" x="{x(i):.1f}" y="{padT - 4}" text-anchor="middle">○</text>'
            )
        else:
            row = f - start + 1
            el.append(
                f'<circle class="dot" cx="{x(i):.1f}" '
                f'cy="{padT + (row - 0.5) * fy:.1f}" r="{fy * 0.32:.1f}"/>'
            )

    return f'<svg class="diag" viewBox="0 0 {W} {H}">' + "".join(el) + "</svg>"


def _bar_tokens(bar):
    """Per-entry (label, text, voicing, chord) for a bar, with duration dots.

    A multi-chord bar gets beat dots distributed exactly as ChordMark does
    (largest-remainder over DEFAULT_BEATS): two chords -> 'C.. G..', and
    'F... G.' for 3+1. A single-chord bar gets no dots (it fills the bar).
    A held '%' entry is shown as '%' (ChordMark bar-repeat convention), never '.'.
    """
    n = len(bar)
    if n <= 1:
        durs = [None] * n
    else:
        durs = chordmark_render._distribute_beats(n, chordmark_render.DEFAULT_BEATS)
    out = []
    for entry, dur in zip(bar, durs):
        chord = entry.get("chord", "")
        label = "%" if chord == "%" else nice_name(chord)
        if dur is not None:
            label = label + "." * dur
        out.append((label, entry.get("text") or "", entry.get("voicing"), chord))
    return out


def render_bar_html(bar, inline_diagrams=False):
    """Render one bar as a grid cell of chord-over-syllable slots.

    Each chord entry is a slot: the chord name (with beat dots for multi-chord
    bars, or '%' for a held entry) above its syllables below. The enclosing
    `.bar` cell draws the bar lines (the `|`) and gives every bar equal width.
    Hyphenation is verbatim from `text` (a trailing '-' marks a word continuation).
    """
    slots = []
    for label, text, voicing, chord in _bar_tokens(bar):
        idia = (
            f'<span class="idia">{diagram(voicing)}</span>'
            if inline_diagrams and voicing and chord != "%"
            else ""
        )
        slots.append(
            '<span class="sl">'
            f'<span class="ch"><b class="cn">{_html.escape(label)}</b></span>'
            f"{idia}"
            f'<span class="ly">{_html.escape(text)}</span>'
            "</span>"
        )
    return '<div class="bar">' + "".join(slots) + "</div>"


def _iter_entries(sections):
    for sec in sections or []:
        for bar in sec.get("bars", []):
            for entry in bar:
                yield entry


def _dict_sort_key(entry):
    """Alphabetical sort key for a dictionary entry: by chord name, then voicing.

    Case-insensitive on the name so e.g. A, Am, A7 group naturally.
    """
    return (entry["chord"].lower(), entry.get("voicing") or "")


def dictionary_entries(sections, mode="per_voicing"):
    """Distinct chord diagrams for the dictionary, alphabetically ordered.

    per_voicing: one entry per distinct (chord, voicing).
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
        return sorted(best.values(), key=_dict_sort_key)

    return sorted(counts.values(), key=_dict_sort_key)


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
.seclabel { font-weight:700; text-decoration:underline; margin:1rem 0 .45rem;
  font-family: Georgia, serif; }
.body { font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
  font-size:.88rem; line-height:1.3; }
.ln { display:grid; gap:0; margin:0 0 .55rem; break-inside:avoid; }
.bar { border-left:1px solid #888; padding:.05rem .6ch .2rem; min-width:0;
  overflow:hidden; }
.ln .bar:last-child { border-right:1px solid #888; }
.sl { display:inline-flex; flex-direction:column; vertical-align:bottom;
  padding-right:.9ch; }
.sl .ch { height:1.4em; white-space:pre; } .sl .cn { font-weight:700; }
.sl .ly { white-space:pre-wrap; overflow-wrap:anywhere; }
.sl .idia { display:block; }
.sl .idia svg { width:42px; height:auto; }
"""


def _dictionary_html(sections, mode):
    parts = []
    for e in dictionary_entries(sections, mode):
        parts.append(
            f'<div class="dia"><div class="dn">{_html.escape(nice_name(e["chord"]))}</div>'
            f"{diagram(e['voicing'])}</div>"
        )
    return '<div class="dict">' + "".join(parts) + "</div>"


def _chunk(items, n):
    """Split a list into consecutive chunks of at most n (n>=1)."""
    n = max(1, n)
    return [items[i : i + n] for i in range(0, len(items), n)]


def _body_html(sections, inline_diagrams, bars_per_line=4):
    """Render sections as an even bar-grid: `bars_per_line` equal-width bars per
    line, each its own cell (CSS draws the bar lines), chords over their syllables."""
    cols = f"grid-template-columns:repeat({bars_per_line},1fr)"
    lines = []
    for sec in sections or []:
        label = sec.get("label")
        if label:
            lines.append(f'<div class="seclabel">{_html.escape(label)}</div>')
        for group in _chunk(sec.get("bars", []), bars_per_line):
            cells = "".join(render_bar_html(bar, inline_diagrams=inline_diagrams) for bar in group)
            lines.append(f'<div class="ln" style="{cols}">{cells}</div>')
    return '<div class="body">' + "".join(lines) + "</div>"


def _song_inner_html(song, dictionary="per_voicing", inline_diagrams=False, bars_per_line=4):
    """The per-song body markup (title + composer + dictionary + body), no <style>.

    Shared by render_song (standalone page) and render_songbook (one doc, many songs)
    so both produce identical inner markup.
    """
    sections = song.get("sections", [])
    title = _html.escape(song.get("title") or "")
    composer = _html.escape(", ".join(song.get("composers") or []))
    return (
        f'<h1>{title}</h1><div class="composer">{composer}</div>'
        f"{_dictionary_html(sections, dictionary)}"
        f"{_body_html(sections, inline_diagrams, bars_per_line)}"
    )


def render_song(song, dictionary="per_voicing", inline_diagrams=False, bars_per_line=4):
    """Render a song dict to a full standalone target-look HTML page."""
    title = _html.escape(song.get("title") or "")
    inner = _song_inner_html(
        song, dictionary=dictionary, inline_diagrams=inline_diagrams, bars_per_line=bars_per_line
    )
    return (
        '<!doctype html><html><head><meta charset="utf-8">'
        f"<title>{title}</title><style>{_CSS}</style></head>"
        '<body><div class="page">'
        f"{inner}"
        "</div></body></html>"
    )


# Extra CSS only the songbook needs: a page break before every song after the first,
# and a simple table-of-contents at the top.
_SONGBOOK_CSS = """
.song { break-before: page; background:#fff; max-width:820px; margin:1.5rem auto;
  padding:2.4rem 2.6rem 3rem; box-shadow:0 1px 6px rgba(0,0,0,.12); }
.song:first-of-type { break-before: auto; }
.toc { max-width:820px; margin:1.5rem auto; background:#fff;
  padding:2rem 2.6rem; box-shadow:0 1px 6px rgba(0,0,0,.12); }
.toc h1 { margin-bottom:1rem; }
.toc ol { font-family:Georgia,serif; font-size:1rem; line-height:1.6; }
"""


def render_songbook(
    songs, title="", dictionary="per_voicing", inline_diagrams=False, bars_per_line=4
):
    """Render many song dicts into ONE standalone HTML document.

    One shared <style> block; an optional title + table-of-contents at the top;
    each song as a <section class="song"> (its own title/dictionary/body). A page
    break is inserted before every song after the first (.song{break-before:page}).
    """
    head_title = _html.escape(title or "Songbook")
    toc_items = "".join(f"<li>{_html.escape(s.get('title') or '')}</li>" for s in songs)
    toc = ""
    if songs:
        heading = f"<h1>{_html.escape(title)}</h1>" if title else ""
        toc = f'<div class="toc">{heading}<ol>{toc_items}</ol></div>'

    sections_html = "".join(
        '<section class="song">'
        + _song_inner_html(
            s, dictionary=dictionary, inline_diagrams=inline_diagrams, bars_per_line=bars_per_line
        )
        + "</section>"
        for s in songs
    )
    return (
        '<!doctype html><html><head><meta charset="utf-8">'
        f"<title>{head_title}</title><style>{_CSS}{_SONGBOOK_CSS}</style></head>"
        "<body>"
        f"{toc}"
        f"{sections_html}"
        "</body></html>"
    )
