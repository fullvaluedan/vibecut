# VibeCut handoff, 2026-08-02 (end of session: rounds 15-18 shipped, round 19 in a G6 fix cycle)

Written at a clean stopping point after the monthly API spend limit killed four in-flight
fix agents (they died during setup and wrote NO code, so nothing is half-applied).

Branch: `feat/director-eval`, tip `9ca7d6a0`, pushed. Working tree clean apart from the
untracked local-only `.claude/` and `bunfig.toml`.

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

### Round 19: ALL SEVEN BUILD TASKS MERGED, but the round does NOT close (see section 3)

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

Gates at tip `9ca7d6a0`: apps/web **2690 pass / 0 fail**, hf-bridge **210 pass / 0 fail**,
`bunx tsc --noEmit` clean from apps/web, `wasm-pack test --node rust/crates/effects`
**21 pass / 0 fail**, `bun run build:web` green.

## 3. Round 19 G6 verdict: 3 features PASS, 4 REOPEN

Full evidence in `docs/TO-VERIFY.md` (round-19 section) and the verifier's scores below.

| Feature | Func | Qual | Verdict |
|---|---|---|---|
| T19.1 Adjust + presets | 9 | 9 | PASS |
| T19.2 chroma key + eyedropper | 9 | 8 | PASS |
| T19.4a sounds | 9 | 8 | PASS |
| T19.0 wasm foundation | 6 | 7 | REOPEN |
| T19.3 transitions | 8 | 7 | REOPEN |
| T19.4b new effects + tab unhide | 9 | 6 | REOPEN |
| T19.4a stickers prune + caption looks | 8 | 6 | REOPEN |

### DEFECT 1 (CRITICAL, blocks the entire GPU half of round 19)

**apps/web never loads the wasm this round built.**
`apps/web/node_modules/opencut-wasm` is a REAL DIRECTORY holding the published 0.2.10
(dated 2026-06-07). It SHADOWS the root-level `bun link` that `rust/wasm/README.md`
tells you to create, so the README's dev-loop instructions are false on this repo
layout. Both `package.json` (root, ~line 31) and `apps/web/package.json` (~line 57)
still pin `"opencut-wasm": "^0.2.10"`, so any fresh `bun install` restores the shadow.

Proof: the served bundle chunk was byte-identical (md5) to the npm copy and contained
zero occurrences of `color-adjust`.

Consequences on a clean checkout: adding an Adjust effect BLANKS THE PREVIEW with
`Missing uniform 'u_sigma' for shader 'color-adjust'`; chroma key, pixelate, vignette,
glow and noise fail identically; and `MASK_EXPANSION_OPACITY_RENDERED = true` is running
against a compositor that cannot honour it.

CURRENT LOCAL STATE (uncommitted, machine-only): the verifier replaced that directory
with a junction to `rust/wasm/pkg` so anything could be verified at all. A backup of the
npm copy sits at `apps/web/node_modules/opencut-wasm.npm-0.2.10-backup`. This is a hack,
not a fix, and it will not survive `bun install`.

The fix task was fully specified and was mid-launch when the spend limit hit. Required
shape: (a) a reproducible dev-link that survives `bun install` (root `overrides`, a
`bun run link:wasm` script that removes the shadow and makes a Windows-safe junction, or
a `link:` dependency with a documented publish-time repin); (b) a RUNTIME CAPABILITY
GUARD so a stale wasm shows one clear actionable banner instead of blanking the preview,
with `MASK_EXPANSION_OPACITY_RENDERED` gated on the detected capability and unknown
shaders degrading to a no-op pass list; (c) a guard TEST comparing the pinned version to
the version the Rust source declares - that test is what would have caught this.

### DEFECT 2: cross dissolve dips about 25% dark at its midpoint

Both neighbours ramp opacity, so source-over compositing yields `0.75 * luminance` at
t=0.5 instead of a flat blend. Measured mid-gray to mid-gray: `[126,127,129]` ->
`[93,96,94]` -> `[123,128,128]`, in preview AND export. Correct math: with an upper
layer at alpha a over a lower layer at alpha 1, the result is `U*a + L*(1-a)`, so the
OUTGOING layer must stay at factor 1.0 and only the INCOMING (last-composited) layer
ramps 0->1. The existing unit tests ASSERT the buggy per-layer 0.5 factor and must be
rewritten as composited-result assertions (that test class would have caught it). Dip to
black/white need the same re-derivation check.

### DEFECT 3: 6 of 7 Effects-browser tiles are pixel-identical

Catalogue tiles render with `params: {}`, and every effect except blur is neutral at its
defaults (correct for clips, useless for a catalogue). Fix: add an optional
`previewParams` to `EffectDefinition`, author a visibly distinct value set per effect,
use it in the tile render path only (never for a newly added clip instance), and guard
it with a test asserting every registered effect's previewParams produce a NON-EMPTY
pass list or appear in a documented exemption list. Chroma key needs a decision (key a
plausible hue on a bundled preview image, or a static illustrative thumbnail).

### DEFECT 4: caption looks bleed in both directions

Application is a merge, and the 12 looks do not all set the same key set. Repro:
Broadcast -> Neon Accent -> Plain leaves `letterSpacing=2 shadowBlur=8 shadowOffsetY=2`;
"Plain", the reset look, leaves a drop shadow. Fix: compute the union of keys across all
12 looks, make every look set every key in that union (without changing any look's
intended fresh-application appearance), and add both a completeness-invariant test and a
full 12x12 permutation sequence-independence sweep.

### Minor, not scored as reopens

- Escape out of the eyedropper also deselects the clip.
- The sounds route's rate-limit call has no try/catch.
- `next dev --turbopack` inside a worktree can serve a STALE bundle from the outer
  checkout when sibling lockfiles exist (set `turbopack.root` or run from the main
  checkout).

## 4. What to do next, in order

1. Re-run the four fix tasks from section 3 (their full specs are reproduced above; each
   was written as a standalone worktree brief). Suggested split: DEFECT 1 on Opus alone
   (it is the critical path and touches package resolution + a runtime guard), DEFECT 2
   on Opus, DEFECTS 3 and 4 on Sonnet in parallel. They touch disjoint files.
2. Re-run the round-19 verifier (T19.5) on the fixed tip. It must confirm, with the
   local wasm actually loaded: all 7 effect tiles visibly distinct, an Adjust effect
   rendering rather than blanking, mask expansion/opacity, a luminance-flat cross
   dissolve, and clean caption-look sequencing. Round 19 closes only at 9/9 across all
   seven features.
3. Then Round 20 (HyperFrames + Remotion, un-parked, probe-render-first) and the rest of
   Round 21 (T21.2 provider abstraction incl. claude-code support for the assistant
   route, T21.3-T21.7 hosted credits/billing/shop). Both need their own Fable plan docs
   before any build, per the roadmap.

## 5. Dan-owed (only Dan can do these)

1. **Publish `opencut-wasm` 0.3.0 and repin** - needs his npm auth. Checklist is in
   `rust/wasm/README.md`. Until then dev depends on the local-link fix from DEFECT 1.
   Note the Windows build needs `RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu` (no MSVC
   linker on this machine), and `cargo test` cannot link at all here - Rust tests run via
   `wasm-pack test --node rust/crates/effects`.
2. **Anthropic key** for the live prompt-to-edit assistant: either a device key in
   Settings > AI, or `ANTHROPIC_API_KEY` in `apps/web/.env.local` plus a restart.
   (Claude Code auth mode does not cover that route yet; it is tracked as T21.2.)
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
