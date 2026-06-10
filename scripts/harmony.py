"""Pure harmonic-analysis engine over the chord-anchored song model.

No file or network I/O — all functions take plain dicts/lists and return plain
data, so they are directly unit-testable (same contract as chordmark_render.py).

Pipeline (plan 2026-06-02-harmonic-analysis.md, Phase A):

    song dict
      → normalize_events()        A0  flat event stream, % carry, beats
      → voicing_to_pitches()      A1  frets → MIDI / pitch classes
      → quality_from_pitches()    A2  notes-first quality (+ ambiguity)
      → parse_symbol()/analyze_chord()  A3  symbol parse + reconcile
      → estimate_key()            A4  cadence-based tonic (stored key wins)
      → roman()/classify_function() A5 Roman numerals + harmonic function
      → detect_devices()          A6  ii–V, tritone subs, chromatic bass, …
      → analyze_song()            A7  assembled annotated stream + confidence

The single naming authority is quality_from_pitches(): the symbol path converts
the printed quality text to an interval set and runs it through the same
function, so the two paths can never disagree about vocabulary.
"""

import re

DEFAULT_BEATS = 4
PERCENT = "%"

# Standard tuning, low E to high e, open-string MIDI numbers.
OPEN_STRING_MIDI = [40, 45, 50, 55, 59, 64]

_LETTER_PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
_LETTERS = "CDEFGAB"
# Default spelling per pitch class (the songbook spells chromatics with sharps).
DEFAULT_PC_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

_MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11]
_MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10]  # natural minor

_ROMAN_NUMERALS = ["I", "II", "III", "IV", "V", "VI", "VII"]

# Confidence penalties (subtracted from 1.0; >=0.8 high, >=0.5 medium, else low).
PENALTY = {
    "no_chord": 0.6,  # orphan leading '%' or unparseable symbol
    "ambiguous_quality": 0.30,  # notes under-determined AND no usable symbol quality
    "symbol_fallback": 0.15,  # voicing present but didn't determine quality
    "root_missing": 0.55,  # symbol root pc absent from the voicing's notes
    "quality_mismatch": 0.55,  # notes-derived family != symbol-implied family
    "bass_mismatch": 0.15,  # symbol slash bass != physical lowest note
    "unresolved_dominant": 0.20,
    "dim_multimatch": 0.15,  # >1 diminished rule matched
    "nondiatonic_guess": 0.10,  # function fell through to 'chromatic'
}


def note_to_pc(name):
    """'C#' → 1, 'Bb' → 10. Accepts #/b/♯/♭. Returns None if unparseable."""
    if not name:
        return None
    m = re.match(r"^([A-G])([#b♯♭]*)$", name.strip())
    if not m:
        return None
    pc = _LETTER_PC[m.group(1)]
    for acc in m.group(2):
        pc += 1 if acc in "#♯" else -1
    return pc % 12


# ---------------------------------------------------------------------------
# A0 — event normalization
# ---------------------------------------------------------------------------


def _bar_beats(n, beats_per_bar=DEFAULT_BEATS):
    """Beat durations for a bar of n chords. Largest-remainder, earliest-wins;
    if the bar holds more chords than beats, fall back to an even fractional
    split so no chord ever gets duration 0."""
    if n <= 0:
        return []
    if n > beats_per_bar:
        return [beats_per_bar / n] * n
    base = beats_per_bar // n
    remainder = beats_per_bar - base * n
    return [base + 1 if i < remainder else base for i in range(n)]


def normalize_events(song, beats_per_bar=DEFAULT_BEATS):
    """Flatten a song dict into an ordered list of event dicts.

    Each event:
      idx            stable, occurrence-unique integer (0-based, song order)
      section        section index;  section_label  its label (may be None)
      bar            global bar index across the song
      bar_in_section bar index within the section
      pos            entry index within the bar
      symbol         the raw stored chord string ('%' kept as-is)
      chord          the *effective* symbol: '%' resolved to the carried chord;
                     None for an orphan leading '%'
      voicing        effective voicing ('%' carries the struck chord's voicing)
      is_percent     True when this event is a '%' carry
      text           the entry's lyric fragment (or None)
      beats          duration in beats (int, or float in the >beats fallback)
    """
    events = []
    idx = 0
    bar_global = 0
    last_real = None  # {'symbol', 'voicing'} of the most recent struck chord
    for s_i, section in enumerate(song.get("sections", [])):
        label = section.get("label")
        for b_i, bar in enumerate(section.get("bars", [])):
            durations = _bar_beats(len(bar), beats_per_bar)
            for pos, entry in enumerate(bar):
                symbol = entry.get("chord")
                if symbol == PERCENT:
                    chord = last_real["symbol"] if last_real else None
                    voicing = last_real["voicing"] if last_real else None
                    is_percent = True
                else:
                    chord = symbol
                    voicing = entry.get("voicing")
                    is_percent = False
                    if symbol:
                        last_real = {"symbol": symbol, "voicing": voicing}
                events.append(
                    {
                        "idx": idx,
                        "section": s_i,
                        "section_label": label,
                        "bar": bar_global,
                        "bar_in_section": b_i,
                        "pos": pos,
                        "symbol": symbol,
                        "chord": chord,
                        "voicing": voicing,
                        "is_percent": is_percent,
                        "text": entry.get("text"),
                        "beats": durations[pos],
                    }
                )
                idx += 1
            bar_global += 1
    return events


