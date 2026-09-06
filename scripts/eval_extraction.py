#!/usr/bin/env python3
"""Score a candidate extraction against hand-corrected golden songs, and diff
two independent parses of the same material.

Two modes:

  score  — per-field accuracy of a candidate corpus against the golden corpus
           (the hand-corrected per-song JSONs; by default only songs whose
           document.status is "done" count as ground truth). Gives parser /
           prompt / model changes a number instead of a vibe:

             python scripts/eval_extraction.py score \\
                 --golden data/joao-gilberto/songs \\
                 --candidate /tmp/fresh-parse/songs [--all-statuses] \\
                 [--report-json /tmp/eval.json]

  diff   — bar-level disagreements between two parses of the same song
           (e.g. two providers, or two runs). Disagreement is a nearly free
           error detector: bars where independent parses differ are where QA
           time should go first.

             python scripts/eval_extraction.py diff a.json b.json \\
                 [--report-json /tmp/diff.json]

Scoring is alignment-based (difflib over the flat chord-name sequence), so a
missing or extra bar doesn't cascade into "everything after it is wrong".
All scoring functions are pure; only main() touches disk.
"""

import argparse
import difflib
import json
import re
from pathlib import Path

# ---------------------------------------------------------------------------
# pure scoring
# ---------------------------------------------------------------------------


def flat_entries(song):
    """All chord entries of a song in reading order, with their (si, bi) home."""
    out = []
    for si, sec in enumerate(song.get("sections", [])):
        for bi, bar in enumerate(sec.get("bars", [])):
            for e in bar:
                out.append({"si": si, "bi": bi, **e})
    return out


def _norm_text(t):
    """Lyric fragment comparison key: casefold, collapse whitespace, and
    neutralize word-continuation dashes ('nho- ra,' == 'nhora,') — dash
    presence is a corpus convention, not extraction correctness. Accents are
    KEPT: dropping diacritics is a real model error. (Cost: a genuine hyphen
    inside a lyric word would also be removed — rare enough to accept.)"""
    s = str(t or "")
    s = s.replace("- ", "").replace("-", "")
    return re.sub(r"\s+", " ", s).strip().casefold()


PERCENT = "%"


def harm_key(name):
    """Harmonic identity of a chord name: (root_pc, quality, bass_pc).

    'Amaj7' and 'A7+' are the same chord in different spelling conventions —
    the golden corpus uses Brazilian forms while songbooks print others, so
    chord correctness must compare harmony, not strings. Unparseable names
    (and '%') fall back to the raw string.
    """
    from harmony import parse_symbol

    p = parse_symbol(name) if name and name != PERCENT else None
    if p is None:
        return ("raw", name)
    return ("h", p["root_pc"], p["quality"], p["bass_pc"])


def aligned_pairs(truth_names, cand_names):
    """Index pairs (ti, ci) of harmonically-equal entries via difflib alignment."""
    t_keys = [harm_key(n) for n in truth_names]
    c_keys = [harm_key(n) for n in cand_names]
    sm = difflib.SequenceMatcher(a=t_keys, b=c_keys, autojunk=False)
    pairs = []
    for op, t0, t1, c0, c1 in sm.get_opcodes():
        if op == "equal":
            pairs.extend((t0 + k, c0 + k) for k in range(t1 - t0))
    return pairs


def _frac(num, den):
    return round(num / den, 4) if den else None


def _song_counts(truth_song, cand_song):
    """Raw alignment counters for one song pair (the basis of all fractions)."""
    t, c = flat_entries(truth_song), flat_entries(cand_song)
    pairs = aligned_pairs([e["chord"] for e in t], [e["chord"] for e in c])
    n = {
        "pairs": len(pairs),
        "t": len(t),
        "c": len(c),
        "s_ok": 0,
        "v_ok": 0,
        "v_tot": 0,
        "x_ok": 0,
        "x_tot": 0,
        "a_ok": 0,
    }
    for ti, ci in pairs:
        te, ce = t[ti], c[ci]
        n["s_ok"] += te["chord"] == ce["chord"]
        if te.get("voicing"):
            n["v_tot"] += 1
            n["v_ok"] += te["voicing"] == ce.get("voicing")
        if te.get("text"):
            n["x_tot"] += 1
            n["x_ok"] += _norm_text(te["text"]) == _norm_text(ce.get("text"))
        n["a_ok"] += (te["si"], te["bi"]) == (ce["si"], ce["bi"])
    return n


