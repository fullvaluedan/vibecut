# Premiere Pro parity — timeline audit & backlog

Created: 2026-06-15 · Updated: 2026-06-15 · Branch: `feat/premiere-parity-timeline` (off `feat/round26`)

Goal: make the editor's timeline behave like Adobe Premiere Pro. This doc tracks the
reported issues (now resolved) plus a research-grounded, ranked backlog of the next
parity gaps. Round 25/26 already shipped a Premiere-style tool model, ripple trims,
gap selection, markers, and zoom hotkeys.

## Reported issues + hotkey — all resolved

| # | Issue | Status |
|---|---|---|
| 1 | No hotkey back to Selection (want `V`) | ✅ **Already on round26** — `activate-selection-tool` bound to `v` clears the place tool (`use-editor-actions.ts`). The report came from testing the older round-24 branch. |
| 3 | Dropped clip near the start should snap to 0:00 | ✅ **Shipped** — `computeDropTarget` snaps a mouse-dropped clip to 0:00 within ~10px of the start (`drop-target.ts`). |
| 4 | Video drop defaults to V2 instead of V1 | ✅ **Fixed this round (Option B)** — a video/image drop now prefers the main track (V1) when it fits. |
| 2 | Multi-segment selection (`A` tool) can't be moved | ✅ **Fixed this round** — the Track Select Forward gesture is now momentary; the selection is immediately draggable. |
| — | "Pressing `A` should switch to Selection" | ✅ **Resolved without a remap** — bindings stay Premiere-standard (`A` = Track Select Forward, `V` = Selection). The request was a workaround for #2; fixing #2 removes the friction. |

## What shipped this round

- **#4 — video prefers V1.** New pure helper `preferMainTrackIndex` (`timeline/placement/prefer-main-track.ts`, unit-tested in `placement/__tests__/prefer-main-track.test.ts`) redirects a video/image drop from an overlay (V2+) lane to the main track when V1 can hold the clip at the drop time. Deliberate higher placement still works: when V1 is occupied at the drop time the clip bumps up, and dropping above all tracks makes a new top track. Wired into `computeDropTarget`; `resolve.ts` stays a pure executor. **Accepted tradeoff:** hovering a *free* V2 now lands on V1 — honoring an explicit, squarely-over-an-existing-overlay hover is a deferred refinement.
- **#2 — track-tool group move.** `selectForwardFrom` (`timeline/components/timeline-track.tsx`) now disarms back to the Selection tool after selecting (`setTool(null)`), so the freshly-selected group is immediately draggable through the existing selection-driven move controller (no controller change). This is the low-risk **Option A**; the fuller-fidelity **Option B** (tool stays armed and the group drags directly, like Premiere) is a follow-up — see backlog.
- **Snapping (R4).** Clip **move** (`group-move/snap.ts`) and **trim** (`controllers/resize-controller.ts`) now snap to **markers** (bookmarks) and the **sequence start (0:00)**, on top of the existing clip-edge / playhead / keyframe snapping. A bookmarks getter was threaded through both controllers' config (mirroring `playhead-controller`). Edge snapping was already cross-track. Both paths still honor the snapping toggle + Shift-to-suppress.
- **Asset metadata.** The media bin list view now shows per-asset **resolution · fps · duration**, and the double-click preview dialog shows resolution/fps/duration/codec/audio. (Data was already persisted; only duration was rendered.)

## Beyond the timeline — the panel/inspector surface

A second audit covered everything **outside** the timeline (Effect Controls, asset metadata, sequence settings, clip speed/duration, Source Monitor, audio meters, markers/info/history panels). Key finding: **frame-rate change and clip-speed change already exist** (Assets → Settings tab; `Ctrl+R` → Speed tab) and the Effect Controls surface exists as the **Transform** tab — they were under-surfaced, not missing. The full exists/partial/missing map and a ranked build program live in **`docs/plans/2026-06-15-002-feat-premiere-panel-parity-plan.md`**.

