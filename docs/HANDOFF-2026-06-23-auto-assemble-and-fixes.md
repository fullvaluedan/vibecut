# Handoff — AI auto-assemble + fixes (2026-06-23)

**Branch:** `feat/director-importance` (worktree `C:\Users\danom\Videos\framecut-director`). **Pushed** through `2487f32f`; `29a5bbeb` (playback fix) is committed but **NOT pushed** (1 ahead). **Dev server:** `cd apps/web && bun run dev -- --port 3001` → http://localhost:3001 (Next 16 + turbopack). It dies inside ~30 min because **this agent's session reaps its own background processes** (the dev log showed a healthy server just *stopping*, no crash). Keep it up by running it in YOUR OWN terminal, or `powershell -ExecutionPolicy Bypass -File C:\Users\danom\framecut-watchdog.ps1` (2h restart loop, log at `C:\Users\danom\framecut-watchdog.log`). The agent can't keep a process alive past the session without harness-evading tricks the safety classifier (rightly) blocks.

## What shipped this session (all gated: tsc 0, eslint 0-new, ~265 director tests green)
1. **Issue 1** `6292dcbe` — 8-video-track cap + move/Track-Select-Forward explosion (was 1 new track per element; now collapses per source track + caps).
2. **Take rule** `8cc964eb` — keep-LAST take, cut earlier near-identical within `TAKE_WINDOW_SEC`=120s; removed the "pick one yourself" punt.
3. **AI Auto-Assemble P0-P5** `baad26b5`,`7fedd179`,`410c9012`,`ca83df2a`,`4a1d558d`,`9572dff9`,`50cfd384` — transcribe the WHOLE bin (per-asset cache) → cross-bin candidate pool + take clusters → LLM picks+orders best spans (`/api/director/assemble`, **verified live via curl: real plan + narrative returned**) → place on a fresh scene → right-panel review (dual timecodes, play/drop/re-include/swap-take).
4. **FU1+FU2** `2487f32f` — drafts onto a fresh scene (non-destructive); per-clip audio features (loudness/wpm/filler) cached + fed to the LLM candidate catalog.
5. **Issue 2** `d4aab934` — Remove Silences no longer deletes a quiet showcase/b-roll VIDEO clip + no 4-frame remnant (`features/editing/silence-refine.ts`).
6. **Playback fix** `29a5bbeb` — Up/Down "go to edit point" now pauses (was rolling past the cut during playback).

Architecture notes live in the `vibecut` memory + the plan `C:\Users\danom\.claude\plans\i-had-a-massive-soft-kitten.md`. Live-verify checklist: `docs/TO-VERIFY.md`.

## OPEN — needs a fresh session

### A. Repeats still surviving (HIGH — user-reported, Groq backend)
**Symptom:** Dan repeated a *similar* (not verbatim) phrase at the **very beginning** and it wasn't cut. Transcription was Groq (cloud, word-level).
**Where to look** (`features/ai-generate/director/`):
- This is a SAME-asset, close-together, *paraphrased* repeat. `take-clusters.ts` only clusters same-asset pairs ≥ `MIN_SAME_ASSET_GAP_SEC`=3s apart AND ≥ `HIGH_SIMILAR` (`text-similarity.ts`) — a paraphrase or a <3s-apart repeat slips through. `phrase-repeat.ts` needs a **verbatim** ≥4-token n-gram — misses a paraphrase. So a near-beginning paraphrase falls to the **LLM** (`buildDirectorPrompt` in `hf-bridge/author.ts` already says "REDUNDANT RESTATEMENTS … even in DIFFERENT words").
- **First step: get the actual transcript of the opening** (run AI Director with Groq, log the signal table / the `/api/director/plan` request body) and see (1) what the two phrases' similarity score is, (2) whether the LLM flagged it and the user just didn't accept it, (3) whether it's same-asset <3s (→ phrase-repeat territory but paraphrased → nobody catches it).
- **Likely fixes:** lower `HIGH_SIMILAR` for the take detector, OR add a paraphrase-aware same-asset detector (semantic, not verbatim), OR strengthen the LLM prompt's opening-redundancy instruction. Tune against Dan's real recording — don't guess thresholds blind.
- All these detectors are pure + bun-testable (`director/__tests__/`).

### B. Issue 3 — playback stutter (BLOCKED here)
Dominant cost is the wasm compositor texture pool; this worktree runs the *published* `opencut-wasm` npm with **no local Rust toolchain**, so the real fix needs a Rust+wasm-pack machine. JS-side options (memo per-element `TimelineElement`, stabilize `PreviewPanel` overlays) need a live `window.__renderPerf` profile first — see `docs/TO-VERIFY.md` #6. Don't optimize blind.

### C. Clip border for cut visibility (UI — quick)
On a black/dark clip thumbnail the cut boundaries are invisible (Dan's screenshot: adjacent clips blend into one black strip). Give timeline clip elements a visible border/outline so each clip's edges read against a dark background. Look in `timeline/components/timeline-element.tsx` (the clip body / `ElementInner`) — add a subtle border (e.g. `border border-white/15` or a ring) that's distinct from the blue selection ring. Upstream file → PATCHES row.

### D. AI Director left a NOISE-only take (HIGH — a few frames of pure noise survived)
A short fragment of just *noise* (no speech, high waveform energy) was left in the cut. The existing guards miss it: `dead-air.ts` cuts LOW-loudness dead time (this is HIGH energy); the take/phrase detectors need text. So a brief non-speech, high-energy blip (a bump, breath-pop, room noise) is invisible to every detector AND to the LLM (no transcript text for it). Need a **non-speech-fragment guard**: a span with high energy but no transcript words, shorter than ~N frames, between/around speech → drop it. This is the same fragment class as the 4-frame remnant (Issue 2) but driven by NOISE not silence. Likely a new detector in `director/*` (energy envelope from `audio-features.ts` over the gaps between transcript segments) or a min-fragment guard in the apply/assemble path. Pure + bun-testable.

### E. Abrupt cuts — land mid-sound (MEDIUM)
Some cuts are visibly abrupt in the waveform (the cut point lands mid-word/mid-sound, no breathing room). Director cuts are aligned to transcript SEGMENT boundaries, but a segment edge can fall mid-sound. Options: snap each cut boundary to the nearest low-energy / zero-crossing point within a small window (reuse the energy envelope in `audio-features.ts` / the silence detector), and/or add a tiny crossfade at cut joins. Remove-silences already pads ±0.15s; the Director apply path (`apply-plan.ts` → `RemoveRangesCommand`) does not. Make boundary-softening shared. Tune against Dan's recording.

### F. Push — DONE this session (`29a5bbeb` playback + `5f188192`/this handoff pushed).
