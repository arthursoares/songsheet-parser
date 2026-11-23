#!/usr/bin/env python3
"""Local QA correction server for the songsheet per-song corpus.

Serves the browser app and a small JSON API for listing, reading, and saving
songs, plus page images. Saves are validated against the songsheet schema and
refused if invalid.

Usage:
    python qa_server.py --songs data/joao-gilberto/songs --port 8000
"""

import argparse
import hashlib
import json
import os
import re
import threading
from html import escape
from pathlib import Path

from extraction_provenance import entries, file_sha256
from review_state import record_review, review_summary
from songsheet_io import DocumentError, load_document, save_document, validate_document

SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parent
STATIC_DIR = SCRIPTS / "qa_static"
PDF_DIR: Path | None = None  # set in main(); sibling pdf/ of --songs by default
CV_CACHE_DIR = Path("/tmp/cv-cache")  # shared with audit_voicings runs

SAFE = re.compile(r"^[A-Za-z0-9._-]+$")  # path-segment guard (no traversal)


def _safe_under(root: Path, *segments) -> Path | None:
    """Resolve root/segments and return it only if it stays inside root; else None."""
    for seg in segments:
        if seg in ("", ".", "..") or not SAFE.match(seg):
            return None
    candidate = (root / Path(*segments)).resolve()
    root_resolved = root.resolve()
    if candidate == root_resolved or root_resolved in candidate.parents:
        return candidate
    return None


def _json(status, obj):
    return status, "application/json", json.dumps(obj, ensure_ascii=False).encode()


def _query_params(path):
    """Parse the query string of a raw path into a flat dict (last value wins)."""
    from urllib.parse import parse_qs, urlparse

    q = urlparse(path).query
    return {k: v[-1] for k, v in parse_qs(q).items()}


def _bars_per_line(params):
    """The bars-per-line layout guide from ?bars=, restricted to 4/6/8 (default 4)."""
    try:
        n = int(params.get("bars", 4))
    except (TypeError, ValueError):
        n = 4
    return n if n in (4, 6, 8) else 4


def _diagram_layout(params):
    value = params.get("diagrams")
    return value if value in ("dictionary", "inline", "both") else None


def _target_render_options(params):
    return {
        "dictionary": params.get("dict", "per_voicing"),
        "inline": params.get("inline") == "1",
        "bars_per_line": _bars_per_line(params),
        "diagram_layout": _diagram_layout(params),
    }


def _song_meta(path: Path):
    """Status + voicing-audit summary for the sidebar. Never raises.

    print_diffs counts entries where the stored voicing differs from (or is
    missing against) voicing_printed; audited says whether the CV audit has
    touched this song at all (so 0 diffs is meaningful).
    """
    try:
        doc = json.loads(path.read_text())
        status = doc.get("document", {}).get("status") or "pending"
        diffs, audited = 0, False
        for song in doc.get("songs", []):
            for sec in song.get("sections", []):
                for bar in sec.get("bars", []):
                    for e in bar:
                        vp = e.get("voicing_printed")
                        if not vp:
                            continue
                        audited = True
                        if vp != e.get("voicing"):
                            diffs += 1
        return status, diffs, audited
    except Exception:
        return "pending", 0, False


def list_albums(root: Path):
    out = []
    for album in sorted(p for p in root.iterdir() if p.is_dir()):
        songs = []
        for f in sorted(album.glob("*.json")):
            status, diffs, audited = _song_meta(f)
            songs.append(
                {"file": f.name, "status": status, "print_diffs": diffs, "audited": audited}
            )
        out.append({"album": album.name, "songs": songs})
    return out


def _chrome():
    """Find an isolated server export renderer without starting desktop Chrome."""
    import shutil

    configured = os.environ.get("SONGSHEET_CHROME_BIN")
    if configured:
        return shutil.which(configured)
    return shutil.which("chrome-headless-shell") or shutil.which("chromium-headless-shell")


# Serialize headless-Chrome conversions: the server is a ThreadingHTTPServer,
# so concurrent exports would otherwise collide and 500 under burst.
_CHROME_LOCK = threading.Lock()


