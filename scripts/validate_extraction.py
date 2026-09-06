#!/usr/bin/env python3
"""Validate songsheet extraction across a whole PDF.

Pipeline per PDF:
  1. Render each page to PNG (pymupdf), cached on disk.
  2. Parse each page to the chord-anchored model (codex vision), cached as
     per-page JSON so the expensive step is resumable.
  3. Assemble per-page results into one document (stitch songs across page
     breaks: a page that opens with the same title as the previous page's last
     song is treated as a continuation and its bars are appended).
  4. Schema-validate the assembled document.
  5. Run structural heuristics and print a per-PDF report.

Usage:
    python validate_extraction.py "data/joao-gilberto/pdf/1 - Chega de Saudade.pdf"
    python validate_extraction.py data/joao-gilberto/pdf/*.pdf --workdir /tmp/ssv
    python validate_extraction.py PDF --report-json /tmp/report.json

Page renders and per-page JSON live under <workdir>/<pdf-stem>/ and are reused
only while content/settings fingerprints match. --force creates a fresh extraction.
"""

import argparse
import copy
import json
import sys
import unicodedata
from pathlib import Path

import fitz  # pymupdf

SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parent
sys.path.insert(0, str(SCRIPTS))

import diagram_evidence  # noqa: E402
import parse_songsheet  # noqa: E402
from extraction_provenance import (  # noqa: E402
    attach_observations,
    file_sha256,
    has_observations,
    seal_page_sources,
    validate_observations,
)
from songsheet_io import publish_bytes, write_json_artifact  # noqa: E402
from songsheet_version import stamp, version_error  # noqa: E402

SCHEMA_PATH = ROOT / "schemas" / "songsheet.schema.json"
DEFAULT_WORKDIR = Path("/tmp/ssv")


def render_pages(pdf_path: Path, out_dir: Path, dpi: int, force: bool) -> list[Path]:
    """Render each PDF page to a PNG, cached. Return ordered list of PNG paths."""
    out_dir.mkdir(parents=True, exist_ok=True)
    settings = {
        "pdf": {"name": pdf_path.name, "sha256": file_sha256(pdf_path)},
        "dpi": dpi,
        "renderer": {
            "pymupdf": fitz.VersionBind,
            "implementation_sha256": file_sha256(Path(__file__)),
        },
    }
    manifest_path = out_dir / "_render-manifest.json"
    try:
        previous = json.loads(manifest_path.read_text())
    except (OSError, ValueError):
        previous = {}
    if not isinstance(previous, dict):
        previous = {}
    reusable = not force and previous.get("settings") == settings
    old_pages = previous.get("pages", {}) if reusable else {}
    if not isinstance(old_pages, dict):
        old_pages = {}
    pages, records = [], {}
    with fitz.open(pdf_path) as doc:
        for i in range(doc.page_count):
            png = out_dir / f"page-{i + 1:03d}.png"
            if not (png.exists() and old_pages.get(png.name) == file_sha256(png)):
                publish_bytes(png, doc[i].get_pixmap(dpi=dpi).tobytes("png"), overwrite=True)
            pages.append(png)
            records[png.name] = file_sha256(png)
    write_json_artifact(manifest_path, {"settings": settings, "pages": records}, overwrite=True)
    return pages


def parse_page(
    png: Path, out_dir: Path, force: bool, *, provider: str = "codex", model: str = None
) -> dict:
    """Reuse only matching, intact page results; preserve every new extraction snapshot."""
    return parse_songsheet.parse_cached(png, out_dir, force=force, provider=provider, model=model)


def _norm_title(title: str) -> str:
    nfkd = unicodedata.normalize("NFKD", title or "")
    return nfkd.encode("ascii", "ignore").decode("ascii").lower().strip()


