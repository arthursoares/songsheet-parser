#!/usr/bin/env python3
"""Create and score frozen, song-level extraction benchmark manifests."""

import argparse
import hashlib
import json
from pathlib import Path

import eval_extraction

MANIFEST_VERSION = 1
SPLITS = ("development", "held_out")
GROUND_TRUTH_LABEL = "human_reviewed"


def _canonical_path(golden_root, selection):
    root = golden_root.resolve()
    selected = Path(selection)
    path = (root / selected).resolve() if not selected.is_absolute() else selected.resolve()
    try:
        relative = path.relative_to(root)
    except ValueError as exc:
        raise ValueError(f"reference is outside golden root: {selection}") from exc
    if path.suffix != ".json" or not path.is_file():
        raise ValueError(f"reference is not a song JSON file: {selection}")
    doc = json.loads(path.read_text())
    if len(doc.get("songs", [])) != 1:
        raise ValueError(f"reference must contain exactly one whole song: {relative}")
    return path, relative.as_posix()


def _reference(golden_root, selection, label_type, review_provenance):
    path, relative = _canonical_path(golden_root, selection)
    return {
        "path": relative,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "label_type": label_type,
        "review_provenance": review_provenance,
    }


def create_manifest(
    golden_root,
    development,
    held_out,
    label_type,
    review_provenance,
):
    """Return a deterministic manifest with explicit, disjoint whole-song splits."""
    if not str(review_provenance).strip():
        raise ValueError("review provenance must be non-empty")
    memberships = {}
    for split, selections in (("development", development), ("held_out", held_out)):
        if not selections:
            raise ValueError(f"{split} split must contain at least one song")
        refs = [_reference(golden_root, s, label_type, review_provenance) for s in selections]
        paths = [ref["path"] for ref in refs]
        if len(paths) != len(set(paths)):
            raise ValueError(f"duplicate song in {split} split")
        memberships[split] = sorted(refs, key=lambda ref: ref["path"])
    development_paths = {ref["path"] for ref in memberships["development"]}
    held_out_paths = {ref["path"] for ref in memberships["held_out"]}
    overlap = sorted(development_paths & held_out_paths)
    if overlap:
        raise ValueError(f"song appears in both splits: {overlap}")
    return {"manifest_version": MANIFEST_VERSION, "splits": memberships}


def write_manifest(path, manifest):
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n")


def load_manifest(path):
    manifest = json.loads(path.read_text())
    _validate_manifest_shape(manifest)
    return manifest


def _validate_manifest_shape(manifest):
    if manifest.get("manifest_version") != MANIFEST_VERSION:
        raise ValueError(f"unsupported manifest_version: {manifest.get('manifest_version')}")
    if set(manifest.get("splits", {})) != set(SPLITS):
        raise ValueError("manifest must contain exactly development and held_out splits")


def _verified_references(manifest, golden_root, split):
    _validate_manifest_shape(manifest)
    if split not in SPLITS:
        raise ValueError(f"unknown split: {split}")
    resolved_splits = {}
    for split_name in SPLITS:
        split_refs = manifest["splits"][split_name]
        if not split_refs:
            raise ValueError(f"{split_name} split must contain at least one song")
        resolved_splits[split_name] = [
            _canonical_path(golden_root, ref.get("path", "")) for ref in split_refs
        ]
        paths = [relative for _path, relative in resolved_splits[split_name]]
        if len(paths) != len(set(paths)):
            raise ValueError(f"duplicate song in {split_name} split")
    development_paths = {relative for _path, relative in resolved_splits["development"]}
    held_out_paths = {relative for _path, relative in resolved_splits["held_out"]}
    overlap = sorted(development_paths & held_out_paths)
    if overlap:
        raise ValueError(f"song appears in both splits: {overlap}")
    refs = manifest["splits"][split]
    resolved = resolved_splits[split]
    verified = []
    for ref, (path, relative) in zip(refs, resolved, strict=True):
        if ref.get("label_type") != GROUND_TRUTH_LABEL:
            raise ValueError(
                f"{ref.get('path')} is not eligible as ground truth: "
                f"label_type={ref.get('label_type')!r}"
            )
        if not str(ref.get("review_provenance", "")).strip():
            raise ValueError(f"{ref.get('path')} has no review provenance")
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != ref.get("sha256"):
            raise ValueError(f"gold reference hash mismatch: {relative}")
        verified.append((relative, path))
    return verified