def _chrome_convert(html: str, fmt: str):
    """Render an HTML string to PDF or PNG bytes via headless Chrome.

    fmt is "pdf" or "png". Returns the bytes, or raises RuntimeError if Chrome is
    missing or the conversion fails / times out. Conversions are serialized
    (one Chrome process at a time) so concurrent exports don't collide. PNG is
    rendered from Chrome's paginated PDF instead of a fixed-height screenshot,
    so long charts are not silently clipped at the viewport boundary.
    """
    import io
    import signal
    import subprocess
    import tempfile

    if fmt not in ("pdf", "png"):
        raise ValueError(f"unsupported Chrome conversion format: {fmt!r}")

    with _CHROME_LOCK:
        chrome = _chrome()
        if not chrome:
            raise RuntimeError("Chrome not found")

        with tempfile.TemporaryDirectory() as tmp:
            in_html = Path(tmp) / "in.html"
            in_html.write_text(html, encoding="utf-8")
            out = Path(tmp) / "out.pdf"
            profile = Path(tmp) / "chrome-profile"
            cmd = [
                chrome,
                "--headless",
                "--disable-gpu",
                "--no-first-run",
                "--no-default-browser-check",
                f"--user-data-dir={profile}",
                "--no-pdf-header-footer",
                f"--print-to-pdf={out}",
                in_html.as_uri(),
            ]
            try:
                r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            except subprocess.TimeoutExpired as e:
                raise RuntimeError("Chrome conversion timed out") from e
            if r.returncode != 0 or not out.exists():
                detail = (r.stderr or r.stdout or "").strip()
                if r.returncode < 0:
                    try:
                        outcome = f"terminated by {signal.Signals(-r.returncode).name}"
                    except ValueError:
                        outcome = f"terminated by signal {-r.returncode}"
                else:
                    outcome = f"exited with status {r.returncode}"
                if detail:
                    outcome += f": {detail}"
                raise RuntimeError(f"Chrome conversion failed ({outcome})")

            pdf = out.read_bytes()
            if not pdf.startswith(b"%PDF-"):
                raise RuntimeError("Chrome conversion failed (invalid PDF output)")
            if fmt == "pdf":
                return pdf

            # Chrome's command-line screenshot captures only the viewport. Render
            # every printed page and join them vertically for a complete PNG.
            import fitz
            from PIL import Image

            try:
                pages = []
                with fitz.open(stream=pdf, filetype="pdf") as document:
                    for page in document:
                        pixmap = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
                        pages.append(
                            Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
                        )
                if not pages:
                    raise ValueError("PDF has no pages")
                image = Image.new(
                    "RGB",
                    (max(page.width for page in pages), sum(page.height for page in pages)),
                    "white",
                )
                y = 0
                for page in pages:
                    image.paste(page, (0, y))
                    y += page.height
                png = io.BytesIO()
                image.save(png, format="PNG")
                return png.getvalue()
            except Exception as e:  # noqa: BLE001
                raise RuntimeError(f"PNG conversion failed: {e}") from e


def _attach(stem: str, ext: str):
    """A Content-Disposition attachment header dict for <stem>.<ext>."""
    return {"Content-Disposition": f'attachment; filename="{stem}.{ext}"'}


def _render_html_for_export(target: Path, params):
    """Build the export HTML for a single song (style=target default, or fork).

    Returns (html_str, None) on success or (None, error_3tuple) on failure.
    """
    if params.get("style") == "fork":
        result = render_song_html(
            target, bars_per_line=_bars_per_line(params), diagram_layout=_diagram_layout(params)
        )
    else:
        result = render_target_html(target, **_target_render_options(params))
    # render_*_html return (200, "text/html", bytes); surface any non-200 as error
    if result[0] != 200:
        return None, result
    return result[2].decode("utf-8"), None


def _render_doc_html_for_export(doc, params):
    """Build export HTML from an in-memory document without reading a song file."""
    if params.get("style") == "fork":
        result = render_song_doc(
            doc, bars_per_line=_bars_per_line(params), diagram_layout=_diagram_layout(params)
        )
    else:
        result = render_target_doc(doc, **_target_render_options(params))
    if result[0] != 200:
        return None, result
    return result[2].decode("utf-8"), None


def _load_doc(body: bytes):
    """Parse a request body into a document dict.

    Returns (doc, None) on success or (None, error_3tuple) on a JSON parse error.
    """
    try:
        return json.loads(body), None
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as e:
        return None, _json(400, {"error": f"invalid JSON: {e}"})


def _existing_song(root: Path, album: str, fname: str):
    """Resolve root/album/fname for read routes: (target, None) or (None, error response)."""
    target = _safe_under(root, album, fname)
    if target is None:
        return None, _json(400, {"error": "bad path"})
    if not target.exists():
        return None, _json(404, {"error": "not found"})
    return target, None


# --- route handlers -------------------------------------------------------
# Each takes (req, **path_args) where req has .root, .body, .params, and
# returns (status, ctype, body) or (status, ctype, body, headers).


def _h_albums(req):
    return _json(200, list_albums(req.root))


def _h_song_get(req, album, file):
    target, err = _existing_song(req.root, album, file)
    if err is not None:
        return err
    return 200, "application/json", target.read_bytes()


def _h_song_post(req, album, file):
    # No existence check: a save may (re)create the file.
    target = _safe_under(req.root, album, file)
    if target is None:
        return _json(400, {"error": "bad path"})
    return save_song(target, req.body)


def _h_chordmark(req, album, file):
    """The generated ChordMark source text for a saved song."""
    target, err = _existing_song(req.root, album, file)
    if err is not None:
        return err
    try:
        text = _build_chordmark(target, _bars_per_line(req.params))
    except Exception as e:  # noqa: BLE001
        return _json(500, {"error": f"chordmark build failed: {e}"})
    return 200, "text/plain; charset=utf-8", text.encode()


