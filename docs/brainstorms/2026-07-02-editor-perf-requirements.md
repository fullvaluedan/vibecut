---
title: "Editor performance — timeline interaction lag + playback stutter (diagnosis + requirements)"
date: 2026-07-02
type: brainstorm
status: diagnosis-only
branch: feat/director-importance
phase: A (code-reading diagnosis; NO code changed, nothing committed)
source_project: Dan's live 32:19 project — 28 bin assets, V1 video + linked A1 audio, waveforms visible
---

# Editor performance: timeline lag + playback stutter

Diagnosis by code reading only. No code was changed, no dev server was touched, nothing
was committed. This doc ranks the most plausible lag sources with `file:line` evidence and
proposes requirements + the cheap live measurements to run in Phase B (Chrome, Dan drives).

## Symptoms (Dan, live, today)

Project: a 32:19 timeline, 28 bin assets, multiple clips on V1 + linked audio on A1, audio
waveforms visible on clips. Two symptoms explicitly selected:

1. **Timeline interactions feel delayed/stuttery** — dragging clips, trimming, scrubbing the
   playhead.
2. **Playback stutters** — preview drops frames / freezes during play.

Deprioritized (not selected): "whole app always sluggish", "only during AI runs". Treat the
lag as present during normal editing. Also present in the project (not necessarily the lag
cause, but real-world state): out-of-sync badges (`-108f/+109f`) from video moved independently
of linked audio.

Caveat carried from the brief: Dan is on `next dev --turbopack`, so some overhead is inherent.
The goal is to find OUR hot paths, not to stop at "it's dev mode".

---

## Prior art status — what actually shipped from the June-20 perf plan

The June-20 plan (`docs/plans/2026-06-20-001-fix-director-longvideo-perf-plan.md`, KTD1–KTD5 /
U1–U5) **fully shipped**. Confirmed from `git log`:

| Plan unit | Commit | Status |
|-----------|--------|--------|
| U1 probe word-capability | `6eb7c6e7`, `9ed97510`, `e32769c1` | shipped |
| U2 honest "Transcribing…" label | `8a6b29c0` | shipped |
| **U3 / KTD3 seek race (freeze on frame 1)** | **`68ba04c7` "supersede frame decodes by time, not count"** | **shipped** |
| U4 stream-resample long audio | `4f3c3599` | shipped |
| U5 whisper-tiny for long analysis | `1c056ebc` | shipped |

Plus three bonus perf commits from the same session that bear directly on the current symptoms:

- `7159aac8` **perf(timeline): memoise Timeline so playback stops re-rendering 137 clips** — wrapped
  `Timeline` in `React.memo` (`apps/web/src/timeline/components/index.tsx:777`).
- `5021a60d` **perf(preview): return the cached frame without re-running the decode chain** — the
  synchronous fast-path in `getFrameAt` (`apps/web/src/services/video-cache/service.ts:56-61`).
- `7b28a47c` **perf(transcription): stop re-hashing the timeline on every scrub** — moved the
  background-transcriber hash off a wide selector onto the stable `tracks` ref.

The direct-manipulation plan (`2026-06-29-003`) also shipped in full (multi-select move, single-clip
trim, selection prune, ripple-insert, etc. — commits `da522e4c`, `9675b94d`, `70f5b74d`,
`172715bc`, `a545dc82`, and follow-ups).

**Implication for the current stutter:** KTD3 is not the bug anymore. Reading the current code
confirms the seek race is genuinely fixed:
- `getFrameAt` supersedes queued decodes by **requested time**, not a monotonic count
  (`service.ts:63-85`, pure decision in `seek-supersede.ts:25-36`), so same-time RAF repeats
  coalesce and the latest distinct time completes.
- A synchronous fast-path returns the still-valid decoded frame without touching the async chain
  (`service.ts:56-61`).
- An undecodable-media negative cache stops re-probing bad clips every frame (`service.ts:33,44`).

So the **current** playback stutter is a *different mechanism* (see H4/H5 below), not KTD3 residue.

Out of scope (unchanged): the Rust/wasm compositor (`opencut-wasm`) internals — no local toolchain
to instrument. JS-side call frequency INTO wasm, batching, caching, and re-render elimination are
all in scope.

---

## How the two gestures flow through the code (traced)

