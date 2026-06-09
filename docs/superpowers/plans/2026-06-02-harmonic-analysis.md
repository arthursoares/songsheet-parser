# Harmonic Analysis & Visualization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (or executing-plans) to implement this task-by-task. Steps use `- [ ]` checkboxes.
>
> **Revision 2 (2026-06-02):** hardened after a Codex review — added an event-normalization task (A0) and a dedicated voicing→pitch decoder (A1), made **confidence a first-class, early output**, added slash-bass reconciliation + key-spelling preservation + ambiguity handling, a stable per-entry index, multi-song-doc behavior, beat-distribution edge cases, and re-sequenced (C7 key-confirm before the D1 functional corpus report; audio/circle-of-fifths/sentiment deferred until the engine + core tab are stable). The single biggest correctness threat is **root/quality identification from sparse/rootless guitar voicings** — everything downstream cascades from it, so A1–A3 carry the most test weight.

**Goal:** Build a harmonic-analysis layer over the chord-anchored corpus and a live, interactive **Harmony** tab in the QA tool that shows harmony aligned to the lyrics — turning the digitized songs into *analyzable, audible, queryable* harmonic data, and laying the groundwork for chord-progression prediction later. This is the project's original purpose (the João Gilberto harmonic-analysis project).

**Architecture:**
- A **pure Python engine `scripts/harmony.py`** (no I/O, like `chordmark_render.py`): `song dict → annotated stream`. Single source of truth; the server and batch jobs call it.
- A thin server wrapper: `GET /api/harmony/<album>/<file>` and `POST /api/harmony-doc` (in-memory doc, for live/unsaved analysis) returning the annotated stream as JSON.
- A new **Harmony tab** in `qa_static/` rendering the harmony×lyrics view (port the validated prototype), with an **edit loop** back into the chord editor.
- A **corpus-insight batch** script producing the bossa-device quantification report.
- (Deferred) a **prediction** track built on the functional stream.

**Tech stack:** Python 3 + pytest (pure functions); vanilla JS / inline SVG / **Web Audio** for the tab (no build step); existing dark theme.

---

## Design decisions (validated 2026-06-02 + hardened by Codex review — keep these)

