"""Pure functions converting the chord-anchored songsheet model to ChordPro.

No file or network I/O — all functions take plain dicts/lists and return strings,
so they are directly unit-testable.

ChordPro basics emitted here:
  {title: ...}                  song title
  {subtitle: ...}               optional subtitle
  {composer: ...}               optional composer(s)
  {comment: <label>}            one per section, for the section label
  lyric lines with inline [Chord] tags placed before the syllable each chord
  anchors to (entry order = anchor). Instrumental bars (no text) become a line of
  bare [Chord] tokens. A "%" bar-repeat re-states the chord still sounding.
"""

PERCENT = "%"


def _directive(name, value):
    return "{" + f"{name}: {value}" + "}"


def _chord_tag(chord, last_real):
    """The [Chord] tag for an entry's chord; "%" re-states the sounding chord.

    Returns "" only when there is no chord to show (a leading % with nothing yet).
    """
    if chord == PERCENT:
        return f"[{last_real}]" if last_real else ""
    return f"[{chord}]"


def _render_bar(bar, last_real):
    """Render one bar (list of chord entries) to a ChordPro fragment.

    Returns (fragment, new_last_real). A bar with any sung text becomes inline
    [Chord]text; an instrumental bar becomes bare [Chord] tokens. Entry order is
    the anchor — the Nth chord precedes the Nth text fragment.
    """
    has_text = any((e.get("text") or "").strip() for e in bar)
    parts = []
    for entry in bar:
        chord = entry.get("chord", "")
        tag = _chord_tag(chord, last_real)
        if chord and chord != PERCENT:
            last_real = chord
        if has_text:
            text = (entry.get("text") or "").strip()
            parts.append(tag + text)
        else:
            parts.append(tag)
    sep = "" if has_text else " "
    return sep.join(p for p in parts if p), last_real


def render_chordpro(song):
    """Render one song dict to a ChordPro string."""
    lines = []
    title = song.get("title") or ""
    lines.append(_directive("title", title))
    if song.get("subtitle"):
        lines.append(_directive("subtitle", song["subtitle"]))
    composers = song.get("composers") or []
    if composers:
        lines.append(_directive("composer", ", ".join(composers)))
    lines.append("")

    last_real = None
    for section in song.get("sections", []):
        label = section.get("label")
        if label:
            lines.append(_directive("comment", label))
        for bar in section.get("bars", []):
            frag, last_real = _render_bar(bar, last_real)
            lines.append(frag)
        lines.append("")

    # drop a single trailing blank line for tidy output
    while lines and lines[-1] == "":
        lines.pop()
    return "\n".join(lines) + "\n"
