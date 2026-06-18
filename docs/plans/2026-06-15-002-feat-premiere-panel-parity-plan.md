---
title: "feat: Premiere-Pro panel & inspector parity — the non-timeline surface"
type: feat
date: 2026-06-15
status: ready
target_branch: feat/premiere-parity-timeline (off feat/round26)
origin: docs/premiere-parity-audit.md
---

# feat: Premiere-Pro panel & inspector parity — the non-timeline surface

## Summary

The first parity pass covered the **timeline interaction model** (tools, snapping, trims, drops). This plan covers everything **outside the timeline** — the panels, inspectors, settings, and clip controls — which is where the remaining "this doesn't feel like Premiere" gaps live: a dedicated Effect Controls panel, asset metadata, frame-rate/sequence settings, clip speed/duration, plus Source Monitor, audio meters, and the markers/info/history panels.

**Critical correction from the audit:** several things assumed missing already exist — they're just under-surfaced. This plan distinguishes *build new* from *surface/complete existing*, so we don't rebuild what's there.

---

## Current-state map (evidence-based)

| Premiere surface | Status | Where it is / what's missing |
|---|---|---|
| Effect Controls | 🟡 **EXISTS as the "Transform" tab** (`properties/components/effect-controls-tab.tsx`) | Motion (Position/Scale/Rotation), Opacity, Audio groups; stopwatch keyframing; scrub values. Missing: **dedicated panel**, in-panel keyframe **graph**, **Anchor Point**, true multi-clip edit |
| Asset metadata | ✅ **SHIPPED this session** | Bin list shows resolution · fps · duration; preview dialog shows +codec/audio. Follow-up: sortable detail columns + Video Usage |
| Change frame rate / resolution | ✅ **EXISTS** | Assets panel → **Settings** tab (`panels/assets/views/settings/index.tsx`): fps dropdown + canvas size, undoable. Missing: a discoverable **Sequence Settings** dialog home |
| Clip Speed / Duration | 🟡 **EXISTS, partial** | `Ctrl+R` → **Speed** tab: speed % + maintain-pitch (`speed/components/speed-tab.tsx`, model `retime: {rate, maintainPitch}`). Missing: **Duration** field, **Reverse**, **Ripple**, **Time Interpolation**, **Time Remapping** |
| Source Monitor | 🔴 **MISSING** | Only `media-preview-dialog.tsx` (a modal `<video controls>`). No in/out marking, no insert/overwrite-from-source |
| Audio meters / Loudness (LUFS) | 🔴 **MISSING** | Waveforms render on clips; no realtime peak meter or LUFS panel |
| Markers panel / Info panel / History panel | 🔴 **MISSING** | Timeline bookmarks exist; no list panels |
| Transitions / Adjustment browsers | 🔴 **Stubs** | "coming soon" in `panels/assets/index.tsx` |

---

## Requirements

- **R1** — Per-asset metadata is visible in the bin and preview. *(✅ shipped — P1)*
- **R2** — Frame rate / resolution are changeable from a discoverable, Premiere-shaped surface.
- **R3** — Clip speed is fully editable: speed %, target duration, reverse, ripple, and interpolation quality.
- **R4** — The Effect Controls surface reaches Premiere parity: dedicated panel feel, in-panel keyframes, Anchor Point, multi-clip edit.
- **R5** — Variable-speed Time Remapping (keyframed velocity).
- **R6** — A Source Monitor with in/out marking feeding insert/overwrite.
- **R7** — Audio meters (peak + LUFS) and the markers/info/history list panels.

---

## Implementation Units (ranked by value × bounded-risk)

Units flagged **⚠ engine** touch the compositor (`opencut-wasm`) or renderer/decode and need a deeper design pass — do not treat as quick wins. Units flagged **ready** are bounded UI/state work.

### P1. Asset metadata in the bin — ✅ SHIPPED
`draggable-item.tsx` gained a compact `meta` slot; `views/assets.tsx` renders resolution · fps · duration; `media-preview-dialog.tsx` shows +codec/audio. **Follow-up (ready):** a sortable list-detail mode with columns (resolution, fps, codec, audio, Video Usage count) — extend the existing sort infra in `views/assets.tsx`.

