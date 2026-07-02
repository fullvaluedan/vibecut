/**
 * Codec choices for compressing the transcription audio before cloud upload.
 * Pure (no mediabunny / WebCodecs / AudioContext imports) so it's bun-testable;
 * `audio-encode.ts` does the browser encode using these.
 */

export type UploadCodec = "opus" | "aac";

/**
 * Preference order: Opus first (smallest), then AAC. Both are natively
 * encodable via WebCodecs (no new dependency) and accepted by Groq's
 * /audio/transcriptions. MP3 is intentionally absent — browsers can't encode it
 * natively and it's no smaller than Opus.
 */
export const CODEC_PREFERENCE: readonly UploadCodec[] = ["opus", "aac"];

export interface UploadInfo {
	/** Filename whose extension lets Groq detect the container/codec. */
	filename: string;
	mimeType: string;
}

/**
 * Container/filename/mime for an upload codec. Opus rides in a WebM container,
 * AAC in an MP4/m4a container — both proven in scene-exporter and both in
 * Groq's accepted format list.
 */
export function uploadInfoForCodec(codec: UploadCodec): UploadInfo {
	return codec === "opus"
		? { filename: "timeline.webm", mimeType: "audio/webm" }
		: { filename: "timeline.m4a", mimeType: "audio/mp4" };
}

/**
 * How long the browser encode is allowed to run before we give up and fall back
 * to the raw WAV. Scales with source duration: the flat 20s ceiling was tuned to
 * catch a WebCodecs pipeline WEDGE on a SHORT ripple-cut timeline (near-instant
 * hang), but a genuine 30-plus-minute encode legitimately needs more wall-clock
 * time and would trip that flat ceiling for no reason, forcing the oversized-WAV
 * fallback that 413s. We keep a 20s floor (short-clip wedge protection unchanged)
 * and a 90s ceiling (a truly wedged pipeline still degrades in bounded time).
 */
export function computeEncodeTimeoutMs(durationSec: number): number {
	const FLOOR_MS = 20_000;
	const CEILING_MS = 90_000;
	const MS_PER_SEC_OF_AUDIO = 40; // ~generous vs. faster-than-realtime encode
	const scaled = FLOOR_MS + Math.max(0, durationSec) * MS_PER_SEC_OF_AUDIO;
	return Math.min(CEILING_MS, Math.max(FLOOR_MS, scaled));
}

/** WebCodecs codec string + target bitrate for the support probe and encode. */
export function encoderProbe(codec: UploadCodec): {
	webCodec: string;
	bitrate: number;
} {
	// 16 kHz mono speech: low bitrates are ample and keep an hour in single-digit MB.
	return codec === "opus"
		? { webCodec: "opus", bitrate: 32000 }
		: { webCodec: "mp4a.40.2", bitrate: 48000 };
}
