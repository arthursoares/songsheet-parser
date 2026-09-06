#!/usr/bin/env python3
"""Build a read-only catalog and compare curated cross-album arrangements.

The manifest is the only authority for composition identity. Normalized titles
and composers are emitted as review suggestions and never assign a work.
"""

import argparse
import hashlib
import html
import itertools
import json
import re
import unicodedata
from pathlib import Path

from chord_identity import strict_harm_key
from eval_extraction import aligned_pairs, flat_entries
from harmony import note_to_pc, parse_key_name, parse_symbol, roman, voicing_to_pitches
from review_state import REVIEW_FIELDS, review_gaps, review_summary
from songsheet_io import publish_bytes, validate_document, write_json_artifact

SCHEMA_VERSION = 1
VOICING_FIELDS = ("voicing", "voicing_printed")


def _fraction(numerator, denominator):
    return round(numerator / denominator, 4) if denominator else None


def _normalized(value):
    value = unicodedata.normalize("NFKD", str(value or "")).casefold()
    value = "".join(character for character in value if not unicodedata.combining(character))
    return re.sub(r"[^a-z0-9]+", " ", value).strip()


def _candidate_key(arrangement):
    title = _normalized(arrangement["observed_song"]["title"])
    composers = tuple(sorted(_normalized(c) for c in arrangement["observed_song"]["composers"]))
    return title, composers


def _validate_manifest(manifest):
    if not isinstance(manifest, dict):
        raise ValueError("work manifest must be an object")
    if manifest.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(f"manifest schema_version must be {SCHEMA_VERSION}")
    works = manifest.get("works")
    assignments = manifest.get("assignments")
    if not isinstance(works, dict) or not isinstance(assignments, dict):
        raise ValueError("manifest needs object-valued works and assignments")
    for work_id, work in works.items():
        if not work_id or not isinstance(work, dict) or not work.get("title"):
            raise ValueError("each work needs a non-empty id and title")
    for arrangement_id, assignment in assignments.items():
        if not isinstance(assignment, dict) or assignment.get("work_id") not in works:
            raise ValueError(f"assignment {arrangement_id!r} references an unknown work_id")
        confirmed = assignment.get("confirmed_key")
        if confirmed is not None:
            if not isinstance(confirmed, dict):
                raise ValueError(
                    f"assignment {arrangement_id!r} confirmed_key needs tonic and evidence"
                )
            tonic = confirmed.get("tonic")
            if not isinstance(tonic, str) or tonic != tonic.strip() or note_to_pc(tonic) is None:
                raise ValueError(f"assignment {arrangement_id!r} has an invalid tonic")
            evidence = confirmed.get("evidence")
            if not isinstance(evidence, str) or not evidence.strip():
                raise ValueError(
                    f"assignment {arrangement_id!r} confirmed_key needs non-blank evidence"
                )
            if confirmed.get("mode", "major") not in ("major", "minor"):
                raise ValueError(f"assignment {arrangement_id!r} has an invalid key mode")
    return manifest


def load_manifest(path):
    """Load and validate the small curated work-assignment manifest."""
    manifest = json.loads(Path(path).read_text(encoding="utf-8"))
    return _validate_manifest(manifest)


def _song_records(path, corpus_root, document):
    relative = path.relative_to(corpus_root).as_posix()
    songs = document.get("songs", [])
    for index, song in enumerate(songs):
        arrangement_id = relative if len(songs) == 1 else f"{relative}#song-{index + 1}"
        yield arrangement_id, song


def _coverage(song, document=None):
    entries = [e for e in flat_entries(song) if e.get("chord") != "%"]
    editorial = sum(e.get("voicing") is not None for e in entries)
    printed = sum(e.get("voicing_printed") is not None for e in entries)
    meta = (document or {}).get("_meta", {})
    diagrams = meta.get("diagram_evidence", {}) if isinstance(meta, dict) else {}
    diagnostics = meta.get("diagram_diagnostics", {}) if isinstance(meta, dict) else {}
    diagnostic_pages = {
        wrapper["record"]["page"]
        for wrapper in diagnostics.values()
        if wrapper["record"]["page"] in song.get("pages", [])
    }
    return {
        "non_percent_events": len(entries),
        "editorial_voicing_events": editorial,
        "editorial_voicing_fraction": _fraction(editorial, len(entries)),
        "printed_voicing_events": printed,
        "printed_voicing_fraction": _fraction(printed, len(entries)),
        "tracked_diagram_events": sum(e.get("observation_id") in diagrams for e in entries),
        "diagram_diagnostic_pages": len(diagnostic_pages),
    }


