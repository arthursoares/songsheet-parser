import html
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "render_chordmark.js"
FORKS = (
    [Path(os.environ["CHORDMARK_REPO"])]
    if os.environ.get("CHORDMARK_REPO")
    else [ROOT.parent / "chordmark" / "chord-mark", ROOT / ".local" / "chordmark-runtime"]
)
RUNTIME = next(
    (
        fork
        for fork in FORKS
        if (fork / "packages" / "chord-mark" / "src" / "chordMark.js").is_file()
        and (fork / "node_modules" / ".bin" / "esbuild").is_file()
        and (fork / "node_modules" / "jsdom").is_dir()
    ),
    None,
)
pytestmark = pytest.mark.skipif(
    RUNTIME is None or not shutil.which("node"),
    reason="ChordMark CLI integration requires Node and the installed optional ChordMark fork",
)


def _render(tmp_path, source, chart_data, *options):
    input_path = tmp_path / "preview.chordmark"
    output_path = tmp_path / "preview.html"
    data_path = tmp_path / "chart.json"
    input_path.write_text(source)
    data_path.write_text(json.dumps(chart_data))
    result = subprocess.run(
        [
            "node",
            str(SCRIPT),
            str(input_path),
            str(output_path),
            "--chordmark-repo",
            str(RUNTIME),
            "--chart-data",
            str(data_path),
            *options,
        ],
        text=True,
        capture_output=True,
    )
    return result, output_path.read_text() if output_path.exists() else ""


def test_chart_data_restores_labels_blank_bar_many_slots_and_voicings(tmp_path):
    labels = ["A&B", "<i>not markup</i>", "C", "C", "%", "__proto__", "F", "G7"]
    voicing = [None, 0, 2, 2, 1, 0]
    chart_data = [
        [
            [{"name": "", "voicing": None}],
            [
                {"name": name, "voicing": voicing if index in (0, 1, 5) else None}
                for index, name in enumerate(labels)
            ],
            [{"name": "C", "voicing": [0, 3, 2, 0, 1, 0]}],
            [{"name": "C", "voicing": None}],
        ]
    ]

    result, rendered = _render(
        tmp_path,
        "C [C G] [C G] [C G] [C G] C G\n",
        chart_data,
        "--expected-bars",
        "4",
        "--diagrams",
        "both",
    )

    assert result.returncode == 0, result.stderr
    visible = html.unescape(re.sub(r"<[^>]*>", "", rendered))
    for label in labels:
        assert label in visible
    assert "not markup" in visible
    assert "<i>not markup</i>" in visible
    # Four distinct dictionary voicings plus four per-occurrence diagrams.
    assert rendered.count('<svg class="cmChordDiagram') == 8
    assert rendered.count('class="cmChordSymbol') == 11
    # The one source hold remains, without extra percent signs from the parser's
    # adjacent-bar repeat optimization.
    assert visible.count("%") == 1


def test_chart_data_rejects_exact_slot_count_mismatch(tmp_path):
    result, _ = _render(
        tmp_path,
        "[C G] [C G] [C G] [C G]\n",
        [[[{"name": "C", "voicing": None}]]],
        "--expected-bars",
        "1",
    )

    assert result.returncode == 3
    assert "has 1 slots; ChordMark parsed 8" in result.stderr


def test_chart_data_aligns_lyrics_across_an_empty_bar(tmp_path):
    result, rendered = _render(
        tmp_path,
        "C G C\n_hello _ _world\n",
        [
            [
                [{"name": "Am", "voicing": None}],
                [{"name": "", "voicing": None}],
                [{"name": "G7", "voicing": None}],
            ]
        ],
        "--expected-bars",
        "3",
    )

    assert result.returncode == 0, result.stderr
    assert rendered.count('class="cmBarSeparator"') == 4
    assert "hello" in rendered and "world" in rendered
    assert ">Am<" in rendered and ">G7<" in rendered
    assert ">G<" not in rendered


def test_cli_without_chart_data_keeps_the_existing_render_path(tmp_path):
    input_path = tmp_path / "source.chordmark"
    output_path = tmp_path / "source.html"
    input_path.write_text("Am7\n")

    result = subprocess.run(
        [
            "node",
            str(SCRIPT),
            str(input_path),
            str(output_path),
            "--chordmark-repo",
            str(RUNTIME),
            "--expected-bars",
            "1",
        ],
        text=True,
        capture_output=True,
    )

    assert result.returncode == 0, result.stderr
    assert ">Am7<" in output_path.read_text()
