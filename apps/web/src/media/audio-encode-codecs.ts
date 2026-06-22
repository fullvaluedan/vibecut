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