def _h_render_doc(req):
    """?style=target|fork&dict=&diagrams=&bars= — render from a POSTed doc.

    Live preview of UNSAVED edits: body is the in-memory document. Never writes.
    """
    doc, err = _load_doc(req.body)
    if err is not None:
        return err
    options = _target_render_options(req.params)
    fork = None
    if req.params.get("style") == "fork":
        fork = render_song_doc(
            doc, bars_per_line=options["bars_per_line"], diagram_layout=options["diagram_layout"]
        )
    if fork is not None and fork[0] == 200:
        return fork
    target = render_target_doc(doc, **options)
    if fork is None:
        return target
    if target[0] != 200:
        return fork
    headers = {"X-Songsheet-Preview-Style": "target"}
    if fork[0] == 422:
        headers["X-Songsheet-Preview-Reason"] = "bar-layout"
    return *target, headers


def _h_chordmark_doc(req):
    """?bars= — the generated ChordMark source from a POSTed doc."""
    doc, err = _load_doc(req.body)
    if err is not None:
        return err
    try:
        text = _build_chordmark_doc(doc, _bars_per_line(req.params))
    except Exception as e:  # noqa: BLE001
        return _json(500, {"error": f"chordmark build failed: {e}"})
    return 200, "text/plain; charset=utf-8", text.encode()


def _h_review_doc(req):
    """Summarize or record field review on an in-memory document. Never writes."""
    payload, err = _load_doc(req.body)
    if err is not None:
        return err
    if not isinstance(payload, dict) or not isinstance(payload.get("doc"), dict):
        return _json(422, {"ok": False, "error": "body needs a document object in 'doc'"})
    doc = payload["doc"]
    try:
        validate_document(doc)
        if "field" in payload or "status" in payload:
            if "field" not in payload or "status" not in payload:
                raise ValueError("field and status must be supplied together")
            reviewed = record_review(
                doc,
                payload["field"],
                payload["status"],
                payload.get("reviewer", ""),
                payload.get("evidence", ""),
            )
        else:
            reviewed = doc
        validate_document(reviewed)
        summary = review_summary(reviewed)
    except (DocumentError, TypeError, ValueError) as exc:
        return _json(422, {"ok": False, "error": str(exc)})
    return _json(200, {"ok": True, "doc": reviewed, "review": summary})


def _h_harmony(req, album, file):
    """Harmonic analysis of a saved song."""
    target, err = _existing_song(req.root, album, file)
    if err is not None:
        return err
    try:
        doc = json.loads(target.read_text())
    except Exception as e:  # noqa: BLE001
        return _json(500, {"error": f"bad song file: {e}"})
    return harmony_doc(doc)


def _h_harmony_doc(req):
    """Harmonic analysis of a POSTed (unsaved) document.

    Live analysis of in-memory edits, same contract as /api/render-doc.
    """
    doc, err = _load_doc(req.body)
    if err is not None:
        return err
    return harmony_doc(doc)


def _h_convert(req):
    """?fmt=pdf|png&name=<stem> — body is an HTML document, returns it converted
    by the configured headless renderer as a downloadable attachment.
    """
    fmt = req.params.get("fmt", "pdf")
    if fmt not in ("pdf", "png"):
        return _json(400, {"error": f"unsupported fmt {fmt!r}"})
    try:
        html = req.body.decode("utf-8")
    except UnicodeDecodeError:
        return _json(400, {"error": "body must be utf-8 HTML"})
    if not html.strip():
        return _json(400, {"error": "empty body"})
    try:
        data = _chrome_convert(html, fmt)
    except RuntimeError as e:
        return _json(500, {"error": str(e)})
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", req.params.get("name", "export")) or "export"
    ctype = "application/pdf" if fmt == "pdf" else "image/png"
    return 200, ctype, data, _attach(stem, fmt)


def _h_render(req, album, file):
    """ChordMark HTML rendered via the fork (or style=target)."""
    target, err = _existing_song(req.root, album, file)
    if err is not None:
        return err
    if req.params.get("style") == "target":
        return render_target_html(target, **_target_render_options(req.params))
    return render_song_html(
        target, bars_per_line=_bars_per_line(req.params), diagram_layout=_diagram_layout(req.params)
    )


def _h_export(req, album, file):
    """?fmt=chordmark|chordpro|html|pdf|png — downloadable file for one song."""
    target, err = _existing_song(req.root, album, file)
    if err is not None:
        return err
    fmt = req.params.get("fmt", "html")
    stem = file[:-5] if file.endswith(".json") else file

    if fmt == "chordmark":
        try:
            text = _build_chordmark(target, _bars_per_line(req.params))
        except Exception as e:  # noqa: BLE001
            return _json(500, {"error": f"chordmark build failed: {e}"})
        return (200, "text/plain; charset=utf-8", text.encode(), _attach(stem, "chordmark"))

    if fmt == "chordpro":
        try:
            text = _build_chordpro(target)
        except Exception as e:  # noqa: BLE001
            return _json(500, {"error": f"chordpro build failed: {e}"})
        return (200, "text/plain; charset=utf-8", text.encode(), _attach(stem, "chordpro"))

    html, err = _render_html_for_export(target, req.params)
    if err is not None:
        return err
    if fmt == "html":
        return 200, "text/html", html.encode(), _attach(stem, "html")
    if fmt in ("pdf", "png"):
        if _chrome() is None:
            return _json(500, {"error": "Chrome not found for PDF export"})
        try:
            blob = _chrome_convert(html, fmt)
        except RuntimeError as e:
            return _json(500, {"error": str(e)})
        ctype = "application/pdf" if fmt == "pdf" else "image/png"
        return 200, ctype, blob, _attach(stem, fmt)
    return _json(400, {"error": f"unknown fmt: {fmt}"})