1. **Notes-first chord quality, with an explicit ambiguity path.** Derive quality from the **decoded voicing** (intervals from the root), not the symbol text — so alterations survive (`A7+5`→`7♯5`, `9(♭5)`→`9♭5`, `DmM7(b5)`→`mMaj7♭5`). BUT rootless / no-3rd / quartal / sparse voicings must NOT be over-named: when the notes don't determine a quality, return an **`ambiguous`/unknown** quality and **lower confidence** (fall back to the symbol-implied quality, flagged `quality_source:"symbol"`). Cross-check notes vs. the printed symbol; disagreement → low **confidence** + a `discrepancy` note (this also surfaces real voicing-entry/notation issues to fix).
2. **Cadence-based key/tonic — but defer to the stored key when present.** If the song has a `key`, use it (and treat cadence/KS as a cross-check). Otherwise estimate the tonic as the chord most **targeted by ii–V–I / V–I resolutions** (KS pitch-class correlation only as a *secondary* candidate — it picked the relative minor F#m on "Garota"). **Heavy-tonicization risk:** songs with many secondary ii–Vs can over-weight a tonicized target → if the winning margin is small, mark the key **low-confidence**. Allow a **human override** in the UI (C7). Preserve the key's **letter spelling** (sharps/flats), not just its pitch class, so Roman degrees/accidentals read correctly in C#/Db etc.
3. **Function classification (context-aware) with tie-breaks + confidence.** Diatonic by degree+quality; **secondary dominant** by down-a-fifth resolution (`V7/x`) — but do NOT over-call: an unresolved dominant or chromatic planing that doesn't actually resolve down a fifth is **not** a secondary (leave it `dominant`/`chromatic`, lower confidence). The **bluesy I7→IV** is named explicitly. Diminished chords disambiguated as **common-tone / passing / leading-tone (= rootless V7♭9)**; when more than one rule matches, apply a defined **tie-break order** and **lower confidence**.
4. **Devices:** ii–V(–I), tritone substitution, **chromatic descending bass** runs, maj7 tonic. **Tonicization spans** from runs of secondary/ii–V motion at a non-tonic target.
5. **Representation:** model on **abstracted root+quality** and **key-relative function**; keep the raw symbol for display; pitch-class sets from the voicings.
6. **Beats/timing:** assume **4 beats/bar**, distribute across a bar's chords by largest-remainder (port `chordmark_render._distribute_beats`) — but **never emit a 0-length chord**: if a bar has more chords than beats, fall back to an even fractional split. `%` = re-strum of the carried chord.
7. **Confidence is a first-class field on every entry**, set during analysis (ambiguous quality, notes↔symbol disagreement, small key margin, multi-match function/diminished, unresolved-dominant) — the UI's shading/tooltips/edit-loop depend on it, so it must exist from A7 on, not bolted on later.

### Findings that justify the build
- **Garota de Ipanema:** cadence estimator → **C# major** (matches the stored key); KS wrongly chose F#m. ✓
- **Desde que o samba é samba (Voz e Violão):** 23 secondary dominants, 13 ii–V–I, and a **chromatic descending bass G–F#–F–E falling under the "tear" line** (word-painting); notes-first caught 3 symbol/voicing discrepancies.
- **Corpus, key-free detectors (trustworthy now, no key needed):** 1,883 ii–V pairs · 420 tritone-sub candidates · 636 chromatic-bass runs (mean 3.45, max 7) across ~185 songs / 24.7k chord events.

---

## Phase A — analysis engine `scripts/harmony.py` (pure, tested)

- [x] **A0 Event normalization (do FIRST — data plumbing before theory).** Flatten `song → events` with: section index + label, **bar index**, a **stable per-entry id/index** (occurrence-unique, since repeated chords share a bar — the edit/jump loop needs exact identity), the raw `text`, and **`%` carry-forward** (each `%` event carries the previous *real* chord's symbol/notes; handle an orphan leading `%` — see `chordmark_render._resolve_leading_percent`). Compute **beats** per event via the 4/bar largest-remainder rule with the **no-zero-duration** guard (chords>beats → fractional). Tests: holds resolve, indices are unique & stable, beats per bar sum correctly incl. the >4-chords case.
- [x] **A1 Voicing→pitch decoder (dedicated; do NOT reuse the draw-only parsers).** `voicing_to_pitches(voicing)` → `{midis:[...], pcs:set, bass_pc, bass_midi}` from standard tuning open MIDI `[40,45,50,55,59,64]` (low→high), `x`=muted, missing/empty → empty result (not an error). NB the existing `render_target._parse_voicing`, `qa_static/diagram.js parse()`, and `chordmark_render.voicing_to_inline()` are draw/validate-only and don't decode pitches — write a fresh shared decoder. Tests: open E, an up-neck Dm7, a muted/partial voicing, empty/`%`.
- [x] **A2 Notes-first quality (+ ambiguity).** `quality_from_pitches(root_pc, pcs)` → quality string (`maj7`,`7`,`7♯5`,`7♭9`,`9♭5`,`13`,`6/9`,`m7`,`m7♭5`,`mMaj7`,`mMaj7♭5`,`°7`,`sus4`,…) from intervals (3rd/5th/7th-or-6th + tensions ♭9/9/♯9/11/♯11/♭13/13). If the 3rd or root is absent or the set is otherwise under-determined → return `ambiguous` (don't guess). Tests incl. a no-3rd/quartal voicing → `ambiguous`.
- [x] **A3 Symbol parse + reconcile + slash bass.** Parse root + **slash bass** from the symbol. Quality = A2 when notes are sufficient, else the symbol-implied quality (`quality_source:"symbol"`). **Reconcile bass:** keep both the symbol bass and the physical `bass_pc`; if they differ, expose it (affects inversion/tritone-sub labels) and lower confidence. If the symbol root isn't in `pcs` or symbol-quality disagrees with the notes → `confidence:"low"` + `discrepancy`. Voicing-less / `%` → symbol-based, flagged. Tests: a deliberate notes↔symbol disagreement, a slash chord, a Brazilian tension-slash name (`D#m7/9/A#`), a `%`.
- [x] **A4 Key/tonic.** `estimate_key(events, stored_key)` → `{tonic_pc, tonic_name (spelled), mode, how, margin, candidates}`. **If `stored_key` present → use it** (cadence/KS = cross-check). Else score each pc by how often it is the **target of a detected V→I / ii–V–I**, pick the max, include KS as a secondary candidate list; **small margin → low key-confidence**. Preserve letter spelling. Tests: Garota→C#, Desde→A, assert it does NOT return the relative minor, and a **negative test** with heavy tonicization (a tonicized region must not win over the true tonic) + a stored-key case (stored wins).
- [x] **A5 Roman + function.** `roman(root, quality, tonic_name, bass)` using the **spelled** key (degree map incl. ♭/♯, lowercase minor, alterations appended, slash/inversion from the reconciled bass). `classify_function(prev,cur,next,tonic)` → tonic/subdominant/dominant/secondary/passing/chromatic + human label + the **rule that fired** ("why" text). Rules: diatonic-by-degree; secondary-dominant **only on real down-a-fifth resolution** (else dominant/chromatic, lower confidence); bluesy I7→IV; diminished common-tone/passing/leading-tone with a **defined tie-break order** and confidence-drop on multi-match. Tests per case incl. an unresolved dominant (NOT secondary) and a multi-match diminished.
- [x] **A6 Device detectors.** ii–V and ii–V–I, secondary dominants, tritone subs (dom7 resolving down a semitone), chromatic descending-bass runs (consecutive bass −1, return longest), maj7 tonics. Operate on the holds-resolved stream. Tests with crafted progressions.
- [x] **A7 Assemble (+ confidence + tonicization).** `analyze_song(song)` → annotated stream: per event `{idx, section, bar, beats, symbol, root, bass, bass_physical, quality, quality_source, notes, midis, roman, function, func_label, why, devices, tonic_target, confidence, discrepancy?, text}` + `{key, key_name, key_how, key_margin, key_candidates, summary:{counts...}}`. **Confidence is computed here for every event** (ambiguous quality, notes↔symbol disagreement, bass mismatch, small key margin, multi-match function). Test the full shape + that low-confidence flags fire on the known-discrepancy fixtures.

## Phase B — server endpoint
- [x] **B1** `GET /api/harmony/<album>/<file>` and `POST /api/harmony-doc` (body=doc) → analysis as JSON; reuse `_safe_under` + the `_json()` 3-tuple shape. **Multi-song docs:** define behavior explicitly (analyze `songs[0]` by default, matching `render_target_doc`; optionally return a per-song list — pick one and document it). Tests: 200 + shape; traversal 400; bad-JSON 400 on the POST.

## Phase C — Harmony tab (frontend; port the prototype). Re-sequenced per review.
The validated prototype (git-ignored, `experiments/harmonic-analysis/desde-viz.html`) is the UX target.
- [x] **C1 base:** new `Harmony` tab; measures + chord cells + colour-coded Roman + lyrics from `/api/harmony` (holds as ties).
- [x] **C2 lanes:** continuous **tension contour** (SVG) + **bass lane** + **tonicization ribbon**.
- [x] **C3 devices+spotlight:** device brackets w/ **pedagogical tooltips**; **spotlight** chips (functions + device types) dim non-matching.
- [x] **C4 panel+confidence:** rich click panel (chord **diagram** from voicing + Roman/function + "why" + notes + devices + **confidence/discrepancy**); **confidence shading** on cells (consumes A7's confidence).
- [x] **C7 edit loop (BEFORE D1 — see below):** click a low-confidence/discrepancy chord → jump to the chord editor; **confirm/override the inferred key inline** (mutates the in-memory doc; persists via existing `POST /api/song`/`save_song`) → Roman numerals re-derive live. This is how the corpus gets confirmed keys.
- [ ] **C5 audio (DEFERRED until A/B/C1–C4 + C7 stable):** Web Audio playback, beat-accurate durations, continuously gliding playhead, sidebar-follows. (Logic already proven in the prototype — port it.)
- [ ] **C6 circle-of-fifths (DEFERRED with C5):** current-root highlight + fading trace.

## Phase D — corpus insights (batch) — depends on C7 for functional stats
- [ ] **D1** `scripts/harmony_report.py`: run `analyze_song` over the corpus → aggregate **device quantification** (ii–V density, tritone-sub rate, chromatic-bass run stats, maj7-tonic %, distinct-chord vocab) → Markdown + CSV. Key-free stats over all songs; **functional/Roman stats only over confirmed-key songs (hence C7 first).** Include a **corpus-runtime/memory check** (~24.7k events) so `analyze_song` scales.
- [ ] **D2 (DEFERRED):** harmony×lyrics insights — cadence↔line/rhyme-end alignment; chromatic-bass-descent ↔ longing words (Portuguese sentiment); reharmonization-on-repeat.

## Phase E — prediction (deferred)
- [ ] **E1** variable-order Markov / n-gram on the **functional** stream → "likely next chord" suggester (hint in the Harmony tab/editor). Interpretable, fits the small corpus.
- [ ] **E2** transfer learning: pretrain a small seq model on **iRb (~1,186 jazz tunes)** + jazz-filtered **CHORDONOMICON**, fine-tune on the bossa corpus; benchmark against the **Jazz Harmony Treebank** (Hooktheory bulk is ToS-gated).

---

## Open decisions / risks
- **Biggest correctness threat: root/quality from sparse/rootless voicings** (A1–A3) — Romans, functions, devices, tonicizations, and reports all cascade from it. Hence the ambiguity path + confidence + the heavy test weight there.
- **Key reliability is the gate.** Cadence estimator + the C7 confirm pass (before D1's functional stats). Consider a batch key-suggester to seed values for review.
- **Beats = 4/bar** is a simplification (no time signatures in the model); fine for the player, not strict metric analysis; never emit 0-length.
- **Confidence early** so the UI can rely on it.
- **Copyright:** the corpus and any artifact embedding song chords/lyrics (incl. the prototype + screenshots in `experiments/`) stay **git-ignored** — never commit song content.
- **Prediction (E) needs the functional layer solid first** — separate effort after A–C.

## Recommended order
**A0→A1→A2→A3** (the decoder + notes-first quality + reconcile — most test weight) → **A4→A5→A6→A7** (key, function, devices, assemble w/ confidence) → **B** → **C1→C2→C3→C4** (the visible payoff) → **C7** (key-confirm edit loop) → **D1** (the novel corpus numbers, now trustworthy) → **C5/C6** (audio + circle-of-fifths polish) → **D2 / E** (lyric-sentiment insights, prediction).
