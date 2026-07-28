---
title: "feat: Director waveform-referenced cutting (round 6)"
type: feat
date: 2026-07-17
depth: deep
---

# feat: Director waveform-referenced cutting (round 6)

## Summary

Make the RMS energy envelope a first-class cutting signal in the Director. Removal boundaries swallow the pause around them (leaving a room-tone handle) instead of leaving residual silence; long pure-silence blocks are cut automatically without the VAD model; Whisper hallucinations over silence are detected and quarantined; the two content-destroying bug classes from the 2026-07-17 live test (phrase-repeat n-gram false positives, second-pass pacing spans containing speech) are fixed; and the clamp evidence set learns about silence so the correct big cuts stop being demoted. Deterministic-only round: no LLM prompt changes or prompt-version risk; cache keys shift only on inputs where the hallucination guard flags content (KTD7).

## Problem Frame

Dan's first live AI CUT run (join-the-group clip, root-caused in docs/LIVE-TEST-ISSUES.md items 1-4 and reproduced by apps/web/scripts/diag-join-the-group.ts) produced 6 auto cuts on footage needing only a head trim: two mid-sentence amputations from 4-word n-gram matches across different sentences, one second-pass pacing op swallowing a whole spoken sentence, pause tightens that left 0.5-0.7s of silence on each side of every join, and a 24s dead-air tail that survived because Whisper hallucinated "Thank you." segments over it while the LLM's correct dead-outro cut was clamp-demoted to an unchecked row. Every decision about WHAT to cut is currently transcript-only; the envelope reaches just 3 of ~15 pipeline sites (noise-fragment, the VAD energetic test, snapRemovalOps). Dan's directive: read the audio waveform and cut precisely; a join that needs a crossfade was cut wrong.

---

## Requirements

**Cut placement (hard cuts and silences)**

- R1. No AUTO-accepted removal from a gap-derived family (pacing, second-pass sp- gap ops, envelope/VAD dead-air, noise, tiny-clip shards, swallow-pause widening) may contain the midpoint of a real (non-hallucinated) word. Transcript-content families (filler, duplicate, repeat, redundancy, context, retake, LLM plan cuts) legitimately contain the word midpoints of the content they remove. No removal boundary from ANY family may land strictly inside a real word. Zero mid-sentence amputations from gap-derived cuts on the diag replay.
- R2. Every removal boundary adjacent to a pause swallows the pause, leaving at most HANDLE_SEC (0.15s) plus one envelope window (0.05s) of silence in the kept footage on that side. Boundaries in continuous speech snap to the local energy trough within 0.25s and never land inside a word. No crossfades: placement precision is the bar.
- R3. Long pure-silence blocks (at or above 2.5s, hallucination-guarded, zero real words inside) are cut automatically with a keep-a-beat pad, with no dependency on the VAD model (works whether or not the Silero pass ran or produced gaps). Edge gaps (timeline head/tail) cut flush at a 0.5s floor. A block covering more than 0.8 of the timeline stays opt-in.

**Transcription trust**

- R4. Transcript spans whose audio is silence (Whisper hallucinations, e.g. the 30s "Thank you." segments with 9-21s single words) are detected from the envelope and excluded from speech-presence math, per-segment features, and the LLM catalogs; their spans become silence-eligible for R3.

**Detector precision**

- R5. Phrase-repeat auto-cuts only when the two occurrences' containing segments are near-identical (whole-segment similarity at or above HIGH_SIMILAR = 0.8, true retakes). N-gram-only matches demote to unchecked review rows. Implements the standing repeat-brainstorm decision that lexical detectors are fallback, not primary.
- R6. Pacing and gap-derived second-pass removal spans (categories pacing and deadair) never contain a real word's midpoint: spans are split into word-free sub-spans or dropped at emission (pacing) and after inverse remapping (second-pass). Content-derived second-pass ops (filler, duplicate, repeat) keep their word-removing function, and second-pass phrase-repeat matches get the same similarity gate as pass 1 (R5). The 3.75s sentence-swallowing sp- op class is impossible by construction.
- R7. The clamp evidence set includes envelope dead-air runs and hallucinated spans, so an LLM plan cut whose interior is silence (the 24s dead-outro) is shrunk to evidence and ships AUTO instead of being demoted.