# ---------------------------------------------------------------------------
# A1 — voicing → pitches
# ---------------------------------------------------------------------------


def voicing_to_pitches(voicing):
    """Decode a comma fret voicing ('x,5,7,5,6,x') into sounding pitches.

    Returns {'midis': [...], 'pcs': set, 'bass_pc': int|None, 'bass_midi': int|None}.
    Missing/empty/malformed input yields the empty result (analysis data is
    hand-corrected; robustness beats raising here — callers flag confidence).
    """
    empty = {"midis": [], "pcs": set(), "bass_pc": None, "bass_midi": None}
    if not voicing:
        return empty
    tokens = [t.strip() for t in voicing.split(",")]
    if len(tokens) != 6:
        return empty
    midis = []
    for open_midi, tok in zip(OPEN_STRING_MIDI, tokens):
        if tok.lower() == "x" or tok == "":
            continue
        if not tok.isdigit() or int(tok) > 24:
            return empty
        midis.append(open_midi + int(tok))
    if not midis:
        return empty
    return {
        "midis": midis,
        "pcs": {m % 12 for m in midis},
        "bass_pc": midis[0] % 12,
        "bass_midi": midis[0],
    }


# ---------------------------------------------------------------------------
# A2 — notes-first quality
# ---------------------------------------------------------------------------


def quality_from_pitches(root_pc, pcs):
    """Quality string from a root pitch class and a set of pitch classes.

    Returns 'ambiguous' when the notes don't determine a quality (missing root,
    missing 3rd without a real sus shape, empty set) — never guesses.
    """
    if root_pc is None or not pcs:
        return "ambiguous"
    iv = {(pc - root_pc) % 12 for pc in pcs}
    if 0 not in iv:
        return "ambiguous"

    third = 4 if 4 in iv else (3 if 3 in iv else None)

    if third is None:
        # sus4 needs the P4 *and* the P5 — a bare 4th+♭7 (quartal stack) is ambiguous
        if 5 in iv and 7 in iv:
            if 10 in iv:
                return "9sus4" if 2 in iv else "7sus4"
            return "sus4"
        return "ambiguous"

    if third == 3:
        # diminished family: ♭5 with no natural 5
        if 6 in iv and 7 not in iv:
            if 10 in iv:
                return "m7♭5"
            if 11 in iv:
                return "mMaj7♭5"
            if 9 in iv:
                return "°7"
            return "dim"
        if 11 in iv:
            base = "mMaj7"
        elif 10 in iv:
            base = "m11" if 5 in iv else ("m9" if 2 in iv else "m7")
        elif 9 in iv:
            base = "m6/9" if 2 in iv else "m6"
        else:
            base = "m(add9)" if 2 in iv else "m"
        if 8 in iv and 7 in iv:
            base += "♭13"
        return base

    # major third
    has_p5 = 7 in iv
    seventh = "maj" if 11 in iv else ("dom" if 10 in iv else None)
    alters = []
    if not has_p5:
        if 6 in iv:
            alters.append("♭5")
        elif 8 in iv:
            alters.append("♯5")
    if 1 in iv:
        alters.append("♭9")
    if 3 in iv:
        alters.append("♯9")
    if 6 in iv and has_p5:
        alters.append("♯11")
    if 8 in iv and has_p5:
        alters.append("♭13")
    alt = "".join(alters)

    if seventh == "dom":
        ext = "13" if 9 in iv else ("9" if 2 in iv and 1 not in iv and 3 not in iv else "7")
        return ext + alt
    if seventh == "maj":
        base = "maj9" if 2 in iv else "maj7"
        return base + alt
    if 9 in iv:  # 6th chord (no 7th)
        return ("6/9" if 2 in iv else "6") + alt
    if not has_p5 and 8 in iv:
        return "aug"
    return ("add9" if 2 in iv else "") + alt


def quality_family(quality):
    """Coarse family for cross-checks and function rules:
    maj / min / dom / dim / halfdim / sus / amb."""
    q = quality or "ambiguous"
    if q == "ambiguous":
        return "amb"
    if q in ("m7♭5", "mMaj7♭5"):
        return "halfdim"
    if q in ("dim", "°7"):
        return "dim"
    if q.startswith("m") and not q.startswith("maj"):
        return "min"
    if "sus" in q:
        return "sus"
    if q.startswith("7") or q.startswith("9") or q.startswith("13") or q.startswith("11"):
        return "dom"
    return "maj"  # '', 6, 6/9, add9, maj7, maj9, aug …


# ---------------------------------------------------------------------------
# A3 — symbol parse + reconcile
# ---------------------------------------------------------------------------

_ROOT_RE = re.compile(r"^([A-G][#b♯♭]?)")
_BASS_RE = re.compile(r"/([A-G][#b♯♭]?)$")


