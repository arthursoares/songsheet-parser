import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "json_to_chordmark.py"
PY = ROOT / ".venv" / "bin" / "python"


def test_cli_writes_one_chordmark_per_song(tmp_path):
    doc = {
        "document": {"title": "Doc"},
        "songs": [
            {
                "title": "Chega de Saudade",
                "chords": {},
                "sections": [
                    {"label": None, "bars": [[{"chord": "Dm7", "text": "Vai"}]]}
                ],
            }
        ],
    }
    in_path = tmp_path / "doc.json"
    in_path.write_text(json.dumps(doc))
    out_dir = tmp_path / "out"

    result = subprocess.run(
        [str(PY), str(SCRIPT), str(in_path), "--output", str(out_dir)],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr

    produced = out_dir / "chega-de-saudade.chordmark"
    assert produced.exists()
    content = produced.read_text()
    assert "Dm7" in content
    assert "_Vai" in content
