---
title: "feat: Advanced clip & audio features (anchor point, time remap, reverse, audio meters/LUFS, source monitor)"
type: feat
date: 2026-06-15
status: ready
target_branch: feat/premiere-parity-timeline (off feat/round26)
origin: docs/plans/2026-06-15-002-feat-premiere-panel-parity-plan.md
---

# feat: Advanced clip & audio features

## Summary

The panel-parity plan flagged six items as "engine-blocked (needs opencut-wasm work)." **That was wrong.** A trace of the render/audio pipeline shows `opencut-wasm` is a downstream texture-quad rasterizer fed a fully-resolved descriptor — every piece of geometry math, the entire audio graph, and the timeline-time→source-time mapping live in **our JS/TS layer**. So all of these are buildable **without forking opencut-wasm** (the hard rule holds untouched). This plan re-scopes them with a per-unit **confidence verdict** and the specific in-our-layer approach + named OSS, directly answering "did you find OSS, and can you confidently build it?"

The one honest "not confident" item is **AI optical-flow slow-mo** — no drop-in OSS, Chromium-only, heavy. **Frame-blending** is the realistic baseline and is in-our-layer.

---

## Problem Frame

Premiere parity needs: pivot-aware transforms (Anchor Point), variable + reverse clip speed, audio level/loudness metering, and a Source Monitor. The prior plan deferred these as engine work. The architecture finding inverts that:

- **The WASM compositor only rasterizes textured quads.** `computeVisualTransform` (`apps/web/src/services/renderer/compositor/frame-descriptor.ts`) turns our `Transform` `{scaleX,scaleY,position,rotate}` into a quad centered at `centerX/centerY` with `rotationDegrees`; rotation/scale pivot is hard-wired to the quad **center**. Same descriptor path feeds preview and export.
- **Audio plays through a JS Web Audio graph.** `AudioManager.ensureAudioContext` (`apps/web/src/core/managers/audio-manager.ts`) builds `AudioContext → masterGain → mastering chain → destination`; the mastering chain (`apps/web/src/media/audio-mastering.ts`) is a real node graph. The compositor never touches audio.
- **Time mapping is one constant multiply.** `getSourceTimeAtClipTime` (`apps/web/src/retime/resolve.ts`) returns `clipTime * rate`; `clampRetimeRate` (`apps/web/src/retime/rate.ts`) coerces `rate ≤ 0` to 1. Frame access (`videoCache.getFrameAt` → mediabunny `CanvasSink`) is **random-access by timestamp**.

Every feature below is math/UI on top of these existing seams.

---

## Requirements

- **R1** — A clip's scale/rotation can pivot around an editable Anchor Point.
- **R2** — Realtime peak (and per-channel) audio meters during playback.
- **R3** — Integrated loudness (LUFS / EBU R128) metering with delivery targets, plus an export-time loudness readout.
- **R4** — Clip speed supports **reverse** (negative rate).
- **R5** — **Time Remapping**: variable speed via a keyframed velocity curve (speed ramps, freeze frames).
- **R6** — Speed changes preserve audio pitch via real time-stretch (not naive resample).
- **R7** — Slow-motion has a quality option beyond raw frame-duplication (frame-blending baseline).
- **R8** — A Source Monitor: preview a bin clip, mark in/out, before adding it.

---

## Key Technical Decisions

