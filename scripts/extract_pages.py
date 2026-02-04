#!/usr/bin/env python3
"""
Extract pages from PDF songbooks as PNG images.

Usage:
    python extract_pages.py songbook.pdf --output data/artist/png/
    
Requirements:
    pip install pdf2image
    # Also needs poppler: apt install poppler-utils
"""

import argparse
from pathlib import Path


def extract_pages(pdf_path: Path, output_dir: Path, dpi: int = 200):
    """Extract PDF pages as PNG images."""
    from pdf2image import convert_from_path
    
    output_dir.mkdir(parents=True, exist_ok=True)
    
    print(f"Extracting pages from: {pdf_path.name}")
    pages = convert_from_path(pdf_path, dpi=dpi)
    
    for i, page in enumerate(pages, 1):
        output_path = output_dir / f"page-{i:03d}.png"
        page.save(output_path, "PNG")
        print(f"  Saved: {output_path.name}")
    
    print(f"Done: {len(pages)} pages extracted")


def main():
    parser = argparse.ArgumentParser(description="Extract PDF pages as PNG images")
    parser.add_argument("pdf", type=Path, help="PDF file to extract")
    parser.add_argument("-o", "--output", type=Path, required=True, help="Output directory")
    parser.add_argument("--dpi", type=int, default=200, help="Resolution (default: 200)")
    
    args = parser.parse_args()
    
    if not args.pdf.exists():
        print(f"Error: {args.pdf} not found")
        return 1
    
    extract_pages(args.pdf, args.output, args.dpi)


if __name__ == "__main__":
    main()
