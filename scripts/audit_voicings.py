#!/usr/bin/env python3
"""Corpus-wide voicing audit: diff the CV diagram reader against stored voicings.

For every song in the corpus, read the chord diagrams deterministically from
the album PDF's native page images (diagram_reader) and pair them with the
song's chord entries in reading order. Two independent sources then exist for
every voicing:

  agree     reader == stored        -> almost certainly correct, skip in review
  differ    reader != stored        -> review worklist (vision hallucination,
                                       OR a deliberate editorial correction)
  unmatched diagram/entry counts differ -> structural attention needed

With --write, each paired entry gets `voicing_printed` (what the PAGE says) —
the stored `voicing` is NEVER touched, so running over hand-corrected songs is
safe. The report ranks songs by disagreement count: that is the review order.

    python scripts/audit_voicings.py --songs data/<artist>/songs \\
        --pdfs data/<artist>/pdf [--write] [--only <album-dir>] \\
        [--report-json /tmp/audit.json] [--cache /tmp/cv-cache]

Pairing and comparison are pure (tested); page reading is cached per PDF page.
"""

import argparse
import difflib
import json
import re
from pathlib import Path

from diagram_reader import decode_diagram, detect_diagrams, load_page_image, resolve_voicing
from materialize_songs import album_slug
from songsheet_version import stamp

# ---------------------------------------------------------------------------
# pure pairing / comparison
# ---------------------------------------------------------------------------


def voiced_entries(song):
    """Chord entries that should correspond to printed diagrams, in order.

    Entries WITH a stored voicing always count. If the diagram count instead
    matches all non-'%' entries, the caller may pair against those (entries
    that lost their voicing in migration still have a printed diagram).
    """
    with_v, non_pct = [], []
    for sec in song.get("sections", []):
        for bar in sec.get("bars", []):
            for e in bar:
                if e.get("chord") == "%":
                    continue
                non_pct.append(e)
                if e.get("voicing"):
                    with_v.append(e)
    return with_v, non_pct


def _fuzzy_pairs(entries, diagrams):
    """Align entries<->diagrams via difflib over voicing strings.

    'equal' runs pair agreeing voicings; same-length 'replace' runs pair
    positionally (the disagreements we want to surface); inserts/deletes
    (a missed or spurious diagram) are skipped instead of shifting the rest.
    """
    a = [e.get("voicing") or f"<none-{i}>" for i, e in enumerate(entries)]
    b = [d[0] or f"<err-{i}>" for i, d in enumerate(diagrams)]
    sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    pairs = []
    for op, a0, a1, b0, b1 in sm.get_opcodes():
        if op == "equal" or (op == "replace" and a1 - a0 == b1 - b0):
            pairs.extend((entries[a0 + k], diagrams[b0 + k]) for k in range(a1 - a0))
    return pairs


def pair_song(song, diagrams):
    """Pair a song's entries with its pages' decoded diagrams, in order.

    diagrams: list of (voicing_or_None, error_or_None) in reading order across
    the song's pages. Returns (pairs, mode) where pairs = [(entry, voicing)]
    and mode is 'voiced' | 'all-entries' | 'fuzzy' | None (unalignable).
    """
    with_v, non_pct = voiced_entries(song)
    if len(diagrams) == len(with_v):
        return list(zip(with_v, diagrams)), "voiced"
    if len(diagrams) == len(non_pct):
        return list(zip(non_pct, diagrams)), "all-entries"
    # near-miss counts (a missed/spurious diagram): anchor on agreements
    best = max(
        (_fuzzy_pairs(entries, diagrams) for entries in (with_v, non_pct)),
        key=len,
    )
    if best and len(best) >= 0.5 * min(len(diagrams), len(with_v) or len(non_pct)):
        return best, "fuzzy"
    # low-agreement songs give difflib no anchors; for |count diff| <= 2,
    # brute-force which elements of the longer list to drop, maximizing
    # voicing agreement of the resulting positional pairing
    for entries in (with_v, non_pct):
        if not entries:
            continue
        d = len(diagrams) - len(entries)
        if d == 0 or abs(d) > 2:
            continue
        longer_is_diagrams = d > 0
        longer = diagrams if longer_is_diagrams else entries
        shorter = entries if longer_is_diagrams else diagrams
        bestpairs, bestscore = None, -1
        n = len(longer)
        cuts_iter = (
            [(i,) for i in range(n)]
            if abs(d) == 1
            else [(i, j) for i in range(n) for j in range(i + 1, n)]
        )
        for cuts in cuts_iter:
            kept = [x for k, x in enumerate(longer) if k not in cuts]
            pair = list(zip(shorter, kept)) if longer_is_diagrams else list(zip(kept, shorter))
            score = sum(1 for e, (v, _err) in pair if v and e.get("voicing") == v)
            if score > bestscore:
                bestscore, bestpairs = score, pair
        if bestpairs is not None:
            return bestpairs, "offset"
    return [], None


def audit_song(song, diagrams):
    """Compare reader output against stored voicings.

    Returns a report dict; when paired, each entry dict gains nothing here —
    writing voicing_printed is the caller's choice (so this stays pure).
    """
    pairs, mode = pair_song(song, diagrams)
    n_with_v, n_non_pct = (len(x) for x in voiced_entries(song))
    rep = {
        "mode": mode,
        "diagrams": len(diagrams),
        "entries_with_voicing": n_with_v,
        "entries_non_pct": n_non_pct,
        "agree": 0,
        "differ": 0,
        "unreadable": 0,
        "missing_stored": 0,
        "diffs": [],
    }
    for e, (cv, err) in pairs:
        if cv is None:
            rep["unreadable"] += 1
            continue
        stored = e.get("voicing")
        if not stored:
            rep["missing_stored"] += 1
            rep["diffs"].append({"chord": e.get("chord"), "stored": None, "printed": cv})
        elif stored == cv:
            rep["agree"] += 1
        else:
            rep["differ"] += 1
            rep["diffs"].append({"chord": e.get("chord"), "stored": stored, "printed": cv})
    return rep, pairs


