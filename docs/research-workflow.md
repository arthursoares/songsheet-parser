# From scans to a reviewable comparison

The implementation is kept in a branch stack. Each branch includes its predecessors:

1. `chore/remove-obsolete-skill-directives`: remove obsolete external workflow requirements.
2. `fix/protect-corpus-document-writes`: validated, atomic corpus saves and explicit replacement.
3. `feat/extraction-provenance`: schema v3 observation links, source fingerprints, and snapshots.
4. `feat/trustworthy-extraction-evaluation`: explicit denominators, full interval identity,
   ordered alignment, and frozen development/held-out manifests.
5. `feat/cross-album-research`: curated work identity and revision-specific comparisons.
6. `feat/hybrid-diagram-evidence`: native CV proposals with conservative pairing and diagnostics.
7. `feat/field-review-workflow`: field review, stale-state detection, source-linked crops,
   asynchronous edit protection, and integration with research eligibility.

## Candidate extraction

```bash
python scripts/validate_extraction.py Album.pdf --workdir .local/candidates/run-001
python scripts/materialize_songs.py --workdir .local/candidates/run-001 \
  --out .local/candidates/run-001/songs
python scripts/qa_server.py --songs .local/candidates/run-001/songs --pdfs data/<artist>/pdf
```

The original corpus is not the output directory. Every extraction retains source observations;
CV readings remain unreviewed proposals. Count mismatches or unreadable diagrams do not produce
guessed pairings. Recorded crop IDs survive unsaved entry moves. Legacy documents without
observation IDs retain their previous crop fallback; newly linked unpaired entries do not.

## Review and research

Use the Review tab to record the field, status, reviewer, and evidence. Verification is a
reviewer's declaration about current values, not a model confidence estimate. Changes make
the relevant verification stale. Undo/redo includes review annotations; Save does not discard
edits made while a request is pending. A document's Done status does not certify CV proposals.

Use [the corpus research CLI](corpus-research.md) for explicit work assignments and comparison
reports. A key must have a current explicit confirmation for Roman comparisons. Unsupported
chord notation stays literal; supported chords are compared using complete interval sets in
the project's Brazilian notation dialect. Reports include input and implementation hashes.

Use [frozen benchmarks](../README.md) for performance claims. Development and held-out membership
must be disjoint. Unreviewed labels, changed reference files, stale field checks, and unreviewed
printed-voicing references are refused. Historical calibration-song accuracy does not establish
held-out performance.

## Local Eclipse packet

The local `.local/research/eclipse/` directory contains an explicit work assignment, original
input fingerprints/snapshots, four source-page images, candidate copies, comparison reports,
and an unreviewed benchmark selection. These artifacts contain private source material and
are intentionally git-ignored. `build_candidates.py --output <fresh-directory>` reproduces
the candidates against the pinned original JSON and PDF fingerprints.

The packet records an assistant's partial source inspection and three correction proposals.
It does not mark either arrangement or any new held-out reference human-verified. Complete
musical/print review, particularly voicings, lyrics, unresolved page pairings, and keys, is the
remaining data-quality gate before validated cross-album findings or extraction accuracy claims.
