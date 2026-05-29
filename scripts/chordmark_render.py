"""Pure functions converting the chord-anchored songsheet model to ChordMark text.

No file or network I/O — all functions take plain dicts/lists and return strings,
so they are directly unit-testable.
"""

DEFAULT_BEATS = 4
PERCENT = "%"


def voicing_to_inline(voicing):
    """Validate a comma fret-number voicing and return it normalized for `Name[...]`.

    Input: 6 comma-separated tokens, low-E to high-e, each "x" (muted) or a
    fret number 0-24. Example: "x,5,7,5,6,x".
    Output: the same comma form (validated/normalized), which Arthur's ChordMark
    fork accepts natively as an inline voicing — e.g. "x,5,7,5,6,x".
    Raises ValueError on malformed input (wrong count, non-numeric, out of range).
    """
    tokens = [t.strip() for t in voicing.split(",")]
    if len(tokens) != 6:
        raise ValueError(f"voicing must have 6 strings, got {len(tokens)}: {voicing!r}")
    out = []
    for t in tokens:
        if t.lower() == "x":
            out.append("x")
            continue
        if not t.isdigit():
            raise ValueError(f"bad fret token {t!r} in voicing {voicing!r}")
        fret = int(t)
        if fret < 0 or fret > 24:
            raise ValueError(f"fret {fret} out of range 0-24 in voicing {voicing!r}")
        out.append(str(fret))
    return ",".join(out)


def _chord_token(entry):
    """Render one chord entry's name with optional inline voicing (no dots)."""
    name = entry["chord"]
    voicing = entry.get("voicing")
    if voicing:
        return f"{name}[{voicing_to_inline(voicing)}]"
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
                lines.append(f"chord {name} {voicing_to_inline(voicing)}")
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
