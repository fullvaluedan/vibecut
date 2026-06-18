---
title: "feat: Timeline fixes & tools — drop snap, pen mask, track ops, rate-stretch, panel restyle"
type: feat
date: 2026-06-16
updated: 2026-06-16
status: in-progress
target_branch: feat/premiere-parity-timeline (off feat/round26)
pr: https://github.com/fullvaluedan/vibecut/pull/48
origin: live testing of the running build (localhost:3000); handoff docs/HANDOFF-premiere-parity.md
---

# feat: Timeline fixes & tools

## Summary

Seven issues found testing the running build, on the same `feat/premiere-parity-timeline` branch (PR #48). Three are bug-fixes (drop-to-head snap, pen-tool masking, moving clips onto empty tracks), three are new track/clip operations (unlink linked A/V, duplicate track, Rate-Stretch speed tool + right-click), and one is a UI consistency pass (restyle Audio/Speed/Blending inspector panels to match the Transform panel). Verification is live on localhost by the user (no Odysseus/export gate this round); pure logic gets wasm-free unit tests.

**This pass (resume):** U1 shipped; the U2 and U5 bug repros are now in hand and root-caused; the command/mutation infrastructure that U3/U4 depend on is confirmed (the prior "empty glob" was a false alarm). U3, U4, U6, U7 are ready to build — one unit per session, U3 first.

---

## Status snapshot

| Unit | Status | One-line |
|---|---|---|
| **U1** Drop-to-head snap | ✅ **Shipped** (`6a31463b`) | Drop-only + wider zone. Possible follow-up: a "snaps only the first time" symptom needs a fresh live repro on the shipped build. |
| **U2** Pen-tool video masking | 🔬 **Repro'd → root-caused** | Pen falls through to *new-shape* creation on `no-target`. Mask pipeline is intact; the gap is intent/selection. Ready to build (one live check). |
| **U3** Unlink linked A/V | ⬜ **Ready to build** | Infra confirmed; clear `linkId` via an undoable command + clip context-menu entry. *Build next.* |
| **U4** Duplicate track | ⬜ **Ready to build** | Infra confirmed; reuse `AddTrackCommand` + the existing `duplicate-elements` logic in one batch. |
| **U5** Move clips onto empty tracks | 🔬 **Repro'd → seam found** | "Refuses — no indicator." Move path omits empty tracks; bin-drop path already supports them. Reconcile the two. |
| **U6** Rate-Stretch tool + right-click Speed | ⬜ **Ready to build** | New `rate-stretch` armed tool; edge-drag writes `retime.rate`; right-click → Speed tab. Positive rate only. |
| **U7** Restyle Audio/Speed/Blending panels | ⬜ **Ready to build** | Extract one fx-group renderer from `effect-controls-tab.tsx`; route the three panels through it. |

---

## Problem Frame

The shipped parity work surfaced rough edges and gaps in real use:

- **Drop-to-head snap** snapped a *newly dropped* clip to 0:00 but the zone was tiny and fired only once, and a prior change also leaked a 0:00 snap into the **move** path. (Shipped fix in U1.)
- **Pen tool** is supposed to cut a freeform mask into the selected video, but drawing a path produces a **new standalone shape on the timeline instead of a mask** (the user's repro).
- **Tracks** can't be unlinked (linked A/V move together with no escape), can't be duplicated, and a clip dragged onto an existing empty track is **refused with no drop indicator**.
- **Speed** can only be changed via a panel field — no timeline tool and no right-click.
- **Inspector panels** are inconsistent: Transform uses the polished fx-group style (`EffectControlsTab`); Audio/Speed/Blending use the plainer `ElementParamsTab`.

---

## Requirements

- **R1** — A clip dropped near the timeline head snaps to 0:00; the snap zone is comfortably wide; it works on every drop; snap-to-front applies on **drop only**, never on move. *(shipped, U1)*
- **R2** — Arming the pen and drawing a closed path over a maskable clip cuts a **mask into that clip** (not a new shape); empty-canvas draws still create a shape.
- **R3** — Linked A/V (and other `linkId` groups) can be **unlinked** so pieces move independently.
- **R4** — A track can be **duplicated** (its clips copied to a new track).
- **R5** — A clip can be **moved onto an existing empty (compatible) track** — with a visible drop indicator.
- **R6** — Clip speed is changeable via a **Rate-Stretch tool** (drag a clip edge on the timeline) and a **right-click → Speed/Duration**.
- **R7** — Audio, Speed, and Blending inspector panels use the **Transform panel's fx-group style**.

---

## Codebase infrastructure (confirmed this pass)

Resolves the handoff's "re-locate the command/mutation infra first" — the `commands/` tree exists; the earlier empty glob was wrong.

- **Command/undo infra:** `apps/web/src/commands/base-command.ts` (abstract `Command` with `execute/undo/redo`), `apps/web/src/commands/batch-command.ts` (compose into one undo), history in `apps/web/src/core/managers/commands.ts`.
- **Track/element commands:** `apps/web/src/commands/timeline/track/add-track.ts` (`AddTrackCommand`, supports `keepWhenEmpty`), `apps/web/src/commands/timeline/element/insert-element.ts`, and **`apps/web/src/commands/timeline/element/duplicate-elements.ts` already exists** (reuse for U4).
- **Mutation model:** commands rebuild state and apply via `editor.timeline.updateTracks(newTracks)` (full-state replace). **IDs are caller-generated** with `generateUUID()`. There is **no "clear a field" API** — to clear `linkId` you spread the element with `linkId: undefined` inside a command (answers U3's open question).
- **Link model:** `apps/web/src/timeline/link-elements.ts` exports `findLinkedPartners` and `expandSelectionWithLinks`; `linkId` is set at drop/auto-link time. No clear-link helper yet (U3 adds the command).
- **Context menus:** clip menu in `apps/web/src/timeline/components/timeline-element.tsx` (Split/Copy/Duplicate/Mute/Nest…); track menu in `apps/web/src/timeline/components/index.tsx` (Paste/Mute/Add video|audio track/Move up|down/Delete).
- **All other referenced paths exist** (place-tool-store, resize-controller, retime/, drop-target, placement/resolve, group-move/snap, the properties panels, masks/freeform/).
- **PATCHES.md (root) discipline:** upstream (opencut) files get a `PATCHES.md` entry in the same commit; new files we author do not. Upstream-modified in this plan: `timeline-element.tsx`, `components/index.tsx`, `add-track.ts`, `drop-target.ts`, `group-move/snap.ts`, `resize-controller.ts`, `place-tool-store.ts`, `registry.tsx`, `element-params-tab.tsx`, `actions/definitions.ts`. New (ours): the unlink/duplicate-track commands, the fx-param-group component.

---

## Key Technical Decisions

- **KTD1 — Snap-to-front is a drop-only concern.** *(Shipped, U1.)* Widened the drop snap zone, fixed the once-only behavior, and removed the sequence-start (0:00) snap source from the **move** builder; marker/edge/playhead move-snapping stays. (R1)
- **KTD2 — Pen mask is a routing/intent bug, not a broken pipeline.** *(Root-caused this pass.)* `finishPen()` calls `finishPenAsMask()`, which returns `no-target` unless the selection is exactly one video/image/graphic element; on `no-target` it **silently creates a Custom shape**. The freeform mask pipeline (build → point-convert → `updateElements({ patch: { masks:[mask] } })`) is intact. Fix selection persistence and auto-target the maskable clip under the path before falling back to shape-creation. (R2)
- **KTD3 — Unlink clears `linkId` via a command.** Reuse `link-elements.ts`; add an undoable command that rebuilds the selected linked elements with `linkId: undefined` and applies via `updateTracks` (no clear-field API), plus a context-menu entry. (R3)
- **KTD4 — Duplicate track = new track + copied elements** in one `BatchCommand`: `AddTrackCommand` then a copy of each source element (fresh `generateUUID()` ids) at the same time. Reuse the existing `duplicate-elements` copy logic. (R4)
- **KTD5 — Move-to-empty is a move-path placement gap.** *(Repro'd: "refuses, no indicator.")* The bin-drop path (`drop-target.ts`) already supports empty-track targets; the **move/group-move** resolution doesn't surface an empty compatible track as a candidate. Reconcile the move resolution with the drop path's empty-target handling; type mismatch still rejects. (R5)
- **KTD6 — Rate-Stretch is a new armed tool + an edge-drag that writes `retime.rate`.** Add a `rate-stretch` place-tool; while armed, dragging a clip edge changes on-timeline duration AND `retime.rate` so the same source fills the new span (reuse the `retime` model + resize controller). Right-click → "Speed/Duration…" opens the existing Speed tab. Positive rate only. (R6)
- **KTD7 — Extract one fx-group param renderer.** Pull the FxGroup/scrub-value/stopwatch rendering out of `effect-controls-tab.tsx` into a shared component, and render Blending/Audio/Speed through it instead of `ElementParamsTab`. (R7)

---

## Implementation Units

### U1. Drop-to-head snap: wider, every-time, drop-only
**Status:** ✅ Shipped (`6a31463b`). Possible follow-up below.
**Goal:** A dropped clip reliably snaps to 0:00 within a comfortable zone, on every drop; moving an existing clip never snaps to 0:00. *(R1)*
**Files:** `apps/web/src/timeline/components/drop-target.ts` (`SNAP_TO_START_PX` 10→28, drop-only logic), `apps/web/src/timeline/group-move/snap.ts` (removed sequence-start source from the move builder).
**Shipped behavior:** Drop-to-head snap is now drop-only with a wider zone; the move builder no longer snaps to 0:00 (marker/edge/playhead move-snapping retained).
**Possible follow-up (needs fresh live repro):** the user reported a "snaps only the first time" symptom. On the shipped build, confirm whether a *second* clip dropped near the head still snaps — and if not, whether it's because V1[0] is occupied (so it lands on a different track, which is correct) versus the snap genuinely not firing. If the latter, reopen as a small drop-only fix; otherwise close.

### U2. Pen-tool freeform video masking
**Status:** 🔬 Repro'd → root-caused. Ready to build after one live selection-loss check.
**Goal:** Arming the pen and drawing a closed path over a maskable clip cuts a visible freeform mask into **that clip**; drawing over empty canvas still creates a Custom shape. *(R2)*
**Files:** `apps/web/src/preview/components/place-tool-overlay.tsx` (`finishPen` / `finishPenAsMask` branch + selection handling), `apps/web/src/masks/freeform/**` (only if a render gap surfaces), `apps/web/src/masks/components/masks-tab.tsx` (reflects the mask), the renderer mask-application path (`apps/web/src/services/renderer/**`) only if the cutout doesn't render.
**Approach:** **Root cause (grounded):** in `place-tool-overlay.tsx`, `finishPen()` calls `finishPenAsMask()`, which returns `no-target` when the selection isn't exactly one `video`/`image`/`graphic` element; on `no-target` the code falls through to `buildGraphicElement("custom-path") → insertElement` and toasts *"Custom shape added"* — the observed repro. The mask pipeline itself is complete. So the fix is intent disambiguation + selection, not rebuilding masks:
  1. **Preserve a selected maskable clip through pen arming / the first canvas click** (verify live whether arming or the first click clears selection — the strong hypothesis for why `selected.length !== 1` at finish).
  2. **On `no-target` at path close, auto-target the topmost maskable clip whose bounds contain the path centroid at the playhead** before falling back to shape-creation. Only create a Custom shape when there is genuinely no maskable clip under the path.
Keep `finishPenAsMask`'s build/convert/patch logic as-is; only its reachability and the `no-target` branch change.
**Execution note:** Verify live whether arming the pen / the first canvas click clears the clip selection before changing the branch logic — interaction controllers are `useState`-held and don't HMR, so hard-reload and inspect `window.__vibeEditor`.
**Open question (default chosen):** when a maskable clip is under the path, **mask wins**; an explicit shape is drawn on empty canvas. Confirm this matches intent live before finalizing; if the user wants an explicit "pen vs. pen-mask" sub-mode instead, that's a small follow-up.
**Test scenarios:** select a video → draw a closed 3+ point path → mask cuts into THAT clip (no new shape), Masks tab shows feather/invert; arming the pen with a maskable clip selected keeps it selected at finish; draw over a video with no prior selection → auto-targets the clip under the path and masks it; draw over empty canvas (no maskable clip under path) → Custom shape still added (preserved); draw again over a masked clip → replaces the mask.
**Verification:** live — arm pen, draw over a video → cutout appears in preview and the Masks tab reflects it; draw over empty canvas → Custom shape still added.

### U3. Unlink linked A/V  ← build next
**Status:** ⬜ Ready to build (infra confirmed).
**Goal:** A linked A/V (or any `linkId`) selection can be unlinked so the pieces move/trim independently. *(R3)*
**Files:** a new undoable command under `apps/web/src/commands/timeline/element/` (e.g. `unlink-elements.ts`), `apps/web/src/timeline/link-elements.ts` (reuse `findLinkedPartners`/`expandSelectionWithLinks`), `apps/web/src/timeline/components/timeline-element.tsx` (clip context-menu "Unlink", shown only when the selection is linked), a wasm-free test for the command's pure state transform if extractable.
**Approach:** Add a command that rebuilds the selected linked elements (and their `findLinkedPartners`) with `linkId: undefined`, applies via `editor.timeline.updateTracks`, and returns a selection patch. Single undo restores `linkId`. Mirror the existing link/expand pattern. Show the menu item only when `expandSelectionWithLinks` reveals more than the directly-selected element(s).
**Test scenarios:** unlink a linked A/V pair → moving the video no longer drags the audio; undo restores the link; context item hidden for an unlinked single clip; unlink a multi-member `linkId` group → all members independent; the command is one undo step.
**Verification:** live — drop a video (auto-links A/V), right-click → Unlink, move the video alone; undo re-links.

### U4. Duplicate track
**Status:** ⬜ Ready to build (infra confirmed; reuse `duplicate-elements`).
**Goal:** Right-click a track → "Duplicate track" creates a new track with copies of its clips. *(R4)*
**Files:** a new command under `apps/web/src/commands/timeline/track/` (e.g. `duplicate-track.ts` = `AddTrackCommand` + a copy of each element, one `BatchCommand`), reuse `apps/web/src/commands/timeline/element/duplicate-elements.ts` for the per-element copy/new-id logic, `apps/web/src/timeline/components/index.tsx` (track context menu, alongside Add/Move/Delete track), a wasm-free test for the command if extractable.
**Approach:** New `BatchCommand`: `AddTrackCommand` of the same type adjacent to the source (its `trackId` is generated up-front and stable pre-execute), then insert a fresh-id copy (`generateUUID()`) of each source element at the same time onto the new track. Single undo removes the whole duplicate. Reuse the existing `duplicate-elements` copy logic so id-freshness and param-copy stay consistent with single-element duplicate.
**Test scenarios:** duplicate a video track with 2 clips → new track with 2 clips at identical times; single undo removes the whole duplicate; duplicate an empty track → new empty track; element ids are fresh (no collision); the new track sits adjacent to the source.
**Verification:** live — duplicate a populated track; both tracks render; undo removes it cleanly.

### U5. Move clips onto empty tracks
**Status:** 🔬 Repro'd ("refuses — no indicator") → seam found. Ready to build.
**Goal:** A clip can be dragged onto an existing empty (compatible) track, with a visible drop indicator. *(R5)*
**Files:** `apps/web/src/timeline/placement/resolve.ts` (move drop-target resolution), `apps/web/src/timeline/components/drop-target.ts` (reference: the bin-drop path's empty-target support), `apps/web/src/timeline/controllers/element-interaction-controller.ts` and/or `apps/web/src/timeline/group-move/**` (the move-hover candidate that drives the indicator + commit), `apps/web/src/timeline/placement/__tests__/resolve.test.ts`.
**Approach:** **Grounded seam:** the bin-drop path (`drop-target.ts`) already treats an empty track as a valid target (`EMPTY_TARGET_ELEMENT`, `emptyTimelineResult`, the empty-lane reuse branch), but the **move/group-move** resolution doesn't surface an empty compatible track as a hover candidate — so no indicator shows and the drop refuses. Reconcile the move resolution with the drop path: an empty compatible track becomes a valid move destination (indicator + land), while a type-mismatched track still rejects. Keep consistent with the U1/round-25 placement rules; update `resolve.test.ts` if the policy changes.
**Test scenarios:** move a video clip onto an empty video track → indicator shows, it lands there (not a new track, not a snap-back); move onto an empty audio track with a video clip → rejected (type mismatch, unchanged); move onto an occupied track at a free time → unchanged; bin-drop onto an empty track still works (no regression); existing placement tests stay green.
**Verification:** live — add an empty track (U4 or the existing Add-track), drag a clip onto it → indicator appears and it lands.

### U6. Rate-Stretch tool + right-click Speed/Duration
**Status:** ⬜ Ready to build (paths confirmed; `PlaceTool` union currently `text|shape|pen|track-select-forward`).
**Goal:** Change a clip's speed by dragging its edge with a Rate-Stretch tool, and via right-click → Speed/Duration. *(R6)*
**Files:** `apps/web/src/preview/place-tool-store.ts` (add `rate-stretch` to the `PlaceTool` union), `apps/web/src/actions/definitions.ts` (`R` hotkey for the tool), `apps/web/src/timeline/components/{tool-rail.tsx,timeline-element.tsx}` (rail button + armed-edge-drag + context-menu "Speed/Duration…"), `apps/web/src/timeline/controllers/resize-controller.ts` (rate-stretch resize mode), the retime model (`apps/web/src/retime/**`, `RetimeConfig.rate`, reuse/extend `apps/web/src/retime/duration.ts`), a wasm-free test for the rate↔duration math.
**Approach:** New armed tool `rate-stretch`. While armed, dragging a clip edge resizes the on-timeline duration AND sets `retime.rate = sourceSpan / newDuration` (same source fills the new span) — extend `resize-controller` with a rate-stretch mode rather than a normal trim. Extract the rate↔duration math as a **pure wasm-free helper** (reuse/extend `retime/duration.ts`) and unit-test it. Right-click → "Speed/Duration…" sets the Properties panel to the Speed tab for the selection (mirror `open-speed-panel`). Positive rate only (reverse is deferred — see Plan B).
**Execution note:** The resize/interaction controller is `useState`-held and doesn't HMR — hard-reload before iterating; verify via `window.__vibeEditor`.
**Test scenarios:** rate-stretch math — dragging to half the duration → rate 2× (and back); clamp respected; right-click → Speed tab opens for the clip; rail button + `R` arm the tool; dragging the edge changes duration + speed live; normal Selection-tool trim still trims (unchanged).
**Verification:** live — arm Rate-Stretch (R), drag a clip's edge → it gets shorter and plays faster; right-click → Speed/Duration opens the Speed panel.

### U7. Restyle Audio / Speed / Blending panels to the Transform style
**Status:** ⬜ Ready to build (paths confirmed).
**Goal:** Audio, Speed, and Blending inspector panels render in the Transform panel's fx-group style. *(R7)*
**Files:** `apps/web/src/components/editor/panels/properties/components/effect-controls-tab.tsx` (extract a shared FxGroup/param-row renderer), a new shared component (e.g. `components/fx-param-group.tsx`), `apps/web/src/components/editor/panels/properties/registry.tsx` (`buildBlendingTab`, `buildAudioTab`), `apps/web/src/components/editor/panels/properties/components/element-params-tab.tsx`, `apps/web/src/speed/components/speed-tab.tsx`.
**Approach:** Extract the FxGroup header + scrub `ValueField` + stopwatch/keyframe-nav rendering from `EffectControlsTab` into a reusable component. Render Blending (`opacity`, `blendMode`), Audio (`volume`, `muted` + the Audio Sync section), and Speed through it, preserving each panel's params and keyframeability. Keep `ElementParamsTab` for any tab not in scope, or route it through the shared renderer.
**Execution note:** Pure styling/structure refactor — preserve behavior (keyframe toggles, commit paths) exactly; no new params.
**Test scenarios:** `Test expectation: none — visual/structural refactor`; verify live that Blending/Audio/Speed still read + write + keyframe their params identically, now in the fx-group style.
**Verification:** live — open each of Blending, Audio, Speed → they look like Transform (fx-group headers, blue scrub values) and still edit correctly.

---

## Open Questions

- **U2 disambiguation default** — when a maskable clip is under the drawn path, **mask wins**; an explicit shape is drawn on empty canvas. Default chosen; confirm live. Alternative (small follow-up): an explicit "Pen" vs "Pen (mask)" sub-mode.
- **U2 selection-loss** — does arming the pen or the first canvas click clear the clip selection? Execution-time live check; drives whether the fix is mostly "preserve selection" or mostly "auto-target under path."
- **U1 follow-up** — the "snaps only the first time" symptom: needs a fresh live repro on the shipped build; may already be resolved by `6a31463b` (or be the correct "V1[0] occupied → lands elsewhere" behavior).

---

## Scope Boundaries

- **In scope:** U2–U7 (U1 shipped). Build order: **U3 → U4 → U6 → U7**, with U2 and U5 once their live checks confirm the fix shape.
- **Deferred to Follow-Up Work:**
  - **Reverse speed** — *rebuild fresh* (a prior automated attempt hung and broke `tsc` on `services/renderer/resolve.ts`; do not salvage). Implement as a **`reversed` boolean flag** (keep `rate` positive so the clamp/pitch/duration math stays valid — **not** a negative rate). It threads ~6–7 consumers: video resolve, blur, audio mix, preview audio, audio-stretch, waveform, split. Tracked in the advanced-clip/audio plan.
  - The rest of the advanced-clip/audio plan (LUFS panel, time-remapping, source monitor, frame-blend slow-mo, reverse-prefetch, multi-clip Effect Controls) — see `docs/plans/2026-06-15-003-feat-advanced-clip-audio-features-plan.md`.
  - The broader parity backlog (insert/overwrite, razor-at-click, rolling/slip/slide, JKL).
- **Out of scope:** any `opencut-wasm` or render-engine change (it's a downstream texture-quad rasterizer fed a fully-resolved descriptor — all geometry/audio/time math lives in our JS layer, so nothing here needs an engine fork); export verification (the user verifies live this round).

---

## Risks & Dependencies

- **U2** default (mask-wins-under-path) is a product choice — confirm live so it matches the user's mental model before finalizing; the selection-loss check gates which half of the fix carries the weight.
- **U5** must reconcile with the bin-drop path's empty-target support without regressing bin-drop onto empty tracks; keep type-mismatch rejection intact.
- **U6** touches the timing-sensitive resize/interaction controller (no HMR) — hard-reload + `window.__vibeEditor`.
- **Upstream discipline:** every opencut-upstream file edit needs a `PATCHES.md` (root) entry in the same commit — see the upstream/new split in *Codebase infrastructure*. New files (the unlink/duplicate-track commands, the fx-param-group component) don't.
- **Verification reality:** live-verified on localhost:3000 by the user; pure helpers (U6 rate↔duration, any extractable command transform) get wasm-free bun tests; `@/wasm`-importing timeline tests still can't run under bun.
- **One unit per session** — two failures on this branch came from cramming a session (a hung agent + a broken revert). Commit + push per clean unit; auto-push is OK (user opted in).

---

## Execution context (run / test / rules)

Full run + rules in `docs/HANDOFF-premiere-parity.md`. Quick version:

- **Run:** `preview_start` config **`framecut-dev`** (bun `--cwd apps/web run dev`, port 3000) → **http://localhost:3000**. Compiles ~3s; HMR picks up most edits.
- **Interaction controllers are `useState`-held and do NOT HMR** — hard-reload before iterating on drag/move/trim/pen; inspect live via `window.__vibeEditor`.
- **Rules:** never fork `opencut-wasm`/`hyperframes`; log each upstream edit in `PATCHES.md` in the same commit; one unit per session; keep changes default-safe/additive ("don't break export" is still cardinal); land on `feat/premiere-parity-timeline` → PR #48 → `feat/round26`.

---

## Verification

1. `tsc --noEmit` clean (bar the known `globals.css` false positive); eslint no new errors on changed files.
2. Wasm-free bun tests for U6 (rate↔duration) and any extractable command transforms (U3 unlink, U4 duplicate).
3. Live on localhost:3000 — the per-unit live checks above.
4. Each upstream-file edit logged in `PATCHES.md`.

---

## Sources & Research

Grounded in this branch's code:
- **Snap (U1, shipped):** `timeline/components/drop-target.ts` + `timeline/group-move/snap.ts`.
- **Pen mask (U2):** `preview/components/place-tool-overlay.tsx` (`finishPen` → `finishPenAsMask`, with the `no-target` → Custom-shape fall-through at lines ~143–184 being the repro), `masks/freeform/**`.
- **Command/mutation infra (U3/U4):** `commands/base-command.ts`, `commands/batch-command.ts`, `commands/timeline/track/add-track.ts`, `commands/timeline/element/{insert-element,duplicate-elements}.ts`, `core/managers/commands.ts`; `editor.timeline.updateTracks` + caller-side `generateUUID()`; `timeline/link-elements.ts`.
- **Move-to-empty (U5):** `timeline/placement/resolve.ts` + the interaction/group-move controller (move path) vs. `timeline/components/drop-target.ts` (bin-drop path that already supports empty targets).
- **Rate-Stretch (U6):** `preview/place-tool-store.ts` (`PlaceTool` union), `timeline/controllers/resize-controller.ts`, `retime/**` (`RetimeConfig.rate`, `retime/duration.ts`).
- **Panel restyle (U7):** `components/editor/panels/properties/{registry.tsx, components/effect-controls-tab.tsx, components/element-params-tab.tsx}`, `speed/components/speed-tab.tsx`.
- **Context menus:** `timeline/components/timeline-element.tsx` (clip), `timeline/components/index.tsx` (track).
