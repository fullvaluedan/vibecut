---
title: "fix: recut quality (stop the 826-cut mess) + timeline performance on long projects"
date: 2026-07-02
type: fix
depth: deep
branch: feat/director-importance
origin: docs/brainstorms/2026-07-02-editor-perf-requirements.md
target_repo: framecut-director (clone at C:/Users/danom/Videos/framecut-director)
---

# fix: recut quality + timeline performance

## Summary

Dan's real "how to build a website" project (`d9b0924b`) came out of AI CUT with **826 timeline elements (413 video + 413 linked audio)** and it lags to edit and stutters on playback. Investigation showed the clip count is not a rendering quirk to engineer around — it is the visible symptom of an edit that was never actually cleaned up. This plan fixes both layers:

- **Track A — Recut quality (the real fix).** Make AI CUT produce a genuinely clean edit so a 32-minute source lands at roughly the ~150 clips a human would make, not 413. Concretely: actually remove the repeats the Director already detects (today they surface as accept-OFF review rows and silently stay on the timeline), remove real silent dead air (today only hesitation-word dead air is caught), delete whole redundant / out-of-context takes as units, and trim clip edges instead of hard-cutting where a trim is the right move.
- **Track B — Timeline performance (the safety net).** Make the editor stay responsive on any clip count so a heavily-cut long project does not lag. Coalesce drag updates to one per frame, memoize the clip component, cache the A/V-sync scan, virtualize the timeline to on-screen clips, and prefetch decode across cut boundaries so playback stops freezing.

Track A attacks the cause; Track B attacks the consequence. Both are needed: Track A shrinks new edits, Track B keeps the editor fast for this already-cut project and for any future long source.

**This plan does NOT change the transcription pipeline or the emphasis-pause protection shipped today (commit `5b7d6efe`)** — that fix already stops the sub-2s over-cutting *when a transcript is available*; it is a dependency of Track A, not part of it.

---

## Problem Frame

Raw evidence from the live project (measured via `window.__vibeEditor`, Phase B):

- **413 video clips**, median clip ~2.95s, 84 clips under 1 second.
- **386 of 412 boundaries removed content** (only ~2s of non-rippled gaps; nothing is a pointless split). Of raw ~60 min of source across 26 recordings, ~28 min was removed, ~32 min retained.
- **But 268 of the 386 cuts (69%) are under 2 seconds**, and those 268 cuts removed only ~199s total. The meaningful ~25 min of removal came from just 118 longer (>2s) cuts.
- **This project has no cached transcript**, so when AI CUT ran, the emphasis-pause protection had zero word timings and ran unprotected — the 268 sub-2s cuts are the unprotected-over-cutting signature.
- Playback: median frame 16.6ms (60fps baseline is fine), but **3 dead-stop stalls of ~594ms** plus a scatter of 55-74ms hitches in 19s of play — decode overrun at cut boundaries on a heavily-cut long source.

Dan's framing (authoritative): "826 cuts is a wild amount. There's definitely repeats, redundant videos, out of context video that can be completely deleted. Sometimes you need to trim and not cut. We have repeats that were cut but not removed from the timeline. You need to reassess what these cuts are and whether you're removing necessary stuff."

Root causes found in code:

