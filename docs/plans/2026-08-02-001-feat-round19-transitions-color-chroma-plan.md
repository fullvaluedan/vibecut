# Round 19 plan: transitions, color adjust, chroma key, dormant surfaces

Date: 2026-08-02. Author: Fable (planning only). Parent: roadmap 2026-08-01-001 section 8.
Research base: two 2026-08-02 reports (renderer/effects pipeline terrain map; dormant
surfaces audit). Facts below cite them, not guesses.

## 0. What the research settled

1. Preview and export share ONE render path (CanvasRenderer -> frame descriptors ->
   Rust/wgpu compositor). All pixel work is GPU. There is NO JS-side shader path.
2. The single hardest constraint: `rust/crates/effects/src/pipeline.rs`
   `pack_effect_uniforms` (lines ~265-290) is HARD-CODED to blur's three uniforms and
   errors on any other uniform name; the uniform buffer has only 4 scalar slots. Any
   new shader (color adjust, chroma key, new effects) requires generalizing this and
   rebuilding wasm. The Rust/wasm toolchain IS installed and the build scripts exist
   (`bun run build:wasm`, local-link loop documented in rust/wasm/README.md); the
   masks/types.ts comment claiming "no toolchain" is stale.
3. Color adjust as an EFFECT reuses ~everything on the TS side (params UI, keyframes,
   commands, thumbnails): one definition file + one registry line. Clip-level fields
   would reuse ~nothing. Effect route chosen.
4. Chroma key is architecturally an EFFECT (reads the layer's own pixels), not a mask.
   Its wildcard is the eyedropper: no pixel-readback path from the preview exists
   (capture-frame.ts is the closest candidate).
5. Transitions are mostly a TIMELINE project: two overlapping clips already blend
   correctly in the renderer with zero new plumbing (flat layer items, per-layer
   opacity). What blocks them: the model forbids same-track overlap
   (placement/overlap.ts), and the video cache has ONE sink per mediaId - two clips
   cut from the same file seeking two times per frame will thrash (the
   boundary-prefetch ~600ms stall class). Dissolve-family needs NO Rust; wipes/slides
   need a two-input shader (deferred).
6. Dormant surfaces: Sounds is 2 small bugs + a missing Freesound key away from
   shippable; the effects browser is healthy but pointless with one effect; stickers
   should be PRUNED (~700 dead lines) not revived - its resolver half is load-bearing
   for export of legacy projects; caption styles are live and adding looks is ~10 min
   each (stroke/shadow params are untapped).
7. `MASK_EXPANSION_OPACITY_RENDERED = false` is a ready-made canary for the wasm
   rebuild workflow: both fields already plumbed JS-side; the Rust LayerMaskDescriptor
   just lacks them.

## 1. Standing decisions (agents do not relitigate)

1. Task order: T19.0 (wasm foundation) is the critical path; T19.1/T19.2/T19.4b build
   on it. T19.3 (transitions) and T19.4a (surfaces) are independent and run parallel.
2. Wasm distribution: opencut-wasm is OUR package. Dev uses the documented local-link
   loop; landing a round bumps the package version and publishes, then apps/web pins
   the new exact version. The publish step is Dan-gated (needs his npm auth) - the
   plan treats "local-link works + version bumped + publish checklist written" as the
   in-repo done state.
3. Color adjust ships as ONE effect ("Adjust") with 9 params (brightness, contrast,
   saturation, exposure, temperature, tint, highlights, shadows, sharpen) in ONE
   shader pass, with a neutral early-out returning zero passes. Filter presets are
   param bundles on the same effect.
4. Transitions v1 = dissolve family only: cross dissolve, dip to black, dip to white,
   fade (from/to nothing). Modeled as a TRANSITION ENTITY attached to a main-track
   join (not free overlap): the timeline model stays overlap-free; the renderer
   synthesizes the overlap by extending both neighbors' sampling windows during the
   transition span. Wipes/slides deferred to a two-input-shader follow-up.
5. Stickers: partial prune (dead browse/search API, logos stub, shapes duplicate);
   keep resolver/registry/flags-data spine (export of legacy projects depends on it).
   The 254-flag browser is NOT revived unless Dan asks.
6. Sounds: fix the two bugs, unhide with a friendly no-key empty state on the
   Freesound sub-tab; Music&SFX (HeyGen) and Saved work without it. Dan's Freesound
   key is a 2-minute follow-up, not a blocker.
7. Effects browser unhides ONLY in T19.4b when the registry holds >= 5 effects
   (blur + adjust + pixelate + vignette + glow; noise/shake if cheap).
8. Crop keyframes: still Dan's open decision; NOT in this round unless he says build.

## 2. Tasks

Gates for every task: the standard set (G1 bun test apps/web at the stated baseline+,
hf-bridge 210+, G2 tsc from apps/web, G3 new tests, marker-grep, no em dashes,
PATCHES.md same-commit rows for upstream-originated files, worktree base VERIFIED by
test count before starting). Round closes with T19.5's G4 browser pass + G6 ratings.

### T19.0 Wasm effects foundation (CRITICAL PATH)
Agent: **Opus**. Size: L (1-2 days). Worktree: yes.

1. Generalize `pack_effect_uniforms` to a per-shader uniform schema (each registered
   shader declares its uniform layout; unknown shader or uniform still errors
   loudly). Widen the uniform buffer to fit >= 12 scalars + 2 vec2 + 1 vec4 color
   (room for adjust + chroma), keeping alignment correct.
2. Blur must be regression-proof: same visual output byte-for-byte (or within float
   tolerance) - add a Rust-side test if the crate has a test harness, else a JS-side
   golden test through the thumbnail path.
3. Flip the canary: add `expansion` + `opacity` to the Rust LayerMaskDescriptor,
   implement them in the mask shader path, flip MASK_EXPANSION_OPACITY_RENDERED to
   true (JS plumbing already exists). This proves the end-to-end rebuild.
4. Build + local-link: `bun run build:wasm`, link into apps/web per
   rust/wasm/README.md; document every deviation found. Bump the crate/package
   version; write the publish checklist (docs/plans/ appendix or PATCHES note).
5. Effects pipeline hygiene while in there: an early-out skipping the pre-chain
   copy_texture when a layer's pass list is empty (the research flagged the
   all-defaults blit cost).

