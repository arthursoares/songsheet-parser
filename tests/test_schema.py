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
    doc["songs"][0]["sections"][0]["bars"][0] = [{"voicing": "x,5,7,5,6,x"}]
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(doc, schema)


def test_voicing_must_be_comma_fret_form():
    schema = load_schema()
    doc = json.loads(FIXTURE.read_text())
    # old 6-char form is no longer valid; needs comma separation
    doc["songs"][0]["sections"][0]["bars"][0] = [{"chord": "Dm7", "voicing": "x5756x"}]
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(doc, schema)


def test_voicing_accepts_two_digit_frets():
    schema = load_schema()
    doc = json.loads(FIXTURE.read_text())
    # the fret>=10 case the old format could not express
    doc["songs"][0]["sections"][0]["bars"][0] = [{"chord": "F#maj7", "voicing": "x,9,11,10,11,9"}]
    jsonschema.validate(doc, schema)  # must not raise


def test_percent_continuation_is_valid_chord():
    schema = load_schema()
    doc = json.loads(FIXTURE.read_text())
    doc["songs"][0]["sections"][0]["bars"][0] = [{"chord": "%"}]
    jsonschema.validate(doc, schema)  # must not raise


def test_stray_key_on_song_is_rejected():
    schema = load_schema()
    doc = json.loads(FIXTURE.read_text())
    doc["songs"][0]["unexpected_field"] = "nope"
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(doc, schema)


def test_song_note_string_is_valid():
    schema = load_schema()
    doc = json.loads(FIXTURE.read_text())
    doc["songs"][0]["note"] = "remember to check bar 4 voicing"
    jsonschema.validate(doc, schema)  # must not raise


def test_song_note_non_string_is_rejected():
    schema = load_schema()
    doc = json.loads(FIXTURE.read_text())
    doc["songs"][0]["note"] = 42  # not a string
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(doc, schema)


def test_document_status_enum():
    schema = load_schema()
    doc = json.loads(FIXTURE.read_text())
    for s in ("pending", "in_progress", "done"):
        doc["document"]["status"] = s
        jsonschema.validate(doc, schema)  # valid values
    doc["document"]["status"] = "finished"  # not in enum
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(doc, schema)
