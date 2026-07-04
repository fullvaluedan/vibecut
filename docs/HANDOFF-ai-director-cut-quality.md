# Handoff — AI Director cut-quality + next direction ("detect the necessary parts")

**Date:** 2026-06-18  **Branch:** `feat/director-dupword` (all work committed AND pushed to `origin`, through `c41f4b0c`).
**Repo:** git worktree `C:\Users\danom\Videos\framecut-director` (NOT the main clone `…\Videos\framecut`). Dev server: the `framecut-director` launch.json entry → `localhost:3000` (start via `preview_start`, or `bun run dev:web`). `.env.local` is already copied into the worktree.

---

## Where things stand

The AI Director is the headline feature: drop footage → AI CUT → AI Director → a **Review modal** of typed cut/keep/reorder/take ops (all flagged, user accepts/rejects per row) → applied as ONE undoable `BatchCommand` → every decision seeds a device-local **per-category taste** profile injected into the next prompt.

**Shipped this session (all on origin):**
- **Vision v0** — opt-in (Settings → AI → Director vision, default off): samples one frame per segment → `planDirectorVision`/`planMultimodal`; visual cuts (off-screen/frozen/dead-air) with a Vision badge; degrades to text on `claude-code`. (plan `docs/plans/2026-06-18-002-…`)
- **Editor-wide fix sweep** (plan `docs/plans/2026-06-18-003-…`, all 8 units U1–U8): preview-freeze recovery, properties-panel state hygiene, keyboard guards, cursor feedback, handle geometry, a11y, visual polish, error/edge hardening.
- **Round-2 cut completion audit** (plan `docs/plans/2026-06-18-001-…`): applyDirectorPlan atomicity tests + clearTaste test.
- **Live-testing fixes** (Dan testing on a real ~21-min recording):
  - `f395ae69` **createBuffer crash fix** — analysis audio now mixed at 16kHz MONO (was 44.1kHz stereo ≈ 459MB > browser `createBuffer` limit on long timelines). Export untouched.
  - `b4f0c67a` **phrase-repeat detector** (`director/phrase-repeat.ts`) — verbatim n-gram repeats (≥4 tokens, ≤60s apart) → cut the earlier; `"repeat"` category. + strengthened LLM cut prompt for PARAPHRASED redundancy + dead time.
  - `c41f4b0c` **dead-air detector** (`director/dead-air.ts`) — dense hesitation runs (um/uh/okay…, ≥3 over ≥2.5s, bridges ≤1 content word) → cut as DEAD AIR; `"deadair"` category.

**The Director's deterministic detector stack** (all pure, unit-tested, merged via `mergeDetectedCuts` into the modal):
`duplicate-words` → `phrase-repeat` → `dead-air` → `filler-words` → `pacing`, plus the LLM's `cut`/`take_select`/`reorder` judgment and (opt-in) the vision pass.

