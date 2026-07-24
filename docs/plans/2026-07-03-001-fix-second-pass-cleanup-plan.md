---
title: "fix: bulletproof second-pass cleanup (no micro-clip survives, residual repeats/mistakes/irrelevant content removed)"
date: 2026-07-03
type: fix
depth: deep
branch: feat/director-importance
origin: user report (fresh recut still shows sub-10-frame filler/repeat slivers) + docs/plans/2026-07-02-002-fix-recut-quality-and-timeline-perf-plan.md
target_repo: framecut-director
---

# fix: bulletproof second-pass cleanup

## Summary

Dan re-ran AI CUT after the recut-quality units (U1-U4, 2026-07-02-002) and the result still contains sub-10-frame slivers: shards of fillers, repeats, and mistakes surviving as their own micro-clips. Root cause confirmed by code read: `planRemovalRanges` (apply-plan.ts) maps accepted cuts 1:1 to removal ranges with **zero coalescing** — two accepted cuts landing 8 frames apart leave an 8-frame shard of an "um" as its own clip. Nothing anywhere enforces a minimum surviving clip duration, and the pipeline never re-analyzes its own output (a human editor's second pass).

This plan makes the cleanup an **enforced invariant, not another heuristic**:

1. **No micro-clip can survive a recut** — accepted removal ranges are coalesced across sub-floor gaps before applying (guarded so a complete content word is never swallowed), and pre-existing micro-clips get swept.
2. **The Director re-checks its own output** — a virtual second pass remaps the transcript through the accepted cuts and re-runs the deterministic detectors on the compressed result, catching the repeats/mistakes/fillers that only become adjacent (and obvious) after pass 1. Iterates to convergence, capped at 3 passes, all inside ONE review and ONE undo.
3. **Non-relevant segments actually leave** — high-confidence out-of-context flags flip from opt-in to default-accept (Dan's updated call), uncertain band stays reviewable, and the context prompt is hardened to catch mistake meta-asides ("wait, let me redo that").

Constraints unchanged: everything stays one undo, review remains the gate, editor perf and transcription pipeline untouched.

---

## Problem Frame

Evidence from Dan's fresh recut (screenshots, 2026-07-03): multiple clips visibly under 10 frames wide between kept content; he identifies them as "fillers, repeats, mistakes, umms." His words: "you've been missing these basic mistakes... Make a bulletproof plan to remove mistakes, repeats, non-relevant segments to the overall video."

Mechanics of the failure (all confirmed by code read):

- **Sliver creation:** word-level detectors (filler, duplicate-word) emit tight word-span cuts. Two accepted cuts separated by a few frames of noise leave that noise as a surviving clip. `planRemovalRanges` (`apply-plan.ts:54-71`) does no gap coalescing. (Contrast: `planKeepInverseRanges` for Highlight mode already drops sub-frame slivers — the concept exists, just not on the cut path.)
- **No minimum-duration invariant:** `detectTinyClipCuts` exists but with `MIN_USEFUL_CLIP_FRAMES = 5` (run-director.ts) and surfaces as review rows; 5-15 frame shards pass right under it.
- **No second pass:** compression reveals adjacency — two takes 40s apart become adjacent after the material between them is cut, making the duplication obvious — but the pipeline analyzes only the original timeline. The remap helper needed for a virtual second pass already exists (`remapTranscriptTimestamps`, features/transcription).
- **Out-of-context is opt-in only** (U3 of the prior plan, per Dan's earlier decision); Dan has now revised: non-relevant segments should be removed, not just flagged.

---

## Requirements

- **R1 (invariant):** After a Director apply, no clip shorter than the floor (default 15 frames at project fps) exists on the timeline, unless that clip contains a complete content word that no accepted cut covered. This is asserted by tests, not hoped for.
- **R2:** Accepted removal ranges separated by a sub-floor retained gap are coalesced into one range before applying, with a word-guard: a gap containing a complete content word is never swallowed.
- **R3:** Pre-existing micro-clips (e.g. Dan's currently shattered timeline) are detected on the next Director run and removed by default when they contain no complete content word; content-bearing micro-clips surface as review rows.
- **R4:** After pass-1 ops are assembled, the Director virtually applies the default-accepted cuts to the transcript and re-runs the deterministic detectors (duplicate-words, fillers, phrase-repeat, segment-repeat, word dead-air, pacing) on the compressed result; new findings map back to original coordinates and fold into the SAME review with the same accept defaults as pass 1. Repeats until no new cuts, capped at 3 passes.
- **R5:** Out-of-context flags at/above the accept threshold default-accept; below stays opt-in. The context prompt also targets mistake meta-asides and abandoned sentences.
- **R6:** The whole result remains ONE review and ONE undo; a pass-2/3 finding is indistinguishable in UX from a pass-1 finding.
- **R7:** No LLM re-runs per pass (cost): passes 2+ use deterministic detectors only.
- **R8:** No regressions: emphasis-pause protection, keeper protection, trim-vs-cut, consolidation, and the one-undo batch all hold.
- **R9 (no unnecessary cuts):** A clip boundary is never created where nothing was actually removed for a real reason. Every surviving boundary corresponds either to a removal whose span carried a genuine reason (mistake/silence/repeat/filler/dead-air/context) or to a source discontinuity; no source-contiguous adjacent same-source clips survive, and no sub-floor removal is applied between two content words that has no filler/repeat/silence/mistake justification. (User report 2026-07-03: a cut appeared mid-continuous-speech with no mistake or silence.)

---

## Key Technical Decisions

- **KTD1 (coalesce at the range level, post-accept, pre-apply).** Coalescing runs on the ACCEPTED ranges inside the apply path (`planRemovalRanges` or immediately after it), not inside detectors. Detectors stay precise; the guarantee lives at the single choke point every removal flows through (cut, take_select, context, all of it). This is what makes it bulletproof: no detector can reintroduce slivers.
- **KTD2 (word-guard via transcript, fail-open to keep).** A sub-floor gap is swallowed only if word timings confirm it contains no complete content word (fillers/partials do not count as content). With no transcript available, gaps are NOT swallowed (fail toward keeping footage). Pure function, injectable word list.
- **KTD3 (virtual second pass via transcript remap, not re-transcription).** Pass 2 does not re-transcribe or touch the timeline: it applies the accepted ranges to the words/segments arrays with `remapTranscriptTimestamps` (already shipped and tested for exactly this shift math), runs the deterministic detectors on the remapped transcript, then maps findings back to original coordinates by inverting the shift (add back the cumulative removed duration at each point — the inverse is well-defined because removals are disjoint sorted ranges). Everything stays in one plan/review; no intermediate apply.
- **KTD4 (convergence loop, cap 3).** Passes repeat while new (non-duplicate) cuts appear, max 3 total. Each pass's new cuts adopt the same defaultAccept rules as pass 1 (verbatim repeats + fillers accepted; soft/uncertain opt-in). Dedup by time-span against all prior ops so the loop terminates.
- **KTD5 (micro-clip sweep for pre-existing shards).** Raise the tiny-clip floor from 5 frames to the shared floor constant, and split its output: shards with no complete content word default-accept; content-bearing ones stay review rows. This cleans Dan's existing timeline on his next run without risking real words.
- **KTD6 (context auto-accept mirrors the repeat pattern).** Context flags carry LLM confidence; at/above `DEFAULT_REDUNDANCY_ACCEPT_THRESHOLD` (0.7, reuse the constant) they default-accept, below stays opt-in. Prompt hardened for: off-topic tangents, abandoned thoughts, meta-asides/self-corrections, content belonging to another video. Precision-over-recall instruction stays.
- **KTD7 (one shared floor constant).** `MIN_SURVIVING_CLIP_FRAMES = 15` (~0.5s at 30fps) in one place, converted via project fps everywhere (coalescing gap, micro-clip sweep, invariant tests). Matches the existing PAUSE_FLOOR_FRAMES precedent.

---

## High-Level Technical Design

```
pass 1 (existing): transcribe -> removeSilences -> re-transcribe -> detectors + LLM passes -> merge
        |
        v
  NEW convergence loop (deterministic only, cap 3):
        ops -> default-accepted ranges -> remapTranscriptTimestamps(words/segments)
             -> re-run dup-words/filler/phrase-repeat/segment-repeat/dead-air/pacing
             -> map new cuts back to ORIGINAL coords (inverse shift)
             -> dedup vs all prior ops -> fold in (same accept defaults)
             -> repeat while new cuts found
        |
        v
  review (ONE panel: pass-1 + pass-2/3 + context rows with accept defaults)
        |
        v
  apply: planRemovalRanges -> NEW coalesceRemovalRanges (sub-floor gaps swallowed
         unless word-guard) -> RemoveRangesCommand -> ConsolidateAdjacentClips
         -> (same BatchCommand, one undo)
        |
        v
  INVARIANT (tested): no surviving clip < floor without a complete content word
```

---

## Implementation Units

### U1. Coalesce accepted removal ranges across sub-floor gaps (the choke-point guarantee)

**Goal:** Two accepted removals separated by less than the floor never leave a sliver: the gap is swallowed into one range, unless it contains a complete content word.

**Requirements:** R1, R2 (KTD1, KTD2, KTD7)

**Dependencies:** none

**Files:**
- Create `apps/web/src/features/ai-generate/director/coalesce-removal-ranges.ts` (pure)
- Create `apps/web/src/features/ai-generate/director/__tests__/coalesce-removal-ranges.test.ts`
- Modify `apps/web/src/features/ai-generate/director/apply-plan.ts` (wire into the removal path used by `applyDirectorPlan`)
- Modify `apps/web/src/features/ai-generate/director/run-director.ts` or the shared constants home (add `MIN_SURVIVING_CLIP_FRAMES = 15`)

**Approach:** `coalesceRemovalRanges({ ranges, words, floorTicks })`: sort ranges, walk pairs, and when `next.start - prev.end < floorTicks`, merge them iff no complete content word (word fully inside the gap, not classified as a filler token) lives in the gap; no words data means no merge (fail-open to keep). Runs on the accepted ranges inside the apply path so every removal source is covered. Also drop accepted ranges that are themselves shorter than one frame (degenerate).

**Test scenarios:**
- Two cuts 8 frames apart, gap contains only a partial word/noise: merged into one range.
- Two cuts 8 frames apart, gap contains the complete word "free": NOT merged.
- Two cuts 20 frames apart (over floor): NOT merged.
- Chain of 5 cuts each 5 frames apart: all merge into one range (transitive).
- No words provided: nothing merges (fail-open).
- Filler word ("um") alone in the gap does not count as content: merged.
- Idempotent: coalescing twice equals once.

**Verification:** Unit tests green; applying a dense synthetic cut plan yields zero sub-floor retained gaps between removals.

### U2. Micro-clip sweep for pre-existing shards

**Goal:** Shards already on a timeline (like Dan's current one) get removed on the next Director run: no-content shards by default, content-bearing ones as review rows.

**Requirements:** R1, R3 (KTD5, KTD7)

**Dependencies:** U1 (shares the floor constant)

**Files:**
- Modify `apps/web/src/features/ai-generate/director/tiny-clip.ts` (floor + word-aware split of accept default)
- Modify `apps/web/src/features/ai-generate/director/run-director.ts` (pass words + floor; wire accept defaults)
- Extend `apps/web/src/features/ai-generate/director/__tests__/` tiny-clip coverage

**Approach:** Raise the detector's threshold to the shared floor. For each candidate shard, check word timings: no complete content word inside → `defaultAccept: true`; otherwise `defaultAccept: false` (review row, reason names the word). Keep the existing overlap-filtering so a shard already covered by another cut is not doubled.

**Test scenarios:**
- A 9-frame clip containing only a partial "um": default-accepted cut.
- A 12-frame clip containing the complete word "yes": opt-in row with the word in the reason.
- A 20-frame clip (over floor): untouched.
- No transcript: shards surface as opt-in rows only (fail-open, nothing auto-removed).

**Verification:** On a fixture mimicking Dan's shattered timeline (dozens of 5-12 frame clips), a Director run removes the no-content shards by default.

### U3. Virtual second-pass convergence loop

**Goal:** The Director re-analyzes its own compressed output and catches residual repeats/mistakes/fillers, inside the same review and undo.

**Requirements:** R4, R6, R7 (KTD3, KTD4)

**Dependencies:** U1 (pass-2 range math uses the same coalescing semantics)

**Files:**
- Create `apps/web/src/features/ai-generate/director/second-pass.ts` (pure orchestration: remap -> detect -> inverse-map -> dedup)
- Create `apps/web/src/features/ai-generate/director/__tests__/second-pass.test.ts`
- Modify `apps/web/src/features/ai-generate/director/run-director.ts` (loop after the merge, before opening review)

**Approach:** From the merged ops, take the default-accepted removal spans, sort/merge them, and build the remapped words/segments with `remapTranscriptTimestamps` (applied removal-by-removal right-to-left, or via a cumulative-shift walk). Run the deterministic detectors on the remapped transcript. Inverse-map each new cut to original coordinates by adding back the cumulative removed duration before its remapped start (pure helper with its own tests: `inverseRemap(t) = t + sum(removals ending before mapped position)` — implement and property-test round-trip `inverse(forward(t)) === t` for points outside removals). Dedup vs all existing ops by span overlap. Fold in with pass-1 accept defaults. Loop while new ops appear, cap 3 passes; `log`/toast the pass count. Emphasis-pause keepers and take-cluster keepers are re-applied as protection in each pass's merge.

**Test scenarios:**
- Two verbatim takes 40s apart, everything between them cut in pass 1: pass 2 detects the now-adjacent repeat and emits the cut (in ORIGINAL coordinates, verified exact).
- Round-trip property: for a set of disjoint removals, forward-then-inverse mapping of any retained-region point is identity.
- A pass-2 cut overlapping a pass-1 op is deduped (no double).
- No new findings in pass 2: loop exits after 2 passes.
- Adversarial fixture where each pass reveals one new repeat: loop stops at cap 3 with the 3rd pass's ops included.
- Keeper spans survive all passes uncut.
- Convergence never mutates the timeline or the persisted transcript cache (pure until apply).

**Verification:** On a synthetic transcript with repeats separated by cuttable filler, one Director run (one review, one undo) removes both the filler and the repeat that adjacency revealed.

### U4. Context auto-accept + prompt hardening for mistakes/meta-asides

**Goal:** Non-relevant segments actually leave the video by default when the model is confident; mistake meta-asides are explicitly targeted.

**Requirements:** R5 (KTD6)

**Dependencies:** none (parallel-safe)

**Files:**
- Modify `apps/web/src/features/ai-generate/director/context-relevance.ts` (confidence-split accept default)
- Modify `apps/web/src/app/api/director/context/route.ts` (prompt: add meta-asides/self-corrections/abandoned-sentence targets; keep precision-over-recall)
- Extend `apps/web/src/features/ai-generate/director/__tests__/context-relevance.test.ts`

**Approach:** Reuse `DEFAULT_REDUNDANCY_ACCEPT_THRESHOLD` for the split: flags at/above it map to `defaultAccept: true`, below to `false`. Prompt gains explicit categories with one-line definitions (off-topic tangent, abandoned thought, meta-aside/self-correction, wrong-video content) and instructs a confidence per flag. Non-throwing behavior unchanged.

**Test scenarios:**
- A 0.85-confidence flag: default-accepted cut, category context.
- A 0.6-confidence flag: opt-in row (unchanged).
- Malformed/absent confidence: treated as low (opt-in), never accepted.
- Overlap with an existing cut still filtered.

**Verification:** A transcript containing "wait, that's wrong, let me redo this" gets a default-accepted context cut on a live run.

### U5. No unnecessary cuts (every boundary must be justified)

**Goal:** Eliminate cuts that have no removal reason behind them. Dan's example: a boundary added mid-continuous-speech with no mistake, silence, or repeat. Distinct from slivers (leftover shards) — this is a cut that should not have been made.

**Requirements:** R9 (KTD1, ties to KTD2's word-guard)

**Dependencies:** U1 (shares the word-guard + floor); best diagnosed after U1-U4 so the full op set exists

**Files:**
- Create `apps/web/src/features/ai-generate/director/justify-cuts.ts` (pure)
- Create `apps/web/src/features/ai-generate/director/__tests__/justify-cuts.test.ts`
- Modify `apps/web/src/features/ai-generate/director/run-director.ts` (drop unjustified removals before review) and/or `apply-plan.ts`
- Possibly modify `apps/web/src/commands/timeline/track/consolidate-adjacent-clips.ts` (ensure ALL source-contiguous pairs merge)

**Approach:** Diagnosis first on a real recut — classify every surviving boundary as (a) pure split (source contiguous, nothing removed) → must consolidate away; verify `ConsolidateAdjacentClips` merges every source-contiguous adjacent same-source pair and add a regression test; (b) justified removal (span carried a real filler/repeat/silence/dead-air/mistake/context reason) → keep; (c) unjustified sub-floor removal (a short removal bounded by content words with no filler/repeat/silence/mistake reason) → drop it, keeping the footage. `justifyCuts({ removals, words, reasons, floorTicks })` drops case-(c) removals: a removal shorter than the floor whose span sits between two complete content words and carries no accepted removal reason is reverted. Reuse the content-word helper from U1. Fail-open: with no transcript, do not drop anything.

**Test scenarios:**
- A 6-frame removal between two complete content words with reason "filler:um" → KEPT (justified).
- A 6-frame removal between two complete content words with NO reason (or category "pacing" with no filler/repeat) → DROPPED (unjustified).
- A removal over the floor → never dropped regardless of reason.
- Two source-contiguous adjacent same-source clips → consolidated to one (pure-split regression).
- No transcript → nothing dropped (fail-open).

**Verification:** Live on Dan's recut — the mid-continuous-speech boundary he flagged is gone, and every remaining boundary is either a real content discontinuity or a justified removal.

---

## Scope Boundaries

**In scope:** removal-range coalescing + floor invariant, micro-clip sweep, deterministic second-pass convergence, context accept-default flip + prompt hardening.

**Non-goals:**
- Re-running LLM passes per convergence iteration (R7; cost).
- Editor performance, transcription pipeline, silence-removal internals (all shipped, untouched).
- Auto-remediating Dan's current timeline in place: the fix applies on his next AI CUT run (fresh or over the current state - U2 handles the existing shards then).

### Deferred to Follow-Up Work
- An LLM-judged final QA pass ("watch" the resulting cut list and score it) - powerful but a separate feature.
- Exposing the floor as a user setting.

---

## Risk Analysis & Mitigation

- **Coalescing swallows a real word (R2):** word-guard with fail-open-to-keep when no transcript; filler tokens enumerated from the existing filler detector's list, not re-invented; property tests on the guard.
- **Inverse mapping drift (U3):** pure helper with round-trip property tests; pass-2 cuts asserted in original coordinates against hand-computed fixtures.
- **Convergence loop runaway:** hard cap 3; dedup by span; deterministic detectors only.
- **Context auto-accept removes wanted content:** threshold reuse (0.7) + prompt keeps precision-over-recall + everything visible in review + one undo.

---

## Verification

- `bunx tsc --noEmit` = 0; new unit tests green (coalesce, tiny-clip split, second-pass + inverse-map round-trip, context split). Full suite at the known baseline (3 pre-existing mask failures).
- **Invariant test (the headline):** an integration-style fixture with dense word-level cuts runs plan -> coalesce -> apply -> consolidate and asserts ZERO surviving clips under the floor lacking a content word.
- Live (Dan or main session on a throwaway copy): re-run AI CUT on the shattered project; confirm no sub-10-frame clips remain, residual repeats ("it's free / it's free to try" class) are gone, and a meta-aside gets a default-accepted context cut.
