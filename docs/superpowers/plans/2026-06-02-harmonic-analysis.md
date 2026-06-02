# Harmonic Analysis & Visualization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (or executing-plans) to implement this task-by-task. Steps use `- [ ]` checkboxes.

**Goal:** Build a harmonic-analysis layer over the chord-anchored corpus and a live, interactive **Harmony** tab in the QA tool that shows harmony aligned to the lyrics — turning the digitized songs into *analyzable, audible, queryable* harmonic data, and laying the groundwork for chord-progression prediction later. This is the project's original purpose (the João Gilberto harmonic-analysis project).

**Architecture:**
- A **pure Python engine `scripts/harmony.py`** (no I/O, like `chordmark_render.py`): `song dict → annotated stream`. It is the single source of truth for all analysis; the server and any batch jobs call it.
- A thin server wrapper: `GET /api/harmony/<album>/<file>` and `POST /api/harmony-doc` (render the in-memory doc, for live/unsaved analysis) returning the annotated stream as JSON.
- A new **Harmony tab** in `qa_static/` rendering the harmony×lyrics view (the validated prototype — see "Prototype" below) reading that endpoint, with an **edit loop** back into the chord editor.
- A **corpus-insight batch** script producing the bossa-device quantification report.
- (Deferred) a **prediction** track built on the functional stream.

**Tech stack:** Python 3 + pytest (pure functions; reuse the voicing-decode + diagram logic already in `render_target.py`/`diagram.js`); vanilla JS / inline SVG / **Web Audio** for the tab (no build step, matches the existing tool); the existing dark theme.

---

## Design decisions (validated in the 2026-06-02 experiments — keep these)

