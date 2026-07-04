# AI Director — Accurate Repeat Detection (dedicated LLM redundancy pass)

**Date:** 2026-06-23
**Status:** Requirements — ready for `/ce-plan`
**Branch context:** `feat/director-importance` (the AI Director lives in `apps/web/src/features/ai-generate/director/`)

## Problem

The AI Director leaves too many repeats in the cut. Repeats come in two forms in real footage, and **both** slip through:

- **Near-verbatim retakes** — the speaker restarts and says almost the same sentence again.
- **Paraphrased restatements** — the speaker makes the same point again in different words.

The current repeat-catching is a patchwork of *lexical* detectors (`take-clusters.ts`, `phrase-repeat.ts`, `segment-repeat.ts`) that only match near-verbatim text (token similarity ≥ 0.8), each behind a brittle gate (word-level Whisper timestamps the default model can't emit, a 3-second same-clip gap rule, consecutive-segments-only matching). Paraphrases are **mathematically uncatchable** by lexical overlap, and even near-verbatim retakes fall through the gates. The general "cut" LLM prompt is the only paraphrase catch today, and doing redundancy detection inside a do-everything prompt makes it inconsistent. Patching individual detectors has not converged ("going in circles").

## Users / Context

A solo creator (Dan) editing multi-take talking-head recordings into a tight cut. He currently removes surviving repeats by hand. Every Director cut is **review-gated** — the user confirms each proposed cut — so the cost of a false positive is one un-check; the cost of a false negative is a missed repeat he must catch manually.

## Goal & success criteria

Catch the repeats **accurately**: reliably surface the clear repeats (both types) for removal, without flagging distinct content or intentional repetition.

- **S1.** On real multi-take footage, the Director proposes cuts for the obvious repeats — both verbatim retakes and reworded restatements — that today survive.
- **S2.** It does **not** flag distinct-but-topically-similar lines, or intentional repetition (callbacks, recaps, emphasis), as repeats.
- **S3.** When a line has multiple takes, the take left in the cut is the best-delivered one (not merely the last), and the user can swap to any alternate from the review panel.
- **S4.** Repeats are no longer double-flagged by overlapping detectors — one coherent set of repeat rows in review.

## Approach (decided)

A **dedicated LLM redundancy pass** (Approach B), separate from the general cut prompt: it reads the full transcript and returns groups of lines that make the same point, with a chosen keeper per group. Chosen over local embeddings (A) and the embeddings+LLM hybrid (C) because it needs no model download, the LLM understands meaning (covers both repeat types), and a single focused task is more reliable than the catch-all prompt. This **extends** the existing take-cluster/redundancy architecture; it is not a rewrite.

## Requirements

- **R1. Dedicated redundancy pass.** A focused LLM pass, separate from the general Director cut prompt, takes the full timeline transcript (per-line/segment) and returns groups of lines that state the same point. It covers **both** near-verbatim retakes and reworded (paraphrased) restatements — meaning-based, not token-based.

- **R2. Conservative / high-confidence.** The pass only groups lines it is confident say the same thing. Ambiguous or merely topically-related lines are left ungrouped. The confidence bar is a tunable dial (start precise; loosen toward recall if it under-catches on real footage).

- **R3. Protect intentional repetition.** Deliberate callbacks, "as I said earlier" recaps, and rhetorical repetition for emphasis are **not** flagged as redundant. (Falls out naturally from R2 — when it isn't confident the repetition is accidental, it leaves it.)

- **R4. Best-delivery keeper.** For each repeat group, the keeper is the **best-delivered** take, not automatically the last. The judgment is grounded in the per-clip audio features the bin already computes (loudness, filler-rate, words-per-minute — see the auto-assemble `featuresByAsset` work) **plus** the transcript, so "best delivery" reflects how it sounds, not just how the words read.

- **R5. Swap to alternates in review.** Each proposed repeat group surfaces as a cut row in the review panel; the user can **swap** the surviving take to any other take in that group, reusing the auto-assemble swap-take interaction.

- **R6. Review-gated.** The pass proposes; nothing is auto-applied. Accepting a group removes the non-keeper takes; one undo restores them.

- **R7. Primary repeat-catcher; lexical detectors demoted.** When an LLM connection is available, this pass is the **single** source of repeat-cuts. The lexical detectors (`take-clusters`, `phrase-repeat`, `segment-repeat`) and the general cut prompt's redundancy clause stop contributing repeat rows so repeats are not double-flagged (S4). The lexical detectors remain only as the **fallback** when no LLM is available (offline / degraded).

- **R8. Anti-hallucination.** The pass may only reference real transcript lines/spans; any group referencing content that doesn't map to a real span is dropped before review (mirrors the existing `sanitizeDirectorPlan` / snap-to-real-span guards).

## Scope boundaries

**In scope:** line/utterance-level repeat detection via the dedicated LLM pass; conservative confidence; intentional-repetition protection; best-delivery keeper grounded in audio features; swap-to-alternate in review; demoting the lexical detectors to a fallback; review-gating.

**Out of scope (for now):**
- Local semantic embeddings / a client-side similarity model (Approaches A and C) — revisit only if the LLM pass proves insufficient or an offline-accurate path becomes a priority.
- Whole-topic / section-level repetition or restructuring — this is utterance-level.
- Any auto-apply / non-review path.
- Reworking the general cut prompt beyond removing its now-redundant redundancy clause.

## Dependencies / Assumptions

- **LLM availability.** Requires a text LLM connection (claude-code subscription or API key — both handle text). With none, the flow falls back to the lexical detectors (R7).
- **Context size.** Assumes a full timeline transcript fits the model context (Opus ~200k tokens covers well over an hour of speech). Chunking is **not** in scope unless a real recording overflows — flagged as a revisit, not a build item.
- **Audio features exist.** The per-clip loudness/filler/wpm features needed for R4 are already computed in the auto-assemble path (`featuresByAsset`); R4 reuses them rather than adding new analysis.
- **Swap UX exists.** The swap-take interaction needed for R5 already exists in the auto-assemble review panel and is the pattern to reuse.
- **Cost.** The pass re-sends the transcript to the LLM (accepted trade-off for accuracy). A possible optimization — folding the redundancy grouping into the existing plan call's output instead of a second round-trip — is left to planning to weigh against keeping the pass focused.

## Outstanding questions (for planning)

- **Q1.** Separate LLM call vs. extending the existing `/api/director/plan` response schema with redundancy groups — focus/quality vs. one fewer round-trip. (Planning decides; brainstorm leans "separate + focused" but flags the single-call optimization.)
- **Q2.** Exact keeper-scoring blend of audio features vs. transcript signal for R4 (which feature dominates when they disagree).
- **Q3.** Default confidence threshold for R2 and how it's exposed/tuned (constant vs. surfaced setting).
- **Q4.** How a repeat group spanning more than two takes renders in the review panel (one row with N alternates vs. N-1 cut rows).