### P2. Sequence Settings dialog — *ready*
**Goal (R2):** make frame-rate/resolution change discoverable in a Premiere-shaped "Sequence Settings" dialog instead of buried in the Assets → Settings tab.
**Approach:** reuse the existing `editor.project.updateSettings` calls (`panels/assets/views/settings/index.tsx:257-329`); make `project/components/project-info-dialog.tsx` editable (it's the natural shell) or add a dialog opened from a menu. No new plumbing — `UpdateProjectSettingsCommand` is already undoable. Note the multi-sequence caveat (Premiere has per-sequence settings; we have one project setting) as a documented limitation.
**Test scenarios:** changing fps updates `project.settings.fps` and is undoable; changing canvas size updates render size; dialog opens/closes; existing Settings-tab path still works.

### P3. Speed / Duration completion
- **P3a (ready) — Duration field.** Add a Duration input to the Speed tab that derives `retime.rate` from a target clip length (positive rate only; reuse `buildConstantRetime`/`clampRetimeRate`). Tests: setting duration sets the matching rate and vice versa; clamp respected.
- **P3b (⚠ engine) — Reverse.** Allow negative/​signed rate (`retime/rate.ts` currently clamps positive) and thread reverse playback through `retime/resolve.ts` + the decode/render path.
- **P3c (⚠ engine) — Time Interpolation.** Frame sampling / frame blending / optical flow for slow-mo; optical flow is a large renderer feature.
- **P3d (ready) — Ripple toggle.** "Shift trailing clips" when duration changes — reuse the existing `ripple/` module (currently wired only to deletes).

### P4. Effect Controls → dedicated parity
- **P4a (ready) — Multi-clip edit.** Change the representative-only selection in `properties/index.tsx:82-94` to fan value writes across all selected clips.
- **P4b (⚠ engine) — Anchor Point.** Add an anchor/pivot param (`params/registry.ts`) **and** compositor pivot support in `opencut-wasm` so scale/rotation pivot honors it. Fake param without engine support is not acceptable.
- **P4c (larger UI) — In-panel keyframe graph** + promote `EffectControlsTab` into a dedicated panel (it already takes just `{element, trackId}`), removing the "go to the timeline lanes" hand-off (`effect-controls-tab.tsx:1049`).

### P5. Time Remapping — *⚠ engine, large*
**Goal (R5):** variable speed via a keyframed velocity curve. Extend `RetimeConfig` (`timeline/types.ts:87-90`) from a scalar `rate` to a keyframed curve; add the timeline rubber-band + Effect-Controls velocity graph; thread through `retime/resolve.ts` and the renderer. The single largest item.

### P6. Audio meters + Loudness — *⚠ engine, high creator value*
**Goal (R7):** realtime peak meters (dBFS, hold/clip) on the preview toolbar, and a LUFS loudness panel with delivery presets (YouTube −14, etc.). Needs realtime level taps from the audio graph during playback/render.

### P7. Source Monitor — *larger UX*
**Goal (R6):** a two-up Source/Program model — open a bin clip in a source monitor, mark in/out (persisted per asset), and feed Insert/Overwrite into the timeline (ties into the timeline plan's Insert/Overwrite backlog). Replaces the modal `media-preview-dialog.tsx` for the source role.

### P8. Markers / Info / History panels — *medium each*
- **Markers panel:** list of timeline bookmarks with name/comment/color + CSV export (data exists in `timeline/bookmarks/`).
- **Info panel:** contextual clip/gap details (name, type, fps, frame size, in/out, duration).
- **History panel:** a visual list over the existing command stack (`core/managers/commands.ts`) with click-to-state.

### P9. Effects browser completion — *medium*
Fill the **Transitions** and **Adjustment** stub views (`panels/assets/index.tsx:25-35`); add favorites/presets to the existing `EffectsView`.

---

## Scope Boundaries

- **In scope (this plan):** the durable identification + ranked program above. P1 shipped; P2, P3a, P3d, P4a, P8, P9 are the bounded next builds.
- **Needs a deeper design/engine pass before building:** P3b/P3c (reverse, optical flow), P4b (Anchor Point — compositor pivot), P5 (Time Remapping), P6 (audio meters/LUFS), P7 (Source Monitor). These touch `opencut-wasm`/the renderer or are major UX additions — never fork opencut-wasm; extend via the patch discipline.
- **Out of scope (product identity):** full broadcast multi-sequence project model; XMP metadata fields; the full ~100-effect Premiere library.

---

## Risks & Dependencies

- **Engine-touching units** (P3b/c, P4b, P5, P6) require compositor/renderer changes — slower, riskier, and some need design decisions (e.g. does the WASM compositor expose a pivot transform?). Confirm engine capability before committing.
- **Discoverability vs duplication (P2):** frame-rate change already works in the Settings tab — the dialog must not create a second source of truth; both should call the same `updateSettings`.
- **Upstream discipline:** all of these touch opencut-upstream files → `PATCHES.md` entry per change.
- **Verification reality:** UI/panel behavior is verified live (the editor needs a loaded project with media); pure helpers (e.g. duration↔rate math in P3a) should be extracted wasm-free and unit-tested, per the timeline plan's lesson.

---

## Verification

1. `tsc --noEmit` clean (bar the known `globals.css` false positive); eslint no new errors on changed files.
2. Bun unit tests for any extracted pure helpers (e.g. P3a duration↔rate).
3. Live (localhost:3000): per-unit checks in a loaded project — P2 (change fps, undo), P3a (set duration, speed updates), P4a (multi-select edits all), etc.
4. Each upstream-file edit logged in `PATCHES.md`.

---

## Sources & Research
Premiere panel model (Effect Controls keyframe graph, Project metadata columns, Sequence vs Project Settings, Speed/Duration dialog + Time Remapping, Source/Program monitors, audio meters/LUFS, markers/info/history) — Adobe Help + PremiumBeat + practitioner sources. Codebase map confirmed against `panels/properties/`, `panels/assets/`, `speed/`, `retime/`, `project/`. See `docs/premiere-parity-audit.md`.