def score_split(
    manifest,
    golden_root,
    candidate_root,
    split,
    voicing_reference_field="voicing",
):
    """Verify a frozen split, then score it with missing songs treated as empty parses."""
    refs = _verified_references(manifest, golden_root, split)
    pairs = []
    missing = []
    selected = {relative for relative, _path in refs}
    for relative, gold_path in refs:
        candidate_path = candidate_root / relative
        truth = eval_extraction._load_song(gold_path)[0]
        if candidate_path.is_file():
            candidate = eval_extraction._load_song(candidate_path)[0]
        else:
            candidate = {"sections": []}
            missing.append(relative)
        pairs.append((relative, truth, candidate))
    candidate_files = {
        path.relative_to(candidate_root).as_posix() for path in candidate_root.glob("*/*.json")
    }
    report = eval_extraction.score_corpus(
        pairs,
        voicing_reference_field=voicing_reference_field,
        missing_songs=missing,
        extra_candidate_songs=sorted(candidate_files - selected),
    )
    report["benchmark"] = {
        "manifest_version": manifest["manifest_version"],
        "split": split,
        "references_verified": len(refs),
    }
    return report


def cmd_create(args):
    manifest = create_manifest(
        args.golden,
        args.development,
        args.held_out,
        args.label_type,
        args.review_provenance,
    )
    write_manifest(args.output, manifest)
    print(
        f"wrote {args.output}: {len(manifest['splits']['development'])} development, "
        f"{len(manifest['splits']['held_out'])} held_out"
    )
    return 0


def cmd_score(args):
    manifest = load_manifest(args.manifest)
    reference_field = eval_extraction.VOICING_REFERENCE_FIELDS[args.voicing_reference]
    report = score_split(manifest, args.golden, args.candidate, args.split, reference_field)
    aggregate = report["aggregate"]
    coverage = report["coverage"]
    print(
        f"{args.split}: chord recall={eval_extraction._fmt_pct(aggregate['chord_recall'])}, "
        f"precision={eval_extraction._fmt_pct(aggregate['chord_precision'])}, "
        f"voicing recovery={eval_extraction._fmt_pct(aggregate['voicing_recovery'])}, "
        f"text recovery={eval_extraction._fmt_pct(aggregate['text_recovery'])}"
    )
    print(
        f"coverage: {coverage['candidate_songs_found']}/{coverage['truth_songs']} songs; "
        f"missing={len(coverage['missing_songs'])}, "
        f"extra={len(coverage['extra_candidate_songs'])}"
    )
    if args.report_json:
        args.report_json.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print(f"report written to {args.report_json}")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create", help="freeze explicit reviewed song splits")
    create.add_argument("--golden", type=Path, required=True)
    create.add_argument("--development", action="append", required=True, metavar="SONG_JSON")
    create.add_argument("--held-out", action="append", required=True, metavar="SONG_JSON")
    create.add_argument(
        "--label-type",
        choices=(GROUND_TRUTH_LABEL, "unreviewed", "model_generated"),
        required=True,
    )
    create.add_argument("--review-provenance", required=True)
    create.add_argument("--output", type=Path, required=True)
    create.set_defaults(fn=cmd_create)

    score = commands.add_parser("score", help="verify and score one frozen split")
    score.add_argument("--manifest", type=Path, required=True)
    score.add_argument("--golden", type=Path, required=True)
    score.add_argument("--candidate", type=Path, required=True)
    score.add_argument("--split", choices=SPLITS, required=True)
    score.add_argument(
        "--voicing-reference",
        choices=sorted(eval_extraction.VOICING_REFERENCE_FIELDS),
        default="editorial",
    )
    score.add_argument("--report-json", type=Path)
    score.set_defaults(fn=cmd_score)
    args = parser.parse_args()
    raise SystemExit(args.fn(args))


if __name__ == "__main__":
    main()