Tests: uniform-schema packing (per-shader accept/reject), blur golden, mask
expansion/opacity render (the two long-parked fields), JS mask tests un-skip if any
were gated. NOTE: wasm build output (rust/wasm/pkg) handling: follow whatever the
repo's gitignore does today; do not commit build artifacts unless the repo already
does.

### T19.1 Color adjust effect + filter presets
Agent: **Sonnet**. Size: M (after T19.0; branches from its worktree branch). 

1. `rust/crates/effects/src/shaders/color_adjust.wgsl`: one pass, ordered ops
   (exposure -> temperature/tint -> contrast -> highlights/shadows -> saturation ->
   brightness; sharpen as a cheap 5-tap unsharp within the same pass or a second
   pass only when sharpen > 0). Register in pipeline.rs with its uniform schema.
2. TS: `effects/definitions/color-adjust.ts` (9 params, sensible ranges, all
   keyframable via the existing generic path; neutral early-out returns []), one
   line in definitions/index.ts. Zero new UI components (the effects tab renders
   declared params).
3. Filter presets: a preset strip in the clip Effects tab when the Adjust effect is
   selected (or an "Adjust" quick-add with preset thumbnails): 8-10 bundles (e.g.
   Vivid, Film, Mono, Warm, Cool, Fade, Punch, Golden). Thumbnails via the existing
   effect-preview service with per-preset params.
4. Renderer-parity test through the export path fixture (same class as the T18.2
   renderer-sync test).

### T19.2 Chroma key effect + eyedropper
Agent: **Opus**. Size: M-L (after T19.0; parallel with T19.1 once the schema API is
merged - coordinate on pipeline.rs via rebase order T19.1 then T19.2).

1. `chroma_key.wgsl`: key color (vec3), similarity, smoothness, spill suppression,
   shadow preservation; standard YCbCr-distance keying. Registered with its schema.
2. TS definition `effects/definitions/chroma-key.ts` under the Effects system; ALSO
   surface it as a "Cutout" affordance: a small "Chroma key" section entry in the
   video inspector that adds/edits the effect (CapCut parity naming), implemented as
   a thin wrapper over the effect commands - no parallel state.
3. EYEDROPPER (the wildcard): investigate services/renderer/capture-frame.ts as the
   readback path (it captures the exact rendered frame for freeze). Approach: on
   "pick color", capture the current frame at preview resolution, open a magnifier
   overlay on the preview, sample pixels from the captured bitmap (not the live
   canvas). If capture-frame cannot serve, fall back to sampling the DECODED source
   frame (pre-effects) via videoCache.getFrameAt - document which shipped and why.
   Escape cancels; the picked color lands in the effect's color param.
