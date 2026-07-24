---
title: "feat: Director round 9 (speculation + smooth-filler defaults, cut-row seek, persistent review)"
type: feat
date: 2026-07-18
depth: standard
---

# feat: Director round 9 (speculation + smooth-filler defaults, cut-row seek, persistent review)

## Summary

Dan's verdict from his first real run on a finished video (2026-07-18): the cut list is good but
two defaults fight his style, and the review dock needs two UX affordances. (1) He deliberately
ends sections with trailing speculation; coherent speculation must be KEPT by default, offered as
an opt-in cut. (2) His delivery flows smoothly through filler words; a filler inside continuous
speech should start unchecked, while a filler next to a real pause stays auto-cut. (3) Each cut
row should jump the timeline playhead to just before the cut (slider 1-10s of pre-roll) so he can
watch the transition. (4) The Done button goes away: the review dock persists after apply, and
toggling rows keeps applying/unapplying cuts (the existing revise flow already restores a clipped
segment on uncheck).

## Dan's binding decisions (2026-07-18)

- Coherent trailing speculation: keep by default, surface as an unchecked opt-in cut row.
- Fillers in smooth speech: unchecked by default; fillers beside a real pause stay checked.
- Row click seeks to (cut start - pre-roll) and plays; pre-roll slider 1-10s, default 1s.
- Done button removed. The review persists; unchecking an applied cut restores the segment
  (revise flow). The applied-locked phase keeps its current behavior.

## Requirements

- R1. The Director prompt distinguishes coherent trailing speculation/musing from incoherent
  rambling. Coherent speculation cuts arrive tagged, map to a new `speculation` category, start
  unchecked (`defaultAccept: false`), badge "Speculation", unchecked hint "Keeping the
  speculation". Incoherent rambling and dead time remain plain auto-accepted cuts.
- R2. `detectFillerCuts` demotes a filler/hedge op to `defaultAccept: false` when speech flows
  through it: gap to the nearest valid word is under the smooth threshold on BOTH sides. False
  starts (cut-off fragments) are never demoted. Unchecked filler rows show "Keeping the filler".
- R3. The cut-review row's timestamp is a button: click seeks the playhead to
  max(0, startSec - preRoll) and plays. A pre-roll slider (1-10s, default 1s) sits in the panel;
  the value survives plan close/reopen within the session.
- R4. The cut panel has no Done button in any phase. Review phase keeps Cancel + Apply. The
  applied phase persists indefinitely; a new AI CUT run replaces the plan (verified path:
  run-director.ts:384 openCutPanel resets state).
- R5. Standing rules: Edit tool only; no em dashes in added lines (U+2014 grep); prompt wording
  change bumps a version constant threaded into the eval cache key; new category completes the
  five-piece checklist; suites + tsc + diag assertions + four-fixture eval before Dan's smoke pass.

## Key technical decisions

- KTD1. The LLM tags speculation via a new optional `kind` field (enum: ["speculation"]) in
  DIRECTOR_SCHEMA. Mapping to `category: "speculation"` + `defaultAccept: false` happens inside
  `sanitizeDirectorPlan` (hf-bridge), so the app route and the eval adapter get identical
  behavior. `stableOpId` hashes op|start|end|target only, so ids are unaffected.
- KTD2. New `DIRECTOR_PROMPT_VERSION = 2` exported from author.ts beside the prompt; the eval
  adapter's plan-pass `cachedCall` payload becomes `{ ...input, promptVersion }` (the
  VERIFY_PROMPT_VERSION precedent). Without it the eval replays stale cached plans.
- KTD3. Five-piece category checklist for `speculation`: author.ts union; taste.ts CATEGORIES;
  taste.ts CATEGORY_LABEL; review-format.ts CATEGORY_BADGE + rejectedHint; justify-cuts.ts
  JUSTIFIED_REMOVAL (a categorized op absent from that set is silently reverted pre-review).
- KTD4. Smooth threshold `SMOOTH_GAP_SEC = 0.2` in filler-words.ts. Neighbor = nearest word with
  end > start scanning outward; a missing neighbor (clip edge) counts as a pause, so edge fillers
  stay auto-cut. The demoted op's reason gains "(mid-sentence, speech flows through)" so the row
  explains itself even while checked, mirroring the phrase-repeat wording precedent.
- KTD5. Seek reuses the assemble panel's `playAt` precedent (editor.playback.seek + play). The
  timestamp button is type="button" with stopPropagation/preventDefault so a click never toggles
  the row checkbox. `seekPreRollSec` lives in director-plan-store OUTSIDE the CLEARED reset
  object, so open/close cycles preserve it for the session.
- KTD6. Demoted fillers drop out of the clamp-evidence set automatically (it filters
  defaultAccept !== false); this matches the round-7 treatment of demoted rows and is accepted.
- KTD7. No worktree agents this round: four small sequential units, one commit each, inline.

## Implementation units

### U1. Smooth-filler demotion
filler-words.ts: gap computation + demotion + reason suffix; review-format.ts: filler branch in
rejectedHint; filler-words.test.ts: smooth vs paused vs edge vs false-start cases.

### U2. Speculation category end to end
author.ts: kind in schema, prompt bullet + JSON instruction line, sanitize mapping,
DIRECTOR_PROMPT_VERSION, category union; index.ts export; taste.ts both pieces;
review-format.ts badge + hint; justify-cuts.ts allow-list; eval llm-adapter.ts plan cache key.
Tests: sanitize kind mapping (valid, invalid kind ignored, non-cut kind ignored), justify
allow-list, review-format hint.

### U3. Cut-row seek + pre-roll slider
director-plan-store.ts: seekPreRollSec + setSeekPreRollSec (outside CLEARED);
director-cut-panel.tsx: timestamp button + slider row; store test for persistence across close.

### U4. Remove Done, persistent review
director-cut-panel.tsx: header Done and applied-footer Done removed; review-phase Cancel kept;
copy updated ("review stays open; start a new AI CUT run to replace it"). Tests referencing the
dismiss flow adjusted.

### U5. Gates + handoff surfaces
Suites (1374+174 baseline, 3 pre-existing mask failures) + tsc + diag assertions
(bun scripts/diag-join-the-group.ts) + four-fixture eval --llm (plan pass re-runs live: prompt
changed; compare OFFERED match / AUTO essLost to round-7 numbers 61.0/78.2/37.5/81.6 and
8/66/26/15). TO-VERIFY.md rows for Dan's smoke pass. No upstream files expected; PATCHES.md
only if that changes.

## Risks

- The prompt change can shift the plan pass beyond speculation tagging; the four-fixture eval is
  the guard, and AUTO essLost should only improve (speculation moves AUTO to OFFERED).
- Over-tagging: the model may tag mid-video tangents as speculation. The bullet scopes it to
  trailing/afterthought musing and requires coherence; eval + Dan's pass judge it.
- SMOOTH_GAP_SEC 0.2 may demote fillers Dan wants gone; they remain one click away, and taste
  learning records his accepts.
- Removing Done leaves applied-locked with no dismiss affordance by design; a stale locked list
  is replaced by the next run. Named consciously.

## Sources

Dan's 2026-07-18 review screenshot + notes (this session); recon maps (two Explore agents,
in-session); docs/HANDOFF-2026-07-17.md lessons; docs/plans/2026-07-17-001 and -002 precedents.