- **KTD1 — Everything stays in our JS layer; opencut-wasm is never forked.** Confirmed: the compositor consumes a resolved `FrameItemDescriptor`; geometry, audio, and time math are all pre-WASM in our code. This is the load-bearing finding that makes the whole plan low-risk.
- **KTD2 — Anchor Point is a compensating-offset.** Pivoting about an arbitrary anchor reduces to a closed-form adjustment of the `centerX/centerY` we already emit (`anchor − (R·S)·anchor`). No new descriptor field, no WASM change. Add an `anchor` channel to `Transform`/params; animate it for free through `resolveTransformAtTime`.
- **KTD3 — Audio metering taps the existing master bus.** Insert an `AnalyserNode` (peak) and an `AudioWorkletNode` (LUFS) at the mastering chain's master node. Export LUFS runs an offline pass on `createTimelineAudioBuffer`'s output. OSS: **`needles`** (MIT, BS.1770 momentary/short-term/integrated), **`web-audio-peak-meter`** (MIT, peak + true-peak). Avoid GPL audio libs.
- **KTD4 — Variable + reverse speed extend the sampler, not the engine.** Replace the constant multiply in `getSourceTimeAtClipTime` with the **integral of a keyframed rate curve** (Remotion's cumulative-seek formula: `sourceTime(t) = ∫₀ᵗ rate(τ)dτ`). Reverse = lifting the `clampRetimeRate` ≤0 guard + emitting decreasing source-time. Audio pitch preservation under speed: **`signalsmith-stretch`** (MIT, WASM + AudioWorklet).
- **KTD5 — Slow-mo: frame-blend now, AI optical-flow deferred.** Frame-blending (weighted mix of adjacent decoded frames) is cheap, universal, in-our-layer. AI optical flow (RIFE via `onnxruntime-web` + WebGPU) has **no drop-in OSS**, is Chromium-only, and costs ~1-2 min for a 5s 4× clip — a future opt-in render path, not the default.
- **KTD6 — Reverse/time-remap performance needs a reverse-aware prefetch.** The video cache prefetches *forward*; backward sampling falls to repeated `seekToTime` (decode-from-keyframe on long-GOP) → slow without a reverse prefetch in `video-cache/service.ts`. Correctness is unaffected; this is a perf unit.

---

## Implementation Units

Each unit carries a **Confidence** verdict (the direct answer to "can you confidently build it?").

### U1. Anchor Point (transform pivot)
**Confidence: HIGH.** Pure math, no OSS, no WASM. *(R1)*
**Files:** `apps/web/src/rendering/index.ts` (add `anchor` to `Transform` + `buildTransformFromParams`), `apps/web/src/services/renderer/compositor/frame-descriptor.ts` (`computeVisualTransform` — apply the compensating offset), the transform param registry (`params/registry.ts`), Effect Controls Motion group (`properties/components/effect-controls-tab.tsx` — add an Anchor row), and a test for the offset math.
**Approach:** Add an `anchor {x,y}` param (default = center, i.e. 0,0 offset). In `computeVisualTransform`, displace `centerX/centerY` by `anchor − rotate(scale(anchor))` so scale/rotation pivot about the anchor. Extract the offset computation as a **pure, wasm-free helper** so it's unit-testable under bun.
**Test scenarios:** anchor at center → no position change (regression guard); anchor offset + 90° rotation → expected center displacement; anchor + non-uniform scale → expected displacement; default param absent → behaves exactly as today.
**Verification:** bun unit test on the offset helper; live — set an anchor, rotate/scale, confirm pivot; export matches preview (same descriptor path).

### U2. Audio peak meters
**Confidence: HIGH.** *(R2)*
**Files:** `apps/web/src/media/audio-mastering.ts` (expose a tap node), `apps/web/src/core/managers/audio-manager.ts` (`ensureAudioContext` — attach `AnalyserNode` / `ChannelSplitter`), a new meter component on the preview toolbar (`apps/web/src/preview/components/toolbar.tsx`), optional dep `web-audio-peak-meter`.
**Approach:** Insert an `AnalyserNode` (per-channel via `ChannelSplitter` for L/R) at the master/output node. Read `getFloatTimeDomainData` per `requestAnimationFrame`; render a dBFS bar with peak-hold + red clip indicator. Post-limiter tap for a true output meter.
**Test scenarios:** silence → floor; full-scale tone → 0 dBFS + clip indicator; peak-hold decays; meter stops updating when transport paused (no audio context churn).
**Verification:** live — play a clip with audio, meter moves; mute → floor.

### U3. LUFS loudness panel
**Confidence: HIGH** (true-peak is a minor gap in `needles`). *(R3)*
**Files:** new loudness panel component, `audio-manager.ts` (attach the worklet), `apps/web/src/media/audio.ts` (`createTimelineAudioBuffer` already produces the full mix → offline LUFS pass), dep `needles` (MIT).
**Approach:** Realtime: `needles` worklet on the master bus → momentary/short-term/integrated LUFS. Delivery presets (YouTube −14, Spotify −14, broadcast −23). Export/file LUFS: offline BS.1770 pass on the rendered buffer. Measure pre-limiter for source loudness, post-limiter for delivered (the limiter at `audio-mastering.ts` already shapes output).
**Test scenarios:** known −23 LUFS reference buffer measures ≈ −23 (offline path); preset switch updates the target line; integrated value stabilizes over a sustained tone.
**Verification:** live meter + an offline measurement on a known file.

### U4. Reverse speed
**Confidence: HIGH (correctness) / MEDIUM (perf).** *(R4)*
**Files:** `apps/web/src/retime/rate.ts` (relax the ≤0 clamp to allow signed rate), `apps/web/src/retime/resolve.ts` (`getSourceTimeAtClipTime` emits decreasing source-time for negative rate), `apps/web/src/timeline/components/audio-waveform.tsx`/audio render (reverse the audio buffer offline), Speed tab (`apps/web/src/speed/components/speed-tab.tsx` — Reverse toggle), `apps/web/src/timeline/retime/__tests__` for the sampler.
**Approach:** Allow negative rate; map `clipTime → trimEnd − |rate|·clipTime` (decreasing source timestamps). Video: `CanvasSink` seeks backward fine. Audio: reverse the source buffer (offline). Pair with U7's reverse-aware prefetch for smoothness.
**Execution note:** Verify reverse playback live before claiming done — the perf path (long-GOP backward seek) is the risk, not correctness.
**Test scenarios:** rate −1 → first timeline frame samples the clip's last source frame; reverse + trim respects the trimmed window; audio plays reversed; toggling reverse off restores forward mapping.
**Verification:** live — reverse a clip, scrub, export; confirm no crash on long-GOP (perf may be slow pending U7).

### U5. Time Remapping (keyframed variable speed)
**Confidence: HIGH (engine) / the timeline rubber-band UI is the bulk.** *(R5, R6)*
**Files:** `apps/web/src/timeline/types.ts` (`RetimeConfig` → add a keyframed curve variant; note `audio-manager.ts` already references a `mode:"curve"` hook), `apps/web/src/retime/resolve.ts` (integral-of-curve sampler + caching), a timeline velocity rubber-band overlay, Effect-Controls Time-Remapping row, audio via `signalsmith-stretch` (MIT), tests for the integral sampler.
**Approach:** Extend retime from a scalar to a keyframed rate curve; `sourceTime(t) = ∫₀ᵗ rate(τ)dτ` (precompute/cache the piecewise integral). Timeline rubber-band to add/drag speed keyframes; Alt-split a keyframe → speed ramp; 0% segment → freeze frame. Audio pitch held via `signalsmith-stretch` worklet.
**Test scenarios:** constant curve == today's constant rate (regression); a 2-keyframe ramp produces the expected monotonic source-time integral; freeze-frame (0%) holds one source frame; clip on-timeline duration recomputes from the curve.
**Verification:** bun test on the integral sampler (extract wasm-free); live — draw a speed ramp, confirm smooth accel + correct duration.

### U6. Slow-motion frame-blending
**Confidence: HIGH** (frame-blend). *(R7)*
**Files:** the frame-resolution path (`apps/web/src/services/renderer/resolve.ts` / video-cache), Speed-tab "Time interpolation" selector (Frame sampling | Frame blending).
**Approach:** When interpolation = blending and the requested source-time falls between decoded frames, mix the two nearest frames weighted by the fractional position. Default stays "frame sampling" (current behavior). **AI optical-flow is explicitly deferred** (see Scope Boundaries).
**Test scenarios:** sampling mode unchanged (regression); blending at a fractional time mixes the bracketing frames; blending at an exact frame == that frame.
**Verification:** live — 50% slow-mo with blending looks smoother than sampling.

### U7. Reverse/time-remap-aware video prefetch
**Confidence: MEDIUM.** *(supports R4, R5)*
**Files:** `apps/web/src/services/video-cache/service.ts` (prefetch + fast-path direction).
**Approach:** Detect playback/sample direction; prefetch the *previous* frame and widen the backward fast-path window so reverse + reverse-ramp scrubbing isn't a cold seek every frame.
**Test scenarios:** forward unchanged (regression); reverse sampling hits cache for consecutive backward frames; direction flip re-primes correctly.
**Verification:** live — reverse playback is materially smoother than U4 alone.

### U8. Source Monitor
**Confidence: HIGH (feasibility) / LARGE (scope).** *(R8)*
**Files:** a new Source Monitor panel (reusing `apps/web/src/services/video-cache` + `canvas-renderer`), per-asset in/out state, and a feed into insert/overwrite (ties to the timeline plan's Insert/Overwrite backlog).
**Approach:** A second preview surface that decodes a bin clip via the existing `videoCache.getFrameAt`; mark in/out (persisted per asset); transport controls. Insert/Overwrite wiring is a dependency on the timeline Insert/Overwrite unit — build the monitor + in/out first, wire edits when that lands.
**Test scenarios:** open a clip → plays independently of the program preview; mark in/out → persists on reopen; (later) insert respects the marked range.
**Verification:** live — open a bin clip in the source monitor, mark in/out, confirm independence from the program monitor.

---

## Scope Boundaries

- **In scope:** U1–U8 above, all in our JS/TS layer.
- **Deferred to Follow-Up Work:**
  - **AI optical-flow slow-mo (RIFE via `onnxruntime-web` + WebGPU).** No drop-in OSS; Chromium-only; ~1-2 min per 5s 4× clip. An opt-in "high quality" render path after frame-blending ships. *(this is the one genuinely low-confidence item)*
  - **Audio time-stretch quality tiers** beyond `signalsmith-stretch` (e.g. Rubber Band) — blocked by GPL licensing, not capability.
  - Source Monitor ↔ Insert/Overwrite wiring depends on the timeline Insert/Overwrite unit (timeline plan).
- **Out of scope:** forking or modifying `opencut-wasm` (hard rule; and unnecessary — the finding above).

---

## Risks & Dependencies

- **Reverse/remap performance (U4/U5)** on long-GOP codecs — mitigated by U7; correctness is independent.
- **OSS licenses:** recommended deps are all **MIT** (`needles`, `web-audio-peak-meter`, `signalsmith-stretch`). Avoid GPL (`rubberband-web`) and weigh MPL (`SoundTouchJS`) against the distribution model.
- **All touch opencut-upstream files** → `PATCHES.md` entry per change.
- **Verification reality:** extract pure math (anchor offset, retime integral) into wasm-free helpers for bun unit tests; the rest is live-verified (audio graph, decode, render) — `tsc`/lint gate the wiring.
- **`needles` lacks true-peak** — pair with `web-audio-peak-meter` for true-peak if delivery compliance needs it.

---

## Sources & Research

OSS landscape (GitHub, 2026): **needles** (MIT, BS.1770 LUFS), **web-audio-peak-meter** (MIT), **signalsmith-stretch** (MIT, time-stretch/pitch), **optical-flow-web** / RIFE-via-`onnxruntime-web` (no drop-in; deferred), Remotion accelerated-video docs (cumulative-seek formula for variable speed), `diffusionstudio/webcodecs-scroll-sync` (reverse-seek reference). Architecture finding from tracing `services/renderer/compositor/frame-descriptor.ts`, `core/managers/audio-manager.ts`, `media/audio-mastering.ts`, `retime/resolve.ts`, `retime/rate.ts`, `services/video-cache/service.ts` — all confirm the work lives in our JS layer, not opencut-wasm.
