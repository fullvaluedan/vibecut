# Premiere Pro parity — timeline audit & backlog

Created: 2026-06-15 · Branch: `feat/premiere-parity-timeline` (off `feat/round26`)

Goal: make the editor's timeline behave like Premiere Pro. This doc tracks the four
reported issues plus a ranked backlog of the next parity gaps. Current state reflects
`feat/round26` (round 25/26 already shipped a Premiere-style tool model, ripple trims,
gap selection, markers, and zoom hotkeys).

## The four reported issues

| # | Issue | Status |
|---|---|---|
| 1 | No hotkey back to Selection (want `V`) | ✅ **Already fixed on round26** — `activate-selection-tool` bound to `v` clears the place tool (`use-editor-actions.ts`). The report came from testing the older round-24 `perf/preview-decode` branch. No code needed. |
| 3 | Dropped clip near the start should snap to 0:00 | ✅ **Fixed this branch** — `computeDropTarget` snaps a mouse-dropped clip to 0:00 within ~10px of the start (`apps/web/src/timeline/components/drop-target.ts`). Also closes the queued "snap-to-0:00" item. |
| 4 | Video drop defaults to V2 instead of V1 | 🔬 **Scoped — needs a behavior decision** (below). |
| 2 | Multi-segment selection (A tool) can't be moved | 🔬 **Scoped — needs live confirmation** (below). |

## #4 — Video drop defaults to V1 (not V2)

**Root cause.** Track order is `[...overlay, main, ...audio]` (`drop-target.ts`, `placement/resolve.ts`), so overlay tracks (V2) render *above* the main track (V1). `computeDropTarget` targets the track under the cursor Y via `getTrackAtY`, then `resolveTrackPlacement({ strategy: "preferIndex", trackIndex })`. In a project that already has a V2/overlay, a casual drop near the top lands on V2. (In a fresh project with only V1, it correctly lands on V1.)

**Fix location.** `resolveTrackPlacement`'s `preferIndex` branch (`apps/web/src/timeline/placement/resolve.ts:190`) and/or the preferred-index choice in `computeDropTarget`.

**Behavior decision required before coding (it's a policy change in a tested subsystem):**
- **Option A (Premiere-literal):** drop targets exactly the track under the cursor — V1 if you aim at V1, V2 if you aim at V2. The "defaults to V2" complaint then becomes a track-ordering/layout perception issue (V2 on top).
- **Option B (recommended):** a *video* drop prefers the **main track (V1)** when the clip fits there, unless the cursor is deliberately over a specific higher track's lane. Matches the "video → V1 by default" expectation.

`placement/__tests__/resolve.test.ts` encodes the current preferIndex behavior, so whichever option is chosen, update those tests in lockstep. **Recommend confirming A vs B, then implementing.**

## #2 — Multi-segment track-tool selection can't be moved

**Observed.** Select multiple segments with the `A` (track-select-forward) tool, then they can't be dragged.

**Where it lives.** The tool selects elements (`use-editor-actions.ts` `track-select-forward` → `usePlaceToolStore` + selection). Moving a multi-selection is handled by the element interaction controller (`apps/web/src/timeline/controllers/element-interaction-controller.ts` + `hooks/element/use-element-interaction.ts`). Likely the drag-move path is gated to the Selection tool, or doesn't treat a track-tool multi-selection as a draggable group.

**Needs live confirmation** of the exact failure (cursor doesn't initiate a drag vs. drag initiates but clamps) before fixing, since the interaction controller is timing/lifecycle-sensitive. Then: ensure a track-tool multi-selection hands off to the same multi-move path the Selection tool uses (Premiere: after the track-select tool grabs clips, you drag them as a group).

## Ranked broader parity backlog

Grounded against what already exists (✅) vs. Premiere:

1. **Insert vs. Overwrite on drop/paste** — Premiere distinguishes Insert (ripples everything right) from Overwrite (replaces). The editor currently inserts/places without the Insert/Overwrite mode. High value.
2. **#4 default-track policy** — see above.
3. **#2 track-tool group move** — see above.
4. **Snapping coverage** — clip-edge and playhead snapping during *move/trim* (not just the new drop-to-start). Verify what exists; Premiere snaps to edges, playhead, markers, and sequence start.
5. **Trim modes** — ripple ✅ (Q/W), roll, slip, slide. Roll/slip/slide are missing.
6. **Tool hotkeys** — Selection `V` ✅, Track-select `A` ✅, Razor `C` (verify), Hand `H`, Zoom `Z`, Rate-stretch `R`, Slip `Y`, Slide `U`, Pen `P`.
7. **J-K-L shuttle** — play backward/pause/forward with repeat-press speed ramps. (Playback rate exists; true JKL shuttle noted as queued.)
8. **Three-/four-point editing & source monitor** — larger; likely out of near-term scope.
9. **Track targeting & sync locks** — Premiere's track-target toggles drive where inserts land (ties into #1/#4).
10. **Assets list metadata** (resolution/duration/fps) — queued chip; not timeline but part of the parity polish.

## How to extend this audit
Each backlog item should graduate to its own `ce-plan` → `ce-work` cycle. Confirm the #4 policy (A vs B) and the #2 live behavior, then those two move from "scoped" to "in progress."
