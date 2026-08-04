# VibeCut handoff, 2026-08-04 (ROUNDS 19 + 20 CLOSED 9/9; T21.2 SHIPPED; T21.3-T21.7 PLAN READY; next: Dan's approval + pricing knobs)

Updated at the end of the 2026-08-03 session: round 19's four G6 reopens plus the
R19-7 follow-up hole were fixed and re-verified live, round 20 (HyperFrames +
Remotion authoring) was planned, built, merged, and verified LIVE (a credentialed
claude-code CLI drove real author/planner calls through the UI), and T21.2 (LLM
provider abstraction) is merged. Rounds 19 and 20 close at 9/9 across every
feature. Evidence: `docs/TO-VERIFY.md` (round-19 re-verification + round-20
sections).

Branch: `feat/director-eval`, tip `ca3998b0` (the T21.2 merge), pushed. Working
tree clean apart from the untracked local-only `.claude/` and `bunfig.toml`.

## 1. Read these first, in this order

1. `docs/plans/2026-08-01-001-feat-capcut-parity-roadmap.md` - the master roadmap
   (rounds 15-21, Dan's directives, the G6 9/10 gate, the credit-system pricing plan).
2. `docs/plans/2026-08-02-001-feat-round19-transitions-color-chroma-plan.md` - the
   ACTIVE round's plan, with per-task specs and the settled decisions.
3. `docs/TO-VERIFY.md` - dated verification sections per round + the Dan-owed list.
4. `PATCHES.md` - every modified upstream-originated file. Conflicts on EVERY worktree
   merge; resolution is always keep-both, then marker-grep before commit AND push.
5. `docs/HANDOFF-2026-08-01.md` - the previous session's handoff (rounds 15-18 detail).

## 2. What is DONE and shipped (all pushed)

### Rounds 15-18 + onboarding: CLOSED, every feature rated 9/10 or better by its verifier

- Round 15 (timeline CapCut feel): media drops land on V1 from every gesture; magnetic
  main track default ON; edge-drag clamp feedback ("No more footage"); 8 video + 8 audio
  tracks with user add/delete. Closed 9/9.
- Round 16 (transcript x Director): transcript lineage journal; RED PIPE BARS at every
  cut with a deleted-words window and per-word restore; panel UX (follow-playback,
  ambient status); Groq error surfacing + one-shot local-Whisper fallback; the
  export-segment-drop fix. Closed 9/9 after one fix cycle.
- Round 17 (prompt-to-edit assistant): timeline context serializer, 11 edit tools +
  ask_user, validators reusing the editor's own clamps, executor (one BatchCommand per
  turn, strict >3 ops / >10s confirmation), chat dock + mini-prompt, real-service
  adapter, template smart defaults + show-me mode. Closed 9/9. LIVE LLM RUN IS STILL
  DAN-OWED (needs an Anthropic key; see section 5).
- Round 18 (parity quick wins): freeze frame / reverse / crop; speed curves (7 CapCut
  presets + editable graph); audio fade handles; export resolution + bitrate labels +
  "export SRT alongside"; VibeCut home page + wordmark + favicon. All 9/9 (T18.1 was
  reopened once for a freeze-frame linked-audio desync, fixed and re-rated 9/9).
- T21.1 onboarding (pulled forward from round 21): `/get-started` page, first-run banner,
  provider status cards, deep links into Settings > AI. Closed 9/9.
- Groq server-side key support: the app reads `GROQ_API_KEY` from the server env; Dan's
  real key is in `apps/web/.env.local` and the cloud path was verified end to end
  (HTTP 200, 67-word transcript, word-seek + pipe + SRT export all correct).

### Round 19: CLOSED 2026-08-03 at 9/9 across all seven features

- T19.0 wasm effects foundation: `pack_effect_uniforms` generalized to a per-shader
  uniform schema (96-byte buffer: 12 scalars + 2 vec2 + 1 vec4), blur proven
  bit-identical, mask expansion + opacity implemented in Rust and
  `MASK_EXPANSION_OPACITY_RENDERED` flipped true, empty-pass-chain blit skipped.
- T19.3 transitions v1: cross dissolve / dip to black / dip to white at main-track
  joins, fade at open head/tail; join chip + picker + bracket badge; zero-migration
  model (optional element field); survival rules across split/trim/move/ripple; and a
  per-consumer video-cache sink that fixed same-source crossfade thrash (20 seeks and
  ~306ms down to 2 seeks and ~33ms in the unit harness).
