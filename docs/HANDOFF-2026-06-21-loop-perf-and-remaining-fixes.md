# Handoff — run the fix loop on the remaining FrameCut issues

**Date:** 2026-06-21 · **Repo/worktree:** `C:\Users\danom\Videos\framecut-director` · **Branch:** `feat/director-importance` (pushed to `origin`, tip `5021a60d`). **Dev server:** `cd apps/web && bun run dev -- --port 3001` → http://localhost:3001 (Next 16 + turbopack; restart fully — don't just refresh — after an OOM).

---

## START HERE — the loop (what Dan asked for)

Run this circuit on the **Backlog** below, **up to 5 passes** or until the editor "runs perfectly," whichever comes first:

1. **`/ce-plan`** the next backlog item (or a small batch of related ones).
2. **`/ce-work`** the plan — test-first where the logic is pure; commit per unit.
3. **`/ce-code-review`** the diff; apply valid findings.
4. Repeat.

**Context discipline (critical):** each of those three skills loads a very large prompt. Running all three at full ceremony 5× will exhaust a context window. If context gets tight, **compress** the circuit — plan inline, fix, `tsc`/lint/bun-test, commit, and use the harness `/code-review` (not the multi-agent `ce-code-review`) — which is how this session actually operated. Spawn fresh sub-agents for investigation/review to keep the main context lean.

**The loop can't fully self-verify.** Almost every remaining item is browser-only and Dan defers testing. After each fix: `tsc --noEmit` + eslint + `bun test` for any pure core, then **add a live check to `docs/TO-VERIFY.md`** rather than claiming it works. Dan validates on :3001.

---

## Backlog for the loop (prioritized)

1. **Preview LAG (the blocker — Dan can't test through it).** A first JS-side fix shipped (`5021a60d`: `video-cache/service.ts` fast-paths the cached frame instead of re-running the decode chain every RAF tick). **If it still lags:** the remaining cost is the **HyperFrames overlay composite + the wasm compositor texture pool** (the known `#6 stutter`). That code is the **published `opencut-wasm`** — NOT locally buildable, no Rust toolchain here — so it needs a profile capture (`window.__renderPerf = true`) to confirm, and the fix would live in the wasm/Rust layer. Triage JS-side first (React re-renders over the 137-element timeline; the RAF render loop in `apps/web/src/preview/components/index.tsx`); escalate to "blocked on wasm toolchain" only after a profile says so. **Get Dan's answer first:** is it smoother after `5021a60d`, and does it lag specifically with the HyperFrames overlay ON?
2. **VAD pre-filter (S2 — the real long-video fix).** In-browser Whisper on ~20-min sources is ~real-time slow and OOM'd the dev server. Add a Silero VAD pass (`vad-web`, ~2 MB, MIT) that transcribes only speech → 30–50% less audio → faster + lower memory, and its non-speech spans double as dead-air cut candidates. Needs a new dep + browser verify. Independent of item 3. Plan: see `docs/ideation/2026-06-20-ai-cut-fast-reliable-ideation.md` (S2) and `docs/plans/2026-06-20-001-...` (U3–U5).
3. **Word-model spike (S1 / U1 — GATED on Dan).** `_timestamped` Whisper models are registered (`whisper-base_timestamped`, `medium.en_timestamped`). Dan must run AI Director on a SHORT clip with one of them and report: does the `[transcription] …can't produce word-level timestamps…` warning stay silent (GO → word-level detectors re-arm) or fire (NO-GO)? Then wire `selectAnalysisModel` to the word-capable model for long sources (U2 task).
4. **Overwrite-on-drop v2 (follow-up).** Shipped v1 (`03937079`) caps the new clip to the old clip's slot length. Full Premiere "overwrite for the new clip's full length, clearing into the next clip" (a non-rippling region clear) is the upgrade.
5. **Pre-existing lint debt** (optional, not Dan's bugs): `selectable-surface.tsx` has 2 `react-hooks/set-state-in-effect`; `transcript-cache.ts`, `assets.tsx`, `worker.ts` have pre-existing `no-unsafe-type-assertion` / `prefer-object-params`. Confirmed present at HEAD before this session's edits.

---

## What shipped this session (all committed + pushed)

- **Transcription:** word-timestamp degrade → segment-level (`service.ts`/`worker.ts`); U1 probe (~20s slice, no doubled pass); U2 honest "Transcribing… Ns elapsed" label; U5 auto whisper-tiny for >5-min analysis runs; U4 stream-resample per-asset audio (fixes the "Extracting timeline audio" OOM).
- **Director quality:** segment-level consecutive-repeat detector; stronger cut prompt (dead-time/tangents); minute timecodes in the review modal.
- **Long-source waveform:** stream the source via mediabunny (was truncated past ~44s).
- **Preview:** seek-supersede by TIME not count (un-freeze), + the lag fast-path (`5021a60d`).
- **Core editing bugs (this batch):** (1) timeline no longer collapses to ~30 frames on delete; (2) AI CUT edits the placed clips, not the whole bin; (3) overwrite-on-drop v1; (4) multi-asset bin drag adds all; (5) hotkeys work immediately after add. Plus earlier: multi-file OS drop cascades; Ctrl+A select-all in the Assets panel.

Every pure core is bun-tested; all browser flows are in `docs/TO-VERIFY.md` awaiting Dan.

---

## Hard constraints / gotchas

- **PATCHES.md (Hard Rule 1):** every upstream-OpenCut file you modify needs a row in the same commit. FrameCut-authored files (most of `features/ai-generate`, `selection/`, new helper files) don't. Check origin with `git log --follow --reverse` if unsure; files already listed in `PATCHES.md` are upstream-tracked.
- **bun has no DOM and crashes on `@/wasm` imports** (`wasm.__wbindgen_start is not a function` — pre-existing, ignore those failures). Keep pure logic in wasm-free files so it's testable; mock `@/wasm` in tests that need it.
- **Strict lint:** `opencut/prefer-object-params` (use object params for 2+ args), `@typescript-eslint/no-unsafe-type-assertion` (no `as`; use type guards / `instanceof`). `eslint.exe` is at repo-root `node_modules/.bin/`; run from `apps/web` with `../../node_modules/.bin/eslint.exe <files>`.
- **claude CLI env gotcha:** AI Director shells out to `claude` (`spawn("claude", …, {shell:true})`). A failed auto-update can wipe `hermes\…\bin\claude.exe` → "not recognized". Fix: copy the working `Roaming\npm\…\bin\claude.exe` over it.
- **Gates per change:** `apps/web` `tsc --noEmit` 0 errors; eslint clean on touched files (pre-existing errors are OK if you didn't add them — verify by stashing); director + media + selection bun suites green.

## Pointers
- Ideation (options + GitHub prior art): `docs/ideation/2026-06-20-ai-cut-fast-reliable-ideation.md`
- Perf/transcription/preview plan: `docs/plans/2026-06-20-001-fix-director-longvideo-perf-plan.md`
- Live-verify checklist: `docs/TO-VERIFY.md` (Dan ticks these off)
- Project goals/architecture: `docs/BRIEF.md`, `docs/HANDOFF.md`