def build_catalog(corpus_root, manifest, include_unreviewed=False, *, voicing_field="voicing"):
    """Return a deterministic catalog without changing the source corpus."""
    manifest = _validate_manifest(manifest)
    corpus_root = Path(corpus_root)
    arrangements = []
    excluded = {}
    invalid_files = []
    valid_files = 0
    assignments = manifest["assignments"]

    for path in sorted(corpus_root.rglob("*.json")):
        try:
            raw = path.read_bytes()
            document = json.loads(raw)
            validate_document(document)
        except (OSError, ValueError) as exc:
            invalid_files.append(
                {"source_path": path.relative_to(corpus_root).as_posix(), "error": str(exc)}
            )
            continue
        valid_files += 1
        status = document.get("document", {}).get("status") or "pending"
        fields = review_summary(document)["fields"]
        gaps = review_gaps(
            document,
            ("structure", "chords", voicing_field),
            require_explicit=("voicing_printed",) if voicing_field == "voicing_printed" else (),
        )
        for arrangement_id, song in _song_records(path, corpus_root, document):
            eligible = status == "done" and not gaps
            included = eligible or include_unreviewed
            if not included:
                reason = status if status != "done" else "done_with_incomplete_review"
                excluded[reason] = excluded.get(reason, 0) + 1
            assignment = assignments.get(arrangement_id, {})
            manifest_key = assignment.get("confirmed_key")
            field_key = None
            if fields["key"]["status"] == "verified":
                tonic, mode = parse_key_name(song["key"])
                field_key = {
                    "tonic": tonic,
                    "mode": mode,
                    "evidence": fields["key"]["evidence"],
                    "reviewer": fields["key"]["reviewer"],
                    "source": "current_field_review",
                }
            conflict = bool(
                manifest_key
                and field_key
                and (
                    note_to_pc(manifest_key["tonic"]) != note_to_pc(field_key["tonic"])
                    or manifest_key.get("mode", "major") != field_key["mode"]
                )
            )
            confirmed_key = None if conflict else (manifest_key or field_key)
            album = document.get("document", {})
            arrangements.append(
                {
                    "arrangement_id": arrangement_id,
                    "source_path": arrangement_id.split("#song-")[0],
                    "revision_sha256": hashlib.sha256(raw).hexdigest(),
                    "work_id": assignment.get("work_id"),
                    "document_status": status,
                    "included": included,
                    "provisional": included and not eligible,
                    "field_review": fields,
                    "review_gaps": list(gaps),
                    "observed_album": {
                        "catalog_path": path.parent.relative_to(corpus_root).as_posix(),
                        "title": album.get("title"),
                        "source_pdf": album.get("source_pdf"),
                        "page_count": album.get("page_count"),
                        "release_date": None,
                        "recording_date": None,
                    },
                    "observed_song": {
                        "title": song.get("title"),
                        "composers": song.get("composers", []),
                        "pages": song.get("pages", []),
                    },
                    "keys": {
                        "stored": song.get("key"),
                        "stored_provenance": "document field; not treated as confirmed",
                        "confirmed": confirmed_key,
                        "manifest_confirmation": manifest_key,
                        "field_confirmation": field_key,
                        "confirmation_conflict": conflict,
                    },
                    "coverage": _coverage(song, document),
                }
            )

    known_ids = {a["arrangement_id"] for a in arrangements}
    invalid_paths = {item["source_path"] for item in invalid_files}
    invalid_assignments = sorted(
        key for key in set(assignments) - known_ids if key.split("#song-", 1)[0] in invalid_paths
    )
    unknown_assignments = sorted(set(assignments) - known_ids - set(invalid_assignments))
    if unknown_assignments:
        raise ValueError(f"manifest assignments not found in corpus: {unknown_assignments}")

    candidate_buckets = {}
    for arrangement in arrangements:
        candidate_buckets.setdefault(_candidate_key(arrangement), []).append(arrangement)
    suggestions = []
    for (title, composers), group in sorted(candidate_buckets.items()):
        assigned = {a["work_id"] for a in group if a["work_id"]}
        if len(group) > 1 and (any(a["work_id"] is None for a in group) or len(assigned) > 1):
            suggestions.append(
                {
                    "normalized_title": title,
                    "normalized_composers": list(composers),
                    "arrangement_ids": [a["arrangement_id"] for a in group],
                    "note": "candidate only; curate assignments in the manifest",
                }
            )

    works = []
    for work_id, work in sorted(manifest["works"].items()):
        work_arrangements = [a["arrangement_id"] for a in arrangements if a["work_id"] == work_id]
        works.append(
            {
                "work_id": work_id,
                "title": work["title"],
                "composers": work.get("composers", []),
                "arrangement_ids": work_arrangements,
            }
        )

    included = [a for a in arrangements if a["included"]]
    included_events = sum(a["coverage"]["non_percent_events"] for a in included)
    included_printed = sum(a["coverage"]["printed_voicing_events"] for a in included)
    return {
        "schema_version": SCHEMA_VERSION,
        "policy": {
            "default_eligibility": "document.status == done with no incomplete explicit field checks",
            "printed_evidence_policy": "explicit current printed-diagram review required",
            "include_unreviewed": include_unreviewed,
            "unreviewed_label": "provisional",
            "identity_authority": "curated manifest assignments",
        },
        "summary": {
            "source_files_attempted": valid_files + len(invalid_files),
            "source_files_valid": valid_files,
            "source_files_invalid": len(invalid_files),
            "assigned_invalid_sources": len(invalid_assignments),
            "arrangements_discovered": len(arrangements),
            "arrangements_included": len(included),
            "arrangements_excluded": len(arrangements) - len(included),
            "excluded_by_status": dict(sorted(excluded.items())),
            "included_assigned": sum(a["work_id"] is not None for a in included),
            "included_unassigned": sum(a["work_id"] is None for a in included),
            "included_provisional": sum(a["provisional"] for a in included),
            "included_confirmed_keys": sum(a["keys"]["confirmed"] is not None for a in included),
            "included_non_percent_events": included_events,
            "included_printed_voicing_events": included_printed,
            "included_printed_voicing_fraction": _fraction(included_printed, included_events),
            "invalid_files": len(invalid_files),
        },
        "works": works,
        "arrangements": arrangements,
        "candidate_groups": suggestions,
        "invalid_files": invalid_files,
        "invalid_assignments": invalid_assignments,
    }


