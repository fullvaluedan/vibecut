# Handoff — Director-cut review panel, take-selection rule, + 3 fixes

**Date:** 2026-06-22 · **Repo/worktree:** `C:\Users\danom\Videos\framecut-director` · **Branch:** `feat/director-importance` (pushed to origin; tip at handoff: `6ac45541`). **Dev server:** `cd apps/web && bun run dev -- --port 3001` → http://localhost:3001 (Next 16 + turbopack). A 5-hour watchdog (`/tmp/framecut-watchdog.log`) is auto-restarting it until ~20:10 TST 2026-06-22 — it will be GONE for the next session; just start the server yourself.

---

## START HERE — how this session worked (and its one real gap)

Verification was done two ways: **gates** (`cd apps/web` → `bunx tsc --noEmit`, eslint via `../../node_modules/.bin/eslint.exe <files>`, `bun test`) and a **live command-layer harness**: the editor exposes `window.__vibeEditor` (an `EditorCore`, dev-only) on the running app. Drive it via the Claude_Preview MCP (`preview_eval` against the framecut server) to insert clips, run commands, read `scenes.getActiveScene().tracks`, call `command.undo()`, etc. This proved e.g. overwrite geometry, `memo(Timeline)`, retime math, and undo all at the COMMAND level.

**THE GAP (caused real escaped bugs this session):** the harness CANNOT fire an HTML5 drag-drop or a keypress. So drag-from-bin, keyboard undo, track-select-forward, and the like are **not** testable from the agent side — they were shipped "gated + command-verified" and flagged in `docs/TO-VERIFY.md` as "confirm the GESTURE", and that's exactly where bugs slipped (the multi-track drop, Ctrl+Z). **Be honest about this**: for gesture/keyboard UI, either get the user to confirm, or find a way to exercise the real DOM-event path. Don't imply gesture-level "done" from a command-level check.

Two MCP annoyances to expect: the preview browser tab keeps wandering to `localhost:3008` (Command Center) — re-`location.href` it to 3001; and a fresh fake `/editor/<id>` sometimes won't mount `__vibeEditor` under dev-server load — reopen a previously-created project id instead.

---

## What the user wants next — Director-cut REVIEW PANEL overhaul (the main feature)

Today the Director's cut review is a **modal** with a flat checklist + an "Apply N of N" button (see `features/ai-generate/director/*` + the review component — grep "Director's cut" / "Apply" / near-identical "pick one to cut yourself"). The user wants it reworked:

1. **Move it OUT of the modal into the RIGHT-hand panel** (right of the preview — the properties/inspector column, `components/editor/panels/properties/*`). The cut list lives there, persistent, not a blocking modal.
2. **Click a cut row → seek/play the video at that cut's timecode** so the user can confirm it before/after applying. (Wire row-click to `editor.playback.seek` + play.)
3. **Per-cut UNDO/restore after applying.** After applying all cuts, the user wants to pick specific cuts to "bring back" (re-insert that removed region) if there's a problem at that spot — without undoing everything. So the applied cuts must be individually reversible, not just one big BatchCommand undo. (Design: keep the cut list live post-apply with a per-row "restore" that re-inserts that region; or apply each cut as a tracked, individually-revertable edit.)
4. **Each cut row shows TWO timecodes: the ORIGINAL source timecode AND a "floating" timecode** that accounts for edits already applied (since cuts shift everything after them). So after applying some cuts, the user can still find the spot on the current timeline. (Maintain a mapping original→current as cuts apply; show both.)

## Take-selection rule the user wants (replaces the current "too close → pick one yourself")

The screenshot "Near-identical takes — pick one to cut yourself" leaves both for the user. New desired behavior (in the Director take/redundancy logic — `features/ai-generate/director/*`, the take-aware redundancy detector):

