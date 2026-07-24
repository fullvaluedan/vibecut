---
title: "fix: Director round 11 (de-dup AUTO harm, the same-segment vacuity in the phrase-repeat gate)"
type: fix
date: 2026-07-18
depth: standard
---

# fix: Director round 11 (de-dup AUTO harm, the same-segment vacuity in the phrase-repeat gate)

## Summary

ADDENDUM 9's postscript attributed hermes' stable-high AUTO essential-words-lost (57 words) to the
DE-DUP family: `repeat` 17 + `redundancy` 16, 58% of the total. The handoff proposed a single
lever, "deliberate-repeat protection (bookend/sign-off signal)". Round-11 diagnosis REFUTES that as
the explanation for the larger half and replaces it with a measured mechanism.

The `repeat` half is not a deliberate-repeat problem at all. It is a hole in the round-6 U4 gate
that was built to prevent exactly this. `detectPhraseRepeatCuts` keeps a match's AUTO default only
when the two occurrences' containing SEGMENTS are near-identical (`similarity >= HIGH_SIMILAR`).
When both occurrences land inside ONE segment, that test compares a segment with ITSELF and returns
1.0 unconditionally. The gate is vacuous for every intra-segment repeat, which is the common case
for a stumble-restart.

Measured on hermes (`scripts/_tmp-diag-phrase-gate.ts`, deterministic, no LLM), over the 31 AUTO
phrase-repeat ops:

| gate evidence | Dan KEPT (bad cut) | Dan CUT (good cut) | resSim |
|---|---|---|---|
| same-segment (both occurrences in one segment) | 17 | 6 | 1.00 on every op |
| no-residual (segment adds nothing beyond the phrase) | 2 | 3 | n/a |
| real-evidence (cross-segment, residual both sides) | 1 | 2 | 0.24-0.74 |

The same-segment bucket is 23 of 31 AUTO ops and is wrong 74% of the time. The other two buckets
behave roughly as the gate intends and are LEFT ALONE. Representative same-segment offenders, all
kept by Dan: `"we are going to"` inside `"we are going to start this up we are going to launch a
small instance"`, and `"a dollar a day"` inside `"can be less than a dollar a day up to a dollar a
day twenty dollars per month"`. The doc comment at phrase-repeat.ts:16-25 names this exact failure
("We are going to build it" vs "we are going to showcase") as the thing U4 prevents; it does not,
because that example is cross-segment and the real footage is not.

## Scope decision (why this round is ONE unit, not two)

The `redundancy` half (16 words, the sign-off "But we don't do that here at Full Value, Dan.") is
NOT addressed here, and the handoff's bookend hypothesis does not fit it either: the two instances
are 4 seconds apart (16:18 and 16:22), not far-apart bookends. Dan keeps an immediately-repeated
catchphrase. Distinguishing that from a stutter-restart needs its own attribution pass over the
LLM redundancy groups (how many AUTO groups, what fraction Dan kept, what separates them). Guessing
a signal here is precisely the mistake ADDENDUM 8 made with pacing. Deferred to round 12 with the
diagnostic named in "Follow-ups".

## Requirements

- R1. `detectPhraseRepeatCuts` demotes a match to `defaultAccept: false` when the earlier and later
  occurrences resolve to the SAME containing segment. The similarity comparison is only trusted
  when it had two distinct segments to compare.
- R2. The demoted row carries a reason that says why it is unchecked, distinct from both existing
  strings (the `confirmedRetake` string and the round-6 different-sentence string). The op is still
  PRODUCED, so OFFERED recall is unchanged by construction.
- R3. No behavior change when `segments` is absent or empty (legacy callers, degraded transcripts):
  those keep today's AUTO default, exactly as the round-6 gate already specifies.
- R4. The `no-residual` and `real-evidence` buckets are untouched this round. Their bad:good ratios
  (2:3 and 1:2) do not justify a demotion and the sample is small.
