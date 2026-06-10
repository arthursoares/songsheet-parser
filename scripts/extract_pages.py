#!/usr/bin/env python3
"""Extract pages from a PDF as PNG images for songsheet parsing.

Stage 1 of the pipeline: PDF -> PNG pages.

Rendering uses PyMuPDF (``import fitz``), so no external poppler binaries are
required.
"""

import argparse
import sys
from pathlib import Path

import fitz  # PyMuPDF


def render_pdf(
    pdf_path,
    out_dir,
    dpi=200,
    prefix="page",
    first_page=None,
    last_page=None,
    verbose=False,
):
    """Render a PDF to PNG pages with PyMuPDF.

    Pure/importable: takes paths, returns the list of written PNG ``Path``s.

    Page numbering is 1-indexed and preserved in the filename
    (``<prefix>-<page>.png``, zero-padded to 3 digits, e.g. ``page-001.png``)
    so downstream tooling keeps finding pages. ``first_page``/``last_page`` are
    inclusive 1-indexed bounds (``None`` => start/end of document).
    """
    pdf_path = Path(pdf_path)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    written = []
    doc = fitz.open(str(pdf_path))
    try:
        start = (first_page or 1) - 1
        stop = last_page if last_page is not None else doc.page_count
        for page_index in range(start, stop):
            page = doc[page_index]
            page_num = page_index + 1
            pix = page.get_pixmap(dpi=dpi)
            filename = f"{prefix}-{page_num:03d}.png"
            filepath = out_dir / filename
            pix.save(str(filepath))
            written.append(filepath)
            if verbose:
                print(f"  Saved {filename}")
    finally:
        doc.close()

    return written


def main():
    parser = argparse.ArgumentParser(description="Extract pages from a PDF as PNG images.")
    parser.add_argument("pdf", help="Path to the input PDF file")
    parser.add_argument(
        "--output",
        "-o",
        default="pages",
        help="Output directory for PNG pages (default: pages)",
    )
    parser.add_argument(
        "--dpi",
        type=int,
        default=200,
        help="Resolution in DPI (default: 200)",
    )
    parser.add_argument(
        "--prefix",
        default="page",
        help="Filename prefix (default: page)",
    )
    parser.add_argument(
        "--first-page",
        type=int,
        default=None,
        help="First page to extract (1-indexed)",
    )
    parser.add_argument(
        "--last-page",
        type=int,
        default=None,
        help="Last page to extract (1-indexed)",
    )
    args = parser.parse_args()

    pdf_path = Path(args.pdf)
    if not pdf_path.exists():
        print(f"Error: PDF not found: {pdf_path}", file=sys.stderr)
        sys.exit(1)

    output_dir = Path(args.output)

    print(f"Extracting pages from {pdf_path} at {args.dpi} DPI...")

    written = render_pdf(
        pdf_path,
        output_dir,
        dpi=args.dpi,
        prefix=args.prefix,
        first_page=args.first_page,
        last_page=args.last_page,
        verbose=True,
    )

    print(f"\nExtracted {len(written)} pages to {output_dir}")


if __name__ == "__main__":
    main()
