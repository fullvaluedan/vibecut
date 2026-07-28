---
title: "feat: Director round 12 (join texture: stranded fragments, silent slivers, final-read pass, run feedback)"
type: feat
date: 2026-07-18
depth: standard
---

# feat: Director round 12 (join texture, final-read pass, run feedback)

## Summary

Dan's 2026-07-18 live verdict on a 10-file, 29-minute run: individual cut choices are fine, but
the Director "doesn't consider what the final product looks like when it cuts". Concretely, it cut
everything around a filler "so...", stranding the connective between two joins, and his timeline
shows tiny sliver clips between adjacent cuts. Root cause is architectural: every pass judges its
own cuts in isolation and nothing ever reads the ASSEMBLED result.

Census (`scripts/_tmp-census-join-texture.ts`, cached pipeline, AUTO path, four fixtures):

- 196 adjacent-cut joins; 18 stranded kept fragments of <= 4 words between two cuts.
- Dan's finals CUT the entire fragment in 15 of 18. He kept 3 ("and look at that",
  "Let's find out.", "I had some confusion"): complete, meaningful mini-reactions.
- Word cost of blanket swallowing: removes 38 words he cut, destroys 11 he kept. Blanket
  auto-swallow would hand back over half of round 11's essLost win, so the default must be
  review-gated for word-bearing fragments.
- 2 wordless SILENT slivers (0.05s, 0.06s) between cuts: the timeline-sliver artifact. Zero words,
  so swallowing them is invisible to every word metric; it is pure texture repair.

Also in scope: the morning's "nothing happened" incident. The silent-failure sweep (67 paths,
6-area fan-out) identified the failure class: a run error currently shows a 15-second toast, then
the dock reverts to idle (ai-cut-actions.ts:114-125); a user who looks away sees nothing, ever.
Three passes have no timeout at any layer (client fetches at run-director.ts:301/317/330 carry
only the cancel signal; the claude-code spawn in hf-bridge author.ts has no kill timer), and the
transcription worker attaches no error/messageerror handler (services/transcription/service.ts:78,
contrast services/vad/service.ts which has all three), so a worker death hangs the run forever
with a live-looking elapsed ticker.

## Requirements

- R1 (U1). A post-merge join-texture layer in `buildDirectorProposals`:
  - A wordless gap <= `SILENT_SLIVER_MAX_SEC` (0.5) between two adjacent default-accepted cut
    spans becomes an AUTO `join` cut op (zero kept words, metric-invisible, texture-only).
  - A kept run of <= `FRAGMENT_MAX_WORDS` (4) words between two adjacent default-accepted cut
    spans becomes an OFFERED (`defaultAccept: false`) `join` cut op whose reason quotes the
    stranded text ("Stranded between two cuts: \"so...\" - swallow it?").
  - Both only fire between cuts that are BOTH default-accepted: an opt-in neighbor is not a join.
- R2 (U1). New `DirectorOpCategory` `"join"` with the full five-piece checklist: author.ts union,
  taste.ts CATEGORIES + CATEGORY_LABEL ("Join cleanup"), review-format badge ("Join") + rejected
  hint ("Keeping the fragment"), justify-cuts JUSTIFIED_REMOVAL allow-list (MANDATORY: a missing
  entry silently reverts categorized sub-floor cuts, justify-cuts.ts:49).
- R3 (U2, after U1 lands). The verify pass reads the ASSEMBLED post-cut transcript (what remains,
  in order, after all default-accepted cuts) and adjudicates each OFFERED join fragment: swallow
  (promote to checked) or keep. Prompt change bumps VERIFY's version constant. Success is measured
  per-fragment against Dan's finals: >= 12 of the 15 he cut promoted, at most 1 of the 3 he kept
  wrongly promoted, AUTO essLost rise <= 3 words suite-wide on 3-run means.
- R4 (U3). Run feedback and robustness:
  - Failure persists: the catch in ai-cut-actions.ts writes an error state (stage + message) that
    the dock renders as a card with a Retry button; the toast remains but is no longer the only
    evidence.
  - Completion is announced: a success toast when the review dock opens with a fresh plan.
  - Timeouts: each director pass fetch gets `AbortSignal.any([cancel, AbortSignal.timeout(ms)])`
    (generous: plan 300s, other passes 180s); the recall passes already fail open and must degrade
    on timeout instead of hanging; a plan-pass timeout surfaces the error card.
  - The claude-code CLI spawn in packages/hf-bridge author.ts gets a kill timer.
  - The transcription worker gets error + messageerror handlers that reject the pending promise
    (mirror services/vad/service.ts).
- R5. Standing rules: Edit tool only; no em dashes in added lines; PATCHES.md same-commit for any
  upstream-originated file; prompt wording changes bump that pass's version constant; never edit
  pipeline code while an eval runs; gates before Dan sees it: apps/web suite (1416 pass + exactly
  3 known mask failures), hf-bridge 177, tsc clean, four-fixture eval 3-run for any essLost claim.

## Key technical decisions

- KTD1. Join detection runs at the END of buildDirectorProposals over the merged op set, because
  a join only exists once every pass has contributed its cuts. It reads the final default-accepted
  spans, not any single pass's output.
- KTD2. Word-bearing fragments are OFFERED, never AUTO, in U1. The census is decisive: 3 of 18
  were deliberate keeps and no deterministic signal separates them (both classes contain complete
  sentences). Judgment belongs to the final-read pass (U2) or Dan.
- KTD3. Silent slivers are AUTO because they carry zero transcript words: essLost and match cannot
  move by construction. The 0.5s ceiling keeps real breathing pauses (which pacing already owns)
  out of scope; measured slivers were 0.05-0.06s.
- KTD4. U2 extends the existing VERIFY pass rather than adding a new LLM call: the app already
  runs verify on every Director run (commit f6f3c13c), so the final read rides an existing
  round-trip. Its prompt gains the assembled transcript and the fragment questions.
- KTD5. U1 and U3 are independent code areas and are built by parallel worktree agents; U2 waits
  for U1 (it adjudicates U1's rows). Both agents touch hf-bridge author.ts in disjoint regions
  (category union vs spawn timer); merge sequentially and re-run gates after each merge.

## Units

- U1. Join-texture detector + `join` category five-piece + wiring + unit tests. Commit.
- U2. Verify-pass final read + version bump + eval measurement (3-run). Commit with ADDENDUM 11.
- U3. Error card + completion toast + pass timeouts + spawn kill timer + worker error handlers +
  unit tests where pure. Commit.
- U4. TO-VERIFY rows for Dan (join rows on real footage; the error card; run-time feel), promote
  or delete the census script, handoff update.

## Verification gates

Suites + tsc as R5. Eval: U1 must leave AUTO essLost and match UNCHANGED on 3-run means (silent
slivers are word-free; fragments are opt-in). U2 is the measured lever and carries the ADDENDUM.
U3 is UI/robustness: unit-test the pure pieces (timeout composition, store error state), live-verify
the card/toast in the browser-pane smoke recipe (window.__directorPlanStore).