def _symbol_to_intervals(qtext):
    """Convert a printed quality text to an interval set, in the songbook's
    Brazilian conventions (7+5, 7-9, m7/9, 13,9, 69, 479, …).

    Returns a set of intervals, or None when the text is unintelligible. The
    result is fed through quality_from_pitches(0, …) so the symbol path uses
    the exact same naming vocabulary as the notes path.
    """
    t = qtext.strip()
    # normalize: parens/commas are just separators; +/- are ♯/♭
    t = t.replace("(", "/").replace(")", "").replace(",", "/")
    t = t.replace("+5", "#5").replace("-5", "b5")
    t = t.replace("+9", "#9").replace("-9", "b9")
    t = t.replace("+11", "#11").replace("-13", "b13")
    t = t.replace("♯", "#").replace("♭", "b")
    # Brazilian major-seventh spellings: trailing '7+' (any '+' not part of an
    # altered tension, consumed above), '7M', 'M7', and 'mM7' all mean maj7
    t = re.sub(r"7\+", "maj7", t)
    t = re.sub(r"7M", "maj7", t)
    t = re.sub(r"^mM(?=\d|/)", "mmaj", t)  # DmM7(b5) — minor with a capital-M maj7
    t = re.sub(r"M(?=7|9|11|13)", "maj", t)  # DM7, AM7(b5)

    iv = None
    if t.startswith("mmaj") or t.startswith("mMaj") or t.startswith("m(maj"):
        iv = {0, 3, 7, 11}
        t = re.sub(r"^m\(?[mM]aj7?\)?", "", t)
    elif t.lower().startswith("maj"):
        iv = {0, 4, 7, 11}
        t = t[3:]
        if t.startswith("7"):
            t = t[1:]
    elif t.lower().startswith("dim") or t.startswith("°") or t.startswith("º"):
        iv = {0, 3, 6}
        t = re.sub(r"^(dim|°|º)", "", t)
        if t.startswith("7"):
            iv.add(9)
            t = t[1:]
    elif t.startswith("m"):
        iv = {0, 3, 7}
        t = t[1:]
    elif t.startswith("sus") or t.startswith("4"):
        iv = {0, 5, 7}
        t = re.sub(r"^sus4?", "", t) if t.startswith("sus") else t[1:]
    else:
        iv = {0, 4, 7}

    minorish = 3 in iv
    susish = 5 in iv and 3 not in iv and 4 not in iv
    seen_seventh = 11 in iv or 9 in iv  # maj/dim prefixes already imply one
    for tok in re.findall(r"sus4?|#5|b5|#9|b9|#11|b13|13|11|9|7|6|4|5", t):
        if tok.startswith("sus"):
            iv.discard(3)
            iv.discard(4)
            iv.add(5)
        elif tok == "7":
            iv.add(10)
            seen_seventh = True
        elif tok == "6":
            iv.add(9)
            seen_seventh = True
        elif tok == "9":
            iv.add(2)
        elif tok == "11":
            iv.add(5)
        elif tok == "13":
            iv.add(9)
            iv.add(10)
            seen_seventh = True
        elif tok == "4":
            iv.add(5)
            iv.discard(4)  # 479-style sus
        elif tok == "#5":
            iv.discard(7)
            iv.add(8)
        elif tok == "b5":
            iv.discard(7)
            iv.add(6)
        elif tok == "#9":
            iv.add(3)
        elif tok == "b9":
            iv.add(1)
        elif tok == "#11":
            iv.add(6)
        elif tok == "b13":
            iv.add(8)
    # a bare 9/11 extension implies the ♭7 (C9 = C7/9), unless a 6th/maj7 is there
    if (
        (2 in iv or (5 in iv and not susish))
        and not seen_seventh
        and 11 not in iv
        and not minorish
        and 4 in iv
    ):
        iv.add(10)
    if 2 in iv and minorish and not seen_seventh and 11 not in iv and 9 not in iv:
        # m9 implies m7/9 unless it's an m6/9 or m(add9) form — corpus writes m79/m7/9
        pass  # keep as add9; the explicit corpus forms always carry the 7
    if susish and (2 in iv or 10 in iv) and 10 not in iv and 2 in iv:
        iv.add(10)  # 479-style: sus with a 9 implies the ♭7
    return iv


def parse_symbol(symbol):
    """Parse a printed chord symbol.

    Returns {'root', 'root_pc', 'bass', 'bass_pc', 'qtext', 'quality', 'family'}
    or None for '%', empty, or an unparseable symbol. 'quality' is the
    symbol-implied canonical quality (same vocabulary as the notes path).
    """
    if not symbol or symbol == PERCENT:
        return None
    s = symbol.strip()
    m = _ROOT_RE.match(s)
    if not m:
        return None
    root = m.group(1)
    rest = s[m.end() :]
    bass = None
    bm = _BASS_RE.search(rest)
    if bm:
        bass = bm.group(1)
        rest = rest[: bm.start()]
    iv = _symbol_to_intervals(rest)
    quality = quality_from_pitches(0, iv) if iv else "ambiguous"
    return {
        "root": root,
        "root_pc": note_to_pc(root),
        "bass": bass,
        "bass_pc": note_to_pc(bass) if bass else None,
        "qtext": rest,
        "quality": quality,
        "family": quality_family(quality),
    }