def _h_export_doc(req, album, file):
    """Export a posted document snapshot using an existing song's filename only."""
    _target, err = _existing_song(req.root, album, file)
    if err is not None:
        return err
    doc, err = _load_doc(req.body)
    if err is not None:
        return err
    try:
        validate_document(doc)
    except (DocumentError, TypeError, ValueError) as exc:
        return _json(422, {"error": str(exc)})

    fmt = req.params.get("fmt", "html")
    if fmt not in ("chordmark", "chordpro", "html", "pdf", "png"):
        return _json(400, {"error": f"unknown fmt: {fmt}"})
    stem = file[:-5] if file.endswith(".json") else file

    if fmt == "chordmark":
        try:
            text = _build_chordmark_doc(doc, _bars_per_line(req.params))
        except Exception as exc:  # noqa: BLE001
            return _json(500, {"error": f"chordmark build failed: {exc}"})
        return 200, "text/plain; charset=utf-8", text.encode(), _attach(stem, "chordmark")

    if fmt == "chordpro":
        try:
            text = _build_chordpro_doc(doc)
        except Exception as exc:  # noqa: BLE001
            return _json(500, {"error": f"chordpro build failed: {exc}"})
        return 200, "text/plain; charset=utf-8", text.encode(), _attach(stem, "chordpro")

    html, err = _render_doc_html_for_export(doc, req.params)
    if err is not None:
        return err
    if fmt == "html":
        return 200, "text/html", html.encode(), _attach(stem, "html")
    if fmt in ("pdf", "png"):
        if _chrome() is None:
            return _json(500, {"error": "Chrome not found for PDF export"})
        try:
            blob = _chrome_convert(html, fmt)
        except RuntimeError as exc:
            return _json(500, {"error": str(exc)})
        ctype = "application/pdf" if fmt == "pdf" else "image/png"
        return 200, ctype, blob, _attach(stem, fmt)
    raise AssertionError(f"unhandled export format: {fmt}")


def _h_export_album(req, album):
    """?fmt=pdf|html — whole-album songbook (one document)."""
    album_dir = _safe_under(req.root, album)
    if album_dir is None:
        return _json(400, {"error": "bad path"})
    if not album_dir.is_dir():
        return _json(404, {"error": "not found"})
    fmt = req.params.get("fmt", "pdf")
    html, err = _render_album_songbook_html(album_dir, album, req.params)
    if err is not None:
        return err
    if fmt == "html":
        return 200, "text/html", html.encode(), _attach(f"{album}-songbook", "html")
    if fmt == "pdf":
        if _chrome() is None:
            return _json(500, {"error": "Chrome not found for PDF export"})
        try:
            blob = _chrome_convert(html, "pdf")
        except RuntimeError as e:
            return _json(500, {"error": str(e)})
        return 200, "application/pdf", blob, _attach(f"{album}-songbook", "pdf")
    return _json(400, {"error": f"unknown fmt: {fmt}"})


# Source- and document-fingerprinted crops; observation IDs survive unsaved moves.
_CROP_CACHE: dict = {}
# PyMuPDF's native objects are not safe to use concurrently.  Keep both the
# existing native-image loads and page-placement inspection on one lane.
_PDF_LOCK = threading.Lock()


def _evidence_pdf(source):
    """Resolve and fingerprint one recorded source PDF, or return an API error."""
    if PDF_DIR is None or not PDF_DIR.is_dir():
        return None, _json(404, {"error": "no pdf directory configured"})
    if not isinstance(source, dict):
        return None, _json(422, {"error": "invalid source PDF evidence"})
    name, digest = source.get("name"), source.get("sha256")
    if not isinstance(name, str) or not name or Path(name).name != name:
        return None, _json(400, {"error": "invalid source PDF path"})
    pdf = (PDF_DIR / name).resolve()
    if not pdf.is_relative_to(PDF_DIR.resolve()) or pdf.suffix.lower() != ".pdf":
        return None, _json(400, {"error": "invalid source PDF path"})
    if not pdf.is_file():
        return None, _json(404, {"error": "recorded source PDF is unavailable"})
    if not isinstance(digest, str) or file_sha256(pdf) != digest:
        return None, _json(409, {"error": "source PDF changed; regenerate candidate evidence"})
    return pdf, None


