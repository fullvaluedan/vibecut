import type { TranscriptionModelId } from "./types";

/**
 * Reserved for a future accuracy tier: once a LARGER word-capable export
 * (whisper-base/medium_timestamped) is confirmed to LOAD in-app, short sources
 * can use it for a better transcript while long sources stay on the fast tiny
 * model. Until then the selector returns one confirmed word-capable model at
 * every length (see below).
 */
export const ANALYSIS_TINY_THRESHOLD_SECONDS = 300;

/**
 * Pick the transcription model for the Director/analysis pipeline. Plan A (KTD1):
 * words are ALWAYS on so the word-level detectors (duplicate-words, filler,
 * dead-air, phrase-repeat) can run — so this returns a WORD-CAPABLE
 * `_timestamped` export, never a words-off model. `whisper-tiny-timestamped` is
 * the id VERIFIED to emit word timestamps in our transformers.js (U1 spike,
 * 2026-06-24); the larger word-capable exports stay unadopted until their load
 * is confirmed in-app (base failed a headless load). The shipped probe-degrade
 * still covers any residual word-capability gap, so this can't make a run fail.
 * ANALYSIS path only (`ensureTimelineTranscript`) — captions pick their own
 * model and are unaffected (R6).
 */
export function selectAnalysisModel({
	durationSec,
}: {
	durationSec: number;
}): TranscriptionModelId {
	void durationSec; // length tier reserved (see ANALYSIS_TINY_THRESHOLD_SECONDS)
	return "whisper-tiny-timestamped";
}