def analyze_chord(symbol, voicing):
    """Reconcile a printed symbol with its voicing (A3).

    Returns a dict with root/bass/quality/quality_source/notes/midis plus
    'penalties' (list of PENALTY keys) and 'discrepancy' (str or None).
    """
    sym = parse_symbol(symbol)
    pitch = voicing_to_pitches(voicing)
    penalties = []
    notes = sorted(pitch["pcs"])
    discrepancy = None

    if sym is None:
        penalties.append("no_chord")
        return {
            "symbol": symbol,
            "root": None,
            "root_pc": None,
            "bass": None,
            "bass_pc": None,
            "bass_physical": pitch["bass_pc"],
            "quality": "ambiguous",
            "quality_source": None,
            "family": "amb",
            "notes": notes,
            "midis": pitch["midis"],
            "penalties": penalties,
            "discrepancy": None,
        }

    notes_quality = quality_from_pitches(sym["root_pc"], pitch["pcs"])
    if notes_quality != "ambiguous":
        quality, source = notes_quality, "notes"
        if sym["quality"] != "ambiguous" and quality_family(notes_quality) != sym["family"]:
            penalties.append("quality_mismatch")
            discrepancy = f"notes say {notes_quality!r} but symbol implies {sym['quality']!r}"
    elif sym["quality"] != "ambiguous":
        quality, source = sym["quality"], "symbol"
        if pitch["pcs"]:
            penalties.append("symbol_fallback")
    else:
        quality, source = "ambiguous", None
        penalties.append("ambiguous_quality")

    if pitch["pcs"] and sym["root_pc"] is not None and sym["root_pc"] not in pitch["pcs"]:
        penalties.append("root_missing")
        discrepancy = discrepancy or "symbol root not present in the voicing"

    if (
        sym["bass_pc"] is not None
        and pitch["bass_pc"] is not None
        and sym["bass_pc"] != pitch["bass_pc"]
    ):
        penalties.append("bass_mismatch")

    return {
        "symbol": symbol,
        "root": sym["root"],
        "root_pc": sym["root_pc"],
        "bass": sym["bass"],
        "bass_pc": sym["bass_pc"],
        "bass_physical": pitch["bass_pc"],
        "quality": quality,
        "quality_source": source,
        "family": quality_family(quality),
        "notes": notes,
        "midis": pitch["midis"],
        "penalties": penalties,
        "discrepancy": discrepancy,
    }


def confidence_level(penalties):
    """Map a list of PENALTY keys to 'high' / 'medium' / 'low'."""
    score = 1.0 - sum(PENALTY.get(p, 0.1) for p in penalties)
    if score >= 0.8:
        return "high"
    if score >= 0.5:
        return "medium"
    return "low"


# ---------------------------------------------------------------------------
# moves — the holds-resolved, deduplicated progression stream
# ---------------------------------------------------------------------------


def _build_moves(events):
    """Collapse the event stream into harmonic 'moves'.

    Consecutive events with the same effective chord symbol (including '%'
    carries and re-strikes of the identical symbol) form one move. Detectors
    and function classification run on moves; results map back via event_idxs.
    """
    moves = []
    for ev in events:
        if moves and ev["chord"] == moves[-1]["symbol"]:
            moves[-1]["event_idxs"].append(ev["idx"])
            moves[-1]["beats"] += ev["beats"]
            continue
        info = analyze_chord(ev["chord"], ev["voicing"])
        info_move = {
            "symbol": ev["chord"],
            "event_idxs": [ev["idx"]],
            "beats": ev["beats"],
            "chord": info,
        }
        moves.append(info_move)
    return moves


def _effective_bass_pc(move):
    c = move["chord"]
    if c["bass_pc"] is not None:
        return c["bass_pc"]
    if c["bass_physical"] is not None:
        return c["bass_physical"]
    return c["root_pc"]


# ---------------------------------------------------------------------------
# A4 — key / tonic estimation
# ---------------------------------------------------------------------------

# Krumhansl-Kessler key profiles (secondary cross-check only).
_KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
_KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]


def _ks_correlate(profile, hist):
    n = 12
    mp = sum(profile) / n
    mh = sum(hist) / n
    num = sum((profile[i] - mp) * (hist[i] - mh) for i in range(n))
    dp = sum((profile[i] - mp) ** 2 for i in range(n)) ** 0.5
    dh = sum((hist[i] - mh) ** 2 for i in range(n)) ** 0.5
    if dp == 0 or dh == 0:
        return 0.0
    return num / (dp * dh)


def _ks_candidates(events, top=3):
    """Beats-weighted pitch-class histogram correlated against the KS profiles."""
    hist = [0.0] * 12
    for ev in events:
        pcs = voicing_to_pitches(ev["voicing"])["pcs"]
        if not pcs:
            sym = parse_symbol(ev["chord"])
            if sym and sym["root_pc"] is not None:
                pcs = {sym["root_pc"]}
        for pc in pcs:
            hist[pc] += ev["beats"] / max(len(pcs), 1)
    scored = []
    for pc in range(12):
        rotated = hist[pc:] + hist[:pc]
        scored.append((pc, "major", _ks_correlate(_KS_MAJOR, rotated)))
        scored.append((pc, "minor", _ks_correlate(_KS_MINOR, rotated)))
    scored.sort(key=lambda t: -t[2])
    return [
        {"tonic_pc": pc, "mode": mode, "score": round(s, 3), "how": "ks"}
        for pc, mode, s in scored[:top]
    ]


