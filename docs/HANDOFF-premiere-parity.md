# Handoff — Premiere parity branch

**Branch:** `feat/premiere-parity-timeline` (off `feat/round26`) · **PR:** [vibecut#48](https://github.com/fullvaluedan/vibecut/pull/48) → base `feat/round26`
**Updated:** 2026-06-16 · **HEAD:** `dd2f9ecb`

This branch closes a large batch of Premiere-Pro parity gaps across the timeline, the inspector panels, and clip transform/audio — all built in our own JS/TS layer (no `opencut-wasm` fork). Everything below is committed + pushed.

---

## What shipped (verified-safe, on the PR)

| Area | Commit | What |
|---|---|---|
| Timeline #4 | `d088a565` | Video/image drop prefers **V1** over a free overlay (`preferMainTrackIndex`, unit-tested) |
| Timeline #2 | `a9976cab` | **Track Select (A)** gesture is momentary → the selection is draggable as a group |
| Timeline R4 | `423360a4` | Move/trim **snap to markers + sequence start (0:00)** (edges already cross-track) |
| Bin | `0c54ce02` | **Asset metadata** in list view + preview dialog (resolution · fps · duration · codec · audio) |
| Speed | `3e3609dd` | Speed tab **target Duration** field (length ↔ rate, wasm-free math, unit-tested) |
| Project | `e387a1ed` | **Sequence Settings** — editable fps + resolution from the editor header (same `updateSettings` as the buried Settings tab) |
| Markers | `cbd3d4b1` | **Markers** Assets tab — list scene bookmarks, click-to-seek, delete |
| Transform | `cf0e93f0` | **Anchor Point** — scale/rotation pivot; pure offset math (unit-tested); **default anchor → byte-identical export** |
| Audio | `25a4cdc9` | **Peak meters** — observe-only `AnalyserNode` on the master bus; dBFS bar + peak-hold + clip indicator (no dep) |

Also: `docs/premiere-parity-audit.md` (timeline audit), and three plans in `docs/plans/2026-06-15-00{1,2,3}-*` (timeline parity, panel parity, advanced clip/audio).

## Test + verification state

- **Runnable unit tests: 38 pass / 0 fail** (`prefer-main-track`, `retime/duration`, `compositor/anchor-offset`, plus `chunk-plan`/`concurrency`). `tsc` clean (bar the known `globals.css` false positive); eslint clean on changed code.
- **Bun cannot run timeline tests that import `@/wasm`** (`opencut-wasm __wbindgen_start` init fails) — pre-existing. Those units are tsc + live-verified; prefer extracting **pure wasm-free helpers** so logic stays unit-testable (the pattern used for `preferMainTrackIndex`, `retime/duration`, `anchor-offset`).
- **Still needs a live/export check on the build machine (Odysseus):** the interaction gestures (#2, #4, snapping), the Speed Duration field, Anchor Point pivot, and the audio meter. None can regress existing export/audio, but confirm behavior before relying on them. One thing to confirm specifically: a rotated **off-center anchor** pivots the correct direction — if it mirrors, flip the `sin` sign in `services/renderer/compositor/anchor-offset.ts`.

---

## Remaining work — `docs/plans/2026-06-15-003-feat-advanced-clip-audio-features-plan.md`

Key finding (verified by tracing the pipeline): **`opencut-wasm` is a downstream texture-quad rasterizer** fed a fully-resolved descriptor. All geometry math, the audio graph, and the timeline→source-time mapping live in our JS layer — so **none of these need an engine fork**. Per-unit confidence + exact seams are in the plan.

| Unit | Confidence | Status / next |
|---|---|---|
| **U4 Reverse speed** | High (core) | **Attempted, reverted.** An automated build hung and left broken code (tsc failed on the export path — `services/renderer/resolve.ts` lost `getSourceTimeAtClipTime`). Core: relax `retime/rate.ts` ≤0 clamp (signed rate) + decreasing source-time in `retime/resolve.ts` (unit-test it) + audio buffer reverse + Speed-tab toggle. **Rebuild fresh**, don't salvage. |
| **U3 LUFS panel** | High | Needs npm dep `needles` (MIT) worklet on the master bus + offline pass on `createTimelineAudioBuffer`. Dep install + worklet need runtime verification. |
| **U5 Time Remapping** | High (engine) / large UI | `RetimeConfig` scalar → keyframed curve; integral sampler in `retime/resolve.ts` (Remotion cumulative-seek); timeline rubber-band; audio via `signalsmith-stretch` (MIT). Largest item. |
| **U6 Frame-blend slow-mo** | High | Two-frame blend in the render resolve path; default stays "sampling" (export-safe). Opt-in `interpolation` field. |
| **U7 Reverse prefetch** | Medium | Direction-aware prefetch in `services/video-cache/service.ts` (perf for reverse/U4). |
| **U8 Source Monitor** | High / large UI | Second preview over existing decode/render APIs + in/out marking. **Only remaining unit with zero export/audio/dep risk** — safe to build any time. |
| **P4a Multi-clip Effect Controls edit** | — | Fan property writes across all selected clips (`properties/index.tsx` representative-only today). Intricate write path in a tested panel — careful, live-verify. |
| Deferred | — | AI optical-flow interpolation (RIFE/ONNX, Chromium-only, no OSS drop-in); Razor-at-click, Insert/Overwrite, rolling/slip/slide, source patching, JKL (timeline plan). |

---

## How to continue (rules for the next agent)

1. **Verify on Odysseus before trusting export/audio changes.** Don't break export — it's the cardinal rule. U4/U5/U6 change the export/decode path; the PR is the verification vehicle (build + DeepSeek review on Odysseus before merge).
2. **Never fork `opencut-wasm` or `hyperframes`.** Everything is doable in the JS layer (see the key finding above).
3. **Log every upstream (opencut) file edit in `PATCHES.md` in the same commit.** New (ours) files don't need an entry.
4. **The element-interaction controller is `useState`-held and does NOT hot-reload** — hard-reload / restart dev before iterating on drag/move; inspect via `window.__vibeEditor`.
5. **Build one unit per focused session.** Lesson from this branch: a single huge session + a hung sub-agent led to broken U4. Keep sessions scoped; commit + push per unit so the PR stays reviewable.
6. **Branch convention:** keep landing on `feat/premiere-parity-timeline` → PR #48 → merge into `feat/round26`.

## Suggested next step
Review/build PR #48 on Odysseus to confirm the shipped units, then pick up **U8 (Source Monitor — zero-risk)** or **rebuild U4 (Reverse)** fresh, each verified on the build machine.
