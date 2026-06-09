"""Tests for scripts/harmony.py — the pure harmonic-analysis engine (Phase A)."""
import json
from pathlib import Path

import pytest

import harmony
from harmony import (
    analyze_chord,
    analyze_song,
    classify_function,
    detect_devices,
    estimate_key,
    normalize_events,
    note_to_pc,
    parse_symbol,
    quality_from_pitches,
    roman,
    voicing_to_pitches,
    _build_moves,
)

FIXTURES = Path(__file__).parent / "fixtures"
CORPUS = Path(__file__).resolve().parent.parent / "data" / "joao-gilberto" / "songs"


def _song(sections):
    return {"title": "t", "sections": sections}


# ---------------------------------------------------------------------------
# A0 — event normalization
# ---------------------------------------------------------------------------

class TestNormalizeEvents:
    def test_percent_carries_previous_chord_and_voicing(self):
        song = _song([{"label": "A", "bars": [
            [{"chord": "Gm7", "voicing": "3,x,3,3,2,x"}],
            [{"chord": "%"}],
            [{"chord": "%"}],
        ]}])
        evs = normalize_events(song)
        assert evs[1]["is_percent"] and evs[2]["is_percent"]
        assert evs[1]["chord"] == "Gm7" and evs[2]["chord"] == "Gm7"
        assert evs[1]["voicing"] == "3,x,3,3,2,x"
        assert evs[1]["symbol"] == "%"  # raw symbol preserved

    def test_orphan_leading_percent(self):
        song = _song([{"label": None, "bars": [[{"chord": "%"}], [{"chord": "C"}]]}])
        evs = normalize_events(song)
        assert evs[0]["chord"] is None and evs[0]["is_percent"]

    def test_indices_unique_and_stable(self):
        song = _song([
            {"label": "A", "bars": [[{"chord": "C"}, {"chord": "C"}]]},
            {"label": "B", "bars": [[{"chord": "C"}]]},
        ])
        evs = normalize_events(song)
        assert [e["idx"] for e in evs] == [0, 1, 2]
        assert evs[2]["section"] == 1 and evs[2]["bar"] == 1
        assert evs[2]["bar_in_section"] == 0

    def test_beats_distribution(self):
        song = _song([{"label": None, "bars": [
            [{"chord": "C"}],
            [{"chord": "C"}, {"chord": "G"}],
            [{"chord": "C"}, {"chord": "F"}, {"chord": "G"}],
        ]}])
        evs = normalize_events(song)
        assert evs[0]["beats"] == 4
        assert [e["beats"] for e in evs[1:3]] == [2, 2]
        assert [e["beats"] for e in evs[3:6]] == [2, 1, 1]  # largest-remainder, earliest-wins

    def test_more_chords_than_beats_never_zero(self):
        bar = [{"chord": c} for c in ["C", "D", "E", "F", "G"]]
        evs = normalize_events(_song([{"label": None, "bars": [bar]}]))
        assert all(e["beats"] > 0 for e in evs)
        assert sum(e["beats"] for e in evs) == pytest.approx(4)


# ---------------------------------------------------------------------------
# A1 — voicing → pitches
# ---------------------------------------------------------------------------

class TestVoicingToPitches:
    def test_open_e(self):
        p = voicing_to_pitches("0,2,2,1,0,0")
        assert p["midis"] == [40, 47, 52, 56, 59, 64]
        assert p["pcs"] == {4, 8, 11}
        assert p["bass_pc"] == 4 and p["bass_midi"] == 40

    def test_up_neck_dm7(self):
        p = voicing_to_pitches("x,5,7,5,6,x")
        assert p["midis"] == [50, 57, 60, 65]
        assert p["pcs"] == {2, 9, 0, 5}
        assert p["bass_pc"] == 2

    def test_partial_muted(self):
        p = voicing_to_pitches("x,x,0,2,3,2")
        assert p["bass_midi"] == 50  # open D string
        assert p["pcs"] == {2, 9, 6}  # D A D F#

    def test_empty_and_malformed(self):
        for bad in (None, "", "1,2,3", "x,x,x,x,x,x", "a,b,c,d,e,f", "0,2,2,1,0,99"):
            p = voicing_to_pitches(bad)
            assert p["midis"] == [] and p["pcs"] == set()
            assert p["bass_pc"] is None


