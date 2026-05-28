import json
from pathlib import Path

import jsonschema
import pytest

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_PATH = ROOT / "schemas" / "songsheet.schema.json"
FIXTURE = ROOT / "tests" / "fixtures" / "chega-page1.json"


def load_schema():
    return json.loads(SCHEMA_PATH.read_text())


def test_valid_document_passes():
    schema = load_schema()
    doc = json.loads(FIXTURE.read_text())
    jsonschema.validate(doc, schema)  # raises on failure


def test_chord_entry_requires_chord():
    schema = load_schema()
    doc = json.loads(FIXTURE.read_text())
    doc["songs"][0]["sections"][0]["bars"][0] = [{"voicing": "x5756x"}]
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(doc, schema)


def test_voicing_must_be_six_chars():
    schema = load_schema()
    doc = json.loads(FIXTURE.read_text())
    doc["songs"][0]["sections"][0]["bars"][0] = [{"chord": "Dm7", "voicing": "xx"}]
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(doc, schema)


def test_percent_continuation_is_valid_chord():
    schema = load_schema()
    doc = json.loads(FIXTURE.read_text())
    doc["songs"][0]["sections"][0]["bars"][0] = [{"chord": "%"}]
    jsonschema.validate(doc, schema)  # must not raise