1. **Repeats detected but not removed.** Redundancy groups only start ACCEPTED at `confidence >= 0.7`; the `[0.5, 0.7)` band and the lexical-repeat backstop both default to accept-OFF (`redundancy-apply.ts:21-27`, `run-director.ts` `backstopDefaultAccept` / `defaultAccept: false` mapping). The user must toggle each row on. Un-toggled repeats stay on the timeline, inflating the clip count and leaving duplicate content in the video.
2. **Silent dead air is not removed.** `detectDeadAirCuts` keys on hesitation WORDS (um/uh/okay), not audio silence (`director/dead-air.ts:21-38`). The only silence-gap dead-air detector is VAD (`detectVadDeadAirCuts`), which is opt-in and OFF by default (`run-director.ts` `directorVadDeadAirEnabled` gate). Genuine "sitting there in silence" survives.
3. **Everything is a ripple-cut; nothing is a trim.** The Director emits only `cut` (remove + ripple) ops. A removal that lands at a clip boundary should often be a trim (shorten the edge) rather than a cut that fragments the timeline.
4. **No over-cut consolidation.** After many small cuts, adjacent retained slivers of the same source are never re-merged, so the fragment count stays maximal.
5. **Timeline renders every clip, unmemoized, per pointer event.** Drag/trim forces a re-render of all 413 clips with no rAF coalescing, each running the O(total-elements) A/V-sync scan (`element-interaction-controller.ts` raw mousemove + notify → `use-element-interaction.ts` forced rerender → unmemoized `timeline-element.tsx` + `av-sync.ts:56-75` scan). Measured: ~152k element-visits per full re-render.
6. **Playback drops ticks on decode overrun.** The preview render is fired-and-not-awaited under a single in-flight guard; a cut-boundary deep seek into the long source exceeds the frame budget and the next tick is dropped (`preview/components/index.tsx:199,217`, `video-cache/service.ts:190-224`).

---

## Requirements

Carried and refined from the origin requirements doc (see origin), plus Track A from Dan's reassessment request.

**Track A — recut quality**
- **R1** — AI CUT removes the repeats it detects by default for high-confidence groups, and makes the remaining opt-in repeats obviously reviewable, so duplicate content does not silently stay on the timeline.
- **R2** — AI CUT removes real silent dead air (not only hesitation-word dead air) so long silent stretches are gone from the result.
- **R3** — AI CUT can delete a whole redundant or out-of-context take as a unit, rather than only fragmenting within it.
- **R4** — A removal at or near a clip edge is expressed as a trim where a trim is the correct edit, reducing needless fragmentation.
- **R5** — After cutting, adjacent retained slices of the same source with nothing removed between them are consolidated into one clip, so the timeline is not fragmented beyond the actual edit.
- **R6** — On a clean re-run of this 32-min source with a transcript present, the result lands at a human-plausible clip count (target: well under 413, order ~150), with no meaningful content wrongly removed.

**Track B — timeline performance**
- **R7** — Timeline drag/trim stays responsive (no sub-30fps stalls) on a 400+ clip project: per-pointer-event work is no longer O(n²) and is coalesced to one update per frame.
- **R8** — Playback holds frame rate on a heavily-cut long timeline with no ~600ms freezes at cut boundaries.
- **R9** — Scrubbing tracks the cursor within ~1 frame on the same project.
- **R10** — No correctness regressions: the A/V-sync badge shows the right offset; snapping, linked-selection drag, ripple-insert, the KTD3 seek fix, and cached waveforms all keep working.
- **R11** — All fixes are JS-side only; no dependence on rebuilding `opencut-wasm`.

---

## Key Technical Decisions

