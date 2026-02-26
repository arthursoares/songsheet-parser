# Quick Start: Two-Stage Hybrid Alignment

Get started with chord-syllable position markers in 3 steps.

---

## Prerequisites

```bash
# Ensure GEMINI_API_KEY is set
export GEMINI_API_KEY="your-key-here"

# Or add to ~/.bashrc
echo 'export GEMINI_API_KEY="your-key"' >> ~/.bashrc
```

---

## Basic Usage

### 1. Parse Songsheet (Stage 1)

```bash
cd /root/clawd/projects/songsheet-parser

python3 scripts/parse_songsheet.py \
  /root/clawd/output/songsheets/sample-11.png \
  --output data/joao-gilberto/json/
```

**Output:** `data/joao-gilberto/json/sample-11.json` with bar structure

---

### 2. Add Position Markers (Stage 2)

```bash
python3 scripts/add_positions.py \
  data/joao-gilberto/json/sample-11.json \
  --image /root/clawd/output/songsheets/sample-11.png
```

**Output:** Updates JSON in-place with `chord_positions` field

**Expected:**
```
🎵 Processing 1 files
📄 sample-11.json
   14 bars need position alignment
   ✓ Bar 2: 2 positions
   ✓ Bar 5: 2 positions
   ...
   💾 Saved 14 position annotations
```

---

### 3. Generate ChordMark

```bash
python3 scripts/json_to_chordmark.py \
  data/joao-gilberto/json/sample-11.json \
  --output data/joao-gilberto/chordmark/ \
  --no-merge
```

**Output:** `data/joao-gilberto/chordmark/nao-vou-pra-casa-sample-11.chordmark`

**Result:**
```
Bmaj7.. Fdim7..
_um a-mor a- _en tao nao vou pra ca
```

---

## Batch Processing

### Process Entire Directory

```bash
# Add positions to all songs
python3 scripts/add_positions.py \
  data/joao-gilberto/json/ \
  --image-dir /root/clawd/output/songsheets/

# Generate all ChordMark files
python3 scripts/json_to_chordmark.py \
  data/joao-gilberto/json/ \
  --output data/joao-gilberto/chordmark/
```

---

## Command Reference

### add_positions.py

```bash
# Single file
python3 scripts/add_positions.py FILE.json --image IMAGE.png

# Multiple files
python3 scripts/add_positions.py file1.json file2.json --image-dir images/

# Entire directory
python3 scripts/add_positions.py data/artist/json/ --image-dir output/songsheets/

# Dry run (see what would be processed)
python3 scripts/add_positions.py data/artist/json/ --dry-run

# Custom API key
python3 scripts/add_positions.py FILE.json --image IMAGE.png --api-key "key"
```

### json_to_chordmark.py

```bash
# Single file (don't merge pages)
python3 scripts/json_to_chordmark.py FILE.json -o output/ --no-merge

# Multiple files (merge multi-page songs)
python3 scripts/json_to_chordmark.py data/artist/json/*.json -o output/

# Entire directory (merge by title)
python3 scripts/json_to_chordmark.py data/artist/json/ -o output/
```

---

## Checking Results

### View JSON Positions

```bash
# See positions in one bar
python3 << 'EOF'
import json
data = json.load(open("data/joao-gilberto/json/sample-11.json"))
for i, bar in enumerate(data["bars"]):
    if bar.get("chord_positions"):
        print(f"Bar {i+1}: {bar['lyrics']}")
        for pos in bar["chord_positions"]:
            print(f"  {pos['chord']} at '{pos['at_syllable']}'")
        break
EOF
```

### View ChordMark Output

```bash
cat data/joao-gilberto/chordmark/nao-vou-pra-casa-sample-11.chordmark
```

Look for `_` markers in lyric lines:
- `_um a-mor` → chord changes at "um"
- `_en tao` → chord changes at "en"

---

## Troubleshooting

### "No image found"

```bash
# Check source field in JSON
python3 -c "import json; print(json.load(open('FILE.json'))['source'])"

# Provide image path explicitly
python3 scripts/add_positions.py FILE.json --image /path/to/image.png
```

### "Model not found" error

Script uses `gemini-2.0-flash`. If unavailable, edit `scripts/add_positions.py`:

```python
# Line ~177
model = genai.GenerativeModel("gemini-2.0-flash")

# Change to:
model = genai.GenerativeModel("gemini-flash-latest")
```

### Low success rate

Check:
1. Image quality (legible text?)
2. Lyrics accuracy (OCR issues?)
3. Bar structure (Stage 1 parsed correctly?)

View warnings:
```bash
python3 scripts/add_positions.py ... 2>&1 | grep "⚠️"
```

### "Syllable not found" warnings

**Normal!** Model may see slightly different text than Stage 1 OCR.

- Minor differences are okay (marker insertion handles gracefully)
- If many warnings, check OCR quality in Stage 1

---

## Cost Estimates

**Per song:**
- ~10 bars needing alignment
- ~$0.0001 per bar
- **Total: ~$0.001 per song**

**100 songs:** ~$0.10  
**1000 songs:** ~$1.00

Very affordable for production use.

---

## Next Steps

1. **Process your catalog:**
   ```bash
   python3 scripts/add_positions.py data/artist/json/ --image-dir images/
   python3 scripts/json_to_chordmark.py data/artist/json/ -o output/
   ```

2. **Review output:**
   - Check ChordMark files for `_` markers
   - Verify alignment looks correct
   - Note any systematic errors

3. **Iterate:**
   - Fix Stage 1 OCR issues if needed
   - Re-run Stage 2 on updated JSONs
   - Build correction UI for edge cases

---

## Documentation

- **TWO_STAGE_HYBRID_IMPLEMENTATION.md** - Full implementation details
- **ARCHITECTURE.md** - Technical architecture
- **EXAMPLES.md** - Visual examples and edge cases
- **QUICKSTART.md** - This file

---

## Support

Questions? Issues?

1. Check JSON structure: `cat data/artist/json/FILE.json | jq .bars[0]`
2. Verify image exists: `ls -lh /path/to/image.png`
3. Test single bar: Use `--dry-run` first
4. Check logs: Look for `❌` and `⚠️` messages

Happy parsing! 🎵