# ---------------------------------------------------------------------------
# A2 — notes-first quality
# ---------------------------------------------------------------------------

class TestQualityFromPitches:
    @pytest.mark.parametrize("intervals,expected", [
        ({0, 4, 7}, ""),
        ({0, 3, 7}, "m"),
        ({0, 4, 7, 11}, "maj7"),
        ({0, 4, 7, 10}, "7"),
        ({0, 4, 8, 10}, "7♯5"),
        ({0, 4, 7, 10, 1}, "7♭9"),
        ({0, 4, 6, 10, 2}, "9♭5"),
        ({0, 4, 10, 9}, "13"),
        ({0, 4, 9, 2}, "6/9"),
        ({0, 3, 7, 10}, "m7"),
        ({0, 3, 6, 10}, "m7♭5"),
        ({0, 3, 7, 11}, "mMaj7"),
        ({0, 3, 6, 11}, "mMaj7♭5"),
        ({0, 3, 6, 9}, "°7"),
        ({0, 3, 6}, "dim"),
        ({0, 5, 7}, "sus4"),
        ({0, 5, 7, 10}, "7sus4"),
        ({0, 4, 7, 10, 2}, "9"),
        ({0, 3, 7, 10, 2}, "m9"),
        ({0, 3, 7, 9}, "m6"),
        ({0, 4, 8}, "aug"),
    ])
    def test_qualities(self, intervals, expected):
        assert quality_from_pitches(0, intervals) == expected

    def test_root_transposition(self):
        # Dm7 = D F A C → pcs {2,5,9,0} with root 2
        assert quality_from_pitches(2, {2, 5, 9, 0}) == "m7"

    def test_no_third_is_ambiguous(self):
        assert quality_from_pitches(0, {0, 7, 10}) == "ambiguous"

    def test_quartal_is_ambiguous(self):
        # C F Bb — bare fourths must not be over-named as sus
        assert quality_from_pitches(0, {0, 5, 10}) == "ambiguous"

    def test_missing_root_is_ambiguous(self):
        assert quality_from_pitches(0, {4, 7, 10}) == "ambiguous"

    def test_empty_is_ambiguous(self):
        assert quality_from_pitches(0, set()) == "ambiguous"
        assert quality_from_pitches(None, {0, 4, 7}) == "ambiguous"


# ---------------------------------------------------------------------------
# A3 — symbol parse + reconcile
# ---------------------------------------------------------------------------

class TestParseSymbol:
    @pytest.mark.parametrize("symbol,root,quality,bass", [
        ("C", "C", "", None),
        ("Cm7", "C", "m7", None),
        ("Cmaj7", "C", "maj7", None),
        ("C7+", "C", "maj7", None),   # Brazilian: trailing 7+ = maj7
        ("C7M", "C", "maj7", None),
        ("Cmaj9", "C", "maj9", None),
        ("C7", "C", "7", None),
        ("C6", "C", "6", None),
        ("C69", "C", "6/9", None),
        ("C6/9", "C", "6/9", None),
        ("C7+5", "C", "7♯5", None),
        ("C7-9", "C", "7♭9", None),
        ("C7-5", "C", "7♭5", None),
        ("Cm7-5", "C", "m7♭5", None),
        ("C13", "C", "13", None),
        ("C13-9", "C", "13♭9", None),
        ("C13,9", "C", "13", None),
        ("C9", "C", "9", None),
        ("Cm7/9", "C", "m9", None),
        ("Cm79", "C", "m9", None),
        ("Cm7(9)", "C", "m9", None),
        ("Cdim7", "C", "°7", None),
        ("Cdim", "C", "dim", None),
        ("Cmmaj7", "C", "mMaj7", None),
        ("C7sus4", "C", "7sus4", None),
        ("Csus4", "C", "sus4", None),
        ("C479", "C", "9sus4", None),
        ("C/E", "C", "", "E"),
        ("Gm7/9", "G", "m9", None),
        ("D#m7/9/A#", "D#", "m9", "A#"),
        ("A13/G", "A", "13", "G"),
        ("Bb7", "Bb", "7", None),
    ])
    def test_corpus_vocabulary(self, symbol, root, quality, bass):
        p = parse_symbol(symbol)
        assert p["root"] == root
        assert p["quality"] == quality
        assert p["bass"] == bass

    def test_percent_and_empty(self):
        assert parse_symbol("%") is None
        assert parse_symbol(None) is None
        assert parse_symbol("") is None