**Open follow-ups:**
- **Live-verify everything** — `docs/TO-VERIFY.md` (Dan defers testing; it has sections per shipped item incl. the new repeat/dead-air detectors + the text-resize "anchor" repro).
- **Threshold tuning** — once Dan reports what his footage does, the detectors are one-line dials: `phrase-repeat` `minPhraseWords`/`windowSeconds`; `dead-air` `MAX_BRIDGE_CONTENT`/`minSpanSeconds`/`minHesitations`; `pacing` targets.
- **Long-EXPORT chunked audio** (flagged latent twin of the createBuffer crash): exporting a ~21min+ video hits the same `createBuffer` wall (export needs 44.1kHz stereo, can't downsample). Needs chunked audio mixing in the SHARED `media/audio.ts` mix path — a careful refactor; warrants its own `/ce-plan`.
- **#6 playback stutter** — BLOCKED: runtime uses the published npm `opencut-wasm@^0.2.10`, no local Rust toolchain (can't instrument `texture_pool.rs` here). Needs a wasm-toolchain machine.
- **B-roll insertion** — the documented next leap (multimodal plan `docs/plans/2026-06-15-002-…` U4); needs its own `/ce-plan`.

---

## NEXT DIRECTION (Dan's ask): "detect the NECESSARY parts of a video"

Today the Director is **subtractive** — it detects what to CUT (repeats, fillers, dead air, pauses, tangents). Dan wants the inverse: detect what to **KEEP** — the *necessary / high-value* parts. This is the keep-side / **importance (highlight) detection** arc. It's a real new capability, not a tweak — give it its own `/ce-plan`.

**Why it's valuable:** the cut-side is "remove the obviously bad"; the keep-side is "find the actually good." Together they let the Director build a tight cut from a long ramble (and enable a future "make me a 60s short / highlight reel" mode).

**Candidate signals for an importance score per segment (most are already half-built):**
- **Audio emphasis** — loudness/energy peaks already in the signal table (`audio-features.ts` → `loudnessRelative`); a sustained-emphasis or pitch-rise span = the speaker stressing a point. Deterministic.
- **Speaking-rate dynamics** — `wpm` is in the signal table; a confident, steady delivery (vs the hesitant low-wpm dead-air the new detector cuts) reads as load-bearing.
- **Lexical salience** — content-word density / keyword hits / "thesis sentence" markers ("the key thing is", "the point is", "what matters", "here's the trick"). Deterministic + cheap.
- **LLM importance pass** — ask the planner to also emit `keep` ops on the load-bearing spans (the schema ALREADY has a `keep` op — it's currently informational only). The strongest signal; pairs with the deterministic ones.
- **Vision interest** — when vision is on, score visually-engaging frames (face present, on-topic screen content) vs dead frames.

**Suggested shape (for the next /ce-plan):**
1. A deterministic `importance.ts` that scores each segment (emphasis + wpm-confidence + lexical salience) → a 0..1 keep-score, surfaced in the signal table sent to the LLM (so the planner sees "this segment scored high").
2. Make `keep` ops actually *do* something: a "keep-only / highlight" mode that, instead of listing cuts, KEEPS the top-scoring spans and cuts the rest — the inverse apply path (cut everything not kept). Gate it as a mode in the AI-CUT menu.
3. (Stretch) a "make a ~Ns short" target: pick the best contiguous/assembled window under a duration budget.

Keep it review-gated like everything else (the user vets the kept set). The deterministic importance score is unit-testable (pure, like the existing detectors); the LLM keep-pass is live-verified.

---

## Env / gotchas for the next session (read these first)
- **Hard Rule 1** (BRIEF/CLAUDE.md): new code goes in `packages/hf-bridge/`, `packages/taste-engine/` (doesn't exist yet), or `apps/web/src/features/ai-generate/` — touching upstream-originated files (OpenCut fork) is a last resort and MUST be logged in `PATCHES.md` (same commit). The Director detectors are all in `features/ai-generate/` → no PATCHES.
- **bun test has NO DOM** (`document` undefined, no happy-dom) and **crashes on `@/wasm` / canvas / mediabunny imports** — keep detector logic pure + wasm-free (inject `ticksPerSecond`); the 5 failing tests in a full `bun test apps/web/src` sweep are PRE-EXISTING `wasm.__wbindgen_start` crashes, not yours.
- **Adding a cut category** is a 3-place ripple: the `DirectorOpCategory` union in `packages/hf-bridge/src/author.ts`, `CATEGORIES` + `CATEGORY_LABEL` in `director/taste.ts`, and (optional) a badge in `director-review-dialog.tsx`. Mirror `"repeat"`/`"deadair"`.
- **`preview_start` MCP hits the "Desktop only" gate** (narrow harness viewport → editor never mounts → `window.__vibeEditor` undefined), so `preview_eval` can't read the user's live timeline — confirm hypotheses from the code/math instead.
- **Strict lint:** `@typescript-eslint/no-unsafe-type-assertion` (no `as` from any/unknown — use type-predicate guards), `opencut/prefer-object-params` (object param for 2+ args, incl. test helpers). Pre-existing violations on untouched lines are tolerated; YOUR new code must be clean.
- Architecture/goals/lessons: repo `docs/BRIEF.md` + `docs/HANDOFF.md`; the full per-round log is in the auto-memory `vibecut.md`.