- **KTD1 (Track A is a recut-behavior change, not a destructive migration of the existing project).** The existing `d9b0924b` timeline is not rewritten by this plan. Track A changes what a FUTURE AI CUT run produces; the existing over-cut project is remediated by re-running AI CUT (now transcript-aware) or by Track B making it tolerable. This keeps Track A testable on fresh runs without risking Dan's current edit.
- **KTD2 (auto-accept high-confidence repeats; keep the low band opt-in).** Raise the effective removal so `>= DEFAULT_REDUNDANCY_ACCEPT_THRESHOLD` groups AND the lexical-repeat backstop for clearly-verbatim repeats default to ACCEPTED, while the `[floor, accept)` band stays opt-in (never auto-cut genuinely uncertain content). This directly targets root cause 1 without reintroducing the "auto-cut newly-surfaced content" risk the accept-OFF default was protecting against. The exact threshold and whether the lexical backstop flips are the load-bearing product calls — see Open Questions OQ1.
- **KTD3 (silent dead air via the existing VAD detector, made default-on for the Director analysis path).** `detectVadDeadAirCuts` already exists and is overlap-filtered against other cuts; the gap is that `directorVadDeadAirEnabled` defaults off. Turn it on for the Director path (not a new detector) so silent dead air is removed, degrading gracefully when VAD is unavailable. Confirm the VAD worker cost is acceptable on a 32-min source before committing to default-on (OQ2).
- **KTD4 (trim-vs-cut resolves at the apply boundary, not in every detector).** Introduce a single post-merge pass that converts a removal op whose edge sits within a small tolerance of a clip boundary into a trim of that clip, and leaves interior removals as ripple-cuts. Keeps the detectors unchanged and centralizes the trim decision.
- **KTD5 (consolidation pass merges adjacent same-source contiguous slices).** After the cut/trim ops are applied, run one pass that merges consecutive timeline clips where `next.mediaId === prev.mediaId` and `next.trimStart === prev.trimStart + prev.duration` (nothing removed between them) into a single clip. This is the mechanical cure for fragment inflation and is safe because it changes representation, not content. Pairs with the linked audio track so A/V stay aligned.
- **KTD6 (timeline virtualization is custom viewport-culling, not react-window).** `react-window` (already a dep, used in `font-picker.tsx`) assumes a uniform list; timeline clips are absolutely positioned by time. Render only clips whose `[startTime, startTime+duration]` intersects the visible horizontal scroll window plus a small overscan. This is the single biggest Track B lever at 413 clips.
- **KTD7 (A/V-sync offsets precomputed once per tracks-change).** Replace the per-clip `computeAvSyncOffset` scan with a single O(n) pass keyed by `linkId` at tracks-change, handed to each clip as a prop/context value. Kills the O(n²) both during drag and on any timeline re-render (origin OQ2 resolved in favor of the fuller fix).
- **KTD8 (playback prefetch across the next cut boundary).** Keep decode off the critical frame path by prefetching the next clip's frame at/near the boundary before the playhead crosses, so the deep seek is warm. Preferred over "cap per-frame work / hold last frame" because Phase B showed the stalls are boundary seeks, not steady-state overrun (origin OQ3 resolved in favor of prefetch).

---

## High-Level Technical Design

Where each fix sits in the existing Director pipeline and timeline/preview render paths:

```
AI CUT (runDirector)                          TRACK A changes
  assemble
  reorderClipsByTimestamp
  transcribe (full)  ── emphasis-pause protection needs this (shipped 5b7d6efe)
  removeSilences (word-protected)
  transcribe (shortened)
  detectors: dup-words, dead-air(words), filler, pacing,
             phrase/segment repeat, redundancy(LLM)
                                              A1: repeats default-ACCEPT for high conf   (KTD2)
             + VAD dead-air  ◄────────────────A2: default-ON for Director path           (KTD3)
  merge (keepers protect)
  ── trim-vs-cut pass ◄────────────────────── A4: edge removals become trims            (KTD4)
  ── consolidation pass ◄──────────────────── A5: merge adjacent same-source slices     (KTD5)
  energy-snap, clip-edge-snap
  open review

Timeline render (per pointer event)           TRACK B changes
  raw mousemove → notify → forced rerender ── B1: coalesce to one update per rAF        (R7)
  map ALL clips → <TimelineElement>       ──── B2: React.memo the clip                  (R7)
                                              B4: virtualize to on-screen clips (KTD6)
    each clip → <AvSyncBadge>              ──── B3: precompute offsets once (KTD7)

Preview render (per frame, playback)
  resolveNode → getFrameAt(activeClip)
    cut boundary → deep seekToTime  ────────── B5: prefetch across boundary (KTD8)
```

---

## Implementation Units

### Phase 1 — Track A: recut quality

### U1. Auto-accept high-confidence repeats; keep the uncertain band opt-in

**Goal:** Detected repeats above the accept threshold are removed by default so duplicate content does not silently stay on the timeline; the low-confidence band remains opt-in.

**Requirements:** R1 (KTD2)

**Dependencies:** none

**Files:**
- Modify `apps/web/src/features/ai-generate/director/run-director.ts` (the `backstopDefaultAccept` / `defaultAccept: false` mapping for `lexicalRepeatCuts`)
- Modify `apps/web/src/features/ai-generate/director/redundancy-apply.ts` (accept-default logic)
- Modify/extend `apps/web/src/features/ai-generate/director/__tests__/redundancy-apply.test.ts`

