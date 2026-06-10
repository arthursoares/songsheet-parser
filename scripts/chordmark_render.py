"""Pure functions converting the chord-anchored songsheet model to ChordMark text.

No file or network I/O — all functions take plain dicts/lists and return strings,
so they are directly unit-testable.
"""

import re

DEFAULT_BEATS = 4
PERCENT = "%"


def normalize_chord_name(name):
    """Map Brazilian tension-slash notation to a chord-symbol-parseable name.

    The songbook writes added tensions with a slash infix (C7/9, Cm7/9, C7/13),
    which the fork's chord-symbol parser rejects — it reads the first '/' as a
    bass note, so e.g. "D#m7/9/A#" fails and (because a ChordMark chord line is
    all-or-nothing) drops the whole line to raw text. Fold the infix tension into
    the chord quality so the fork can parse it: 7/9 -> 9, 7/11 -> 11, 7/13 -> 13,
    6/9 -> 69. Any trailing '/<bass>' is preserved. The stored JSON keeps the
    original spelling; this runs only when emitting ChordMark for the fork.
    """
    if not name or name == PERCENT:
        return name
    out = re.sub(r"7/(9|11|13)", r"\1", name)  # C7/9 -> C9, Cm7/9 -> Cm9
    out = re.sub(r"6/9", "69", out)  # C6/9 -> C69
    # Comma (or OCR-dot) tension stacks: the 13 already implies the 9.
    out = re.sub(r"13[,.](♭9|b9|-9)", "13-9", out)  # E13,♭9 -> E13-9
    out = re.sub(r"13[,.]9", "13", out)  # E13,9  -> E13
    out = re.sub(r"9[,.]13", "13", out)  # A9,13  -> A13
    out = re.sub(r"13[,.]4", "13sus4", out)  # A13,4  -> A13sus4
    # Slash-4 means sus4 in this songbook (a bass note is always a letter,
    # so a digit after '/' is never a real bass).
    out = re.sub(r"7/4/9|4/79|9/4|4/9", "9sus4", out)  # C#4/9, A9/4 -> ...9sus4
    out = re.sub(r"7/4", "7sus4", out)  # G7/4 -> G7sus4
    # chord-symbol accepts -9 on dominants but wants b9 on minor sevenths.
    out = re.sub(r"m7-9", "m7b9", out)  # F#m7-9 -> F#m7b9
    return out


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
    name = normalize_chord_name(entry["chord"])
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
                lines.append(f"chord {normalize_chord_name(name)} {voicing_to_inline(voicing)}")
    return lines


MAX_BARS_PER_LINE = 4

# ChordMark `key` declarations accept a plain (minor) key only; corpus key
# fields sometimes hold misparsed chord names ("F#69"), which we must not emit.
KEY_RE = re.compile(r"^[A-G](#|b)?m?$")


def _render_metadata(song):
    """Emit `composer`/`key` declaration lines for the studio's page header."""
    lines = []
    composers = song.get("composers") or []
    if isinstance(composers, str):
        composers = [composers]
    composers = [c for c in composers if c]
    if composers:
        lines.append("composer " + ", ".join(composers))
    key = song.get("key")
    if key and KEY_RE.match(key):
        lines.append(f"key {key}")
    return lines


def _bar_has_lyric(bar):
    return any(e.get("text") for e in bar)


def _group_bars(bars, max_bars=MAX_BARS_PER_LINE):
    """Group a section's bars into chord lines for ChordMark.

    Consecutive bars are grouped while they share lyric-presence (a sung run vs.
    an instrumental run), capped at `max_bars` so lines stay readable.
    This makes the output render as flowing systems instead of one bar per line.
    Returns a list of bar-lists.
    """
    groups, cur, cur_lyric = [], [], None
    for bar in bars:
        has = _bar_has_lyric(bar)
        if cur and (has != cur_lyric or len(cur) >= max_bars):
            groups.append(cur)
            cur = []
        cur.append(bar)
        cur_lyric = has
    if cur:
        groups.append(cur)
    return groups


def _resolve_leading_percent(group, last_real):
    """Avoid a chord line that starts with '%'.

    ChordMark only accepts '%' (bar repeat) when it is NOT the first token of a
    chord line, so a group whose first bar leads with '%' would be misparsed as a
    lyric line. Replace that leading '%' with the actual chord still sounding
    (last_real = {"chord", "voicing"}), preserving the entry's text. Returns a
    (possibly new) group; the original is not mutated.
    """
    if not group or not last_real:
        return group
    first = group[0]
    if not first or first[0].get("chord") != PERCENT:
        return group
    patched_entry = dict(first[0])
    patched_entry["chord"] = last_real["chord"]
    if last_real.get("voicing"):
        patched_entry["voicing"] = last_real["voicing"]
    else:
        patched_entry.pop("voicing", None)
    new_group = [[patched_entry] + first[1:]] + group[1:]
    return new_group


def render_song(song, bars_per_line=MAX_BARS_PER_LINE):
    """Render one song dict to a ChordMark string.

    Bars are grouped onto chord lines (by lyric phrase, capped at `bars_per_line`)
    with the lyric line beneath, matching ChordMark's bar-per-space / lyric-line
    grammar so it renders as systems rather than a vertical stack.
    """
    lines = []

    metadata = _render_metadata(song)
    if metadata:
        lines.extend(metadata)
        lines.append("")

    definitions = _render_chord_definitions(song.get("chords"))
    if definitions:
        lines.extend(definitions)
        lines.append("")

    last_real = None  # most recent struck chord, to de-reference a leading '%'
    for section in song.get("sections", []):
        label = section.get("label")
        if label:
            lines.append("#" + label)
        # The vision parse sometimes leaves fully empty bars (no chord, no
        # text), mostly leading pickup bars; ChordMark has no empty-bar token,
        # so drop them rather than emit an unparseable line.
        bars = [bar for bar in section.get("bars", []) if bar]
        for group in _group_bars(bars, bars_per_line):
            group = _resolve_leading_percent(group, last_real)
            lines.append(" ".join(render_chord_line(bar) for bar in group))
            lyric_parts = [render_lyric_line(bar) for bar in group]
            lyric_parts = [p for p in lyric_parts if p is not None]
            if lyric_parts:
                lines.append(" ".join(lyric_parts))
            # update the running "currently sounding" chord from this group
            for bar in group:
                for entry in bar:
                    c = entry.get("chord")
                    if c and c != PERCENT:
                        last_real = {"chord": c, "voicing": entry.get("voicing")}

    return "\n".join(lines) + "\n"
