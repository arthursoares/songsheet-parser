#!/usr/bin/env python3
"""Rank recurring guitar fingering disagreements without editing the library."""

import argparse
import html
import re
import tempfile
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from itertools import zip_longest
from pathlib import Path

from chord_identity import strict_harm_key
from extraction_provenance import entries
from songsheet_io import load_document, publish_bytes

STRING_NAMES = ("low E", "A", "D", "G", "B", "high E")
MINOR_NINTH_FAMILY = re.compile(r"([A-G][#b♯♭]?)m(?:9|79|7/9|7\(9\))")


@dataclass(frozen=True)
class Occurrence:
    file: Path
    song_index: int
    title: str
    label: str
    section: int
    bar: int
    chord: int
    linked: bool

    @property
    def location(self):
        return f"Section {self.section + 1}, bar {self.bar + 1}, chord {self.chord + 1}"


@dataclass
class Group:
    editorial: str
    printed: str
    family: str | None
    matches: list[Occurrence] = field(default_factory=list)

    @property
    def songs(self):
        return {(item.file, item.song_index) for item in self.matches}

    @property
    def albums(self):
        return {item.file.parent for item in self.matches}

    @property
    def labels(self):
        return Counter(item.label for item in self.matches)

    @property
    def name(self):
        return f"{self.family} family" if self.family else self.labels.most_common(1)[0][0]


def collect_groups(root: Path):
    """Group exact disagreement pairs by chord identity or a named review family."""
    groups = {}
    counts = Counter()
    for path in sorted(root.glob("*/*.json")):
        if "-qa-" in path.stem:
            counts["qa_copies"] += 1
            continue
        try:
            doc = load_document(path)
        except (OSError, ValueError):
            counts["invalid_files"] += 1
            continue
        evidence = doc.get("_meta", {}).get("diagram_evidence", {})
        relative = path.relative_to(root)
        counts["songs"] += len(doc["songs"])
        for (song_index, si, bi, ei), entry in entries(doc):
            label = entry["chord"]
            editorial = entry.get("voicing")
            printed = entry.get("voicing_printed")
            if label == "%" or not editorial or not printed:
                continue
            counts["compared"] += 1
            if editorial == printed:
                continue
            counts["differ"] += 1
            match = MINOR_NINTH_FAMILY.fullmatch(label.strip())
            family = match.group(1).replace("♯", "#").replace("♭", "b") + "m9" if match else None
            identity = ("family", family) if family else strict_harm_key(label)
            key = (identity, editorial, printed)
            if key not in groups:
                groups[key] = Group(editorial, printed, family)
            groups[key].matches.append(
                Occurrence(
                    relative,
                    song_index,
                    doc["songs"][song_index]["title"],
                    label,
                    si,
                    bi,
                    ei,
                    entry.get("observation_id") in evidence,
                )
            )
    repeated = [group for group in groups.values() if len(group.songs) >= 2]
    repeated.sort(key=lambda g: (-len(g.songs), -len(g.matches), g.name, g.editorial, g.printed))
    return repeated, counts


def representative_crops(group, root, reader):
    examples = []
    by_album = defaultdict(dict)
    sampled_albums = set()
    # Within each album, inspect linked examples first. Cycle across albums
    # so an early album with missing evidence cannot consume the sample.
    for item in sorted(group.matches, key=lambda item: not item.linked):
        by_album[item.file.parent].setdefault((item.file, item.song_index), item)
    tried = 0
    for round_of_songs in zip_longest(*(songs.values() for songs in by_album.values())):
        for item in round_of_songs:
            if item is None or item.file.parent in sampled_albums:
                continue
            tried += 1
            crop = reader.crop_for(
                root / item.file,
                item.song_index,
                item.section,
                item.bar,
                item.chord,
                expected=(item.label, group.editorial, group.printed),
            )
            if crop:
                examples.append((item, crop))
                sampled_albums.add(item.file.parent)
            if len(examples) == 3 or tried == 12:
                return examples
    return examples


def _voicing_pair(group):
    first, second = group.editorial.split(","), group.printed.split(",")
    cells = [
        (string, editorial, printed, ' class="changed"' if editorial != printed else "")
        for string, editorial, printed in zip(STRING_NAMES, first, second, strict=True)
    ]
    return (
        '<table class="voicing"><thead><tr><th>Fingering</th>'
        + "".join(f'<th scope="col"{css}>{string}</th>' for string, _, _, css in cells)
        + '</tr></thead><tbody><tr><th scope="row">Current chart</th>'
        + "".join(f"<td{css}>{html.escape(value)}</td>" for _, value, _, css in cells)
        + '</tr><tr><th scope="row">Diagram reading</th>'
        + "".join(f"<td{css}>{html.escape(value)}</td>" for _, _, value, css in cells)
        + "</tr></tbody></table>"
    )


