---
title: "fix: AI-CUT emphasis-pause protection + higher repeat/mistake recall + docked cut-list panel"
date: 2026-07-01
type: fix
status: planned
branch: feat/director-importance
target_repo: framecut-director (clone at C:/Users/danom/Videos/framecut-director)
origin: none (planned directly from Dan's live-test feedback on AI-CUT issues #4 and #5)
---

# fix: AI-CUT emphasis-pause protection + higher repeat/mistake recall + docked cut-list panel

## Summary

Three coupled AI-CUT improvements, all inside the existing AI Director pipeline. Nothing here is a new subsystem: the holistic whole-transcript pass, the multi-source cut merge, the accept/reject review, and a docked properties panel all already exist. This plan tunes them.

1. **Stop over-cutting deliberate pauses (#4).** Today `detectPacingCuts` trims any inter-segment gap over 0.8s down to 0.4s, and the standalone RMS "Remove silences" cuts any quiet stretch over 0.6s, with no notion of a pause. Add an emphasis-pause keeper: keep a gap up to about 2s when it reads as a deliberate beat (bounded by speech on both sides) AND no repeat/mistake cut sits around it. Otherwise cut as today.
2. **Catch more repeats/mistakes for approval (#5).** The default AI Director already sends the whole transcript to the model and groups retakes, but it is tuned to under-cut (conservative prompt, a 0.7 confidence floor, a suppressed deterministic backstop, segment-only granularity). Raise recall so more repeats and reworded restatements land in the review list, surfaced as accept-off rows for the user to approve rather than auto-applied.
3. **Dock the cut list (new).** Move the cut-list review out of the Radix modal into the right-side properties panel (the same box that holds Transform / Audio / Effect Controls), reusing the already-docked assemble panel's surface-takeover pattern so it stays open and editable while the user works.

---

## Problem Frame

Dan live-tested the AI Director's cutting on real footage and reported two defects plus one UX ask:

- **#4 Silence too aggressive:** casual pauses get cut. Dan's rule: keep up to ~2s of silence between dialog "only if it seems like it makes sense to pause to emphasize and there's not repeats/mistakes around the pause." So the keep decision is conditional on (a) the gap reading as a deliberate emphasis beat and (b) the absence of a nearby repeat/mistake cut.
- **#5 Repeats missed:** "many repeats were not caught." Dan wants "cuts decided after going through the transcript" (holistic), and "add more redundant/repeats/mistakes to the cut list so we can approve."
- **New UX:** "keep the cut list panel in a window (same box as the transform and audio panel) so we can make changes when needed."

Research finding that reshapes #5: the holistic transcript pass is already the default (`llm-redundancy.ts` via `POST /api/director/redundancy`). The misses come from conservative tuning, not from a missing pass. So #5 is a recall + surfacing change, not new architecture.

---

## Requirements

- **R1 (#4):** In the AI Director, a silent inter-segment gap up to a configurable ceiling (~2s) is KEPT when it is bounded by speech on both sides and no repeat/mistake cut lies within a small window of it. Longer gaps, leading/trailing dead air, and gaps adjacent to a repeat/mistake are still cut.
- **R2 (#4):** The keep rule suppresses ALL cut sources that would remove that gap in the Director: `detectPacingCuts`, `detectVadDeadAirCuts`, and the RMS silence pass, not just one.
- **R3 (#4):** The standalone "Remove silences" menu action also keeps emphasis pauses (using the same pure helper with an empty repeat/mistake set), degrading safely when word timings are unavailable.
- **R4 (#5):** The default AI Director surfaces MORE repeat/mistake candidates into the review list. Newly surfaced lower-confidence candidates appear as review rows that default to NOT accepted, so the user opts in rather than the tool auto-cutting.
- **R5 (#5):** The deterministic repeat backstop (take-cluster / segment-repeat) contributes candidates additively alongside the LLM pass, not only when the LLM route errors.
- **R6 (new):** The cut-list review renders inside the properties panel (persistent, editable, survives deselection), preserving accept/reject, swap-to-alternate, apply-as-one-undo, and the "Ctrl+Z to undo" messaging.
- **R7 (safety):** No new auto-cutting of distinct content. Everything the higher recall surfaces is review-gated. The existing keeper-protection and single-BatchCommand-undo invariants hold.

---

## Key Technical Decisions

- **KTD1 (#4 heuristic, not LLM, for v1):** "Seems like an emphasis pause" is operationalized as a deterministic heuristic: gap duration <= ceiling, a transcript word ends just before the gap and another begins just after it (bounded by speech, so it is mid-delivery rather than leading/trailing/between-takes), and no repeat/mistake cut span lies within a proximity window. Rationale: deterministic, testable, no extra latency, and the transcript+word timings + repeat spans are all already in scope in `run-director.ts`. An LLM emphasis judgment is deferred (see Open Questions).
- **KTD2 (#4 coordination via keepers, not deletion):** The keep decision is expressed as `KeeperSpan`s injected into `mergeDetectedCuts`, which already drops removals overlapping a keeper. This is the existing primitive for "protect this span," so we do not special-case each detector. The keepers must be computed AFTER the repeat/mistake cut spans are known and injected into the merge that fuses the pause-removing sources.
- **KTD3 (#5 reuse, tune recall):** Reuse `planRedundancy` / `buildRedundancyPrompt` / `mapRedundancyGroups` unchanged in shape. Recall is raised by: softening the conservative prompt language, lowering the confidence floor, and surfacing sub-floor groups as accept-off review rows instead of dropping them.
- **KTD4 (#5 additive backstop):** Change `shouldRunLexicalRepeatDetectors` so the deterministic take-cluster / segment-repeat detectors run additively with the LLM pass and feed the review list. `mergeDetectedCuts` already dedups overlaps and protects keepers, so unioning is safe. Word-timing-dependent `phrase-repeat` stays best-effort (no-ops when the device model emits no word timings).
- **KTD5 (new dock via surface-takeover, not a tab):** The properties panel tab registry is element-scoped (keyed by element type, content remounted per element id). A global plan is not an element, so the cut list is NOT a `PropertiesTabDef`. Instead reuse the assemble panel's mechanism: a `surface: 'panel'` + `mode: 'cut'` state in `director-plan-store.ts` and a branch at the TOP of `PropertiesPanel` (above the selection gate) that returns a new `DirectorCutPanel`. This is exactly how the assemble review already docks.

---

## High-Level Technical Design

Director cut flow after this plan (conceptual, `run-director.ts`):

```
transcript + words
      |
      v
[ always-on word cuts ]   [ pacing cuts ]   [ vad dead-air (opt-in) ]   [ RMS remove-silences (pre-step) ]
      |                        |                     |                             |
      |                        +------- pause-removing sources -------------------+
      |                                              |
[ repeat/mistake cuts ]  <-- LLM redundancy (recall-raised) + additive deterministic backstop
      |                                              |
      v                                              v
  repeatSpans  ------------------> [ computeEmphasisPauseKeepers(gaps, words, repeatSpans) ] --> keepers
                                                     |
                                                     v
                          mergeDetectedCuts(cuts, keepers)   // keepers suppress pause cuts
                                                     |
                                                     v
                          openCutPanel({plan, redundancyGroups})   // docked, not modal
                                                     |
                                                     v
                          user accept/reject/swap  -->  applyDirectorPlan (one BatchCommand)
```

Docking reuses the existing assemble-panel takeover:

```
PropertiesPanel()
  if surface==='panel' && mode==='assemble' && draft   -> <DirectorPanel/>      (exists today)
  if surface==='panel' && mode==='cut'      && plan     -> <DirectorCutPanel/>   (new, this plan)
  ... selection gate (EmptyView when nothing selected) ...
  ... element tab strip ...
```

---

## Implementation Units

### U1. Pure emphasis-pause classifier

**Goal:** A pure, wasm-free helper that decides which candidate silence gaps to KEEP as emphasis pauses.

**Requirements:** R1, R2 (provides the decision the merge consumes).

**Dependencies:** none.

**Files:**
- Create `apps/web/src/features/ai-generate/director/emphasis-pause.ts`
- Create `apps/web/src/features/ai-generate/director/__tests__/emphasis-pause.test.ts`

**Approach:** Export `computeEmphasisPauseKeepers({ gaps, words, repeatSpans, maxPauseSec = 2.0, proximitySec })`. A `gap` is `{ start, end }` in seconds (an inter-segment / silence span). Return a list of `KeeperSpan`s for each gap where all hold: `end - start <= maxPauseSec`; a word ends within a small snap of `start` AND a word begins within a small snap of `end` (bounded by speech on both sides); and no `repeatSpan` overlaps or lies within `proximitySec` of the gap. When `words` is empty or `wordsUnavailable`, return no keepers (caller falls back to prior behavior). Keep it side-effect free.

**Patterns to follow:** `KeeperSpan` / `spansOverlap` in `director/cut-utils.ts`; the pure-helper + bun-test shape in `director/__tests__/` and `features/editing/__tests__/silence-refine.test.ts`; `TranscriptWordLite = { start, end, text }` from `features/transcription/transcript-cache.ts`.

**Test scenarios:**
- Happy path: a 1.5s gap with a word ending at its start and a word starting at its end, no repeat nearby -> one keeper returned.
- Ceiling: a 2.5s gap (> maxPauseSec) -> no keeper (still cut).
- Leading/trailing: a gap with speech on only one side (or none) -> no keeper.
- Repeat proximity: a qualifying 1.2s gap with a repeat/mistake span within proximitySec -> no keeper (Dan's "no repeats/mistakes around the pause").
- Edge: gap exactly at maxPauseSec -> kept; gap 1 tick over -> not kept.
- Words unavailable: empty `words` -> returns [] regardless of gaps.
- Purity: inputs not mutated.

**Verification:** All scenarios pass under `bun test`; `bunx tsc --noEmit` clean.

---

### U2. Wire emphasis-pause protection into the Director

**Goal:** Suppress pacing / vad-dead-air / silence cuts on emphasis pauses inside the AI Director, coordinated with repeat/mistake cuts.

**Requirements:** R1, R2, R7.

**Dependencies:** U1.

**Files:**
- Modify `apps/web/src/features/ai-generate/director/run-director.ts`
- Modify (if a shared collect is cleaner) `apps/web/src/features/ai-generate/director/cut-utils.ts`
- Test: extend `apps/web/src/features/ai-generate/director/__tests__/` with a run-director-level or cut-utils-level test that a protected gap survives the merge

**Approach:** In `run-director.ts`, after the repeat/mistake cut spans are known (redundancy cuts + phrase/segment-repeat + duplicate-word cuts, all in scope before the merge at ~L429-456) and before/at the `mergeDetectedCuts` that fuses the pause-removing sources: build the candidate gap list (the inter-segment gaps that pacing/vad-dead-air/RMS would target), call `computeEmphasisPauseKeepers` with the transcript words and those repeat spans, and pass the returned keepers into `mergeDetectedCuts`'s `keepers` argument so overlapping pacing/dead-air/silence removals are dropped. Preserve the existing two-pass merge ordering (base merge, then redundancy-authority merge) and the energy/clip-edge snap that follows.

**Execution note:** Characterize the current merge output on a small fixture first (this is legacy multi-source merge logic), then add the keeper injection so the diff is provable.

**Patterns to follow:** the existing `keepers`/`selectProtectedSpans`/importance usage in `run-director.ts`; `mergeDetectedCuts` keeper semantics in `cut-utils.ts`.

**Test scenarios:**
- Integration: given a fixture with a 1.5s speech-bounded gap and pacing+deadair cuts targeting it, after merge the gap is NOT removed.
- Coupled: same gap but with a redundancy cut adjacent -> the gap IS removed (no keeper).
- Regression: a 3s leading dead-air gap is still removed.
- Ordering: the redundancy-authority second merge still wins its documented conflicts (re-run the existing merge test).

**Verification:** New integration test passes; existing Director merge tests stay green; `bunx tsc --noEmit` clean.

---

### U3. Emphasis-pause protection for standalone "Remove silences"

**Goal:** The standalone AI-CUT "Remove silences" action also keeps emphasis pauses.

**Requirements:** R3, R7.

**Dependencies:** U1.

**Files:**
- Modify `apps/web/src/features/editing/remove-silences.ts`
- Modify `apps/web/src/features/editing/silence-refine.ts`
- Test: extend `apps/web/src/features/editing/__tests__/silence-refine.test.ts`

**Approach:** In `runRemoveSilences`, best-effort fetch word timings via `getCachedTranscript(editor)` (do NOT trigger a blocking transcription; if the cache is empty, skip and behave as today). Convert the detected silent runs into gap candidates and run `computeEmphasisPauseKeepers` with an EMPTY repeat set, then drop kept spans from the cut list before building the `RemoveRangesCommand`. Classify BEFORE the clip-subtraction split in `refineSilenceRanges` (per the gotcha that refine can split a range). When words are unavailable, either behave as today or apply a raised floor; keep behavior explicit and documented in a constant.

**Patterns to follow:** `remove-repeats.ts` already consumes `getCachedTranscript`/`ensureTimelineTranscript` (the read pattern); `refineSilenceRanges` guard structure.

**Test scenarios:**
- With words: a 1.5s speech-bounded silent run is kept; a 3s run and a leading run are cut.
- Without words (empty cache): falls back to current behavior (documented) with no crash.
- Padding not double-counted when computing the natural-pause duration.
- Applied result is still one `RemoveRangesCommand` (single undo).

**Verification:** Tests pass; standalone Remove silences no longer eats short in-dialog pauses on a words-available timeline; `bunx tsc --noEmit` clean.

---

### U4. Raise repeat/mistake recall in the LLM redundancy pass

**Goal:** Surface more repeats/reworded restatements as review candidates.

**Requirements:** R4, R7.

**Dependencies:** none (independent of #4 units).

**Files:**
- Modify `packages/hf-bridge/src/llm-redundancy.ts` (prompt)
- Modify `apps/web/src/features/ai-generate/director/redundancy-apply.ts` (floor + sub-floor surfacing)
- Optionally modify `apps/web/src/features/ai-generate/director/redundancy-catalog.ts` (finer-grained lines)
- Test: extend the redundancy-apply / catalog tests under `director/__tests__/`

**Approach:** Soften `buildRedundancyPrompt`'s conservative directives toward recall while keeping the explicit "leave intentional repetition / callbacks / emphasis alone" guard. Make `DEFAULT_REDUNDANCY_CONFIDENCE_FLOOR` a parameter and lower the default (e.g. 0.7 -> ~0.5). In `mapRedundancyGroups`, instead of dropping sub-floor groups, emit them as `RedundancyReviewGroup`s whose cut ops default to NOT accepted, so they show in the panel for opt-in. Optionally split over-long catalog lines so partial-line retakes become visible to the model.

**Patterns to follow:** existing `mapRedundancyGroups` -> `RedundancyReviewGroup` mapping and the accept-default logic in the review store.

**Test scenarios:**
- A group at 0.55 confidence now appears as a review row with accept=false (previously dropped).
- A group above the accept threshold still defaults to accepted.
- Sub-segment split makes a mid-segment retake groupable (if catalog change included).
- Intentional-repetition guard: a deliberate callback the prompt should leave alone is not grouped (prompt regression check via a fixture if the harness supports it, else documented).

**Verification:** More candidates surface as accept-off rows; nothing new is auto-applied; `bunx tsc --noEmit` clean; hf-bridge + web type-check clean.

---

### U5. Additive deterministic backstop for repeats

**Goal:** The take-cluster / segment-repeat detectors contribute candidates alongside the LLM pass, not only on route error.

**Requirements:** R5, R7.

**Dependencies:** U4 (land recall changes first so the union is tested against the new surfacing).

**Files:**
- Modify `apps/web/src/features/ai-generate/director/redundancy-apply.ts` (`shouldRunLexicalRepeatDetectors`)
- Modify `apps/web/src/features/ai-generate/director/run-director.ts` (union merge, review feed)
- Test: extend `director/__tests__/` for the union + dedup path

**Approach:** Change `shouldRunLexicalRepeatDetectors` so the deterministic take-cluster + segment-repeat detectors always run and their cuts join the candidate set additively; feed them into the same review list. Rely on `mergeDetectedCuts` dedup + keeper protection so a repeat found by both sources appears once. Re-test the special-case merge handling in `run-director.ts` (a small contained clean-cut must not dedup a bigger redundancy cut). Keep `phrase-repeat` best-effort (no-op when word timings are absent).

**Patterns to follow:** `mergeDetectedCuts` dedup semantics; the existing route-error fallback path that already wires these detectors in.

**Test scenarios:**
- A verbatim adjacent retake the LLM missed is caught by segment-repeat and appears in the list.
- A repeat found by BOTH the LLM and the backstop appears once (dedup).
- The contained-clean-cut-vs-bigger-redundancy-cut merge rule still holds.
- No double auto-apply: backstop candidates respect the same accept defaults.

**Verification:** Union path adds real candidates without duplicates; merge regression tests green; `bunx tsc --noEmit` clean.

---

### U6. Dock the cut-list review into the properties panel

**Goal:** Render the cut list persistently in the right-side properties box instead of a modal.

**Requirements:** R6, R7.

**Dependencies:** none functionally (can land in parallel), but pairs naturally with U4/U5 since they feed the list.

**Files:**
- Modify `apps/web/src/features/ai-generate/director/director-plan-store.ts` (a `surface:'panel'` + `mode:'cut'` entry; e.g. `openCutPanel` that leaves `open:false`)
- Create `apps/web/src/features/ai-generate/director/components/director-cut-panel.tsx`
- Modify `apps/web/src/components/editor/panels/properties/index.tsx` (sibling takeover branch above the selection gate)
- Modify `apps/web/src/features/ai-generate/director/run-director.ts` (open the docked panel instead of the modal)
- Keep `director-review-dialog.tsx` mounted as-is OR retire it once the panel is proven (decide during implementation)
- Test: a store test for the new open action + surface/mode flags

**Approach:** Mirror the already-docked assemble panel. Add a store action that sets `surface:'panel', mode:'cut', open:false` and carries the same `plan / decisions / nearTies / redundancyGroups`. Build `DirectorCutPanel` by lifting the cut-mode body out of `director-review-dialog.tsx` (accept/reject rows, per-group swap-to-alternate rendered once per group, near-tie notes, Apply N of M) and wrapping it in the panel shell used by `director-panel.tsx`, with a Done/Apply affordance. In `PropertiesPanel`, add a branch `if (surface==='panel' && mode==='cut' && plan) return <DirectorCutPanel/>` directly beside the existing assemble branch, above the selection gate. Point `run-director` at the new action.

**Patterns to follow:** `director-panel.tsx` (the docked assemble panel) and the existing top-of-`PropertiesPanel` assemble takeover branch; the store's assemble trio (`openAssemble`/`applyDraftEdit`/`closeAssemble`).

**Test scenarios:**
- Store: `openCutPanel` sets `surface:'panel'`, `mode:'cut'`, `open:false`, and preserves plan/decisions/groups.
- Persistence (manual/live): the cut list stays visible after deselecting all clips.
- No double surface: the modal does not also pop (open stays false).
- Swap-to-alternate renders once per group in the panel (no duplicate picker on multi-cut groups).
- Apply still produces one BatchCommand and the "Ctrl+Z to undo" affordance/messaging is present.

**Verification:** The cut list appears in the properties box, editable, survives deselection, applies as one undo; existing modal flows do not double-render; `bunx tsc --noEmit` clean.

---

## Scope Boundaries

**In scope:** emphasis-pause protection in the Director + standalone Remove silences; higher repeat/mistake recall surfaced as review-gated candidates; the additive deterministic backstop; docking the cut list into the properties panel.

**Non-goals:**
- No new auto-cutting of distinct content. Higher recall is review-gated only.
- Not rebuilding the transcript / VAD pipeline (already shipped).
- Not touching the timeline direct-manipulation work (separate, done).

### Deferred to Follow-Up Work
- LLM-scored emphasis-pause classification (let the model judge ambiguous pauses; see Open Questions).
- Promoting a dedicated "Remove repeats / YouTube cut" menu entry wired to `planRepeatCuts` (a second holistic pass that is currently chat-only). Additive, not required for #5.
- A user-facing "recall aggressiveness" setting (ship a sensible default first).

---

## Open Questions

- **OQ1 (emphasis judgment fidelity):** The v1 heuristic ("bounded by speech, <=2s, no repeat/mistake nearby") is a proxy for "makes sense to pause to emphasize." Is that close enough, or should ambiguous pauses be sent to the LLM (the transcript already goes there for redundancy) for a keep/cut call? Decision recommended at implementation once the heuristic is testable on Dan's footage. Default: ship the heuristic, revisit if it still over/under-keeps.
- **OQ2 (pause ceiling + proximity window):** `maxPauseSec ~= 2.0` per Dan; the repeat/mistake `proximitySec` and the word-boundary snap radius are tuning values to settle during implementation against real transcripts.
- **OQ3 (confidence floor value):** Exact lowered floor (e.g. 0.5 vs 0.55) is a recall/precision tuning call best set while watching real review lists; the accept-off surfacing makes a lower value safe.
- **OQ4 (retire the modal?):** Whether to remove `director-review-dialog.tsx` once the docked panel is proven, or keep both surfaces. Lean toward retiring after live confirmation to avoid two code paths.

---

## Risks & Mitigations

- **Over-keeping pauses feels sluggish.** Mitigation: the "no repeat/mistake nearby" clause + the 2s ceiling + still cutting leading/trailing/long gaps; tune `maxPauseSec` and snap radius.
- **Higher recall cuts good content.** Mitigation: everything new is review-gated (accept-off), keeper protection intact, single-undo preserved. This is the core safety net.
- **Merge-semantics regression (#4/#5 both touch `mergeDetectedCuts` ordering).** Mitigation: characterize-first on the merge, keep the redundancy-authority second pass, re-run existing merge tests.
- **Docked panel double-renders with the modal.** Mitigation: the docked surface keeps `open:false` exactly like the assemble panel; add a store test asserting it.
- **Word timings unavailable on some device models.** Mitigation: every word-dependent path degrades to prior behavior; U1 returns no keepers without words.

---

## Verification

- `bunx tsc --noEmit` = 0 in `apps/web` (and `packages/hf-bridge` for U4).
- New bun unit tests green: `emphasis-pause`, silence-refine additions, redundancy-apply/catalog additions, director merge integration, store test.
- Existing Director + silence suites stay green (especially the `mergeDetectedCuts` and swap-to-alternate paths).
- Live (Dan): on real footage, short in-dialog pauses survive while long/edge dead air is cut; more repeats/mistakes appear in the cut list as opt-in rows; the cut list shows in the properties box, stays open after deselecting, and applies as one undo.