def score_song(truth_song, cand_song):
    """Per-field accuracy of a candidate song against a hand-corrected truth.

    chord_acc    harmonically-equal aligned entries / truth entries
    spelling_acc of aligned pairs, fraction with the IDENTICAL printed name
                 (convention agreement — Amaj7 vs A7+ counts here, not above)
    voicing_acc  of aligned pairs where truth has a voicing, fraction equal
    text_acc     of aligned pairs where truth has text, fraction equal (normed)
    anchor_acc   of aligned pairs, fraction in the same (section, bar) position
    bar counts   truth vs candidate totals (structure drift at a glance)
    """
    n = _song_counts(truth_song, cand_song)
    t_bars = sum(len(s.get("bars", [])) for s in truth_song.get("sections", []))
    c_bars = sum(len(s.get("bars", [])) for s in cand_song.get("sections", []))
    return {
        "chord_acc": _frac(n["pairs"], n["t"]),
        "spelling_acc": _frac(n["s_ok"], n["pairs"]),
        "voicing_acc": _frac(n["v_ok"], n["v_tot"]),
        "text_acc": _frac(n["x_ok"], n["x_tot"]),
        "anchor_acc": _frac(n["a_ok"], n["pairs"]),
        "truth_entries": n["t"],
        "cand_entries": n["c"],
        "truth_bars": t_bars,
        "cand_bars": c_bars,
    }


def score_corpus(song_pairs):
    """Aggregate over [(name, truth_song, cand_song)] pairs.

    Aggregates are computed from summed raw counters (weighted by entry
    counts), not a mean of per-song percentages, so long songs count
    proportionally.
    """
    per_song = {}
    tot = {"pairs": 0, "t": 0, "s_ok": 0, "v_ok": 0, "v_tot": 0, "x_ok": 0, "x_tot": 0, "a_ok": 0}
    for name, truth, cand in song_pairs:
        per_song[name] = score_song(truth, cand)
        n = _song_counts(truth, cand)
        for k in tot:
            tot[k] += n[k]
    return {
        "songs": per_song,
        "aggregate": {
            "songs": len(per_song),
            "chord_acc": _frac(tot["pairs"], tot["t"]),
            "spelling_acc": _frac(tot["s_ok"], tot["pairs"]),
            "voicing_acc": _frac(tot["v_ok"], tot["v_tot"]),
            "text_acc": _frac(tot["x_ok"], tot["x_tot"]),
            "anchor_acc": _frac(tot["a_ok"], tot["pairs"]),
            "truth_entries": tot["t"],
        },
    }


def disagreements(song_a, song_b):
    """Bar-level differences between two parses of the same song.

    Returns [{si, bi, field, a, b}] where field is one of structure/chords/
    voicings/text. Compared positionally: bars at the same (section, bar)
    index. Section/bar count mismatches are reported as 'structure' items.
    """
    out = []
    secs_a = song_a.get("sections", [])
    secs_b = song_b.get("sections", [])
    if len(secs_a) != len(secs_b):
        out.append(
            {
                "si": None,
                "bi": None,
                "field": "structure",
                "a": f"{len(secs_a)} sections",
                "b": f"{len(secs_b)} sections",
            }
        )
    for si in range(min(len(secs_a), len(secs_b))):
        bars_a = secs_a[si].get("bars", [])
        bars_b = secs_b[si].get("bars", [])
        if len(bars_a) != len(bars_b):
            out.append(
                {
                    "si": si,
                    "bi": None,
                    "field": "structure",
                    "a": f"{len(bars_a)} bars",
                    "b": f"{len(bars_b)} bars",
                }
            )
        for bi in range(min(len(bars_a), len(bars_b))):
            ba, bb = bars_a[bi], bars_b[bi]
            names_a = [e.get("chord") for e in ba]
            names_b = [e.get("chord") for e in bb]
            if names_a != names_b:
                same_harm = [harm_key(n) for n in names_a] == [harm_key(n) for n in names_b]
                if same_harm:
                    # same chords, different spelling convention — positions still
                    # correspond, so fall through to voicing/text comparison
                    out.append(
                        {"si": si, "bi": bi, "field": "spelling", "a": names_a, "b": names_b}
                    )
                else:
                    out.append({"si": si, "bi": bi, "field": "chords", "a": names_a, "b": names_b})
                    continue  # voicing/text positions don't correspond
            voic_a = [e.get("voicing") for e in ba]
            voic_b = [e.get("voicing") for e in bb]
            if voic_a != voic_b:
                out.append({"si": si, "bi": bi, "field": "voicings", "a": voic_a, "b": voic_b})
            text_a = [_norm_text(e.get("text")) for e in ba]
            text_b = [_norm_text(e.get("text")) for e in bb]
            if text_a != text_b:
                out.append(
                    {
                        "si": si,
                        "bi": bi,
                        "field": "text",
                        "a": [e.get("text") for e in ba],
                        "b": [e.get("text") for e in bb],
                    }
                )
    return out


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _load_song(path: Path):
    doc = json.loads(path.read_text())
    return doc["songs"][0], doc


