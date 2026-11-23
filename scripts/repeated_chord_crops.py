"""Read small, source-verified chord-diagram crops for offline reports."""

from __future__ import annotations

import base64
import hashlib
import io
from pathlib import Path

import audit_voicings
import numpy as np
from diagram_reader import load_page_image
from extraction_provenance import file_sha256
from PIL import Image
from songsheet_io import load_document

RECORDED_BASIS = "Recorded observation evidence"
LEGACY_BASIS = "Legacy reading-order match"


class CropReader:
    """Return conservative printed-diagram crops without modifying the corpus."""

    def __init__(self, pdf_dir: Path, cache_dir: Path):
        self.pdf_dir = Path(pdf_dir)
        self.cache_dir = Path(cache_dir)
        self._documents = {}
        self._digests = {}
        self._pages = {}
        self._legacy_pairs = {}
        self._results = {}

    @staticmethod
    def _signature(path: Path):
        try:
            stat = path.stat()
        except OSError:
            return None
        return (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns)

    def _document(self, path: Path, signature):
        key = (path, signature)
        if key not in self._documents:
            self._documents[key] = load_document(path)
        return self._documents[key]

    def _digest(self, path: Path):
        signature = self._signature(path)
        if signature is None:
            return None
        key = (path, signature)
        if key not in self._digests:
            self._digests[key] = file_sha256(path)
        return self._digests[key]

    def _safe_pdf(self, source: dict | None):
        if not isinstance(source, dict):
            return None
        name, expected = source.get("name"), source.get("sha256")
        if not isinstance(name, str) or not name or Path(name).name != name:
            return None
        if not isinstance(expected, str) or len(expected) != 64:
            return None
        try:
            root = self.pdf_dir.resolve(strict=True)
            pdf = (root / name).resolve(strict=True)
        except OSError:
            return None
        if not root.is_dir() or not pdf.is_relative_to(root) or pdf.suffix.lower() != ".pdf":
            return None
        if not pdf.is_file() or self._digest(pdf) != expected:
            return None
        return pdf

    def _legacy_pdf(self, album: str):
        try:
            root = self.pdf_dir.resolve(strict=True)
            matched = audit_voicings.pdf_for_album(album, root)
            pdf = Path(matched).resolve(strict=True) if matched is not None else None
        except (OSError, TypeError):
            return None
        if (
            pdf is None
            or not pdf.is_relative_to(root)
            or pdf.suffix.lower() != ".pdf"
            or not pdf.is_file()
        ):
            return None
        return pdf

    def _page(self, pdf: Path, page_number: int):
        signature = self._signature(pdf)
        if signature is None:
            return None
        key = (pdf, signature, page_number)
        if key not in self._pages:
            self._pages[key] = load_page_image(pdf, page_number)
        return self._pages[key]

    @staticmethod
    def _entry(song: dict, si: int, bi: int, ei: int):
        if any(type(value) is not int or value < 0 for value in (si, bi, ei)):
            return None
        try:
            entry = song["sections"][si]["bars"][bi][ei]
        except (IndexError, KeyError, TypeError):
            return None
        return entry if isinstance(entry, dict) else None

    @staticmethod
    def _valid_box(box, page) -> bool:
        if not isinstance(box, (list, tuple)) or len(box) != 4:
            return False
        if any(type(value) is not int for value in box) or getattr(page, "ndim", None) != 2:
            return False
        x0, y0, x1, y1 = box
        height, width = page.shape
        return 0 <= x0 <= x1 < width and 0 <= y0 <= y1 < height

    def _render(self, pdf: Path, page_number: int, box, basis: str):
        if type(page_number) is not int or page_number < 1:
            return None
        page = self._page(pdf, page_number)
        if page is None or not self._valid_box(box, page):
            return None
        x0, y0, x1, y1 = box
        crop = np.asarray(page[max(0, y0 - 12) : y1 + 13, max(0, x0 - 8) : x1 + 9]).astype("uint8")
        if not crop.size:
            return None
        image = Image.fromarray(crop).resize(
            (crop.shape[1] * 8, crop.shape[0] * 8), Image.Resampling.LANCZOS
        )
        output = io.BytesIO()
        image.save(output, "PNG")
        encoded = base64.b64encode(output.getvalue()).decode("ascii")
        return {
            "image": f"data:image/png;base64,{encoded}",
            "page": page_number,
            "basis": basis,
            "pdf": pdf.name,
        }

    def _recorded(self, doc: dict, entry: dict):
        observation_id = entry.get("observation_id")
        if not observation_id:
            return None
        wrapper = doc.get("_meta", {}).get("diagram_evidence", {}).get(observation_id)
        record = wrapper.get("record") if isinstance(wrapper, dict) else None
        if not isinstance(record, dict) or record.get("observation_id") != observation_id:
            return None
        printed = entry.get("voicing_printed")
        if not isinstance(printed, str) or record.get("voicing_printed") != printed:
            return None
        pdf = self._safe_pdf(record.get("source_pdf"))
        if pdf is None:
            return None
        page_number, box = record.get("page"), record.get("crop_box")
        if type(page_number) is not int or page_number < 1:
            return None
        try:
            page = self._page(pdf, page_number)
        except (Exception, SystemExit):  # a missing/malformed source is expected evidence failure
            return None
        native = record.get("native_image")
        if not isinstance(native, dict) or page is None or getattr(page, "ndim", None) != 2:
            return None
        if tuple(page.shape) != (native.get("height"), native.get("width")):
            return None
        pixels = np.asarray(page).astype("uint8").tobytes()
        if hashlib.sha256(pixels).hexdigest() != native.get("sha256"):
            return None
        return self._render(pdf, page_number, box, RECORDED_BASIS)

    def _legacy_pair_map(self, key, song: dict, pdf: Path):
        if key in self._legacy_pairs:
            return self._legacy_pairs[key]
        result = None
        try:
            diagrams = audit_voicings.song_diagram_data(song, pdf, self.cache_dir)
            pairs, mode = audit_voicings.pair_song(song, diagrams)
            if mode in {"voiced", "all-entries"}:
                result = {id(entry): data for entry, data in pairs}
        except (Exception, SystemExit):
            result = None
        self._legacy_pairs[key] = result
        return result

    def _legacy(self, song_key, song_path: Path, song: dict, entry: dict):
        pdf = self._legacy_pdf(song_path.parent.name)
        if pdf is None:
            return None
        pairs = self._legacy_pair_map((song_key, pdf, self._signature(pdf)), song, pdf)
        data = pairs.get(id(entry)) if pairs else None
        if not isinstance(data, (list, tuple)) or len(data) != 4:
            return None
        voicing, _error, page_number, box = data
        printed = entry.get("voicing_printed")
        if not isinstance(printed, str) or voicing != printed:
            return None
        return self._render(pdf, page_number, box, LEGACY_BASIS)

    def crop_for(
        self, song_path: Path, song_index: int, si: int, bi: int, ei: int, *, expected=None
    ) -> dict | None:
        """Return a supported PNG crop if the entry still matches the report."""
        song_path = Path(song_path).resolve()
        signature = self._signature(song_path)
        key = (song_path, signature, song_index, si, bi, ei, expected)
        if key in self._results:
            return self._results[key]
        result = None
        try:
            doc = self._document(song_path, signature)
            if type(song_index) is not int or song_index < 0:
                raise IndexError
            song = doc["songs"][song_index]
            entry = self._entry(song, si, bi, ei)
            if entry is not None and (
                expected is None
                or tuple(entry.get(field) for field in ("chord", "voicing", "voicing_printed"))
                == expected
            ):
                if entry.get("observation_id"):
                    result = self._recorded(doc, entry)
                else:
                    result = self._legacy(
                        (song_path, signature, song_index), song_path, song, entry
                    )
        except (Exception, SystemExit):
            result = None
        self._results[key] = result
        return result
