# HyperFrames / Remotion dependency findings - 2026-07-22

This is a routine dependency-hygiene pass: bump the pinned HyperFrames engine to the latest
stable release, read every changelog since our last bump, and check whether any of it touches
the specific problems we've hit before. It is not an attempt to un-park the AI generation
layer. That feature stays hidden behind `surface-flags.ts`, and nothing here changes that.

## Remotion: not in this repo

Searched every `package.json` in the monorepo and every source file for `remotion` (case
insensitive). There is no Remotion dependency anywhere in FrameCut. The only two hits are
harmless: a roadmap doc (`docs/plans/2026-07-19-002-feat-ui-overhaul-roadmap.md`) that refers
to "HyperFrames/Remotion" as the name of the parked feature concept, and a comment in
`apps/web/scripts/director-eval-prepare.ts` with an example path (`D:\Hermes\remotion-v2\...`)
pointing at a *different* project of yours, not this one. If you use Remotion elsewhere, it's
unrelated to FrameCut's dependency tree.

## The pin

| | Before | After |
|---|---|---|
| `hyperframes` (in `packages/hf-bridge/package.json`) | 0.7.10 | 0.7.68 |

0.7.68 is the newest version published to npm as of 2026-07-22 (there's also a `0.7.67-alpha.0`
prerelease, skipped since we only take stable). The task brief mentioned 0.7.4 as the last
bump, but the repo had already moved to 0.7.10 in a follow-up commit (`30c67d37`) before this
pass started, so 0.7.10 is the real "before."

FrameCut never imports the `hyperframes` npm package as a library. `packages/hf-bridge/src/renderer.ts`
only shells out to its CLI binary (`hyperframes render ...`, `hyperframes preview ...`). That
matters for risk: our whole exposed surface is a handful of CLI flags
(`--format`, `--quality`, `--fps`, `--variables-file`, `--output`, `preview --port`), and I
confirmed all of them still exist and mean the same thing on 0.7.68 by running
`hyperframes render --help` and `hyperframes preview --help` against the freshly installed
package. Nothing renamed, nothing removed.

## What happened upstream between 0.7.10 and 0.7.68

58 versions shipped in 26 days (2026-06-26 to 2026-07-22, this project ships several times a
day). I pulled every one of the `releases/vX.Y.Z.md` files from
[github.com/heygen-com/hyperframes](https://github.com/heygen-com/hyperframes) (that's the real
repo behind the `hyperframes` npm package, confirmed from the npm registry's `repository`
field) and read all of them. Full list: 0.7.11 through 0.7.68.

### Top 5 changes that actually matter to us

1. **Render-capture reliability got a real overhaul.** A big chunk of the 58 releases
   (0.7.38, 0.7.39, 0.7.42, 0.7.52, 0.7.54, 0.7.55, 0.7.62 and others) rebuilt how HyperFrames
   captures frames: a faster capture path ("drawElement") now has an automatic
   self-verification net that falls back to the old, slower, proven-safe screenshot method the
   moment anything looks wrong (blank frames, OOM, a stalled worker). This is exactly the kind
   of "render just failed for no clear reason" problem we've suspected before. It's not a
   guarantee, but it's a large, sustained engineering investment aimed straight at our pain
   point.

2. **Windows-specific render bugs got fixed.** You're on Windows. 0.7.32 closed a Windows
   media-setup gap, 0.7.35/0.7.36 fixed HyperFrames picking a broken shell shim instead of the
   real `ffmpeg.exe`/`ffprobe.exe`, and 0.7.42 fixed a case where extracting video frames failed
   outright on Windows because it tried to make a symlink and got a permissions error (`EPERM`);
   it now falls back to copying the file instead. These are the sort of thing that would show
   up as "renders that work for the HyperFrames team on Mac fail silently for you."

3. **Deterministic seeking got several direct fixes.** 0.7.11 fixed the render frame-rate not
   being honored during seeking. 0.7.60 fixed a bug where the software renderer (used on
   machines without a real GPU, plausible for a render inside Docker) could leak a stale frame
   from the compositor into the captured output, and separately fixed a bug in holding a video
   clip's last frame steady when it needs to fill a longer slot than the clip itself. 0.7.61
   added new lint rules that catch animations which read "cold" (wrong) values right after a
   seek. All of this is squarely in the "deterministic render contract" territory the task
   asked me to check.