def _load_catalog_song(corpus_root, arrangement):
    document = json.loads(
        (Path(corpus_root) / arrangement["source_path"]).read_text(encoding="utf-8")
    )
    marker = arrangement["arrangement_id"].rsplit("#song-", 1)
    index = int(marker[1]) - 1 if len(marker) == 2 else 0
    return document["songs"][index]


def _event_view(entry, index):
    return {
        "event_index": index,
        "section_index": entry["si"],
        "bar_index": entry["bi"],
        "chord": entry.get("chord"),
    }


def _roman_for(entry, confirmed_key):
    if not confirmed_key or strict_harm_key(entry.get("chord"))[0] != "h":
        return None
    parsed = parse_symbol(entry.get("chord"))
    if parsed is None:
        return None
    return roman(
        parsed["root"],
        parsed["quality"],
        confirmed_key["tonic"],
        confirmed_key.get("mode", "major"),
        parsed["bass"],
    )


def _roman_alignment(entries, confirmed_key):
    events = []
    for event_index, entry in enumerate(entries):
        numeral = _roman_for(entry, confirmed_key)
        if numeral is not None:
            events.append({"entry": entry, "event_index": event_index, "roman": numeral})
    return events


def _roman_unaligned_spans(left_events, right_events, pairs):
    spans = []
    previous_left = previous_right = -1
    for left_index, right_index in [*pairs, (len(left_events), len(right_events))]:
        left_start, right_start = previous_left + 1, previous_right + 1
        if left_start < left_index or right_start < right_index:
            spans.append(
                {
                    "left": [
                        {
                            **_event_view(event["entry"], event["event_index"]),
                            "roman": event["roman"],
                        }
                        for event in left_events[left_start:left_index]
                    ],
                    "right": [
                        {
                            **_event_view(event["entry"], event["event_index"]),
                            "roman": event["roman"],
                        }
                        for event in right_events[right_start:right_index]
                    ],
                }
            )
        previous_left, previous_right = left_index, right_index
    return spans