1. **Notes-first chord quality.** Derive quality from the **decoded voicing** (intervals from the root), not the symbol text — so alterations survive (`A7+5`→`7♯5`, `9(♭5)`→`9♭5`, `DmM7(b5)`→`mMaj7♭5`) and the symbol parser's gaps (`/9` tensions, `69`) don't lose information. Cross-check against the printed symbol; disagreement → lower **confidence** + a discrepancy note (this also surfaced real voicing-entry/notation issues to fix).
2. **Cadence-based key/tonic.** Estimate the tonic as the chord most **targeted by ii–V–I / V–I resolutions**, not by Krumhansl pitch-class correlation (KS picked the *relative minor* F#m on "Garota", and tends to mis-fire on bossa's maj7-tonic + constant tonicization). Keep KS as a secondary signal; allow a **human override** in the UI. The corpus mostly lacks keys, so this estimator + a confirm pass is the gating dependency for everything key-relative.
3. **Function classification (context-aware).** Diatonic by degree+quality; **secondary dominant** by down-a-fifth resolution (`V7/x`); the **bluesy I7→IV** named explicitly (not generic "secondary"); diminished chords disambiguated as **common-tone / passing / leading-tone (= rootless V7♭9)** rather than a "borrowed" catch-all.
4. **Devices:** ii–V(–I), tritone substitution, **chromatic descending bass** runs, maj7 tonic. **Tonicization spans** derived from runs of secondary/ii–V motion at a non-tonic target.
5. **Representation:** model on **abstracted root+quality** and **key-relative function**; keep the raw symbol for display; pitch-class sets come from the voicings (our unfair advantage). (See `docs/superpowers/plans/` research notes in chat history for the prediction rationale.)
6. **Beats/timing:** assume **4 beats/bar**, distribute across a bar's chords by largest-remainder (matches `chordmark_render._distribute_beats`); `%` = re-strum of the carried chord. Used for the audio player's durations.

### Findings that justify the build
- **Garota de Ipanema:** cadence estimator → **C# major** (matches the stored key); KS wrongly chose F#m. ✓
- **Desde que o samba é samba (Voz e Violão):** 23 secondary dominants, 13 ii–V–I, and a **chromatic descending bass G–F#–F–E falling under the "tear" line** (genuine word-painting); notes-first caught 3 symbol/voicing discrepancies.
- **Corpus, key-free detectors (already trustworthy, no key needed):** 1,883 ii–V pairs · 420 tritone-sub candidates · 636 chromatic-bass runs (mean 3.45, max 7) across ~185 songs / 24.7k chord events.

---

## Phase A — analysis engine `scripts/harmony.py` (pure, tested)

- [ ] **A1 voicing decode.** `voicing_to_pitches(voicing)` → `{midis:[...], pcs:set, bass_pc, bass_midi}` using standard tuning open MIDI `[40,45,50,55,59,64]` (low→high), `x`=muted. Test against known shapes (open E, an up-neck Dm7).
- [ ] **A2 notes-first quality.** `quality_from_pitches(root_pc, pcs)` → a quality string (`maj7`,`7`,`7♯5`,`7♭9`,`9♭5`,`13`,`6/9`,`m7`,`m7♭5`,`mMaj7`,`mMaj7♭5`,`°7`,`sus4`,…) from intervals (3rd/5th/7th-or-6th + tensions ♭9/9/♯9/11/♯11/♭13/13). Tests with explicit voicings.
- [ ] **A3 symbol parse + reconcile.** Parse root + slash bass from the symbol; quality comes from A2; if the symbol root isn't in the pcs or the symbol-implied quality disagrees with the notes → set `confidence:"low"` + `discrepancy` note. Voicing-less entries → quality from symbol, `quality_source:"symbol"`. Tests incl. a deliberate disagreement.
- [ ] **A4 key/tonic (cadence-based).** `estimate_key(stream)` → `{tonic, mode, how, candidates}`: score each pc by how often it is the target of a detected V→I / ii–V–I; pick the max; include KS correlation as a secondary candidate list. Use the song's stored `key` if present (then this is a cross-check). Tests: Garota→C#, Desde→A; assert it does NOT return the relative minor.
- [ ] **A5 Roman + function.** `roman(root_pc, quality, tonic, bass_pc)` (degree map incl. ♭/♯ degrees, lowercase for minor, alterations appended, slash/inversion) and `classify_function(prev, cur, next, tonic)` → one of tonic/subdominant/dominant/secondary/passing/chromatic with a human label and the rule that fired (for the "why" text). Implements: diatonic-by-degree, secondary-dominant (down-a-fifth), bluesy I7→IV, diminished common-tone/passing/leading-tone. Tests for each case.
- [ ] **A6 device detectors.** ii–V and ii–V–I (min7 → dom7 +5 → maj +5), secondary dominants, tritone subs (dom7 resolving down a semitone), chromatic descending-bass runs (consecutive bass −1 semitone, return longest runs), maj7 tonics. Operate on the holds-resolved stream. Tests with crafted progressions.
- [ ] **A7 assemble.** `analyze_song(song)` → the **annotated stream**: per entry `{section, bar, beats, symbol, root, bass, quality, notes, midis, roman, function, func_label, why, devices, tonic_target, confidence, discrepancy?, text}` + `{key, key_how, key_candidates, summary:{counts...}}`. Beats via the 4/bar largest-remainder rule (port from chordmark_render). `%` carries the previous real chord's notes/midis. Test the full shape on a fixture song.

## Phase B — server endpoint
- [ ] **B1** `GET /api/harmony/<album>/<file>` and `POST /api/harmony-doc` (body = doc) → `analyze_song(songs[0])` as JSON; reuse `_safe_under`, 4-tuple not needed. Tests in `tests/test_qa_server.py` (200 + shape; traversal 400).

## Phase C — Harmony tab (frontend, incremental — port from the prototype)
The validated interactive prototype (all 10 features working, Playwright-verified) is preserved git-ignored at `experiments/harmonic-analysis/desde-viz.html` — **it is the UX target**; port its logic to read `/api/harmony` instead of inlined data.
- [ ] **C1 base:** new `Harmony` tab; render measures + chord cells + colour-coded Roman + lyrics from `/api/harmony` (holds as ties).
- [ ] **C2 lanes:** continuous **tension contour** (SVG), **bass lane**, **tonicization ribbon**.
- [ ] **C3 devices+spotlight:** device brackets with **pedagogical tooltips**; **spotlight** legend chips (functions + device types) dim non-matching.
- [ ] **C4 panel+confidence:** rich click panel (chord **diagram** from voicing + Roman/function + "why" + notes + devices + **confidence/discrepancy**); **confidence shading** on cells.
- [ ] **C5 audio:** Web Audio playback with **beat-accurate durations** + **continuously gliding playhead** (rAF, synced to the audio clock) + **sidebar follows the playhead**; pause keeps the cursor visible. (Port the validated logic; it's done in the prototype.)
- [ ] **C6 circle of fifths** companion (current root highlighted, fading trace).
- [ ] **C7 edit loop:** click a low-confidence/discrepancy chord → jump to the chord editor; **confirm/override the inferred key inline** → Roman numerals re-derive live (also write the confirmed key back to the song on Save, seeding the corpus keys).

## Phase D — corpus insights (batch)
- [ ] **D1** `scripts/harmony_report.py`: run `analyze_song` over the corpus → aggregate **device quantification** (ii–V density, tritone-sub rate, chromatic-bass run stats, maj7-tonic %, distinct-chord vocab) → Markdown + CSV. Key-free stats over all songs; functional stats over songs with a confirmed key.
- [ ] **D2** harmony×lyrics insights (exploratory): cadence↔line/rhyme-end alignment; chromatic-bass-descent ↔ longing words (Portuguese sentiment); reharmonization-on-repeat. Report findings.

## Phase E — prediction (deferred)
- [ ] **E1** variable-order Markov / n-gram on the **functional** stream → a "likely next chord" suggester (could surface as a hint in the Harmony tab and/or the editor). Interpretable, fits the small corpus.
- [ ] **E2** transfer learning: pretrain a small seq model on **iRb (~1,186 jazz tunes)** + jazz-filtered **CHORDONOMICON**, fine-tune on the bossa corpus; benchmark functional structure against the **Jazz Harmony Treebank**. (Hooktheory bulk data is ToS-gated.)

---

## Open decisions / risks
- **Key reliability is the gate.** Most songs have no key; the cadence estimator + a one-time **confirm pass in the QA tool** (C7) is the path to trustworthy key-relative analysis. Consider a batch key-suggester to seed values for review.
- **Beats = 4/bar** is a simplification (no time signatures in the model); fine for the player, not for strict metric analysis.
- **Copyright:** the corpus and any artifact embedding song chords/lyrics (incl. the prototype HTML + screenshots) stay **git-ignored** — never commit song content.
- **Prediction needs the functional layer solid first**; treat Phase E as a separate effort after A–C land.

## Recommended order
A (engine) → B (endpoint) → C1–C5 (the tab + audio, the visible payoff) → D1 (the novel corpus numbers) → C6/C7 polish + edit loop → E (prediction). A is the foundation everything else inherits; do its tests carefully.