**Process and gates**

- R8. Gates. Per unit: suites green (692 director + 174 hf-bridge, counts approximate, plus new tests), bunx tsc --noEmit clean, and the unit's own Verification bullet. At round end, additionally: (a) diag replay assertions pass (R1-R3 checked mechanically; the assertion tooling is a U7 deliverable, so this gate runs once U7 lands); (b) the four-fixture eval (noise-adjusted match guarded by raw, per plan 2026-07-16-001 R8) does not regress OFFERED match and does not increase AUTO essential-words-lost on any fixture; (e) the hands-on smoke pass from docs/LIVE-TEST-ISSUES.md's definition of done: import the join-the-group clip, run AI CUT with defaults, open review, play every join, and record the listened verdict in Addendum 6.
- R9. New modules are pure, bun-tested, import no @/wasm/canvas/mediabunny, take seconds in and out (plan 2026-07-16-001 R9 convention).
- R10. No em dashes in code or docs. No LLM prompt wording changes this round (no prompt-version bumps needed). No new DirectorOpCategory (reuse "deadair", "pacing", "repeat"); if implementation finds one necessary, the four-piece checklist applies (author.ts union, taste.ts CATEGORIES + CATEGORY_LABEL, review badge, justify-cuts allow-list).

---

## Key Technical Decisions