def _golden_files(golden_root: Path, all_statuses: bool):
    """Golden song files: status 'done' only, unless --all-statuses."""
    out = []
    for p in sorted(golden_root.glob("*/*.json")):
        doc = json.loads(p.read_text())
        status = doc.get("document", {}).get("status")
        if all_statuses or status == "done":
            out.append(p)
    return out


def _fmt_pct(v):
    return "—" if v is None else f"{v * 100:6.2f}%"


def cmd_score(args):
    golden = _golden_files(args.golden, args.all_statuses)
    if not golden:
        print("No golden songs found (none marked status=done; use --all-statuses to override).")
        return 1
    pairs, missing = [], []
    for g in golden:
        rel = g.relative_to(args.golden)
        cand = args.candidate / rel
        if not cand.exists():
            missing.append(str(rel))
            continue
        pairs.append((str(rel), _load_song(g)[0], _load_song(cand)[0]))
    if missing:
        print(f"skipped {len(missing)} golden song(s) with no candidate: {missing}")
    if not pairs:
        print("Nothing to score.")
        return 1

    report = score_corpus(pairs)
    print(f"{'song':<50} {'chord':>8} {'spell':>8} {'voicing':>8} {'text':>8} {'anchor':>8}  bars")
    for name, s in report["songs"].items():
        print(
            f"{name:<50} {_fmt_pct(s['chord_acc']):>8} {_fmt_pct(s['spelling_acc']):>8}"
            f" {_fmt_pct(s['voicing_acc']):>8}"
            f" {_fmt_pct(s['text_acc']):>8} {_fmt_pct(s['anchor_acc']):>8}"
            f"  {s['cand_bars']}/{s['truth_bars']}"
        )
    a = report["aggregate"]
    print(
        f"\n{'AGGREGATE (' + str(a['songs']) + ' songs)':<50}"
        f" {_fmt_pct(a['chord_acc']):>8} {_fmt_pct(a['spelling_acc']):>8}"
        f" {_fmt_pct(a['voicing_acc']):>8}"
        f" {_fmt_pct(a['text_acc']):>8} {_fmt_pct(a['anchor_acc']):>8}"
    )
    if args.report_json:
        args.report_json.write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(f"report written to {args.report_json}")
    return 0


def cmd_diff(args):
    song_a, _ = _load_song(args.a)
    song_b, _ = _load_song(args.b)
    items = disagreements(song_a, song_b)
    if not items:
        print("Parses agree on every bar.")
        return 0
    for d in items:
        where = (
            "doc"
            if d["si"] is None
            else (f"section {d['si'] + 1}" + ("" if d["bi"] is None else f" bar {d['bi'] + 1}"))
        )
        print(f"{where:<22} {d['field']:<10} A={d['a']}  B={d['b']}")
    print(f"\n{len(items)} disagreement(s) — review these bars first.")
    if args.report_json:
        args.report_json.write_text(json.dumps(items, ensure_ascii=False, indent=2))
        print(f"report written to {args.report_json}")
    return 0


