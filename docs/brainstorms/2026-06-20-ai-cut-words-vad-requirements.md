---
title: "AI CUT: word timestamps back on + VAD for speed and dead-time"
date: 2026-06-20
status: requirements
scope: standard
repo: framecut-director
---

# AI CUT — restore word timestamps + add VAD (fix repeats, faster, cut dead-time)

## Problem & context

The AI Director leaves **repeated phrases** and **dead/low-value footage** in the cut, and is slow + OOM-prone on long (15-min+) sources. Two root causes, both addressable:

1. **Word timestamps are off.** The default model can't emit cross-attention word timestamps, so this session's degrade falls back to segment-level and **four detectors go dark**: `phrase-repeat`, `duplicate-words`, `filler-words`, `dead-air`. The "3 repeated phrases at the start" survived for exactly this reason. External research shows `_timestamped` Whisper ONNX exports *do* support word timestamps in transformers.js — so this is a model-choice problem, not a hard limit.
2. **No voice-activity gating.** All audio (including 30–50% silence/dead-air on a long recording) is fed to Whisper, which is slow, OOM-prone, hallucinates over silence, and is blind to non-speech "just sitting there" footage that stays above the dB silence-removal threshold (room tone, sips, keyboard).

This brainstorm scopes **S1 (use a word-capable model)** + **S2 (Silero VAD)** to fix repeats and lift overall cut quality, speed, and reliability.

## Goals / success criteria

- **G1 — Repeats fixed.** Back-to-back repeated phrases/takes are flagged as cut rows (the original complaint). Word-level `phrase-repeat` + `duplicate-words` run again, alongside the shipped `segment-repeat` and take-clusterer.
- **G2 — More boring footage cut.** Filler words and dead-air (incl. silent "just sitting" gaps the dB pass misses) surface as reviewable cut candidates.
- **G3 — Not slower despite words-on.** Long-video transcription wall-clock is no worse than today's tiny-degraded path — VAD offsets the larger model by transcribing only speech.
- **G4 — Reliable on long sources.** No OOM; if a chosen model can't actually emit words, the run still completes (degrade safety net).
- **G5 — No regression** to short-clip behavior or caption generation (captions are a separate, user-invoked flow with its own model).

## The approach (recommended — confirmed "automatic, words always on")

Three coordinated changes, no user-facing knob:

1. **Auto word-capable model selection (words always on).** Replace the analysis-model selector so it always picks a `_timestamped` (word-capable) Whisper export, choosing size automatically by source length (smaller export for long sources, more accurate for short). The selector is a one-place heuristic; the exact model IDs are a planning/verification detail. The shipped **U1 probe** makes this safe: if the chosen export can't actually emit words in our transformers.js version, the run degrades to segment-level rather than failing.

2. **Silero VAD gating (speed + reliability).** Run a small VAD before transcription; feed Whisper only the speech intervals. Cuts transcription compute proportional to the silence ratio, removes the silence-hallucination failure mode, and keeps memory bounded — buying back the cost of the larger word-capable model.

3. **VAD-derived dead-air cut candidates (quality).** Non-speech gaps longer than a threshold become reviewable "dead air" cut rows. This catches silent low-value footage that the dB-threshold silence-removal misses (ambient noise keeps it above threshold) — the "me just sitting there drinking water" case, via audio alone.

This **supersedes the U5 decision** shipped earlier today (auto-`whisper-tiny` for long sources, which kept words *off* for speed). U5's tradeoff is replaced by words-always + VAD-for-speed.

## Requirements

- **R1.** The analysis transcription path (`ensureTimelineTranscript`) selects a word-capable (`_timestamped`) model automatically by source length; words are requested on every length.
- **R2.** When word timestamps are available, the `phrase-repeat`, `duplicate-words`, `filler-words`, and `dead-air` detectors run and contribute reviewable cut rows.
- **R3.** A Silero VAD pass gates transcription so only speech intervals are decoded; total transcription is not slower than today's degraded path on a 15-min source (G3).
- **R4.** Non-speech gaps beyond a duration threshold are surfaced as "dead air" cut candidates, deduped against the existing silence-removal and pacing cuts.
- **R5.** If the selected model cannot emit word timestamps (probe fails), the run degrades to segment-level and still completes (G4); no OOM on a 16-min source.
- **R6.** Caption generation (Subtitles panel, user-picked model) is unchanged; VAD/word-model selection applies only to the Director/analysis path.
- **R7.** Model and VAD assets download once and are cached; the combined one-time download is acceptable for the quality gain (size budget confirmed in planning).

## Scope boundaries

**In scope:** S1 (auto word-capable model + re-armed detectors) and S2 (VAD gating + VAD dead-air cuts).

### Deferred for later
- **Paraphrase-aware repeat detection** (S4 — MiniLM sentence embeddings for "same point, different words"). The LLM still attempts these; embeddings are a separate follow-up.
- **Visual dead-time detection** (S3 — frame-diff / face-presence for off-screen/frozen). Audio VAD dead-air is in scope; the visual signal is a separate effort and complements the existing opt-in Vision pass.

### Outside this product's identity
- **Server-side transcription** (faster-whisper on a GPU). Faster, but breaks the local-first / in-browser identity.

## Key decisions (from dialogue)
- **Automatic, no knob** — the system picks model + VAD behavior; no user-facing speed/quality toggle.
- **Words always on** — never trade words away for speed; use VAD to stay fast instead.
- **VAD drives dead-air cuts**, not just speed — the non-speech gaps become reviewable cut candidates.

## Open questions (resolve in planning / verification)
- Which exact `_timestamped` exports emit word timestamps in our transformers.js version? (Research names `whisper-base_timestamped`, `whisper-medium.en_timestamped`; `large-v3-turbo_timestamped` was broken then fixed in transformers.js PR #1594. **Assumption pending verification.**) Is there a tiny/small `_timestamped`? Confirm before finalizing the length→model heuristic.
- English-only acceptable for short clips (would allow the more accurate `medium.en_timestamped`), or must it stay multilingual (`base_timestamped`)?
- Dead-air gap threshold (seconds) for R4, and whether VAD **replaces** or **augments** the current dB silence-removal pass.
- Does the auto heuristic retain `tiny` (degraded) as a last-resort fallback for very long sources where even `base_timestamped` is too heavy, or is the probe-degrade safety net sufficient?

## Relationship to shipped work
- **Supersedes U5** (whisper-tiny-for-long, words-off) — same selector, opposite priority.
- **Builds on U1** (the probe) — makes the words-always model swap safe.
- **Builds on U4** (stream-resample) — VAD + stream-resample together are the long-video reliability story.
- **Complements the shipped `segment-repeat` detector** — R2's word-level detectors are additional repeat catchers, not replacements.
