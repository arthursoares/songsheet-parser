# Extraction provenance and candidates

New extractions use schema version **3**. Older documents remain readable; a normal save
stamps the current version. The only new entry field is optional `observation_id`, linking
the editable occurrence to its source reading. Voicings still belong to occurrences and
lyrics remain anchored by entry order.

`_meta.extraction_sources` records the image content hash, provider/model, prompt hash,
implementation and schema hashes, SDK version, request options, and extraction timestamp.
`_meta.observations` retains exact chord/voicing/text readings and their original positions.
Both maps use content hashes as identifiers. Assembly adds the PDF hash and actual page
number in `_meta.page_sources`, protected by an assembly fingerprint. Per-song materialization
keeps the relevant observations and their source contexts. Imported older page results are
labelled `legacy_page_result`; missing model/input details are not invented.

An editorial edit changes an entry, not its observation. Moving an entry preserves its link.
Corpus saves check hashes and links, and reject deletion or alteration of evidence already
on disk. Even `materialize_songs --overwrite` cannot discard existing source evidence: use a
fresh candidate directory when re-extracting. Raw source readings are evidence of the page
extraction, not proof of what a recording contains or a claim of human verification.

## Cache and snapshot behavior

The direct parser CLI, whole-PDF validator, and evaluation `reparse` command share the same
cache implementation. A cached result is reused only if its image, prompt, provider/model,
code, schema, and SDK fingerprints match and its payload is intact. Rendering also tracks
the PDF bytes, DPI, renderer version/code, and output PNG hashes. Legacy caches without these
fingerprints are refreshed. `--force` requests another extraction even when inputs match.

Every new page extraction is saved under `extractions/*.snapshot` before the latest
`<page>.json` alias is published atomically. Snapshots contain ordinary UTF-8 JSON; their
reserved suffix keeps recursive song exporters from treating historical attempts as current
songs. Re-running extraction preserves previous snapshots. Snapshots can contain copyrighted
song data and belong with local/private working data.

Use separate candidate locations, for example:

```bash
python scripts/validate_extraction.py Album.pdf --workdir .local/candidates/run-001
python scripts/materialize_songs.py --workdir .local/candidates/run-001 \
  --out .local/candidates/run-001/songs
```

`.local/` is git-ignored. The corrected corpus is not modified by these commands. Fingerprints
make runs attributable and prevent stale cache reuse; they do not make a remote model
deterministic. Provider response IDs are currently unavailable and recorded as null.
