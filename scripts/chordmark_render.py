"""Pure functions converting the chord-anchored songsheet model to ChordMark text.

No file or network I/O — all functions take plain dicts/lists and return strings,
so they are directly unit-testable.
"""

import re

DEFAULT_BEATS = 4
PERCENT = "%"


class ChordMarkBarError(ValueError):
    """Raised when a bar cannot be represented without changing its timing."""


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
    if len(bar) > beats:
        raise ChordMarkBarError(
            f"cannot render {len(bar)} chord entries in a {beats}-beat ChordMark bar"
        )
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
    """Render one idiomatic ChordMark lyric line, preserving every chord anchor.

    The stored model uses a token-final ``-`` as a syllable-continuation marker.
    ChordMark can express that without displaying the dash by gluing the next
    ``_`` chord-position marker to the word (``tris_te_za`` -> ``tristeza``).
    Empty entries before later lyrics still get a distinct marker; only empty
    anchors after the final lyric can be omitted.
    """
    entries = list(bar)
    while entries and not (entries[-1].get("text") or "").strip():
        entries.pop()
    if not entries:
        return None

    line = ""
    for index, entry in enumerate(entries):
        if index:
            previous = (entries[index - 1].get("text") or "").split()
            line += "_" if previous and _continues_word(previous[-1]) else " _"
        else:
            line = "_"
        line += lyric_display_text(entry.get("text"), continuation_after=index + 1 < len(entries))
    return line


def _continues_word(token):
    return len(token) > 1 and token.endswith("-")


def lyric_display_text(text, continuation_after=False):
    """Hide proven continuation dashes; preserve ordinary or terminal hyphens."""
    tokens = str(text or "").split()
    out = ""
    for index, token in enumerate(tokens):
        continues = index < len(tokens) - 1 or continuation_after
        if _continues_word(token) and continues:
            out += token[:-1]
        else:
            out += token + " "
    return out.strip()


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
    """Split consecutive bars into lines of at most ``max_bars`` bars."""
    max_bars = max(1, max_bars)
    groups, cur = [], []
    for bar in bars:
        if len(cur) >= max_bars:
            groups.append(cur)
            cur = []
        cur.append(bar)
    if cur:
        groups.append(cur)
    return groups


def _group_section_bars(sections, max_bars=MAX_BARS_PER_LINE, *, keep_empty_bars=True):
    """Return ``(label, bars)`` systems shared by both renderers.

    Unlabeled section edges commonly represent source-PDF page boundaries, so
    they do not interrupt a system.  An explicit label starts a new system and
    is attached to that system; a final short system is retained at song end.
    ``keep_empty_bars`` lets each renderer preserve its established treatment
    of fully empty bars.

    A label without any following bars is returned as ``(label, [])`` so it is
    not silently discarded.
    """
    groups = []
    pending = []
    pending_label = None

    def flush():
        nonlocal pending, pending_label
        if pending or pending_label is not None:
            groups.append((pending_label, pending))
            pending = []
            pending_label = None

    for section in sections or []:
        label = section.get("label")
        if label:
            flush()
            pending_label = label
        for bar in section.get("bars", []):
            if not keep_empty_bars and not bar:
                continue
            pending.append(bar)
            if len(pending) >= max(1, max_bars):
                flush()

    flush()
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

    Bars are grouped onto chord lines of exactly ``bars_per_line`` where enough
    bars remain, with the lyric line beneath, matching ChordMark's bar-per-space
    / lyric-line grammar so it renders as systems rather than a vertical stack.
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
    for label, group in _group_section_bars(
        song.get("sections", []), bars_per_line, keep_empty_bars=False
    ):
        if label:
            lines.append("#" + label)
        if not group:
            continue
        group = _resolve_leading_percent(group, last_real)
        lines.append(" ".join(render_chord_line(bar) for bar in group))
        lyric_line = render_lyric_line([entry for bar in group for entry in bar])
        if lyric_line:
            lines.append(lyric_line)
        # update the running "currently sounding" chord from this group
        for bar in group:
            for entry in bar:
                c = entry.get("chord")
                if c and c != PERCENT:
                    last_real = {"chord": c, "voicing": entry.get("voicing")}

    return "\n".join(lines) + "\n"


def render_chart_source(song, bars_per_line=MAX_BARS_PER_LINE):
    """Build timing-only Fork input and the exact display data for its slots.

    Older Fork versions cannot parse inline fingerings inside sub-beats or
    repeated names in a measure. Parse the timing first, then let the renderer
    attach the real labels and fingerings. Empty measures have one blank slot.
    """
    lines = _render_metadata(song) + _render_chord_definitions(song.get("chords"))
    rows = []
    for label, bars in _group_section_bars(song.get("sections", []), bars_per_line):
        if label:
            lines.append("#" + label)
        if not bars:
            continue
        row = []
        encoded_bars = []
        display_entries = []
        for bar in bars:
            entries = bar or [{"chord": ""}]
            if len(entries) > DEFAULT_BEATS * 4:
                raise ChordMarkBarError("This bar has more chord changes than Chord Chart can fit.")
            slots = []
            for entry in entries:
                voicing = entry.get("voicing")
                frets = voicing_to_inline(voicing).split(",") if voicing else None
                slots.append(
                    {
                        "name": entry["chord"],
                        "voicing": [None if fret == "x" else int(fret) for fret in frets]
                        if frets
                        else None,
                    }
                )
            row.append(slots)
            display_entries.extend(entries)

            tokens = ["C" if i % 2 == 0 else "G" for i in range(len(entries))]
            if len(tokens) == 1:
                encoded_bars.append(tokens[0])
            elif len(tokens) <= DEFAULT_BEATS:
                durations = _distribute_beats(len(tokens), DEFAULT_BEATS)
                encoded_bars.append(
                    " ".join(token + "." * beats for token, beats in zip(tokens, durations))
                )
            else:
                groups = []
                start = 0
                for size in _distribute_beats(DEFAULT_BEATS, len(tokens)):
                    group = tokens[start : start + size]
                    groups.append(group[0] + "." if size == 1 else "[" + " ".join(group) + "]")
                    start += size
                encoded_bars.append(" ".join(groups))
        lines.append(" ".join(encoded_bars))
        lyric_line = render_lyric_line(display_entries)
        if lyric_line:
            lines.append(lyric_line)
        rows.append(row)
    return "\n".join(lines) + "\n", rows