def _page_diagram_boxes(pdf: Path, page_number: int, records: list[dict]):
    """Map native inclusive crop boxes into rotated, cropped page fractions.

    The diagram reader uses the first embedded page image.  MuPDF reports that
    image's placement in cropped but unrotated page coordinates, so each native
    pixel-edge rectangle must pass through the image placement and the page
    rotation before it can be normalized against the rendered ``page.rect``.
    """
    import fitz

    result = {record["observation_id"]: None for record in records}
    with _PDF_LOCK, fitz.open(pdf) as document:
        if page_number < 1 or page_number > document.page_count:
            return result
        page = document[page_number - 1]
        images = page.get_images(full=True)
        if not images:
            return result
        xref, native_width, native_height = images[0][0], images[0][2], images[0][3]
        placements = page.get_image_rects(xref, transform=True)
        if len(placements) != 1:
            return result
        _placement_rect, placement = placements[0]
        rotation = page.rotation_matrix
        rendered = page.rect
        if rendered.width <= 0 or rendered.height <= 0:
            return result
        for record in records:
            native = record.get("native_image", {})
            if native.get("width") != native_width or native.get("height") != native_height:
                continue
            x0, y0, x1, y1 = record["crop_box"]
            # Evidence boxes are inclusive pixel indices; use the outer pixel
            # edges so a one-pixel box retains non-zero area.
            unit_points = (
                fitz.Point(x0 / native_width, y0 / native_height),
                fitz.Point((x1 + 1) / native_width, y0 / native_height),
                fitz.Point(x0 / native_width, (y1 + 1) / native_height),
                fitz.Point((x1 + 1) / native_width, (y1 + 1) / native_height),
            )
            points = [point * placement * rotation for point in unit_points]
            left = max(0.0, min(point.x for point in points) / rendered.width)
            top = max(0.0, min(point.y for point in points) / rendered.height)
            right = min(1.0, max(point.x for point in points) / rendered.width)
            bottom = min(1.0, max(point.y for point in points) / rendered.height)
            if left < right and top < bottom:
                result[record["observation_id"]] = [
                    round(left, 10),
                    round(top, 10),
                    round(right, 10),
                    round(bottom, 10),
                ]
    return result


def _h_diagram_location(req, album, file):
    """All observation-linked source locations for a saved song.

    Paired diagram evidence includes normalized page geometry.  A validated
    observation with only page context is still useful to the reviewer and is
    returned with ``box: null``.  Legacy entries without links are not guessed.
    """
    target, err = _existing_song(req.root, album, file)
    if err is not None:
        return err
    try:
        doc = load_document(target)
    except (ValueError, OSError) as exc:
        return _json(422, {"error": str(exc)})

    meta = doc.get("_meta", {})
    observations = meta.get("observations", {})
    contexts = meta.get("page_sources", {})
    evidence = meta.get("diagram_evidence", {})
    pending = {}
    resolved_sources = {}
    for _position, entry in entries(doc):
        observation_id = entry.get("observation_id")
        if observation_id in pending:
            continue
        observation = observations.get(observation_id)
        if not isinstance(observation, dict):
            continue
        wrapper = evidence.get(observation_id)
        record = wrapper.get("record") if isinstance(wrapper, dict) else None
        if isinstance(record, dict):
            page_number, source = record["page"], record["source_pdf"]
        else:
            context = contexts.get(observation.get("source_id"))
            if not isinstance(context, dict):
                continue
            page_number, source = context["page"], context["source_pdf"]
        source_key = json.dumps(source, sort_keys=True, separators=(",", ":"))
        if source_key not in resolved_sources:
            pdf, source_err = _evidence_pdf(source)
            if source_err is not None:
                return source_err
            resolved_sources[source_key] = pdf
        pdf = resolved_sources[source_key]
        pending[observation_id] = {
            "page": page_number,
            "box": None,
            "pdf": pdf,
            "record": record,
        }
    if not pending:
        return _json(404, {"error": "no linked source locations"})

    groups = {}
    for observation_id, location in pending.items():
        if location["record"] is not None:
            groups.setdefault((location["pdf"], location["page"]), []).append(location["record"])
    for (pdf, page_number), records in groups.items():
        try:
            boxes = _page_diagram_boxes(pdf, page_number, records)
        except (Exception, SystemExit):  # noqa: BLE001 - page-only is the defined fallback
            boxes = {record["observation_id"]: None for record in records}
        for observation_id, box in boxes.items():
            pending[observation_id]["box"] = box
    return _json(
        200,
        {
            "locations": {
                observation_id: {"page": item["page"], "box": item["box"]}
                for observation_id, item in pending.items()
            }
        },
    )