def _render_group(group, rank, examples, sampled):
    esc = html.escape
    titles = {item.title for item in group.matches}
    labels = " · ".join(f"{label} ({count})" for label, count in group.labels.most_common())
    search = " ".join((group.name, labels, group.editorial, group.printed, *sorted(titles)))
    rows = defaultdict(list)
    for item in group.matches:
        rows[item.file, item.song_index].append(item)
    occurrences = "".join(
        f"<li><b>{esc(matches[0].title)}</b> <small>{esc(path.as_posix())}</small>"
        f"<p>{esc(' · '.join(item.location + ' · ' + item.label for item in matches))}</p></li>"
        for (path, _song_index), matches in rows.items()
    )
    crops = "".join(
        f'<figure><img loading="lazy" src="{esc(crop["image"])}" alt="Chord diagram from {esc(item.title)}">'
        f"<figcaption><b>{esc(item.title)}</b><br>{esc(item.file.parent.name)} · page {crop['page']}"
        f"<br>{esc(item.location)} · {esc(item.label)}<br><small>{esc(crop['basis'])}</small></figcaption></figure>"
        for item, crop in examples
    )
    evidence = (
        f'<div class="examples">{crops}</div>'
        if crops
        else "<p>No reliable crop matched in the sample.</p>"
        if sampled
        else ""
    )
    return f'''
    <details class="group" id="group-{rank}" data-search="{esc(search)}">
      <summary>
        <span class="heading"><b>{esc(group.name)}</b><small>{esc(labels)}</small></span>
        <span class="pair">{esc(group.editorial)} → {esc(group.printed)}</span>
        <span class="count"><b>{len(group.songs)} songs</b><small>{len(group.matches)} occurrences · {len(group.albums)} albums</small></span>
      </summary>
      <div class="detail">
        {_voicing_pair(group)}
        {evidence}
        <details class="occurrences"><summary>Affected songs</summary><ul>{occurrences}</ul></details>
      </div>
    </details>'''