def _unaligned_spans(left_entries, right_entries, pairs):
    spans = []
    previous_left = previous_right = -1
    for left_index, right_index in [*pairs, (len(left_entries), len(right_entries))]:
        left_start, right_start = previous_left + 1, previous_right + 1
        if left_start < left_index or right_start < right_index:
            spans.append(
                {
                    "left": [
                        _event_view(e, i)
                        for i, e in enumerate(left_entries[left_start:left_index], left_start)
                    ],
                    "right": [
                        _event_view(e, i)
                        for i, e in enumerate(right_entries[right_start:right_index], right_start)
                    ],
                }
            )
        previous_left, previous_right = left_index, right_index
    return spans


def compare_arrangements(corpus_root, left, right, voicing_field="voicing"):
    """Align harmonically equal chords and report evidence differences."""
    if voicing_field not in VOICING_FIELDS:
        raise ValueError(f"voicing_field must be one of {VOICING_FIELDS}")
    if not left.get("work_id") or left.get("work_id") != right.get("work_id"):
        raise ValueError("comparison requires two manifest-assigned arrangements of one work")
    left_song = _load_catalog_song(corpus_root, left)
    right_song = _load_catalog_song(corpus_root, right)
    left_entries = [e for e in flat_entries(left_song) if e.get("chord") != "%"]
    right_entries = [e for e in flat_entries(right_song) if e.get("chord") != "%"]
    pairs = aligned_pairs(
        [e.get("chord") for e in left_entries], [e.get("chord") for e in right_entries]
    )
    aligned = []
    counts = {
        "harmonically_aligned": len(pairs),
        "exact_chord_symbols": 0,
        "equivalent_chord_spellings": 0,
        "voicing_matches": 0,
        "voicing_differences": 0,
        "voicing_missing_left": 0,
        "voicing_missing_right": 0,
        "physical_bass_matches": 0,
        "physical_bass_differences": 0,
        "physical_bass_unknown": 0,
    }
    left_key = left["keys"]["confirmed"]
    right_key = right["keys"]["confirmed"]
    keys_confirmed = left_key is not None and right_key is not None
    left_roman_events = _roman_alignment(left_entries, left_key) if keys_confirmed else []
    right_roman_events = _roman_alignment(right_entries, right_key) if keys_confirmed else []
    roman_enabled = bool(keys_confirmed and left_roman_events and right_roman_events)

    for left_index, right_index in pairs:
        le, re_ = left_entries[left_index], right_entries[right_index]
        exact = le.get("chord") == re_.get("chord")
        counts["exact_chord_symbols" if exact else "equivalent_chord_spellings"] += 1
        lv, rv = le.get(voicing_field), re_.get(voicing_field)
        if lv is None:
            counts["voicing_missing_left"] += 1
        if rv is None:
            counts["voicing_missing_right"] += 1
        if lv is not None and rv is not None:
            counts["voicing_matches" if lv == rv else "voicing_differences"] += 1
        lb = voicing_to_pitches(lv)["bass_pc"] if lv is not None else None
        rb = voicing_to_pitches(rv)["bass_pc"] if rv is not None else None
        if lb is None or rb is None:
            counts["physical_bass_unknown"] += 1
        else:
            counts["physical_bass_matches" if lb == rb else "physical_bass_differences"] += 1
        left_roman = _roman_for(le, left_key) if roman_enabled else None
        right_roman = _roman_for(re_, right_key) if roman_enabled else None
        aligned.append(
            {
                "left": {**_event_view(le, left_index), "voicing": lv, "physical_bass_pc": lb},
                "right": {**_event_view(re_, right_index), "voicing": rv, "physical_bass_pc": rb},
                "chord_relation": "exact" if exact else "harmonically_equivalent_spelling",
                "voicing_relation": (
                    "missing"
                    if lv is None or rv is None
                    else ("exact" if lv == rv else "different")
                ),
                "physical_bass_relation": (
                    "unknown"
                    if lb is None or rb is None
                    else ("exact" if lb == rb else "different")
                ),
                "roman": (
                    {"left": left_roman, "right": right_roman, "match": left_roman == right_roman}
                    if roman_enabled
                    else None
                ),
            }
        )

    spans = _unaligned_spans(left_entries, right_entries, pairs)
    roman_pairs = (
        aligned_pairs(
            [event["roman"] for event in left_roman_events],
            [event["roman"] for event in right_roman_events],
        )
        if roman_enabled
        else []
    )
    roman_spans = (
        _roman_unaligned_spans(left_roman_events, right_roman_events, roman_pairs)
        if roman_enabled
        else []
    )
    roman_matches = [
        {
            "left": {
                **_event_view(
                    left_roman_events[left_index]["entry"],
                    left_roman_events[left_index]["event_index"],
                ),
                "roman": left_roman_events[left_index]["roman"],
            },
            "right": {
                **_event_view(
                    right_roman_events[right_index]["entry"],
                    right_roman_events[right_index]["event_index"],
                ),
                "roman": right_roman_events[right_index]["roman"],
            },
        }
        for left_index, right_index in roman_pairs
    ]
    mismatches = [
        item
        for item in aligned
        if item["chord_relation"] != "exact"
        or item["voicing_relation"] != "exact"
        or item["physical_bass_relation"] != "exact"
    ]
    return {
        "work_id": left["work_id"],
        "left_arrangement_id": left["arrangement_id"],
        "right_arrangement_id": right["arrangement_id"],
        "voicing_field": voicing_field,
        "provisional": left["provisional"] or right["provisional"],
        "sources": {
            "left": {"path": left["source_path"], "revision_sha256": left["revision_sha256"]},
            "right": {"path": right["source_path"], "revision_sha256": right["revision_sha256"]},
        },
        "document_status": {"left": left["document_status"], "right": right["document_status"]},
        "pages": {"left": left["observed_song"]["pages"], "right": right["observed_song"]["pages"]},
        "key_evidence": {"left": left["keys"], "right": right["keys"]},
        "roman_comparison": {
            "enabled": roman_enabled,
            "reason": (
                "both arrangements have current explicit key confirmations"
                if roman_enabled
                else (
                    "disabled: confirmed keys produced no comparable Roman events"
                    if keys_confirmed
                    else "disabled: both arrangements need explicit key confirmations"
                )
            ),
            "left_events": len(left_roman_events),
            "right_events": len(right_roman_events),
            "uninterpreted_left": sum(
                strict_harm_key(e.get("chord"))[0] != "h" for e in left_entries
            ),
            "uninterpreted_right": sum(
                strict_harm_key(e.get("chord"))[0] != "h" for e in right_entries
            ),
            "aligned_events": len(roman_pairs),
            "aligned_event_pairs": roman_matches,
            "unaligned_spans": roman_spans,
        },
        "event_counts": {"left": len(left_entries), "right": len(right_entries)},
        "printed_coverage": {
            "left": left["coverage"]["printed_voicing_fraction"],
            "right": right["coverage"]["printed_voicing_fraction"],
        },
        "field_coverage": {"left": left["coverage"], "right": right["coverage"]},
        "counts": {**counts, "unaligned_spans": len(spans)},
        "aligned_events": aligned,
        "aligned_mismatches": mismatches,
        "unaligned_spans": spans,
    }