**Playback preview loop** (steady state, decoupled from React):
- `PreviewCanvas.render` runs under `useRafLoop` (`preview/components/index.tsx:198-228`). It reads
  the time **imperatively** (`editor.playback.getCurrentTime()`, line 202) — no React state per
  frame — and early-outs when the frame index and render tree are both unchanged (`:210-215`).
- During playback the clock is `PlaybackManager.updateTime` on its **own** RAF
  (`playback-manager.ts:232-259`). Per tick it calls **only** `notifyUpdate` → `updateListeners`
  (`:256`, `:203-207`), **not** the general `notify()` that `useEditor` subscribes to. So
  `useEditor` selectors do **not** re-run every frame during playback — only explicit
  `onUpdate(setCurrentTime)` consumers do (timecode display + the bookmark overlay that forced the
  `Timeline` memo). This bounds the per-frame React cost. (This corrects an over-read that playback
  drives a 60 Hz whole-tree re-render — it does not.)

**Scrub** (playhead drag): each mousemove → `seek()` → `notify()` (`playback-manager.ts:72-80`),
which DOES fire all `useEditor` subscribers. But `useEditor`'s `getSnapshot` bails the re-render
when the selector value is shallow-equal to the cache (`use-editor.ts:51-69`), and the scene/tracks
reference is stable during a pure scrub (no edit), so most subscribers bail and only the playhead
actually moves. Scrub's real cost is (a) the preview decode seeking a long source, and (b) the
per-move O(n) snap-point scan — not a wide re-render.

**Clip drag / trim**: this is the one that forces a wide re-render. The drag controller runs a
**raw** `document` `mousemove` listener with **no rAF coalescing** and calls `notify()` on every
event (`element-interaction-controller.ts:471,572-595,720-721`). `notify()` fan-outs to
`useElementInteraction`'s `useReducer` bump (`use-element-interaction.ts:80-81`), which forces
`TimelineImpl` to re-render — bypassing shallow-equal entirely — on **every pointer event**.

---

## Ranked hypotheses (likelihood × impact)

### H1 — Raw mousemove → forced full-timeline re-render, ×  unmemoized clips, × O(n) sync badge = O(n²) per pointer event  ⭐ TOP for symptom 1 (drag/trim)

**Likelihood: high. Impact: high. Confidence: high (first-hand traced).**

Per raw mousemove during a drag/trim:
1. `handleMouseMove` fires on every pointer event — no rAF throttle, no coalescing
   (`element-interaction-controller.ts:471` registers it; `:572-595` dispatches; `:720-721`
   notifies). High-poll mice fire this well above 60 Hz.
2. `notify()` → `useElementInteraction`'s forced `rerender` (`use-element-interaction.ts:80-81`) →
   `TimelineImpl` re-renders. The `React.memo` on `Timeline` does **not** help — it only blocks
   *parent-driven* re-renders; this one originates inside Timeline's own hook.
3. `TimelineTrackRows` (`timeline/components/index.tsx:779`) is not memoized and receives a **new**
   `dragView` object every move (the `view` getter allocates a fresh object + `memberTimeOffsets`
   Map each call — `element-interaction-controller.ts:328-349`), so all track rows re-render.
4. `TimelineElement` (`timeline-element.tsx:243`) is **not memoized** and also takes `dragView` as a
   prop → **all 28+ clips re-render on every pointer event**.
5. Each re-rendered clip renders `<AvSyncBadge>` (`timeline-element.tsx:434`), which calls
   `computeAvSyncOffset` **unconditionally** (`:1329-1335`). That function double-loops over **all
   tracks × all elements** to find the A/V partner (`av-sync.ts:56-75`). With 28 clips this is
   ~28 × (scan of ~56 elements) ≈ **1.5k element visits per pointer event**, on top of reconciling
   28 full clip subtrees.

Net: **O(n²) per pointer event, at pointer poll rate.** This is the most likely dominant cause of
drag/trim feeling delayed and stuttery on a 28-clip project. It gets worse linearly-squared as the
project grows.

Secondary per-move costs inside the same handler (all O(n), additive, but smaller than the render
fan-out): `computeDropTarget` hit-test over all tracks (`element-interaction-controller.ts:246`),
`resolveGroupMoveForDrop` → `resolveGroupMove` (`:555-562`), and `snapGroupEdges` scanning tracks
for snap points (`:506`).

### H2 — `computeAvSyncOffset` is O(total elements) and runs per clip, uncached  ⭐ amplifier for H1, and a standalone cost

**Likelihood: high. Impact: medium-high. Confidence: high.**