- T19.1 Adjust effect: 9 colour params in one shader pass + 8 filter presets with live
  GPU thumbnails.
- T19.2 chroma key: YCbCr keying with spill suppression and shadow preservation,
  straight-alpha convention verified against the blend shader, an sRGB encode/decode
  trap caught and tested, plus an eyedropper that samples the DECODED source frame
  (not the composited preview) with a magnifier overlay.
- T19.4b: pixelate, vignette, glow (2-pass separable, combine fused into the blur so no
  second texture binding was needed), noise (new time uniform threaded through
  `resolveEffectPasses`); shake correctly DROPPED as a transform concern, not a
  fragment effect. Effects tab unhidden; `HIDDEN_ASSET_TABS` is now just
  `["hyperframes"]`.
- T19.4a: Sounds tab fixed (load-more TypeError, dead commercial-license filter, audio
  preview leak, friendly no-key state) and unhidden; stickers pruned (~700 dead lines
  removed, export-critical resolver spine kept and proven by a legacy-project test);
  6 new caption looks (12 total).

Gates at the R19-7 tip: apps/web **2717 pass / 0 fail / 1 skip** (the skip is the
intentional pin-vs-source guard test, un-skip after the 0.3.0 publish + repin),
hf-bridge **210 pass / 0 fail**, `bunx tsc --noEmit` clean from apps/web,
`wasm-pack test --node rust/crates/effects` **21 pass / 0 fail**, `bun run build:web`
green.

### Round 20: CLOSED 2026-08-03 at 9/9 across all four features (LIVE verification)

Plan: `docs/plans/2026-08-03-001-feat-round20-hyperframes-remotion-plan.md`.
Verified live (claude-code CLI drove real author/planner calls through the UI;
evidence in `docs/TO-VERIFY.md` round-20 section):

- T20.0 registry tag-pin: already shipped in `653437fb`; render-smoke re-run 24/24.
- T20.1 style preference profiles (9/9): `HfPreset.design` (palette/fonts/motion/
  density), store v4 -> v5 migration proven lossless live, VIBE_STYLES as factory
  defaults, DESIGN PROFILE brief injection seen in the live author request, native
  path maps accent/font onto template variables, profile editor in the panel.
- T20.2 probe-render-first + resume (9/8): probe stage (4s probes via a generated
  `probe.html`, `probeSec` route param), contact-sheet approval gate riding the
  drafts UX (full render blocked pre-approval, approval persists across close),
  run-manifest checkpoint (pending/probed/rendered/failed; retry from drafts;
  same-scope re-run reuses rendered chunks, ~5s, zero author calls), placed
  segments always muted (audio muxes from source). One minor defect R20-1 (reused
  chunks lost `framecutAi.brief`) fixed in `9c6e7867`.
- T20.3 Remotion media-pack export (9/9): manifest + JSON EDL + transcript +
  media via File System Access directory (JSON bundle fallback), spec
  `docs/remotion-media-pack-v1.md`, styleProfile slot null until kit-side
  validation. Kit-side consumption is Dan-owed.
- T20.4 panel redesign + un-park (9/9): start flow profiles -> describe ->
  showcase -> run-flow note -> Advanced disclosure; `HIDDEN_ASSET_TABS` is now
  EMPTY; RUN HYPERFRAMES cluster + context item + drafts panel live;
  auto-assemble and highlight stay parked.

Gates at tip `9c6e7867`: apps/web **2777 pass / 0 fail / 1 skip**, hf-bridge
**232 pass / 0 fail**, tsc clean, render-smoke 24/24.