def assemble_document(
    pdf_path: Path, page_results: list[dict], *, page_numbers: list[int] | None = None
) -> dict:
    """Stitch per-page parse results into one document, merging songs that
    continue across page breaks (same title as previous page's last song)."""
    songs: list[dict] = []
    page_numbers = (
        page_numbers if page_numbers is not None else list(range(1, len(page_results) + 1))
    )
    if (
        len(page_numbers) != len(page_results)
        or len(set(page_numbers)) != len(page_numbers)
        or any(type(p) is not int or p < 1 for p in page_numbers)
    ):
        raise ValueError("page_numbers must give one distinct positive page number per result")
    pdf_source = {
        "name": pdf_path.name,
        "sha256": file_sha256(pdf_path) if pdf_path.is_file() else None,
    }
    meta = {
        "source_pdf": pdf_source,
        "extraction_sources": {},
        "observations": {},
        "page_sources": {},
    }
    for page_idx, original in zip(page_numbers, page_results):
        result = copy.deepcopy(original)
        err = version_error(result)
        if err:
            raise ValueError(err)
        validate_observations(result)
        diagram_evidence.validate_diagram_metadata(result)
        if not has_observations(result):
            result = attach_observations(
                result,
                {
                    "kind": "failed_page"
                    if result.get("_meta", {}).get("parse_error")
                    else "legacy_page_result",
                    "metadata": copy.deepcopy(result.get("_meta", {})),
                    "source_pdf": pdf_source,
                    "page": page_idx,
                },
            )
        for key in ("extraction_sources", "observations"):
            for source_id, value in result["_meta"][key].items():
                if source_id in meta[key] and meta[key][source_id] != value:
                    raise ValueError(f"conflicting extraction evidence: {source_id}")
                meta[key][source_id] = copy.deepcopy(value)
        for key in ("diagram_evidence", "diagram_diagnostics"):
            for record_id, value in result.get("_meta", {}).get(key, {}).items():
                target = meta.setdefault(key, {})
                if record_id in target and target[record_id] != value:
                    raise ValueError(f"conflicting diagram evidence: {record_id}")
                target[record_id] = copy.deepcopy(value)
        for source_id in result["_meta"]["extraction_sources"]:
            context = {"source_pdf": pdf_source, "page": page_idx}
            if source_id in meta["page_sources"] and meta["page_sources"][source_id] != context:
                raise ValueError("one extraction source cannot refer to multiple PDF pages")
            meta["page_sources"][source_id] = context
        for s_idx, song in enumerate(result.get("songs", [])):
            song = json.loads(json.dumps(song))  # deep copy
            # The model's own "pages" value is an unreliable guess (it may print
            # a song/section number). The real page index is authoritative.
            cont = (
                s_idx == 0
                and songs
                and _norm_title(song.get("title")) == _norm_title(songs[-1].get("title"))
            )
            if cont:
                prev = songs[-1]
                prev.setdefault("sections", []).extend(song.get("sections", []))
                if page_idx not in prev["pages"]:
                    prev["pages"].append(page_idx)
            else:
                song["pages"] = [page_idx]
                songs.append(song)

    seal_page_sources(meta)
    return stamp(
        {
            "document": {
                "title": pdf_path.stem,
                "source_pdf": pdf_path.name,
                "page_count": len(page_results),
            },
            "songs": songs,
            "_meta": meta,
        }
    )


def _bars(song: dict) -> list:
    out = []
    for section in song.get("sections", []):
        out.extend(section.get("bars", []))
    return out


def heuristics(document: dict) -> list[str]:
    """Return a list of warning strings (empty = clean)."""
    warns = []
    for i, song in enumerate(document.get("songs", [])):
        tag = f"song[{i}] {song.get('title')!r}"
        bars = _bars(song)
        if not (song.get("title") or "").strip():
            warns.append(f"{tag}: empty title")
        if not bars:
            warns.append(f"{tag}: no bars")
            continue
        first_bar = bars[0]
        if first_bar and first_bar[0].get("chord") == "%":
            warns.append(f"{tag}: first bar starts with '%' (orphan continuation)")
        n_chords = sum(len(b) for b in bars)
        n_with_text = sum(1 for b in bars for e in b if e.get("text"))
        if n_chords and n_with_text == 0:
            warns.append(f"{tag}: no lyrics anchored on any chord ({n_chords} chords)")
        for b_idx, bar in enumerate(bars):
            if not bar:
                warns.append(f"{tag}: bar {b_idx} is empty")
    return warns


