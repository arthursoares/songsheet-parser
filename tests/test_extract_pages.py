"""Tests for scripts/extract_pages.py (PyMuPDF-based PDF -> PNG rendering)."""

import sys
from pathlib import Path

import fitz  # PyMuPDF

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from extract_pages import render_pdf  # noqa: E402


def _make_pdf(path: Path, n_pages: int = 2) -> Path:
    doc = fitz.open()
    for _ in range(n_pages):
        doc.new_page()
    doc.save(str(path))
    doc.close()
    return path


def test_render_pdf_produces_named_pngs(tmp_path):
    pdf = _make_pdf(tmp_path / "sample.pdf", n_pages=2)
    out_dir = tmp_path / "out"

    written = render_pdf(pdf, out_dir, dpi=72)

    assert len(written) == 2
    expected = [out_dir / "page-001.png", out_dir / "page-002.png"]
    assert written == expected
    for p in expected:
        assert p.exists()
        assert p.stat().st_size > 0
        # PNG magic number.
        assert p.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"


def test_render_pdf_creates_output_dir(tmp_path):
    pdf = _make_pdf(tmp_path / "s.pdf", n_pages=1)
    out_dir = tmp_path / "nested" / "out"
    assert not out_dir.exists()

    written = render_pdf(pdf, out_dir, dpi=72)

    assert out_dir.is_dir()
    assert written == [out_dir / "page-001.png"]


def test_render_pdf_page_range(tmp_path):
    pdf = _make_pdf(tmp_path / "multi.pdf", n_pages=3)
    out_dir = tmp_path / "range"

    written = render_pdf(pdf, out_dir, dpi=72, first_page=2, last_page=3)

    assert written == [out_dir / "page-002.png", out_dir / "page-003.png"]
    for p in written:
        assert p.stat().st_size > 0
