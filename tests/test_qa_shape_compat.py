import json
import subprocess

import pytest
import qa_shape_compat as compat
from qa_shape_edits import ShapeEditError


def test_node_browser_parity_accepts_match_and_rejects_mismatch():
    compat.check_shape_names(["C"], "x,3,2,0,1,0", explicit=True)

    with pytest.raises(ShapeEditError, match="does not match target voicing"):
        compat.check_shape_names(["G"], "x,3,2,0,1,0", explicit=True)


def test_node_browser_parity_rejects_invalid_explicit_name_only():
    with pytest.raises(ShapeEditError, match="invalid target chord"):
        compat.check_shape_names(["not-a-chord"], "x,3,2,0,1,0", explicit=True)

    compat.check_shape_names(["not-a-chord"], "x,3,2,0,1,0")


def test_node_invocation_is_fixed_and_uses_stdin_json(monkeypatch):
    seen = {}

    def run(command, **kwargs):
        seen.update(command=command, kwargs=kwargs)
        return subprocess.CompletedProcess(command, 0, '[{"valid":true,"match":true}]', "")

    monkeypatch.setattr(compat.subprocess, "run", run)

    compat.check_shape_names(["C"], "x,3,2,0,1,0", explicit=True)

    assert seen["command"] == ["node", "-e", compat._NODE_PROGRAM]
    assert seen["kwargs"]["cwd"] == compat._STATIC_DIR
    assert json.loads(seen["kwargs"]["input"]) == {
        "names": ["C"],
        "voicing": "x,3,2,0,1,0",
    }
    assert seen["kwargs"]["timeout"] == 5
    assert seen["kwargs"]["check"] is False


def test_python_fallback_covers_common_chords_and_skips_unknown_dialects(monkeypatch):
    monkeypatch.setattr(compat, "_node_results", lambda _names, _voicing: None)

    compat.check_shape_names(["C", "C/E"], "x,3,2,0,1,0", explicit=True)
    compat.check_shape_names(["C7/9"], "x,3,2,0,1,0", explicit=True)
    compat.check_shape_names(["C"], "x,x,x,x,x,x", explicit=True)

    with pytest.raises(ShapeEditError, match="does not match target voicing"):
        compat.check_shape_names(["G"], "x,3,2,0,1,0")


@pytest.mark.parametrize("name", ["", "H7", " C", "C 7", "C%", "C\u200b", "Cfoo", "C77/9garbage"])
def test_python_fallback_rejects_obviously_invalid_explicit_names(monkeypatch, name):
    monkeypatch.setattr(compat, "_node_results", lambda _names, _voicing: None)

    with pytest.raises(ShapeEditError, match="invalid target chord"):
        compat.check_shape_names([name], "x,3,2,0,1,0", explicit=True)


def test_invalid_voicing_is_rejected_before_node(monkeypatch):
    called = False

    def node(_names, _voicing):
        nonlocal called
        called = True

    monkeypatch.setattr(compat, "_node_results", node)

    with pytest.raises(ShapeEditError, match="invalid target voicing"):
        compat.check_shape_names(["C"], "x,3,2,0,1", explicit=True)
    assert called is False