def _spell_pc(pc, events):
    """Spell a pitch class the way the song's symbols spell it (else sharps)."""
    counts = {}
    for ev in events:
        sym = parse_symbol(ev["chord"])
        if sym and sym["root_pc"] == pc:
            counts[sym["root"]] = counts.get(sym["root"], 0) + 1
    if counts:
        return max(counts, key=counts.get)
    return DEFAULT_PC_NAMES[pc]


def parse_key_name(key):
    """'C#' / 'Am' / 'Bbm' → (tonic_name, mode) or None."""
    if not key:
        return None
    m = re.match(r"^([A-G][#b♯♭]?)\s*(m|min|minor)?$", key.strip())
    if not m:
        return None
    return m.group(1), ("minor" if m.group(2) else "major")


def estimate_key(events, stored_key=None):
    """Estimate the song's key (A4).

    Returns {'tonic_pc','tonic_name','mode','how','margin','candidates','confidence'}.
    A stored key always wins ('how':'stored'); the cadence estimate is computed
    anyway as a cross-check and exposed in candidates.
    """
    moves = _build_moves(events)
    scores = [0.0] * 12
    target_minor = [0] * 12
    target_major = [0] * 12
    for i, mv in enumerate(moves[:-1]):
        c, nxt = mv["chord"], moves[i + 1]["chord"]
        if c["root_pc"] is None or nxt["root_pc"] is None:
            continue
        if c["family"] == "dom" and (c["root_pc"] + 5) % 12 == nxt["root_pc"]:
            target = nxt["root_pc"]
            weight = 1.0
            # ii–V–I weighs more than a bare V–I
            if i > 0:
                prev = moves[i - 1]["chord"]
                if (
                    prev["root_pc"] is not None
                    and prev["family"] in ("min", "halfdim")
                    and (prev["root_pc"] + 5) % 12 == c["root_pc"]
                ):
                    weight = 2.0
            scores[target] += weight
            if nxt["family"] in ("min", "halfdim"):
                target_minor[target] += 1
            elif nxt["family"] in ("maj", "dom"):
                target_major[target] += 1

    ordered = sorted(range(12), key=lambda pc: -scores[pc])
    best, second = ordered[0], ordered[1]
    total = sum(scores)
    margin = ((scores[best] - scores[second]) / scores[best]) if scores[best] else 0.0
    cadence_mode = "minor" if target_minor[best] > target_major[best] else "major"
    cadence = {
        "tonic_pc": best if total else None,
        "tonic_name": _spell_pc(best, events) if total else None,
        "mode": cadence_mode,
        "score": scores[best],
        "margin": round(margin, 3),
        "how": "cadence",
    }
    candidates = ([cadence] if total else []) + _ks_candidates(events)

    stored = parse_key_name(stored_key)
    if stored:
        name, mode = stored
        return {
            "tonic_pc": note_to_pc(name),
            "tonic_name": name,
            "mode": mode,
            "how": "stored",
            "margin": None,
            "candidates": candidates,
            "confidence": "high",
            "cadence_agrees": (cadence["tonic_pc"] == note_to_pc(name)) if total else None,
        }

    if not total:
        ks = _ks_candidates(events, top=1)
        if ks:
            pc = ks[0]["tonic_pc"]
            return {
                "tonic_pc": pc,
                "tonic_name": _spell_pc(pc, events),
                "mode": ks[0]["mode"],
                "how": "ks",
                "margin": 0.0,
                "candidates": candidates,
                "confidence": "low",
            }
        return {
            "tonic_pc": None,
            "tonic_name": None,
            "mode": None,
            "how": "none",
            "margin": 0.0,
            "candidates": [],
            "confidence": "low",
        }

    return {
        "tonic_pc": best,
        "tonic_name": _spell_pc(best, events),
        "mode": cadence_mode,
        "how": "cadence",
        "margin": round(margin, 3),
        "candidates": candidates,
        "confidence": "low" if margin < 0.25 else "high",
    }


# ---------------------------------------------------------------------------
# A5 — Roman numerals + function classification
# ---------------------------------------------------------------------------


def _letter_index(name):
    return _LETTERS.index(name[0])


def _quality_suffix(quality, family):
    """Display suffix after the (cased) numeral."""
    q = quality
    if q in ("", "m"):
        return ""
    if q == "ambiguous":
        return "?"
    if family in ("min",):
        # lowercase already says minor — drop the leading 'm'
        if q == "mMaj7":
            return "maj7"
        if q.startswith("m"):
            return q[1:]
        return q
    if family == "halfdim":
        return "ø7" if q == "m7♭5" else "maj7♭5"
    if family == "dim":
        return "°7" if q == "°7" else "°"
    if q == "aug":
        return "+"
    return q