class TestAnalyzeChord:
    def test_notes_first_wins(self):
        # symbol says Dm7; voicing IS a Dm7 → quality from notes
        c = analyze_chord("Dm7", "x,5,7,5,6,x")
        assert c["quality"] == "m7" and c["quality_source"] == "notes"
        assert c["penalties"] == []

    def test_notes_symbol_disagreement(self):
        # voicing is Cm7 (C Eb G Bb) but symbol claims C7 → discrepancy, low conf
        c = analyze_chord("C7", "x,3,5,3,4,x")
        assert c["quality_source"] == "notes"
        assert c["quality"] == "m7"
        assert "quality_mismatch" in c["penalties"]
        assert c["discrepancy"]

    def test_voicingless_falls_back_to_symbol(self):
        c = analyze_chord("A7+5", None)
        assert c["quality"] == "7♯5" and c["quality_source"] == "symbol"
        assert c["notes"] == [] and c["midis"] == []

    def test_ambiguous_voicing_falls_back_to_symbol_flagged(self):
        # power-chord voicing E B E → no 3rd → symbol quality used, flagged
        c = analyze_chord("E7", "0,2,2,x,x,x")
        assert c["quality"] == "7" and c["quality_source"] == "symbol"
        assert "symbol_fallback" in c["penalties"]

    def test_slash_bass_reconciliation(self):
        # symbol bass F# but the physical bass of the voicing is D (open 4th string)
        c = analyze_chord("Dm7/F#", "x,x,0,2,1,1")
        assert c["bass"] == "F#" and c["bass_pc"] == 6
        assert c["bass_physical"] == 2
        assert "bass_mismatch" in c["penalties"]

    def test_root_missing_from_voicing(self):
        # voicing sounds E Bb Db G — no C anywhere
        c = analyze_chord("C7", "x,x,2,3,2,3")
        assert "root_missing" in c["penalties"]

    def test_brazilian_tension_slash(self):
        c = analyze_chord("D#m7/9/A#", None)
        assert c["root"] == "D#" and c["bass"] == "A#"
        assert c["quality"] == "m9"


# ---------------------------------------------------------------------------
# A4 — key estimation
# ---------------------------------------------------------------------------

def _bars(*chords):
    return [[{"chord": c}] for c in chords]


