#!/usr/bin/env python3
"""Deterministic chord-diagram reader for the Lumiar-typeset songbook pages.

The vision LLM tops out around 40% exact on voicings — the diagrams are
~36x22 px at the PDFs' native ~72 dpi and the model falls back to reciting
textbook shapes. But the typesetting is pixel-consistent, so the diagrams can
be READ instead of guessed:

  - horizontal grid: 6 horizontal string lines, TOP = high e, BOTTOM = low E;
    vertical lines separate fret columns (left to right)
  - thick left edge = nut (first column = fret 1); otherwise a shaded column
    carries the position
  - dots = fretted notes; BOLD string line = played, THIN grey = muted, so
    bold-with-no-dot = open; a tiny "o" under the nut additionally marks the
    low strings open when their line can't show it
  - the position digit under the grid is 4x5 px (unreadable-ish), so absolute
    frets are resolved HARMONICALLY instead: given the printed chord name,
    exactly one base fret in 1..12 makes the voicing's pitch classes contain
    the chord root (and best match its quality)

Works on the PDF's NATIVE embedded page image (no resampling blur):

    python scripts/diagram_reader.py "data/<artist>/pdf/Album.pdf" --page 1
    python scripts/diagram_reader.py page.png [--golden song.json]

Pure decoding (numpy on a grayscale array); only the CLI touches disk.
"""

import argparse
import json
from pathlib import Path

import numpy as np
from harmony import _symbol_to_intervals, parse_symbol

# Grayscale bands of the Lumiar rendering (empirical, stable across albums):
INK = 235  # anything darker is structure (incl. shading ~199)
LINE = 220  # grid lines (bold ~74-150, thin ~178-203)
DARK = 150  # dot cores incl. anti-aliased edge rows
BOLD_MAX = 170  # a played (bold) string line's interior mean is below this

OPEN_STRING_MIDI = [40, 45, 50, 55, 59, 64]  # low E -> high e


# ---------------------------------------------------------------------------
# page-level detection
# ---------------------------------------------------------------------------


def _components(mask):
    """Connected components (8-conn) of a boolean mask -> list of pixel lists."""
    h, w = mask.shape
    lab = np.zeros(mask.shape, dtype=int)
    out = []
    cur = 0
    for sy in range(h):
        for sx in range(w):
            if mask[sy, sx] and lab[sy, sx] == 0:
                cur += 1
                stack = [(sy, sx)]
                lab[sy, sx] = cur
                pts = []
                while stack:
                    y, x = stack.pop()
                    pts.append((y, x))
                    for dy in (-1, 0, 1):
                        for dx in (-1, 0, 1):
                            yy, xx = y + dy, x + dx
                            if 0 <= yy < h and 0 <= xx < w and mask[yy, xx] and lab[yy, xx] == 0:
                                lab[yy, xx] = cur
                                stack.append((yy, xx))
                out.append(pts)
    return out


def detect_diagrams(page):
    """Diagram bounding boxes (x0, y0, x1, y1) in reading order.

    A diagram is a connected ink component of grid-like size at native
    resolution (~22-60 px wide, ~14-40 tall). Reading order clusters boxes
    into visual rows by y-center, then left to right.
    """
    boxes = []
    for pts in _components(page < INK):
        ys = [p[0] for p in pts]
        xs = [p[1] for p in pts]
        x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
        if 22 <= x1 - x0 <= 60 and 14 <= y1 - y0 <= 40 and len(pts) > 80:
            boxes.append((x0, y0, x1, y1))
    boxes.sort(key=lambda b: (b[1] + b[3]) / 2)
    rows = []
    for b in boxes:
        yc = (b[1] + b[3]) / 2
        if rows and yc - np.mean([(c[1] + c[3]) / 2 for c in rows[-1]]) < 15:
            rows[-1].append(b)
        else:
            rows.append([b])
    return [b for row in rows for b in sorted(row, key=lambda b: b[0])]


# ---------------------------------------------------------------------------
# single-diagram decoding
# ---------------------------------------------------------------------------


