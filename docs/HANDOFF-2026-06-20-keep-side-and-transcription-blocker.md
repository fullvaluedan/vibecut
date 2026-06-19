# Handoff — AI Director keep-side shipped + the word-timestamp blocker

**Date:** 2026-06-20  **Repo:** worktree `C:\Users\danom\Videos\framecut-director`. Dev server: `bun run dev:web` → localhost:3000.

## TL;DR — start here

Two big arcs are **built, tested, committed, pushed** (two stacked PRs), but **neither is live-validated** because **AI Director currently fails on real footage** at a newly-found **pre-existing** blocker:

> **`Model outputs must contain cross attentions to extract timestamps... not exported with output_attentions=True`** (`apps/web/.../transcription/.../service.ts:67`, in the transcription worker).

**This is the #1 thing to fix next.** It blocks *every* AI Director and Highlight run. Once it's fixed, validate both arcs (the R9 footage check that's been pending all along).

---

## The blocker (fix first)

**What:** `ensureTimelineTranscript({ wantWords: true })` requests WORD-level Whisper timestamps. transformers.js can only produce word timestamps via cross-attention DTW, which needs the model exported with `output_attentions=True`. The configured Whisper model isn't, so the worker throws at `service.ts:67` after the model loads.

**Why pre-existing (not the new arcs):** `wantWords: true` came from the Round-1 dup-word work (the word-level detectors: `duplicate-words`, `phrase-repeat`, `dead-air`, `filler-words` all need word timing). It was shipped "live-verify later" and never actually run on footage. The asset-context + keep-side arcs reuse the same `ensureTimelineTranscript` call (`run-director.ts:~65`, `run-highlight.ts`).

**The multimodal plan flagged this risk explicitly** (KTD5): "transformers.js word timestamps are heuristic (cross-attention DTW)... spike-verify word timing on the default model before building filler-detection on it." That spike never happened — this is it failing.

**Fix options (pick after a quick look at the transcription service + which model is configured):**
1. **Graceful degrade (fastest, most robust):** when word-level fails / the model can't do it, fall back to `return_timestamps: true` (segment-level). The word-needing detectors (`duplicate-words`/`phrase-repeat`/`dead-air`/`filler-words`) then simply produce nothing; the LLM cut, `pacing`, the take/redundancy layer (segment-text based), and the keep-side **importance score** all still work. This unblocks AI Director + Highlight immediately. Make `wantWords` advisory, not required.
2. **Swap to a word-capable model:** find/configure a Whisper variant exported with `output_attentions=True` (some `Xenova/whisper-*` exports support word timestamps; verify in transformers.js). Better long-term (keeps the word-level detectors working) but needs model research + a possibly larger download.
3. **Hybrid:** try word-level; on the cross-attention error, catch and retry segment-level for that run; surface a one-time note.

**Investigation pointers:** the error is at the transcription worker `service.ts:67`; trace from `ensureTimelineTranscript` (`apps/web/src/features/transcription/transcript-cache.ts`) → the worker → the model config (which `Xenova/whisper-*` and what `return_timestamps` it passes). `wantWords` is threaded from `run-director.ts` and `run-highlight.ts`.

---

## What shipped this session (all committed + pushed)

**Cut-side arc — PR #50** (`feat/director-asset-context` → `feat/director-dupword`): asset-context model + repeat-aware cut quality, U1–U7. Take clustering (lexical similarity), redundancy/take-selection detector, keeper-safe merge, asset catalog + `grp` column in the planner prompt, the take/repeat review surface. Plan: `docs/plans/2026-06-19-001-...`.

**Keep-side arc — PR #51** (`feat/director-importance` → `feat/director-asset-context`): emphasis/anchor importance scoring + Highlight mode, U1–U8. `importance.ts` (the score), `keep-select.ts` (contiguity-aware budget selection), `apply-plan.ts` `planKeepInverseRanges`/`applyHighlightPlan` (inverse apply), Phase B (score wired into the normal Director: `imp` column, capped protection, LLM keep-pass), Phase D (Highlight mode: `run-highlight.ts` orchestrator, mode-discriminated keep review surface, menu duration dialog). Plan: `docs/plans/2026-06-19-002-...`.

**Audio OOM cache fix** (`apps/web/src/media/audio.ts`, logged in `PATCHES.md`): `collectAudioElements` was decoding the full asset audio once PER timeline element (silence-removal → ~50 elements of the same asset → ~50 parallel ½GB decodes → OOM at "Extracting timeline audio"). Added a per-asset decode cache (1 decode, shared read-only). **This fixed multi-element timelines** — short clips now decode fine.

**Verification:** all director + hf-bridge unit tests pass (~225); full `apps/web` bun sweep green except the 5 pre-existing `wasm.__wbindgen_start` crashes; `tsc --noEmit` 0 errors on `apps/web` + `packages/hf-bridge`; ESLint clean. The pure cores are bun-tested; all browser orchestration/UI is live-verify (bun has no DOM).

---

## Other open issues (lower priority than the blocker)

- **Long-video (12-min+) audio still OOMs.** The per-asset cache fixed the *N-decodes* problem, but a *single* long decode still holds the full native asset audio ~3× in memory before resampling (`resolveAudioBufferForAsset` builds all chunks + a `nativeChannels` copy + a `nativeBuffer`). The real fix is **stream-resample chunk-by-chunk** (never hold the full native buffer) — the "chunked audio mixing" refactor the original handoff scoped for its own `/ce-plan`. Short clips (≤~4 min) work; long ones need this. (A cheap partial: drop the redundant `nativeChannels` intermediate copy + downmix the analysis decode to mono — helps but may not fully clear 12-min.)
- **Neither arc is R9-validated on footage.** The whole point of the dev-server session was to validate pick-quality (do the cut/keep decisions actually pick the right parts?). Blocked by the transcription error above. The keep-side defaulted to **LLM-primary** keep selection for the un-budgeted Highlight (KTD4) — confirm that's the desired behavior once it runs.
- **PRs not merged.** #50 and #51 are open + mergeable, stacked; no CI configured. Merge bottom-up (#50 then #51) when validated; `feat/director-dupword` itself still needs to reach `main` eventually (separate, ~55 commits).

## Env / gotchas
- A prior long-video OOM **wedges the browser tab's memory** — fully CLOSE the tab (not refresh) and reopen to clear it before re-testing.
- The Whisper model is a **one-time ~40MB download** (first run ~a minute; cached after). The onnxruntime `VerifyEachNodeIsAssignedToAnEp` warnings + "No language specified - defaulting to English" are benign.
- New code goes in `apps/web/src/features/ai-generate/` / `packages/hf-bridge/` — touching upstream OpenCut files needs a `PATCHES.md` entry (Hard Rule 1). `bun test` has no DOM and crashes on `@/wasm` imports — keep pure logic wasm-free; mock `@/wasm` + command classes for apply-plan tests (see `apply-plan.test.ts`). Strict lint: `opencut/prefer-object-params`, `@typescript-eslint/no-unsafe-type-assertion`.
- Full per-arc detail: the two plan docs above; the session log is in the auto-memory `vibecut.md`.