class TestEstimateKey:
    def test_stored_key_wins(self):
        song = _song([{"label": None, "bars": _bars("Dm7", "G7", "Cmaj7")}])
        evs = normalize_events(song)
        key = estimate_key(evs, "A")
        assert key["tonic_name"] == "A" and key["how"] == "stored"
        assert key["mode"] == "major" and key["confidence"] == "high"

    def test_stored_minor(self):
        key = estimate_key([], "Bbm")
        assert key["tonic_pc"] == 10 and key["mode"] == "minor"

    def test_cadence_estimation(self):
        song = _song([{"label": None, "bars": _bars(
            "Cmaj7", "Dm7", "G7", "Cmaj7",
            "Dm7", "G7", "Cmaj7",
            "A7", "Dm7",          # one secondary toward ii — must not win
            "Dm7", "G7", "Cmaj7",
        )}])
        key = estimate_key(normalize_events(song), None)
        assert key["tonic_pc"] == 0
        assert key["mode"] == "major"
        assert key["how"] == "cadence"

    def test_heavy_tonicization_does_not_win(self):
        # 3 true ii–V–I to C vs 2 bare V–I into the tonicized D region
        song = _song([{"label": None, "bars": _bars(
            "Dm7", "G7", "Cmaj7",
            "E7", "A7", "D7", "G7", "Cmaj7",   # chain resolving home
            "Dm7", "G7", "Cmaj7",
            "Dm7", "G7", "Cmaj7",
        )}])
        key = estimate_key(normalize_events(song), None)
        assert key["tonic_pc"] == 0

    def test_not_the_relative_minor(self):
        song = _song([{"label": None, "bars": _bars(
            "Am7", "Dm7", "G7", "Cmaj7", "Am7", "Dm7", "G7", "Cmaj7",
        )}])
        key = estimate_key(normalize_events(song), None)
        assert key["tonic_pc"] == 0  # C, not A minor

    def test_spelling_follows_song_symbols(self):
        song = _song([{"label": None, "bars": _bars(
            "D#m7", "G#7", "C#maj7", "D#m7", "G#7", "C#maj7",
        )}])
        key = estimate_key(normalize_events(song), None)
        assert key["tonic_name"] == "C#"  # spelled as the songbook spells it

    def test_no_cadences_falls_back_to_ks_low_confidence(self):
        song = _song([{"label": None, "bars": [
            [{"chord": "C", "voicing": "x,3,2,0,1,0"}],
            [{"chord": "F", "voicing": "1,3,3,2,1,1"}],
            [{"chord": "C", "voicing": "x,3,2,0,1,0"}],
        ]}])
        key = estimate_key(normalize_events(song), None)
        assert key["how"] == "ks" and key["confidence"] == "low"


# ---------------------------------------------------------------------------
# A5 — Roman numerals + function
# ---------------------------------------------------------------------------

class TestRoman:
    @pytest.mark.parametrize("root,quality,tonic,mode,bass,expected", [
        ("C", "maj7", "C", "major", None, "Imaj7"),
        ("D", "m7", "C", "major", None, "ii7"),
        ("G", "7", "C", "major", None, "V7"),
        ("B", "m7♭5", "C", "major", None, "viiø7"),
        ("D#", "m7", "C#", "major", None, "ii7"),
        ("F#", "maj7", "C#", "major", None, "IVmaj7"),
        ("Db", "7", "C", "major", None, "♭II7"),
        ("A", "7", "C", "major", None, "VI7"),
        ("Eb", "maj7", "C", "major", None, "♭IIImaj7"),
        ("C", "7♯5", "C", "major", None, "I7♯5"),
        ("C", "°7", "C", "major", None, "i°7"),
        ("G", "7", "C", "major", "B", "V7/B"),
        ("A", "m", "A", "minor", None, "i"),
        ("E", "7", "A", "minor", None, "V7"),
    ])
    def test_roman(self, root, quality, tonic, mode, bass, expected):
        assert roman(root, quality, tonic, mode, bass) == expected

    def test_unknown_root(self):
        assert roman(None, "m7", "C") is None


def _ctx(root, family):
    return {"root_pc": note_to_pc(root), "family": family}