`AvSyncBadge` renders for **every** video/audio clip (`timeline-element.tsx:434`) and recomputes the
partner scan on every render with **no memoization** (`av-sync.ts:41-87`; the double loop is
`:56-75`). It is the multiplier that turns H1's "re-render N clips" into "O(n²)". It also fires on
any legitimate timeline re-render (selection change, edit), not just drags. Because Dan's project is
exactly the shape this scans hardest (linked V/A pairs across a long timeline), this is a real
standalone cost even outside dragging. Cheapest structural fix later: compute all badge offsets once
per tracks-change (a single O(n) pass keyed by `linkId`) and hand each clip its precomputed value,
or memoize the component on `element`.

### H3 — Per-move snap-point scan on scrub and resize is O(n)  (contributor to symptom 1, scrub + trim)

**Likelihood: medium-high. Impact: medium. Confidence: medium-high (agent-traced, not line-verified
by me).**

Both the playhead scrub handler and the resize handler rebuild timeline snap points every move by
scanning all tracks/elements (`playhead-controller.ts` scrub → `buildTimelineSnapPoints` with
element-edge + keyframe sources; `resize-controller.ts` `snappedDelta` → same). O(n) per move. On
scrub this stacks on top of the decode cost (H5); on trim it stacks on top of H1's re-render.
Snapping is toggleable (`timeline-store` `snappingEnabled`), which is a useful Phase-B A/B lever:
if turning snapping off materially smooths trim/scrub, this is confirmed as a real contributor.

### H4 — Playback: async render walks the whole node tree every frame; frame-budget overrun drops ticks  ⭐ TOP for symptom 2 (playback)

**Likelihood: high. Impact: high. Confidence: medium-high.**

The preview render is fired-and-not-awaited under a single in-flight guard: if a frame's
`renderer.render(...)` (decode + wgpu composite) has not resolved, the next rAF tick early-returns
via `renderingRef.current` (`preview/components/index.tsx:199,217,223`). So **whenever one frame's
work exceeds the frame budget, the next tick is dropped** — this is exactly "drops frames / freezes"
during play.

What scales that per-frame work with clip count:
- `resolveRenderTree` → `resolveNode` recurses the **entire** node tree every frame and
  `Promise.all`s all children (`renderer/resolve.ts:71-97`). Inactive clips early-return cheaply
  (`clipTime < 0 || clipTime >= duration` before any decode — `:142-145`, `:194-197`), so the walk
  is O(total nodes) of cheap checks, not O(active) — a ~137-node tree allocates ~137 promises/frame.
  Real but modest.
- The dominant cost is the **active** video node's `getFrameAt` decode (`resolve.ts:205-217`). During
  steady playback inside one clip the fast-path + prefetch keep it cheap
  (`video-cache/service.ts:56-61`, prefetch `:226-264`). **At a cut boundary** the source time jumps,
  the fast-path misses, and `seekToTime` does a deep seek into the long (32-min) source
  (`service.ts:190-224`). Dan's project is heavily cut, so playback crosses many boundaries → many
  deep seeks → many frame-budget overruns → the observed stutter. This is the current playback
  mechanism, distinct from the already-fixed KTD3 freeze.

### H5 — Scrub decode latency into a long source (symptom 1, scrub specifically)

**Likelihood: medium-high. Impact: medium. Confidence: medium.**

Scrubbing issues a new `seek({time})` every move; the preview loop then requests a frame at the new
source time. Fast scrubbing across a long, many-cut source is a stream of fast-path misses →
`seekToTime` deep seeks (`service.ts:190-224`), each slower than the pointer cadence. The
supersede-by-time logic keeps this correct (no freeze) but decode latency still lags the visual
behind the cursor, which reads as "scrub feels delayed". Less React, more decode — different remedy
from H1 (this one is decode-bound, not re-render-bound).

### H6 — 60 Hz `onUpdate` consumers during playback  (minor)

**Likelihood: medium. Impact: low. Confidence: high.**

`notifyUpdate` fires `updateListeners` every frame (`playback-manager.ts:256`). Consumers are the
timecode display and the bookmark overlay (`onUpdate(setCurrentTime)`), each doing a small state set
and re-render. Bounded and small (the `Timeline` memo + the imperative render loop keep it off the
clip tree). Note for correctness: this is NOT a whole-timeline 60 Hz re-render — worth stating so we
don't chase it as the playback cause.

### H7 — Waveform canvas redraw  (ruled OUT as a per-move cost)