def _h_diagram_crop(req, album, file):
    """?si=&bi=&ei= — magnified PNG of the PRINTED diagram for one chord entry.

    Prefer recorded observation-linked boxes. Legacy documents without source
    links retain the audit pairing fallback; unpaired new observations do not.
    """
    if PDF_DIR is None or not PDF_DIR.is_dir():
        return _json(404, {"error": "no pdf directory configured"})
    target, err = _existing_song(req.root, album, file)
    if err is not None:
        return err
    observation_id = req.params.get("observation_id")
    if observation_id is not None and not re.fullmatch(r"[0-9a-f]{64}", observation_id):
        return _json(400, {"error": "invalid observation id"})
    try:
        doc = load_document(target)
    except (ValueError, OSError) as exc:
        return _json(422, {"error": str(exc)})
    song = doc["songs"][0] if doc["songs"] else {}
    entry, coordinates = None, None
    if observation_id is None:
        try:
            si, bi, ei = (int(req.params[k]) for k in ("si", "bi", "ei"))
        except (KeyError, ValueError):
            return _json(400, {"error": "si/bi/ei query params required"})
        if min(si, bi, ei) < 0:
            return _json(404, {"error": "no such entry"})
        try:
            entry = song["sections"][si]["bars"][bi][ei]
        except (IndexError, KeyError, TypeError):
            return _json(404, {"error": "no such entry"})
        observation_id = entry.get("observation_id")
        coordinates = (si, bi, ei)
    record = None
    if observation_id:
        wrapper = doc.get("_meta", {}).get("diagram_evidence", {}).get(observation_id)
        if wrapper is None:
            return _json(404, {"error": "no recorded diagram pairing; inspect the source page"})
        record = wrapper["record"]
        pdf, source_err = _evidence_pdf(record["source_pdf"])
        if source_err is not None:
            return source_err
        page_num, box = record["page"], record["crop_box"]
    else:
        import audit_voicings as av

        pdf = av.pdf_for_album(album, PDF_DIR)
        if pdf is None:
            return _json(404, {"error": f"no PDF for album {album}"})
        try:
            with _PDF_LOCK:
                diagrams = av.song_diagram_data(song, pdf, CV_CACHE_DIR)
            pairs, _mode = av.pair_song(song, diagrams)
        except Exception as exc:  # noqa: BLE001
            return _json(500, {"error": f"diagram pairing failed: {exc}"})
        hit = next((data for paired, data in pairs if paired is entry), None)
        if hit is None:
            return _json(404, {"error": "entry has no paired diagram"})
        _voicing, _error, page_num, box = hit
    key = (
        str(target.resolve()),
        file_sha256(target),
        observation_id or coordinates,
        file_sha256(pdf),
    )
    if key in _CROP_CACHE:
        return 200, "image/png", _CROP_CACHE[key]

    import io

    import numpy as np
    from diagram_reader import load_page_image
    from PIL import Image

    try:
        with _PDF_LOCK:
            page = load_page_image(pdf, page_num)
    except (Exception, SystemExit) as exc:  # noqa: BLE001
        return _json(500, {"error": f"source image unavailable: {exc}"})
    if record and (
        tuple(page.shape) != (record["native_image"]["height"], record["native_image"]["width"])
        or hashlib.sha256(page.astype("uint8").tobytes()).hexdigest()
        != record["native_image"]["sha256"]
    ):
        return _json(409, {"error": "native source image no longer matches recorded evidence"})
    x0, y0, x1, y1 = box
    # Include the printed chord label and the fret-position glyph below the grid.
    crop = np.asarray(page[max(0, y0 - 12) : y1 + 13, max(0, x0 - 8) : x1 + 9]).astype("uint8")
    im = Image.fromarray(crop).resize((crop.shape[1] * 8, crop.shape[0] * 8), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "PNG")
    data = buf.getvalue()
    _CROP_CACHE[key] = data
    return 200, "image/png", data


def _h_page(req, album, file, n):
    """pages/<file-stem>-p<n>.png"""
    if not n.isdigit():
        return _json(400, {"error": "bad path"})
    slug = file[:-5] if file.endswith(".json") else file
    png = _safe_under(req.root, album, "pages", f"{slug}-p{n}.png")
    if png is None:
        return _json(400, {"error": "bad path"})
    if not png.exists():
        return _json(404, {"error": "no page"})
    return 200, "image/png", png.read_bytes()


def _static_file(path: str):
    """Static files: index.html at "/", else by name under STATIC_DIR. None if no match."""
    rel = "index.html" if path == "/" else path.lstrip("/")
    if ".." in rel or not all(SAFE.match(seg) for seg in rel.split("/")):
        return None
    f = STATIC_DIR / rel
    if not (f.exists() and f.is_file()):
        return None
    ctype = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".png": "image/png",
        ".json": "application/json",
    }.get(f.suffix.lower(), "application/octet-stream")
    return 200, ctype, f.read_bytes()


# (method, /pattern/with/{params}, handler) — matched in order, segment-exact.
_ROUTES = [
    ("GET", "/api/albums", _h_albums),
    ("GET", "/api/song/{album}/{file}", _h_song_get),
    ("POST", "/api/song/{album}/{file}", _h_song_post),
    ("GET", "/api/chordmark/{album}/{file}", _h_chordmark),
    ("POST", "/api/render-doc", _h_render_doc),
    ("POST", "/api/chordmark-doc", _h_chordmark_doc),
    ("POST", "/api/review-doc", _h_review_doc),
    ("GET", "/api/harmony/{album}/{file}", _h_harmony),
    ("POST", "/api/harmony-doc", _h_harmony_doc),
    ("POST", "/api/convert", _h_convert),
    ("GET", "/api/render/{album}/{file}", _h_render),
    ("GET", "/api/export/{album}/{file}", _h_export),
    ("POST", "/api/export-doc/{album}/{file}", _h_export_doc),
    ("GET", "/api/export-album/{album}", _h_export_album),
    ("GET", "/api/page/{album}/{file}/{n}", _h_page),
    ("GET", "/api/diagram-location/{album}/{file}", _h_diagram_location),
    ("GET", "/api/diagram-crop/{album}/{file}", _h_diagram_crop),
]
_COMPILED_ROUTES = [(m, p.strip("/").split("/"), fn) for m, p, fn in _ROUTES]