def _review_queue(catalog, comparisons):
    disagreements = {}
    for comparison in comparisons:
        points = (
            comparison["counts"]["unaligned_spans"] * 10
            + comparison["counts"]["voicing_differences"]
            + comparison["counts"]["physical_bass_differences"]
        )
        for arrangement_id in (
            comparison["left_arrangement_id"],
            comparison["right_arrangement_id"],
        ):
            disagreements[arrangement_id] = disagreements.get(arrangement_id, 0) + points
    queue = []
    for arrangement in catalog["arrangements"]:
        reasons = []
        points = disagreements.get(arrangement["arrangement_id"], 0)
        if arrangement["work_id"] is None:
            reasons.append("missing curated work assignment")
            points += 100
        if arrangement["document_status"] != "done":
            reasons.append(f"document status is {arrangement['document_status']}")
            points += 40
        if arrangement.get("review_gaps"):
            reasons.append("field review needed: " + ", ".join(arrangement["review_gaps"]))
            points += 10 * len(arrangement["review_gaps"])
        if arrangement["keys"].get("confirmation_conflict"):
            reasons.append("manifest and field-review key confirmations disagree")
            points += 40
        if arrangement["keys"]["confirmed"] is None:
            reasons.append("no usable explicit key confirmation")
            points += 20
        coverage = arrangement["coverage"]
        missing_printed = coverage["non_percent_events"] - coverage["printed_voicing_events"]
        if missing_printed:
            reasons.append(f"{missing_printed} events lack printed-voicing evidence")
            points += min(missing_printed, 20)
        if (
            coverage["diagram_diagnostic_pages"]
            and arrangement["field_review"]["voicing_printed"]["status"] != "verified"
        ):
            reasons.append(
                f"{coverage['diagram_diagnostic_pages']} source pages have diagram diagnostics"
            )
            points += 15 * coverage["diagram_diagnostic_pages"]
        if disagreements.get(arrangement["arrangement_id"]):
            reasons.append("same-work comparison has alignment or voicing disagreements")
        if reasons:
            queue.append(
                {
                    "arrangement_id": arrangement["arrangement_id"],
                    "priority_points": points,
                    "reasons": reasons,
                }
            )
    return sorted(queue, key=lambda item: (-item["priority_points"], item["arrangement_id"]))