def _string_line_clusters(sub):
    """The 6 string lines as clusters of adjacent full-width ink rows."""
    h, w = sub.shape
    cands = []
    for y in range(h):
        xs = np.where(sub[y] < LINE)[0]
        if len(xs) < 0.5 * w:
            continue
        runs = np.split(xs, np.where(np.diff(xs) > 2)[0] + 1)
        run = max(runs, key=len)
        if len(run) >= 0.5 * w:
            cands.append((y, run.min(), run.max()))
    if not cands:
        return None
    mx1 = int(np.median([c[2] for c in cands]))
    cands = [c for c in cands if abs(c[2] - mx1) <= 3]  # consistent right edge
    clusters = []
    for y, _rx0, _rx1 in cands:
        if clusters and y - clusters[-1][-1] <= 1:
            clusters[-1].append(y)
        else:
            clusters.append([y])
    if len(clusters) < 6:
        return None
    if len(clusters) == 6:
        return clusters
    best, bestv = None, 1e9  # the 6-run with the most uniform spacing
    for i in range(len(clusters) - 5):
        sel = clusters[i : i + 6]
        gaps = np.diff([np.mean(c) for c in sel])
        v = float(np.var(gaps)) + (0 if 3 <= np.mean(gaps) <= 7 else 100)
        if v < bestv:
            bestv, best = v, sel
    return best


def decode_diagram(page, box):
    """Decode one diagram. Returns (result, None) or (None, reason).

    result = {
      'pattern': 6 chars low-E..high-e, 'F' fretted / 'O' open / 'M' muted,
      'dot_cols': fret-column index per string (low-E first, None if no dot),
      'nut': bool, 'shaded': column index or None, 'n_cols': int, 'box': box,
    }
    """
    x0, y0, x1, y1 = box
    sub = page[y0 : y1 + 1, x0 : x1 + 1].astype(int)
    h, w = sub.shape
    clusters = _string_line_clusters(sub)
    if clusters is None:
        return None, "string lines not found"
    ys6 = [int(round(np.mean(c))) for c in clusters]
    spacing = (ys6[-1] - ys6[0]) / 5.0
    ex0, ex1 = [], []
    for c in clusters:
        xs = np.where(sub[c[0]] < LINE)[0]
        runs = np.split(xs, np.where(np.diff(xs) > 2)[0] + 1)
        run = max(runs, key=len)
        ex0.append(run.min())
        ex1.append(run.max())
    gx0, gx1 = int(np.median(ex0)), int(np.median(ex1))
    gy0, gy1 = clusters[0][0], clusters[-1][-1]

    region = sub[gy0 : gy1 + 1, gx0 : gx1 + 1]
    colink = (region < LINE).sum(axis=0)
    gh = gy1 - gy0 + 1
    vl = []
    for x in range(region.shape[1]):
        if colink[x] >= 0.8 * gh:
            if vl and x - vl[-1][-1] <= 1:
                vl[-1].append(x)
            else:
                vl.append([x])
    if len(vl) < 4:
        return None, f"only {len(vl)} fret lines"
    detected = [int(np.mean(v)) + gx0 for v in vl]
    nut = len(vl[0]) >= 2  # thick left edge
    # The typeset grid is uniform; thin grey fret lines are sometimes lost under
    # dot halos. Rebuild the full column grid from the median detected spacing
    # so a missed line can't shift every fret index after it.
    span = detected[-1] - detected[0]
    step = float(np.median(np.diff(detected)))
    n_cells = max(1, int(round(span / step)))
    vxs = [int(round(detected[0] + i * span / n_cells)) for i in range(n_cells + 1)]
    cells = list(zip(vxs[:-1], vxs[1:]))

    shaded = None  # grey-filled position column
    for j, (cx0, cx1) in enumerate(cells):
        if cx1 - cx0 < 3:
            continue
        mids = []
        for ya, yb in zip(ys6[:-1], ys6[1:]):
            band = sub[ya + 1 : yb, cx0 + 2 : cx1 - 1]
            if band.size:
                mids.append(np.median(band))
        if mids and 170 < np.median(mids) < 246:
            shaded = j
            break

    # dots: a vertical run of >=4 dark pixels through the string row
    # (lines are 1-2 px thick whatever their boldness; the nut is excluded)
    halfsp = max(2, int(spacing / 2) + 1)
    nut_x = vxs[0] if nut else None
    dotx = {}
    for i, yc in enumerate(ys6):
        best = (0, None)
        for x in range(max(0, gx0 + 1), min(w, gx1 + 4)):
            if nut_x is not None and abs(x - nut_x) <= 2:
                continue
            col = sub[max(0, yc - halfsp) : yc + halfsp + 1, x]
            run = th = 0
            for v in col:
                run = run + 1 if v < DARK else 0
                th = max(th, run)
            if th > best[0]:
                best = (th, x)
        if best[0] >= 4:
            dotx[i] = best[1]

    # bold/thin per string: darkest member row of the cluster, interior mean
    # (string lines render as 1-2 row clusters; the dark row carries the weight)
    rowmean = {}
    for i, c in enumerate(clusters):
        means = []
        for y in c:
            vals = [
                sub[y, x]
                for x in range(gx0 + 1, gx1)
                if not (i in dotx and abs(x - dotx[i]) <= 3)
                and not any(abs(x - v) <= 1 for v in vxs)
            ]
            if vals:
                means.append(np.mean(vals))
        rowmean[i] = min(means) if means else 255
    # "o" glyph under the nut marks low strings open when the line isn't bold
    o_rows = set()
    if nut:
        strip = sub[gy1 + 1 : min(h, gy1 + 7), max(0, gx0 - 3) : gx0 + 5]
        if strip.size and (strip < 200).sum() >= 3:
            o_rows.add(5)  # bottom string (low E)

    pattern = []
    dot_cols = []
    cw = (vxs[-1] - vxs[0]) / len(cells)
    for i in range(6):  # i=0 top (high e) .. 5 bottom (low E)
        if i in dotx:
            pattern.append("F")
            # dots render in the right half of their cell (peaks at ~0.6 and
            # ~1.0 of cell width, calibrated against the golden corpus), so
            # anchor the snap at 0.72cw instead of the cell center
            col = int(round((dotx[i] - vxs[0]) / cw - 0.72))
            dot_cols.append(max(0, min(len(cells) - 1, col)))
        elif rowmean[i] < BOLD_MAX or i in o_rows:
            pattern.append("O")
            dot_cols.append(None)
        else:
            pattern.append("M")
            dot_cols.append(None)
    # position digit: small glyph under the grid, beneath its anchor column
    # (too small to OCR generically at 4x5 px, but the font is identical across
    # all albums, so template matching against calibrated glyphs works)
    digit_bitmap, digit_col = None, None
    dy0, dy1 = gy1 + 2, min(h, gy1 + 10)
    if dy1 > dy0:
        strip = sub[dy0:dy1, max(0, gx0 + 4) : min(w, gx1 + 5)]
        ys, xs = np.where(strip < 190)
        if len(ys) >= 4:
            bx0, bx1 = xs.min(), xs.max()
            by0, by1 = ys.min(), ys.max()
            if bx1 - bx0 <= 10 and by1 - by0 <= 8:  # one compact glyph (or two)
                glyph = (strip[by0 : by1 + 1, bx0 : bx1 + 1] < 190).astype(int)
                digit_bitmap = glyph.tolist()
                cx = bx0 + (bx1 - bx0) / 2 + gx0 + 4
                digit_col = int(max(0, min(len(cells) - 1, round((cx - vxs[0]) / cw - 0.72))))
    return {
        "pattern": "".join(reversed(pattern)),
        "dot_cols": list(reversed(dot_cols)),
        "nut": nut,
        "shaded": shaded,
        "n_cols": len(cells),
        "digit_bitmap": digit_bitmap,
        "digit_col": digit_col,
        "box": box,
    }, None


