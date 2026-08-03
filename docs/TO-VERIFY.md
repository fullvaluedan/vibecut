# TO-VERIFY — live checks pending Dan's testing

Everything below is **shipped + committed** (tsc + lint clean, logic unit-tested where testable) but **not yet live-verified by Dan** on real footage. Branch: `feat/director-dupword` (dev server: `framecut-director` launch entry → localhost:3000). Tick items off as you confirm them.

## Round 19 G6 RE-VERIFICATION (2026-08-03, T19.5 re-verify, branch `feat/director-eval`, tip `a8d6a6df` + uncommitted R19-7 fix)

Re-run of the four reopen checks on the fix commit, plus a same-day re-check of the one remaining hole. **Round 19 CLOSES at 9/9 across all seven features.** The first pass below found three of the four reopen defects verifiably fixed and one remaining hole (R19-7, stale-wasm clip-effect degrade still throwing); R19-7 was then fixed in the working tree (`compactEffectPassGroups` in `wasm-capabilities.ts`, applied in `resolve.ts` `resolveEffectPassGroups`) and re-verified end to end the same day — see the "FIXED and RE-VERIFIED" block under check 7 and the re-rated scores.

**Method.** Same measurement approach as the original pass: the app driven in headless Chrome (puppeteer-core + chrome-headless-shell from the repo-root install) against `bun run dev` from THIS checkout, pixels measured through the app's own render path (`__vibeEditor.renderer.createSnapshot()` at a seeked playhead, decoded to mean RGB / luminance std / % lit / named corner pixel / 64x64 FNV hash), exports via `renderer.exportProject` (returns the mp4 buffer directly) + ffmpeg frame extraction (`scale=1:1` rawvideo for per-frame mean RGB). Same ffmpeg fixture family regenerated: `testsrc2`+sine, solid `0x2040A0` / `0x00B140` / `0x808080` plates, 640x360@30. One harness correction vs the original pass: **TICKS_PER_SECOND is 120000, not 300000** (proven by a 50s export from a "20s" timeline built on the wrong constant; all numbers below use the correct one).

### Gates at `a8d6a6df` (+ R19-7 working-tree fix)
- G1 `bun test` apps/web: 2717 pass, 0 fail, 1 skip (the intentional pin-vs-source version check, skipped until Dan publishes 0.3.0) on the R19-7 working tree; 2715 at `a8d6a6df` itself. PASS.
- G1 `bun test` hf-bridge: 210 pass, 0 fail. PASS.
- G2 `bunx tsc --noEmit` from apps/web: 0 errors. PASS.
- Rust `RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu wasm-pack test --node rust/crates/effects`: 21 pass, 0 fail. PASS.
- Focused suites for the four fixes (`wasm-capabilities`, `wasm-version`, `transition-window`, `transition-export-parity`, `preview-params`, `caption-styles-data`, `caption-styles-sequencing`): 68 pass, 0 fail, 1 skip across 8 files (the 12x12 caption sweep alone is 144/144).

### The seven reopen checks

**1. Local wasm actually loaded — PASS, proven at every level.**
`apps/web/node_modules/opencut-wasm` is a junction to `rust/wasm/pkg` (version 0.3.0), created by the new `bun run link:wasm` (root `postinstall` re-runs it `--if-built` after every `bun install`). The dev server serves exactly one wasm chunk, `rust_wasm_pkg_opencut_wasm_bg_11d1fd06.wasm`, whose md5 `a57c5ee5d2cc62be01bd87a3f1bd8343` is byte-identical to `rust/wasm/pkg/opencut_wasm_bg.wasm` and contains the string `color-adjust`. The backed-up npm 0.2.10 copy hashes `9c2c8f547faf1b980b09d26e1a5a25d8`, matching the stale md5 from the original pass. With 0.3.0 loaded, no stale-wasm banner renders.

**2. Adjust (and the five other shaders) render rather than blanking — PASS.**
On a testsrc2 clip at 8.0s, baseline mean `[122.7,128.6,126]` / std 67.0. Each effect added with strong params, measured, then removed: color-adjust sat+80/contrast+40 → std 81.5 (frame changes, mean preserved as designed); chroma-key `#00FF00` sim 40 → mean `[127,88.3,126.7]` (greens keyed); pixelate 40 → same mean, new hash + corner `[204,138,105]`; vignette 80 → mean `[58.5,62.9,57.2]`; glow 80 → mean `[124.2,134.1,124.6]` std 71.1; noise 50 → mean `[90.7,83,91.8]`. Every removal restored the baseline to the tenth, and there were ZERO `Missing uniform` / `Failed to apply effects` console errors across the whole run.

**3. All 7 catalogue tiles visibly distinct — PASS, quantified.**
Six GPU tiles now render with `previewParams` (tile path only — a freshly added `color-adjust` clip instance still gets all-zero neutral params, verified) and chroma-key ships a static illustrative thumbnail (`/effects/chroma-key-preview.png`, exemption documented in the guard test). Normalized 64x64 pixel compare, MSD per pixel summed over RGB: vs the unprocessed `preview.jpg` source — Blur 155, Adjust 890, Chroma 38634, Pixelate 1007, Vignette 37829, Glow 1366, Noise 1632. Pairwise minimum across all 21 pairs is 911 (Blur vs Pixelate, RMS ≈ 17 LSB/channel — Blur and Pixelate legitimately share a mean; they differ in structure); Vignette and the chroma thumbnail sit at 35k-55k against everything. The original defect measured a single shared FNV hash for 6 of 7 tiles, i.e. pairwise MSD 0.

**4. Mask expansion/opacity honoured end to end — PASS, and the stale-wasm guard path confirmed LIVE.**
Ellipse mask (0.6 ratio) over the solid `0x2040A0` plate, measured as % of frame lit and the top-left corner pixel: expansion 0 → 28.4% lit (geometry exact: π·0.3² = 28.3%), +40 → 47.4%, +80 → 69.8%, -40 → 14.0%, back to 0 → exactly 28.4%. Opacity 0.5 → corner `[14,33,82]`, exactly half of `[28,66,164]`; 0.0 → corner `[28,66,164]` (mask inert); 1.0 → 28.4% again. Guard path: `MASK_EXPANSION_OPACITY_RENDERED` is AND-ed with the runtime capability report in `frame-descriptor.ts`; with the npm 0.2.10 copy deliberately restored (check 7), expansion +80 left the mask at exactly 28.4% lit and opacity 0.5 kept the corner `[0,0,0]` — the no-op (0,1) degradation working live, which exceeds the required unit-level confirmation (also covered by `wasm-capabilities.test.ts`, green).

**5. Luminance-flat cross dissolve — PASS in preview AND export; dips fall linearly.**
Same-source constant-gray (`0x808080`) 1.0s cross dissolve: `[128,128,128]` at 9.0, 9.5, 9.75, 10.0, 10.25, 10.5, 11.0 — perfectly flat, where the original pass measured the 0.75x dip (`[93,96,94]`) at the midpoint. Cross-source blue→green: endpoints `[28,66,164]` / `[0,153,62]`, and every in-window sample matches the linear blend to ≤0.5 LSB (9.75 → `[21,88,138]` vs `[21,87.8,138.5]`; 10.0 → `[14,110,113]` vs `[14,109.5,113]`; 10.25 → `[7,131,88]` vs `[7,131.3,87.5]`). The outgoing clip now holds at factor 1.0 ("hold" ramp) while the incoming ramps 0→1, confirmed in the render tree. Dip to black: 9.75 `[14,33,82]` (exactly half the blue), 10.0 `[0,0,0]`, 10.25 `[0,76,31]` (half the green). Dip to white: 9.75 `[142,161,210]` (= ½·255 + ½·blue), 10.0 `[255,255,255]`, 10.25 `[128,204,159]` (= ½·255 + ½·green). Export of the same dissolve timeline (20.016s → 20.0s, 640x360@30 h264): midpoint frame `[15,110,112]` against the linear blend of the exported endpoints `[14,109,111]` — flat to h264 quantization; the original pass measured `[95,93,93]` here.

**6. Caption-look sequencing — PASS, through the real UI apply path.**
Four `Caption N` text elements on an overlay text track, looks applied by clicking the actual Captions-panel buttons (pointerdown/up/click on the rendered `CaptionStyles` grid). Original repro A: Broadcast (letterSpacing=2, shadowBlur=8, shadowOffsetY=2, bg `#1a1a1a` — all correctly applied) → Neon Accent → Plain leaves `letterSpacing=0 shadowBlur=0 shadowOffsetY=0 strokeWidth=0 background.enabled=false` — zero bleed, "Plain" is a true reset. Repro B: Weight Shift (`letterSpacing=1.5`) → Outline Pop leaves `letterSpacing=0 strokeWidth=6 shadowBlur=0` — clean in the other direction too. The data-level 12x12 sequence-independence sweep (144/144) and the completeness invariant are green in `caption-styles-sequencing.test.ts`.

**7. Stale-wasm UX — PASS (R19-7 FIXED and RE-VERIFIED 2026-08-03, working tree on top of `a8d6a6df`).**
With the npm 0.2.10 copy swapped back in and `.next` cleared: exactly ONE banner renders — "VibeCut is running a stale opencut-wasm build — GPU effects (gaussian-blur, color-adjust, chroma-key, pixelate, vignette, glow, noise) are disabled. Fix: run `bun run build:wasm && bun run link:wasm` from the repo root (see rust/wasm/README.md)." — one span, actionable, correct. The app loads and renders clips fine (baseline snapshot `[122.7,128.6,126]`, no blank on load), and mask expansion/opacity degrade to (0,1) as shown in check 4.
First-pass finding (now fixed): adding a clip effect (vignette amount 100, or color-adjust) under the stale wasm threw every frame — `Failed to apply effects: At least one effect pass is required` — and snapshot capture failed outright. Root cause: `filterSupportedEffectPasses` emptied the pass group, but the empty-group skip (`compositor.rs:517-527`) only exists in the NEW 0.3.0 compositor; the stale 0.2.10 compositor being guarded against treats an empty group as an error, and nothing JS-side dropped all-empty groups from `effectPassGroups`.
FIXED and RE-VERIFIED 2026-08-03 (uncommitted working-tree fix: new `compactEffectPassGroups` in `wasm-capabilities.ts` drops empty groups, applied in `resolve.ts` `resolveEffectPassGroups`; `wasm-capabilities.test.ts` 9 pass / 0 fail, tsc clean). Re-ran this entire check against the stale 0.2.10 swap: (a) banner still exactly one span, same actionable text; (b) preview does not blank — baseline snapshot `[122.7,128.6,126]` std 67.01; (c) adding vignette amount 100 AND color-adjust sat 100/contrast 60 under stale wasm now renders the clip WITHOUT the effect — the frame is byte-identical to the no-effect baseline (`[122.7,128.6,126]` std 67.01, same hash) — with ZERO `Failed to apply effects` / `Missing uniform` console errors (the first pass logged six). Mask no-op degrade re-confirmed unchanged: expansion +80 stays at 28.4% lit / corner `[0,0,0]`, opacity 0.5 keeps the corner `[0,0,0]`. The junction was restored afterwards (`bun run link:wasm`), version re-verified 0.3.0, the 0.2.10 backup directory preserved, and a healthy-state smoke re-confirmed: no banner, baseline renders, vignette 80 genuinely renders again (mean drops to `[57,61.6,60.1]`), zero console errors.

### Re-rated G6 scores

| Feature | Functionality | Quality | Verdict |
| --- | --- | --- | --- |
| T19.0 wasm foundation (schema uniforms, mask expansion/opacity) | 9 | 9 | PASS (R19-7 fixed + re-verified 2026-08-03: stale-wasm degrade now renders the clip without the effect, zero errors) |
| T19.3 transitions v1 (dissolve family) | 9 | 9 | PASS (R19-2 fixed; flat in preview + export) |
| T19.1 Adjust effect + 8 filter presets | 9 | 9 | PASS (re-confirmed renders + neutral-instance restore) |
| T19.2 chroma key + eyedropper | 9 | 8 | PASS (unchanged; static-thumbnail decision for tiles is sound) |
| T19.4b pixelate/vignette/glow/noise + effects tab unhidden | 9 | 9 | PASS (R19-3 fixed; tiles quantifiably distinct, guard test green) |
| T19.4a sounds fix + unhide | 9 | 8 | PASS (unchanged; R19-6 minor stands) |
| T19.4a stickers prune + 12 caption looks | 9 | 9 | PASS (R19-4 fixed; bleed dead through the real UI path) |

**Bottom line: round 19 CLOSES at 9/9 across all seven features** (T19.2 and T19.4a-sounds at 9/8, same PASS level the original verifier used). All four G6 reopen defects plus the R19-7 hole found in this pass are fixed and verified with live pixel evidence; the R19-7 fix is in the working tree awaiting the maintainer's commit. Everything user-facing is verified on both the healthy 0.3.0 link and the degraded stale-wasm path.

## Round 19: transitions, color adjust, chroma key, dormant surfaces (2026-08-02, T19.5, branch `feat/director-eval`, tip `21ae6e59`)

Closing verifier pass for T19.0, T19.1, T19.2, T19.3, T19.4a and T19.4b. Round 19 is **NOT done**: four tasks reopen (T19.0, T19.3, T19.4a captions, T19.4b).

**Environment notes for the next verifier.** Screenshots were unavailable the whole session (`Browser pane is not displayed, so the page is not compositing frames`), so every visual claim below is a pixel measurement taken through the app's own render path: `editor.renderer.createSnapshot()` at a seeked playhead, decoded back into a canvas and reduced to mean RGB, luminance standard deviation, a Laplacian edge score, or named corner pixels. That call runs the same CanvasRenderer the preview and the export use, so the numbers are the real composited frame, not a DOM approximation. Two consequences of the non-compositing pane, both artifacts and not product bugs: CSS opacity transitions never advance (a hovered element reports `opacity: 0` forever, so the hover-reveal chip had to be confirmed by finishing the stalled `CSSTransition` and reading the end value, which is 1), and the preview canvas reports a negative `y` in `getBoundingClientRect`. Synthetic `element.click()` works for plain buttons but NOT for Radix `TabsTrigger`, which needs a full pointerdown/pointerup/click sequence; an earlier read of "the Sounds sub-tabs do not switch" was that, not a defect. Test media was generated with ffmpeg into the scratchpad (`testsrc2` + sine for a normal clip, a solid `0x2040A0` plate for a background, and a `0x00B140` green plate with a moving `testsrc2` inset for chroma key).

**One environment change was required to verify anything GPU-side, and it is itself the biggest finding of the round.** See defect R19-1.

### Gates
- G1 `bun test` apps/web: 2690 pass, 0 fail. PASS.
- G1 `bun test` hf-bridge: 210 pass, 0 fail. PASS.
- G2 `bunx tsc --noEmit` from apps/web: 0 errors. PASS.
- Rust `RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu wasm-pack test --node rust/crates/effects`: 21 pass, 0 fail. PASS.

### G6 scores

| Feature | Functionality | Quality | Verdict |
| --- | --- | --- | --- |
| T19.0 wasm foundation (schema uniforms, mask expansion/opacity) | 6 | 7 | REOPEN (R19-1) |
| T19.3 transitions v1 (dissolve family) | 8 | 7 | REOPEN (R19-2) |
| T19.1 Adjust effect + 8 filter presets | 9 | 9 | PASS |
| T19.2 chroma key + eyedropper | 9 | 8 | PASS (R19-5 minor) |
| T19.4b pixelate/vignette/glow/noise + effects tab unhidden | 9 | 6 | REOPEN (R19-3) |
| T19.4a sounds fix + unhide | 9 | 8 | PASS (R19-6 minor) |
| T19.4a stickers prune + 12 caption looks | 8 | 6 | REOPEN (R19-4) |

### Defects (these reopen tasks)

**R19-1 (T19.0, blocking): the local wasm link never reaches `apps/web`, so the whole round's shader work is dead in the app as merged.**
`apps/web/node_modules/opencut-wasm` is a real directory containing the published npm **0.2.10** (3,037,899 bytes, dated Jun 7), not a symlink. Node/bun resolution from `apps/web` finds it before the hoisted root `node_modules/opencut-wasm` symlink that `bun link opencut-wasm` creates, so the documented local-dev loop silently does nothing. `rust/wasm/README.md` states the opposite ("From the repo root it links into the hoisted `node_modules/opencut-wasm`, which is where `apps/web` resolves it") and that claim is false on this checkout. Both `package.json` and `apps/web/package.json` still pin `"opencut-wasm": "^0.2.10"`.
Repro on a clean checkout: start `bun run dev:web`, put a video clip on V1, select it, open the clip Effects tab, and add the Adjust effect. The preview goes blank and the console shows `Failed to apply effects: Missing uniform 'u_sigma' for shader 'color-adjust'` (0.2.10's schema table has no color-adjust entry, so packing falls through to blur's). With all-neutral params it instead shows `Failed to apply effects: At least one effect pass is required`. Chroma key, pixelate, vignette, glow and noise fail the same way, and `MASK_EXPANSION_OPACITY_RENDERED = true` is now sending two `LayerMaskDescriptor` fields the resolved 0.2.10 compositor does not implement.
Confirmation: the served chunk `.../5bcb1_opencut-wasm_opencut_wasm_bg_11d1fd06.wasm` was byte-identical to the 0.2.10 npm copy (md5 `9c2c8f54...`) and contained zero occurrences of the string `color-adjust`, while `rust/wasm/pkg/opencut_wasm_bg.wasm` (md5 `e2b42a2b...`, version 0.3.0) contains it.
Workaround used for the rest of this pass (local only, not committed): replaced `apps/web/node_modules/opencut-wasm` with a directory junction to `rust/wasm/pkg`, deleted `apps/web/.next`, and restarted the dev server. After that the served chunk becomes `rust_wasm_pkg_opencut_wasm_bg_11d1fd06.wasm` with md5 `e2b42a2b...` and every shader below works.
Fix: either publish 0.3.0 and repin both package.json files (Dan-owed, see below), or make the documented dev loop actually take (link into `apps/web` too, or add a `resolutions`/workspace override), and correct the README's Windows notes. Until one of those lands, `MASK_EXPANSION_OPACITY_RENDERED` is true against a compositor that cannot honour it.