class TestClassifyFunction:
    def test_diatonic_degrees(self):
        c = note_to_pc("C")
        assert classify_function(None, _ctx("C", "maj"), None, c)["function"] == "tonic"
        assert classify_function(None, _ctx("D", "min"), None, c)["function"] == "subdominant"
        assert classify_function(None, _ctx("F", "maj"), None, c)["function"] == "subdominant"
        assert classify_function(None, _ctx("G", "dom"), None, c)["function"] == "dominant"
        assert classify_function(None, _ctx("A", "min"), None, c)["function"] == "tonic"

    def test_secondary_dominant_needs_resolution(self):
        c = note_to_pc("C")
        resolved = classify_function(None, _ctx("A", "dom"), _ctx("D", "min"), c)
        assert resolved["function"] == "secondary_dominant"
        assert resolved["target_pc"] == note_to_pc("D")
        unresolved = classify_function(None, _ctx("A", "dom"), _ctx("F", "maj"), c)
        assert unresolved["function"] == "dominant"
        assert "unresolved_dominant" in unresolved["penalties"]

    def test_bluesy_I7(self):
        c = note_to_pc("C")
        fn = classify_function(None, _ctx("C", "dom"), _ctx("F", "maj"), c)
        assert fn["function"] == "tonic" and "I7" in fn["label"]

    def test_diminished_leading_tone(self):
        c = note_to_pc("C")
        fn = classify_function(_ctx("C", "maj"), _ctx("C#", "dim"), _ctx("D", "min"), c)
        # C#° between C and Dm matches both leading-tone and passing →
        # tie-break picks leading-tone and flags the multi-match
        assert fn["function"] == "dominant" and "leading-tone" in fn["label"]
        assert "dim_multimatch" in fn["penalties"]

    def test_diminished_common_tone(self):
        c = note_to_pc("C")
        fn = classify_function(_ctx("G", "dom"), _ctx("C", "dim"), _ctx("C", "maj"), c)
        assert "common-tone" in fn["label"]

    def test_unknown_chord(self):
        fn = classify_function(None, {"root_pc": None, "family": "amb"}, None, 0)
        assert fn["function"] == "unknown"


# ---------------------------------------------------------------------------
# A6 — device detectors
# ---------------------------------------------------------------------------

def _moves_for(*chords):
    song = _song([{"label": None, "bars": _bars(*chords)}])
    return _build_moves(normalize_events(song))


class TestDetectDevices:
    def test_ii_v_i(self):
        devs = detect_devices(_moves_for("Dm7", "G7", "Cmaj7"), tonic_pc=0)
        types = {d["type"] for d in devs}
        assert "ii-V-I" in types
        assert "maj7_tonic" in types

    def test_ii_v_without_resolution(self):
        devs = detect_devices(_moves_for("Dm7", "G7", "Am7"), tonic_pc=0)
        types = [d["type"] for d in devs]
        assert "ii-V" in types and "ii-V-I" not in types

    def test_secondary_dominant(self):
        devs = detect_devices(_moves_for("A7", "Dm7"), tonic_pc=0)
        assert any(d["type"] == "secondary_dominant" and d["target_pc"] == 2
                   for d in devs)

    def test_v_to_tonic_not_secondary(self):
        devs = detect_devices(_moves_for("G7", "C"), tonic_pc=0)
        assert not any(d["type"] == "secondary_dominant" for d in devs)

    def test_tritone_sub(self):
        devs = detect_devices(_moves_for("Db7", "Cmaj7"), tonic_pc=0)
        assert any(d["type"] == "tritone_sub" for d in devs)

    def test_chromatic_bass_run(self):
        # G – F# – F – E in the bass (Desde's "tear" line shape)
        devs = detect_devices(
            _moves_for("G", "D/F#", "F6", "C/E"), tonic_pc=None)
        runs = [d for d in devs if d["type"] == "chromatic_bass_run"]
        assert runs and runs[0]["length"] == 4

    def test_percent_carries_do_not_break_runs(self):
        song = _song([{"label": None, "bars": [
            [{"chord": "G"}], [{"chord": "%"}],
            [{"chord": "D/F#"}], [{"chord": "F6"}], [{"chord": "C/E"}],
        ]}])
        moves = _build_moves(normalize_events(song))
        assert len(moves) == 4  # the % merged into the G move
        devs = detect_devices(moves)
        assert any(d["type"] == "chromatic_bass_run" for d in devs)