def roman(root_name, quality, tonic_name, mode="major", bass=None):
    """Roman numeral for a chord in a spelled key ('D#', 'm7', 'C#' → 'ii7')."""
    if not root_name or not tonic_name:
        return None
    root_pc, tonic_pc = note_to_pc(root_name), note_to_pc(tonic_name)
    if root_pc is None or tonic_pc is None:
        return None
    scale = _MINOR_SCALE if mode == "minor" else _MAJOR_SCALE
    degree = (_letter_index(root_name) - _letter_index(tonic_name)) % 7
    expected = scale[degree]
    actual = (root_pc - tonic_pc) % 12
    acc = (actual - expected + 6) % 12 - 6
    prefix = "♭" * (-acc) if acc < 0 else "♯" * acc
    numeral = _ROMAN_NUMERALS[degree]
    family = quality_family(quality)
    if family in ("min", "dim", "halfdim"):
        numeral = numeral.lower()
    out = prefix + numeral + _quality_suffix(quality, family)
    if bass and note_to_pc(bass) != root_pc:
        out += "/" + bass
    return out


# diatonic degree table: semitone offset → (degree label, allowed families, function)
_DIATONIC_MAJOR = {
    0: ("I", ("maj",), "tonic"),
    2: ("ii", ("min", "halfdim"), "subdominant"),
    4: ("iii", ("min",), "tonic"),
    5: ("IV", ("maj",), "subdominant"),
    7: ("V", ("dom", "maj", "sus"), "dominant"),
    9: ("vi", ("min",), "tonic"),
    11: ("vii", ("halfdim", "dim"), "dominant"),
}
_DIATONIC_MINOR = {
    0: ("i", ("min",), "tonic"),
    2: ("ii", ("halfdim", "min"), "subdominant"),
    3: ("III", ("maj",), "tonic"),
    5: ("iv", ("min",), "subdominant"),
    7: ("V", ("dom", "maj", "min", "sus"), "dominant"),
    8: ("VI", ("maj",), "tonic"),
    10: ("VII", ("dom", "maj"), "subdominant"),
    11: ("vii", ("dim", "halfdim"), "dominant"),
}


def classify_function(prev, cur, nxt, tonic_pc, mode="major"):
    """Classify one move's harmonic function in context (A5).

    prev/cur/nxt are {'root_pc', 'family'} dicts (prev/nxt may be None).
    Returns {'function','label','why','penalties','target_pc'}.
    """
    out = {
        "function": "chromatic",
        "label": "chromatic",
        "why": "",
        "penalties": [],
        "target_pc": None,
    }
    if cur is None or cur["root_pc"] is None:
        out.update(
            function="unknown", label="unknown", why="no identifiable chord", penalties=["no_chord"]
        )
        return out
    if tonic_pc is None:
        out.update(function="unknown", label="unknown", why="no key established")
        return out

    offset = (cur["root_pc"] - tonic_pc) % 12
    fam = cur["family"]
    table = _DIATONIC_MINOR if mode == "minor" else _DIATONIC_MAJOR
    nxt_root = nxt["root_pc"] if nxt else None

    # bluesy I7 → IV: dominant quality on the tonic resolving up a fourth
    if offset == 0 and fam == "dom":
        if nxt_root is not None and (cur["root_pc"] + 5) % 12 == nxt_root:
            out.update(
                function="tonic",
                label="I7 (bluesy, → IV)",
                why="dominant quality on the tonic resolving to IV",
            )
            return out
        out.update(
            function="tonic",
            label="I7 (bluesy)",
            why="dominant quality on the tonic",
            penalties=["nondiatonic_guess"],
        )
        return out

    # diminished disambiguation — tie-break order: leading-tone > passing > common-tone
    if fam == "dim":
        matches = []
        if nxt_root is not None and (cur["root_pc"] + 1) % 12 == nxt_root:
            matches.append(
                (
                    "dominant",
                    "leading-tone °7 (≈ V7♭9 of next)",
                    "root a semitone below the next chord",
                )
            )
        prev_root = prev["root_pc"] if prev else None
        if (
            prev_root is not None
            and nxt_root is not None
            and (
                ((prev_root + 1) % 12 == cur["root_pc"] and (cur["root_pc"] + 1) % 12 == nxt_root)
                or (
                    (prev_root - 1) % 12 == cur["root_pc"] and (cur["root_pc"] - 1) % 12 == nxt_root
                )
            )
        ):
            matches.append(
                ("passing", "passing °7", "chromatic stepwise motion between its neighbours")
            )
        if nxt_root is not None and cur["root_pc"] == nxt_root:
            matches.append(("passing", "common-tone °7", "same root as the chord it embellishes"))
        if matches:
            func, label, why = matches[0]
            pens = ["dim_multimatch"] if len(matches) > 1 else []
            out.update(function=func, label=label, why=why, penalties=pens)
            return out
        out.update(
            function="chromatic",
            label="diminished (unclassified)",
            why="no diminished rule matched",
            penalties=["nondiatonic_guess"],
        )
        return out

    # diatonic by degree + family
    if offset in table and fam in table[offset][1]:
        degree, _, func = table[offset]
        out.update(function=func, label=degree, why=f"diatonic {degree} in the {mode} key")
        return out

    # secondary dominant — only on a real down-a-fifth resolution
    if fam == "dom":
        target = (cur["root_pc"] + 5) % 12
        if nxt_root is not None and nxt_root == target:
            out.update(
                function="secondary_dominant",
                label="V7/x",
                why="dominant resolving down a fifth to a non-tonic target",
                target_pc=target,
            )
            return out
        out.update(
            function="dominant",
            label="unresolved dominant",
            why="dominant quality but no down-a-fifth resolution",
            penalties=["unresolved_dominant"],
        )
        return out

    # secondary ii: minor chord a fifth above a following dominant (ii of a ii–V)
    if (
        fam in ("min", "halfdim")
        and nxt is not None
        and nxt["family"] == "dom"
        and nxt_root is not None
        and (cur["root_pc"] + 5) % 12 == nxt_root
    ):
        target = (nxt_root + 5) % 12
        if target != tonic_pc:
            out.update(
                function="secondary_ii",
                label="ii/x",
                why="minor chord starting a ii–V toward a non-tonic target",
                target_pc=target,
            )
            return out

    out.update(
        function="chromatic",
        label="chromatic",
        why="no diatonic or secondary rule matched",
        penalties=["nondiatonic_guess"],
    )
    return out