**Approach:** Make `>= DEFAULT_REDUNDANCY_ACCEPT_THRESHOLD` groups start accepted (already the intent) AND flip clearly-verbatim lexical-repeat backstop cuts to `defaultAccept: true`, while `[floor, accept)` groups stay accept-OFF. Do not auto-accept the genuinely-uncertain band — that boundary is what protects against cutting newly-surfaced content. Surface a review summary count so the user sees how many repeats were auto-removed vs left opt-in.

**Patterns to follow:** existing `defaultAccept` plumbing in `redundancy-apply.ts`; the accept-threshold constants already defined there.

**Test scenarios:**
- A `0.85`-confidence redundancy group produces cut ops with `defaultAccept: true`.
- A `0.6`-confidence group stays `defaultAccept: false` (opt-in), unchanged.
- A verbatim lexical phrase-repeat backstop cut defaults to accepted; a paraphrase-adjacent one does not.
- The keeper take of every group is never in the accepted-cut set (no group loses all takes).
- Review summary reports correct auto-removed vs opt-in counts.

**Verification:** On a source with known duplicate takes, a default AI CUT run removes the clear repeats without the user toggling rows; uncertain repeats still appear as opt-in.

### U2. Remove real silent dead air (VAD default-on for the Director path)

**Goal:** Long silent stretches are removed, not just hesitation-word clusters.

**Requirements:** R2 (KTD3)

**Dependencies:** none

**Files:**
- Modify `apps/web/src/features/ai-generate/director/run-director.ts` (the `directorVadDeadAirEnabled` gate for the analysis path)
- Modify `apps/web/src/features/ai-generate/store.ts` (default value, if the default lives there)
- Extend `apps/web/src/features/ai-generate/director/__tests__/` coverage for the dead-air merge inclusion

**Approach:** Default the Director's VAD dead-air pass on for the analysis path only (leave the user setting as an override). Keep it non-throwing and overlap-filtered against the other detectors, exactly as wired today. Confirm the VAD worker runtime on a 32-min source is acceptable (OQ2) before finalizing default-on; if too slow, gate default-on by duration or expose a one-click "remove dead air" in review instead.

**Patterns to follow:** the existing `detectVadDeadAirCuts` wiring and overlap filter in `run-director.ts`.

**Test scenarios:**
- With VAD default-on and a synthesized speech/silence/speech buffer, a > threshold silent gap surfaces as a dead-air cut.
- A silent gap already covered by a word/pacing cut is filtered out (no double).
- VAD failure/unavailable degrades to no dead-air cuts without throwing (Director still completes).
- Emphasis-pause keepers still protect a short mid-sentence pause from the dead-air cut (no regression to the shipped protection).

**Verification:** A recording with a genuine multi-second silent pause has that silence removed by a default AI CUT run.

### U3. Delete whole redundant / out-of-context takes as a unit

**Goal:** A redundant or out-of-context recording/take is removed as one op, not fragmented.

**Requirements:** R3

**Dependencies:** U1 (shares the redundancy/take-cluster surface)

**Files:**
- Modify `apps/web/src/features/ai-generate/director/take-clusters.ts` and/or `redundancy.ts`
- Modify `apps/web/src/features/ai-generate/director/run-director.ts` (fold whole-take removals into the op set)
- Add `apps/web/src/features/ai-generate/director/__tests__/whole-take-removal.test.ts`

**Approach:** When a take cluster keeps its best member, emit a single whole-span cut for each non-keeper take rather than letting per-line detectors nibble it. Extend to flag an entire recording as out-of-context when it has near-zero retained-signal relevance (definition is an open question — OQ3). Keep keepers protected in the merge.

**Test scenarios:**
- A 3-take cluster emits one whole-span cut per non-keeper, keeper untouched.
- Cut spans align to clip boundaries (no mid-word take edges) after the snap chain.
- An out-of-context recording with no keeper-cluster membership is flagged for removal (opt-in if uncertain).
- Removing a whole take never removes its linked-audio partner independently (A/V stays consistent).

**Verification:** A source with an abandoned duplicate take deletes the whole take, not 15 fragments of it.

