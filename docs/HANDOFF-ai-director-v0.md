# Handoff — v0 AI Director (text + audio, review-gated)

**Branch:** `feat/ai-director-v0` (off `feat/ai-director-foundations` / PR #49, now merged into `feat/round26`)
**Plan:** [`docs/plans/2026-06-17-001-feat-v0-ai-director-plan.md`](plans/2026-06-17-001-feat-v0-ai-director-plan.md) (committed `ddaac5eb`)
**Status:** **CODE-COMPLETE — all 6 units committed. NOT yet live-verified end-to-end.**
**Verification at handoff:** 61 director tests pass · `tsc` clean · lint clean across all changed files.

---

## What this is

The AI Director is the new **primary** AI-CUT entry. It watches and listens to the whole
assembled video, proposes a "director's cut" as a list of typed ops, shows them in a **Review
modal** for per-op accept/reject, and applies the accepted ops as **one undoable step**. Every
review decision seeds a persisted **taste** signal that is injected into the next plan.

It is **text + audio** only in v0 (no vision yet): the planner reasons from the transcript fused
with per-segment audio features (loudness / WPM / filler / silence) and the source map. This runs
on every auth mode (text-only `planJson`).

---

## The 6 units (all committed on `feat/ai-director-v0`)

| Unit | Commit | What |
|---|---|---|
| **U1** planner | `6e8193dd` | `packages/hf-bridge/src/author.ts` — `buildDirectorPrompt` (fused signal table), `DIRECTOR_SCHEMA`, `sanitizeDirectorPlan`, `DirectorOp`/`DirectorPlan`/`DirectorSegment` types, `stableOpId` (djb2), thin `planDirector` wrapper. Exported from `index.ts`. |
| **U2** route | `8fc7daab` | `apps/web/src/app/api/director/plan/route.ts` — mirrors hyperframes/cuts (`resolveAiAuth`→401, body→400, `planDirector`→`{plan,usage}`, typed 500). |
| **U3** apply | `e705ceff` | `apps/web/src/features/ai-generate/director/apply-plan.ts` — `planRemovalRanges` (pure, tested) + `applyDirectorPlan` (accepted cut/take_select → ONE all-track `RemoveRangesCommand` = one undo). |
| **U6** taste | `47aa9d19` | `apps/web/src/features/ai-generate/director/taste.ts` — pure `aggregateDecisions` + `deriveTasteNote` (≥2 samples, ≥50%) + zustand `useDirectorTasteStore` (persist `vibecut-director-taste`). |
| **U4/U5 cores** | `9fc11cdb` | `build-signal-table.ts` (PURE, wasm-free: zips transcript + `computeSpeechFeatures` + source map + silence gap → `DirectorSegment[]`) + `director-plan-store.ts` (pure `initDecisions`/`toggleDecision`/`selectAccepted`, all-accepted default). |
| **U4/U5 UI** | `dacf89d5` | `run-director.ts` orchestrator, `components/director-review-dialog.tsx` (Radix modal), `ai-cut-menu.tsx` (AI Director replaces the old modes). |

---

## Flow (end to end)

```
AiCutMenu "AI Director"  →  runDirector({editor})         [run-director.ts]
  → assembleBinToTimeline
  → runRemoveSilences
  → ensureTimelineTranscript            (no speech → typed throw)
  → extractTimelineAudio → decodeAudioToFloat32 → computeSpeechFeatures
  → buildSignalTable({segments, features, elements: tracks.main.elements})
  → POST /api/director/plan  (buildAiAuthHeaders() + taste note)   [route.ts → planDirector]
  → useDirectorPlanStore.openWith(plan)        ← resolves here; modal now owns the rest
DirectorReviewDialog                          [director-review-dialog.tsx]
  → per-op accept/reject (all accepted by default)
  → "Apply N of M" → applyDirectorPlan({editor, ops: accepted})   [apply-plan.ts]
                   → noteReviewDecisions(...)  → taste seed        [taste.ts]
                   → toast (N cuts, X.Xs removed; Ctrl+Z restores)
```

---

## THE REMAINING GATE — live end-to-end verification

**Nothing in the UI path is bun-tested** (assertion: the 61 tests cover all *logic* — planner,
sanitizer, apply ranges, taste aggregation, signal-table fusion, decision store — plus `tsc`/lint
on the UI). The actual in-browser flow has **never been run**. Do this first in the next session:

1. Start the dev server **on this branch**: `bun run dev:web` (port 3000) from the worktree
   `C:\Users\danom\Videos\framecut-director`.
2. New project → import a talking-head clip with speech.
3. Click **AI CUT → "AI Director — review & cut the whole video"**.
4. Confirm: progress stages advance → `/api/director/plan` returns a plan (needs working Claude
   dispatch — same path HyperFrames uses) → the **Review modal renders** with op rows (badge +
   timecode + reason + checkbox).
5. Toggle a couple of ops off → **Apply N of M** → confirm the cuts land and **Ctrl+Z restores
   everything in one step**.
6. Re-run → confirm the taste note is injected (check the request body / network tab).

Watch for: the renderer crash under heavy DOM evals seen earlier (recover via reload — project
auto-saves). Drive with the dev server + `Claude_Preview` browser tools, not by hand.

---

## Known deferrals / scope edges (v0 intentionally stops here)

- **`reorder` is PROPOSED + shown in the modal but NOT APPLIED.** Returned as `unappliedReorders`
  from `applyDirectorPlan`. The `MoveElementCommand` + cut-ordering interaction needs live
  exercise. Removals (cut / take_select) are the R1/R2/R4 core and apply fully.
- **No vision yet.** Frames sampler (Phase A `frame-extract.ts` / `frame-sampling.ts`) exists but
  isn't wired into the planner. The vision round layers `planMultimodal` + role classification +
  B-roll overlay onto this same planner.
- **Taste is capture + inject only** — the full compression loop (U9) is a later round.

---

## Gotchas banked this build (save the next session time)

- hf-bridge import alias is **`@framecut/hf-bridge`**, not `@/`. hf-bridge has no own
  tsconfig/eslint (typecheck via a throwaway root tsconfig filtering node/bun global noise).
- apps/web eslint forbids `as` from `any`/`unknown`/`never` (`@typescript-eslint/no-unsafe-type-assertion`):
  route bodies parse via `unknown` + `typeof`/`Array.isArray` guards.
- `opencut/prefer-object-params` fires on **any** 2+-positional fn in a file you touch, including
  pre-existing ones (had to convert `ai-cut-menu`'s `run(label,fn)` → `run({label,fn})`).
- `jsx-a11y/label-has-associated-control` needs the label's text as a near-direct child (put
  `{op.reason}` as a direct text node, not nested 3 levels deep).
- Route tests build `new NextRequest(...)` (not `Request`) + `mock.module`. `next/server`, the `@/`
  alias, and `mock.module` all work under `bun test`.
- Pure helpers live in wasm-free modules (local `TICKS_PER_SECOND` const) so they don't import
  `@/wasm` (crashes bun). `tracks.main.elements` IS assignable to `SourceMapElement[]` directly —
  no filter/guard needed.

---

## Next steps (in order)

1. **Live-verify the flow** (above). This is the gate before anything ships.
2. **Open the v0 PR** `feat/ai-director-v0` → `feat/round26`. Foundations (#49) are already in
   round26, so the PR shows only the v0 commits (`ddaac5eb`..`dacf89d5`).
3. **Vision round** — frame sampler into the planner, role classification, B-roll overlay onto
   `planMultimodal`.
4. **Apply `reorder` ops** — wire `unappliedReorders` through `MoveElementCommand`.
5. **Full taste-compression loop (U9).**
