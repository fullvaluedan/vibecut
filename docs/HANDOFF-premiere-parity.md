# Handoff — Premiere-parity timeline branch

**Branch:** `feat/premiere-parity-timeline` (off `feat/round26`) · **PR:** [vibecut#48](https://github.com/fullvaluedan/vibecut/pull/48) → base `feat/round26`
**Updated:** 2026-06-17 · **HEAD:** `2d0a3bbb`

This branch brings the timeline/editor to Premiere-Pro / CapCut parity so a manual editor "just works" — the real product goal (HyperFrames + AI edit) then lands on a trustworthy surface. Everything is in our own JS/TS layer; **no `opencut-wasm` fork**. All work below is committed + pushed to PR #48.

> ## ⚠️ Verification posture — READ THIS FIRST
> The user verifies **live on localhost** (no Odysseus, no Hermes agent for the coding agent). The interaction controllers are **`useState`-held and do NOT hot-reload** — gesture behavior is **not bun-testable**. So almost everything in the "Trim/edit tools" and "Overwrite model" sections below is **shipped + gated (tsc/lint/unit-tested math) but NOT yet live-verified by anyone.**
>
> **`docs/VERIFY-premiere-parity.md` is the live-verification checklist — the gate before relying on any gesture/visual feature.** A "Live-verify…" task chip is also on the user's list. Work the checklist; report failures so a unit can be fixed.

---

## 1. Current state (one-paragraph TL;DR)

Two plans are essentially **done** on this branch: **plan 002** ("timeline just works" — interaction core, masking determinism, the overwrite/insert *drop* model, Rate-Stretch + Ripple) and **plan 003** ("edit backlog" — the rest of the trim suite, overwrite on *move* + *multi-drop*, duplicate-track, markers, mask depth, panel restyle). The full **Premiere trim suite is shipped: Rate-Stretch (R) · Ripple (B) · Roll · Slip (Y) · Slide (U)**, and the **overwrite/insert edit model works on drop, move, and multi-drop**. A `/ce-code-review` pass caught + fixed a real Duplicate-Track bug. The only un-built items are intentional v1 follow-ups (§5) and the separate **advanced clip-audio** plan (reverse-speed / time-remap / LUFS / slow-mo / source-monitor — see `docs/plans/2026-06-15-003-feat-advanced-clip-audio-features-plan.md`).

---

## 2. What shipped

### 2a. Interaction core & free-placement spine (plan 002, early)
- Removed the 0:00 zero-anchor clamp so a clip can be moved off the timeline head.
- Multi-select group **MOVE to new tracks**, incl. per-type new tracks for a linked A/V pair.
- **First-drop-prefers-V1** gated to *new* drops only (existing-element moves honor the hovered track).
- **Multi-drag from the bin** (`MediaDragData.selectedIds`).
- **Track-Select-Forward (A) press-drag** = select-forward + open the move in one gesture. *(The P1 bug there: the move controller read a STALE React-snapshot selection — fixed by reading LIVE `editor.selection`.)*
- Earlier parity (commits `d088a565`..`6a31463b`): V1 drop preference, Track-Select momentary→draggable, move/trim snapping (markers + sequence-start; later 0:00 snap removed from MOVE — drop-only), bin asset metadata, Sequence Settings dialog, **Anchor Point** (pure compensating-offset math), audio **peak meters** (observe-only AnalyserNode), drop-to-head snap (drop-only, `SNAP_TO_START_PX` 28).

### 2b. The Premiere trim/edit tool suite (the headline of this branch)

All five are **armed tools** on the same sticky lifecycle (arm → stays armed → **V** or **Escape** disarms). Each tool's *math* is a pure, wasm-free, bun-tested helper; the *gesture* is live-verified.

| Tool | Key | Commit | Gesture | Math helper (tests) |
|---|---|---|---|---|
| **Rate-Stretch** | R | `3bb32554` | edge-drag → change playback *rate* (source window fixed) | `group-resize/rate-stretch.ts` (7) |
| **Ripple** | B | `d358401e` | edge-drag → trim + ripple downstream (clip anchored) | `trim-tools/ripple.ts` (19) |
| **Roll** | — (rail btn; N=snap) | `e59b531e` (math `de0b0939`) | drag the cut between two adjacent clips | `trim-tools/roll.ts` (23) |
| **Slip** | Y | `9269cb9d` | interior-drag → slide source window, clip fixed | `trim-tools/slip.ts` (14) |
| **Slide** | U | `1347cefd` | interior-drag → move clip, neighbours absorb | `trim-tools/slide.ts` (21) |

**Razor (C)** was shipped earlier in plan 002 (click-split / Shift+click splits all tracks).

### 2c. Overwrite / insert edit model (OQ7 = overwrite default, Ctrl=insert)

The pure carve geometry is `timeline/overwrite/overwrite-plan.ts` (`planClipDrop`, 24 tests, **adversarially verified** — a workflow caught a real insert-algorithm bug before it shipped). Applied at three entry points, all behind a **conservative gate** (only on an *actual* overlap of a type-compatible track; non-overlapping ops are byte-unchanged):

| Entry | Commit | Command |
|---|---|---|
| **Drop** (bin → occupied region) | `431900fc` (U14c) | `OverwriteDropCommand` |
| **Move** (relocate a clip onto a clip) | `af38f761` (U4) | `MoveOverwriteCommand` (excludes the moved clip from the carve) |
| **Multi-drop** (N clips, combined span) | `ae397e4b` (U5) | `OverwriteDropCommand` (extended to `incoming: …[]`) |

`group-move/resolve-move.ts` is **untouched** — its reject/clamp default is the path for every non-carve move; the carve is resolved *before* `resolveGroupMoveForDrop` and skips it. Modifier: **Ctrl** at drop/mouseup → insert (ripple from the drop point), else overwrite.

### 2d. Masking
- **Pen masks** (plan 002): arm-time **latch** of the target clip + pointer-capture stopPropagation + under-cursor "mask what I'm pointing at" (centroid / rotated-bounds hit-test).
- **Expand/contract** (`a507c06f`, U8): new required `expand` param on `BaseMaskParams` (canvas px, +grows/−shrinks, distinct from feather). Pure geometry `masks/expand.ts` (10 tests; box-shapes inflate bounds, freeform = vertex-normal offset, split/text are no-ops). **Storage migration v31→v32** backfills `expand:0` (`CURRENT_PROJECT_VERSION` 31→32).
- **Scalar keyframing** (`eb65245c`, U9): `mask.{feather,centerX,centerY,rotation,scale,expand}` on the existing keyframe engine. Resolver `animation/mask-param-channel.ts` (12 tests); resolved in `frame-descriptor` before `buildMaskArtifacts`, **hot-path guarded** (static masks skip it).

### 2e. Editing extras
- **Duplicate Track** (`8f157f68`, U6): right-click → *Duplicate track*. `DuplicateTrackCommand` + pure `timeline/duplicate-track.ts` clone (7 tests). Re-keys linkId groups to a NEW shared id in the copy; **drops the link for a lone member whose partner is on another track** (the `/ce-code-review` fix — was a dangling group-of-one); `main` duplicates into a new overlay video track.
- **Marker edit + CSV** (`87e1896f`, U7): inline comment (reuses `bookmark.note`) + color swatch + Export CSV (`markers-csv.ts`, RFC-4180, 7 tests). The bookmark model + `updateBookmark` command already existed.
- **Unlink** is **already shipped** (don't rebuild): `UnlinkElementsCommand` + clip context-menu "Unlink" + tests.

### 2f. Panels
- **fx-group restyle** (`572eddba`, U10): extracted `FxGroup`/`Row`/`ValueField`/`Stopwatch`/`KfNav` from `effect-controls-tab.tsx` into a shared `properties/components/fx-group/` module (pure move — Effect-Controls keeps its "fx" badge via an opt-in prop). Speed/Audio/Blending adopt the row layout (`FxParamRow` + `variant="fx"`); Text tab unchanged. Visual-only.
- Earlier: Speed-tab target-Duration field, Sequence Settings, Anchor row, peak meters.

### 2g. Code review (`c625d4d7`)
`/ce-code-review` (8 reviewers + validation) on the U1/U6–U10 batch → fixed the Duplicate-Track cross-track-linkId bug + a Roll no-op-undo guard + dedup/consolidation (`STICKY_TIMELINE_TOOLS` set, shared `readScalarMaskValue`, `MAX_EXPAND`→`expand.ts`, `compute-roll` reuses `findTrackInSceneTracks`) + new glue tests. Dropped 2 false-positive lint findings (verified `eslint` clean).

---

## 3. Architecture & patterns (the reusable seams — most valuable for the next agent)

- **Armed-tool model** (`preview/place-tool-store.ts`): `PlaceTool` is a `kind`-union (text/shape/pen/track-select-forward/razor/rate-stretch/ripple/roll/slip/slide). **`STICKY_TIMELINE_TOOLS`** (a `Set` + `isStickyTimelineTool` guard) centralizes Escape-disarm + the place-tool-overlay early-return — **adding a sticky tool now needs only: a union entry + a set entry + an action (`actions/definitions.ts`) + a toggle handler (`actions/use-editor-actions.ts`) + a tool-rail button (`timeline/components/tool-rail.tsx`).** `V` (`activate-selection-tool`) sets tool null.
- **Edge-drag tools → resize-controller** (`timeline/controllers/resize-controller.ts`): a `ResizeMode` (`"trim"|"rate-stretch"|"ripple"|"roll"`) is **latched ONCE at resize-start** from the armed tool; `handleMouseMove` branches to the matching `computeGroup*` (in `timeline/group-resize/`), which returns `GroupResizeUpdate[]` applied via the existing multi-element preview/commit (one undo).
- **Body-drag tools → element-interaction-controller** (`timeline/controllers/element-interaction-controller.ts`): a `MoveMode` (`"move"|"slip"|"slide"`) is latched at mousedown; `"slipping"`/`"sliding"` sessions drive preview-on-drag + single-undo commit via new `previewSlip/Slide`+`commitSlip/Slide` ops wired in `hooks/element/use-element-interaction.ts`. **The normal move path is the untouched `"move"` fall-through.** This seam is where Premiere's other body-drags would hook.
- **Carve model**: `planClipDrop` (pure, tested) is the single source of carve geometry for drop/move/multi. Commands (`OverwriteDropCommand`, `MoveOverwriteCommand`) snapshot `SceneTracks`, split via `SplitElementsCommand` (retime/animation-correct), carve (delete for overwrite / ripple for insert), place the incoming, `updateTracks`, atomic undo — modeled on `RemoveRangesCommand`.
- **opencut-wasm boundary** (verified): it's a downstream texture-quad rasterizer fed a fully-resolved descriptor. ALL geometry, the audio graph (`audio-mastering.ts` master bus), and timeline↔source-time mapping (`retime/resolve.ts`) live in our JS layer → no "advanced" feature needs an engine fork.
- **Wasm-free-helper discipline**: pure math/geometry goes in a wasm-free module (plain tick numbers + a `rate`) so it's **bun-testable**; the `@/wasm`-importing glue lives in the controller/command. `@/wasm`-importing tests crash under `bun test` — when a helper transitively imports `@/wasm`, tests use `mock.module("@/wasm", …)` (see `animation/__tests__/mask-param-channel.test.ts`).
- **PATCHES discipline** (hard rule): every edit to an **upstream-originated** file (author **"Maze Winther"**) must be logged in `PATCHES.md` (root) in the same commit; new (ours, author **"fullvaluedan"**) files are NOT logged. Determine origin: `git log --diff-filter=A --follow --format=%an -- <file> | tail -1`.

---

## 4. Key files map

| Concern | Files |
|---|---|
| Armed tools | `preview/place-tool-store.ts`, `actions/definitions.ts` + `use-editor-actions.ts`, `timeline/components/tool-rail.tsx`, `preview/components/place-tool-overlay.tsx` |
| Edge-drag (trim) | `timeline/controllers/resize-controller.ts`, `timeline/group-resize/compute-{resize,rate-stretch,ripple,roll}.ts`, `timeline/trim-tools/{ripple,roll}.ts` |
| Body-drag (slip/slide) | `timeline/controllers/element-interaction-controller.ts`, `timeline/hooks/element/use-element-interaction.ts`, `timeline/trim-tools/{slip,slide}.ts` |
| Overwrite/insert | `timeline/overwrite/{overwrite-plan,move-overwrite-plan,multi-drop-span}.ts`, `commands/timeline/track/{overwrite-drop,move-overwrite}.ts`, `timeline/controllers/drag-drop-controller.ts`, `timeline/components/drop-target.ts` |
| Tracks / duplicate | `commands/timeline/track/{duplicate-track,add-track,remove-ranges}.ts`, `timeline/duplicate-track.ts`, `core/managers/timeline-manager.ts`, `timeline/components/index.tsx` (track context menu) |
| Masks | `masks/{types,registry,feather,expand}.ts`, `masks/builtin/*`, `masks/freeform/definition.ts`, `masks/components/masks-tab.tsx`, `services/renderer/compositor/frame-descriptor.ts` (`buildMaskArtifacts`) |
| Mask keyframing | `animation/{types,index,mask-param-channel}.ts`, `frame-descriptor.ts` |
| Panels | `components/editor/panels/properties/components/{effect-controls-tab,fx-group/,element-params-tab,property-param-field}.tsx`, `registry.tsx`, `speed/components/speed-tab.tsx` |
| Markers | `components/editor/panels/assets/{views/markers.tsx,markers-csv.ts}`, scene bookmark model |
| Storage migration | `services/storage/migrations/{index,v31-to-v32,transformers/v31-to-v32}.ts` |
| Plans / checklist | `docs/plans/2026-06-16-00{2,3}-*.md`, `docs/plans/2026-06-15-003-*advanced-clip-audio*.md`, **`docs/VERIFY-premiere-parity.md`** |

---

## 5. Intentional v1 limits & follow-ups (NOT bugs)

- **Linked-A/V move-overwrite**: a linked pair is a multi-member group, so a *move* onto an overlap falls through to the ordinary move (no carve). Follow-up: carve per-resolved-track for a linked move.
- **Multi-drop off-type carve**: a multi-drop's off-type clips (audio dropped onto a video track) route to their own new track rather than carving. Follow-up: per-type carve.
- **Freeform mask path-POINT keyframing**: deferred (animating bezier points needs custom array interpolation). Scalar mask props (§2d) are done.
- **Freeform mask Expand contract** on a concave shape is a vertex-normal approximation (no self-intersection resolution) — large inward contracts look rough.
- **Roll** has no default key (Premiere's N = snapping here) — rail-button + user-bindable only.
- **Multi-clip / linked carve-on-move** and **per-type multi-drop carve** are the natural "U4/U5 v2".
- **Advanced clip-audio** (separate plan, `2026-06-15-003`): Reverse speed (rebuild fresh with a **`reversed` flag**, keep rate positive — negative rate broke the clamp/pitch/duration math; it's a 6-consumer change), Time Remapping (keyframed curve + `signalsmith-stretch`), LUFS panel (`needles`, MIT), slow-mo frame-blending, reverse-aware prefetch, Source Monitor. None need a wasm fork. (003-advanced U1 Anchor + U2 Peak-meters already shipped.)

---

## 6. Rules for the next agent
1. **User verifies live on localhost; no Odysseus/Hermes.** Keep changes default-safe/additive; "don't break export" is cardinal. Work `docs/VERIFY-premiere-parity.md` before trusting any gesture/visual feature.
2. **Never fork `opencut-wasm` or `hyperframes`** — everything is doable in the JS layer.
3. **Log every upstream (Maze Winther) file edit in `PATCHES.md` in the same commit.** New (fullvaluedan) files don't. Verify origin with `git log --diff-filter=A --follow --format=%an`.
4. **Interaction controllers are `useState`-held, no HMR** — hard-reload + `window.__vibeEditor`. They're not bun-testable; extract pure wasm-free helpers + unit-test those.
5. **One unit per focused session.** Quality degrades at the tail of a crammed session. Commit + push per clean unit (gate tsc/lint/tests first); **auto-push is OK** (user opted in). When context is long, build via fresh-context subagents and review+gate+commit their diffs.
6. **Reuse the seams** (§3): a new sticky tool needs ~5 small edits; an edge-drag tool adds a `ResizeMode` branch; a body-drag tool adds a `MoveMode` branch; a carve reuses `planClipDrop`.
7. **Branch:** land on `feat/premiere-parity-timeline` → PR #48 → merge into `feat/round26`.

## 7. Suggested next step
**The user should run the verification checklist (`docs/VERIFY-premiere-parity.md`) first** — nothing gesture-level is verified yet, and the v1 follow-ups + advanced-audio plan stack on this foundation. Once it's confirmed, candidates: the linked-A/V move carve + per-type multi-drop carve (small, reuse the carve), then the advanced clip-audio plan (start with reverse-speed via the `reversed` flag, then time-remap). Fix any checklist failures before building further.