- **Keep the LAST take, cut the earlier near-identical ones.** Rationale: the user re-takes lines trying for the best read; the last attempt is the keeper after stumbles.
- **Only auto-cut earlier takes within 2 MINUTES of the last take.** Near-identical phrases further apart than ~2 min are NOT auto-cut (they're probably legitimately repeated content, not retakes).
- **Cluster-aware: handle N consecutive retakes** (e.g. 5 takes in a row) — keep the last of the cluster, cut all earlier members within the 2-min window.
- **Rare A/B fallback:** only if the agent strongly believes stitching multiple takes is better than keeping the last, present an explicit "A or B" choice. Should be very rare — default is "keep last."

---

## Issues reported this session (prioritized backlog)

1. **~200 video tracks created (SEVERE).** The user ran **track-select-forward** (the `A` key, `actions/use-editor-actions.ts`) "to make space," and the timeline ballooned to V183-V189+ (≈189 tracks). Two asks: (a) **hard-cap video tracks at 8** (add a `MAX_VIDEO_TRACKS = 8` guard at the track-creation seam — `AddTrackCommand` / `resolveTrackPlacement` / `computeDropTarget`), and (b) **moving assets must NOT spawn new tracks**. This is the same bug-CLASS as the multi-asset-drop scatter just fixed (`6ac45541`) but on the MOVE / track-select-forward path, which that fix did NOT touch. Trace the MOVE path: `timeline/controllers/element-interaction-controller.ts` (drag-move, slip/slide), `core/managers/timeline-manager.ts#moveElements`, and how `computeDropTarget`/`resolveTrackPlacement` decide `isNewTrack` during a move. Root-cause hypothesis: the move resolves placement at a position where the source track looks occupied (by the element being moved, or the prior one) and spawns a new track each step — analogous to the drop's missing `startTimeOverride`/`excludeElementId`. Use `excludeElementId` (the moving element) in the placement check and cap track creation.
2. **A showcase clip with LOW audio at the start was cut entirely, leaving a weird 4-frame remnant** (the user watching the video). Two problems: (a) the Director treats low-loudness as cuttable dead-air/tangent, but a *showcase/b-roll* clip with quiet audio should not be auto-cut — the loudness-based cut needs a guard (don't cut a whole clip purely on low loudness, esp. the lead clip). (b) The leftover **4 frames** is a cut-boundary artifact — the region-clear/remove-ranges or the Director-applied cut leaves a tiny fragment (frame-rounding at the cut boundary, or a near-empty surviving sliver). Investigate `features/editing/remove-ranges.ts` boundary rounding + the Director apply path (`features/ai-generate/director/apply-plan*`), and the loudness/dead-air detector thresholds. Repro source: the long G7 recording loaded in the user's project.
3. **Playback still drops frames / stutters** — needs to be smooth for editing. Partly addressed (`memo(Timeline)` shipped, `7159aac8`), but the dominant remaining cost is the **wasm compositor texture pool (`#6` in `docs/TO-VERIFY.md`)**, which is **toolchain-blocked** (the app uses published `opencut-wasm`; no local Rust here). Remaining JS-side options need a profile (`window.__renderPerf = true`): per-element `TimelineElement` memo for interaction lag, stabilizing `PreviewPanel`'s `overlayControls`, etc. — don't optimize blind.

---

## What shipped this session (all committed + pushed to `feat/director-importance`)

In order: overwrite-on-drop v2 (`4abf9a33`); `memo(Timeline)` playback perf (`7159aac8`); code-review-hardening of overwrite (`62a70029`); A1/C1 left-resize/main-track diagnosis + fix (`4bdb0187`, `807fb50e`); overwrite A2 retime-aware head-trim (`dbdfc53a`); RemoveRanges retime fix (`067bcb42`); **Groq cloud transcription backend** (`d9195cf0`) + **audio compression to clear the 100 MB cap** (`e7cd2edd`) + "Transcribe on" dropdown (`fb64dbce`); linked-audio speed retime (`6d08c7a3`); multi-asset drop "one track per type + single undo" (`6ac45541`). The hunt-found backlog (left-resize, RemoveRanges, linked-audio, multi-drop, ripple left-trim `e3aa7bbe`, transcriber scrub-perf `7b28a47c`) is all in. Per-fix live checks are in `docs/TO-VERIFY.md` (most "confirm the GESTURE").

**Cloud transcription is live + verified server-side** (route 401/400 + a real WAV+fake key reaching Groq → 500; normalizer bun-tested; editor mounts clean). Audio is compressed (Opus→AAC→WAV fallback) before upload, so long sources clear the 100 MB cap. The BYO-key e2e (paste a Groq key in Settings → AI → "Transcribe on" → Groq, run AI CUT on a long source) is the user's remaining live check. The AI Director's `claude.exe` (hermes) was wiped by a failed auto-update and **restored this session** (copied the working `Roaming/npm/.../bin/claude.exe`); the `[[hermes-claude-cli-break]]` memory documents this recurring break + fix.

---

## Hard constraints / gotchas

- **PATCHES.md (Hard Rule 1):** every upstream-OpenCut file you modify needs a row in the SAME commit. FrameCut-authored files (most of `features/ai-generate`, `features/transcription`, `ripple/`, `speed/`, `services/transcription`, new files) do NOT. Check origin with `git log --follow --reverse` if unsure.
- **Gates per change:** `apps/web` `tsc --noEmit` 0 errors; eslint clean on touched files — **pre-existing errors are OK if you didn't add them; verify by `git stash`ing your change and re-running eslint to compare counts** (this repo has many pre-existing `no-unsafe-type-assertion` / `prefer-object-params`). Run bun tests for any pure core.
- **bun can't import `@/wasm`** (mediaTime, etc.) — keep pure logic in wasm-free leaf files so it's bun-testable (pattern: `audio-encode-codecs.ts` ← tested; `audio-encode.ts` ← browser). Import tests from the leaf.
- **No new `as` casts** (lint). Use type-predicate guards (`v is Record<string, unknown>`) like the route parsers.
- The `mediabunny` dep CAN encode (Opus/AAC/etc.) in-browser via WebCodecs — see `media/audio-encode.ts` + `services/renderer/scene-exporter.ts` for the `Output`/`AudioBufferSource`/`BufferTarget` pattern. WebCodecs encodes Opus + AAC but NOT MP3.

## Pointers
- Live checks: `docs/TO-VERIFY.md` (Dan ticks these). Project goals/architecture: `docs/BRIEF.md`, `docs/HANDOFF.md`, `docs/QUALITY-PLAYBOOK.md` ("one user action = one undo").
- Cloud transcription: `app/api/transcribe/route.ts`, `services/transcription/providers/groq.ts`, `features/transcription/transcript-cache.ts` (cloud branch), `features/ai-generate/store.ts` (`transcriptionBackend`/`groqApiKey`/`buildTranscribeHeaders`), `features/ai-generate/components/ai-settings.tsx` ("Transcribe on" dropdown).
- Drop/track logic: `timeline/controllers/drag-drop-controller.ts`, `timeline/components/drop-target.ts` (`computeDropTarget` — `startTimeOverride`, `excludeElementId`, the new-track decision), `timeline/placement/resolve.ts`, `core/managers/timeline-manager.ts`.
- Director: `features/ai-generate/director/*` (planner, apply-plan, take/redundancy detectors), `app/api/director/plan/route.ts`.