4. **Hostile video codecs now auto-transcode.** As of 0.7.61, both Studio preview and the
   render pipeline automatically detect and transcode codecs that used to just break things
   (HEVC, alpha-channel video, anything Chrome can't decode) into an H.264 proxy, consistently
   across preview, render, and published output. If any of our past "AI-editing render
   failures" came from a user's footage being in an awkward codec rather than the version-skew
   problem, this should quietly fix it.

5. **The registry-fetches-`main`-but-renders-on-a-pinned-engine problem has a real, cheap fix
   available, we just haven't taken it.** See the next section; this is the single most
   actionable finding in this whole pass.

### The version-skew problem (registry fetches `main`, engine is pinned)

This was flagged in `docs/TO-VERIFY.md` as the likely cause of AI-editing render failures:
`packages/hf-bridge/src/registry-fetch.ts` and `packages/hf-bridge/src/bake.ts` both hardcode

```
https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry
```

That always pulls whatever registry content is on `main` **today**, but we render it with
whatever `hyperframes` engine version we have pinned. If the registry authors start using a
runtime feature the pinned engine doesn't have yet (or drop one it used to rely on), a bake can
break for reasons that have nothing to do with our own code and nothing to do with the engine
bump we just did. It's purely a mismatch between "registry content as of right now" and
"engine as of whenever we last bumped."

I checked whether upstream has since shipped some kind of first-class "versioned registry
fetch" feature. They haven't, in the sense of a documented API for it. But I also checked
whether the fix is available anyway, and it is: **HyperFrames tags a real git tag for every
release, and that tag's `registry/` folder is a perfectly normal snapshot of the registry as it
was at that release.** I confirmed this directly:

- `git tag` on the hyperframes repo has `v0.7.10` and `v0.7.68` (and everything between).
- Fetching `registry/` at the `v0.7.10` tag returns the same folder layout
  (`blocks/`, `components/`, `examples/`, `registry.json`) as fetching it at `main` today.

That means our own fetch code could point at
`https://raw.githubusercontent.com/heygen-com/hyperframes/v0.7.68/registry` (i.e. the tag
matching whatever version is in `packages/hf-bridge/package.json`) instead of `main`, and the
registry content we bake would always match the engine we're actually rendering with. No
upstream change needed. This is entirely in our hands, in two files we already own
(`registry-fetch.ts`, `bake.ts`), and it's a small change (read the pinned version, build the
URL from it, instead of a hardcoded `main`).

**I did not make this change.** It's outside what this pass was scoped to do (bump, verify,
report), and touching the render path on the same pass as a version bump makes it harder to
tell which change caused which effect if something breaks. But this is the clearest, cheapest,
most confidently-correct fix available for the exact failure mode you're worried about, and I'd
put it near the top of any follow-up list.

### The transition-slot problem (still not built)

`hyperframes-panel.tsx` currently hides transition blocks (`transitions-3d`,
`transitions-blur`, `transitions-cover`, etc.) with the comment that "a real transition slot is
not yet built." I checked whether upstream changed anything that would make this easier, and
the honest answer is: not directly, but there's a validated pattern to copy.

I pulled the actual `registry-item.json` schema for a transition block
(`transitions-blur`) and it's just a generic block: a title, a 20-second demo composition, and
tags. There's no metadata field for "how long should the overlap be" or "which two clips does
this go between." These blocks are still just standalone demo reels showing a transition
between two placeholder clips baked into the block itself, exactly as our code's comment says.
Nothing changed there.

However, HyperFrames' *own* agent-driven video skills (the ones that write
"faceless-explainer"/"PR-to-video"/"product-launch-video" style videos) do have a working
transition system internally, and it got real bug fixes across this window (0.7.32 padded a
transition's tail duration to match, 0.7.54 fixed transition content going transparent
mid-crossfade, 0.7.60 fixed holding a clip's final frame through a longer slot). Reading the
actual PR for the 0.7.54 fix, the mechanism is: when two scenes get stitched with an overlap
for a transition, extend both scenes' own content to cover that overlap (not just the outer
wrapper), so neither scene goes blank or transparent during the crossfade. That's a real,
working, tested pattern, but it lives inside HyperFrames' own skill-authoring code
(`packages/core` in their repo), not exposed as a public SDK primitive a third-party editor
like ours could just call. If we ever build our own transition slot, that's the blueprint to
copy (reserve an overlap between two adjacent timeline clips, extend both clips' content into
it, bake the transition block as an overlay on top), but we would still be building it
ourselves, not getting it for free.