**R19-2 (T19.3): a cross dissolve dips about 25 percent dark at its midpoint.**
`plan.ts` gives the outgoing neighbour a `direction: "out"` ramp and the incoming neighbour a `direction: "in"` ramp, so BOTH layers are at 0.5 opacity halfway through. Over-compositing those against the black canvas yields `B*p + A*(1-p)^2`, which is `0.75*A` at `p = 0.5` when the two sides carry similar pictures, instead of the `0.5*A + 0.5*B` a dissolve should produce.
Repro: put one clip on V1, split it once so the two halves are the same source, apply Cross dissolve 1.0s to the join, and scrub frame by frame. Measured mean RGB across the window, effects and masks stripped: 9.2s `[126,127,129]`, 9.5s `[126,127,129]`, 9.75s `[105,101,106]`, 10.0s `[93,96,94]`, 10.25s `[100,104,103]`, 10.5s `[123,128,128]`. The predicted `0.75 * 127 = 95` matches the measured 93 to 96 exactly.
It is not specific to same-source joins. On a `0x2040A0` plate crossfading into testsrc2 with a 1.0s dissolve, the midpoint measured `[68,81,104]` where a linear blend would be `[77,96,143]`; the over-composite prediction `[69,80,103]` matches to within 1 level per channel.
It is in the export too, so this is not a preview-only artifact: the exported frame at the same midpoint measured `[95,93,93]` against the preview's `[95,94,98]`.
Why the tests missed it: `transition-window.test.ts` asserts the per-layer opacity FACTOR (0.5 each at the midpoint), which is exactly the buggy value; nothing asserts the composited luminance.
Fix: only one side should ramp. Hold the outgoing neighbour at full opacity through the window and ramp the incoming neighbour 0 to 1 over it, so the standard `A over B` dissolve falls out. Add a composited-luminance assertion (flat mean across the window for two identical sources) so the regression cannot come back.