# ---------------------------------------------------------------------------
# A6 — device detectors (operate on the holds-resolved move stream)
# ---------------------------------------------------------------------------


def detect_devices(moves, tonic_pc=None):
    """Detect harmonic devices over the move stream.

    Returns a list of {'type', 'move_idxs', ...} dicts. Types:
    'ii-V', 'ii-V-I', 'secondary_dominant', 'tritone_sub',
    'chromatic_bass_run', 'maj7_tonic'.
    """
    devices = []
    n = len(moves)

    def root(i):
        return moves[i]["chord"]["root_pc"] if 0 <= i < n else None

    def fam(i):
        return moves[i]["chord"]["family"] if 0 <= i < n else None

    for i in range(n - 1):
        # ii–V (and ii–V–I)
        if (
            fam(i) in ("min", "halfdim")
            and fam(i + 1) == "dom"
            and root(i) is not None
            and root(i + 1) is not None
            and (root(i) + 5) % 12 == root(i + 1)
        ):
            target = (root(i + 1) + 5) % 12
            if i + 2 < n and root(i + 2) == target:
                devices.append(
                    {"type": "ii-V-I", "move_idxs": [i, i + 1, i + 2], "target_pc": target}
                )
            else:
                devices.append({"type": "ii-V", "move_idxs": [i, i + 1], "target_pc": target})
        # secondary dominant: dom resolving down a fifth to a non-tonic root
        if (
            fam(i) == "dom"
            and root(i) is not None
            and root(i + 1) is not None
            and (root(i) + 5) % 12 == root(i + 1)
            and (tonic_pc is None or root(i + 1) != tonic_pc)
        ):
            devices.append(
                {"type": "secondary_dominant", "move_idxs": [i, i + 1], "target_pc": root(i + 1)}
            )
        # tritone substitution: dom7 resolving DOWN A SEMITONE
        if (
            fam(i) == "dom"
            and root(i) is not None
            and root(i + 1) is not None
            and (root(i) - 1) % 12 == root(i + 1)
        ):
            devices.append(
                {"type": "tritone_sub", "move_idxs": [i, i + 1], "target_pc": root(i + 1)}
            )

    # chromatic descending bass runs (each step exactly −1 semitone, length ≥ 3)
    run = [0]
    for i in range(1, n):
        b_prev, b_cur = _effective_bass_pc(moves[run[-1]]), _effective_bass_pc(moves[i])
        if b_prev is not None and b_cur is not None and (b_prev - 1) % 12 == b_cur:
            run.append(i)
        else:
            if len(run) >= 3:
                devices.append(
                    {"type": "chromatic_bass_run", "move_idxs": list(run), "length": len(run)}
                )
            run = [i]
    if len(run) >= 3:
        devices.append({"type": "chromatic_bass_run", "move_idxs": list(run), "length": len(run)})

    # maj7 tonic colour
    if tonic_pc is not None:
        for i in range(n):
            if root(i) == tonic_pc and moves[i]["chord"]["quality"] in ("maj7", "maj9"):
                devices.append({"type": "maj7_tonic", "move_idxs": [i]})

    return devices


def _tonicization_spans(functions, moves, tonic_pc):
    """Spans of consecutive moves driving toward the same non-tonic target."""
    spans = []
    cur = None
    for i, fn in enumerate(functions):
        target = fn.get("target_pc")
        if target is not None and target != tonic_pc:
            if cur and cur["target_pc"] == target and cur["move_idxs"][-1] >= i - 1:
                cur["move_idxs"].append(i)
            else:
                cur = {"target_pc": target, "move_idxs": [i]}
                spans.append(cur)
            # include the resolution move itself in the span
            nxt = i + 1
            if nxt < len(moves) and moves[nxt]["chord"]["root_pc"] == target:
                cur["move_idxs"].append(nxt)
        elif cur and i not in cur["move_idxs"]:
            cur = None
    for s in spans:
        s["move_idxs"] = sorted(set(s["move_idxs"]))
    return spans