## Anything that could break with this bump?

Checked for anything upstream that would break our narrow CLI-flag surface or our own
generated composition HTML:

- No engine-requirement change (`engines.node` is `>=22` on both 0.7.10 and 0.7.68; we run
  Node 24).
- No renamed or removed CLI flags in the render/preview commands we use.
- One internal refactor worth knowing about: 0.7.61 "unified the composition contract"
  (how `data-duration`/`data-end`/track semantics are read across the whole stack). The PR
  explicitly says it keeps reading the old/legacy attribute forms, so our existing generated
  template HTML shouldn't need any changes. Confirmed nothing broke by actually running our
  templates through the bumped engine (see Verification below).
- `bun.lock` shrank by about 96 lines from this bump alone. HyperFrames upgraded its bundled
  Puppeteer browser-downloader (`@puppeteer/browsers` 2.x to 3.x), which dropped several
  transitive packages (`extract-zip`, `yauzl`, the `bare-*` family, `degenerator`/`escodegen`).
  This is normal transitive churn from their side, not something we did.

## Verification

Ran everything the task asked for, from a clean `bun install` at the bumped pin:

- `cd packages/hf-bridge && bun test`: **188 pass, 0 fail** (442 `expect()` calls).
- `cd apps/web && bun test`: **1620 pass, 0 fail** (17604 `expect()` calls). A few tests print
  error-path log lines to stderr (`Retake planning failed: upstream boom`, etc.); those are
  intentional simulated-failure tests, not real failures.
- `cd apps/web && bunx tsc --noEmit`: **clean, 0 errors.** (Running `tsc` from the repo root
  instead pulls in unrelated third-party type conflicts, `miniflare`/`zod`, `wrangler`,
  `react-day-picker`, that have nothing to do with HyperFrames and exist regardless of this
  bump. `apps/web` is the actual build target and the same scope the 0.7.4 bump's own gate
  used, "web tsc 0".)
- `bun packages/hf-bridge/scripts/render-smoke.ts`: **24/24 rendered OK, 0 dim-mismatch, 0
  duration-off.** Same perfect score as the 0.7.4/0.7.10 baseline: all 5 templates x 4
  setting combos (1080p@30, vertical 1080x1920@24, 720p@30 max-duration, square 1080x1080@60)
  plus all 4 registry bakes (data-chart, us-map, us-map-bubble, us-map-hex) rendered clean.
  No network/API access beyond the public GitHub-hosted registry was needed; everything else
  ran locally against Chrome and ffmpeg already on this machine.

## Recommendation: is the generation layer worth un-parking?

Short answer: not yet, but the gap narrowed more this round than in the previous bump, and one
of the two things you'd need is now genuinely available.

What you'd need before it's worth spending real time on again:

1. **The version-skew fix actually landed and held up under real use.** Right now it's a
   3-line change we know how to make (point the registry fetch at the pinned engine's git tag
   instead of `main`) but haven't made or tested. Until it's in and has survived a few real
   bakes, "the registry and the engine disagree" stays a live risk for anything AI-generated.
2. **A transition slot, if you want transitions at all.** Upstream didn't hand us one; we'd be
   building it from scratch using their internal pattern as a guide. That's real work, not a
   quick win from this bump.
3. **Time with real footage.** Everything above is changelog-reading and a clean render-smoke
   run on synthetic templates; it is not the same as Dan actually using AI Generate on a real
   project and hitting (or not hitting) a render failure. The engine is measurably more
   reliable on paper (Windows fixes, capture self-verification, codec auto-proxying,
   determinism fixes) than it was at 0.7.10, but "measurably more reliable on paper" and
   "actually reliable for you" are different claims, and only the second one matters.

If you do want to pick this back up, here's the order I'd do it in. First, land the
registry-tag-pin fix (cheap, well understood, directly answers the failure mode that scared us
off last time). Then re-run render-smoke and a handful of real AI Generate attempts. Only after
that, decide whether a transition slot is worth building.
