"""Pin harmony.py's symbol->interval vocabulary against the shared parity fixture.

The same fixture is asserted from the JS side (chord-symbol, the QA tool's
validator) by tests/js/chord_naming_parity.test.js, so the two chord-naming
vocabularies can't drift apart silently: 'agreed' symbols must keep producing
identical pitch-class sets in both, and 'divergent' symbols pin each side's
current deliberate behavior.
"""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from harmony import parse_symbol

FIXTURE = json.loads(
    (Path(__file__).resolve().parent / "fixtures" / "chord_name_parity.json").read_text()
)


def _pcs(symbol: str) -> list[int]:
    """Pitch classes (relative to root) that harmony.py reads from a symbol."""
    from harmony import _symbol_to_intervals

    parsed = parse_symbol(symbol)
    assert parsed is not None, f"harmony.py failed to parse {symbol!r}"
    qtext = parsed["qtext"]
    iv = _symbol_to_intervals(qtext)
    assert iv is not None, f"harmony.py read no intervals from {symbol!r}"
    return sorted(iv)


@pytest.mark.parametrize("case", FIXTURE["agreed"], ids=lambda c: c["symbol"])
def test_agreed_symbol_intervals(case):
    assert _pcs(case["symbol"]) == case["pcs"]


@pytest.mark.parametrize("case", FIXTURE["divergent"], ids=lambda c: c["symbol"])
def test_divergent_symbol_pins_python_side(case):
    assert _pcs(case["symbol"]) == case["python_pcs"]