### U4. Trim-vs-cut resolution + adjacent-slice consolidation

**Goal:** Edge removals become trims; adjacent same-source contiguous slices merge; the fragment count collapses to the real edit.

**Requirements:** R4, R5, R6 (KTD4, KTD5)

**Dependencies:** U1, U2, U3 (runs on the merged op set)

**Files:**
- Create `apps/web/src/features/ai-generate/director/resolve-trim-vs-cut.ts` (pure)
- Create `apps/web/src/features/ai-generate/director/consolidate-adjacent-clips.ts` (pure)
- Create `apps/web/src/features/ai-generate/director/__tests__/resolve-trim-vs-cut.test.ts`
- Create `apps/web/src/features/ai-generate/director/__tests__/consolidate-adjacent-clips.test.ts`
- Modify `apps/web/src/features/ai-generate/director/run-director.ts` (wire both passes after merge, before/around the snap chain)

**Approach:** `resolveTrimVsCut` converts a removal whose start or end lands within tolerance of a clip boundary into a trim of that clip edge, leaving interior removals as ripple-cuts. `consolidateAdjacentClips` merges consecutive clips where `next.mediaId === prev.mediaId && next.trimStart === prev.trimStart + prev.duration` into one, on both the video track and its linked audio track in lockstep. Both are pure functions over op/clip lists so they are bun-testable and ordering-safe.

**Execution note:** implement the two pure resolvers test-first — they are the correctness core of the fragment-count fix.

**Test scenarios:**
- A removal ending 3 frames inside a clip's trailing edge becomes a trim, not a cut.
- An interior removal (both edges mid-clip) stays a ripple-cut.
- Two adjacent clips continuous in source (`trimStart` meets `trimEnd`) merge to one; their linked audio merges identically.
- Two adjacent clips with a real source jump between them do NOT merge (content was removed).
- A merged clip's duration equals the sum of the merged parts; total timeline duration is unchanged by consolidation.
- Consolidation is idempotent (running twice changes nothing).

**Verification:** Re-running AI CUT on the 32-min source lands well under 413 clips (target ~150) with the same retained content.

---

### Phase 2 — Track B: timeline performance

### U5. Coalesce drag/trim updates to one per frame + memoize the clip component

**Goal:** Per-pointer-event work stops forcing an unmemoized re-render of all 413 clips.

**Requirements:** R7 (origin H1)

**Dependencies:** none (independent of Track A)

**Files:**
- Modify `apps/web/src/timeline/controllers/element-interaction-controller.ts` (rAF-coalesce the raw mousemove → notify)
- Modify `apps/web/src/timeline/hooks/use-element-interaction.ts` (forced rerender path)
- Modify `apps/web/src/timeline/components/timeline-element.tsx` (wrap in `React.memo` with a correct equality boundary)

**Approach:** Batch mousemove-driven `notify()` calls to at most one per animation frame (store latest event, flush on rAF). Memoize `TimelineElement` so clips whose props are unchanged by a drag do not re-render. Ensure the `dragView` prop stops allocating a fresh object every move (or is excluded from the memo comparison for non-dragged clips) so memoization actually bites.

**Patterns to follow:** existing rAF usage in `preview/components/index.tsx`; existing `React.memo` on `Timeline` (`timeline/components/index.tsx`).

**Test scenarios:**
- Test expectation: interaction-timing behavior is validated live (Phase B rerun); unit-cover the pure "latest-event-per-frame" coalescer if extracted as a helper.
- If a coalescer helper is extracted: given 10 events in one frame, exactly one flush fires with the last event's coordinates.
- Memo equality: a clip not under the active drag receives referentially-stable props across a drag move (no re-render).

**Verification:** Live rerun of the Phase B drag measurement (mousemove/s vs rAF/s; per-frame pacing during a real hardware drag) shows drag re-renders coalesced to ~1 per frame and no sub-30fps stall on the 413-clip project.

### U6. Precompute A/V-sync offsets once per tracks-change

**Goal:** Eliminate the O(n²) per-clip A/V-sync scan.

**Requirements:** R7, R10 (KTD7, origin H2)

**Dependencies:** none

