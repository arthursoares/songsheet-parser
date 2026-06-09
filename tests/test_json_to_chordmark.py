import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "json_to_chordmark.py"
PY = ROOT / ".venv" / "bin" / "python"


def make_doc(title="Chega de Saudade"):
    return {
        "document": {"title": "Doc"},
        "songs": [
            {
                "title": title,
                "chords": {},
                "sections": [
                    {"label": None, "bars": [[{"chord": "Dm7", "text": "Vai"}]]}
                ],
            }
        ],
    }


def run_cli(*args):
    return subprocess.run(
        [str(PY), str(SCRIPT), *map(str, args)],
        capture_output=True, text=True,
    )


def test_cli_single_song_doc_is_named_after_the_file(tmp_path):
    in_path = tmp_path / "01-chega-de-saudade.json"
    in_path.write_text(json.dumps(make_doc()))
    out_dir = tmp_path / "out"

    result = run_cli(in_path, "--output", out_dir)
    assert result.returncode == 0, result.stderr

    produced = out_dir / "01-chega-de-saudade.chordmark"
    assert produced.exists()
    content = produced.read_text()
    assert "Dm7" in content
    assert "_Vai" in content


def test_cli_mirrors_album_subdirs_and_avoids_title_collisions(tmp_path):
    corpus = tmp_path / "songs"
    (corpus / "album-a").mkdir(parents=True)
    (corpus / "album-b").mkdir(parents=True)
    (corpus / "album-a" / "01-desafinado.json").write_text(
        json.dumps(make_doc("Desafinado"))
    )
    (corpus / "album-b" / "03-desafinado.json").write_text(
        json.dumps(make_doc("Desafinado"))
    )
    out_dir = tmp_path / "out"

    result = run_cli(corpus, "--output", out_dir)
    assert result.returncode == 0, result.stderr

    assert (out_dir / "album-a" / "01-desafinado.chordmark").exists()
    assert (out_dir / "album-b" / "03-desafinado.chordmark").exists()


def test_cli_multi_song_doc_falls_back_to_slugified_titles(tmp_path):
    doc = make_doc("Song One")
    doc["songs"].append(make_doc("Song Two")["songs"][0])
    in_path = tmp_path / "double.json"
    in_path.write_text(json.dumps(doc))
    out_dir = tmp_path / "out"

    result = run_cli(in_path, "--output", out_dir)
    assert result.returncode == 0, result.stderr

    assert (out_dir / "song-one.chordmark").exists()
    assert (out_dir / "song-two.chordmark").exists()