Not exercised live (carried): multi-chunk runs (single-chunk scopes only),
author-stage retry (render-stage retry was injected and passes), the JSON-bundle
pack fallback, transcript CONTENT accuracy (headless Chrome ships no AudioDecoder;
pipeline verified, content check is Dan's real-browser pass).

### Round 21 (partial): T21.1 onboarding closed with round 18; T21.2 SHIPPED 2026-08-03

T21.2 LLM provider abstraction (merged `ca3998b0`, gates 2804/0/1-skip + 253/0 +
tsc): one capability-keyed provider layer (`packages/hf-bridge/src/llm-client.ts`:
jsonSchema/images/tools per mode; claude-code is the degenerate no-images/no-tools
tier) behind `planJson`/`planMultimodal`; providers anthropic (default + quality
reference), openai, xai-grok, groq-llm (the three as configs over the existing
OpenAI-compatible transport, not new code paths) plus the pre-existing api-key /
claude-code / custom modes. `author-composition.ts`'s parallel dispatch converged
onto it. The prompt-to-edit assistant route now accepts claude-code and every new
provider via a prompt-instructed JSON fallback turn (native Anthropic tools
untouched), so DAN'S LIVE ASSISTANT RUN IS UNBLOCKED without an Anthropic key.
Per-feature provider picks in Settings > AI (Director / Assistant / HyperFrames),
"community quality" label on non-Anthropic picks, store v5 -> v6 additive
migration, eval cache-key stability proven by a golden-hash test. NOT YET
G6-VERIFIED: no live LLM calls (keys are Dan's); transports proven with mock
fetch/spawn only. Follow-up noted: /get-started still renders only Anthropic +
Groq cards (status derivations for the new providers exist; cards not added).

### Add-on 2026-08-05: ClearVoice audio enhancement (shipped, live-verified)

One-click audio quality from [ClearerVoice-Studio](https://github.com/modelscope/ClearerVoice-Studio)
(the `clearvoice` PyPI package, Apache-2.0): a local FastAPI service at
`services/audio-enhance/` runs the PyTorch models, the web app proxies to it via
`/api/audio-enhance` (`CLEARVOICE_SERVICE_URL`, loopback default), and two UI
entry points - the Audio tab's "Enhance audio (AI)" section and an "Enhance
audio" toolbar dropdown next to AI CUT - send the selected clip's source span
and swap the clip's audio in one undoable batch. Tasks live-verified through
the service: denoise (FRCRN_SE_16K, 16k -> 16k) and super_resolution
(MossFormer2_SR_48K, 16k -> 48k); the service also exposes `separate`
(MossFormer2_SS_16K, ZIP of stems) but the UI does not call it yet. Gates:
tsc clean, eslint clean, 8 new unit tests pass, 68 tests across the touched
areas pass, and the full proxy path (browser route -> Python service -> WAV)
was exercised against a real 2.4s sample. The service runs with
`services/audio-enhance/start.ps1` (CPU-only torch; models auto-download to
`services/audio-enhance/clearvoice/checkpoints` on first use, gitignored).

## 3. Round 19 G6 reopens: ALL RESOLVED 2026-08-03

The four defects below were fixed in `a8d6a6df` and re-verified live; the
re-verification then caught one follow-up hole (R19-7), fixed in the tip commit and
re-verified live again. Full before/after numbers: `docs/TO-VERIFY.md` (round-19
re-verification section). Kept here as the record of what was wrong:

- DEFECT 1 (wasm stale shadow) - fixed three ways: `bun run link:wasm` + a root
  `postinstall` that re-links `rust/wasm/pkg` over the npm shadow after every
  `bun install`; a runtime capability guard (`wasmCapabilities()` export +
  `apps/web/src/services/renderer/wasm-capabilities.ts`) that degrades unsupported
  shaders to no-op passes, gates `MASK_EXPANSION_OPACITY_RENDERED`, and shows ONE
  actionable banner; and a version-guard test suite
  (`__tests__/wasm-version.test.ts`, the pin-vs-source check skipped until publish).
- DEFECT 2 (cross dissolve dipped ~25% dark at midpoint) - the outgoing clip now
  holds at factor 1.0 (new `"hold"` ramp direction); flat blend verified in preview
  AND export; dips re-derived, already correct; guilty per-layer-factor tests
  rewritten as composited-result assertions.
- DEFECT 3 (6 of 7 effect tiles pixel-identical) - optional
  `EffectDefinition.previewParams` consumed only by the tile path; chroma-key exempt
  with a static thumbnail (bundled preview frame is chroma-neutral); guard test
  asserts non-empty pass lists.
- DEFECT 4 (caption-look bleed) - every look now spreads `CAPTION_STYLE_RESET`
  (17-key union at `DEFAULTS.text` values) under its designed values; fresh
  application byte-identical; completeness-invariant test + 12x12 sweep (144/144).
- R19-7 (found by the re-verification) - under a STALE compositor, adding a clip
  effect still threw `At least one effect pass is required`: the guard emptied the
  pass group but only the NEW compositor skips empty groups. Fixed JS-side with
  `compactEffectPassGroups` in the resolve path.

### Minor, not scored as reopens

- Escape out of the eyedropper also deselects the clip.
- The sounds route's rate-limit call has no try/catch.
- `next dev --turbopack` inside a worktree can serve a STALE bundle from the outer
  checkout when sibling lockfiles exist (set `turbopack.root` or run from the main
  checkout).

## 4. What to do next, in order

1. T21.3-T21.7 (hosted tier: accounts + credit ledger, Stripe billing + shop,
   metering, licensing/packaging, end-to-end verification). The Fable plan doc is
   WRITTEN: `docs/plans/2026-08-04-001-feat-round21-hosted-tier-plan.md` (opened
   2026-08-04). It carries the roadmap's T21.5 pricing numbers and the section-11
   pricing knobs that are Dan's call (section 4 of the plan). Dan approves the
   plan and answers the knobs, then T21.3 (Opus) and T21.6 (Haiku) open as
   worktree tasks per the plan's sequencing.
2. G6-verify T21.2 once Dan has keys/a moment: one live assistant turn on
   claude-code mode, one Director pass per provider he cares about.
3. The three minor round-19 items in section 3 can ride along with any worktree.

## 5. Dan-owed (only Dan can do these)

1. **Publish `opencut-wasm` 0.3.0 and repin** - needs his npm auth. Checklist is in
   `rust/wasm/README.md`; after repinning both package.json files, un-skip the
   pin-vs-source guard test in
   `apps/web/src/services/renderer/__tests__/wasm-version.test.ts`. Until then dev uses
   `bun run build:wasm && bun run link:wasm` (the postinstall re-links automatically
   after every `bun install` when a local build exists).
   Note the Windows build needs `RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu` (no MSVC
   linker on this machine), and `cargo test` cannot link at all here - Rust tests run via
   `wasm-pack test --node rust/crates/effects`.
2. **Live assistant run (was: Anthropic key)** - T21.2 unblocked this: the assistant
   route now runs on claude-code mode with no key. An Anthropic device key is still
   the quality-reference path, and openai/xai-grok/groq-llm keys are only needed if
   he wants to try those providers (they carry the "community quality" label).
3. **Freesound API key** (free, 2 minutes, freesound.org/apiv2/apply) to light up the
   Sound effects sub-tab. Everything else in the Sounds tab works without it.
4. **Crop keyframes decision**: ship crop non-keyframable (recommended, CapCut parity
   does not need it) or build keyframing now.
5. **Ratify the same-lane ripple decision** from his own chip session (see the auto-memory
   note `t18-1-same-lane-ripple-decision`): that fix chose its option autonomously, is
   UNMERGED, and flagged that a main x director-eval merge breaks 9 drag-drop tests.
6. **Feel checks on real footage** - everything this session was measured on synthetic
   ffmpeg fixtures: play an exported file with sound, scrub a reversed clip, try the crop
   handles, run one real AI CUT to see Director reasons inside the red pipes.
7. **Kit-side check of the Remotion media pack** (round 20): feed an exported pack to the
   dan-video kits (D:\Hermes\remotion-v2) and ratify or amend
   `docs/remotion-media-pack-v1.md`. Candidate (b) (@remotion/player embedded probe
   preview) opens only after (a) proves out in his hands.
8. **Transcript content check in a real browser** (round 20): headless Chrome ships no
   AudioDecoder, so the live verified runs transcribed silence; the pipeline is proven,
   the words are not. One real-browser generation run also covers the multi-chunk path
   (verification only ran single-chunk scopes live).
9. **ClearVoice feel check on real footage** (add-on): start
   `services/audio-enhance/start.ps1`, then run "Reduce noise" / "Improve
   clarity" on a real noisy clip in the Audio tab or via the toolbar button next
   to AI CUT; the headless verification used a synthetic sample, so real-footage
   quality is Dan's call.

## 6. Process notes that keep paying off

- Worktree agents MUST verify their base by test count before starting (two agents built
  on stale `main` this session; both were salvaged at merge, but it costs a rebase).
- Never pipe `bun test` through `tail` in the same shell chain as a `git push` - tail's
  exit 0 masks failures and a red tip got pushed once.
- `git add -A` inside this repo sweeps up the untracked local-only `.claude/` and
  `bunfig.toml`; stage explicit paths instead (it slipped twice, both reverted).
- PATCHES.md conflicts on every worktree merge; keep both sections, then marker-grep
  before commit AND before push.
- Bun runs all test files in one process, so a leaked global stub makes suites
  order-dependent; test seams should install their own in-memory fakes.
- `diag-join-verdicts` gate numbers belong to a cached draw set. Current reproducible
  baseline: recall 12/16, precision 12/13, 19 fragments. Always quote the fragment count
  with the fraction.