- R5. Standing rules: Edit tool only; no em dashes in added lines; PATCHES.md row in the same commit
  if an upstream-originated file is touched (not expected: phrase-repeat.ts is FrameCut-authored);
  no prompt wording change, so no version constant bump; gates = suites + tsc + diag + four-fixture
  eval before Dan sees it.

## Key technical decisions

- KTD1. The fix lives inside the existing `if (segments && segments.length > 0)` block, next to the
  similarity test, and reuses the `containingSegment` helper already in the function. It compares
  the two resolved segments by IDENTITY (same object reference from the same `segments` array),
  which is exact and needs no new tolerance constant. `containingSegment` already returns the array
  element, so `earlierSeg === laterSeg` is sound.
- KTD2. Demote, do not drop. The op stays in the plan with `defaultAccept: false`, so `offered`-mode
  metrics (match, recall, OFFERED essLost) cannot move at all; only the AUTO path changes. This is
  the round-9 filler precedent and it makes the measurement clean: any OFFERED movement in the eval
  would indicate an unintended side effect.
- KTD3. No new `DirectorOpCategory`. These stay `repeat`, so the five-piece category checklist does
  not apply and the review badge/hint keep working unchanged.
- KTD4. The later occurrence used for the segment lookup is the detector's own `bestJ` run, NOT a
  re-derived one. The diagnostic re-derived it (first matching run rather than longest), so the unit
  test must pin the real detector's behavior rather than trusting the diagnostic's table.

## Success criteria (measured, --runs 3 for essLost)

Primary, hermes AUTO:
- AUTO essLost 57 -> materially lower (predicted ~40-45; the `repeat` category's 17 words are the
  addressable share, the remaining 40 are redundancy/pacing/cut/duplicate/filler).
- AUTO match adjusted 76.4% must NOT fall. This is the discriminator between a precise lever and a
  metric shuffle: demoting cuts Dan KEPT should RAISE auto match. A drop means the demotion is
  catching real retakes.
- AUTO cut recall (13.0%) may fall slightly; that is the accepted cost of moving 6 good cuts to
  opt-in.

Guardrail, all four fixtures:
- OFFERED match adj, OFFERED essLost, OFFERED recall: UNCHANGED (KTD2 makes this structural; any
  movement is a bug in the change).
- google-omni / how-to-edit / pokemon-tcg AUTO essLost: must not RISE.

## Units

- U1. Same-segment demotion in `phrase-repeat.ts` + unit tests (same-segment demotes; cross-segment
  near-identical still AUTO; absent/empty segments unchanged; the reason string). Commit.
- U2. Measure: four-fixture eval `--llm --runs 3`, captured to a file with `*>`. Record the AUTO/
  OFFERED deltas in a new ADDENDUM 10. Commit the findings doc.
- U3. If U2 confirms, delete the throwaway diagnostic (`scripts/_tmp-diag-phrase-gate.ts`) or
  promote it to a kept diag script. Update TO-VERIFY with a taste row for Dan.

## Follow-ups (not this round)

- F1. Round 12: attribute the LLM redundancy AUTO groups on hermes the same way (per-group: kept vs
  cut by Dan, adjacency, near-verbatim score, keeper choice vs Dan's). Only then design the
  deliberate-repeat signal for the sign-off's 16 words.
- F2. The eval's `--retake` / `--structural` flags still default OFF (director-eval.ts:512-514,
  llm-adapter.ts:241-245) while the APP now runs both unconditionally (commit f6f3c13c). The eval no
  longer mirrors the shipped app. AUTO essLost is insensitive to this (ADDENDUM 9: identical on all
  four fixtures) so it does not invalidate round 11, but the defaults should be flipped so future
  rounds measure what ships.
- F3. `applyKeeperSwap` (redundancy-apply.ts:216) gates on `confidence >= acceptThreshold` WITHOUT
  the `nearVerbatim` conjunct that the initial mapping applies at :149, so a paraphrase group
  demoted to OFFERED becomes AUTO after a keeper swap. Confirm intended or fix.
