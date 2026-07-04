/**
 * Shared Director types. Grows per unit; U2 introduces the speech/audio feature
 * shapes the planner reasons over.
 */

/**
 * A word-level transcript token. `confidence` is OPTIONAL and treated as a HINT,
 * not ground truth: transformers.js word timing is heuristic (cross-attention
 * DTW) with no calibrated per-word confidence, so consumers must degrade
 * gracefully when it is absent or unreliable (KTD5 — pending the live spike).
 */
export interface WordToken {
	word: string;
	/** Start time in the same timeframe as the segment (seconds). */
	start: number;
	/** End time (seconds). */
	end: number;
	/** Heuristic confidence in [0,1] when the model provides one. */
	confidence?: number;
}

/** A transcript segment in seconds, optionally carrying word-level tokens. */
export interface SpeechSegment {
	start: number;
	end: number;
	text: string;
	/** Present only on the word-level transcription path (U2 spike-gated). */
	words?: WordToken[];
}

/**
 * Per-segment fused speech/audio features the Director uses to judge takes,
 * pacing, and filler. Energy/loudness are RELATIVE WITHIN THE FILE (absolute RMS
 * is not portable across recordings — KTD note).
 */
export interface SpeechFeatures {
	startSec: number;
	endSec: number;
	/** Mean RMS energy over the segment (raw, file-relative scale). */
	energy: number;
	/** Energy as a fraction of the loudest segment in the file, in [0,1]. */
	loudnessRelative: number;
	/** Speaking rate in words per minute (0 for empty/zero-length segments). */
	wpm: number;
	/** Word count used for the rate. */
	wordCount: number;
	/** True when the segment looks like filler/false-start (heuristic fallback). */
	fillerCandidate: boolean;
}
