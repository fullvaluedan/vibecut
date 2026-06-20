import type { TranscriptionModelId } from "./types";

/**
 * Above this timeline length the Director/analysis transcription should trade
 * accuracy for speed: cut decisions (silence, pacing, segment text) tolerate a
 * weaker transcript, and whisper-small on a long source takes many minutes. One
 * dial — raise it if Tiny's transcripts prove too weak for cut quality.
 */
export const ANALYSIS_TINY_THRESHOLD_SECONDS = 300;

/**
 * Pick the transcription model for the Director/analysis pipeline by timeline
 * length: fast Tiny above the threshold, accurate Small below. This is the
 * ANALYSIS path only (`ensureTimelineTranscript`) — user-invoked caption
 * generation picks its own model and is unaffected.
 */
export function selectAnalysisModel({
	durationSec,
}: {
	durationSec: number;
}): TranscriptionModelId {
	return durationSec > ANALYSIS_TINY_THRESHOLD_SECONDS
		? "whisper-tiny"
		: "whisper-small";
}