def build_report(corpus_root, manifest, include_unreviewed=False, voicing_field="voicing"):
    catalog = build_catalog(corpus_root, manifest, include_unreviewed, voicing_field=voicing_field)
    included = [a for a in catalog["arrangements"] if a["included"] and a["work_id"]]
    comparisons = []
    by_work = {}
    for arrangement in included:
        by_work.setdefault(arrangement["work_id"], []).append(arrangement)
    for work_group in by_work.values():
        for left, right in itertools.combinations(work_group, 2):
            comparisons.append(compare_arrangements(corpus_root, left, right, voicing_field))
    scripts = Path(__file__).resolve().parent
    report = {
        "catalog": catalog,
        "comparisons": comparisons,
        "analysis": {
            "alignment": "maximum ordered chord matching (LCS), not musical-form alignment",
            "voicing_field": voicing_field,
            "bass_assumption": "standard six-string guitar tuning",
            "implementation_sha256": {
                name: hashlib.sha256((scripts / name).read_bytes()).hexdigest()
                for name in (
                    "corpus_research.py",
                    "eval_extraction.py",
                    "chord_identity.py",
                    "harmony.py",
                    "review_state.py",
                )
            },
        },
    }
    report["review_queue"] = _review_queue(catalog, comparisons)
    report["catalog"]["summary"]["same_work_comparisons"] = len(comparisons)
    return report