# ---------------------------------------------------------------------------
# digit templates (auto-calibrated from golden-validated diagrams)
# ---------------------------------------------------------------------------

_TEMPLATES_PATH = Path(__file__).resolve().parent / "diagram_digits.json"


def _glyph_distance(a, b):
    """Hamming distance between two 0/1 bitmaps, aligned top-left, padded."""
    ha, wa = len(a), len(a[0])
    hb, wb = len(b), len(b[0])
    h, w = max(ha, hb), max(wa, wb)
    d = 0
    for y in range(h):
        for x in range(w):
            va = a[y][x] if y < ha and x < wa else 0
            vb = b[y][x] if y < hb and x < wb else 0
            d += va != vb
    return d


def match_digit(bitmap, templates):
    """Best (value, distance) against the template bank, or (None, None)."""
    if not bitmap or not templates:
        return None, None
    best, bestd = None, 10**9
    for value, glyphs in templates.items():
        for g in glyphs:
            d = _glyph_distance(bitmap, g)
            if d < bestd:
                bestd, best = d, int(value)
    return best, bestd


def load_digit_templates():
    if _TEMPLATES_PATH.exists():
        return json.loads(_TEMPLATES_PATH.read_text())
    return {}


# ---------------------------------------------------------------------------
# absolute frets
# ---------------------------------------------------------------------------


def voicing_for_base(decoded, base):
    """Comma voicing (low-E first) with fret-column 0 = fret `base`."""
    parts = []
    for p, col in zip(decoded["pattern"], decoded["dot_cols"]):
        if p == "M":
            parts.append("x")
        elif p == "O":
            parts.append("0")
        else:
            parts.append(str(base + col))
    return ",".join(parts)


def _pcs(voicing):
    out = set()
    for s, midi in zip(voicing.split(","), OPEN_STRING_MIDI):
        if s != "x":
            out.add((midi + int(s)) % 12)
    return out


