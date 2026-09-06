"""Conservative chord identity for evaluation, using the analysis vocabulary.

The analysis parser deliberately tolerates unknown fragments. Evaluation must
consume the whole supported notation before granting harmonic equivalence.
This is an acceptance boundary, not a general-purpose chord grammar: unsupported
spellings (including add/omit/alt and power chords) retain exact raw identity.
"""

import re

from harmony import _symbol_to_intervals, parse_symbol

# Match only prefixes that the interpreter actually consumes. In particular,
# its diminished prefix is case-sensitive even though its detection is not.
_PREFIX = re.compile(r"m(?:maj|Maj)7?|(?i:maj)7?|(?:dim|°|º)7?|(?i:aug)|\+|m|sus4?|4")
_TENSION = re.compile(r"sus4?|#5|b5|#9|b9|#11|b13|13|11|9|7|6|4")


def _recognized_quality(text):
    """Consume distinct dialect tokens, separators, and one-level groups."""
    # Keep parentheses intact for validation. Match the engine's other
    # normalization order: 7+5 is an altered fifth, while 7+ is a major seventh.
    for source, target in (
        ("+5", "#5"),
        ("-5", "b5"),
        ("+9", "#9"),
        ("-9", "b9"),
        ("+11", "#11"),
        ("-13", "b13"),
        ("♯", "#"),
        ("♭", "b"),
    ):
        text = text.replace(source, target)
    text = text.replace("7+", "maj7").replace("7M", "maj7")
    text = re.sub(r"^mM(?=\d|/)", "mmaj", text)
    text = re.sub(r"M(?=7|9|11|13)", "maj", text)

    prefix = _PREFIX.match(text)
    pos = prefix.end() if prefix else 0
    previous = "token" if prefix else "start"
    # Count explicit notation, including tokens consumed by a quality prefix.
    # Sus / sus4 / 4 are one qualifier; accidentals were normalized above.
    # Do not count implied tones: aug#5 and dim(b5) are valid restatements.
    seen = set()
    if prefix:
        if prefix.group() in ("sus", "sus4", "4"):
            seen.add("sus")
        elif prefix.group().endswith("7"):
            seen.add("7")
    in_group = False
    while pos < len(text):
        char = text[pos]
        if char == "(":
            if in_group:
                return False
            in_group = True
            previous = "open"
        elif char == ")":
            if not in_group or previous != "token":
                return False
            in_group = False
            previous = "close"
        elif char in "/,":
            if previous not in ("token", "close"):
                return False
            previous = "separator"
        else:
            token = _TENSION.match(text, pos)
            if token is None:
                return False
            value = token.group()
            value = "sus" if value in ("sus", "sus4", "4") else value
            if value in seen:
                return False
            seen.add(value)
            pos = token.end()
            previous = "token"
            continue
        pos += 1
    return not in_group and previous not in ("open", "separator")


def strict_harm_key(name):
    """Return ('h', root_pc, intervals, bass_pc), or ('raw', original_name).

    Recognized names preserve harmony.py's existing Brazilian semantics,
    including its documented differences from other chord interpreters.
    Intervals are a sorted tuple relative to the root: the analyzer's display
    quality can omit explicit extensions, so it cannot determine identity.
    Outer whitespace is tolerated for recognized symbols. Unsupported names,
    empty values, and repeat signs match only the identical original value.
    """
    if not isinstance(name, str) or not name.strip() or name.strip() == "%":
        return ("raw", name)
    symbol = name.strip()
    if any(char.isspace() for char in symbol):
        return ("raw", name)
    parsed = parse_symbol(symbol)
    if parsed is None or not _recognized_quality(parsed["qtext"]):
        return ("raw", name)
    intervals = tuple(sorted(_symbol_to_intervals(parsed["qtext"])))
    return ("h", parsed["root_pc"], intervals, parsed["bass_pc"])