# ---------------------------------------------------------------------------
# A7 — assemble
# ---------------------------------------------------------------------------

class TestAnalyzeSong:
    def _fixture_song(self):
        doc = json.loads((FIXTURES / "chega-page1.json").read_text())
        return doc["songs"][0]

    def test_full_shape(self):
        result = analyze_song(self._fixture_song())
        assert set(result) == {"key", "events", "devices", "summary"}
        ev = result["events"][0]
        for field in ("idx", "section", "bar", "beats", "symbol", "chord", "root",
                      "bass", "bass_physical", "quality", "quality_source", "notes",
                      "midis", "roman", "function", "func_label", "why", "devices",
                      "tonic_target", "confidence", "discrepancy", "text"):
            assert field in ev, field
        assert result["summary"]["events"] == len(result["events"])
        assert all(e["confidence"] in ("high", "medium", "low")
                   for e in result["events"])

    def test_confidence_fires_on_known_discrepancy(self):
        song = _song([{"label": None, "bars": [
            [{"chord": "C7", "voicing": "x,3,5,3,4,x"}],  # voicing is Cm7
            [{"chord": "G7"}],
            [{"chord": "C"}],
        ]}])
        result = analyze_song(song)
        ev = result["events"][0]
        assert ev["discrepancy"]
        assert ev["confidence"] == "low"
        assert result["summary"]["discrepancies"] >= 1

    def test_percent_events_share_move_analysis(self):
        song = _song([{"label": None, "bars": [
            [{"chord": "Dm7", "voicing": "x,5,7,5,6,x"}],
            [{"chord": "%"}],
            [{"chord": "G7"}],
            [{"chord": "Cmaj7"}],
        ]}])
        result = analyze_song(song)
        e0, e1 = result["events"][0], result["events"][1]
        assert e1["is_percent"]
        assert e1["quality"] == e0["quality"] == "m7"
        assert e1["roman"] == e0["roman"]

    def test_tonicization_span(self):
        song = _song([{"label": None, "bars": _bars(
            "Cmaj7", "Em7", "A7", "Dm7", "G7", "Cmaj7",
        )}])
        result = analyze_song(song)
        a7 = next(e for e in result["events"] if e["symbol"] == "A7")
        assert a7["tonic_target"] == "D"

    def test_multi_song_unaffected(self):
        # analyze_song takes ONE song dict; callers pick songs[i]
        song = self._fixture_song()
        r1 = analyze_song(song)
        r2 = analyze_song(song)
        assert r1["summary"] == r2["summary"]  # deterministic


# ---------------------------------------------------------------------------
# Corpus regression tests (skipped when the git-ignored corpus is absent)
# ---------------------------------------------------------------------------

GAROTA = CORPUS / "04-joao-e-getz" / "01-garota-de-ipanema.json"
DESDE = CORPUS / "15-voz-e-violao" / "01-desde-que-o-samba-e-samba.json"


@pytest.mark.skipif(not GAROTA.exists(), reason="corpus not present")
def test_garota_key_is_csharp_major():
    song = json.loads(GAROTA.read_text())["songs"][0]
    result = analyze_song(song)
    key = result["key"]
    assert key["tonic_pc"] == 1          # C#/Db
    assert key["mode"] == "major"        # NOT the relative minor (KS picked F#m)
    assert key["tonic_name"] in ("C#", "Db")


@pytest.mark.skipif(not DESDE.exists(), reason="corpus not present")
def test_desde_stored_key_wins_and_devices_found():
    song = json.loads(DESDE.read_text())["songs"][0]
    result = analyze_song(song)
    assert result["key"]["tonic_name"] == "A"
    assert result["key"]["how"] == "stored"
    assert result["summary"]["devices"].get("ii-V-I", 0) > 0
    assert result["summary"]["devices"].get("secondary_dominant", 0) > 0
    assert result["summary"]["devices"].get("chromatic_bass_run", 0) > 0