**Files:**
- Create `apps/web/src/timeline/av-sync-map.ts` (pure: tracks → Map<elementId, offsetFrames+partner>)
- Modify `apps/web/src/timeline/av-sync.ts` (reuse the pairing logic in a single O(n) pass)
- Modify `apps/web/src/timeline/components/timeline-element.tsx` (consume precomputed value instead of calling `computeAvSyncOffset`)
- Create `apps/web/src/timeline/__tests__/av-sync-map.test.ts`

**Approach:** One pass keyed by `linkId` (with the legacy `mediaId`+overlap fallback) builds every clip's offset once per tracks-change, memoized on the tracks reference. Each `AvSyncBadge` reads its precomputed value. Preserve the exact offset semantics (audio-relative-to-video frames) so the badge is unchanged.

**Test scenarios:**
- A linked V/A pair with a 108-frame drift yields the same `offsetFrames` the per-clip function produced.
- Legacy pairing (no `linkId`, same `mediaId`, overlapping source) resolves identically.
- An unlinked clip yields no offset entry.
- The map is recomputed when the tracks reference changes and reused when it does not.
- Parity test: for the real 413-clip project shape, `av-sync-map` values equal `computeAvSyncOffset` per clip (no behavior change).

**Verification:** Badge offsets unchanged; Phase B `computeAvSyncOffset` self-time during a drag drops to a single O(n) pass per edit.

### U7. Virtualize the timeline to on-screen clips

**Goal:** Render only clips intersecting the visible scroll window, so 413 (or more) clips cost like the ~30 on screen.

**Requirements:** R7 (KTD6)

**Dependencies:** U5, U6 (memoization + cheap per-clip render make culling clean; virtualization multiplies their benefit)

**Files:**
- Modify `apps/web/src/timeline/components/index.tsx` (the track-rows clip map)
- Possibly create `apps/web/src/timeline/hooks/use-visible-clips.ts` (compute the intersecting slice from scrollLeft + viewport width + overscan)
- Create `apps/web/src/timeline/__tests__/use-visible-clips.test.ts`

**Approach:** Custom viewport-culling (not `react-window`, per KTD6): from the horizontal scroll offset, viewport width, and pixels-per-tick, compute the `[startTick, endTick]` window plus overscan, and render only clips whose span intersects it. Keep absolute positioning so scroll and layout are unchanged. Preserve drag/selection correctness for a clip that scrolls out mid-drag (the active drag target stays mounted).

**Test scenarios:**
- Given 413 clips and a viewport showing ticks `[a, b]`, only clips intersecting `[a-overscan, b+overscan]` are returned.
- A clip exactly at the viewport edge is included.
- The active drag target is retained even when its span leaves the window.
- Empty window (scrolled past all clips) returns nothing without error.

**Verification:** Live: DOM node count for the timeline reflects ~on-screen clips, not 413; scrolling and dragging remain correct.

### U8. Prefetch decode across the next cut boundary in playback

**Goal:** Eliminate the ~600ms playback freezes at cut boundaries.

**Requirements:** R8, R9, R10 (KTD8, origin H4/H5)

**Dependencies:** none (independent of Track A and the timeline units)

**Files:**
- Modify `apps/web/src/services/video-cache/service.ts` (prefetch path around `seekToTime` / the existing prefetch at `:226-264`)
- Modify `apps/web/src/renderer/resolve.ts` or `apps/web/src/preview/components/index.tsx` (trigger boundary prefetch as the playhead approaches a clip end)
- Add/extend `apps/web/src/services/video-cache/__tests__/` for the boundary-prefetch decision (pure part)

**Approach:** As the playhead nears the current clip's end during playback, warm the next clip's frame at its boundary source time so the crossing hits the fast-path instead of a cold deep seek. Keep the existing supersede-by-time logic (do not regress the KTD3 seek-race fix). Extract the "should prefetch next boundary now" decision as a pure function for unit testing; the decode itself is validated live.

**Test scenarios:**
- Pure decision: given playhead time, current clip end, and a lookahead window, prefetch triggers once within the window and not before.
- Prefetch targets the correct next-clip source time at the boundary.
- Supersede-by-time still holds: a newer distinct seek is not starved by an outstanding prefetch (no regression to the shipped seek fix).
- No prefetch fires when the next boundary is a same-clip continuation (nothing to warm).