def _match_route(pattern_parts: list[str], parts: list[str]):
    """Match path segments against a pattern; dict of {param} captures, or None."""
    if len(pattern_parts) != len(parts):
        return None
    args = {}
    for pat, seg in zip(pattern_parts, parts):
        if pat.startswith("{") and pat.endswith("}"):
            args[pat[1:-1]] = seg
        elif pat != seg:
            return None
    return args


class _Request:
    """What a route handler sees: corpus root, raw body, parsed query params."""

    __slots__ = ("root", "body", "params")

    def __init__(self, root: Path, body: bytes, params: dict):
        self.root = root
        self.body = body
        self.params = params


def handle(method: str, path: str, body: bytes, root: Path):
    """Pure router. Returns (status, ctype, body) or (status, ctype, body, headers)."""
    params = _query_params(path)
    path = path.split("?", 1)[0]  # drop query string (e.g. cache-bust ?t=)
    parts = [p for p in path.split("/") if p != ""]
    req = _Request(root, body, params)

    for route_method, pattern_parts, handler in _COMPILED_ROUTES:
        if route_method != method:
            continue
        args = _match_route(pattern_parts, parts)
        if args is not None:
            return handler(req, **args)

    if method == "GET":
        hit = _static_file(path)
        if hit is not None:
            return hit

    return _json(404, {"error": "unknown route"})


def save_song(target: Path, body: bytes):
    try:
        doc = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        return _json(400, {"ok": False, "error": f"invalid JSON: {e}"})

    try:
        save_document(target, doc, overwrite=True)
    except DocumentError as e:
        return _json(422, {"ok": False, "error": str(e)})
    except OSError as e:
        return _json(500, {"ok": False, "error": f"could not save song: {e}"})
    return _json(200, {"ok": True})


def _html_error(msg, status=500):
    body = (
        f"<!doctype html><meta charset='utf-8'>"
        f"<body style='font:14px sans-serif;color:#b00;padding:20px'>"
        f"Preview unavailable:<br><pre>{escape(msg)}</pre></body>"
    )
    return status, "text/html", body.encode()


def render_target_doc(
    doc, dictionary="per_voicing", inline=False, bars_per_line=4, *, diagram_layout=None
):
    """Render a document dict to the target lead-sheet HTML (pure Python, no fork).

    The doc-based core shared by the GET (from path) and POST (from body) routes.
    """
    import render_target

    try:
        songs = doc.get("songs", [])
        if not songs:
            return _html_error("no songs in document")
        html = render_target.render_song(
            songs[0],
            dictionary=dictionary,
            inline_diagrams=inline,
            bars_per_line=bars_per_line,
            diagram_layout=diagram_layout,
        )
        return 200, "text/html", html.encode()
    except Exception as e:  # noqa: BLE001
        return _html_error(f"target render failed: {e}")


def render_target_html(
    song_path: Path, dictionary="per_voicing", inline=False, bars_per_line=4, *, diagram_layout=None
):
    """Render a saved song to the target lead-sheet HTML (pure Python, no fork)."""
    try:
        doc = json.loads(song_path.read_text())
    except Exception as e:  # noqa: BLE001
        return _html_error(f"target render failed: {e}")
    return render_target_doc(
        doc,
        dictionary=dictionary,
        inline=inline,
        bars_per_line=bars_per_line,
        diagram_layout=diagram_layout,
    )


def _render_album_songbook_html(album_dir: Path, album: str, params):
    """Render every song JSON in an album into one songbook HTML document.

    Returns (html_str, None) on success or (None, error_3tuple) on failure.
    """
    import render_target

    try:
        songs = []
        for f in sorted(album_dir.glob("*.json")):
            doc = json.loads(f.read_text())
            for s in doc.get("songs", []):
                songs.append(s)
        html = render_target.render_songbook(
            songs,
            title=album,
            dictionary=params.get("dict", "per_voicing"),
            inline_diagrams=params.get("inline") == "1",
            bars_per_line=_bars_per_line(params),
            diagram_layout=_diagram_layout(params),
        )
        return html, None
    except Exception as e:  # noqa: BLE001
        return None, _html_error(f"songbook render failed: {e}")


def harmony_doc(doc):
    """Harmonic analysis of a document dict, as a JSON response 3-tuple.

    Analyzes songs[0] only, matching render_target_doc's multi-song behavior
    (the corpus is one song per file; callers wanting another song slice the
    doc before POSTing).
    """
    import harmony

    songs = doc.get("songs", [])
    if not songs:
        return _json(400, {"error": "no songs in document"})
    try:
        return _json(200, harmony.analyze_song(songs[0]))
    except Exception as e:  # noqa: BLE001
        return _json(500, {"error": f"harmony analysis failed: {e}"})


def _build_chordmark_doc(doc, bars_per_line=4) -> str:
    """Build ChordMark source text for every song in a document dict."""
    import chordmark_render

    songs = doc.get("songs", [])
    return "\n\n".join(chordmark_render.render_song(s, bars_per_line=bars_per_line) for s in songs)


def _build_chordmark(song_path: Path, bars_per_line=4) -> str:
    """Build ChordMark source text for every song in a saved document."""
    doc = json.loads(song_path.read_text())
    return _build_chordmark_doc(doc, bars_per_line=bars_per_line)