# ---------------------------------------------------------------------------
# A7 — assemble
# ---------------------------------------------------------------------------

# Tension level by harmonic function (drives the Harmony tab's contour lane;
# values validated in the prototype). '%' holds share their move's function,
# so they carry the struck chord's tension automatically.
TENSION = {
    "tonic": 0.0,
    "subdominant": 1.0,
    "dominant": 2.0,
    "secondary_dominant": 3.0,
    "secondary_ii": 2.6,
    "passing": 2.4,
    "chromatic": 2.7,
    "unknown": 1.5,
}


def analyze_song(song, beats_per_bar=DEFAULT_BEATS):
    """Full analysis of one song dict → annotated stream (A7).

    Returns {'key': {...}, 'events': [...], 'devices': [...], 'summary': {...}}.
    Every event carries a 'confidence' level; discrepancies and ambiguity are
    first-class so the QA tab can shade and worklist them.
    """
    events = normalize_events(song, beats_per_bar)
    key = estimate_key(events, song.get("key"))
    tonic_pc, tonic_name, mode = key["tonic_pc"], key["tonic_name"], key["mode"]

    moves = _build_moves(events)
    ctx = [{"root_pc": m["chord"]["root_pc"], "family": m["chord"]["family"]} for m in moves]
    functions = []
    for i, mv in enumerate(moves):
        prev = ctx[i - 1] if i > 0 else None
        nxt = ctx[i + 1] if i + 1 < len(moves) else None
        functions.append(classify_function(prev, ctx[i], nxt, tonic_pc, mode or "major"))

    devices = detect_devices(moves, tonic_pc)
    spans = _tonicization_spans(functions, moves, tonic_pc)

    # map move-level results onto events
    move_of_event = {}
    for m_i, mv in enumerate(moves):
        for e_idx in mv["event_idxs"]:
            move_of_event[e_idx] = m_i
    devices_of_move = {}
    for dev in devices:
        for m_i in dev["move_idxs"]:
            devices_of_move.setdefault(m_i, []).append(dev["type"])
    target_of_move = {}
    for span in spans:
        for m_i in span["move_idxs"]:
            target_of_move[m_i] = span["target_pc"]

    key_penalty = [] if key["confidence"] != "low" else ["nondiatonic_guess"]
    out_events = []
    for ev in events:
        m_i = move_of_event[ev["idx"]]
        mv, fn = moves[m_i], functions[m_i]
        c = mv["chord"]
        penalties = list(c["penalties"]) + list(fn["penalties"]) + key_penalty
        rn = (
            roman(c["root"], c["quality"], tonic_name, mode or "major", c["bass"])
            if tonic_name
            else None
        )
        target_pc = target_of_move.get(m_i)
        out_events.append(
            {
                "idx": ev["idx"],
                "section": ev["section"],
                "section_label": ev["section_label"],
                "bar": ev["bar"],
                "bar_in_section": ev["bar_in_section"],
                "pos": ev["pos"],
                "beats": ev["beats"],
                "symbol": ev["symbol"],
                "chord": ev["chord"],
                "is_percent": ev["is_percent"],
                "voicing": ev["voicing"],
                "root": c["root"],
                "bass": c["bass"],
                "bass_physical": c["bass_physical"],
                "quality": c["quality"],
                "quality_source": c["quality_source"],
                "notes": c["notes"],
                "midis": c["midis"],
                "roman": rn,
                "function": fn["function"],
                "func_label": fn["label"],
                "why": fn["why"],
                "devices": devices_of_move.get(m_i, []),
                "tension": TENSION.get(fn["function"], 1.5),
                "tonic_target": DEFAULT_PC_NAMES[target_pc] if target_pc is not None else None,
                "confidence": confidence_level(penalties),
                "discrepancy": c["discrepancy"],
                "text": ev["text"],
            }
        )

    func_counts = {}
    for fn in functions:
        func_counts[fn["function"]] = func_counts.get(fn["function"], 0) + 1
    dev_counts = {}
    for dev in devices:
        dev_counts[dev["type"]] = dev_counts.get(dev["type"], 0) + 1
    summary = {
        "events": len(out_events),
        "moves": len(moves),
        "distinct_chords": len({e["chord"] for e in out_events if e["chord"]}),
        "functions": func_counts,
        "devices": dev_counts,
        "low_confidence": sum(1 for e in out_events if e["confidence"] == "low"),
        "discrepancies": sum(1 for e in out_events if e["discrepancy"]),
    }

    # device events carry event idxs too (the UI brackets need them)
    out_devices = []
    for dev in devices:
        d = dict(dev)
        d["event_idxs"] = [i for m_i in dev["move_idxs"] for i in moves[m_i]["event_idxs"]]
        if "target_pc" in d and d["target_pc"] is not None:
            d["target"] = DEFAULT_PC_NAMES[d["target_pc"]]
        out_devices.append(d)

    return {"key": key, "events": out_events, "devices": out_devices, "summary": summary}