**Likelihood: low. Impact: low. Confidence: high (first-hand).**

Waveforms are cached bitmaps with a `renderSignature` guard that early-returns when nothing visual
changed (`audio-waveform.tsx:157-181`), and they only redraw on their own dep changes / scroll /
resize (`:304-344`), **not** on drag or scrub of other clips. They are not a per-move bottleneck.
(One minor note: the signature is a `JSON.stringify` including the 200-sample gain array, paid only
on an actual redraw — negligible.) Keep this documented so waveforms are not a red herring.

---

## Top 3 (the headline)

1. **H1 — raw mousemove → forced re-render of the unmemoized 28-clip tree, each clip running the
   O(n) A/V-sync scan = O(n²) per pointer event.** Evidence:
   `element-interaction-controller.ts:471,572,720-721` (raw listener + notify) →
   `use-element-interaction.ts:80-81` (forced rerender) → `timeline-element.tsx:243,434` (unmemoized
   clip + unconditional badge) → `av-sync.ts:56-75` (all-tracks×all-elements scan).
2. **H4 — playback frame drops when per-frame decode/composite exceeds the budget under the single
   in-flight guard, driven by deep seeks at cut boundaries on a long source.** Evidence:
   `preview/components/index.tsx:199,217` (drop-if-busy guard) + `video-cache/service.ts:190-224`
   (deep seek path) + `renderer/resolve.ts:71-97` (whole-tree walk per frame).
3. **H2 — `computeAvSyncOffset` is uncached and O(total elements) per clip render** — the multiplier
   behind H1 and a standalone cost on every timeline re-render. Evidence: `av-sync.ts:41-87`,
   `timeline-element.tsx:434`.

---

## Proposed requirements (for the eventual fix plan — not implemented here)

- **R1 — Timeline drag/trim stays responsive on a 30-min, 28-clip project.** Dragging or trimming a
  clip sustains ≥ ~50 fps of visual feedback (no dropped-below-30fps stalls) with pointer input at
  ≥125 Hz. Concretely: per pointer-move work must stop being O(n²). Levers implied by H1/H2:
  coalesce mousemove to one update per animation frame; memoize `TimelineElement` so unrelated clips
  don't re-render; compute A/V-sync offsets once per tracks-change instead of per clip per render.
- **R2 — Playback holds frame rate on a long, heavily-cut timeline.** Preview sustains the project
  fps during play with no visible freeze at cut boundaries, measured on Dan's 32:19 source. Levers
  implied by H4/H5: keep decode off the critical frame path (prefetch across the next cut boundary),
  and/or cap per-frame work so a slow seek degrades gracefully instead of dropping the tick.
- **R3 — Scrubbing tracks the cursor.** Playhead scrub updates the preview within ~1 frame of the
  cursor on the same project (H5), and the per-move snap scan (H3) does not dominate.
- **R4 — No correctness regressions.** The A/V-sync badge still shows the right offset; snapping,
  linked-selection drag, ripple-insert, and the KTD3 seek fix all keep working. Waveforms remain
  cached (do not reintroduce per-move redraw).
- **R5 — Fixes are JS-side only.** No dependence on rebuilding `opencut-wasm`; wasm internals stay
  out of scope.

(Deliberately no target numbers beyond "no sub-30fps stalls" until Phase B gives a baseline — the
measurements below set the real bar.)

---

## Phase B — cheapest measurements to discriminate the hypotheses (Dan runs in Chrome)

All of these are executable via CDP JavaScript / DevTools with no code changes. `window.__vibeEditor`
exposes `EditorCore` in dev (per `PATCHES.md:110`) for imperative probing.