def _build_chordpro_doc(doc) -> str:
    """Build ChordPro source text for every song in a document dict."""
    import chordpro_render

    songs = doc.get("songs", [])
    return "\n\n".join(chordpro_render.render_chordpro(s) for s in songs)


def _build_chordpro(song_path: Path) -> str:
    """Build ChordPro source text for every song in a saved document."""
    doc = json.loads(song_path.read_text())
    return _build_chordpro_doc(doc)


def render_song_doc(doc, bars_per_line=4, *, diagram_layout=None):
    """Render a document dict to ChordMark HTML via the fork (node render_chordmark.js).

    The doc-based core shared by the GET (from path) and POST (from body) routes.
    """
    import shutil
    import subprocess
    import tempfile

    import chordmark_render

    node = shutil.which("node")
    render_js = SCRIPTS / "render_chordmark.js"
    if not node or not render_js.exists():
        return _html_error("node or render_chordmark.js not found")

    def chart_source():
        sources, rows = [], []
        for song in doc.get("songs", []):
            source, song_rows = chordmark_render.render_chart_source(song, bars_per_line)
            sources.append(source)
            rows.extend(song_rows)
        return "\n\n".join(sources), rows

    chart_data = None
    try:
        # Include blank measures in the expected layout so the Fork cannot
        # silently drop them while assembling the chart.
        bar_counts = [
            len(bars)
            for song in doc.get("songs", [])
            for _, bars in chordmark_render._group_section_bars(
                song.get("sections", []), bars_per_line
            )
            if bars
        ]
        try:
            chordmark = _build_chordmark_doc(doc, bars_per_line)
        except chordmark_render.ChordMarkBarError:
            chordmark, chart_data = chart_source()
    except chordmark_render.ChordMarkBarError as e:
        return _html_error(str(e), status=422)
    except Exception as e:  # noqa: BLE001
        return _html_error(f"failed to build ChordMark: {e}")

    with tempfile.TemporaryDirectory() as tmp:
        cm_path = Path(tmp) / "song.chordmark"
        html_path = Path(tmp) / "song.html"
        command = [node, str(render_js), str(cm_path), str(html_path)]
        if diagram_layout is not None:
            command.extend(["--diagrams", diagram_layout])
        if bar_counts:
            command.extend(["--expected-bars", ",".join(map(str, bar_counts))])

        def render(source, rows):
            cm_path.write_text(source)
            html_path.unlink(missing_ok=True)
            invocation = command.copy()
            if rows is not None:
                chart_path = Path(tmp) / "chart.json"
                chart_path.write_text(json.dumps(rows))
                invocation.extend(["--chart-data", str(chart_path)])
            return subprocess.run(
                invocation,
                capture_output=True,
                text=True,
                timeout=60,
            )

        try:
            r = render(chordmark, chart_data)
            if r.returncode == 3 and chart_data is None:
                r = render(*chart_source())
        except chordmark_render.ChordMarkBarError as e:
            return _html_error(str(e), status=422)
        except subprocess.TimeoutExpired:
            return _html_error("fork render timed out")
        except (ValueError, OSError) as e:
            return _html_error(f"could not render Chord Chart: {e}")
        if r.returncode == 3:
            return _html_error(
                "ChordMark could not preserve the chart’s bar boundaries.", status=422
            )
        if r.returncode != 0 or not html_path.exists():
            return _html_error(f"fork render failed:\n{r.stderr or r.stdout}")
        return 200, "text/html", html_path.read_bytes()


def render_song_html(song_path: Path, bars_per_line=4, *, diagram_layout=None):
    """Render a saved song to ChordMark HTML via the fork (node render_chordmark.js)."""
    try:
        doc = json.loads(song_path.read_text())
    except Exception as e:  # noqa: BLE001
        return _html_error(f"failed to build ChordMark: {e}")
    return render_song_doc(doc, bars_per_line=bars_per_line, diagram_layout=diagram_layout)


def serve(songs_root: Path, port: int):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class Handler(BaseHTTPRequestHandler):
        def _run(self, method):
            length = int(self.headers.get("Content-Length", 0) or 0)
            body = self.rfile.read(length) if length else b""
            result = handle(method, self.path, body, songs_root)
            status, ctype, payload = result[0], result[1], result[2]
            extra = result[3] if len(result) > 3 else {}
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(payload)))
            for k, v in extra.items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):
            self._run("GET")

        def do_POST(self):
            self._run("POST")

        def log_message(self, *a):
            pass

    print(f"QA server on http://localhost:{port}  (songs: {songs_root})")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


def main():
    global PDF_DIR
    ap = argparse.ArgumentParser(description="Songsheet QA correction server")
    ap.add_argument("--songs", type=Path, default=ROOT / "data" / "joao-gilberto" / "songs")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument(
        "--pdfs",
        type=Path,
        help="album PDF dir for printed-diagram crops (default: sibling pdf/ of --songs)",
    )
    args = ap.parse_args()
    PDF_DIR = args.pdfs or args.songs.parent / "pdf"
    serve(args.songs, args.port)


if __name__ == "__main__":
    main()