def resolve_voicing(decoded, chord_name=None):
    """Absolute voicing string, or None if the base fret can't be fixed.

    Nut diagrams are absolute already (column 0 = fret 1). Position diagrams
    need a base: the printed digit is too small to read reliably, so the base
    is the unique fret in 2..12 whose pitch classes contain the chord root and
    best overlap the symbol's interval set. Returns (voicing, base, scored)
    where scored=False means nut/absolute (no harmonic guess involved).
    """
    sym = parse_symbol(chord_name) if chord_name else None
    root_pc = sym["root_pc"] if sym else None

    def root_ok(v):
        pcs = _pcs(v)
        return root_pc in pcs or (sym["bass_pc"] is not None and sym["bass_pc"] in pcs)

    if decoded["nut"]:
        v = voicing_for_base(decoded, 1)
        # A spuriously thick left edge can mimic a nut on a position diagram;
        # if the name contradicts fret-1 reading, fall through to base search.
        if sym is None or root_ok(v):
            return v, 1, False
    if sym is None:
        return None, None, False
    # position digit (template-matched) pins the base when the harmonic search
    # is ambiguous — dim7 shapes repeat every 3 frets, dominants often fit at
    # two positions
    digit_base = None
    if decoded.get("digit_bitmap") is not None and decoded.get("digit_col") is not None:
        value, dist = match_digit(decoded["digit_bitmap"], load_digit_templates())
        if value is not None and dist is not None and dist <= 6:
            digit_base = value - decoded["digit_col"]
    ivs = _symbol_to_intervals(sym["qtext"]) or set()
    target = {(root_pc + iv) % 12 for iv in ivs}
    best, bestscore = None, -1.0
    for base in range(1, 13):
        v = voicing_for_base(decoded, base)
        if not root_ok(v):
            continue
        pcs = _pcs(v)
        score = 10 + (len(pcs & target) if target else 0) - 0.1 * base
        if base == digit_base:
            score += 5  # the printed digit outranks harmonic preference
        if score > bestscore:
            bestscore, best = score, base
    if best is None:
        return None, None, False
    return voicing_for_base(decoded, best), best, True


def read_page(page, chord_names=None):
    """Decode every diagram on a page image (grayscale ndarray).

    chord_names, when given, is the printed chord name per diagram in reading
    order (used for base-fret resolution). Returns a list of dicts:
    {'box', 'pattern', 'voicing' (or None), 'base', 'harmonic_base', 'error'}.
    """
    out = []
    for k, box in enumerate(detect_diagrams(page)):
        dec, err = decode_diagram(page, box)
        if dec is None:
            out.append({"box": box, "error": err, "pattern": None, "voicing": None})
            continue
        name = chord_names[k] if chord_names and k < len(chord_names) else None
        voicing, base, scored = resolve_voicing(dec, name)
        out.append(
            {
                "box": box,
                "pattern": dec["pattern"],
                "voicing": voicing,
                "base": base,
                "harmonic_base": scored,
                "error": None,
            }
        )
    return out


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def load_page_image(path: Path, page_num: int = 1):
    """Native-resolution grayscale page: embedded image for PDFs, file for PNGs."""
    from PIL import Image

    if path.suffix.lower() == ".pdf":
        import fitz

        doc = fitz.open(path)
        imgs = doc[page_num - 1].get_images(full=True)
        if not imgs:
            raise SystemExit(f"page {page_num} has no embedded image")
        pix = fitz.Pixmap(doc, imgs[0][0])
        if pix.colorspace and pix.colorspace.n > 1:
            pix = fitz.Pixmap(fitz.csGRAY, pix)
        arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width)
        doc.close()
        return arr.astype(int)
    return np.asarray(Image.open(path).convert("L")).astype(int)


def main():
    ap = argparse.ArgumentParser(description="Read chord diagrams deterministically")
    ap.add_argument("input", type=Path, help="PDF or page PNG (native resolution)")
    ap.add_argument("--page", type=int, default=1, help="PDF page number (1-based)")
    ap.add_argument("--names", help="comma-separated chord names in reading order (for base frets)")
    ap.add_argument("--json", action="store_true", help="emit JSON")
    args = ap.parse_args()

    page = load_page_image(args.input, args.page)
    names = args.names.split(",") if args.names else None
    results = read_page(page, names)
    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
        return
    for k, r in enumerate(results):
        if r.get("error"):
            print(f"{k:3}  ERROR: {r['error']}  box={r['box']}")
        else:
            v = r["voicing"] or f"(relative pattern {r['pattern']})"
            tag = " (harmonic base)" if r.get("harmonic_base") else ""
            print(f"{k:3}  {v}{tag}")


if __name__ == "__main__":
    main()