**Verification:** Live rerun of the Phase B playback measurement on the 413-clip project shows the ~594ms cut-boundary stalls gone (no >100ms frames clustered at boundaries).

---

## Scope Boundaries

**In scope:** Director recut behavior (repeat removal defaults, silent dead air, whole-take deletion, trim-vs-cut, consolidation) and timeline/preview performance (coalesce, memoize, sync-scan cache, virtualization, playback prefetch).

**Non-goals:**
- Rewriting or auto-remediating Dan's existing `d9b0924b` timeline. Remediation is a re-run of AI CUT (now transcript-aware) or living with it via Track B (KTD1).
- Changing the transcription pipeline or the emphasis-pause protection shipped today (dependency, not target).
- Rebuilding `opencut-wasm` or any wasm-internal change (R11).

### Deferred to Follow-Up Work
- A "clip-count warning / likely-over-cut" heuristic in the UI (Dan reviewed and declined this framing).
- SRT/VTT and other export-format work.
- A general timeline-store performance audit beyond the drag/render hot path.

---

## Risk Analysis & Mitigation

- **Auto-accepting repeats removes something wanted (R1/U1).** Mitigation: only auto-accept above the existing accept threshold and clearly-verbatim lexical repeats; keep the uncertain band opt-in; surface a summary count; everything is one undo. Live-verify on a real multi-take source before shipping the default change.
- **VAD default-on is too slow on 32-min sources (R2/U2).** Mitigation: measure VAD worker time first (OQ2); if too slow, gate default-on by duration or make it a one-click review action instead of automatic.
- **Consolidation or trim-vs-cut corrupts A/V alignment (R4/R5/U4).** Mitigation: operate on video and linked audio in lockstep; pure functions with parity/idempotence tests; total-duration-unchanged assertion.
- **Virtualization breaks drag/selection for off-screen clips (R7/U7).** Mitigation: keep the active drag target mounted; overscan; live drag/scroll verification.
- **Playback prefetch regresses the shipped seek-race fix (R8/U8).** Mitigation: preserve supersede-by-time; add a regression test asserting a newer distinct seek is not starved.

---

## Open Questions

- **OQ1 (repeat auto-accept threshold).** Keep `0.7` as the auto-accept line, or lower it (and does the lexical-repeat backstop flip to default-accept for verbatim-only)? Decide with a real multi-take source in U1; product-tunable.
- **OQ2 (VAD default-on cost).** Is the VAD worker fast enough on a 32-min source to default-on unconditionally, or should it be duration-gated / one-click? Measure before finalizing U2.
- **OQ3 (out-of-context definition).** What signal marks a whole recording as out-of-context and safe to delete (near-zero relevance, no cluster membership, operator-flagged)? Needed for the second half of U3; if unclear, ship whole-take removal for redundancy clusters only and defer out-of-context detection.
- **OQ4 (Track A verification without disturbing the live project).** Re-run AI CUT on a COPY/fresh import of the same 26 recordings to validate R6's ~150-clip target, so Dan's current edit is untouched. Confirm a safe way to duplicate the source set for the test run.

---

## Verification

- `bunx tsc --noEmit` = 0 in `apps/web`; new unit tests green (`redundancy-apply`, whole-take removal, `resolve-trim-vs-cut`, `consolidate-adjacent-clips`, `av-sync-map`, `use-visible-clips`, boundary-prefetch decision).
- **Track A (live, on a fresh run of the 26-recording source):** default AI CUT removes clear repeats without row-toggling, removes a genuine silent pause, deletes a whole redundant take, and lands well under 413 clips (~150 target) with no meaningful content wrongly removed.
- **Track B (live, on the existing 413-clip project):** Phase B drag measurement shows coalesced re-renders and no sub-30fps stall; timeline DOM node count reflects on-screen clips; playback measurement shows the ~594ms cut-boundary stalls gone; badge offsets, snapping, linked-selection, and waveforms unchanged.