# ---------------------------------------------------------------------------
# I/O
# ---------------------------------------------------------------------------


def read_pdf_page_cached(pdf: Path, page_num: int, cache_dir: Path):
    """Decoded diagrams for one PDF page: [(box, decoded_or_None, err)] cached."""
    cache = cache_dir / f"{pdf.stem}-p{page_num:03d}.json"
    if cache.exists():
        return json.loads(cache.read_text())
    page = load_page_image(pdf, page_num)
    out = []
    for box in detect_diagrams(page):
        dec, err = decode_diagram(page, box)
        out.append([list(box), dec, err])
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(out))
    return out


def song_diagram_voicings(song, pdf: Path, cache_dir: Path):
    """(voicing_or_None, err) per diagram across the song's pages, in order.

    Base-fret resolution uses the stored chord names in entry order — the
    names are paired positionally, mirroring pair_song's alignment.
    """
    with_v, non_pct = voiced_entries(song)
    raw = []
    for page_num in song.get("pages", []):
        raw.extend(read_pdf_page_cached(pdf, page_num, cache_dir))
    names_pool = with_v if len(raw) == len(with_v) else non_pct
    out = []
    for k, (box, dec, err) in enumerate(raw):
        if dec is None:
            out.append((None, err))
            continue
        name = names_pool[k].get("chord") if k < len(names_pool) else None
        v, _base, _scored = resolve_voicing(dec, name)
        out.append((v, None if v else "base unresolved"))
    return out


def main():
    ap = argparse.ArgumentParser(description="Audit corpus voicings against the CV reader")
    ap.add_argument("--songs", type=Path, required=True, help="per-song corpus root")
    ap.add_argument("--pdfs", type=Path, required=True, help="album PDF directory")
    ap.add_argument("--only", help="only this album directory name")
    ap.add_argument("--write", action="store_true", help="persist voicing_printed into songs")
    ap.add_argument("--report-json", type=Path)
    ap.add_argument("--cache", type=Path, default=Path("/tmp/cv-cache"))
    args = ap.parse_args()

    def norm(slug):
        # song dirs sometimes zero-pad the leading album number ("01-chega-…")
        return re.sub(r"^0+(\d)", r"\1", slug)

    pdf_by_slug = {norm(album_slug(p.stem)): p for p in args.pdfs.glob("*.pdf")}
    rows = []
    for album_dir in sorted(p for p in args.songs.iterdir() if p.is_dir()):
        if args.only and album_dir.name != args.only:
            continue
        pdf = pdf_by_slug.get(norm(album_dir.name))
        if pdf is None:
            print(f"!! no PDF found for album {album_dir.name}, skipping")
            continue
        for song_file in sorted(album_dir.glob("*.json")):
            doc = json.loads(song_file.read_text())
            song = doc["songs"][0]
            try:
                diagrams = song_diagram_voicings(song, pdf, args.cache)
            except Exception as e:  # noqa: BLE001 — one bad page shouldn't kill the run
                rows.append({"album": album_dir.name, "file": song_file.name, "error": str(e)})
                continue
            rep, pairs = audit_song(song, diagrams)
            rep["album"] = album_dir.name
            rep["file"] = song_file.name
            rep["status"] = doc.get("document", {}).get("status") or "pending"
            rows.append(rep)
            if args.write and pairs:
                changed = False
                for e, (cv, _err) in pairs:
                    if cv and e.get("voicing_printed") != cv:
                        e["voicing_printed"] = cv
                        changed = True
                if changed:
                    song_file.write_text(json.dumps(stamp(doc), ensure_ascii=False, indent=2))
            tag = rep["mode"] or "UNALIGNED"
            print(
                f"{album_dir.name}/{song_file.name}: {tag}  agree={rep['agree']}"
                f" differ={rep['differ']} missing={rep['missing_stored']}"
                f" unreadable={rep['unreadable']}"
                f" (diagrams={rep['diagrams']}, voiced={rep['entries_with_voicing']})"
            )

    audited = [r for r in rows if r.get("mode")]
    agree = sum(r["agree"] for r in audited)
    differ = sum(r["differ"] for r in audited)
    missing = sum(r["missing_stored"] for r in audited)
    unaligned = [r for r in rows if "error" not in r and not r.get("mode")]
    errors = [r for r in rows if "error" in r]
    print(f"\n{'=' * 70}")
    print(
        f"AUDIT: {len(audited)} songs aligned, {len(unaligned)} unalignable, {len(errors)} errors"
    )
    total = agree + differ
    if total:
        print(
            f"voicings: {agree} agree ({agree / total:.1%}), {differ} differ, {missing} missing stored"
        )
    print("\nreview worklist (most disagreements first):")
    for r in sorted(audited, key=lambda r: -(r["differ"] + r["missing_stored"]))[:20]:
        print(f"  {r['differ'] + r['missing_stored']:4}  {r['album']}/{r['file']}  [{r['status']}]")
    if args.report_json:
        args.report_json.write_text(json.dumps(rows, ensure_ascii=False, indent=2))
        print(f"\nreport written to {args.report_json}")


if __name__ == "__main__":
    main()