def render_report(groups, counts, examples, sampled_ranks):
    pilot = next((rank for rank, group in enumerate(groups, 1) if group.family == "Em9"), None)
    featured = ""
    if pilot is not None:
        group = groups[pilot - 1]
        featured = f"""<aside class="pilot">
          <div><b>Em9 pilot</b><small>{len(group.matches)} occurrences across {len(group.songs)} songs</small></div>
          <a href="#group-{pilot}">Open Em9 comparison</a>
        </aside>"""
    group_html = "".join(
        _render_group(group, rank, examples.get(rank, []), rank in sampled_ranks)
        for rank, group in enumerate(groups, 1)
    )
    skipped = (
        f" {counts['invalid_files']} invalid song files skipped." if counts["invalid_files"] else ""
    )
    crop_note = (
        " Scan examples are provided for the highest-ranked groups." if sampled_ranks else ""
    )
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Repeated chord disagreements</title>
<style>
:root{{color-scheme:light;--ink:#162231;--muted:#46556a;--line:#cfd8e4;--accent:#17598c;--paper:#fff}}
*{{box-sizing:border-box}}body{{margin:0;background:#eef3f8;color:var(--ink);font:15px/1.5 system-ui,sans-serif}}
main{{max-width:1120px;margin:auto;padding:32px 20px 60px}}h1{{font-size:clamp(28px,5vw,42px);margin:0 0 6px;line-height:1.15}}
p{{margin:0 0 12px}}a{{color:var(--accent)}}small{{color:var(--muted)}}
.metrics,.pilot,.tools,.group>summary{{display:flex;gap:14px;align-items:center;flex-wrap:wrap}}
.metrics,.pilot{{background:#e3effb;border:1px solid #b8cde4;border-radius:9px;padding:12px 15px;margin:16px 0}}
.metrics span{{font-variant-numeric:tabular-nums}}.pilot{{justify-content:space-between}}.pilot small{{display:block}}
.tools{{margin:18px 0 10px}}label{{display:flex;align-items:center;gap:8px}}
input{{color:var(--ink);background:var(--paper);border:1px solid #74879c;padding:7px 10px;border-radius:6px;min-width:15ch}}
.group{{background:var(--paper);border:1px solid var(--line);border-radius:8px;margin:0 0 8px;scroll-margin-top:10px}}
.group[open],.group:target{{border-color:var(--accent)}}.group>summary{{padding:10px 14px;cursor:pointer}}
.group>summary::before{{content:"▸";color:var(--accent)}}.group[open]>summary::before{{content:"▾"}}
.heading{{flex:1 1 180px}}.heading small,.count small{{display:block}}.pair{{font:14px ui-monospace,monospace}}
.count{{text-align:right;min-width:145px}}.detail{{border-top:1px solid var(--line);padding:14px}}
.voicing{{border-collapse:collapse;margin-bottom:10px}}.voicing th,.voicing td{{padding:4px 8px;border:1px solid var(--line);text-align:center}}
.voicing th:first-child{{text-align:left}}.voicing td{{font-family:ui-monospace,monospace}}.changed{{background:#fff1c9;font-weight:700}}
.examples{{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0}}figure{{margin:0;padding:8px;border:1px solid var(--line);border-radius:7px;max-width:245px}}
figure img{{display:block;max-width:100%;height:120px;object-fit:contain;margin:auto}}figcaption{{margin-top:6px;font-size:13px}}
.occurrences summary{{cursor:pointer;color:var(--accent)}}.occurrences ul{{margin:8px 0 0;padding-left:18px}}.occurrences li p{{font-size:13px;color:var(--muted)}}
[hidden]{{display:none!important}}@media(max-width:540px){{.group>summary{{gap:6px 12px}}.count{{text-align:left}}label{{flex-wrap:wrap}}}}
</style></head><body><main>
<h1>Repeated chord disagreements</h1>
<p>Compare current chart fingerings with recorded diagram readings. Each group shares a chord family and the same two fingerings.</p>
<div class="metrics"><span><b>{counts["songs"]:,}</b> songs indexed</span>
<span><b>{counts["compared"]:,}</b> fingerings compared</span>
<span><b>{len(groups):,}</b> groups across multiple songs</span></div>
<p><small>Ranked by distinct songs. {counts["qa_copies"]} QA copies excluded.{skipped}
Minor ninth spellings are grouped for review. Individual labels and slash basses are preserved.
Diagram readings and legacy pairings are evidence to check against the scan.{crop_note}</small></p>
{featured}
<div class="tools"><label>Filter groups <input id="filter" type="search" placeholder="Chord, fingering, or song"></label>
<span id="result" role="status">{len(groups):,} groups</span></div>
{group_html}
</main><script>
const groups = Array.from(document.querySelectorAll(".group"));
const filter = document.getElementById("filter");
const result = document.getElementById("result");
function filterGroups() {{
  const query = filter.value.trim().toLowerCase();
  let visible = 0;
  for (const group of groups) {{
    group.hidden = !group.dataset.search.toLowerCase().includes(query);
    if (!group.hidden) visible++;
  }}
  result.textContent = visible.toLocaleString() + (visible === 1 ? " group" : " groups");
}}
filter.addEventListener("input", filterGroups);
function openGroup() {{
  const group = document.getElementById(location.hash.slice(1));
  if (group && group.classList.contains("group")) {{
    filter.value = "";
    filterGroups();
    group.open = true;
    group.scrollIntoView();
  }}
}}
window.addEventListener("hashchange", openGroup);
openGroup();
</script></body></html>"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--songs", type=Path, required=True, help="per-song library directory")
    parser.add_argument("--pdfs", type=Path, help="source PDF directory for scan examples")
    parser.add_argument("--out", type=Path, required=True, help="local HTML report path")
    args = parser.parse_args()
    if not args.songs.is_dir() or (args.pdfs is not None and not args.pdfs.is_dir()):
        parser.error("the songs and supplied PDFs paths must be directories")
    if args.out.suffix.lower() != ".html":
        parser.error("--out must be an HTML file")

    groups, counts = collect_groups(args.songs)
    examples = {}
    sampled = set()
    if args.pdfs:
        from repeated_chord_crops import CropReader

        pilot = next((i for i, group in enumerate(groups, 1) if group.family == "Em9"), None)
        sampled = set(range(1, min(len(groups), 24) + 1))
        if pilot is not None:
            sampled.add(pilot)
        with tempfile.TemporaryDirectory(prefix="songsheet-review-") as cache:
            reader = CropReader(args.pdfs, Path(cache))
            for rank in sorted(sampled):
                examples[rank] = representative_crops(groups[rank - 1], args.songs, reader)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    publish_bytes(
        args.out, render_report(groups, counts, examples, sampled).encode(), overwrite=True
    )
    print(
        f"{len(groups)} repeated groups, {sum(map(len, examples.values()))} scan crops → {args.out}"
    )


if __name__ == "__main__":
    main()