def render_html(report):
    """Render a standalone report; every value from corpus/manifest is escaped."""

    def esc(value):
        return html.escape(str(value), quote=True)

    summary = report["catalog"]["summary"]
    work_titles = {work["work_id"]: work["title"] for work in report["catalog"]["works"]}
    album_titles = {
        a["arrangement_id"]: a["observed_album"]["title"] for a in report["catalog"]["arrangements"]
    }
    rows = []
    for arrangement in report["catalog"]["arrangements"]:
        confirmed_key = arrangement["keys"]["confirmed"]
        confirmed_label = (
            f"{confirmed_key['tonic']} {confirmed_key.get('mode', 'major')}; "
            f"evidence: {confirmed_key['evidence']}"
            if confirmed_key
            else "not confirmed"
        )
        rows.append(
            "<tr>"
            f"<td>{esc(arrangement['arrangement_id'])}</td>"
            f"<td>{esc(arrangement['observed_album']['title'])}</td>"
            f"<td>{esc(arrangement['observed_song']['title'])}</td>"
            f"<td>{esc(arrangement['work_id'] or 'unassigned')}</td>"
            f"<td>{esc(arrangement['document_status'])}</td>"
            f"<td>{sum(value['status'] == 'verified' for value in arrangement['field_review'].values())}/{len(REVIEW_FIELDS)}</td>"
            f"<td>{esc('provisional' if arrangement['provisional'] else ('yes' if arrangement['included'] else 'excluded'))}</td>"
            f"<td>{esc(arrangement['keys']['stored'])} (confirmation shown separately)</td>"
            f"<td>{esc(confirmed_label)}</td>"
            f"<td>{esc(arrangement['coverage']['editorial_voicing_events'])}/"
            f"{esc(arrangement['coverage']['non_percent_events'])}</td>"
            f"<td>{esc(arrangement['coverage']['printed_voicing_events'])}/"
            f"{esc(arrangement['coverage']['non_percent_events'])}</td>"
            f"<td><code>{esc(arrangement['revision_sha256'])}</code></td>"
            "</tr>"
        )
    comparison_sections = []
    for comparison in report["comparisons"]:
        counts = comparison["counts"]
        absolute_gaps = counts["unaligned_spans"]
        roman_result = comparison["roman_comparison"]
        roman_gaps = len(roman_result["unaligned_spans"])
        roman_summary = (
            f"Confirmed-key Roman alignment: {roman_result['aligned_events']} match"
            f"{'es' if roman_result['aligned_events'] != 1 else ''}; {roman_gaps} gap span"
            f"{'s' if roman_gaps != 1 else ''}."
            if roman_result["enabled"]
            else f"Confirmed-key Roman alignment: {roman_result['reason']}."
        )
        comparison_sections.append(
            f"<section><h2>{esc(work_titles[comparison['work_id']])}</h2>"
            f"<p>{esc(album_titles[comparison['left_arrangement_id']])} ↔ "
            f"{esc(album_titles[comparison['right_arrangement_id']])}</p>"
            f"<p>{'PROVISIONAL · ' if comparison['provisional'] else ''}"
            f"{'Printed diagram readings' if comparison['voicing_field'] == 'voicing_printed' else 'Editorial voicings'}; "
            f"voicing differences: {esc(counts['voicing_differences'])}; "
            f"physical bass differences: {esc(counts['physical_bass_differences'])}.</p>"
            f"<p>Absolute harmonic alignment: {esc(counts['harmonically_aligned'])} match"
            f"{'es' if counts['harmonically_aligned'] != 1 else ''}; {esc(absolute_gaps)} gap span"
            f"{'s' if absolute_gaps != 1 else ''}.</p>"
            f"<p>{esc(roman_summary)}</p>"
            f"<p>Tracked diagram proposals: {comparison['field_coverage']['left']['tracked_diagram_events']} left, "
            f"{comparison['field_coverage']['right']['tracked_diagram_events']} right. "
            f"Pages with diagram diagnostics: {comparison['field_coverage']['left']['diagram_diagnostic_pages']} left, "
            f"{comparison['field_coverage']['right']['diagram_diagnostic_pages']} right.</p>"
            f"<p>Uninterpreted chord symbols excluded from Roman analysis: "
            f"{roman_result['uninterpreted_left']} left, {roman_result['uninterpreted_right']} right.</p>"
            f"<details><summary>Absolute harmonic matches</summary><pre>"
            f"{esc(json.dumps(comparison['aligned_events'], ensure_ascii=False, indent=2))}"
            "</pre></details>"
            f"<details><summary>Absolute harmonic gaps</summary><pre>"
            f"{esc(json.dumps(comparison['unaligned_spans'], ensure_ascii=False, indent=2))}"
            "</pre></details>"
            f"<details><summary>Confirmed-key Roman matches and gaps</summary><pre>"
            f"{esc(json.dumps({'matches': roman_result['aligned_event_pairs'], 'gaps': roman_result['unaligned_spans']}, ensure_ascii=False, indent=2))}"
            "</pre></details></section>"
        )
    queue_rows = "".join(
        "<tr>"
        f"<td>{esc(item['priority_points'])}</td><td>{esc(item['arrangement_id'])}</td>"
        f"<td>{esc('; '.join(item['reasons']))}</td></tr>"
        for item in report["review_queue"]
    )
    candidate_rows = "".join(
        "<tr>"
        f"<td>{esc(item['normalized_title'])}</td>"
        f"<td>{esc(', '.join(item['normalized_composers']))}</td>"
        f"<td>{esc(', '.join(item['arrangement_ids']))}</td>"
        f"<td>{esc(item['note'])}</td></tr>"
        for item in report["catalog"]["candidate_groups"]
    )
    invalid_rows = "".join(
        f"<tr><td>{esc(item['source_path'])}</td><td>{esc(item['error'])}</td></tr>"
        for item in report["catalog"]["invalid_files"]
    )
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Cross-album corpus research</title><style>
body{{font:15px/1.45 system-ui,sans-serif;max-width:1180px;margin:auto;padding:2rem;color:#222;overflow-wrap:anywhere}}
table{{border-collapse:collapse;width:100%;table-layout:fixed;margin:1rem 0}}th,td{{border:1px solid #bbb;padding:.45rem;text-align:left;vertical-align:top}}
th{{background:#eee}}code,pre{{font:12px ui-monospace,monospace}}pre{{white-space:pre-wrap;overflow-wrap:anywhere}}
.notice{{padding:.7rem;background:#fff4ce;border-left:4px solid #c48b00}}</style></head><body>
<h1>Cross-album corpus research</h1>
<p class="notice">This report describes songbook documents and curated work assignments. It makes no recording or release-date claims. Priority points rank missing evidence and disagreements; they are not probabilities.</p>
<p>Sources attempted {esc(summary["source_files_attempted"])}: {esc(summary["source_files_valid"])} valid, {esc(summary["source_files_invalid"])} invalid.</p>
<p>Included {esc(summary["arrangements_included"])} of {esc(summary["arrangements_discovered"])} arrangements; excluded {esc(summary["arrangements_excluded"])}; comparisons {esc(summary["same_work_comparisons"])}.</p>
<p>Included arrangements with incomplete review: {esc(summary["included_provisional"])}. These results remain provisional.</p>
{"".join(comparison_sections) or "<p>No eligible assigned same-work pair to compare.</p>"}
<details><summary>Analysis method and implementation fingerprints</summary><pre>{esc(json.dumps(report.get("analysis", {}), ensure_ascii=False, indent=2))}</pre></details>
{"<h2>Invalid source files</h2><table><thead><tr><th>Source path</th><th>Error</th></tr></thead><tbody>" + invalid_rows + "</tbody></table>" if invalid_rows else "<p>No invalid source files.</p>"}
<details><summary>Catalog and coverage</summary><table><thead><tr><th>Arrangement/source</th><th>Observed album</th><th>Observed song</th><th>Work</th><th>Status</th><th>Current field checks</th><th>Included</th><th>Stored key</th><th>Confirmed key evidence</th><th>Editorial voicings</th><th>Printed voicings</th><th>Revision SHA-256</th></tr></thead><tbody>{"".join(rows)}</tbody></table></details>
<details><summary>Candidate groups</summary><p>Normalization suggestions require manifest review and do not merge works.</p><table><thead><tr><th>Normalized title</th><th>Normalized composers</th><th>Arrangements</th><th>Identity status</th></tr></thead><tbody>{candidate_rows}</tbody></table></details>
<details><summary>Review queue</summary><table><thead><tr><th>Points</th><th>Arrangement</th><th>Evidence needed</th></tr></thead><tbody>{queue_rows}</tbody></table></details>
</body></html>"""


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--corpus", type=Path, required=True, help="root containing album/song JSON"
    )
    parser.add_argument("--manifest", type=Path, required=True, help="curated work assignments")
    parser.add_argument("--json", type=Path, required=True, help="catalog and comparison output")
    parser.add_argument("--html", type=Path, required=True, help="standalone review report")
    parser.add_argument(
        "--include-unreviewed",
        action="store_true",
        help="include non-done documents and label their results provisional",
    )
    parser.add_argument(
        "--voicing-field",
        choices=VOICING_FIELDS,
        default="voicing",
        help="compare editorial voicing or literal printed evidence",
    )
    args = parser.parse_args(argv)
    for output in (args.json, args.html):
        if (
            output.resolve().is_relative_to(args.corpus.resolve())
            or output.resolve() == args.manifest.resolve()
        ):
            raise ValueError("research outputs must be outside the source corpus and work manifest")
    if args.json.resolve() == args.html.resolve():
        raise ValueError("JSON and HTML outputs must have different paths")
    manifest = load_manifest(args.manifest)
    report = build_report(args.corpus, manifest, args.include_unreviewed, args.voicing_field)
    write_json_artifact(args.json, report, overwrite=True)
    publish_bytes(args.html, render_html(report).encode("utf-8"), overwrite=True)
    print(
        f"wrote {args.json} and {args.html}: "
        f"{report['catalog']['summary']['arrangements_included']} arrangements, "
        f"{len(report['comparisons'])} comparisons"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