**R19-3 (T19.4b): 6 of the 7 tiles in the newly unhidden Effects browser are pixel-identical to the unprocessed source.**
`effects/components/assets-view.tsx` renders each tile with `params: {}`, so each effect previews at its declared defaults. Blur defaults to `radius: 15` and shows a blurred tile; every other effect is neutral at its defaults (`pixelate.blockSize: 1`, `vignette.amount: 0`, `glow.intensity: 0`, `noise.amount: 0`, all nine color-adjust params `0`, and chroma key's default `#00FF00` misses any non-green preview image). The result is a grid where Adjust, Chroma key, Pixelate, Vignette, Glow and Noise all show the same untouched picture, so nothing in the browser tells you what any of them do.
Repro: open the left-rail Effects tab and compare the tiles. Measured: all 7 tiles average `[152,147,145]`; a 64x64 FNV hash of the pixel data is `3296002120` for Blur and `1100898576` for all six others, stable across an 8 second settle.
This directly contradicts the unhide criterion in the plan ("Unhide the effects tab (flag + test) once >= 5 effects render distinct live preview tiles").
Fix: give each definition a small `previewParams` bundle (or have the preview service substitute a demonstrative value when `isNeutral` is true for the effect) and pass it instead of `{}`. The per-preset thumbnails in T19.1 already do exactly this correctly and can be the model.

**R19-4 (T19.4a captions): caption looks bleed in both directions, including through "Plain".**
The 6 new looks (Outline Pop, Drop Shadow, Broadcast, Minimal Mono, Highlighter, Cinema Bar) each set the full stroke, shadow and background param set. The 6 original looks (Plain, Neon Accent, Pill Karaoke, Weight Shift, Editorial, Highlight) were never updated and set none of `strokeWidth`, `shadowBlur`, `shadowOffsetX`, `shadowOffsetY` or (mostly) `letterSpacing`. Since `applyStyle` merges (`{ ...el.params, ...style.params }`), whatever the new looks wrote survives every later old look.
Repro A (new leaking into old): hand-make four text elements named "Caption 1".."Caption 4" on an overlay text track, open the Captions tab, click Broadcast, then Neon Accent, then Plain. After Plain the caption still carries `letterSpacing=2 shadowBlur=8 shadowOffsetY=2 background.color=#1a1a1a background.cornerRadius=2 background.paddingX=12`, all of them Broadcast's. "Plain" is the reset look and it leaves an 8px drop shadow and 2px letter spacing on the text.
Repro B (old leaking into new): click Weight Shift (`letterSpacing=1.5`), then Outline Pop. Outline Pop correctly sets `strokeWidth=6` and zeroes the shadow, but `letterSpacing=1.5` persists because Outline Pop does not declare it.
This is precisely the "every look sets everything it controls (merge-not-reset bleed)" rule the plan wrote for this task.
Fix: define one canonical key set for caption looks and have all 12 entries write every key in it (or reset to defaults before merging the look).

**R19-5 (T19.2, minor): Escape out of the eyedropper also deselects the clip.**
`preview/components/eyedropper-overlay.tsx` registers its own `document` keydown listener for Escape and does not stop propagation, so the global `cancel-interaction` action (`actions/use-editor-actions.ts`) also fires and falls through to `deselect-all`. Repro: select a green-screen clip, Effects tab, Cutout, Pick color, press Escape. The pick cancels correctly, but the clip is deselected and the whole inspector drops to "It's empty here", so retrying the pick means reselecting the clip first. Fix: add the eyedropper store to the `cancel-interaction` chain the gap-selection and place-tool stores already use, so Escape is consumed once.

**R19-6 (T19.4a sounds, minor, pre-existing): a rate-limiter outage hides the friendly no-key state.**
`GET /api/sounds/search` calls `checkRateLimit` before anything else, and `auth/rate-limit.ts` has no try/catch. With `bun run dev:web` and no `docker compose up` (both are documented run modes in CLAUDE.md), Upstash at `http://localhost:8079` is not running, the call throws `ECONNREFUSED`, the route returns a bare 500, and the Sound effects tab shows the generic "No sounds available" instead of the Freesound message this task shipped. Starting `redis` + `serverless-redis-http` makes the friendly state appear immediately. Not introduced by R19, but it is the failure mode standing directly in front of R19's headline deliverable. Fix: wrap the limiter call so an unreachable limiter fails open.

### A. Transitions v1 (T19.3) - PASS except R19-2
Fixture: `bg.mp4` 0-6s, `clipA.mp4` split at 10s into two same-source halves 6-10s and 10-14s, `green.mp4` 14-20s on V1, giving one same-source join and two cross-source joins plus an open head and tail.
- [x] Hovering a main-track join reveals the chip. The chip carries `opacity-0 group-hover:opacity-100`, the parent carries `group`, and under a real CDP hover the element matches `.group-hover\:opacity-100:is(:where(.group):hover *)` and its `CSSTransition` for opacity is running with an end value of 1. It reads 0 only because the pane is not compositing, so the transition never advances.
- [x] Clicking the chip opens the mini-picker. At a join it offers exactly Cross dissolve / Dip to black / Dip to white, duration presets 0.25s / 0.5s / 1s plus a custom seconds field, and the honest note "Audio cuts at the join for now.". At the open head and the tail it offers exactly Fade.
- [x] Applying Cross dissolve 0.5s writes `transitionIn` on the right neighbour and draws the bracket at x=650 width=25px, which is 0.5s at the current 50px/s zoom centred on the join. The chip's title becomes "Cross dissolve 0.5s" and its aria-label becomes "Edit Cross dissolve".
- [x] Scrubbing frame by frame through the crossfade shows BOTH clips, never a black flash. Mid-transition frames are a genuine blend of the two sources.
- [ ] But the blend is 25 percent too dark at the midpoint. See R19-2.
- [x] Same-source smoothness (the video-cache fix): playback from 9.0s ran to 13.03s in 4.04s of wall clock, crossing the same-source join at 10s at real time with no stall. Rendering frame by frame across the join cost 1167ms mean / 1245ms max per snapshot versus 1090ms / 1134ms for a matched no-transition control, so the crossfade adds about 78ms (7 percent), nowhere near the ~600ms boundary-prefetch stall class. Note these absolute numbers are dominated by `createSnapshot` building a fresh CanvasRenderer per call; the delta is the meaningful figure. `videoCache.getStats()` is not exposed on `window`, so the secondary-sink count itself is unit-proven only (`video-cache/__tests__/transition-sinks.test.ts`, in the 2690).
- [x] Dip to black at the bg -> clipA join: measured mean RGB 5.4s `[28,66,164]` (the plate), 5.75s `[14,33,82]`, 6.00s `[0,0,0]` exactly, 6.25s `[62,64,63]`, 6.6s `[123,129,127]`.
- [x] Dip to white at the clipA -> green join: 13.6s `[128,123,138]`, 13.875s `[190,191,190]`, 14.00s `[255,255,255]` exactly, 14.125s `[137,201,164]`, 14.4s `[20,147,73]`.
- [x] Fade at the timeline head: 0.0s `[0,0,0]`, 0.125s `[7,17,41]`, 0.25s `[14,33,82]`, 0.4s `[22,53,131]`, 0.6s `[28,66,164]`. Fade at the tail: 19.6s `[17,117,59]` down to 19.98s `[1,10,5]`.
- [x] Right-clicking an applied badge removes the transition; one Ctrl+Z restores it with the same id, kind and duration.
- [x] Changing the duration from 0.5s to 0.25s via a preset chip is ONE undo back to 0.5s.
- [x] Destroying a join (dragging the right clip off the main track) removes both that join's transition and the tail fade that lived on it; one undo restores both.
- [x] Splitting INSIDE the right neighbour keeps the transition on the ORIGINAL join and does not duplicate it onto the new join. Undo restores.
- [x] Full page reload: all four transitions persist with their kinds and durations intact (no serializer work needed, as designed).
- [x] Export parity. Exported the 20s timeline: 20.016s duration, 640x360, 30fps, h264 + aac. Extracted frames match the preview at every transition: 0.00s `[4,0,5]`, 0.25s `[14,32,88]`, 5.40s `[28,64,161]`, 6.00s `[4,0,5]`, 10.00s `[95,93,93]` (preview `[95,94,98]`), 14.00s `[255,252,255]`, 19.90s `[6,26,17]`.

### B. Adjust effect + filter presets (T19.1) - PASS 9/9
Measured at 8.0s on a testsrc2 clip, neutral baseline mean RGB `[123,129,126]`.
- [x] All 9 params render, and setting a param back to 0 returns EXACTLY to `[123,129,126]` every time (checked after each one, 9 for 9).
- [x] brightness +60 `[164,181,166]`; saturation -100 `[127,127,127]` (perfectly grey); temperature +80 `[125,129,96]` (blue pulled down); tint +80 `[123,98,126]` (green pulled down); highlights -80 `[89,68,102]`; shadows +80 `[141,163,139]`.
- [x] contrast and sharpen correctly preserve the mean, so they were measured on luminance spread and edge energy instead: contrast +70 raises standard deviation 56.4 -> 66.1 and contrast -70 drops it to 16.9; sharpen 100 raises the Laplacian edge score 1.2 -> 3.2 with the mean unchanged at 126.8.
- [x] exposure is declared in stops (-3..3) and behaves as `2^stops` inside that range: 0 -> mean 126.8, +2 -> 161.7 with 3.1 percent clipping. Values well outside the declared range saturate, which is correct for the mapping and not reachable from the UI slider.
- [x] All 8 preset chips (Vivid, Film, Mono, Warm, Cool, Fade, Punch, Golden) render DISTINCT live thumbnails, and the thumbnails are right: Mono `[150,150,150]`, Warm `[162,149,134]`, Cool `[136,150,152]`, Golden `[158,135,124]`, Fade `[160,157,156]`, all with different pixel hashes.
- [x] Clicking each chip applies a distinct sensible bundle and changes the rendered frame accordingly: Fade drops luminance spread to 36.7, Punch and Vivid raise it past 65, Mono reaches 73.9.
- [x] Keyframing brightness from -90 to +90 across the clip animates linearly: 6.5s mean 59.6, 7.25s 89.8, 8.0s 126.8, 8.75s 164.6, 9.5s 200.2. Note effect-param keyframe times are element-relative and clamp to the element duration.
- [x] Export spot-check: exported frames at 7.0s and 9.0s measured `[82,76,86]` and `[163,178,166]` against preview `[83,76,86]` and `[164,181,166]`.

### C. Chroma key + eyedropper (T19.2) - PASS 9/8, R19-5 minor
Fixture: the `0x00B140` green plate with a moving inset on V2 over the `0x2040A0` plate on V1.
- [x] The Cutout section sits at the very top of the per-clip Effects tab, above the effect list, and is visible in the empty state.
- [x] "Enable chroma key" adds a real `chroma-key` effect instance (`keyColor:#00FF00, similarity:20, smoothness:10, spill:50, shadow:0`) whose params then appear in the list below. No parallel state.
- [x] With the default pure-green key the `0x00B140` plate is correctly NOT removed, which is exactly what the eyedropper is for.
- [x] Pick color arms the overlay ("Picking... (Esc)"), and the magnifier follows the cursor: moving to 15%/20% put it at `left 113.5px top 89.6px` and moving to 70%/70% put it at `465.5px, 269.6px`, visibility flipping from hidden to visible, with the live hex readout showing `#00993E`.
- [x] It samples the DECODED source, not the composited canvas: the readout is `#00993E`, the decoded value of the plate, and picking succeeded on a clip whose composited pixels were already keyed out.
- [x] Clicking the green plate sets `keyColor` to `#00993E` and the plate keys out COMPLETELY. All four corners went from the green plate to `[28,66,164]`, the V1 background, with the inset still drawn at the centre. Picking mode exits on the click.
- [x] Escape cancels a second attempt: the overlay disarms and the key colour is untouched (R19-5 is that it also deselects the clip).
- [x] Clicking outside the clip refuses gracefully. With the clip scaled to 40 percent, a click in the far corner left `keyColor` unchanged, stayed armed for a retry, and raised the toast "That point is outside the clip / Click inside the clip's own picture to pick a colour."
- [x] Params tune correctly, measured as the percentage of green-dominant pixels left and the percentage showing the background through: similarity 0 -> 3.0 percent green residue / 85.7 percent background, 5 -> 3.0 / 85.8, 20 -> 0.1 / 89.2, 60 -> 0.0 / 95.5, 100 -> 0.0 / 100 (keys everything, as expected at the extreme). smoothness 0 -> 2.4 percent residue, 80 -> 0.0. spill and shadow both move the frame measurably on this fixture.
- [x] Export spot-check for the alpha convention: the keyed-out region measured `[14,32,80]` in the export against `[14,33,82]` in the preview, a 1 to 2 level h264 quantisation difference. The edges are NOT darker in the export, so no premultiplied-alpha regression.

### D. New effects and the unhidden Effects tab (T19.4b) - functionality PASS, tiles REOPEN
- [x] The left-rail Effects tab is visible (`HIDDEN_ASSET_TABS` is `["hyperframes"]`) and lists 7 effects: Blur, Adjust, Chroma key, Pixelate, Vignette, Glow, Noise.
- [ ] The tiles are not distinct. See R19-3.
- [x] Each of the four new effects applies to a clip and scrubs visibly, measured at 12.0s against a `mean 126.8 / std 56.3 / edge 1.3` baseline: pixelate blockSize 1 -> identity, 20 -> edge 0.7, 60 -> edge 0.5; vignette amount 0 -> identity, 60 -> mean 77.1, 100 -> mean 44.0; glow intensity 0 -> identity, 60 -> mean 129.4 std 59.4, 100 -> mean 130.4 std 60.1; noise amount 0 -> identity, 50 -> edge 5.5, 100 -> edge 8.8.
- [x] Every one of them is a true identity at its neutral default, which matters because that is the early-out path.
- [x] Noise visibly reseeds frame to frame. On a SOLID-colour clip so the source contributes nothing: two frames 1/30s apart differ by mean absolute 2.99 per channel with noise off and 51.51 with noise on, and noise on versus off at the same instant differs by 33.42.
- [x] Noise is also deterministic per timestamp: rendering the SAME frame twice with noise on gives a difference of exactly 0.00, which is what export reproducibility needs.
- [x] Keyframing a new effect's param animates: vignette amount 0 to 100 across the clip measured mean 124.3, 104.6, 84.9, 65.2, 45.6 at evenly spaced times, perfectly linear.

### E. Mask expansion and opacity, the long-parked canary (T19.0) - PASS on the local 0.3.0 build
`MASK_EXPANSION_OPACITY_RENDERED` is now `true` and both fields genuinely render. Measured on an ellipse mask over a solid `[28,66,164]` plate, as the percentage of the frame still lit and the colour of a corner pixel that is outside the ellipse.
- [x] Expansion grows and shrinks the boundary: 0 -> 25.8 percent visible, +40 -> 36.1, +80 -> 50.3, -40 -> 19.0, and back to 0 -> exactly 25.8 again.
- [x] Opacity partially reveals the masked-out area: at 1.0 the corner is `[0,0,0]` (fully hidden), at 0.5 it is `[14,33,82]` which is exactly half of the source `[28,66,164]`, at 0.0 it is `[28,66,164]` (mask has no effect), and back at 1.0 the frame returns to 25.8 percent visible.
- [x] It survives export: the same half-strength masked region measured `[14,32,80]` in the exported file.
- [ ] None of this is reachable on a clean checkout. See R19-1.

### F. Sounds tab (T19.4a) - PASS 9/8
- [x] "Sounds" is visible in the left rail (`HIDDEN_ASSET_TABS` no longer contains it).
- [x] All three sub-tabs switch correctly under a real pointer sequence.
- [x] Sound effects shows the friendly no-key state, not an empty grid and not a crash: "Sound search needs a free Freesound API key - add FREESOUND_API_KEY to apps/web/.env.local (get one at freesound.org/apiv2/apply)". `apps/web/.env.local` holds the `your_api_key_here` placeholder, which the route's `isFreesoundApiKeyConfigured` correctly rejects, and `GET /api/sounds/search` returns `{"error":"freesound_not_configured", ...}` with an empty result set rather than an error status.
- [x] Music & SFX degrades gracefully on its own terms: "Music & SFX search uses HeyGen's audio library. Add your HeyGen API key in Settings > AI > Integrations to enable it."
- [x] Saved shows its proper empty state: "No saved sounds / Click the heart icon on any sound to save it here". Hearting a sound needs a live result, so that is Dan-owed.
- [x] Both audited bugs are fixed at source. `commercial_only` is now parsed as `z.enum(["true","false"]).transform(v => v !== "false")` with the `z.coerce.boolean()` trap documented in a comment, the filter is applied in `applyEffectsFilters`, and the client sends it on the INITIAL fetch (observed as `?page_size=50&sort=downloads&commercial_only=true`). `loadMore` now builds a `URLSearchParams` instead of the positional-args call that used to throw.
- [ ] Live search, live load-more and the commercial filter's effect on real results need a real Freesound key. Dan-owed.
- Note: R19-6 above, the failure mode that hides all of this when the rate limiter is unreachable.

### G. Caption looks (T19.4a) - functionality PASS, bleed REOPEN
- [x] All 12 looks are present in the Captions tab: Plain, Neon Accent, Pill Karaoke, Weight Shift, Editorial, Highlight, and the 6 new ones Outline Pop, Drop Shadow, Broadcast, Minimal Mono, Highlighter, Cinema Bar. The grid count stays even.
- [x] Every look applies to all elements named "Caption N" on an overlay text track and raises the "Styled N captions as X" toast.
- [x] The 6 new looks each fully set what they control. Outline Pop writes `strokeWidth=6` and zeroes `shadowBlur`/`shadowOffsetY`; Broadcast writes its own background, letterSpacing, stroke and shadow set.
- [x] One undo reverts a whole restyle across all 4 captions at once (they go into one `BatchCommand`), confirmed by reading all four elements after the undo.
- [ ] Param bleed between the old and new looks, in both directions. See R19-4.

### H. Stickers prune sanity (T19.4a) - PASS
- [x] The app builds, typechecks and runs (all four gates green), so nothing the prune removed was load-bearing for startup.
- [x] There is NO stickers tab. The left rail is exactly Media, Sounds, Text, Shapes, Effects, Captions, Transcript, Settings, and no UI anywhere offers a sticker browser.
- [x] The resolver spine survives as planned: `resolver.ts`, `registry.ts`, `sticker-id.ts`, `intrinsic-size.ts`, `types.ts` and `providers/{index,flags,countries-data}.ts` remain; `index.ts` browse/search (317 lines), `categories.ts`, `providers/logos.ts`, `providers/shapes.ts` and most of `providers/flags.ts` are gone.
- [x] Legacy projects with sticker elements still resolve: `stickers/__tests__/legacy-project-resolve.test.ts` is present and green inside the 2690.

### Dan-owed (Round 19)
1. **npm publish `opencut-wasm` 0.3.0 and repin both `package.json` files** (needs his npm auth; checklist in `rust/wasm/README.md`). Until then nothing in T19.0/T19.1/T19.2/T19.4b renders on a clean checkout. See R19-1 for the interim workaround and for why the documented local-link loop does not currently substitute for this.
2. **A real Freesound API key** (free, 2 minutes) to unlock live sound search, load-more and the commercial filter.
3. **An Anthropic key** for the live prompt-to-edit assistant (carried from R17).
4. **The crop-keyframes decision** (carried; defer still recommended).
5. **Feel checks on real footage**: whether a 0.5s dissolve reads right on his own cuts, whether the 8 Adjust presets flatter real skin tones, and whether a chroma key on a real green screen holds up at the hair line. All of the above was measured on synthetic ffmpeg fixtures.

## Round 17 (Assistant) + T21.1 onboarding verification (2026-08-01, T17.5, branch `feat/director-eval`, tip `6702b2dc`)

Closing verifier pass for T17.1-T17.4 (the prompt-to-edit Assistant) and T21.1 (the /get-started onboarding page). Freeze frame was deliberately OUT of scope (a parallel worktree agent owns that fix). Environment: dev server on localhost:3000 via the launch entry; screenshots were unavailable the whole session (Browser pane not compositing), so every interactive check ran on DOM reads and DOM-dispatched clicks/keys, and synthetic pointer clicks from the computer tool silently no-oped (documented below so the next verifier does not chase it). Fresh-profile state was simulated by clearing the pane's localStorage and deleting its two leftover "New project" IndexedDB test projects from earlier agent sessions (no real footage or Dan data involved).

### Gates
- G1 `bun test` apps/web: 2446 pass, 0 fail. PASS.
- G1 `bun test` hf-bridge: 210 pass, 0 fail. PASS.
- G2 `bunx tsc --noEmit` from apps/web: 0 errors. PASS.

### A. Assistant chat UI, mock mode (T17.3) - PASS
Mock driven via `localStorage["vibecut-assistant-mock"] = "1"` (the documented dev-only flag in real-assistant-service.ts).
- [x] Assistant tab present in the right dock (Properties | Director | Assistant); empty state shows the three example chips; a chip pre-fills the composer (send is a deliberate second click, so the user can edit first).
- [x] "Cut the silence at the start": streamed reply bubble, then "Applied: 3 changes" chip with an Undo link; Undo invokes the service undo handle (a no-op in mock mode by design; in real mode it drives the command-stack undo, guarded by canUndo so a stale/double click cannot corrupt the stack).
- [x] "speed up the second clip": proposed-ops confirmation card with per-op icons + timecodes ("Set clip "B-roll 2" to 2x speed", "Shift everything after it 3s earlier"), composer disabled while held; Confirm morphs the card in place into "Applied: 2 changes" and re-enables the composer; Cancel path is client-side (unit-covered, reducer tests).
- [x] "cut the boring part": clarifying question grounded in a concrete range ("The section from 2:10-2:45 has three long pauses...") with two quick-reply chips; clicking one sends it as the next user turn and consumes the chips.
- [x] Unmatched prompt: plain capability reply, no edit event.
- [x] "do something impossible": friendly error bubble ("I can't do that here - it's outside what this editor can change..."), composer re-enables, no raw error anywhere.
- [x] Ctrl+/ from the Properties tab switches the dock to Assistant and focuses the composer (verified via panel CSS class + activeElement).
- [x] Escape blurs the composer back to the global shortcut scope (activeElement returns to body).
- [x] Preview-toolbar mini-prompt: typing + Enter opens the Assistant tab with the text pre-filled and focused, and clears the mini input.
- [x] History survives reload: all five bubble kinds (user, text, applied chip, clarifying, error) restored per project after a full page reload, and again after switching mock -> real mode.

### B. Real mode, no Anthropic key (graceful block) - PASS
- [x] With the mock flag OFF and no key anywhere, sending a prompt POSTs `/api/assistant/edit`, the route answers 400, and the chat shows exactly "The assistant needs an Anthropic key - add one in Settings > AI." as a friendly bubble; no hang, no raw error, composer re-enables. This is the expected state of this environment: apps/web/.env.local has no ANTHROPIC_API_KEY, and Dan's own provider mode is Claude Code, which this route does not support yet (it needs Anthropic tool calling). The live-LLM turn is therefore Dan-owed (see below), and per the round mission this block is a key-availability fact, not a defect.

### C. Executor spot evidence (no live LLM) - PASS
- [x] Per-file unit counts (all green, part of the 2446): executor 43, turn-service 28, tools 67, context 20, snapshot 15, op-summary 13, director-dock-coexistence 5, template-catalog 2, template-defaults 12, adapter (real-assistant-service) 13, reducer 28, history-store 9.
- [x] Code read: a whole turn's commands execute as ONE `new BatchCommand(plan.commands)` (features/assistant/executor.ts, applyAssistantTurn) so one Ctrl+Z reverts a whole prompt.
- [x] Code read: confirmation thresholds are strict greater-than - MAX_UNCONFIRMED_OPS = 3 and MAX_UNCONFIRMED_DESTRUCTIVE_SEC = 10, `needsConfirmation` fires on `> 3` mutating ops or `> 10` removed seconds (features/assistant/turn-service.ts).

### D. Onboarding page, T21.1 - PASS
- [x] Fresh profile: /projects shows the dismissible first-run banner ("New here? See how VibeCut works - 2 minutes.") linking to /get-started; Dismiss writes `vibecut-onboarding-dismissed=1` and the banner stays gone across reload. Banner is correctly absent once a project exists.
- [x] /get-started renders the intro, the 3-step flow (Import / Let AI cut it / Polish and export), and the three tool cards (AI Cut, Edit by transcript, Auto captions) with plain-language explainers.
- [x] Pre-project: all three "Try it" buttons AND both "Add your key in Settings" buttons disabled with title "Create a project first", plus the inline hint line. Post-project: all enabled, hint gone.
- [x] Provider cards reflect real state: Anthropic "Connected. Using your Claude subscription on this device (the Claude Code app), no key needed." (claude-code mode wording); Groq "Connected. This VibeCut deployment already has a shared Groq key..." (the env's server GROQ_API_KEY, detected via the probe). Get-a-key links only render when not connected.
- [x] Privacy note present ("Bring your own keys, they stay on this device").
- [x] "Add your key in Settings" deep link: routes to `/editor/<id>?open=ai-settings`, lands on the assets panel's Settings tab on the AI sub-view (Claude subscription card + transcription provider options visible), and the `?open` param is stripped from the URL.
- [x] "Get started" header link on /projects; the "Set up AI" indicator links to /get-started#connect-ai, shows the amber warning dot only when setup is needed, and its tooltip flips to "AI is set up" when both providers resolve connected (as they do in this env).
- [x] Unit evidence: 26 pass across get-started provider-status/page tests, first-run-banner.test.ts, deep-link-open.test.ts.
- Note (not a defect): on the very first editor visit, the "Welcome to VibeCut" changelog dialog opens on top of the deep-linked Settings panel; after closing it the panel is there. Worth a glance from Dan for feel.

### E. Template polish, T17.4 - PASS on unit + code evidence
The mock path never inserts a real template (its `applied` events are scripted), and the real insert path needs a live LLM turn, so this feature is scored on unit + code evidence per the round mission.
- [x] template-defaults.test.ts: 12 pass. Absent "accent" fields fill from the project-derived accent (color-utils.deriveAccent), absent "color" from the contrast-safe foreground, kinetic-title's font defaults to Anton, enum position fields take the template's declared preset; LLM-supplied variables always win; duration falls back to each template's defaultDurationSec in validateInsertTiming.
- [x] Show-me mode: `showInsertedElement` seeks the playhead to the earliest inserted element's start and pauses, only for additive-only turns (executor.ts; dedicated describe blocks in executor.test.ts); the inserted element ends up selected because every insert command already returns a `CommandResult.selection`.
- [ ] The actual LOOK of a prompted template on real footage (designed, not default-stamped) is Dan-owed with the live-LLM run below.

### G6 scores (round 17 + T21.1)
| Feature | Functionality | Quality | Verdict |
|---|---|---|---|
| T17.1+T17.2 assistant engine (schema, executor, turn service) | 9 | 9 | DONE (live-LLM turn Dan-owed, not a defect) |
| T17.3 chat UI + real-service integration | 9 | 9 | DONE |
| T17.4 template polish | 9 | 9 | DONE (visual look Dan-owed) |
| T21.1 onboarding page | 9 | 9 | DONE |

### Left for Dan (round 17 + T21.1)
- [ ] THE live-LLM Assistant run (the one check nobody else can do): give the assistant route an Anthropic key, then run the conversation script for real ("delete the second clip", "extend the intro clip by 2 seconds", "add a lower third saying Hello at 0:30", "speed up clip 3 to 2x", one ambiguous ask, one impossible ask) and confirm each lands on the timeline with one Ctrl+Z per turn. Two ways to provide the key: (1) paste a device key in the editor under Settings > AI (Anthropic API key field, stays in this browser), or (2) add `ANTHROPIC_API_KEY=sk-ant-...` to `apps/web/.env.local` and restart the dev server. Your current Claude Code subscription mode does NOT cover this route yet; that gap is tracked for T21.2 provider work, not as a round-17 defect.
- [ ] Judge a prompted motion template's look on real footage (T17.4's whole point): "add a title that says ..." should come out palette-matched and sensibly placed, with the playhead parked on it for inspection.
- [ ] The Welcome-dialog-over-Settings first-visit layering (note in section D): fine per this pass, but see if it feels wrong on first run.
- Carried from round 18 (unchanged, still owed): real-footage freeze/reverse/crop feel, export playback with sound, speed-curve pitch listen, freeze-desync re-listen once the parallel fix lands.

## Round 18: parity quick wins + VibeCut home verification (2026-08-01, T18.6, branch `feat/director-eval`, tip `70cb9fb5`)

Closing verifier pass for T18.1-T18.5. Media: 38.07s clip, 88-word System.Speech TTS muxed over an ffmpeg testsrc video, staged temporarily at `apps/web/public/verify-r18.mp4` for the sandboxed preview pane and deleted afterward (git status confirmed clean). Screenshots were unavailable the whole session (Browser pane not compositing), so verification ran on DOM reads, editor state via `window.__vibeEditor`, and export file readback (ffprobe, frame extraction, volumedetect). Two environment shims, both page-side only, no code edits: requestAnimationFrame mapped to setTimeout (the hidden tab never fires rAF, which otherwise stalls the media-import toast pipeline), and the exported blobs were POSTed to a temporary localhost receiver to reach ffprobe on disk.

### Gates
- G1 `bun test` apps/web: 2405 pass, 0 fail. PASS.
- G1 `bun test` hf-bridge: 210 pass, 0 fail. PASS.
- G2 `bunx tsc --noEmit` from apps/web: 0 errors. PASS.

### A. Freeze frame (T18.1) - PASS with one real defect
- [x] Playhead at 2s, toolbar button: clip splits at exactly 2s, a real captured 1280x720 PNG still (ephemeral asset, kept out of the media bin) is inserted for 3s, downstream video clips shift right 3s, ONE undo reverts the whole batch.
- [x] Context-menu "Freeze frame" on the clip does the identical thing.
- [x] Playhead off-clip: toast "Move the playhead over a video clip to freeze it".
- [x] Export proof: frames at t=3.5 and t=4.9 are the identical source-2.0s frame (testsrc digit "2", frozen gradient bar); video resumes correctly after the still.
- [x] **NEW BUG (reopens T18.1): the linked separated audio does NOT shift.** The video track ripples +3s but the audio clip stays at its old position, so every word after the freeze plays 3s early relative to picture, and no desync badge appears. Confirmed in live state (audio track untouched by the freeze batch) and audible/measurable in the exported file. `buildFreezeFrameBatch` ripples only the target track.
- [x] FIXED and RE-VERIFIED 2026-08-01 (fix `3e81c839`, re-rate at tip `f00edced`): the linked audio now splits at the freeze point in the same SplitElementsCommand call and its right half rides the ripple. Live state after a 2s freeze on a 38.07s clip: the audio right half starts at tick 600000, exactly where the video right half starts, both share one fresh linkId, trims mirror the video. A second freeze at 10s split the already-split halves again correctly (both lanes at 1560000). No desync badge rendered. An unlinked voice clip on its own audio lane spanning the freeze point did not move. One undo reverted each freeze to a byte-identical timeline snapshot (JSON compare), including removal of the ephemeral still asset from the bin. Gates at re-rate: apps/web `bun test` 2452 pass 0 fail, `tsc --noEmit` 0 errors.

### B. Reverse (T18.1 + T18.2 trim fix) - PASS
- [x] Speed tab Reverse toggle sets retime.reversed on the clip AND its linked audio; Speed field shows 1.00 and disables; the tooltip "Audio is muted while reversed" is on the Reverse row (code-confirmed; hover not reproducible in the automated pane).
- [x] Audio silent while reversed: resolveEffectiveAudioGain returns 0 for reversed clips, the single choke point shared by preview and export, unit-tested.
- [x] Split a reversed clip at 2s: frame-continuous at the cut (left half source window [36.07, 38.07] played backward, right half [0, 36.07]; both meet at source 36.07).
- [x] Reversed trim directions, live-dragged on the real handles: LEFT edge drag ate the source TAIL (trimEnd 2 to 3, trimStart untouched), RIGHT edge drag ate the source HEAD (trimStart 0 to 1, trimEnd untouched). This is the T18.2 fix working in the UI, not just in compute-resize tests.
- [x] Export proof of backward playback: timeline 14.0 shows source frame 19, timeline 16.0 shows source frame 17 (testsrc counter read from extracted frames).
- [ ] Backward playback during live SCRUB: preview canvas renders black in this non-compositing pane (WebGL draw loop tied to visibility), so scrubbing visuals are Dan-owed; the export proof above covers the sampling math end to end.

### C. Crop (T18.1) - PASS except keyframability
- [x] Transform tab Crop group (Left/Top/Right/Bottom %): typing Left 10 commits crop.left 0.1 live, one undo clears it.
- [x] Crop button toggles handle mode: exactly 4 edge-handle buttons plus a dim-mask SVG overlay appear (the transform handles are replaced); Escape exits the mode (overlay gone).
- [x] The drag pipeline (previewElementCrop live layer, commitPreview as ONE undoable command, undo restores) verified through the same manager calls the handles drive; the raw on-canvas pointer gesture could not be exercised because screenToCanvas depends on the degenerate hidden-pane viewport (Dan-owed feel check).
- [x] Old project loads uncropped: the 8-clip round-16 project opens with crop null on every element, no errors; also unit-tested (crop-serialization).
- [ ] **Spec gap (reopens T18.1 alongside the freeze bug): crop is not keyframable.** The UI says "Crop applies before Motion's scale/position. Not keyframable yet." while the roadmap line says keyframable. Implement or have Dan descope.
- Re-rate note 2026-08-01: crop keyframability was a pre-authorized v1 descope per the T18.1 task brief (ship non-keyframable and say so). It is Dan's open decision, not a defect; the re-rate scores against the descoped spec. The line above stays open for Dan.

### D. Speed curves (T18.2) - PASS
- [x] All 7 chips present. Each preset applied a distinct curve and retimed the 38.07s clip correctly: Montage 30.45s (6 pts), Hero 45.32s (5 pts), Bullet 15.60s (5 pts), Jump Cut 14.45s (8 pts), Flash In 27.69s (3 pts), Flash Out 27.69s (3 pts), Custom 38.07s editable 3-point flat curve.
- [x] Graph point drag: middle point pulled up committed rate 2.73 at t=0.5, duration 38.07s to 20.43s, one undo step. The graph tracks the pointer live; the timeline duration commits on release.
- [x] Reverse while a curve is active clears the curve (retime becomes rate 1 reversed, duration back to 38.07s).
- [x] Audio follows: the linked audio element carries the identical curve points in state; the renderer-sync unit test (curve-renderer-sync.test.ts) pins preview-vs-export sampling at inflections, per-frame, monotonic.
- [x] Export proof: the Bullet-curved tail shows source frame 26 at timeline 25 (2s into the segment), i.e. compression is real in the file.
- [ ] Audible pitch behavior (curve + Change pitch toggle) needs speakers: Dan-owed.

### E. Audio fade handles (T18.3) - PASS
- [x] Top-left corner handle drag inward committed fadeInSec 2.0 (matches drag px at current zoom); top-right set fadeOutSec; the fade curve overlay renders on the clip.
- [x] One undo per drag: undo reverted only the fade-out drag (fade-in stayed 2), redo restored it.
- [x] Audio tab numeric fields mirror the handles (read 2/2 after the drags); typing a value commits on blur.
- [x] Cannot cross: fade-in 40 on the 38.07s clip clamped to the full duration and forced fade-out to 0 (the edited side has priority, resolveFadePair).
- [x] Trim shorter than fades: effective values clamp at read time via clampFadesToDuration (raw params kept, unit-tested), verified with a live 4s trim.
- [x] Export proof: first exported second measures mean -33.0 dB vs -20.6 dB steady state, the 5s fade-in ramp is in the mixdown. (The tail window was silent source audio, so the fade-out ramp was not measurable on this clip.)

### F. Export options (T18.4) - PASS
- [x] Popover: resolution picker Project size (1280x720) / 2160p / 1080p / 720p with a live "Output: WxH" label (3840x2160 and 1280x720 both observed).
- [x] Bitrate labels scale with resolution: 2/6/12/24 Mbps at 720p, 18/54/108/216 Mbps at 2160p (9x pixels, 9x bitrate).
- [x] "Also export captions (.srt)" appears when a transcript exists AND still appears after deleting words (lineage-aware follow-up).
- [x] Export at 1080p (non-native) with SRT checked: exactly two files (New project.mp4 1920x1080@30 h264+aac, duration 38.06s; New project.srt). The SRT reflects the cut: the deleted word is gone, its segment shrank instead of dropping (round-16 fix holds through the export dialog), and the surviving second segment's timecode matches where that word's audio actually plays on the edited timeline.
- [x] The composite project (freeze + reverse + curve + fades) exported with all four effects verifiably present in the file (see sections A/B/D/E export-proof lines).
- Note: the in-browser Whisper transcript of this synthetic TTS clip was a 4-word hallucination ("Thank you. Thank you."), enough to exercise the SRT flow but not a rich remap test; the heavy SRT remap coverage remains round 16's live pass plus unit tests.

### G. VibeCut home + wordmark (T18.5) - PASS
- [x] /projects shows the VibeCut wordmark (own SVG, /logos/vibecut/wordmark.svg, weight-900 text, invert/dark:invert-0 theme handling) and the hero tiles: New project / AI Cut / Edit by transcript / Auto captions, each with a description.
- [x] Deep links: AI Cut opened the newest project with the Director dock active ("AI CUT: review and cut the whole video" panel) and the URL stripped to /editor/id; Edit by transcript opened with the Transcript panel showing; both live-verified.
- [x] Favicon files replaced in the T18.5 commit (b3b1f6eb); /favicon.ico serves the new 827-byte mark.
- [x] Footer says VibeCut (component text: "VibeCut", current-year copyright).
- [ ] Disabled-tiles-with-hint on a profile with zero projects: not reproducible live without deleting Dan's existing projects; deriveHeroTileStates and the deep-link param logic are unit-tested (hero-tiles.test.ts, deep-link-open.test.ts) in the passing suite. Dan-owed only if he cares to see the empty state.
- [ ] Dark/light visual readability: markup handles both themes but no screenshot was possible this session.

### G6 scores (round 18)
| Feature | Functionality | Quality | Verdict |
|---|---|---|---|
| T18.1 freeze + reverse + crop | 9 | 9 | DONE, re-rated 2026-08-01 after fix `3e81c839` (tip `f00edced`); crop keyframes stay Dan's call |
| T18.2 speed curves | 9 | 9 | DONE |
| T18.3 audio fade handles | 9 | 9 | DONE |
| T18.4 export options | 9 | 9 | DONE |
| T18.5 VibeCut home + wordmark | 9 | 9 | DONE |

Re-rate 2026-08-01: T18.1 re-scored 9/9 at tip `f00edced` after the freeze linked-audio fix (`3e81c839`); evidence on the section A and C lines above. The round 18 G6 gate is now met.

### Left for Dan (round 18)
- [ ] Real-footage freeze/reverse/crop FEEL: scrub over a freeze still, drag the 4 crop handles on canvas, reverse a real clip and listen for the mute, judge the cut texture at a reversed split. The automated pane cannot composite the preview canvas, so all visual-feel checks here are yours.
- [ ] Export playback on your machine: play an exported MP4 end to end with sound (this pass verified the file contents via ffprobe and extracted frames, not a human viewing).
- [ ] Speed curve pitch: play a curved clip with Change pitch on and off and confirm the audio chipmunks vs stays natural.
- [ ] Hero tiles empty state: on a fresh profile (no projects) the three AI tiles should render disabled with a hint until the first project exists.
- [ ] The freeze-frame desync fix, once landed, needs a re-listen on real footage (dialog before AND after a freeze staying in lip sync).

## Round 16: transcript x Director hands-on verification (2026-08-01, T16.4, branch `feat/director-eval`)

Agent hands-on pass on real speech media (no Dan's own footage was available in this environment). Media: since no bundled speech fixture exists in the repo and synthetic tone audio (testsrc + sine) produces no real transcript, speech was generated with Windows PowerShell `System.Speech` TTS and muxed over an ffmpeg `testsrc` video (11s clip, 31-word sentence). Both browser panes used: the sandboxed preview pane could not reach any localhost port other than the declared dev server, so file injection into the Assets panel had to go through the Chrome extension bridge (`claude-in-chrome`) with the video staged at `apps/web/public/verify-speech-test.mp4` temporarily and deleted afterward (confirmed clean via `git status`).

### Gates
- G1 `bun test` apps/web: 1942 pass, 0 fail (target 1942+). PASS.
- G1 `bun test` hf-bridge: 210 pass, 0 fail (target 210+). PASS.
- G2 `bunx tsc --noEmit` from apps/web: 0 errors. PASS.
- G5 `diag-join-the-group.ts`: ASSERTIONS PASSED (R1a, R1b, R2, R3, band). PASS.
- G5 `diag-join-verdicts.ts`: ran entirely against the existing `.eval-cache` (0 new cache files written, so no live LLM budget spent). Result: recall 9/16 (56%), precision 9/10 (90%), 19 word-bearing fragments graded. This is BELOW the round 16 target (recall >= 11/14, precision 11/11) and the fragment totals themselves differ from the target's implied baseline (19 graded here vs 14 CUT fragments expected), which per the "compare cache keys before crying regression" lesson from a prior round means this number may not be comparable to whatever run produced the 11/14 target. Not re-run live to avoid burning API budget; **flag for the next agent to re-run with a fresh cache-key check before treating this as a confirmed regression.**

### Panel UX (T16.3) - verified
- [x] Header shows "Transcribing..." during the run, then "Transcript ready - N words" (31 words for the test clip).
- [x] Click a word seeks the playhead there; active-word highlight tracked the playhead during playback.
- [x] Search highlights matching words.
- [x] Follow-playback toggle visually ON by default (blue/active icon).
- [ ] Auto-scroll during playback and hover-suspends-follow-then-resumes-after-2s: NOT exercised. The 11s test transcript never overflowed the panel, so there was nothing to scroll or hover-suspend. Needs a longer clip or a real project to verify.
- [ ] Toggle state survives reload: not exercised (would need a page reload mid-session, skipped to conserve time budget).

### Manual delete, pipe, restore (T16.2) - verified
- [x] Selecting 3+ words and deleting shows a thin RED PIPE (not strikethrough) between the surviving words; timeline range removed on all tracks (V1 and A1 both split); one Ctrl+Z undoes the whole delete.
- [x] Clicking the pipe opens a window: "Manual delete", timecodes (e.g. `00:01.3 - 00:02.3`), removed words shown struck through.
- [x] Selecting a subset of words inside the window updates the button to "Restore N words"; clicking it re-inserts exactly that range as one undoable command, downstream clips and linked audio shift right by the restored duration, the pipe stays, and reopening the pipe shows only the still-cut words.
- [x] Ctrl+Z on a restore reverts it (words go back into the pipe).
- [x] "Restore all" clears the pipe, merges the clip fragments back into one, transcript reads continuous; Ctrl+Z brings the pipe back.
- [x] A second delete immediately after a prior delete/restore/undo cycle applies with no "Timeline changed - refresh" block.
- [ ] External edit the lineage cannot explain (check 8): trimmed the last fragment's right edge directly on the timeline. The transcript panel did NOT show a refresh-needed flag afterward, staying on "Transcript ready - N words". This may mean the lineage's source-map math correctly explained the trim (a good sign, better than full re-transcribe-on-any-change), or it may mean the stale-detection is not wired for simple trims. Recorded as-is per the check's own "expected, record it" framing; not treated as a bug without further product direction on what SHOULD count as unexplainable.

### NEW BUG - export drops any segment containing a cut (T16.2/T16.3 point 4)
Repro (minimal, confirmed twice):
1. Transcribe a clip with 2+ sentences/segments.
2. Select 3+ words INSIDE the first segment/sentence (leaving other words in that segment) and delete them via the transcript panel.
3. Export as .srt (or .txt or .csv) from the panel's export menu (the three-dot menu next to Copy).
4. The exported file is missing the ENTIRE first segment/sentence, even though the live transcript panel correctly shows that segment with only the cut words removed. Only segments that were never touched by a cut appear in the export.
5. Confirmed NOT history-dependent: reproduces on a single fresh delete with no prior restore/undo. Confirmed the baseline (fully unedited transcript) exports correctly, and a full restore back to the unedited state also exports correctly, so the bug is specific to a segment that currently has an ACTIVE (unrestored) cut somewhere inside it.

This blocks G6 quality scores for T16.2 and T16.3 below 9 (see roadmap doc statuses) and needs a code fix, not just a docs note.

**FIXED (G6 reopen) - live re-verify pending.** Root cause: `viewFromRecord` in
`features/transcription/lineage.ts` decided a segment's fate by testing the SEGMENT's own
midpoint against the merged removal spans, so a cut in the middle of a sentence contained
that sentence's midpoint and dropped the whole segment. The panel hid it (it renders the
view's `words`); the Export menu did not (txt/srt/csv all serialize `segments`). Segments
are now derived from the same word journal the words are: a segment survives while any of
its words do, its text and bounds shrink to the surviving extent, and only a segment with
nothing left is dropped. Word-less captures shrink from the journal ranges directly.
`components/assets-view.tsx` now also adopts the view's segments unconditionally, so a
cut-everything timeline can no longer export a stale transcript. Covered by
`features/transcription/__tests__/lineage-export-segments.test.ts`.
Re-verify with the repro above, plus: delete inside the LAST segment; delete a span
crossing a segment boundary; delete a whole segment (it should vanish from the export);
restore all and confirm the export matches the pre-delete file exactly.

### Director provenance (check 9) - partially verified, live LLM available
A working LLM provider WAS configured in this environment (Settings > AI > "Claude subscription (Claude Code)"), so this was NOT blocked.
- [x] AI CUT > AI Director ran end to end on the test clip and proposed one op (a trailing dead-air cut, "0:09.5-0:10.1 - Trailing silence (0.8s) after the last speech").
- [x] Apply worked ("Director's cut - applied", "Applied 1 of 1"); timeline shortened by the cut duration.
- [x] Director dock stayed fully functional (interactive, no lock-up, no infinite spinner) after a manual transcript delete performed AFTER the Director apply, confirming the 2026-07-28 dock-resync fix still holds for this newer edit path.
- [ ] Director-sourced red pipe with category + reason: NOT exercised. The only op the LLM proposed on this synthetic clean-TTS clip was a trailing dead-air cut with no words on either side of it, so no pipe was expected or produced (a pipe requires words removed BETWEEN two surviving words). The merged unit tests are the only coverage for the Director-provenance pipe rendering path; a real multi-take/filler-laden clip is needed to exercise this live. Recommend re-running this check against one of Dan's real recordings in a future round.

### Exports (check D)
- [x] Export menu offers .txt (with an "Include timecodes" sub-toggle), .srt, .csv; all three download correctly from the panel.
- [ ] FAILS after a cut is active: see the new bug above. Exports on the unedited transcript, and exports after a full delete+restore-all cycle (net zero cuts), are both correct; only a transcript with an active, unrestored cut somewhere in a segment triggers the bug.

### Left for Dan / a future round (superseded by the G6 re-rate below; kept for history)
- [ ] Groq live key check: a Groq key IS stored in Settings, but running transcription with "Groq (cloud)" selected FAILED ("Transcript failed to load - Transcription was interrupted") with no clear "check your key" messaging and no fallback to in-browser. Could not tell whether the stored key is genuinely invalid/expired in this environment or whether this is a real regression in the cloud path; needs Dan to test with a known-good key.
- [ ] Director live run on REAL footage with fillers/retakes/repeats, to actually exercise a Director-sourced pipe with category + reason (this pass only had a clean TTS clip, which gave the Director nothing to cut except trailing silence).
- [ ] Auto-scroll and hover-suspend-follow on a transcript long enough to overflow the panel.
- [ ] The `diag-join-verdicts.ts` recall/precision gate: re-run with a fresh cache-key comparison before treating the 9/16, 9/10 result as a confirmed regression from round 16's lineage/journal changes.

## Round 16 G6 RE-RATE (2026-08-01, T16.4 re-rate, tip `97a61dfa`)

Second agent pass after the round-16 G6 fix cycle, re-checking the three defects that kept
T16.1-T16.3 below 9. New media this pass: a 41s clip, 6 sentences / 113 words (long enough
to overflow the transcript panel), Windows `System.Speech` TTS muxed over an ffmpeg
`testsrc` video via the `claude-in-chrome` bridge (file staged at
`apps/web/public/verify-speech-test.mp4`, deleted after, confirmed clean via `git status`).

### Gates
- G1 `bun test` apps/web: 1976 pass, 0 fail. PASS (up from 1942, matches the 14 new export
  tests + 20 new Groq-fallback tests from the fix cycle).
- G1 `bun test` hf-bridge: 210 pass, 0 fail. PASS.
- G2 `bunx tsc --noEmit` from apps/web: 0 errors. PASS.
- G5 diag gate: NOT re-run, per the fix-cycle's own cross-commit forensics. The prior
  round's recall 9/16 / precision 9/10 reading was diagnosed as an instrumentation
  artifact, not a real regression: running `diag-join-verdicts.ts` at the pre-round-15
  commit and at tip, with the `.eval-cache` held fixed, produced byte-identical diag
  output. The re-baselined reproducible number is recall 12/16, precision 12/13, 19
  fragments. This defect is CLOSED; do not re-run it again without a fresh cache-key
  reason to suspect drift.

### EXPORT BUG RE-VERIFIED - PASS
Repro from the original bug report, plus the two additional scenarios the fix note asked
for. All four confirmed on the live app, not just unit tests:
- [x] Baseline (unedited) export of .txt/.srt/.csv: all 6 sentences present, correct
  timecodes, SRT numbered 1-6.
- [x] Delete 5 words inside the FIRST sentence ("the Round 16 Re -Verification" cut from
  "Welcome to **the Round 16 Re -Verification** Pass for the video editor."): re-exported
  .txt/.srt/.csv all show "Welcome to Pass for the video editor." as segment 1, all 6
  segments still present, timecodes shifted down by the cut duration, SRT still numbered
  1-6 from the top.
- [x] Delete a 4-word span CROSSING the segment 1/segment 2 boundary ("video editor. This
  clip"): both segments shrink independently and stay as two separate rows ("Welcome to
  Pass for the" / "contains several full sentences...") - neither segment is dropped, they
  are not merged into one row.
- [x] Restore-all after both deletes: exported .txt/.srt/.csv are BYTE-IDENTICAL to the
  baseline files (diffed with `diff`, zero output on all three).

This closes the "export drops any segment containing a cut" bug from the previous pass.
Root-cause fix (`viewFromRecord` deriving segments from the word journal instead of a
segment-midpoint test) holds under a boundary-crossing case the original repro did not
cover.

### GROQ ERROR PATH RE-VERIFIED - PASS
Settings > AI > Transcribe on "Groq (cloud)" with an invalid key (`gsk_invalid_test`)
stored, then a genuinely fresh transcription attempt (cache cleared, no prior "current
value" for the timeline's audio hash). Confirmed at the network level, not just the UI:
intercepted the `fetch` call and captured `POST /api/transcribe -> 401,
{"error":"Groq key rejected - check your key."}` in 200ms, immediately followed by a normal
local-Whisper transcription that completed to "Transcript ready - 113 words" - a plain
transcript, not an error screen, not a hang. The UI's own progress line for this moment
(`${cloudError.message} - using local transcription...`, i.e. "Groq key rejected - check
your key. - using local transcription...") is broadcast by the same code path that produced
the captured network response; it was too fast (well under a second) to catch as DOM text
in this automated pass, but the network proof plus the visible fallback-then-success outcome
together confirm the fix works end to end. Cloud transcription was disabled and the test key
cleared afterward (Settings back to "In browser", key field empty).

### AUTO-SCROLL FOLLOW - PARTIALLY VERIFIED
- [x] Overflow condition reproduced: with the 113-word / 41s clip and the transcript panel
  at its normal size the content did not overflow (551px content in a 551px box), so the
  panel was zoomed via `document.documentElement.style.fontSize` (a genuine
  content-vs-viewport ratio change, not a code edit) until the transcript genuinely
  overflowed its scroll container (337px content in a 309px box).
- [x] Follow-playback toggle is ON by default.
- [x] Toggle state survives reload: turned OFF, reloaded the page, confirmed it read back
  OFF from `localStorage`; turned back ON to restore the default.
- [ ] Live scroll-tracks-playback, hover-suspends-follow, and manual-scroll-suspends-then-
  resumes-after-2s were NOT exercised this pass. The automated browser tab used
  (`claude-in-chrome`) reported `document.hidden: true` / `document.hasFocus(): false` for
  the whole session, which throttles the app's requestAnimationFrame-driven playback timer
  in Chrome; clicking Play advanced the displayed time by under one frame and then froze,
  reproducibly, across multiple fresh page loads. This reads as a tab-visibility artifact of
  the automation environment, not a product defect: the pure suspend/resume timing logic
  (`isFollowSuspended` in `features/transcription/follow-playback-suspend.ts`) is unit-tested
  (5 cases: idle, pointer-over, within-window, resumes-after-window, exact-boundary) and
  passing in the G1 gate above. Per the round's own "unit-proven code paths don't block the
  score" allowance, this is recorded as a Dan-owed live check, not a new defect.

### SPOT-CHECK - PASS
One manual delete (5 words) -> red pipe appears -> restore 2 of the 5 words -> pipe stays
(only the remaining 3 cut words shown on reopen) -> restore all -> pipe gone (0 pipes in the
DOM) -> undo chain: three `command.undo()` calls trace exactly back through
113 -> 110 -> 108 -> 113 words, i.e. restore-all undone, then restore-2 undone, then the
original delete undone, landing back on the clean 113-word baseline with zero pipes. (Undo
was driven through the editor's own `command.undo()` API rather than the Ctrl+Z key
combination - keyboard-shortcut delivery was unreliable through the automation bridge in
this session; the underlying undo/redo history mechanism itself is what was being tested and
it reversed every step exactly.)

### Left for Dan / a future round (current)
- [x] **Real Groq key success path - DONE 2026-08-01.** A real server-side `GROQ_API_KEY`
  (`apps/web/.env.local`) was live-verified end to end with a fresh dev server (port 3000,
  confirmed via server logs showing `.env.local` loaded) on branch `feat/director-eval` at
  `92d7c8c7`. Settings > AI showed "Server key detected, cloud transcription available
  without a key", the in-app Groq key field was confirmed empty (value length 0, never typed
  into), and the backend was set to "Groq (cloud)". A fresh 26.7s / 67-word TTS+ffmpeg clip
  (System.Speech over an ffmpeg testsrc video, never seen by the transcript cache before) was
  imported and transcribed. Evidence: `POST /api/transcribe` returned **200** and the
  transcript panel read "Transcript ready - 67 words" with properly punctuated,
  word-timestamped text within seconds of opening the Transcript tab (no visible
  loading wait), consistent with the cloud round-trip described in the Settings copy.
  Spot-check integration on the same clip: clicking a word seeked the playhead
  (00:00:00:24, matching that word's position); selecting 2 words and deleting them
  showed the expected red pipe; exporting as .srt produced correct sequential timecodes
  and the segment containing the cut correctly shrank instead of dropping (the round-16
  export-segment-drop fix still holds). A temp clip was staged at
  `apps/web/public/verify-groq-fresh.mp4` for the browser-extension import bridge and
  deleted afterward (confirmed clean via `git status`). No retries needed; the call
  succeeded on the first attempt.
- [ ] Director-sourced red pipe with category + reason on REAL footage with fillers,
  retakes, or repeats (this pass's synthetic clean-TTS clip gives the Director nothing to cut
  except trailing silence, so no pipe is ever produced to inspect).
- [ ] Live scroll-follow-during-playback, hover-suspend, and manual-scroll-suspend on a real,
  focused browser tab (see AUTO-SCROLL FOLLOW above - blocked on tab visibility in this
  automated pass, not unit-test coverage).

## Round 12: join cleanup, final read, and run feedback (2026-07-19, commits `51bc9bd9`..`1338ba04`, branch `feat/director-eval`)
Built from your 2026-07-19 verdict ("the AI doesn't consider what the final product looks like when it cuts", the stranded "so...", the sliver clips). Three parts. What to check on a real run:
- [ ] **No more sliver clips.** Tiny wordless fragments between two cuts are now swallowed automatically. Your timeline should not show those 1-2 frame orphans at cut joins any more.
- [ ] **Join rows read sensibly.** Where a cut leaves a short stranded fragment, you get an unchecked **Join** row quoting it (`Stranded between two cuts: "so..."`). Are these landing on the right fragments? Measured against your four finished videos: 15 of 18 were things you cut yourself.
- [ ] **The pre-checked ones (this is the weak part, tell me if it annoys you).** An AI final-read pass reads the video as it would actually play after all cuts and pre-checks the fragments that break flow. Measured: it never wrongly pre-checked anything (0 for 3 on the fragments you deliberately kept), but it only catches about a third of the ones you would cut. So expect to check several Join rows by hand. If it ever pre-checks something you wanted, that is a bug worth reporting immediately.
- [ ] **Failed runs now leave a card, not silence.** This is the fix for your "nothing happened" run. If a run dies you get a persistent card in the dock naming the stage and what went wrong, with **Retry** and **Dismiss**, instead of a 15-second toast you can miss by looking away. Agent-verified in-app (card renders, Dismiss clears, a new run clears it).
- [ ] **Completion is announced.** A "Director's cut ready - N proposed changes" toast when the review opens.
- [ ] **Nothing can hang forever.** Every AI call now has a timeout and the transcription worker can no longer die silently. If a run stalls it should now FAIL visibly rather than spin. If you ever see it spin past ~5 minutes on one stage again, tell me.

## Round 11: fewer auto-checked repeat cuts (2026-07-18, commit `06784d9d`, branch `feat/director-eval`)
A repeat detector was auto-checking cuts on no real evidence: when you say a phrase twice inside ONE sentence ("we are going to start this up, we are going to launch a small instance"), its safety check was comparing that sentence against itself and always passing. Those rows now start UNCHECKED. Measured across all four eval fixtures, the one-click apply destroys **a third less of your kept dialog** (suite mean 29.7 to 19.9 words); nothing was removed from the review list, so every one of those cuts is still one click away.
- [ ] **The trade, which is yours to judge.** One-click apply now cuts less on its own: it does less damage, but it also leaves more for you to check off. On a real run, does the safer default feel right, or did the Director get too timid? If it feels timid, say so and I will narrow the rule to only the cases where you repeat a phrase deliberately.
- [ ] **The unchecked rows read sensibly.** Rows demoted this way say `repeats INSIDE one sentence: a stumble or deliberate emphasis, review before cutting`. When you hit one, is it usually a stumble you WOULD cut? If nearly all of them are, that is the signal to loosen the rule.

## Recall-pass consolidation — retake/structural always on (2026-07-18, commits `8ceabc51`..`6641603e`, branch `feat/director-eval`)
Addendum 9 measured it (match up on all four fixtures, one-click harm identical), so per your round-5 framing the retake and structural passes now ALWAYS run and their two Settings toggles are gone (store v4 migration drops the old fields silently). What to feel for on a real run:
- [ ] **More review rows, same safe apply.** Runs now surface retake + structural rows (all unchecked opt-ins) every time. The one-click apply should feel unchanged; the review list is longer. If the extra rows feel like noise rather than recall, say so - the levers are the pass floors, not the deleted toggles.
- [ ] **Run time.** Every Director run now makes 3 extra LLM calls (retake, structural, verify). If runs feel meaningfully slower, tell me and I'll look at parallelizing the passes.

## Director round 9 — review defaults + dock UX (2026-07-18, commits `048a8d01`..`5e9d0bc7`, branch `feat/director-eval`)
Your four asks from the finished-video run. AGENT-VERIFIED live in-app (2026-07-18, synthetic plan through the real dock + timeline, numeric via `window.__vibeEditor` + the new `window.__directorPlanStore` dev hook): speculation and smooth-filler rows start unchecked with badges + hints; timestamp click seeks to start minus lead-in and plays (29.0s at 1s, 25.0s at 5s for a 30s cut); slider updates store + label; no Done in any phase; Apply 60s -> 56.4s, uncheck restored the 3s segment (59.4s), recheck re-applied, panel persisted. Also verified pipeline-side by the four-fixture eval: speculation ops are OFFERED-only on every fixture, fillers shifted heavily AUTO -> OFFERED. What's left is the TASTE judgment only - run **AI CUT → AI Director** on your real footage and confirm:
- [ ] **Speculation tagging matches your intent.** The model should tag YOUR coherent trailing musings (kept, unchecked) but still auto-cut incoherent rambling. If it mis-files one direction or the other, tell me the clip time and I'll tighten the prompt rule.
- [ ] **Smooth-filler split matches your ear.** Mid-flow fillers unchecked, paused fillers auto-cut. If one lands on the wrong side, note the timestamp - the dial is `SMOOTH_GAP_SEC` (0.2s) in filler-words.ts.
- [ ] **The lead-in feel.** Default 1s: is that enough runway on real footage, or should the default be 2s?
- Known edge (by design): if you leave A/B on "Preview original" and start a new run, flip back with the A/B button first.

## Ripple-drag live preview (2026-07-17, commit `3d93a3d9`, branch `feat/director-eval`)
Closes round 8's known v1 limitation: with **Ripple editing ON**, a right-handle trim now shifts the downstream clips ON SCREEN during the drag instead of them jumping at mouseup. Numerically verified in-app (3 butted clips; preview shifts tracked the drag both directions, a drag back to the origin restored exact base positions, and the commit matched the final preview to the tick). Confirm the FEEL on real footage:
- [x] **Shrink:** ripple ON, drag a clip's right handle LEFT → everything downstream (all tracks) slides left WITH the drag, keeping spacing; release → nothing jumps. VERIFIED 2026-08-01 (round 15, T15.5): live `previewOverlay` showed the downstream clip + linked audio shifted mid-drag to match a -500px (~10s) shrink, before mouseup.
- [x] **Extend:** drag the right handle RIGHT → downstream slides right during the drag; release → no jump. VERIFIED 2026-08-01 (round 15, T15.5): same mechanism confirmed via the magnet path (T15.2): a real +400px (~8s) extend drag pushed the downstream clip + its linked audio by the exact delta, live during the drag.
- [x] **Bail-out:** mid-drag, come back to where you started → everything sits exactly where it began. VERIFIED 2026-08-01 (round 15, T15.5): dragged a shrink back to the exact starting clientX before mouseup; preview and the final commit both matched the pre-drag baseline byte-for-byte (trimEnd/duration/startTime all reverted exactly).
- [x] **Unchanged paths:** ripple OFF right-trim, and any LEFT-handle trim, behave exactly as before (left-handle ripple still applies only at commit; that path is the per-track heuristic, not this preview). VERIFIED 2026-08-01 (round 15, T15.5): with magnet OFF and ripple OFF, a right-trim extend correctly walled at the neighbor's edge with no ripple; left-handle trims (magnet ON) pin the clip's start and clamp only at the true source limit, not the neighbor.

## Audio-separation regression on multi/selected bin drags (2026-06-24, commit `ab77bcd5`)
Fixed: the multi-asset drag path stopped separating source audio (regression from `6ac45541`), so dragging selected clips combined audio into the video. Now separates in-batch onto a shared audio track. Drag-drop is DOM-bound → live-verify in-app:
- [ ] **The regression:** select 2-3 videos in the bin, drag one onto the timeline → all land, each with its audio on a **separate audio track**, video+audio **linked** (move/trim together).
- [ ] **One undo:** a single Ctrl+Z removes the whole multi-drop (clips + separated audio + any new tracks).
- [ ] **No explosion:** all separated audio packs onto **one** shared audio track, not one per clip.
- [ ] **Single unselected drag** still separates (the path that already worked). If it does NOT, that's a separate bug in `maybeSeparateAudio`/the `separateSourceAudio` wiring — flag it.
- [ ] **Audio-only assets** dragged in a multi-selection add normally (no phantom separated-audio track); a **video with no audio** (`hasAudio:false`) adds no empty audio track.

## AI CUT words-on (Plan A U1/U2/U5, 2026-06-24, commit `bdebf823`)
The Director's analysis transcription now uses a WORD-CAPABLE model so the word-level detectors re-arm. U1 spike confirmed `whisper-tiny_timestamped` emits word timestamps headlessly; in-app uses onnxruntime-web (parity expected but unverified).
- [ ] **tiny-timestamped LOADS in-app** — run AI CUT / AI Director and confirm the analysis transcription completes (no init-error). If it fails to load, revert the one-line `selectAnalysisModel` change or fall back to a registered words-off model. (The shipped probe-degrade only catches word-*capability* at decode, NOT a model load failure — this is the one real risk of U2.)
- [ ] **Word detectors re-arm** — duplicate-words / filler / dead-air (and phrase-repeat on the redundancy-pass fallback) now produce review rows on a real source, where before they were dark.
- [ ] **Short-clip transcript-quality trade** — short sources now use tiny-timestamped (was whisper-small, words-off). Watch whether the *worse transcript text* hurts the LLM redundancy pass / segment cuts on short clips. If so, the fix is the accuracy tier (confirm `base_timestamped`/`medium.en_timestamped` load in-app, then tier them in `selectAnalysisModel`).
- [ ] **VAD dead-air (U3+U5, BUILT — opt-in, live-verify).** Turn ON **Settings → AI → "Director dead-air (VAD)"** (default off). A Silero VAD worker (`@ricky0123/vad-web`, loads its model from a CDN on first run) scans the decoded audio for long silent/non-speech gaps and adds them as **dead-air** cut rows in the Director review. Confirm: (a) the toggle works + the VAD model downloads once; (b) silent stretches show up as dead-air rows (overlap-filtered, no doubles with pacing); (c) with the toggle OFF, the Director is byte-identical to before (zero regression); (d) a VAD failure (e.g. offline first run) doesn't break the Director — it just skips dead-air. The worker is browser-only so this is the part I couldn't verify headlessly.
- [ ] **VAD-gated transcription (U4, BUILT — opt-in, live-verify).** Turn ON **Settings → AI → "Speech-only transcription (VAD)"** (default off, separate from the dead-air toggle). On the analysis path it runs VAD first, transcribes ONLY the concatenated speech, and remaps times back to the timeline. Confirm on a long/gappy source: (a) transcription is faster + no hallucinated text over silence; (b) **cut points still land at the right timeline spots** (this is the riskiest part — the remap; if cuts are shifted, the offset map is wrong); (c) with the toggle OFF, transcription is byte-identical to before; (d) a VAD failure falls back to full-audio transcription (no broken run); (e) captions are unaffected. Touches the CORE transcription pipeline (`transcript-cache.ts`) so verify AI CUT + Director + captions all still work with the toggle both on and off.

## HyperFrames bump 0.6.91 → 0.7.4 (2026-06-24, branch `feat/director-importance`, commit `54302f68`)
The pinned render engine was ~30 releases behind; registry blocks fetch from `main` (always-latest) but rendered against the stale 0.6.91 engine — the likely cause of AI-editing render failures. Bumped to 0.7.4 (mostly render-reliability fixes).
- [x] **Render engine VERIFIED on 0.7.4 (not pending).** `packages/hf-bridge/scripts/render-smoke.ts` drove the real `renderTemplateJob`/`bakeRegistryBlock` path: all 5 templates × 4 setting combos (1080p@30, vertical 1080×1920@24, 720p@30 max-duration, square 1080×1080@60, two look variants) + 4 registry bakes (data-chart, us-map, us-map-bubble, us-map-hex) → **24/24 rendered OK, 0 dim-mismatch, 0 duration-off**. Re-run with `bun packages/hf-bridge/scripts/render-smoke.ts` after any future HyperFrames bump. Post-bump gate: web tsc 0, 387 integration tests + hf-bridge 53 pass.
- [ ] **Plan step (claude -p) — live.** The smoke harness covers the RENDER engine only, not the LLM planning that decides WHICH effects to place. Run AI Generate on real footage and confirm the plan returns sane effects (the `claude` CLI itself is healthy — v2.1.167).
- [ ] **In-app placement — live.** Confirm rendered/native effects land on the timeline at the right spots via the actual AI Generate panel (the harness bypasses the Next route + placement).

## Dedicated LLM redundancy pass (2026-06-24, branch `feat/director-importance`, plan `docs/plans/2026-06-23-001-feat-director-repeat-detection-plan.md`)
The repeat-detection rebuild (brainstorm → deepened plan → U1-U5). Pure cores are bun-tested (llm-redundancy sanitize/dedup, candidate catalog, group→cut mapping + the lexical-detector gate + swap recompute, review hint — 337 director+route tests, hf-bridge 53, tsc 0). The LLM quality + the wiring are **live-verify only** (the route + run-director cross the wasm/LLM boundary). Needs Dan's footage + an AI connection.
- [ ] **Repeats actually caught (the whole point).** Run **AI CUT → AI Director** on the footage where repeats survived. Reworded restatements AND near-verbatim retakes should now show as **Repeat**-badge cut rows (from the dedicated `/api/director/redundancy` pass). Accept them → the redundant takes are gone. Does it catch the real repeats now?
- [ ] **Conservative, not over-cutting.** It should NOT flag distinct-but-topically-similar lines or intentional repetition (callbacks, "as I said earlier" recaps, emphasis). If it under-catches, the `REDUNDANCY_CONFIDENCE_FLOOR` (redundancy-apply.ts, default 0.7 inclusive) loosens; if it over-cuts, raise it.
- [ ] **Best take kept.** Where there are multiple takes of a line, the one left in should be the best-delivered (cleanest/loudest/least filler), not just the last. Rejecting a Repeat row keeps THAT take ("Keeping this take" hint).
- [ ] **No double-flagging (S4).** Repeats appear as ONE coherent set of rows — the lexical detectors (take-clusters/phrase-repeat/segment-repeat) stay silent when the LLM pass ran; the general cut prompt no longer proposes redundancy cuts.
- [ ] **Fallback on error.** Force the redundancy route to fail (offline / bad key) → the Director still completes and the lexical detectors run as the fallback (no crash). One extra LLM round-trip per run is expected (token cost).
- [ ] **Swap-to-alternate dropdown (U5b, now BUILT — live-verify).** Each redundancy GROUP shows a single **"Keep instead:"** dropdown (on the group's first Repeat row) listing every take by timecode + snippet. Picking a different take should instantly rebuild that group's cut rows — the newly-chosen take survives, the rest (including the old keeper) become Repeat cuts — without touching any other group's rows. Apply then removes the right takes. (A swapped group's cuts use the takes' raw line spans, so they aren't re-snapped to energy/clip edges — expect sub-frame boundary differences vs the initial cuts; harmless at line boundaries. If a group's cuts were all deduped away in the merge, it has no row and so no dropdown — expected.)

## Live-test fixes — noise take / clip border / abrupt cuts / opening repeats (2026-06-23, branch `feat/director-importance`)
All four came from Dan's live testing today. Pure logic is bun-tested (268 director tests, tsc 0, lint clean); the behaviour on real footage is yours to confirm. Dev server: run it in YOUR OWN terminal (`cd apps/web && bun run dev -- --port 3001`) — the agent's session reaps any process it launches, so the watchdog can't keep it up past the session.

- [ ] **(D) Noise-only take is now flagged.** Re-run **AI CUT → AI Director** on the footage where a few frames of pure noise (high waveform energy, no transcript words) survived. The Director should now propose a **Noise** cut row over that blip (a short, loud, word-less gap between/around speech). Accept it → the noise is gone. It's conservative: only SHORT (<0.5s) loud word-less gaps trip it, so a longer un-transcribed sound (intentional SFX) is left to the LLM. If a real noise blip is LONGER than ~0.5s and survives, tell me and I'll raise `DEFAULT_MAX_FRAGMENT_SEC` (`noise-fragment.ts`). If it over-flags quiet breaths, the `DEFAULT_NOISE_ENERGY_RATIO` (0.5× median speech) is the dial.
- [ ] **(C) Clip borders read against black.** Look at the timeline with dark/black clips: each clip now has a faint white hairline border so adjacent clips no longer blend into one black strip. Confirm it's distinct from the blue **selection** ring (the border is the clip edge; the blue ring sits just outside a selected clip). If too faint/strong, the dial is `border-white/20` in `timeline-element.tsx`.
- [ ] **(E) Cuts land in the quiet, not mid-sound.** After an AI Director cut, scrub the cut joins: they should land in the gap between words/sounds rather than clipping a word mid-syllable. Boundaries snap to the nearest low-energy trough within ±0.1s. If joins still sound abrupt, the radius `DEFAULT_SNAP_SEARCH_SEC` (`snap-cut.ts`) can grow (note: too large risks jumping into a neighbouring word). Zero-crossing snapping is the finer follow-up if envelope-trough snapping isn't enough.
- [ ] **(E, Highlight) Highlight joins are clean too.** Run **AI CUT → Highlight**: the cuts AROUND the kept spans should land in the quiet. Kept spans are expanded outward into nearby silence (directional, so a keep never clips its own first/last word — worst case it keeps a few extra frames of silence). The "keeping N of M · Xs of Ys" preview reflects the (slightly larger) snapped spans. Confirm no kept clip starts/ends mid-word.
- [ ] **(E, Auto-assemble) Auto-assemble joins are clean too.** Run **AI CUT → Auto-assemble**: the back-to-back joins between clips should have breathing room (each clip carries a little of its own head/tail silence), not a hard cut from one clip's last syllable to another's first. This path has no energy envelope, so it pads into the transcript's inter-segment gaps (`DEFAULT_ASSEMBLE_PAD_SEC` = 0.06s, clamped to the gap so it never eats adjacent speech). The review panel's `src M:SS–M:SS` shows the slightly-padded source range — expected. If joins still feel tight, raise the pad in `assembly-pad.ts`.
### Live-test round 2 (2026-06-23 — from Dan's first real Director run)
- [ ] **Cut-created slivers swallowed (2-frame no-audio + 13-frame stutter at the start).** Re-run AI Director on the same footage. The tiny remnant clips at the very start should be GONE — when a cut boundary lands within ~15 frames of a clip edge it now snaps out to the edge, swallowing the sliver. If a remnant LARGER than 15 frames survives, tell me and I'll raise `REMNANT_FRAMES_TOLERANCE` (run-director.ts). If a legit short clip gets eaten, lower it.
- [ ] **Reverse-order clips re-sequenced.** With your timestamped clips placed out of order, run AI Director: it should toast "put N clips in chronological order (by filename time)" and lay them in timestamp order before cutting (one Ctrl+Z reverts the whole run). Works on whichever video track holds them (V1 or an overlay). NOTE: it only fires when EVERY clip on the track has a parseable timestamp and they're out of order — if your clips share the SAME timestamp (your screenshot showed identical names) it can't order them and leaves them alone; in that case the content/LLM-order fallback is still a follow-up (tell me and I'll prioritize it). Supported name forms: `2026-06-22 23-37-45`, `20260622_233745`, `2026-06-22T23:37:45`.

- [ ] **Useless 2-frame head clip removed.** Re-run AI Director: a stray sub-5-frame video clip (no speech, e.g. the white-document 2-frame clip the reorder sorted to the head) now shows in the Review modal as a **cut** row "Stray clip (0.07s) — too short to be real footage". Accept it → gone. It's review-gated (so a real quick shot isn't silently dropped) — if you'd rather it auto-drop without a review row, tell me. Threshold is `MIN_USEFUL_CLIP_FRAMES` = 5 (run-director.ts); raise it if larger junk clips slip through.

- [ ] **(A) Opening paraphrased repeat — NEEDS YOUR DATA (not fixed yet).** A paraphrased repeat near the start isn't caught by the deterministic layers BY DESIGN (they're near-verbatim only), so it falls to the LLM. To tune the right layer without guessing: in DevTools console run `window.__directorDebug = true`, then **AI CUT → AI Director**. The console prints `[director-debug]` lines — the opening transcript, the **pairwise lexical similarity** of the opening segments vs the 0.8 merge bar, and whether the **LLM proposed a cut** there. Paste me those lines (or just the opening transcript text) and I'll fix the right layer — lower the take/repeat similarity bar, add a paraphrase-aware detector, or strengthen the LLM opening-redundancy prompt.

## Issue 1 — 8-video-track cap + no track-spawn on move/forward-select (2026-06-22, branch `feat/director-importance`, SEVERE)
Root cause: a group move minted ONE new track PER member, so dragging a Track-Select-Forward selection (≈189 clips) ballooned to ≈189 video tracks. Fix is two parts: (a) hard cap `MAX_VIDEO_TRACKS = 8` at every creation seam, (b) the move path collapses new tracks to one-per-source-track + respects the cap. Pure cores are bun-tested: `placement/__tests__/track-cap.test.ts` (5), `group-move/__tests__/collapse-new-tracks.test.ts` (4), and cap cases added to `placement/__tests__/resolve.test.ts`. The real `resolveNewTrackMove` collapse+cap was also command-level verified (3 clips on V1 → 1 new track; at 8 tracks → returns null) by running it against the actual code with the wasm boundary mocked. The GESTURE paths are NOT agent-testable (no drag/keypress, and the preview MCP was flaky this session) — **these need your click/drag:**
- [ ] **Forward-select drag no longer explodes (THE bug).** Press **A** (Track-Select-Forward), click early on the timeline to grab everything forward across all tracks, then **drag** the selection (to make space). It must NOT spawn a pile of new V-tracks. Worst case it lands the grabbed clips on ONE new lane (collapsed) or keeps them put — never 180 tracks.
- [ ] **Hard cap at 8 video tracks.** Add video tracks (right-click track header → Add video track, or drag clips up to new lanes) until you have 8 (V1 main + 7). The 9th attempt should do nothing / reuse the top lane — the count never exceeds 8. Audio/text/graphic tracks are unaffected (add as many as you want).
- [ ] **Drag-from-bin at the cap.** With 8 video tracks, drag a clip from the bin onto empty space above the tracks → it lands on an existing video lane, no V9 drop-line appears.
- [ ] **Normal moves still work.** Below the cap: dragging a single clip between existing video tracks, and dragging a clip up to make ONE new track, both still behave (the cap only bites at 8).
- [ ] **AI at the cap.** With 8 video tracks, RUN HYPERFRAMES / bake a block → AI clips overflow onto an existing lane instead of silently vanishing (claimLane is cap-aware) — no clips lost.
- DEFERRED (follow-up, not shipped this pass): threading the full move-group id set into the drop-occupancy probe (`excludeElementIds`) so an in-bounds horizontal shove reuses tracks with ZERO spurious new lanes. The collapse+cap already make the EXPLOSION impossible; this is a polish refinement that's browser-only to verify, so it was left for a live-verify pass rather than shipped blind.

## Issue 2 — quiet showcase clip no longer cut + no 4-frame remnant (2026-06-22, branch `feat/director-importance`)
Root cause: **Remove Silences** (`features/editing/remove-silences.ts`, which runs inside Autocut + the Director flow) flags any stretch with RMS < 0.015 as "silent" and cuts it across ALL tracks — so a quiet showcase/b-roll VIDEO clip got deleted as if it were dead air, and the 0.15s inward padding left a ~4-frame sliver at each clip edge. Fix (pure logic, bun-tested — `silence-refine.ts`, 8 cases): before cutting, `refineSilenceRanges` (a) **subtracts any video clip a silence range would fully cover** (intentional footage is protected), and (b) **snaps a cut edge that lands within 0.25s just inside a clip boundary out to that boundary** so the cut swallows the silent sliver instead of leaving it. Mid-clip pauses, gap silence, and sound-then-silence clips still cut normally. NOTE: only Remove Silences changed; the Director's own cuts (dead-air/LLM) are segment-aligned + review-gated, so they weren't touched.
- [ ] **Showcase survives.** A project with a quiet b-roll/showcase clip (visual, little/no audio) — run **AI CUT → Remove silences** (or Autocut). The showcase clip should NOT be deleted, and there should be NO tiny leftover frames where a clip got cut.
- [ ] **Real silence still cuts.** A talking-head with dead pauses still tightens (mid-clip pauses removed); a silent GAP between clips still closes.
- [ ] **No remnant on a normal trim.** Where Remove Silences cuts at the very start/end of a clip, the clip edge is flush — no 1–5 frame sliver left behind.

## Take-selection rule — keep-last + 2-min window (2026-06-22, branch `feat/director-importance`)
Replaces the old "Near-identical takes — pick one to cut yourself" punt. New rule (pure logic, bun-tested — `take-clusters.test.ts` + `redundancy.test.ts`, 15 cases): the keeper is now ALWAYS the LATEST take (recency wins outright; audio quality no longer overrides), and the earlier near-identical takes are cut — but ONLY those within `TAKE_WINDOW_SEC` (120s) of the last take. A near-identical phrase >2 min before the keeper is left alone (treated as legitimate repeated content, not a retake). N-take clusters keep the last and cut all earlier in-window members. The amber "pick one yourself" box no longer appears (the deterministic detector never punts; the rare A/B "stitch" choice is reserved for the LLM planner).
- [ ] **Keep-last on retakes.** Record/import footage with a flubbed line re-taken 2–3× back-to-back (within 2 min). Run AI CUT → AI Director: the review should propose cutting the EARLIER takes and keeping the LAST one — no "pick one yourself" note.
- [ ] **2-min window respected.** A near-identical phrase repeated much later (>2 min apart — e.g. an intro line echoed in the outro) is NOT auto-cut (no cut row for it).
- [ ] **Cluster of N.** 4–5 takes in a row of the same line → only the last survives; the earlier four are all proposed as cuts.

## AI Auto-Assemble — build a cut from the WHOLE bin (2026-06-22, branch `feat/director-importance`, P0–P4 reachable)
The flagship new feature: **AI CUT → "Auto-assemble — build a cut from all my clips"**. It transcribes EVERY bin clip (retakes + unused, cached per-asset cross-project), pools candidate spans across all clips, clusters takes bin-wide, asks the LLM to infer the story + pick the best span per beat + drop junk + ORDER them, lays the result on the main track as ONE undoable command, AND opens a **review panel in the right inspector** (P5). Pure cores are bun-tested (asset-transcribe helpers, candidate-pool, buildTakeClustersFromPool, sanitizeAssemblyPlan snap-to-candidate, placement geometry, candidate-building, the editable draft model + buildAssemblyDraft — ~35 cases). The panel UI + the LLM quality are **live-verify only** (the preview MCP was flaky this session). **Needs your footage + an AI connection:**
- [ ] **The core run.** Import a bin of raw retakes (several takes of the same lines + some unused/dead clips), nothing on the timeline. AI CUT → Auto-assemble. A coherent rough cut should appear on the main track AND the right inspector should switch to the **Director's cut** review panel. Judge the LLM's selection + ordering — that's the thing only you can.
- [ ] **Review panel — dual timecodes.** Each row shows the floating CURRENT position on the assembled timeline (mono, leading) AND the ORIGINAL source clip + in/out (`clip.mp4 · src M:SS–M:SS`). Dropping/swapping a row should shift every later row's CURRENT timecode while the ORIGINAL stays put.
- [ ] **Row-click + Play → seek and play** at that row's current position. **Drop** removes a span (the rest ripple up); the dropped span appears under "Dropped" with **Re-include** (which brings it back at its ordinal). **Swap take (N)** appears only when the line has alternates — picking one replaces the source in/out + text but keeps the slot. Each edit re-projects the timeline; Ctrl+Z steps back through edits. **Done** closes the panel, leaving the cut.
- [ ] **Non-destructive — fresh scene.** Auto-assemble creates a NEW scene ("Auto-assemble cut") and places the rough cut there; your original scene/timeline is left untouched. Use the scene tabs to switch back and compare. Ctrl+Z reverts the placement on the new scene.
- [ ] **Caching is fast on re-run.** Run it twice on the same bin — the second run skips transcription (progress shows "(cached)") and goes straight to assembling. Add/remove a clip and only the new clip transcribes.
- [ ] **Take selection.** Where you shot 3–5 takes of a line, the cut keeps ONE (the cluster is surfaced to the LLM as a `grp`, and the panel offers the others under Swap take) — not all of them, not zero.
- [ ] **Degrades sanely.** A bin with no speech → "No speech found in the bin to assemble." A clip that won't decode is skipped, not fatal. Hallucination-proof by construction (the planner can only place real source spans — `sanitizeAssemblyPlan`).
- [ ] **Take-ranking uses audio.** Per-clip audio features (loudness/wpm/filler) are now computed per bin clip (cached alongside the transcript) and shown to the LLM in the candidate catalog, so when two takes of a line differ in delivery the cut should favor the cleaner/louder one — not just whichever the transcript happens to list. (The features cache with the transcript, so re-runs stay fast.)
- NOTE: the modal cut/highlight reviews are untouched (the panel only takes over when an assemble draft is active).

## Cloud transcription — Groq backend (2026-06-22, opt-in BYO key)
Server path fully verified live without a key (route 401/400 validation; a real WAV + a fake key reached Groq and surfaced its 401 as a 500 — so route → formData → `transcribeWithGroq` → Groq → error-propagation all work). The Groq `verbose_json` → `TranscriptionResult` normalizer is bun-tested (`providers/__tests__/groq.test.ts`, 5 cases). The editor mounts clean with the new Settings section. **Only the successful Groq call needs your key:**
- [ ] **Cloud transcription e2e.** Settings → AI → **Cloud transcription** ON → paste a **Groq key** (console.groq.com, `gsk_...`). Run **AI CUT** on a real clip: transcription should return in **seconds, not minutes**, the Director review modal should show **word-level** cuts (duplicate/filler/dead-air rows — they re-arm because Groq emits word timestamps), and a ~16-min source should **not OOM** (audio is uploaded, not Whisper'd in-browser). Compare wall-clock vs in-browser.
- [ ] **Toggle off still works.** Turn Cloud transcription OFF (or clear the key) → transcription falls back to the in-browser Whisper path unchanged. A user without a key is never affected (default is in-browser).
- [ ] **Compressed upload (2026-06-22) — was the 100 MB cap.** The cloud path now compresses the 16 kHz-mono audio to a small **Opus** (`.webm`) or **AAC** (`.m4a`) blob before upload (mediabunny + WebCodecs, no new dep), so the WAV's ~115 MB/hour no longer hits Groq's 100 MB cap. **Verify:** run cloud AI CUT on a **long** source (45+ min) that previously failed the WAV upload → it transcribes; in DevTools → Network the `/api/transcribe` upload is a few-MB `.webm`/`.m4a` (not a tens-of-MB `.wav`). A short clip still works. If a browser can't encode either codec it silently falls back to the WAV (works up to ~50 min); the pure codec map is bun-tested (`media/__tests__/audio-encode-codecs.test.ts`).

## Long-video performance + transcription/preview (2026-06-20, branch `feat/director-importance`, plan `docs/plans/2026-06-20-001-...`)
Run **AI CUT → AI Director** on the long (16-min) recording that surfaced these. Pure cores are bun-tested (probe slice, analysis-model selector, streaming resampler, seek-supersede); the rest is browser-only.
- [ ] **U1 — single transcription pass.** The `[transcription] …word-level…falling back` warning appears ONCE and transcription does NOT run twice. On whisper-small the probe (~20s) catches the cross-attention failure before any full word pass. Wall-clock should be roughly half the doubled-pass time.
- [ ] **U2 — honest progress.** Within seconds of decoding, the status reads "Transcribing your video — Ns elapsed (long videos take a few minutes)", NOT "Initializing speech model — 903s". The elapsed counter advances during transcription.
- [ ] **U5 — faster model on long sources.** A >5-min timeline transcribes with **whisper-tiny** (faster); a short clip still uses **whisper-small**. Captions (Subtitles panel) are unchanged. Eyeball whether Tiny's transcript is still good enough for cut quality — if cuts get noticeably worse, raise `ANALYSIS_TINY_THRESHOLD_SECONDS` or revert to Small.
- [ ] **U4 — no audio OOM.** The 16-min source decodes for the Director WITHOUT the `createBuffer`/allocation crash at "Extracting timeline audio". Memory stays bounded. Also sanity-check that **export** audio still sounds right (export path kept the offline render — should be unchanged). Possible risk: linear-resample aliasing slightly degrades the 16k analysis audio → if transcription accuracy drops oddly, that's the suspect.
- [ ] **U3 — preview unfreezes (NEEDS RUNTIME CONFIRMATION).** Scrubbing the playhead across the cut 16-min timeline now UPDATES the preview frame (no freeze on frame 1). **This is the one fix I could not runtime-verify** — the root cause (same-time RAF repeats superseding a slow deep seek) is high-confidence from tracing + `window.__wasmPanic` being empty, and the fix (supersede by time, not count) is unit-tested, but confirm it on the actual long timeline. If it STILL freezes, capture console + tell me — do not assume the hypothesis held.
- [ ] **Preview-lag React fix — `memo(Timeline)` (2026-06-22, NEEDS RUNTIME CONFIRMATION).** On a heavy project (~137 elements), **press play** and watch: during playback the playhead/needle still moves smoothly and the preview canvas updates, but the timeline body should feel lighter (the ~137 clips are no longer re-rendering every frame). Confirm nothing visibly broke: clips, selection highlight, hover, drag, zoom, and the playhead all still update correctly while playing AND while editing. **Why:** `EditorLayout` subscribes to playback time for the bookmark overlay → re-renders every frame; `Timeline` (no props) was re-rendering with it. `React.memo(Timeline)` bails on that parent re-render. If editing/selection now feels stale or the playhead stalls, tell me — the memo could be masking a prop I missed.
- [ ] **RemoveRanges retime fix (2026-06-22, code-review hunt — NEEDS RUNTIME CONFIRMATION).** Speed-ramp a clip (e.g. 2×), then run **Remove Silences** (or Q/W ripple-trim, or AI Director autocut) so a cut boundary lands INSIDE that retimed clip. The surviving right piece should start on the CORRECT source frame (not offset by the rate factor). **Why:** `remove-ranges.ts` advanced the right remainder's `trimStart` by raw timeline ticks; it now converts through the rate (`getSourceSpanAtClipTime`), matching `split-elements.ts`. Same bug-class as the overwrite A2 fix. rate==1 (normal) clips are unchanged.
- [ ] **Transcriber scrub-hash perf (2026-06-22, code-review hunt — premise verified live, optional profile).** With a many-clip project, scrub the playhead back and forth: `computeTimelineAudioHash` should NOT recompute per mousemove (put a counter/breakpoint in it to confirm — it should fire only after an actual edit settles). Background transcription should still kick in a few seconds after a real edit. **Why:** the hash was read via a `useEditor` SELECTOR (subscribeAll), so it recomputed on every notify incl. each scrub; it now derives from the cheap `tracks` reference via `useMemo`, which only changes on edits. Verified live: 3 seeks kept the tracks ref identical (no re-hash), an insert changed it (hash still updates).
- [ ] **Ripple-mode left-edge trim (2026-06-22, code-review hunt — bun-tested, confirm the GESTURE).** Enable **Ripple editing** (timeline toolbar toggle). Two contiguous clips A[0,100], B[100,300]; drag **B's LEFT edge right** ~50 → B and everything after it should slide LEFT to close the gap (no leading gap left behind). Sanity-check it didn't over-fire: a right-edge trim still ripples (unchanged), and a plain MOVE-right of a clip does NOT get rippled away. **Why:** the ripple diff only vacated space on an endTime shrink, never on a startTime increase, so left-trims opened a gap nothing closed; it now also vacates the leading span (guarded so a move-right, where the end also grows, isn't mistaken for a trim). Pure logic bun-tested (`ripple/__tests__/diff.test.ts`, 4 cases).
- [ ] **Multi-asset bin drop (2026-06-22, code-review hunt — code-mirror of executeFileDrop, confirm the GESTURE).** Two checks: (a) **mixed types** — shift/ctrl-select a video AND an audio clip in the Assets panel, drag the group onto the timeline → BOTH land (video on a video track, audio on an audio track); nothing silently disappears. (b) **N of one type on empty space** — multi-select 3 videos, drop on empty timeline space → ONE new video track with all 3 back-to-back, NOT 3 separate one-clip tracks. **Why:** the loop reused one static drop target (one track/type) for every asset; it now re-resolves `computeDropTarget` per asset by its own type and re-reads tracks each iteration (so created tracks are reused), and only advances the cascade on a successful insert. Single-asset drag is unchanged.
- [ ] **Linked-audio speed retime (2026-06-22, code-review hunt — command-level verified, confirm the GESTURE).** Add a video with audio → right-click **Extract Audio** (creates a linked audio clip) → select the clip → **Properties → Speed → 2.0×**. The video AND the linked audio should both halve and stay in sync (audio no longer overhangs at 1×). The live preview while dragging the speed value should move both too. **Why:** speed changes went to only the inspected element; `updateElementRetime`/`previewElementRetime` now expand to retimable linked partners. Verified live via `window.__vibeEditor` (2× on a linked V+A pair → both → 45000 ticks at rate 2). An UNLINKED clip's speed change still affects only itself.
- [ ] **Left-resize of the FIRST main-track clip (2026-06-22, code-review hunt — command-sequence verified, confirm the GESTURE).** Put two contiguous clips on the main track (A then B). Grab A's LEFT resize handle and drag it RIGHT to trim A's head. A should keep its right edge fixed, its start moves right, and a **leading gap** opens before it (closeable with Close Gaps / ripple) — exactly like trimming any other clip's head, and like deleting the first clip. It must NOT snap A's right edge leftward. Also sanity-check: **dragging** (moving) the first clip toward the right still snaps it back to 0 (you can't move the first clip off the start). **Why:** the main-track `startTime` enforce-rule used to pin the earliest clip to 0 on a resize too, corrupting the geometry; it now pins only pure moves. Verified live via `window.__vibeEditor` at the command level (left-trim first clip → clean gap; move still pins; non-first trim unaffected) — confirm the actual handle-drag matches.

## AI Director — Round 2 (the cut)
Run **AI CUT → AI Director** on a talking-head clip with speech, then check the Review modal + apply:

- [ ] **Filler cuts (U2)** — standalone "um/uh/er", hedges ("you know"/"i mean"), and cut-off false-starts show as cut rows labeled *Filler "…"* / *False start "…"*. "like/so/well" are NOT auto-cut (left to the LLM).
- [ ] **Pacing cuts (U3)** — over-long pauses show as *Long pause (N.Ns) — tighten*; accepting one shortens the gap (doesn't delete the whole pause).
- [ ] **Reorder apply (U1)** — accept a reorder op and confirm the content actually MOVES; one Ctrl+Z restores everything (reorder + cuts undo together).
- [ ] **Take-selection (U3)** — the planner no longer merges unrelated lines (only near-identical re-takes).
- [ ] **Per-category taste (U4)** — reject filler cuts across two runs → the next run proposes fewer fillers (the taste note steers per category).

## AI Director — Round 1 (the dup-word fix)
- [ ] **Doubled "now" (~5:20 in ROUGH_CUT)** — re-run AI Director; the duplicate should now be offered as a cut (gap loosened to ~1s + breath/filler step-over + chunk-seam repair).

## Timeline / editor fixes
- [x] **Import → V1**: importing a video lands on V1 (main), not V2, even when a V2 overlay track exists. VERIFIED 2026-08-01 (round 15, T15.5): with a V2-equivalent overlay track already present, a bin-drag drop of a second video still landed on the sole main track (ripple-inserted, no new video track created) with its audio auto-separated onto the existing audio lane.
- [ ] **Multi-select move (forward tool)** — press **A**, then press-drag an unselected clip: it selects everything forward AND moves the group in one motion.
- [ ] **Shift + ← / →** nudges 15 frames (configurable in Settings → Hotkeys); timeline view follows the playhead; clicking the track area doesn't move the playhead (ruler does).

## Export
- [ ] **Save location first** — clicking Export opens the save dialog BEFORE the encode (cancelling costs no render); the file extension matches (mp4 when AI overlays are burned in).
- [ ] **Audio-stage progress** — exporting WITH audio shows the bar move through the first 5% instead of freezing; export no longer self-cancels when you click away from the popover.

## Move between tracks + unlink (#4 — built, needs drag verification)
- [ ] **Cross-track move (#4A)** — drag a linked video clip vertically onto another video track: the video moves, its linked audio **stays put** (no Alt needed). A genuine overlap on the target track still rejects the move.
- [ ] **Unlink (#4B)** — right-click a linked clip → **Unlink audio/video**; afterward the video and audio move/trim fully independently (the menu item only appears on linked clips; Ctrl+Z re-links).

## AI Director — Vision v0 (the cut gets eyes)
Turn on **Settings → AI → Director vision** (default OFF), then run **AI CUT → AI Director** on a clip where the speaker leaves frame / freezes / cuts to black, using an **API key** auth mode (the claude-code CLI can't take images and will degrade to text):

- [ ] **Vision toggle (U3)** — the "Director vision" switch persists across reloads; with it OFF the Director behaves exactly as before (text-only).
- [ ] **Visual cuts (U2)** — with vision ON, the Director proposes cuts whose reason references the *visual* (e.g. "speaker off-screen", "frozen frame") and the Review modal tags them with a **Vision** badge.
- [ ] **Cost notice (U4)** — a toast reports "Director vision analyzed N frames · ~Xk tokens" after a vision run.
- [ ] **Degrade fallback (U3/U4)** — on the claude-code CLI (no image support), vision ON still produces a text cut and shows "Director vision isn't available… used the transcript" (never an error).
- [ ] **Per-category taste** — rejecting vision cuts across runs makes the next run propose fewer (the "vision-based cuts" taste line steers it, separate from text cuts).
- [ ] **Frame budget** — long timelines never send more than 20 frames (an even spread across segments); the text-only path is unchanged when vision is off.

## Editor sweep — Properties panel state hygiene (U2)
Select different elements and switch the Properties panel between them:

- [ ] **Template-group switch no longer corrupts** — select template group A, then a different group B of the same template type; B's Template Controls show **B's** field values (not A's), and editing B does NOT overwrite it with A's old values. (Root cause: the tab subtree is now keyed by `element.id`, so React remounts and re-seeds every per-element `useState` on selection change.)
- [ ] **Uniform-Scale checkbox re-derives per element** — select an element whose X/Y scale differ (Uniform Scale OFF), then select one whose X==Y; the Effect Controls "Uniform Scale" checkbox reflects the NEW element's state (checked), not the previous element's. (Same remount; ScaleRows seeds `useState(sx === sy)` fresh.)
- [ ] **FxGroup collapse re-derives per element** — collapsing a Motion/Opacity group on one element does not carry the collapsed state to the next selected element (each starts at its default).
- [ ] **Multi-select header shows** — multi-select two UNRELATED clips → a compact "N elements selected — editing <name>" header renders above the tabs (edits apply to the representative). A single selection, a linked V/A pair, or a single template group does NOT show the header.

## Editor sweep — Keyboard shortcuts & native affordances (U3)
- [ ] **Bare key on a focused toolbar button** — Tab to (or focus) a toolbar toggle (Snapping/Ripple/etc.) and press **Space/Enter**; it ACTIVATES the button (native) instead of firing toggle-play / goto-start.
- [ ] **Shortcuts still fire on a focused clip** — click a clip (clip body is `<button tabindex="-1">`), then press **s** (split) / **Space** (play) — they still work (the interactive guard excludes `tabindex="-1"`, so clip focus doesn't suppress shortcuts).
- [ ] **Ctrl+C with no timeline selection** — select some page text (a transcript line / label) with nothing selected on the timeline and press **Ctrl/Cmd+C**; the native browser copy runs (text lands on the clipboard). With a clip selected, Ctrl+C still does the editor copy.
- [ ] **Ctrl+R with no selection** — press **Ctrl/Cmd+R** with nothing selected; the browser reloads (no longer eaten by the speed panel). With a clip selected it still opens the Speed panel.
- [ ] **Held key** — hold **s**; it splits once, not repeatedly (one-shot). Hold an arrow / seek key; it still auto-repeats (scrub).
- [ ] **Zoom-out chip** — Settings → Hotkeys: the *timeline zoom out* shortcut shows a single **-** chip (not two blank boxes / a duplicate "+").

## Editor sweep — Cursor feedback (U4)
Sweep the cursor across the preview canvas and the timeline (no tool armed unless noted):

- [ ] **Canvas hover cursor** — hovering a selectable element on the preview shows the **move** cursor; hovering a **text** element shows the **text** cursor (hinting double-click-to-edit); over empty canvas it's the default arrow. While space-pan is armed the **grab/grabbing** pan cursor still takes precedence.
- [ ] **Clip grab cursor (idle)** — hovering a timeline clip body shows the **grab** (open-hand) cursor and a faint **brightness** lift on hover — distinct from the blue selection ring. The left/right resize handles still show **w-resize / e-resize** (unchanged).
- [ ] **Grabbing during drag (no flicker)** — press-drag a clip: the cursor stays **grabbing** for the WHOLE drag, even as the pointer leaves the clip rect and crosses other tracks/labels (no flicker to the underlying cursor). On drop/cancel it restores to normal.
- [ ] **ew-resize during resize** — drag a clip's edge handle: the cursor stays **ew-resize** for the whole resize gesture and restores on release/cancel.
- [ ] **Forward-tool track cursor** — press **A** (Track Select Forward): the track surface shows the distinguishing **e-resize** cursor; disarm the tool and it reverts.
- [ ] **Body cursor always restores** — after ANY drag/resize (commit, cancel via Esc, a drag that snaps back within threshold, or navigating away mid-gesture) the global page cursor returns to normal and text selection works again — the body cursor is never stuck.

## Editor sweep — Handle geometry & text-resize (U5)

**Handle viewport-clip (full-bleed rotation/top handles) — buildable, shipped:**
- [ ] **Rotation handle grabbable on a full-bleed element** — select an element that fills the whole canvas (e.g. a full-frame background image/video). Its **rotation** handle (the round icon ~24px above top-center) and the **top-left/top-right corner** handles are now visible and grabbable — they paint just past the canvas top edge instead of being clipped away.
- [ ] **Handles don't escape into neighbor panels** — those edge handles paint at most ~36px (`HANDLE_OVERLAY_HEADROOM_PX`) past the viewport top/bottom; they do NOT spill over the preview toolbar, the panel border, or adjacent panels.
- [ ] **Scene still clips (zoom in)** — zoom the preview past 100% so the canvas is larger than the viewport: the rendered scene + letterbox are still clipped at the viewport edge (no canvas bleed). Pan around — still clipped. (The scene moved into its own `overflow-hidden` wrapper; only the handle overlay escapes.)
- [ ] **Masks unaffected** — enter the Masks tab on an element: mask handles/outline render correctly (the mask-handle root went `overflow-visible` too).
- [ ] **Normal centered elements unchanged** — a normally-sized, centered element's handles look and grab exactly as before.

**Narrow-clip resize-handle overlap — buildable, shipped:**
- [ ] **A 1–2-frame clip is still movable** — zoom the timeline so a clip renders narrower than ~16px, select it: only a single thin (4px) RIGHT resize handle shows; the rest of the clip body is a **move** zone (press-drag the body to reposition it). Previously the two 8px handles covered the whole body and you could only resize, never move.
- [ ] **Narrow clip still resizable** — that thin right handle still trims the clip (e-resize cursor).
- [ ] **Normal-width clips unchanged** — a normal clip still shows BOTH (8px) left + right handles at `-left-1`/`-right-1` as before.

**Text-resize discoverability (ANCHOR — gated on a live repro you must confirm):**
- [ ] **Placing text leaves handles visible** — arm the Text tool, click on the canvas to place text. The new text element is auto-selected and its **transform handles are visible immediately** (static analysis confirms `InsertElementCommand` returns a selection result and placement does NOT auto-enter edit mode). You should be able to resize from a corner right away.
- [ ] **Edit-mode affordance** — double-click a text element to enter caret-edit mode: a **dashed ring** now outlines the editable box and a small **"Esc or click away to resize"** hint appears just below it. Press Esc (or click away) → handles return → resize from a corner works.
- [ ] **ANCHOR (Dan's report) — confirm the exact repro:** place text → try to resize from a corner. **Does placing text drop you into edit mode (no handles)?** Per static analysis it should NOT — placement auto-selects with handles visible, and only double-click enters edit mode. Confirm this fix (the edit-mode ring + hint) makes resize reachable/discoverable. **If the cursor / handles are ALSO missing during plain SELECTION (not edit mode), REOPEN** — that would be a live-only bug static analysis could not reproduce (the cursor pipeline + handle render are correct in isolation; U4 already wired the `move`/`text` hover cursor). In that case capture which state you're actually in (selected vs editing) when the corner-resize cursor is missing.

## Editor sweep — Accessibility (U6)
Best checked with a screen reader (VoiceOver / NVDA) plus a keyboard pass:

- [ ] **Icon buttons named** — the preview Play/Pause button announces "Play"/"Pause" (state-dependent) and Fullscreen announces "Toggle fullscreen"; the timeline zoom in/out buttons announce "Zoom in/out timeline"; the assets-bin Assemble / view-mode / sort icon buttons announce their action (not an empty/"button" label). Tooltips still show on hover.
- [ ] **Toggles announce pressed** — the timeline toolbar toggles (Auto snapping, Ripple editing, Audio waveforms, Linked selection, Bookmark) expose `aria-pressed` — a screen reader says "pressed"/"not pressed" as you toggle them, and each has an accessible name (the tooltip string). The momentary buttons (Split, Duplicate, Delete, etc.) do NOT report a pressed state.
- [ ] **Ruler no longer a frozen slider** — the timeline ruler is no longer announced as a slider stuck at 0 (it dropped `role="slider"`/`tabIndex`/`aria-value*`). The real slider is the playhead (still announces live position + arrow-key seek). Mouse scrub on the ruler is unchanged.
- [ ] **Director modal — checkbox styled + described** — open the AI Director review modal: each op row uses the app `Checkbox` (matches the rest of the UI, clicking the row toggles it), and the dialog has an accessible description ("Review each proposed change and apply the ones you want — Ctrl+Z restores everything") read by the screen reader on open. (Dialog padding is handled separately in U7.)
- [ ] **Alt+← / Alt+→ nudges a selected clip one frame** — select a clip, press **Alt+ArrowLeft/Right**: it moves exactly one frame (collision/track rules match a mouse drag — an overlap on the destination blocks the move). Holding the key repeats the nudge. The selection stays on the moved element(s). Ctrl+Z undoes each nudge.
- [ ] **Unbound actions appear in the Hotkeys editor** — Settings → Hotkeys: `Stop playback` and `Toggle ripple editing` (and any other action shipped without a default key, e.g. the new nudge actions show their Alt+Arrow keys) now appear in the list with a **"Not set"** record button so they can be bound. Previously the editor listed bound keys only and hid them.

## Editor sweep — Visual polish (U7)
Mostly compile/visual-trivial; sweep the editor once:

- [ ] **Theme icon reflects mode** — toggle the theme: in **dark** mode the button shows a **sun** (Sun03Icon → "switch to light"), in **light** mode a **moon** (Moon02Icon → "switch to dark"). The icon now flips (previously frozen on the sun); the sr-only label ("Light"/"Dark") matches the icon's target mode.
- [ ] **Director review dialog has padding** — open the AI Director review modal (AI CUT → AI Director): its content (title, description, op rows, Cancel/Apply) is no longer flush against the dialog border — there's `p-6` breathing room all around.
- [ ] **Variant picker dialog has padding** — RUN HYPERFRAMES (authored engine) → "Versions ×3" → open the picker: same `p-6` padding; the version cards no longer touch the dialog edge.
- [ ] **Source-audio context-menu icon reflects state** — right-click a video clip with source audio: the "Separate / Re-merge source audio" item now shows an **Unlink** icon when the source audio is already separated and a **Link** icon when it isn't (previously both states showed a frozen scissor icon).
- [ ] **"Export clips" is disabled** — right-click a bin asset: the **Export clips** item is now greyed-out / non-clickable (it had no handler — a silent no-op — and now matches the disabled "Replace media" convention).
- [ ] **Promotions tooltip text color** — (compile-trivial) the `promotions` tooltip variant uses a valid `text-red-900` (was the invalid `text-redb-900`, which Tailwind dropped → no color). The light-mode promotions tooltip text is now the intended dark red.
- [ ] **HyperFrames Stop button placed correctly** — start a RUN HYPERFRAMES run: the destructive **Stop** button appears next to the run button (in the flex row, `gap-1` spacing) and aborts the run. It's no longer a stray child inside the Radix `<Tooltip>` (between trigger and content) — the run-button tooltip still shows on hover with no layout glitch.
- [ ] **Font params use the full FontPicker** — select a text/template element with a font property; the font control is now the full **FontPicker** popover (Google Fonts + system fonts + search, with live previews), not the old 12-font hardcoded dropdown. Picking a font previews + commits it (same onPreview/onCommit path); the value shows in the trigger.
- [ ] **Timecode field doesn't trap you on invalid input** — (low-nit) click a timecode to edit, type garbage (e.g. "abc"), then click away: the field now **reverts to the displayed time and exits edit mode** (was: stuck in the red error state with Escape the only way out). Pressing **Enter** on invalid input still shows the inline error (active commit gets feedback); a valid entry still commits on blur or Enter.

## Editor sweep — Error/edge hardening (U8)
The pure pieces (empty-export decision, audio finite-duration guard) are unit-tested (`export/__tests__/can-export.test.ts`, `media/__tests__/duration.test.ts`); the toast + Director paths are live-verify:

- [ ] **Empty-project export is blocked before the save dialog** — open Export on a project with a **0-duration timeline** (no clips, or all clips trimmed to nothing): the **Export button is disabled** (with a "Add footage to the timeline to export." hint), and if reached programmatically `handleExport` shows `"Add footage to the timeline first"` and returns **without opening the OS save-location picker**. Previously you picked a save destination first, THEN got "Project is empty". Add a clip → Export re-enables and the picker shows as normal.
- [ ] **Malformed / streaming audio imports with a sane default** — import an audio file whose `HTMLMediaElement.duration` is non-finite (Infinity for a live/streaming source, or 0 for a malformed/truncated file): it imports as a normal asset using `DEFAULT_NEW_ELEMENT_DURATION` (no throw, no zero-length element on paste/drop to the timeline). A normal finite-duration audio file imports with its real length (unchanged). *(Hard to hit with everyday files — a 0-byte/truncated `.mp3` or a live HLS handle is the repro; the finite-check itself is unit-tested.)*
- [ ] **Zero-import shows a neutral (not green-success) toast** — drop ONLY unsupported files (e.g. a `.txt` + a `.zip`) into the bin so 0 assets are actually added: you now see per-file **error** toasts AND a single neutral **info** toast "No media assets were uploaded" — NOT the old **green success** "No media assets were uploaded" that contradicted the errors. A normal import (1+ added) still shows the green success ("X media assets have been uploaded").
- [ ] **Director cancel restores the pre-run timeline in one step (fixed; was a MINIMAL toast-only fix with N+1 undo entries).** Run **AI CUT → AI Director** on an EMPTY timeline (so it auto-assembles the bin first) with the clips placed out of chronological order (so the reorder pre-pass also fires), let it open the docked Review panel, then click **Cancel**. The timeline goes back to EXACTLY how it was before the run (no assembled footage, original clip order), in one step, with no leftover undo entry - Ctrl+Z has nothing new from this run to undo. Also check: cancelling MID-RUN, before the Review panel even opens (stop it during "Transcribing..." or "Listening to the takes..."), rolls back the same way. The revise flow is unchanged (round 9/U8): once you click Apply there is no Cancel button anymore (the panel switches to the "applied" phase); toggling a row after Apply still revises the applied cut in place, and Ctrl+Z still restores everything from Apply. (The Review surface is a persistent DOCKED panel now, not a modal - there's no separate outside-click/Esc/X dismissal path to check, just the one Cancel button.) **One more thing to try:** since the panel is docked (not a modal), you can keep editing the timeline while a run is working or while the Review panel sits open. If you make an unrelated edit (move a clip, change a property) DURING a run or while reviewing, then click Cancel: your edit must survive (it's a real edit, not something the run made), and only the Director's own plan gets discarded - the toast will say the plan was discarded but your other edit stays, since a Cancel can never tell apart "safe to fully roll back" from "you touched something else" and always errs on the side of not deleting your work.

## Bug fix — AI CUT createBuffer crash on long timelines
- [ ] **Long-timeline AI CUT** — re-run **AI CUT → AI Director** on the ~21-min timeline that crashed with `createBuffer(2, 57460830, 44100) failed`. It should get PAST "Extracting timeline audio…" now (analysis audio mixes at 16kHz mono ≈ 83MB instead of 44.1kHz stereo ≈ 459MB). Transcription/cut quality should be unaffected (every consumer already resampled to 16kHz). Short timelines unchanged.

## AI Director — repeated-phrase cuts (cut-quality)
Re-run **AI CUT → AI Director** on the continuous recording where repeats survived:
- [ ] **Verbatim repeats caught** — when you said the same ~4+ word phrase twice nearby, the EARLIER instance shows as a cut row labeled *Repeated phrase "…"* with a **Repeat** badge (keeps the last take). Triples cut the first two.
- [ ] **No false repeats** — a phrase repeated far apart (a deliberate callback / outro recap) is NOT cut (60s window); short/common 3-word overlaps aren't cut (4-word minimum).
- [ ] **Paraphrased repeats** — re-explaining the same point in different words is now in the LLM cut prompt (REDUNDANT RESTATEMENTS + DEAD TIME); the LLM should propose more cuts for redundancy/fumbling. (LLM judgment — verify it's noticeably more aggressive; if it still leaves obvious redundancy, the detector/prompt thresholds are tunable.)
- [ ] **Per-category taste** — rejecting repeat cuts across runs makes the next run propose fewer (the "repeated-phrase cuts" taste line, separate from duplicate-word cuts).
- [ ] **Dead-air cuts** — the "figuring something out" mutter time (a dense run of *um/uh/okay…* with little content, ≥3 hesitations over ≥2.5s) shows as a cut row labeled *Dead air — N hesitations…* with a **Dead air** badge. It's conservative by design: a 2+ word real-content gap breaks the run (it never cuts real speech between two clusters), so it may UNDER-cut — if it leaves obvious mumbling in, tell me and I'll loosen the `MAX_BRIDGE_CONTENT` / span thresholds. Rejecting dead-air cuts trains its own taste line.

## AI Director — take-aware redundancy (asset-context, branch `feat/director-asset-context`)
The deterministic foundation (U1–U4) + the orchestrator wiring + keeper-safe merge (U6) are shipped (tsc + lint clean, 148 director unit tests pass). The LLM-prompt catalog enrichment (U5) and the review-modal UX for take/near-tie rows (U7) are **deliberately held** behind this gate. **This section IS the plan's R9 validation** — run it on your real multi-take footage before I wire U5.

Drop **several take clips of the same lines** into the bin, then run **AI CUT → AI Director**:
- [ ] **Cross-take dedup** — when two clips cover the same line, the weaker/earlier take shows as a cut row reading *Alternate take of "…" — kept the later/clearer version (NN% match)* with a **Take** badge. Accept it and apply: the kept take survives; the redundant one is removed.
- [ ] **Keeper safety (the P0 guard)** — across a cluster of 2–3 takes, you NEVER lose every copy of a line. Exactly one take survives even if the LLM and the deterministic layer disagree on which take to keep.
- [ ] **Far-apart repeat within one clip** — a line restated much later in a single recording shows as a *Repeat*-badge cut, but at **low confidence** (easy to reject) so a deliberate callback/recap isn't aggressively removed.
- [ ] **Near-ties are surfaced, not auto-cut (U7)** — two equally-good (equally loud) takes produce **no** destructive removal; instead an amber **"Near-identical takes — pick one to cut yourself"** panel lists each take's time range + text so you can trim the weaker one manually. Confirm no coin-flip take is silently deleted on apply.
- [ ] **Single-take footage unchanged** — a single continuous recording with no cross-clip repeats produces **no new flags** from this layer (the take-cluster path is a no-op when nothing clusters; the rest of the Director behaves exactly as before).
- [ ] **R9 dial check** — count the real duplicates in your footage by hand and compare against what got flagged. If genuine repeats **survive** (likely true paraphrase — different words), that's expected of the lexical layer and is the LLM-channel's job; if **distinct** lines get merged, tell me and I'll tighten the dials (`HIGH_SIMILAR`, `AUDIO_EPSILON`, `MIN_SAME_ASSET_GAP_SEC` are one-line constants; local embeddings are the documented escalation).

**LLM prompt enrichment (U5) + review UX (U7) — also shipped on this branch:**
- [ ] **Asset catalog in the prompt (U5)** — with ≥2 clips in the bin, the Director's planning prompt now opens with an `ASSET CATALOG` block (one line per clip: name, duration, line count, how it opens/closes) so the LLM's own cut/take judgment is grounded in the bin. A `grp` column marks alternate-take rows and tells the LLM not to re-cut them. **Single-clip input is byte-identical to before** (no catalog block, no grp column) — confirm a one-recording run is unchanged.
- [ ] **Kept-line + match % on take rows (U4/U7)** — each take/repeat row reads *"Alternate take of '…' — kept the later/clearer version (NN% match)"* so you can vet the cut without hunting for the other take.
- [ ] **Rejected-state clarity (U7)** — UN-checking a **Take** row shows *"· Keeping both takes"*; un-checking a **Repeat** row shows *"· Keeping the restatement"* — so you understand that rejecting a de-dup keeps the duplicate. Plain filler/cut rows show no such hint.

## AI Director — keep-side Phase B (importance signal, branch `feat/director-importance`)
The keep-side **pure engine** (U1 emphasis/anchor score, U5 inverse-apply ranges, U6 contiguity budget-select) + **Phase B** (the score wired into the *normal* Director: imp column, capped protection, LLM keep-pass) are shipped (tsc + lint clean, all director/hf-bridge unit tests pass). **The Highlight mode UI (Phase D) is NOT built** — gated by this validation + the LLM-keep-pass-role decision (plan Open Questions). **This IS the R9 validation vehicle** — the imp column makes the score observable; run it on real footage before Phase D.

Run **AI CUT → AI Director** on a normal recording (single recording is fine):
- [ ] **imp column reaches the planner** — the Director prompt now carries an `imp` (0-1) column per line; the LLM is told to lean toward keeping high-imp lines and cutting low-imp ones, and to emit `keep` ops on load-bearing spans. (Not directly visible in the UI — confirm via the cut quality / a debug log of the prompt if you instrument it.)
- [ ] **R9 pick-quality check** — eyeball whether the high-imp lines actually correspond to the *good* parts on your footage. On flat/monotone delivery the score flattens (emphasis-anchor, not taste — by design); if the top-imp spans aren't the good bits, that's the signal that Highlight (Phase D) needs the **LLM keep-pass as primary**, not the deterministic floor. Tell me what you see — the weights (`W_EMPHASIS`/`W_RATE`/`W_LEXICAL`, the wpm band, `PROTECT_FLOOR`) are one-line dials.
- [ ] **Protection doesn't null the cut** — on dense/energetic footage the Director still proposes a *non-trivial* cut (protection is capped at ≤8 spans / ≤40% of the timeline — it shouldn't protect everything). If the Director suddenly cuts almost nothing, the cap needs lowering.
- [ ] **No stray "Keep" rows** — the review modal shows cut/take/repeat rows as before; the LLM's `keep` ops are used silently for protection and do NOT appear as no-op checkboxes (KTD6).
- [ ] **Cut-only behavior unchanged where importance is absent** — the hf-bridge functions stay byte-identical without an imp score (regression-tested); the normal Director now always includes importance, so expect a slightly different (importance-aware) cut than before — that's the intended Phase-B lift.

## AI Director — Highlight mode / Phase D (branch `feat/director-importance`)
The keep-side is now **fully built** (U1–U8): the pure engine, Phase B (normal-Director signal), and **Phase D — the Highlight mode** (tsc + lint clean; pure cores bun-tested; 225 director/hf-bridge tests pass). The UI is **live-verify only** (bun has no DOM). Crossed the R9 gate per your call; LLM-keep-pass defaulted to **primary** for the un-budgeted highlight.

Run **AI CUT → Highlight — keep the best parts**:
- [ ] **Duration dialog** — selecting "Highlight" opens a small dialog with an optional "Target length (seconds)" field + "Build highlight" (NOT a bare menu item). Blank = keep all the good parts; a number (e.g. 60) = fit a ~Ns short.
- [ ] **Keep review surface (inverted semantics)** — the modal reads **"Highlight — review what to keep"**, rows show **Keep/Drop** (accept = keep, the OPPOSITE of cut mode), with a live **"keeping N of M · Xs of Ys (−Z%)"** preview that updates as you toggle. Bulk **Select all / Deselect all**. Confirm you don't confuse it with the cut modal.
- [ ] **Inverse apply** — "Apply highlight" KEEPS the checked spans and cuts everything else; one **Ctrl+Z** restores the whole timeline. Empty selection disables Apply ("Select at least one span to keep") — it never deletes the whole video.
- [ ] **Budget = contiguity-biased short** — a ~60s target returns a *coherent* cut (contiguous-ish runs), not a jump-cut salad of scattered 1s fragments. If it's choppy, the contiguity/min-span dials (`keep-select.ts` MIN_SPAN_SEC / MAX_RUNS) need tuning.
- [ ] **Un-budgeted = LLM-primary** — with no budget, the kept set is the LLM's load-bearing picks (keep ops) ∪ the emphasis floor; on `claude-code`/offline it degrades silently to the deterministic floor (no crash).
- [ ] **R9 pick-quality (the real test)** — are the kept spans actually the good parts? On flat delivery the deterministic floor flattens by design — that's when the LLM-primary path matters. Tell me if the picks are weak; weights are one-line dials.

## Word-timestamp blocker fix (2026-06-20, branch `feat/director-importance`)
The cross-attention crash that blocked **every** AI Director/Highlight run is fixed by a **graceful degrade**: word mode now tries `return_timestamps:"word"`, and on the "Model outputs must contain cross attentions … output_attentions=True" error falls back to a segment-level decode instead of throwing (worker.ts), flags the result `wordsUnavailable`, and the transcript cache treats that as a hit so it never re-transcribes the same timeline. tsc + lint clean; 207 director unit tests pass. **Browser-only — live-verify on real footage:**
- [ ] **AI CUT → AI Director completes on a real recording** — it no longer dies at "Transcribing…" with the cross-attention error; the plan/review modal appears.
- [ ] **AI CUT → Highlight completes** too (same `ensureTimelineTranscript({wantWords:true})` path).
- [ ] **Degrade is one-time / cached** — first Director run on a fresh timeline does the (possibly double) transcription once; a second run on the same timeline is instant (cache hit, not a re-transcribe). Check the console for the one `[transcription] This model can't produce word-level timestamps…` warning — it should appear at most once per session.
- [ ] **Word-detectors silently no-op when degraded** — on the default `onnx-community/whisper-small` (which triggers the degrade) the duplicate-word/filler/dead-air/phrase-repeat cuts simply produce nothing; the LLM cut, pacing, take/redundancy, and the keep-side importance score still work. If you WANT the word detectors back, the fix's option 2 is open: configure a Whisper export that ships cross-attentions (`models.ts`) and re-test — degrade will then keep words instead of dropping them.
- [ ] **Captions unaffected** — the subtitles/caption flow was always segment-level (no words requested); confirm caption generation still works.

## U1 spike — does a `_timestamped` model emit word timestamps? (2026-06-20, plan `docs/plans/2026-06-20-002-...`)
The whole "words back on" arc (fix repeats/fillers/dead-air) hinges on this. Two candidates are now registered + selectable. **Run the spike before U2 (the analysis-selector swap):**
- [ ] Pick **"Base (word timestamps)"** (`onnx-community/whisper-base_timestamped`) as the transcription model and run AI CUT → AI Director (or a caption transcribe). Watch the console: does the `[transcription] …can't produce word-level timestamps…` degrade warning **stay silent** (i.e., words ARE produced), and do word-level repeat/filler rows appear? If yes → **GO**: U2 can adopt it.
- [ ] If it degrades (warning fires) or errors on load, try **"Medium EN (word timestamps)"** (`whisper-medium.en_timestamped`).
- [ ] If BOTH degrade/fail → **NO-GO** on this transformers.js version: the shipped probe-degrade keeps things working (segment-level), and the words-on arc waits for a transformers.js upgrade. Tell me the result and I'll continue U2 or re-scope to VAD-only (U3–U5).
- Note: these are registered but **nothing selects them by default yet** — `selectAnalysisModel` still uses the shipped behavior until U1's verdict (intentional, avoids a download-for-nothing regression).

## Assets/timeline UX fixes (2026-06-20) — browser-only, live-verify
- [ ] **Multi-file drop onto the timeline** — drag several video files from the OS file explorer onto the timeline at once. All of them land, **laid back-to-back** (not stacked on top of each other at the drop point). Single-file drop still lands exactly where dropped. (Mixed audio+video in one drop spread along one accumulator — acceptable; the common case is multiple videos.)
- [ ] **Ctrl/Cmd+A in the Assets panel** — click into the Assets panel (select or click an asset/empty space so it has focus), press **Ctrl/Cmd+A** → ALL assets in the folder get selected (ring highlight). It does NOT trigger the timeline's select-all. Conversely, Ctrl+A while focused in the timeline still selects timeline clips (the global handler), and Ctrl+A while typing in an input does nothing special.
- [ ] **No double-fire** — with the Assets panel focused, Ctrl+A selects assets only (the global timeline select-all is suppressed via stopPropagation); with neither focused / timeline focused, the timeline select-all still works.

## Core editing bug fixes (2026-06-20) — browser-only, live-verify
- [ ] **Bug1 — timeline doesn't collapse on delete.** Build a long (~30 min) timeline, delete clips down to empty → the ruler stays at a sane zoom, NOT collapsed to ~30 frames. (Fix: empty timeline uses `TIMELINE_ZOOM_MIN`, not the 1s floor.)
- [ ] **Bug2 — AI CUT respects the timeline.** Put ONE clip on the timeline (leaving other assets in the bin) → AI CUT / Director edits only that clip; it does NOT pull the rest of the bin in. On an EMPTY timeline, AI CUT still assembles the whole bin (intended).
- [ ] **Bug3 — overwrite on drop (v2, full-length region clear).** Drop a bin asset ON TOP of an existing clip → the new clip lands at the old clip's start with its OWN full length; one Ctrl+Z restores everything. Check both directions, and that nothing downstream shifts (no ripple):
  - **Longer than the slot:** drop a long clip on a short one with clips after it → the new clip extends over them; any clip it fully covers disappears, the next partially-covered clip is head-trimmed (its remaining tail starts right where the new clip ends — no gap).
  - **Shorter than the slot:** drop a short clip on a long one → the new clip fills only its own length; the old clip's leftover tail survives, head-trimmed to butt against the new clip (no gap, no neighbour moves).
  - **Cross-type drop is now a SAFE no-op (code-review fix, A3).** Drop a video/image asset onto a GRAPHIC or TEXT clip (or any type-incompatible target) → nothing happens; the covered clips are NOT deleted. (Before the guard, the region was cleared and the mismatched insert was rejected → a hole. Verify no clips vanish.)
  - **✅ FIXED + browser-verified — overwrite that touches the EARLIEST main-track clip (was code-review A1/C1).** Root cause: the main-track startTime enforce-rule (`update-pipeline.ts:126`) snaps whatever becomes the earliest main element to 0, so a head-trimmed survivor used to snap to 0 and overlap the new clip. **Fix:** `executeMediaOverwrite` now INSERTS the new clip FIRST (it anchors regionStart, so no survivor is ever the earliest when head-trimmed), then trims, then deletes. Verified live via `window.__vibeEditor` for BOTH sub-cases — (a) longer clip onto the first main clip straddling a later one: survivor stayed put (no snap to 0); (b) shorter clip onto the only main clip: the trimmed original stayed put. **Still confirm via real drag-drop** that the on-screen result matches (new clip at the old start, survivor butted against it, no overlap, one undo restores) — the live check exercised the command sequence, not the actual drop gesture.
  - **✅ FIXED — retimed survivor in-point (was code-review A2).** A head-trimmed survivor with a speed ramp (rate ≠ 1) now advances its in-point by `cut * rate` SOURCE ticks (matching the retime resolver), not by raw timeline ticks. Bun-tested (rate 2 and default-rate cases). To eyeball: speed-ramp a clip, drop a shorter clip onto its head, scrub the surviving tail — the frame it starts on should be correct (not offset).
- [ ] **Bug4 — multi-asset drag adds all.** Select multiple bin assets, drag the group onto the timeline → ALL of them land, back-to-back. Dragging a single (or unselected) tile still adds just one.
- [ ] **Bug5 — hotkeys work immediately after add.** Add a clip (via the "+" button OR a bin drag) then immediately press Delete / gap-delete / other shortcuts → they fire without first clicking/scrubbing the timeline.

## Open follow-ups (not yet built)
- [x] **Long EXPORT createBuffer wall - BUILT (W1, 2026-07-20), live-verify pending.** Chunked audio mixing shipped: for timelines over a 192 MB cap (~9 min stereo), the export mixes the audio in 60s windows (`createTimelineAudioChunks` in `media/audio.ts`) and streams each mastered window to the encoder (`scene-exporter.ts` `audioChunks`), so peak memory stays ~one window (~21 MB) regardless of length instead of one whole-timeline buffer (~605 MB at 30 min). Short timelines keep the byte-identical `createTimelineAudioBuffer` single-buffer path. Pure window math is bun-tested + a 30-min synthetic proof (`scripts/export-mix-smoke.ts`) asserts bounded memory and correct duration. **Live-verify:** export Dan's 29-min project WITH audio to completion; confirm the file plays with correct audio through the whole length, levels sound right, and the bar moves through the first 5% during the audio stage. Note: mastering is per-window, so a mix that clips could differ very slightly at a window seam (only affects timelines long enough to be chunked, which previously could not export at all).
- [ ] **#6 playback stutter — BLOCKED on the wasm toolchain (vision-round U5 investigation).** Root-caused to the Rust compositor texture pool (`rust/crates/compositor/src/texture_pool.rs`), still unconfirmed as the *dominant* cause — needs pool-size instrumentation before any fix (don't change Rust blind). **Why it's blocked here:** the running app consumes the **published npm `opencut-wasm@^0.2.10`** (`apps/web/package.json`), not a local build — every web import is `from "opencut-wasm"`, nothing imports `rust/wasm/pkg`, and that dir was never built. This worktree also has **no Rust toolchain** (no cargo / wasm-pack / rustc). So instrumenting the Rust would (a) not run in the app and (b) not even compile-check here — exactly the unverifiable Rust the plan's gate forbids. **To unblock (needs a machine with the Rust + wasm-pack toolchain):** (1) add a pool-size readout to `texture_pool.rs` (count `available` + per-`(w,h)` bucket sizes), expose it via `rust/wasm/src/perf.rs`, surface it in `apps/web/src/diagnostics/render-perf.ts`; (2) `bun run build:wasm` → repoint `apps/web` at the local `rust/wasm/pkg` (or `bun run publish:wasm` to bump the npm package) and rebuild; (3) capture a long-session trace (`window.__renderPerf = true`) to confirm the pool climbs vs plateaus; (4) only then ship the cap/evict fix. Plan: `docs/plans/2026-06-18-002-feat-director-vision-v0-plan.md` (Phase B / KTD-6).