def cmd_reparse(args):
    """Parse a golden song's page PNGs fresh, assemble, score against the golden.

    The whole prompt-improvement loop in one command: per-page parses are
    cached under --workdir only while their input/settings fingerprints match.
    """
    import re as _re

    from songsheet_io import write_json_artifact
    from validate_extraction import assemble_document, parse_page

    golden_song, golden_doc = _load_song(args.golden)
    pages_dir = args.golden.parent / "pages"
    stem = args.golden.stem
    pngs = sorted(
        pages_dir.glob(f"{stem}-p*.png"),
        key=lambda p: int(_re.search(r"-p(\d+)$", p.stem).group(1)),
    )
    if not pngs:
        print(f"No page PNGs found at {pages_dir}/{stem}-p*.png")
        return 1

    work = args.workdir / stem
    work.mkdir(parents=True, exist_ok=True)
    page_results = []
    for png in pngs:
        print(f"  {png.name}: checking extraction…", flush=True)
        page_results.append(
            parse_page(png, work, args.force, provider=args.provider, model=args.model)
        )

    numbers = [int(_re.search(r"-p(\d+)$", png.stem).group(1)) for png in pngs]
    source_pdf = Path(golden_doc.get("document", {}).get("source_pdf") or stem)
    doc = assemble_document(source_pdf, page_results, page_numbers=numbers)
    write_json_artifact(work / "_candidate.json", doc, overwrite=True)
    if len(doc["songs"]) != 1:
        print(f"Cannot score: fresh parse assembled into {len(doc['songs'])} songs; expected one.")
        return 1
    cand_song = doc["songs"][0]

    s = score_song(golden_song, cand_song)
    print(f"\n{'':<12} {'chord':>8} {'spell':>8} {'voicing':>8} {'text':>8} {'anchor':>8}  bars")
    print(
        f"{'fresh parse':<12} {_fmt_pct(s['chord_acc']):>8} {_fmt_pct(s['spelling_acc']):>8}"
        f" {_fmt_pct(s['voicing_acc']):>8}"
        f" {_fmt_pct(s['text_acc']):>8} {_fmt_pct(s['anchor_acc']):>8}"
        f"  {s['cand_bars']}/{s['truth_bars']}"
    )

    items = disagreements(golden_song, cand_song)
    if args.show_diff:
        print()
        for d in items:
            where = (
                "doc"
                if d["si"] is None
                else (f"section {d['si'] + 1}" + ("" if d["bi"] is None else f" bar {d['bi'] + 1}"))
            )
            print(f"{where:<22} {d['field']:<10} GOLDEN={d['a']}  FRESH={d['b']}")
    print(f"\n{len(items)} bar-level disagreement(s); candidate at {work / '_candidate.json'}")
    if args.report_json:
        args.report_json.write_text(
            json.dumps({"score": s, "disagreements": items}, ensure_ascii=False, indent=2)
        )
        print(f"report written to {args.report_json}")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("score", help="score a candidate corpus against golden songs")
    sp.add_argument("--golden", type=Path, required=True, help="hand-corrected corpus root")
    sp.add_argument("--candidate", type=Path, required=True, help="fresh-parse corpus root")
    sp.add_argument(
        "--all-statuses",
        action="store_true",
        help="treat every golden song as truth, not just status=done",
    )
    sp.add_argument("--report-json", type=Path)
    sp.set_defaults(fn=cmd_score)

    dp = sub.add_parser("diff", help="bar-level disagreements between two parses")
    dp.add_argument("a", type=Path)
    dp.add_argument("b", type=Path)
    dp.add_argument("--report-json", type=Path)
    dp.set_defaults(fn=cmd_diff)

    rp = sub.add_parser("reparse", help="re-parse a golden song's pages fresh and score against it")
    rp.add_argument("golden", type=Path, help="hand-corrected song JSON (pages/ sibling dir)")
    rp.add_argument("--workdir", type=Path, default=Path("/tmp/ssv-eval"))
    rp.add_argument("--force", action="store_true", help="ignore cached page parses")
    rp.add_argument("--provider", default="codex")
    rp.add_argument("--model")
    rp.add_argument("--show-diff", action="store_true", help="print every disagreement")
    rp.add_argument("--report-json", type=Path)
    rp.set_defaults(fn=cmd_reparse)

    args = ap.parse_args()
    raise SystemExit(args.fn(args))


if __name__ == "__main__":
    main()
