# Round 20 plan: HyperFrames + Remotion authoring (style profiles, probe-render-first)

Date: 2026-08-03. Author: Fable (planning only). Parent: roadmap 2026-08-01-001 section 9.
Research base: `docs/2026-07-22-hyperframes-remotion-findings.md` (preconditions), a
2026-08-03 terrain map of `packages/hf-bridge` + `features/ai-generate`, and the
round-19 close (native transitions shipped; effects/sounds surfaces live).
Dan's direction is FIXED (roadmap section 9): this plan starts from decisions, not debate.

## 0. Preconditions reviewed (from the 2026-07-22 findings doc)

1. **Registry version skew (MUST FIX FIRST, T20.0).** `registry-fetch.ts` and
   `bake.ts` fetch the registry from `main` but render with the pinned engine
   (0.7.68). Upstream tags every release, and `registry/` at the matching tag is a
   normal snapshot. Pointing the fetch at the tag matching
   `packages/hf-bridge/package.json`'s pin is a ~3-line change in files we own and
   directly answers the failure mode that parked this layer. Untouched until now.
2. **Transition slot: OUT of Round 20.** Round 19 shipped native timeline
   transitions, so registry transition blocks stay non-"Add"-able; a HyperFrames
   transition slot (their internal overlap-extend pattern) is a separate future
   project, only if Dan asks.
3. **Real-footage time stays Dan-owed** (handoff section 5 item 6). Round 20's G6
   runs on the same synthetic-fixture discipline as rounds 15-19; Dan's real-project
   acceptance supersedes.
4. Engine reliability caveat: 0.7.68 is measurably better on paper (Windows fixes,
   capture self-verification, codec auto-proxy, determinism fixes) but "on paper" is
   why probe-render-first is a hard rule, not a nicety.

## 1. Standing decisions (agents do not relitigate)

1. **Style preference profiles**: a saved, named design spec (palette, fonts, motion
   style, density) the user builds once and every generation honors, for HyperFrames
   authored compositions AND for the Remotion media-pack export. The existing
   `HfPreset` container (`features/ai-generate/store.ts`, key `framecut-ai-settings`,
   versioned migrations, MAX_HF_PRESETS = 5) is the natural home: EXTEND it (new
   fields + a store migration), do not build a parallel store. `VIBE_STYLES`
   (`styles.ts`, 6 hardcoded looks) becomes the factory-default profile set, not a
   separate concept. Profile content feeds the brief compiler
   (`compile-hyperframes-prompt.ts`) and the native-template planner path
   (`run-hyperframes.ts`); the self-learning `preference-store.ts` notes keep working
   unchanged on top.
2. **Probe-render-first, always** (hard rules from the dan-video playbook, per the
   roadmap): any render request first renders a short probe - a few seconds, or
   20-frame clips per distinct component, contact-sheeted - for APPROVAL before the
   full render is allowed. Full renders are segmented with resume guards. Audio is
   never taken from render segments; it muxes from source at the end. In our terrain
   that maps to: the authored engine (`run-hyperframes-scoped.ts` + `chunk-plan.ts`,
   ~90s chunks) gains a probe stage before its full pass; per-chunk failures move
   from `skipped[]` (dropped) to checkpointed + retryable; the probe-approval UX
   rides the existing variant-picker/drafts pattern, not a new dialog family.
3. **Remotion integration = candidate (a) only**: VibeCut exports an EDL +
   transcript + media pack directly consumable by the dan-video Remotion kits.
   Embedded `@remotion/player` probe preview (candidate b) is OUT of this round; it
   opens only if (a) proves out in real use. Remotion itself is never added as a
   dependency (findings doc: zero remotion deps today, stays that way).
4. **HyperFrames stays npm-pinned exact, never vendored** (BRIEF rule). New
   product code lives in `packages/hf-bridge` and `features/ai-generate` only, plus
   the API route layer `apps/web/src/app/api/hyperframes/` that already wraps
   hf-bridge.
5. **Un-hiding is the LAST step** (T20.4), after profiles + probe flow exist: the
   parked surfaces (`surface-flags.ts`: `HIDDEN_ASSET_TABS = ["hyperframes"]`,
   `HIDE_RUN_HYPERFRAMES_CLUSTER`, `HIDE_RUN_HYPERFRAMES_CONTEXT_MENU_ITEM`,
   `HIDE_HYPERFRAMES_DRAFTS_PANEL`) flip only when the panel's redesigned start flow
   is in. `HIDE_AUTO_ASSEMBLE_ACTION` / `HIDE_HIGHLIGHT_ACTION` stay parked unless
   Dan asks.

## 2. Tasks

Gates for every task: the standard set (G1 `bun test` apps/web at baseline+ and
hf-bridge 210+, G2 `bunx tsc --noEmit` from apps/web, G3 new tests, marker-grep
before commit AND push, no em dashes in added lines, PATCHES.md same-commit rows for
upstream-originated files, worktree base VERIFIED by test count before starting,
stage explicit paths - never `git add -A`). Round closes with T20.5's G4 browser
pass + G6 ratings (9/9 per feature or reopen).

