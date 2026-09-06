# Cross-album corpus research

`scripts/corpus_research.py` creates a reproducible JSON sidecar and a standalone HTML review
report without modifying song JSON. It catalogs an arrangement by its path relative to the corpus;
the SHA-256 records the exact revision separately. Album titles, PDF names, page counts, song titles,
composers, pages, and stored keys are observations from the documents. Release and recording dates
remain `null`; the tool does not infer facts about recordings from songbook order or filenames.

Work identity comes only from a curated manifest. Title and composer normalization may place records
in `candidate_groups`, but candidates remain unassigned until the manifest says otherwise:

```json
{
  "schema_version": 1,
  "works": {
    "work:eclipse-lecuona": {
      "title": "Eclipse",
      "composers": ["Ernesto Lecuona"]
    }
  },
  "assignments": {
    "06-mexico/13-eclipse.json": {
      "work_id": "work:eclipse-lecuona"
    },
    "15-voz-e-violao/03-eclipse.json": {
      "work_id": "work:eclipse-lecuona"
    }
  }
}
```

Generate the conservative report, which includes only documents whose status is `done`:

```bash
./.venv/bin/python scripts/corpus_research.py \
  --corpus data/joao-gilberto/songs \
  --manifest /tmp/work-assignments.json \
  --json /tmp/corpus-research.json \
  --html /tmp/corpus-research.html
```

Pending and in-progress material can be included for exploration, and is visibly marked provisional:

```bash
./.venv/bin/python scripts/corpus_research.py \
  --corpus data/joao-gilberto/songs \
  --manifest /tmp/work-assignments.json \
  --include-unreviewed \
  --voicing-field voicing_printed \
  --json /tmp/corpus-research.json \
  --html /tmp/corpus-research.html
```

`voicing` compares editorial fingerings. `voicing_printed` compares only literal printed evidence;
a missing printed value stays missing and never falls back to the editorial value. Comparisons use
ordered harmonic chord alignment, then report exact symbol matches, equivalent spellings, unaligned
spans, voicing differences, and physical-bass differences separately. Every source path and revision
hash is retained in the output.

A stored `song.key` is reported with its document provenance but does not enable Roman-numeral
comparison. That comparison requires a reviewed key with explicit evidence in each assignment:

```json
"confirmed_key": {
  "tonic": "B",
  "mode": "major",
  "evidence": "reviewed against printed key signature and final cadence"
}
```

The summary reports included and excluded arrangements, status exclusions, assignment coverage,
invalid files, and the number of comparable pairs. The review queue ranks missing evidence and
observed disagreements with deterministic priority points. Those points are triage weights, not
confidence estimates or probabilities.
