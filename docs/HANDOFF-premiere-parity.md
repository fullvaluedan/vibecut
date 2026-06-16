# Handoff — Premiere parity branch

**Branch:** `feat/premiere-parity-timeline` (off `feat/round26`) · **PR:** [vibecut#48](https://github.com/fullvaluedan/vibecut/pull/48) → base `feat/round26`
**Updated:** 2026-06-16 · **HEAD:** `6a31463b`

This branch closes a large batch of Premiere-Pro parity gaps across the timeline, inspector panels, and clip transform/audio — all in our own JS/TS layer (no `opencut-wasm` fork). Everything below is committed + pushed to PR #48.

> **Verification posture (changed):** the user verifies **live on localhost** — NOT on Odysseus this round, and there is **no Hermes agent** available to the coding agent. So: ship default-safe / additive changes, keep each unit small + pushed, and let the user test. Pure logic → wasm-free bun unit tests.

---

## What shipped (on the PR)

| Area | Commit | What |
|---|---|---|
| Timeline #4 | `d088a565` | Video/image drop prefers **V1** over a free overlay (`preferMainTrackIndex`, unit-tested) |
| Timeline #2 | `a9976cab` | **Track Select (A)** gesture is momentary → the selection is draggable as a group |
| Timeline snap | `423360a4` | Move/trim **snap to markers + sequence start** (edges already cross-track) |
| Bin | `0c54ce02` | **Asset metadata** in list + preview dialog (resolution · fps · duration · codec · audio) |
| Speed | `3e3609dd` | Speed tab **target Duration** field (length ↔ rate, wasm-free math, unit-tested) |
| Project | `e387a1ed` | **Sequence Settings** — editable fps + resolution from the editor header |
| Markers | `cbd3d4b1` | **Markers** Assets tab — list bookmarks, click-to-seek, delete |
| Transform | `cf0e93f0` | **Anchor Point** — scale/rotation pivot; pure offset math (unit-tested); default anchor → byte-identical export |
| Audio | `25a4cdc9` | **Peak meters** — observe-only `AnalyserNode` on the master bus |
| Snap fix | `6a31463b` | **Drop-to-head snap** is now **drop-only + wider zone** (`SNAP_TO_START_PX` 10→28; removed sequence-start snap from the MOVE builder) |

**Tests:** 38 wasm-free unit tests pass; `tsc` clean (bar the `globals.css` false positive); eslint clean on changed code. Bun can't run `@/wasm`-importing timeline tests (pre-existing) — extract pure helpers for coverage.

---

## How to run + test the app

Dev server config already exists in `.claude/launch.json` (the harness `preview_start` config named **`framecut-dev`**, bun `--cwd apps/web run dev`, port 3000). Start it via `preview_start` (not Bash) → **http://localhost:3000**. Compiles clean in ~3s; HMR picks up edits. The interaction controllers are `useState`-held and do **not** HMR — hard-reload before iterating on drag/move/trim; inspect live via `window.__vibeEditor`.

---

## Active plan A — timeline fixes & tools (current focus)
`docs/plans/2026-06-16-001-feat-timeline-fixes-and-tools-plan.md` — 7 issues found testing the build.

| Unit | Status | Notes |
|---|---|---|
| **U1 Drop-to-head snap** | ✅ **shipped** (`6a31463b`) | Drop-only + wider zone. *Possible follow-up:* user reported a "snaps only the first time" symptom — needs their live repro (does the 2nd clip land on a different track because V1[0] is occupied, or not snap at all?). |
| **U2 Pen-tool video masking** | ⛔ **needs user repro** | `finishPenAsMask` exists in `preview/components/place-tool-overlay.tsx`. 3 possible causes: (a) no maskable clip selected, (b) `freeformCanvasPointToLocal` conversion, (c) compositor doesn't render freeform masks. **Ask the user:** did they select the clip first? what toast appears? does the shape draw but not cut? |
| **U3 Unlink linked A/V** | ⬜ to build | Clear `linkId` on the selected element + its `findLinkedPartners` (`timeline/link-elements.ts`). **Open question:** can a patch via `editor.timeline.updateElements` clear a field to `undefined`, or is a dedicated command needed? The `commands/timeline/**` path was empty on glob — **re-locate the command/mutation infra first**. Add an "Unlink" item to the clip context menu (`timeline/components/timeline-element.tsx`, alongside Split/Duplicate/Nest). |
| **U4 Duplicate track** | ⬜ to build | New track + copied elements (fresh ids) in one undoable batch; track context menu lives in `timeline/components/index.tsx`. Needs the same command-infra re-location as U3 (find `AddTrackCommand`/`InsertElementCommand`). |
| **U5 Move clips onto empty tracks** | ⛔ **needs user repro** | Move drop-target resolution rejects an empty compatible track. **Ask the user:** when dragging a clip onto an empty track, does it snap back, refuse, or land on a *new* track instead? Then fix in `drop-target.ts` / `placement/resolve.ts` / the interaction controller. |
| **U6 Rate-Stretch tool + right-click Speed** | ⬜ to build (user chose the full tool) | New `rate-stretch` armed tool in `preview/place-tool-store.ts`; edge-drag writes `retime.rate` (extend `resize-controller.ts`); `R` hotkey + rail button; right-click → opens the Speed tab. Extract the rate↔duration math as a wasm-free helper (reuse `retime/duration.ts`) + unit-test. Positive rate only. |
| **U7 Restyle Audio/Speed/Blending** | ⬜ to build | Transform tab uses `EffectControlsTab` (the target style); Blending/Audio use `ElementParamsTab`, Speed uses `SpeedTab`. Extract the FxGroup/scrub-value/stopwatch renderer from `effect-controls-tab.tsx` into a shared component; render the three through it (registry in `panels/properties/registry.tsx`). Preserve behavior exactly. |

---

## Active plan B — advanced clip & audio features (deferred until plan A lands)
`docs/plans/2026-06-15-003-feat-advanced-clip-audio-features-plan.md`. **Key finding:** `opencut-wasm` is a downstream texture-quad rasterizer fed a fully-resolved descriptor — all geometry/audio/time math is in our JS layer, so **none of these need an engine fork.** Per-unit confidence + seams in the plan.

- **Reverse speed** — *attempted + reverted* (an automated build hung, broke tsc on `services/renderer/resolve.ts`). **Rebuild fresh, don't salvage.** It's a **6-consumer** change (video resolve, blur, audio mix, preview audio, audio-stretch, waveform, split). Use a **`reversed` flag** (keep `rate` positive so the clamp/pitch/duration math stays valid) — NOT a negative rate.
- **LUFS panel** (`needles`, MIT), **Time Remapping** (keyframed curve + `signalsmith-stretch`), **Frame-blend slow-mo**, **reverse prefetch**, **Source Monitor** (zero-risk, large UI), **multi-clip Effect Controls edit (P4a)**.
- Deferred: AI optical-flow (RIFE/ONNX); razor-at-click, insert/overwrite, rolling/slip/slide, JKL.

---

## Rules for the next agent
1. **User verifies live on localhost; no Odysseus, no Hermes agent this round.** Keep changes default-safe/additive; "don't break export" is still the cardinal rule.
2. **Never fork `opencut-wasm` or `hyperframes`** — everything is doable in the JS layer.
3. **Log every upstream (opencut) file edit in `PATCHES.md` in the same commit.** New (ours) files don't.
4. **Interaction controllers are `useState`-held, no HMR** — hard-reload + `window.__vibeEditor`.
5. **One unit per focused session.** Two failures on this branch came from cramming a huge session (a hung agent + a broken revert). Commit + push per clean unit; **auto-push is OK** (user opted in).
6. **Branch:** land on `feat/premiere-parity-timeline` → PR #48 → merge into `feat/round26`.

## Suggested next step
Get the user's **U2 (pen) and U5 (move-to-empty) repro** (quick fixes once the cause is known), then build **U3 (unlink)** — but first **re-locate the command/mutation infra** (the assumed `commands/timeline/**` path was empty). Then U4, U6, U7. Plan B (reverse, etc.) after plan A.