def validate_pdf(
    pdf_path: Path, workdir: Path, dpi: int, force: bool, *, diagrams: bool = True
) -> dict:
    import jsonschema

    schema = json.loads(SCHEMA_PATH.read_text())
    work = workdir / pdf_path.stem
    pages = render_pages(pdf_path, work, dpi, force)

    page_results, parse_errors = [], []
    for page_number, png in enumerate(pages, start=1):
        try:
            result = parse_page(png, work, force)
        except Exception as e:  # noqa: BLE001
            parse_errors.append(f"{png.name}: {e}")
            result = {"songs": [], "_meta": {"parse_error": str(e)}}
        if diagrams and not result.get("_meta", {}).get("parse_error"):
            try:
                result = diagram_evidence.enrich_page_result(result, pdf_path, page_number)
            except Exception as e:  # noqa: BLE001
                result = diagram_evidence.record_page_failure(
                    result, pdf_path, page_number, "enrichment_error", str(e)
                )
        page_results.append(result)

    document = assemble_document(pdf_path, page_results)
    write_json_artifact(work / "_assembled.json", document, overwrite=True)

    schema_error = None
    try:
        jsonschema.validate(document, schema)
    except jsonschema.ValidationError as e:
        schema_error = f"{list(e.absolute_path)}: {e.message}"

    warns = heuristics(document)
    diagram_diagnostics = list(document.get("_meta", {}).get("diagram_diagnostics", {}).values())
    return {
        "pdf": pdf_path.name,
        "pages": len(pages),
        "songs": len(document["songs"]),
        "song_titles": [s.get("title") for s in document["songs"]],
        "parse_errors": parse_errors,
        "schema_error": schema_error,
        "warnings": warns,
        "diagram_diagnostics": diagram_diagnostics,
        "passed": not parse_errors
        and schema_error is None
        and not warns
        and not diagram_diagnostics,
        "assembled_path": str(work / "_assembled.json"),
    }


def main():
    ap = argparse.ArgumentParser(description="Validate songsheet extraction across PDFs")
    ap.add_argument("pdfs", nargs="+", type=Path)
    ap.add_argument("--workdir", type=Path, default=DEFAULT_WORKDIR)
    ap.add_argument("--dpi", type=int, default=200)
    ap.add_argument("--force", action="store_true", help="Re-render and re-parse, ignore cache")
    ap.add_argument(
        "--no-diagrams",
        action="store_true",
        help="skip native-image diagram evidence enrichment",
    )
    ap.add_argument("--report-json", type=Path)
    args = ap.parse_args()

    reports = []
    for pdf in args.pdfs:
        print(f"\n{'=' * 70}\n📄 {pdf.name}\n{'=' * 70}", flush=True)
        rep = validate_pdf(pdf, args.workdir, args.dpi, args.force, diagrams=not args.no_diagrams)
        reports.append(rep)
        status = "✅ PASS" if rep["passed"] else "❌ ISSUES"
        print(f"{status}  pages={rep['pages']} songs={rep['songs']}")
        for t in rep["song_titles"]:
            print(f"   • {t}")
        for e in rep["parse_errors"]:
            print(f"   ⚠️  parse: {e}")
        if rep["schema_error"]:
            print(f"   ❌ schema: {rep['schema_error']}")
        for w in rep["warnings"]:
            print(f"   ⚠️  {w}")
        for diagnostic in rep["diagram_diagnostics"]:
            record = diagnostic["record"]
            print(f"   ⚠️  diagram page {record['page']}: {record['message']}")
        print(f"   → {rep['assembled_path']}")

    if args.report_json:
        args.report_json.write_text(json.dumps(reports, ensure_ascii=False, indent=2))
        print(f"\nReport written: {args.report_json}")

    n_pass = sum(1 for r in reports if r["passed"])
    print(f"\n{'=' * 70}\nSUMMARY: {n_pass}/{len(reports)} PDFs clean")


if __name__ == "__main__":
    main()