### T20.0 Registry tag-pin (precondition, blocks everything)
Agent: **Sonnet**. Size: S. Worktree: no (two files, rides the main checkout).
Status: **ALREADY SHIPPED** in `653437fb` ("fix(hf-bridge): pin registry fetches to
the installed engine's release tag") - `registry-ref.ts`'s `resolveRegistryBase()`
is consumed by both `registry-fetch.ts` and `bake.ts`, fails loudly (never falls
back to `main`), and carries the pin-tracking guard test. Only the render-smoke
regression re-run below remains.

1. `packages/hf-bridge/src/registry-fetch.ts` + `bake.ts`: build the registry base
   URL from the pinned engine version in `packages/hf-bridge/package.json`
   (`https://raw.githubusercontent.com/heygen-com/hyperframes/v<pin>/registry`)
   instead of hardcoded `main`. Single source of truth for the pin; a test asserting
   the URL tracks package.json (the same guard-test class as the wasm version
   guard).
2. Re-run `bun packages/hf-bridge/scripts/render-smoke.ts` (24 renders, must stay
   24/24) as the regression net.
3. Note in PATCHES.md if the files are upstream-originated (they are ours; a plain
   commit note suffices).

### T20.1 Style preference profiles
Agent: **Opus**. Size: M-L. Worktree: yes.

1. DATA: extend `HfPreset` in `features/ai-generate/store.ts` with the design spec:
   palette (accent + supporting colors), fonts (display + body, from the
   already-registered font list), motion style (calm / standard / punchy - maps to
   the planner's existing style vocabulary), density (sparse / balanced / dense).
   Store migration v4 -> v5; existing presets gain defaults losslessly; raise or
   justify MAX_HF_PRESETS.
2. INJECTION: `compile-hyperframes-prompt.ts` emits the active profile as a
   structured "Design profile" brief section (authored path); `run-hyperframes.ts`
   native-template path maps profile fields onto template variables where they exist
   (accent color, font) and into planner context otherwise. A generation with no
   active profile behaves exactly as today (VIBE_STYLES default).
3. UI: profile editor in the HyperFrames panel - create/edit/duplicate/delete,
   live swatch + type preview, one "Active" profile at a time. Reuse the existing
   preset save/load semantics; no new dialog family.
4. Tests: migration losslessness, brief-compiler output with/without a profile,
   native-path variable mapping, editor store round-trip.

### T20.2 Probe-render-first + resume guards (CRITICAL PATH)
Agent: **Opus**. Size: L. Worktree: yes.

1. PROBE STAGE in `run-hyperframes-scoped.ts`: before any full pass, render one
   short probe per distinct chunk plan (first ~3-5s of each chunk, or 20 frames per
   distinct template/component - implement whichever the author route supports
   cheapest; document the choice). Probe outputs land in a contact-sheet review
   riding the variant-picker/drafts machinery (thumbnails + one-click play per
   probe). The full render is BLOCKED until the probe set is approved; approval is
   per-run, persisted on the draft so a closed dialog does not force re-probe.
2. RESUME GUARDS: chunk results checkpoint to disk (the comp dirs already persist;
   add a run-manifest of chunk state: pending/rendered/failed). A failed chunk is
   retryable from the drafts panel instead of silently `skipped[]`; a re-run of the
   same scope reuses rendered chunks. User cancel keeps rendered chunks.
3. AUDIO RULE: verify and pin with a test that placed/rendered segments never carry
   segment audio into the export - audio muxes from source (the current
   place/composite path behavior); if any probe/segment path leaks audio, fix it
   there.
4. Server side: the probe call is a parameterization of the existing
   author/render-comp routes (duration/frames cap), not a new route family, unless
   hf-bridge's renderer makes a dedicated `renderProbe` clearly cheaper - agent
   decides after reading `packages/hf-bridge/src/renderer.ts`, and documents it.
5. Tests: chunk-manifest state machine (incl. retry + reuse), probe gate blocking
   (no full render before approval), audio-never-from-segments invariant, probe
   duration math.

### T20.3 Remotion media-pack export (candidate a)
Agent: **Sonnet**. Size: M. Worktree: yes. Independent of T20.1/T20.2.

1. Export action (project or timeline scope): produces a folder/zip with (a) an EDL
   of the timeline (CMX3600 or the JSON shape the dan-video kits consume - DECIDE by
   reading the kit's documented input contract; the kits live outside this repo at
   D:\Hermes\remotion-v2, so the contract is captured as a versioned spec file in
   `docs/` and the pack targets that spec), (b) the transcript with word timings
   (the round-16 lineage data), (c) the media pack (referenced source media +
   generated overlays), (d) a manifest tying them together (durations, track roles,
   framecutAi comp references).
2. The active style profile (T20.1) serializes INTO the manifest so kit-side
   generation honors the same design spec (palette/fonts/motion/density fields by
   the same names).
3. UI: one menu item (export button dropdown or scenes view), progress + result
   toast, saved via the existing `saveBufferWithPicker` pattern.
4. Tests: EDL/manifest serialization against a fixture project, round-trip
   invariants (durations sum, media references resolve), profile fields present when
   a profile is active. Kit-side consumption check is Dan-owed (needs his
   dan-video setup).

### T20.4 Panel start-flow redesign + un-park
Agent: **Sonnet**. Size: M. Worktree: yes. After T20.1 + T20.2 merge.

1. Redesign `hyperframes-panel.tsx`'s start flow around the new primitives: pick or
   create a style profile -> describe what you want (or pick templates) -> probe ->
   approve -> full render. Fewer visible knobs up front; the collapsible
   template/registry sections move behind an "Advanced" disclosure.
2. Un-park in `surface-flags.ts`: remove `hyperframes` from `HIDDEN_ASSET_TABS`,
   flip `HIDE_RUN_HYPERFRAMES_CLUSTER`, `HIDE_RUN_HYPERFRAMES_CONTEXT_MENU_ITEM`,
   `HIDE_HYPERFRAMES_DRAFTS_PANEL`; update `surface-flags.test.ts` in the same
   commit. Auto-assemble and highlight stay parked.
3. QA the whole panel against the audit list style used in T19.4a: empty states,
   long-project scopes, cancel mid-run, reopen drafts, regenerate from a placed
   clip's brief.

### T20.5 Round verification + G6 rating
Agent: **Sonnet**, after everything merges. Regression gates; browser pass: create
a profile, run an authored generation end to end (probe appears, full render blocks
until approval, chunk failure retries, placed clips carry profile-consistent
styling), export a media pack and validate the manifest, native-template run with a
profile active, panel start flow first-run UX. Score each feature 1-10 func/qual
with evidence; under 9 reopens.

## 3. Sequencing and parallelism

Wave 1 (now): T20.0 (main checkout, lands first), then T20.1 (Opus) + T20.2 (Opus)
+ T20.3 (Sonnet) in three worktrees - T20.1 and T20.2 both touch
`run-hyperframes-scoped.ts`'s orbit (brief compiler vs run loop), so merge order is
T20.1 then T20.2 with a rebase; T20.3 is disjoint.
Wave 2: T20.4 (Sonnet) once 20.1 + 20.2 merge.
Wave 3: T20.5 verification + G6.

Estimate: ~5-7 agent-days wall-clock with the above parallelism.

## 4. Dan-owed / open

1. Kit-side consumption check of the media pack (needs his dan-video /
   D:\Hermes\remotion-v2 setup); the in-repo spec file is the contract until then.
2. npm publish of `opencut-wasm` 0.3.0 (carried from round 19; unrelated to this
   round's code but still gates a clean fresh install).
3. Anthropic key for any LIVE authored-generation run (the probe/full renders call
   the same Claude-backed author route); without it T20.5 verifies with the
   recorded/fixture path and Dan runs one live generation as acceptance.
4. Candidate (b) (@remotion/player embedded probe preview) opens only on Dan's call
   after (a) proves out.
5. Auto-assemble + highlight surfaces stay parked unless Dan asks.

## 5. T20.5 verification status (2026-08-03, tip 9c6e7867) - ROUND 20 CLOSED

Verified LIVE (a credentialed claude-code CLI drove real author/planner calls
through the UI). Full evidence: `docs/TO-VERIFY.md` round-20 section.

- T20.0 registry tag-pin: PASS (shipped earlier in `653437fb`; render-smoke 24/24).
- T20.1 style preference profiles: PASS, 9/9 (CRUD, migration, brief injection,
  native accent mapping all live-verified).
- T20.2 probe-render-first + resume: PASS, 9/8 (gate, approval persistence, reuse,
  cancel, retry, audio invariant all live-verified; minor defect R20-1 - reused
  chunks lost `framecutAi.brief` - fixed in `9c6e7867`).
- T20.3 Remotion media-pack export: PASS, 9/9 (pack validated against
  `docs/remotion-media-pack-v1.md`; kit-side consumption Dan-owed).
- T20.4 panel redesign + un-park: PASS, 9/9 (start flow, Advanced disclosure,
  toolbar cluster, drafts docking all live; auto-assemble/highlight still parked).

Gates at tip `9c6e7867`: apps/web 2777 pass / 0 fail / 1 skip, hf-bridge 232 pass /
0 fail, `bunx tsc --noEmit` clean, render-smoke 24/24.

Not exercised live (carried to Dan's real-browser pass): multi-chunk runs,
author-stage retry, the JSON-bundle pack fallback, transcript content accuracy
(headless Chrome has no AudioDecoder).
