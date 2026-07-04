/**
 * Size guard for the audio blob POSTed to /api/transcribe (Groq).
 *
 * Groq's /audio/transcriptions rejects an oversized upload with HTTP 413
 * (Request Entity Too Large). Their documented free-tier cap is 25 MB; a
 * ~32 min timeline extracted as raw 16 kHz/16-bit mono WAV is ~59 MB, which
 * 413s the moment the Opus/AAC compressor fails to shrink it (see
 * audio-encode.ts). We refuse BEFORE the fetch rather than let Groq 413, and
 * fail with an actionable message pointing at the in-browser backend.
 *
 * Pure (no fetch/Blob/DOM), so it is bun-testable.
 */

/**
 * Conservative ceiling on the outgoing upload, with real headroom under Groq's
 * ~25 MB free-tier cap. A compressed speech blob is single-digit MB, so this
 * only ever bites the raw-WAV fallback on long content (20 MB of WAV is ~10 min
 * at 32000 bytes/sec), exactly the case that was silently 413-ing.
 */
export const MAX_TRANSCRIBE_UPLOAD_BYTES = 20 * 1024 * 1024;

function formatMb(bytes: number): string {
	return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * Decide whether an upload of `byteSize` bytes may be sent. Returns `{ ok:true }`
 * when it fits, or `{ ok:false, error }` with a plain-language, actionable message
 * (never a raw 413) when it does not.
 */
export function checkTranscribeUploadSize(
	byteSize: number,
	capBytes: number = MAX_TRANSCRIBE_UPLOAD_BYTES,
): { ok: true } | { ok: false; error: string } {
	if (byteSize <= capBytes) return { ok: true };
	return {
		ok: false,
		error:
			`This recording is too long to transcribe in the cloud in one request ` +
			`(about ${formatMb(byteSize)}, over the ${formatMb(capBytes)} safe limit). ` +
			`Switch Transcription to "In browser" in Settings under AI, ` +
			`or split the project into shorter sections and try again.`,
	};
}