## Ranked parity backlog (grounded in Premiere research)

Ranked by value × bounded-risk. Each item should graduate to its own `ce-plan` → `ce-work` cycle.

1. **Razor at click-point (`C` as an armed cut tool).** Today the Razor button splits at the playhead; Premiere's `C` cuts at the clicked frame (`Shift+C` cuts all unlocked tracks). High value. Sequence **after** #2 — both touch `timeline-track.tsx` click routing.
2. **Selection-tool trim affordance + `Ctrl`-ripple.** Premiere's `V` shows a trim cursor on a clip edge and `Ctrl`/`Cmd` turns it into a ripple trim — so editors never switch tools for quick trims. Normal trim exists (`resize-controller`); the V-hover cursor + Ctrl-ripple modifier is the gap.
3. **`A`-tool stays armed + drags the group (Option B for #2).** Premiere keeps the Track Select tool active and lets you drag the selection directly. Our Option A auto-disarms after one select; Option B (intercept armed-tool mousedown on an already-selected clip → fall through to the drag controller) is the fuller-fidelity follow-up.
4. **Insert vs Overwrite edit modes.** `,` Insert (ripple right) / `.` Overwrite; drag-drop defaults to Overwrite, `Ctrl`-drop = Insert. Needs ripple-on-insert wiring (the `ripple/` module exists but is currently wired only to deletes). High value, larger.
5. **Snapping toggle on `S`.** Premiere toggles snapping with `S`; here `s` is bound to `split`. Needs a keymap decision (move `split` off `s`) before `S` can become the snap toggle.
6. **Rolling / Slip / Slide trim tools** (`N` / `Y` / `U`). New paired-neighbor and source-window trim logic.
7. **Remaining tool hotkeys:** Track Select Backward (`Shift+A`), Hand (`H`), Zoom-as-tool (`Z`), Rate-stretch-as-tool (`R`), Pen-for-keyframes (`P`).
8. **Source patching vs track targeting vs sync lock** — Premiere's three-layer track-header model governing where inserts land and what ripples.
9. **J-K-L shuttle** with repeat-press speed ramps.
10. **Three-/four-point editing + Source Monitor** — largest scope, lowest daily-use urgency for a simplified-Premiere web editor.
11. **Assets list metadata** (resolution / duration / fps) — ✅ **shipped** (bin list + preview dialog). Follow-ups (sortable detail columns, Video Usage) tracked in the panel-parity plan.

## Notes for future work

- **Verification reality:** timeline tests that import `@/wasm` (or the `@/timeline` barrel) fail under `bun` — `opencut-wasm` calls `__wbindgen_start()` at import, which bun can't initialize. #4 is unit-tested via a **wasm-free pure helper** (`preferMainTrackIndex`); #2 and the snapping change are verified by `tsc` + **live** testing (they live in `@/wasm`-importing controllers). When adding timeline logic, prefer extracting a pure, wasm-free helper so it can be unit-tested.
- **The element-interaction controller is `useState`-held and does NOT hot-reload** (QUALITY-PLAYBOOK "Getting unstuck"). Hard-reload / restart the dev server before iterating on drag/move/selection, and inspect live state via `window.__vibeEditor`. If a fix "does nothing" after 2-3 tries, suspect a stale controller instance, not wrong logic.
- **Drop audio-separation contract:** a video drop can fan out into a separated audio clip (`separateSourceAudio`, `insertAtTarget` returns ids) — preserve it when changing drop placement.
- All upstream (opencut) files touched are logged in `PATCHES.md`.

### Premiere research sources
Adobe Help (Trim Mode; Source Patching & Track Targeting), Noble Desktop (Ripple/Roll/Slip/Slide; Track Select Forward), Fstoppers (source patching vs targeting), Filmora (snapping; Track Select), Pixflow / PremiumBeat (tool + shortcut reference).