4. Tests: key math on synthetic fixtures (green square on gray: keyed alpha correct,
   spill suppressed), eyedropper sample math, inspector wrapper commands.

### T19.3 Transitions v1 (dissolve family)
Agent: **Opus**. Size: L-XL (independent of T19.0; timeline-heavy). Worktree: yes.

1. MODEL: `TransitionSpec { id, kind: "crossDissolve"|"dipToBlack"|"dipToWhite"|
   "fade", durationSec }` attached to a main-track JOIN (stored on the right
   neighbor's element or a track-level map keyed by boundary - agent decides after
   reading serialization; must survive split/trim/move with sensible rules: a
   transition dies when its join dies; duration clamps to min(neighbor halves'
   source headroom for crossDissolve)).
2. RENDERER: scene-builder emits, during the transition window, BOTH neighbors with
   extended sampling windows (left clip samples past its out-point into trimmed-away
   source; right clip before its in-point - clamped by real source, falling back to
   edge-hold frames when no headroom) plus per-layer opacity ramps; dip variants
   insert a color layer ramping over the cut instead of overlapping sources. No Rust.
3. VIDEO CACHE: fix the single-sink-per-mediaId thrash for two concurrent readers of
   one file (research: service.ts sinks map + supersede rule; boundary-prefetch
   ~600ms stall class). Approach options (agent proves one): per-consumer sink keying
   (mediaId+elementId) with a shared decode budget, or a transition-scoped second
   sink. Must include a perf check with __renderPerf across a crossfade between two
   clips split from one file.
4. UI: hovering a main-track join shows a small transition chip; clicking opens a
   mini-picker (the 4 kinds + duration 0.25/0.5/1.0/custom); applied joins render a
   visible bracket over the two clip ends. Right-click to remove. One undo per
   apply/remove/duration change.
5. EXPORT parity + av-sync: linked separated audio does NOT crossfade in v1 (audio
   keeps the hard cut; audio crossfade = follow-up with the fade machinery from
   T18.3) - document in tooltip.
6. Tests: model survive/die rules across split/trim/move/ripple/magnet; sampling
   window math incl. no-headroom edge-hold; opacity ramp values at boundary frames;
   cache concurrency unit test; serialization round-trip + old-project load.

### T19.4a Dormant surfaces: sounds fix+unhide, stickers prune, caption looks
Agent: **Sonnet** (sounds + stickers), **Haiku** (caption looks, separate worktree).
Size: M total. Independent; runs parallel with everything.