1. **Pointer-event vs paint rate during a drag (tests H1's "no coalescing").**
   Paste in the console, then drag a clip for ~3 s:
   ```js
   let mm = 0, raf = 0; const t0 = performance.now();
   const onMM = () => mm++; const loop = () => { raf++; requestAnimationFrame(loop); };
   document.addEventListener('mousemove', onMM, true); requestAnimationFrame(loop);
   setTimeout(() => { document.removeEventListener('mousemove', onMM, true);
     const s = (performance.now()-t0)/1000;
     console.log('mousemove/s', (mm/s).toFixed(0), 'rAF/s', (raf/s).toFixed(0)); }, 3000);
   ```
   **Read:** if mousemove/s ≫ rAF/s (e.g. 200+ vs ~60), each surplus event is a wasted full
   re-render → confirms H1 and that rAF-coalescing is the cheap win.

2. **React commit count + which components render during a drag (tests H1 fan-out).**
   React DevTools → Profiler → record → drag a clip ~2 s → stop. **Read:** commit count should be
   ~1 per pointer event; the flame should show `TimelineElement` × ~28 (and `AvSyncBadge`) committing
   each time. If so, H1 is confirmed and memoizing `TimelineElement` is the lever.

3. **`computeAvSyncOffset` self-time (tests H2).**
   DevTools → Performance → record a ~2 s drag → stop → Bottom-Up, filter "avSync"/"computeAvSyncOffset"
   (or "resolveDropTarget"/"snapGroupEdges"). **Read:** high aggregate self-time for
   `computeAvSyncOffset` confirms H2 as the O(n²) multiplier. Compare against `computeDropTarget` /
   snap functions to rank the in-handler O(n) costs (H3).

4. **Playback frame pacing + long tasks (tests H4).**
   Before pressing play, install a longtask observer and a frame-delta logger:
   ```js
   new PerformanceObserver(l => l.getEntries().forEach(e =>
     console.log('longtask', e.duration.toFixed(1), 'ms'))).observe({entryTypes:['longtask']});
   let last = performance.now();
   (function tick(){ const n = performance.now(); const d = n-last; last = n;
     if (d > 24) console.log('slow frame', d.toFixed(1), 'ms'); requestAnimationFrame(tick); })();
   ```
   Play across a section with many cuts. **Read:** clusters of "slow frame" / longtask entries at cut
   boundaries confirm H4 (decode overrun dropping ticks). Also record a Performance profile and look
   at bottom-up self-time for `render` / `resolveNode` / `getFrameAt` / `seekToTime`.

5. **Cut-boundary decode isolation (separates H4/H5 from render fan-out).**
   In the Performance profile from (4), scrub/play once inside a single long clip (no boundary
   crossings), then across many cuts. **Read:** if slow frames appear almost only when crossing
   boundaries, the cost is the deep `seekToTime` (H4/H5), not the per-frame tree walk — which points
   the fix at prefetch-across-boundary rather than at React.

6. **Snapping A/B (tests H3, near-zero effort).**
   Toggle snapping off in the timeline UI (or `window.__vibeEditor` timeline store) and repeat a trim
   and a scrub. **Read:** if trim/scrub noticeably smooths with snapping off, H3 is a real
   contributor and the snap-point scan should be cached/narrowed.

Recommended order: 1 → 2 → 3 (nails symptom 1) then 4 → 5 (nails symptom 2); 6 is a 20-second sanity
A/B any time.

**Confidence that Phase B will discriminate:** high for symptom 1 — measurements 1–3 directly expose
the re-render fan-out and the O(n²) scan, and each maps to a distinct fix, so they will confirm or
kill H1/H2/H3 cleanly. Medium-high for symptom 2 — measurements 4–5 will tell decode-overrun (H4/H5)
apart from render-tree walk, but attributing time *inside* the wgpu composite is limited because the
wasm is not locally instrumentable (out of scope); we can still see JS-side seek/decode self-time and
frame pacing, which is enough to choose the fix direction.

---

## Open questions

- **OQ1 — Is a high-poll mouse in play?** H1's severity scales with pointer rate. Measurement 1
  answers it and sets how much rAF-coalescing alone buys.
- **OQ2 — Badge value: recompute-per-tracks-change vs memoize-per-clip.** Both kill H2's O(n²). A
  single O(n) pass keyed by `linkId` at tracks-change is the more complete fix (also helps
  non-drag re-renders); component memoization is smaller but leaves the per-tracks-change O(n²).
  Decide when planning.
- **OQ3 — Playback fix altitude.** Prefetch across the next cut boundary (keep decode off the
  critical path) vs. cap per-frame work so a slow seek degrades to holding the last frame rather than
  dropping ticks. Measurement 5 informs which.
- **OQ4 — Does the out-of-sync project state (the `-108f/+109f` badges) interact with the lag?** The
  badge path is H2 (a cost), but the *drift itself* is orthogonal. Worth confirming in Phase B that a
  clean (in-sync) project of the same size lags the same amount — if it does, drift is not a factor.
- **OQ5 — Baseline target.** Pick R1/R2 fps numbers after measurement 4 gives the current baseline,
  rather than guessing now.
</content>
</invoke>
