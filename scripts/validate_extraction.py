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
on re-run unless --force is given.
"""

import argparse
import json
import sys
import unicodedata
from pathlib import Path

import fitz  # pymupdf

SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parent
sys.path.insert(0, str(SCRIPTS))

import parse_songsheet  # noqa: E402

SCHEMA_PATH = ROOT / "schemas" / "songsheet.schema.json"
DEFAULT_WORKDIR = Path("/tmp/ssv")


def render_pages(pdf_path: Path, out_dir: Path, dpi: int, force: bool) -> list[Path]:
    """Render each PDF page to a PNG, cached. Return ordered list of PNG paths."""
    out_dir.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(pdf_path)
    pages = []
    for i in range(doc.page_count):
        png = out_dir / f"page-{i + 1:03d}.png"
        if force or not png.exists():
            doc[i].get_pixmap(dpi=dpi).save(png)
        pages.append(png)
    doc.close()
    return pages


def parse_page(png: Path, out_dir: Path, force: bool) -> dict:
    """Parse one page to the document model, cached as JSON. Return the dict."""
    cache = out_dir / f"{png.stem}.json"
    if cache.exists() and not force:
        return json.loads(cache.read_text())
    result = parse_songsheet.parse_songsheet(png, provider="codex")
    cache.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    return result


def _norm_title(title: str) -> str:
    nfkd = unicodedata.normalize("NFKD", title or "")
    return nfkd.encode("ascii", "ignore").decode("ascii").lower().strip()


def assemble_document(pdf_path: Path, page_results: list[dict]) -> dict:
    """Stitch per-page parse results into one document, merging songs that
    continue across page breaks (same title as previous page's last song)."""
    songs: list[dict] = []
    for page_idx, result in enumerate(page_results, start=1):
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

    return {
        "document": {
            "title": pdf_path.stem,
            "source_pdf": pdf_path.name,
            "page_count": len(page_results),
        },
        "songs": songs,
    }


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


def validate_pdf(pdf_path: Path, workdir: Path, dpi: int, force: bool) -> dict:
    import jsonschema

    schema = json.loads(SCHEMA_PATH.read_text())
    work = workdir / pdf_path.stem
    pages = render_pages(pdf_path, work, dpi, force)

    page_results, parse_errors = [], []
    for png in pages:
        try:
            page_results.append(parse_page(png, work, force))
        except Exception as e:  # noqa: BLE001
            parse_errors.append(f"{png.name}: {e}")
            page_results.append({"songs": []})

    document = assemble_document(pdf_path, page_results)
    (work / "_assembled.json").write_text(
        json.dumps(document, ensure_ascii=False, indent=2)
    )

    schema_error = None
    try:
        jsonschema.validate(document, schema)
    except jsonschema.ValidationError as e:
        schema_error = f"{list(e.absolute_path)}: {e.message}"

    warns = heuristics(document)
    return {
        "pdf": pdf_path.name,
        "pages": len(pages),
        "songs": len(document["songs"]),
        "song_titles": [s.get("title") for s in document["songs"]],
        "parse_errors": parse_errors,
        "schema_error": schema_error,
        "warnings": warns,
        "passed": not parse_errors and schema_error is None and not warns,
        "assembled_path": str(work / "_assembled.json"),
    }


def main():
    ap = argparse.ArgumentParser(description="Validate songsheet extraction across PDFs")
    ap.add_argument("pdfs", nargs="+", type=Path)
    ap.add_argument("--workdir", type=Path, default=DEFAULT_WORKDIR)
    ap.add_argument("--dpi", type=int, default=200)
    ap.add_argument("--force", action="store_true", help="Re-render and re-parse, ignore cache")
    ap.add_argument("--report-json", type=Path)
    args = ap.parse_args()

    reports = []
    for pdf in args.pdfs:
        print(f"\n{'=' * 70}\n📄 {pdf.name}\n{'=' * 70}", flush=True)
        rep = validate_pdf(pdf, args.workdir, args.dpi, args.force)
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
        print(f"   → {rep['assembled_path']}")

    if args.report_json:
        args.report_json.write_text(json.dumps(reports, ensure_ascii=False, indent=2))
        print(f"\nReport written: {args.report_json}")

    n_pass = sum(1 for r in reports if r["passed"])
    print(f"\n{'=' * 70}\nSUMMARY: {n_pass}/{len(reports)} PDFs clean")


if __name__ == "__main__":
    main()