- KTD1. **Silence source of truth is the shared 0.05s RMS envelope with an adaptive threshold.** Threshold = min(0.015, median(per-segment speech energies) x 0.5), where the median is computed ONLY over segments that pass KTD3's text-side absurdity screen (word duration and wpm are computable without the energy threshold, breaking the circularity that hallucinated near-zero-energy segments would otherwise drag the median toward 0 on hallucination-heavy footage). 0.015 linear RMS mirrors the standalone Remove Silences detector (remove-silences.ts RMS_THRESHOLD); the median fallback (noise-fragment.ts precedent) handles quiet recordings, since envelope values are raw per-file RMS, not normalized. No VAD model is required for any of this; the envelope is already computed on every run.
- KTD2. **Swallow-then-snap boundary policy.** For each removal edge, walk outward through contiguous sub-threshold windows and stop at the neighboring real word's boundary plus HANDLE_SEC = 0.15s (mirrors remove-silences PADDING_SEC). Only widen, never shrink. If the edge sits in continuous speech (no sub-threshold window adjacent), fall back to today's trough snap (0.25s search). refineCutWordBounds stays downstream as the word-safety backstop. This replaces the call-site behavior of snapRemovalOps for Director removals; snapKeepSpans (Highlight mode) is untouched.
- KTD3. **Hallucination criteria are conservative (AND, not OR).** A segment is flagged only when its mean envelope energy is below the KTD1 threshold AND it shows a transcription absurdity (any single word longer than 3s, or segment wpm below 30 over a span of 5s or more). Real quiet speech survives. Fail-open: no envelope or no words means no flagging.
- KTD4. **AUTO silence re-entry is narrow and cut-storm-proof by construction.** Only the new envelope dead-air detector emits AUTO silence cuts, only for runs at or above 2.5s containing zero real (post-guard) words, padded 0.15s per side, edge gaps flush at a 0.5s floor, whole-timeline fraction above 0.8 demoted to opt-in (all mirroring vad-dead-air's guards). The 2026-07-04 cut-storm came from unguarded hard splices at every 0.6s pause; this pass cannot remove a word because a run containing a word is not eligible. Dan approved AUTO for this class on 2026-07-17.
- KTD5. **Phrase-repeat similarity gate lives at emission.** detectPhraseRepeatCuts gains an optional segments parameter; each match locates both occurrences' containing segments and computes similarity() (text-similarity.ts, 0.3 jaccard + 0.7 cosine). At or above HIGH_SIMILAR the op keeps its current always-AUTO backstop; below it the op is emitted with defaultAccept: false. Aligns with brainstorm 2026-06-23 R7 (LLM redundancy pass is the primary repeat catcher; lexical detectors are fallback).
- KTD6. **Word-guard is a shared pure helper applied in both pacing domains.** stripWordsFromRemoval(op, words) splits a removal span on real-word midpoints into word-free sub-spans (dropping fragments under 0.2s, mirroring remove-silences MIN_REMOVED_SEC). Applied at detectPacingCuts emission (original domain) and in second-pass after inverseRemapTime (original domain, original words), which kills the asymmetric-remap re-expansion bug regardless of how segment and word boundaries diverge.
- KTD7. **Pipeline placement.** Hallucination guard runs first (before detectors and feature consumers); envelope dead-air joins the deterministic detector block; the swallow pass replaces the snapRemovalOps call site (after verify, before refineCutWordBounds); clamp evidence gains envelope dead-air + hallucinated spans at the existing call-site array (clamp-cut-extent.ts itself is unchanged). All deterministic, no prompt changes: adapter payloads and eval cache keys are byte-identical on inputs the hallucination guard does not flag. On flagged inputs the catalog changes ARE the feature, and cached LLM responses re-prime; U1's verification records per-fixture guard hit counts so Addendum 6 attributes eval movement correctly.
- KTD8. **Measurement per prior rounds.** Foreground per-fixture eval runs with .eval-cache resume; the diag replay is the round's acceptance harness; variance-sensitive comparisons use --runs 3 (handoff lesson: structural cache re-rolls on config changes).

---

## High-Level Technical Design

```mermaid
flowchart TB
  A[words + segments + envelope] --> HG[U1 hallucination-guard\ncleanWords / cleanSegments / halluSpans]
  HG --> DET[deterministic detectors\nduplicate, dead-air, filler, pacing*, repeat*, segment-repeat,\nnoise, tiny-clip, vad-dead-air (defaults on)]
  HG --> EDA[U2 envelope-dead-air\nAUTO cuts for pure-silence runs >= 2.5s]
  EDA --> DET
  DET --> PLAN[LLM plan pass]
  PLAN --> CLAMP[clampCutExtent\nevidence += envelope dead-air + halluSpans U6]
  CLAMP --> MERGE[merge x2, redundancy, context]
  MERGE --> SP[second pass\n+ U5 word-guard after inverse remap]
  SP --> RETAKE[retake fold, structural fold, verify]
  RETAKE --> SWALLOW[U3 swallow-pause\nwiden edges thru silence to word +/- 0.15s handle,\nfallback trough snap in speech]
  SWALLOW --> REFINE[refineCutWordBounds -> resolveTrimVsCut -> justifyCuts]
  REFINE --> OPS[operations]
```

pacing* and repeat* carry their own unit changes (U5 word-guard at emission, U4 similarity gate).

---

## Implementation Units

### U1. Hallucination guard

- **Goal:** Detect transcript spans whose audio is silence and quarantine them from every speech-presence consumer.
- **Requirements:** R4, R9.
- **Dependencies:** none.
- **Files:** new `apps/web/src/features/ai-generate/director/hallucination-guard.ts`; new `apps/web/src/features/ai-generate/director/__tests__/hallucination-guard.test.ts`; modify `apps/web/src/features/ai-generate/director/build-director-proposals.ts` (wire before detectors/features/catalogs).
- **Approach:** Pure function taking words, segments, envelope, windowSec; returns cleanWords, cleanSegments, surviving segment INDICES, and hallucinatedSpans (seconds). Flag a segment per KTD3 (low mean energy AND absurd word duration or wpm); the median threshold input is pre-screened per KTD1. Words inside flagged segments are excluded from cleanWords. Wiring mechanism: features arrives as a precomputed segments-parallel input (computed upstream in run-director.ts and the eval fixture loader; build-director-proposals never calls computeSpeechFeatures), so the guard's surviving indices filter the features array in build-director-proposals, and every downstream features consumer (signal table, take clusters, importance, median speech energy) sees only clean rows without touching run-director.ts. cleanWords/cleanSegments feed the deterministic detectors and the LLM catalogs (signal table, redundancy/retake/structural line catalogs); hallucinatedSpans feed U2 eligibility and U6 evidence. The original arrays remain available where full-timeline geometry is needed (clip spans, totalSec).
- **Patterns to follow:** fail-open convention of refine-cut-words/justify-cuts (no envelope or no words: return inputs unchanged); meanEnergyOverRange from audio-features.ts for span energy.
- **Test scenarios:**
  - The live-run tail: segment "Thank you." 59.92-89.9 with words Thank 59.92-69.2 / you. 69.2-89.9 over a near-zero envelope: flagged; both words excluded; hallucinatedSpans covers 59.92-89.9.
  - Real quiet speech: a 2s segment at low-but-plausible energy with normal word durations (0.2-0.6s) and wpm 150: NOT flagged (absurdity criterion fails).
  - Loud absurd word: a 9s single word over high energy: NOT flagged (energy criterion fails; it is real audio, maybe music).
  - Empty envelope: inputs returned unchanged, hallucinatedSpans empty.
  - Boundary: flagged segment at the exact end of the envelope (clamped indices, no NaN).
  - Majority-hallucinated footage: hallucinated segments outnumber real ones; the pre-screened median (KTD1) keeps the threshold meaningful and the guard still flags them.
- **Verification:** diag replay shows the tail words excluded from all pass catalogs; unit tests green; the guard run over the four eval fixtures' cached envelopes with per-fixture hit counts recorded for Addendum 6 (zero hits validates .eval-cache resume; nonzero means a budgeted cache re-prime).

### U2. Envelope dead-air detector

- **Goal:** Cut long pure-silence blocks automatically from the envelope, no VAD model, on the default path.
- **Requirements:** R3, R9.
- **Dependencies:** U1 (consumes cleanWords + hallucinatedSpans).
- **Files:** new `apps/web/src/features/ai-generate/director/envelope-dead-air.ts`; new `__tests__/envelope-dead-air.test.ts`; modify `build-director-proposals.ts` (run with the detector block; overlap-dedup against vad-dead-air, which is the DEFAULT path since the store defaults it ON; and drop any pacing cut overlapping an envelope dead-air op so EDA is the sole owner of runs at or above 2.5s, using the same call-site filter pattern vad-dead-air uses today).
- **Approach:** Compute sub-threshold window runs (KTD1 threshold). A run is eligible when its duration is at or above 2.5s and no cleanWord midpoint lies inside. Emit category "deadair", id prefix `edead-`, AUTO (no defaultAccept), span shrunk by 0.15s pad per side; head/tail edge gaps cut flush with a 0.5s minimum (vad-dead-air EDGE precedent); a run covering more than 0.8 of totalSec gets defaultAccept: false. Shorter pauses stay pacing's job. Expose the silence-run computation as a shared helper (U3 reuses it).
- **Patterns to follow:** vad-dead-air.ts guard structure (edge handling, whole-timeline fraction, overlap dedup at the build-director-proposals call site); noise-fragment.ts for envelope-scanning code shape.
- **Test scenarios:**
  - The 24s block (57.7-81.9s, hallucination-guarded words excluded): one AUTO cut, padded to about 57.85-81.75, plus flush tail handling for 82.98-83.82 if at or above the edge floor.
  - The 3.4s pause (44.76-48.19): one AUTO cut about 44.91-48.04 (padded both sides).
  - Head silence 0-0.96: flush edge cut 0-0.81 (pad on the interior side only).
  - A 2.0s silence run: no op (below 2.5s AUTO floor).
  - A 3s low-energy run containing one real word midpoint: no op (word makes it ineligible).
  - Whole-file silence: single op with defaultAccept: false (fraction guard).
  - Coexistence: envelope dead-air and vad-dead-air both emitting over the same silence run: one surviving row after the call-site dedup.
  - Pacing overlap: a 3s inter-segment pause produces one edead- op and the overlapping pac- op is dropped (EDA owns 2.5s+; shorter pauses stay pacing's).
  - Envelope empty: no ops.
- **Verification:** diag replay removes the dead-air tail and the 3.4s pause automatically; google/hermes eval AUTO essLost does not increase.

### U3. Pause-swallowing boundary placement

- **Goal:** Every removal edge lands precisely: silence swallowed to a 0.15s room-tone handle next to the neighboring word, trough-snap fallback in continuous speech.
- **Requirements:** R2, R9.
- **Dependencies:** U1 (cleanWords), U2 (shared silence-run helper).
- **Files:** new `apps/web/src/features/ai-generate/director/swallow-pause.ts`; new `__tests__/swallow-pause.test.ts`; modify `build-director-proposals.ts` (replace the snapRemovalOps call for removals; keep snap-cut.ts exports for Highlight mode); modify `redundancy-apply.ts` (applyKeeperSwap routes rebuilt cuts through snapRemovalOps today to stay consistent with the main chain; route it through swallow-pause instead so swapped-group joins get the same placement as pipeline ops).
- **Approach:** For each removal (cut/take_select): start edge walks backward while windows are sub-threshold, stopping at max(prev cleanWord end + 0.15, walk limit); end edge walks forward symmetrically to min(next cleanWord start - 0.15, walk limit). Only widen. If an edge's adjacent window is not sub-threshold (mid-speech boundary), apply nearestLowEnergyTime (existing, 0.25s search) instead. After widening, clip overlaps in time order and drop collapsed spans (snapRemovalOps invariant code as the pattern). Keep/reorder ops untouched.
- **Patterns to follow:** snap-cut.ts (invariants, envelope indexing, test style); remove-silences.ts PADDING_SEC semantics.
- **Test scenarios:**
  - Pacing cut 45.38-47.63 inside silence 44.76-48.19 with words ending 44.72 and starting 48.16: widened to about 44.87-48.01; residual silence in kept footage 0.15s or less per side plus window quantization.
  - Removal edge flush against continuous speech (no sub-threshold neighbor): unchanged except trough snap; never enters a word.
  - Two removals whose widened spans would overlap: clipped in time order, no overlap, later span survives.
  - Widening bounded by a keep op or clip edge: never crosses 0 or totalSec.
  - Empty envelope: pass-through.
  - A removal already word-adjacent on both sides (no silence): byte-identical op.
- **Verification:** diag replay boundary annotations show every join with residual silence at or under 0.2s or in-speech trough placement; no boundary inside a word.

### U4. Phrase-repeat similarity gate

- **Goal:** N-gram matches across different sentences stop auto-cutting; only whole-segment near-identical retakes keep AUTO.
- **Requirements:** R5, R9.
- **Dependencies:** none (parallel with U1-U3).
- **Files:** modify `apps/web/src/features/ai-generate/director/phrase-repeat.ts`; modify `__tests__/phrase-repeat.test.ts`; modify `build-director-proposals.ts` (pass segments; add a regression test pinning the backstop pass-through of detector-set defaultAccept: false); modify `second-pass.ts` (pass the compressed segments already in scope in runSecondPass through detectOnTranscript into detectPhraseRepeatCuts, so compression-revealed cross-sentence n-gram matches get the same HIGH_SIMILAR gate and demotion as pass 1 instead of shipping AUTO ungated).
- **Approach:** detectPhraseRepeatCuts gains optional segments. For each match, find the containing segment of the earlier and later occurrence (midpoint containment); compute similarity() on the two segment texts; below HIGH_SIMILAR, emit the op with defaultAccept: false and a reason noting the demotion. The existing withBackstopAccept call already passes verbatim phrase-repeat ops through unchanged (build-director-proposals.ts:577-580 with redundancy-apply.ts:225-234), so an explicit detector-set defaultAccept: false survives it; the call-site work is passing segments plus a regression test pinning that pass-through. Without segments (fallback callers), behavior is unchanged.
- **Patterns to follow:** text-similarity.ts exports (similarity, HIGH_SIMILAR); take-clusters.ts containing-segment logic.
- **Test scenarios:**
  - The live false positive: "We are going to build it..." vs "we are going to showcase the process..." sharing "We are going to": op emitted with defaultAccept: false.
  - "You do not have to link..." vs "You do not have to subscribe...": demoted.
  - True retake: two segments with similarity at or above 0.8 sharing a 6-word n-gram: op stays AUTO, earlier occurrence cut (existing keep-last behavior pinned).
  - No segments passed: existing test suite passes byte-identical (regression guard).
  - Occurrence spanning two segments: use the segment containing the occurrence midpoint; still deterministic.
- **Verification:** diag replay shows zero AUTO repeat cuts on the clip; eval OFFERED match unchanged (demoted rows remain offered), AUTO essLost down on fixtures where repeat false-positives existed.

### U5. Pacing word-guard (both domains)

- **Goal:** A pacing or second-pass removal span can never contain a real word.
- **Requirements:** R1, R6, R9.
- **Dependencies:** U1 (cleanWords define "real word").
- **Files:** new helper in `apps/web/src/features/ai-generate/director/cut-utils.ts` (stripWordsFromRemoval); modify `pacing.ts` (optional words parameter, guard at emission); modify `second-pass.ts` (guard after inverseRemapTime, against original-domain cleanWords); modify/extend `__tests__/pacing.test.ts` and `__tests__/second-pass.test.ts`.
- **Approach:** stripWordsFromRemoval splits a removal on contained word midpoints into word-free sub-spans, drops fragments under 0.2s, preserves op fields with fresh stable ids for splits (stableOpId namespace precedent from clamp-cut-extent). Pacing applies it when words are provided; second-pass applies it ONLY to gap-derived sp- ops (categories pacing and deadair) after remapping to original coordinates, against original-domain cleanWords. Content-derived sp- ops (filler, duplicate, repeat) are word-removing by design and pass through untouched; stripping them would annihilate the second pass's compression-revealed repeat catching. The emphasis-pause keeper protection and interior-subtraction fix stay as-is; this guard is the belt on top.
- **Patterns to follow:** clamp-cut-extent.ts split-op id minting; second-pass test helpers (take/cut fixtures).
- **Test scenarios:**
  - Regression shape of the live bug: an sp- pacing op that inverse-remaps to 41.63-45.38 across the sentence words 42.34-44.72: split into 41.63-42.19 and 44.87-45.38 (or dropped if under 0.2s), zero word midpoints inside any emitted span.
  - Pacing op on a pure inter-segment gap with no words inside: byte-identical pass-through.
  - Split producing a sub-0.2s fragment: fragment dropped.
  - Words absent (degraded transcript): pass-through unchanged (fail-open).
  - Covers R1: property-style test over the diag fixture words asserting no gap-derived AUTO removal (pacing, second-pass gap ops) contains a word midpoint.
  - Content-derived sp- op (a compression-revealed verbatim repeat spanning real words): passes through unstripped; existing second-pass repeat tests stay green.
- **Verification:** diag replay shows the "I don't think you even have to link..." sentence surviving; second-pass suite green including the X1 regression pin.

### U6. Clamp evidence learns silence

- **Goal:** LLM plan cuts backed by silence or hallucination stop being demoted; the 24s dead-outro ships AUTO.
- **Requirements:** R7.
- **Dependencies:** U1, U2.
- **Files:** modify `build-director-proposals.ts` (clampEvidence array gains envelope dead-air ops and hallucinatedSpans as evidence runs); extend `__tests__/build-director-proposals.test.ts` (or the clamp call-site test file).
- **Approach:** Call-site change only: clamp-cut-extent.ts logic is untouched. hallucinatedSpans convert to evidence-run shape (cut-like spans). Evidence semantics per plan 2026-07-16-001 U2: union coverage at or above 0.5 shrinks to evidence runs, below demotes.
- **Patterns to follow:** existing clampEvidence composition at build-director-proposals.
- **Test scenarios:**
  - A 24s plan cut whose interior is 95 percent covered by an envelope dead-air run + hallucinated span: shrunk to the union (effectively kept AUTO).
  - An oversized plan cut over real dialog with no silence evidence: still demoted (regression).
  - Evidence exactly at the 0.5 coverage boundary: pinned behavior (shrink).
- **Verification:** diag replay shows the dead-outro cut AUTO (via U2 directly or via clamp-evidenced plan op, not an unchecked row).

### U7. Round gate: replay assertions, eval, addendum

- **Goal:** Mechanize the acceptance criteria and record the measured verdict.
- **Requirements:** R8.
- **Dependencies:** U1-U6.
- **Files:** modify `apps/web/scripts/diag-join-the-group.ts` (assertion mode: exit non-zero when R1-R3 checks fail); modify `docs/2026-07-11-director-eval-findings.md` (Addendum 6); update `docs/LIVE-TEST-ISSUES.md` items 1-4 with outcomes.
- **Approach:** Assertions: zero gap-derived AUTO removals containing a cleanWord midpoint (per R1's scoping; transcript-content families are exempt); no removal boundary of any family strictly inside a cleanWord; every removal boundary either within a silence interval with kept-side residual at or under 0.2s or word-adjacent after trough snap; the dead-air tail and 3.4s pause cut AUTO; total AUTO cut seconds (merged-union, not per-op sum) within an expected band. Then the four-fixture eval per KTD8 (baseline numbers from Addendum 5: google 63.8, hermes 75.5, how-to-edit 38.1, pokemon 82.9 OFFERED adjusted); regression gate per R8. Then the R8 gate (e) hands-on smoke pass: import the join-the-group clip in the editor, run AI CUT with defaults, open review, play every join, and record the listened verdict. Addendum 6 records per-fixture before/after, the diag verdict, and the smoke-pass verdict.
- **Test scenarios:** Test expectation: none. This unit is measurement and documentation; its "tests" are the assertions it adds to the diag script.
- **Verification:** diag script exits 0; eval table in Addendum 6 shows no OFFERED regression and AUTO essLost flat or down on all four fixtures; suites and tsc green.

---

## Scope Boundaries

- **Out (this round):** timeline/UX bugs from the live test (linked-clip extend, clip snap-back, Director menu persistence, OFFERED discoverability): parked in docs/LIVE-TEST-ISSUES.md items 5-8 per Dan's priority call.
- **Out on principle:** audio crossfades at joins. Dan 2026-07-17: a join needing a crossfade was cut wrong; precision placement is the product bar.
- **Out:** LLM prompt changes of any kind (retake/structural prompt-version constants stay a deferred residual); VAD-model work; transcription-path changes (the hallucination guard makes VAD-gated transcription less urgent, revisit after measurement).
- **Deferred to follow-up work:** micro-fade rendering at export time if precision placement proves insufficient on some footage (re-open only with Dan); AUTO promotion for verify-kept rows; new fixtures from the app-testers project footage (word transcripts exist in the browser cache).

## Assumptions

- VERIFIED during review: directorVadDeadAirEnabled defaults ON (store.ts:208; the v2 persist migration at store.ts:369-371 force-resets stored false values to true; pinned by director-vad-default.test.ts). U2's overlap-dedup against vad-dead-air is therefore the DEFAULT path, not a conditional one. Open sub-question folded into U2: the 2026-07-17 live run produced no VAD evidence coverage despite the ON default (plausibly the Silero pass not running on the cloud-transcription path in run-director); root-cause this before leaning on the demotion story in U6, and bring any default-flip decision to Dan after Addendum 6.
- Fixture envelopes are rounded to 3 decimals; the KTD1 threshold (0.015) stays meaningful at that precision (quiet windows round toward 0.000).
- The four eval fixtures carry envelope + features (post-U3-enrichment format), so U1-U6 are measurable through the existing eval without fixture regeneration.

## Risks

- **Noisy room tone above threshold:** the adaptive threshold (median x 0.5) may still sit below constant fan hum, so no silence is detected and behavior degrades to today's (fail-safe, no regression). Acceptable; note in Addendum 6 if observed on fixtures.
- **Hallucination guard false positives on whispered speech:** mitigated by the AND criteria (KTD3); a wrongly flagged segment loses its words from detector input but its span only becomes a cut if it is genuinely silent per envelope, which contradicts "whispered speech" by construction of the energy criterion.
- **Eval movement from demotions (U4):** AUTO recall may dip where phrase-repeat was right by luck; the R8 gate accepts AUTO essLost improvements against flat OFFERED, and the 3:1 precision rule (plan 2026-07-16-002 KTD5) governs any contested trade.
- **Second-pass domain confusion (U5):** the guard must run on original-domain coordinates with original-domain words; the existing X1 regression test plus the new sp- regression pin both domains.

## Deferred to Implementation

- Exact adaptive-threshold ratio (0.5 starting point) and the wpm floor for KTD3: tune on the diag fixture plus the four eval fixtures using cached envelopes before touching live tokens (probe-then-tune, handoff lesson).
- Whether U2's sub-2.5s silence runs (1.0-2.5s) get opt-in review rows this round or stay pacing-only: decide from the diag replay's join quality after U3.
- stableOpId namespace choice for U5 split ops.
- Whether hallucinated spans fold into the LLM signal table as explicit "silence" rows (helps the plan pass reason about dead air) or are simply absent; start absent, revisit in Addendum 6.

## Sources and Research

- docs/LIVE-TEST-ISSUES.md: root-caused failures this plan fixes (items 1-4).
- apps/web/scripts/diag-join-the-group.ts + scratchpad diag-join-ops.json (2026-07-17): the reproduced op dump grounding R1-R3 and the U-unit test scenarios.
- Module deep-read (2026-07-17, this session): ENERGY_WINDOW_SEC = 0.05 (audio-features.ts:20); envelope reaches only noise-fragment, the VAD energetic test, snapRemovalOps (build-director-proposals.ts:324,366-372,885); pacing.ts has no word awareness (root of the sp- bug via second-pass.ts:286-287 asymmetric inverseRemapTime); clampEvidence composition (build-director-proposals.ts:479-481); defaultAccept map per op family; phrase-repeat DEFAULT_MIN_PHRASE_WORDS = 4, cuts the earlier occurrence; justify-cuts JUSTIFIED_REMOVAL excludes pacing/llm; HIGH_SIMILAR = 0.8 with reusable similarity()/tokenize()/mostSimilar().
- docs/brainstorms/2026-06-20-ai-cut-words-vad-requirements.md: dead-air candidates deduped against silence/pacing (R4); words-always-on; review-gated framing.
- docs/brainstorms/2026-06-23-director-repeat-detection-requirements.md: R7 lexical-detectors-as-fallback (U4 implements it); R2/R3 conservative bias and intentional-repetition protection.
- docs/plans/2026-07-16-001/-002/-003 + docs/2026-07-11-director-eval-findings.md Addenda 2-5: gate definitions (noise-adjusted guarded by raw, 3:1 precision, 0.90 target), clamp semantics, nothing-auto-applies standing rule and its Dan-approved exception here (KTD4), AUTO essLost floor named detector-sourced (this round is that follow-up).
- apps/web/src/features/editing/remove-silences.ts: WINDOW_SEC 0.05, RMS_THRESHOLD 0.015, PADDING_SEC 0.15, SNAP_SEC 0.25, MIN_REMOVED_SEC 0.2 (KTD1/KTD2/KTD6 constants mirror these).
- PATCHES.md: no upstream files in the touch set; store.ts default-flip logging precedent (line 91).