Sounds (audit's exact findings):
1. Fix use-sound-search.ts loadMore positional-args bug (TypeError on every "load
   more"); fix the commercial_only no-op chain (route ignores it; initial fetch
   never sends it; z.coerce.boolean mangles "false").
2. Friendly no-key state on the Freesound sub-tab ("Add a free Freesound API key in
   .env.local to enable sound search" with the console link); Music&SFX + Saved work
   regardless. Audio preview cleanup on unmount (the bare new Audio() leak).
3. Unhide: remove "sounds" from HIDDEN_ASSET_TABS + update surface-flags.test.ts in
   the same commit. Run the audit's 12-point QA list (the key-dependent points go to
   the Dan-owed list until his Freesound key lands).

Stickers prune (audit's map): delete index.ts browse/search API, categories.ts,
providers/logos.ts, providers/shapes.ts, the browse/search half of flags.ts; keep
resolver.ts, registry.ts, sticker-id.ts, intrinsic-size.ts, types.ts,
countries-data.ts + buildFlagUrl, providers/index.ts (trimmed). Re-point
timeline-element.tsx and sticker-node.ts imports if they touch the barrel. Legacy
projects with sticker elements must still render + export (test with a fixture).

Caption looks (Haiku): add 6 new looks to CAPTION_STYLES using the untapped
stroke/shadow headroom (e.g. Outline Pop, Drop Shadow, Broadcast, Minimal Mono,
Highlighter 2, Cinema Bar). Rules from the audit: every look sets everything it
controls (merge-not-reset bleed), keep the grid count even, only registered text
param keys. QA: apply each to a 10-caption timeline, undo, export one frame.

### T19.4b Effects registry expansion + unhide effects tab
Agent: **Sonnet**. Size: M (after T19.0 merges; each effect ~2-4h per research).
Pixelate, vignette, glow, plus noise and shake if the schema makes them cheap
(shake may be a transform-jitter pass - if it does not fit the effect model
cleanly, drop it and say so). Each: wgsl + pipeline entry + TS definition + params
+ preview-tile sanity. Unhide the effects tab (flag + test) once >= 5 effects
render distinct live preview tiles; verify the no-WebGPU graceful path.

### T19.5 Round verification + G6 rating
Agent: **Sonnet**, after everything merges. The usual: regression gates, browser
pass over every feature (transition picker on real joins incl. same-source
crossfade perf, adjust params + presets on light/dark footage, chroma key on a
green-screen fixture generated via ffmpeg testsrc overlay, sounds tab all three
sub-tabs, caption looks, mask expansion/opacity now rendering), docs updates,
9/10 scores with evidence; under 9 reopens.

## 3. Sequencing and parallelism

Wave 1 (now): T19.0 (Opus), T19.3 (Opus), T19.4a sounds+stickers (Sonnet),
T19.4a captions (Haiku). Four worktrees, disjoint files.
Wave 2 (T19.0 merged): T19.1 (Sonnet) then T19.2 (Opus) - both touch pipeline.rs,
so serial merge order 19.1 -> 19.2; T19.4b (Sonnet) after 19.1's schema pattern
exists. T19.3 merges whenever ready (no overlap).
Wave 3: T19.5 verification + G6.

Estimate: ~5-7 agent-days wall-clock with the above parallelism.

## 4. Dan-owed / open

1. Freesound API key (free, 2 min) -> unlocks the sound-effects sub-tab.
2. Anthropic key -> unlocks the live prompt-to-edit assistant (carried from R17).
3. Crop keyframes decision (carried; defer recommended).
4. npm publish of the bumped opencut-wasm when the round lands (needs his auth);
   until then dev runs on the local link.
5. Ratify the same-lane ripple decision from his chip session (memory:
   t18-1-same-lane-ripple-decision; that session's fix is unmerged and flagged a
   main-merge test breakage - NOT touched by this round).

## 5. T19.5 verification status (2026-08-02, tip 21ae6e59)

Gates: apps/web `bun test` 2690 pass / 0 fail. hf-bridge `bun test` 210 pass / 0
fail. `bunx tsc --noEmit` from apps/web: 0 errors. `wasm-pack test --node
rust/crates/effects`: 21 pass / 0 fail. All four PASS.

Per-task status (evidence and repro steps in docs/TO-VERIFY.md, Round 19 section):

- T19.0 wasm effects foundation: **REOPENED**. The Rust work is correct and the
  mask expansion/opacity canary renders end to end once the local build is
  actually loaded. It is not loaded as merged: `apps/web/node_modules/opencut-wasm`
  is a real directory holding the published 0.2.10, so it shadows the root
  `bun link` the README tells you to make, and both package.json files still pin
  `^0.2.10`. Result on a clean checkout: every T19.1/T19.2/T19.4b shader throws
  at runtime and adding an Adjust effect breaks the preview. Scores 6 / 7.
- T19.1 color adjust effect + filter presets: **PASS**, 9 / 9.
- T19.2 chroma key effect + eyedropper: **PASS with one minor defect** (Escape
  cancels the pick and also deselects the clip). Scores 9 / 8.
- T19.3 transitions v1: **REOPENED**. Everything in the spec works, including
  same-source crossfade smoothness and export parity, but a cross dissolve
  composites both neighbours with ramped opacity, so the blend loses about 25
  percent of its luminance at the midpoint. Scores 8 / 7.
- T19.4a sounds: **PASS**, 9 / 8 (one pre-existing robustness note on the
  rate-limit call in the sounds route).
- T19.4a stickers prune + caption looks: **REOPENED**. The prune is clean, but
  the 6 original caption looks were never updated to reset the stroke, shadow
  and letterSpacing params the 6 new looks introduce, so styles bleed in both
  directions, including through "Plain". Scores 8 / 6.
- T19.4b effects registry expansion + unhide: **REOPENED**. All four effects
  render, scrub and keyframe correctly, but 6 of the 7 browser tiles are
  pixel-identical to the unprocessed source because the tile renders with empty
  params and every effect except blur is neutral at its defaults. The stated
  unhide criterion (at least 5 effects rendering distinct live tiles) is not met.
  Scores 9 / 6.

Round 19 is NOT done. Four tasks reopen: T19.0, T19.3, T19.4a captions, T19.4b.
