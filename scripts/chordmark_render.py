"""Pure functions converting the chord-anchored songsheet model to ChordMark text.

No file or network I/O — all functions take plain dicts/lists and return strings,
so they are directly unit-testable.
"""

DEFAULT_BEATS = 4
PERCENT = "%"


def _chord_token(entry):
    """Render one chord entry's name with optional inline voicing (no dots)."""
    name = entry["chord"]
    voicing = entry.get("voicing")
    if voicing:
        return f"{name}[{voicing}]"
    return name


def _distribute_beats(n, beats):
    """Split `beats` across `n` chords using largest-remainder rounding.

    Returns a list of n positive integers summing to `beats`.
    """
    base = beats // n
    remainder = beats - base * n
    # give one extra beat to the first `remainder` chords (largest-remainder,
    # earliest-wins for the equal fractional parts produced by an even division)
    return [base + 1 if i < remainder else base for i in range(n)]


def render_chord_line(bar, beats=DEFAULT_BEATS):
    """Render one bar (list of chord entries) to a ChordMark chord-line string."""
    if len(bar) == 1:
        entry = bar[0]
        if entry["chord"] == PERCENT:
            return PERCENT
        return _chord_token(entry)

    durations = _distribute_beats(len(bar), beats)
    tokens = []
    for entry, dur in zip(bar, durations):
        tokens.append(_chord_token(entry) + "." * dur)
    return " ".join(tokens)


def render_lyric_line(bar):
    """Render the `_`-anchored lyric line for a bar, or None if no entry has text."""
    parts = []
    for entry in bar:
        text = entry.get("text")
        if text:
            parts.append("_" + text.strip())
    if not parts:
        return None
    return " ".join(parts)


def _render_chord_definitions(chords_index):
    """Emit `chord <name> <voicing>` lines for each distinct voicing in the index."""
    lines = []
    for name, voicings in (chords_index or {}).items():
        for v in voicings:
            voicing = v.get("voicing")
            if voicing:
                lines.append(f"chord {name} {voicing}")
    return lines


def render_song(song):
    """Render one song dict to a ChordMark string."""
    lines = []

    definitions = _render_chord_definitions(song.get("chords"))
    if definitions:
        lines.extend(definitions)
        lines.append("")

    for section in song.get("sections", []):
        label = section.get("label")
        if label:
            lines.append("#" + label)
        for bar in section.get("bars", []):
            lines.append(render_chord_line(bar))
            lyric = render_lyric_line(bar)
            if lyric is not None:
                lines.append(lyric)

    return "\n".join(lines) + "\n"
