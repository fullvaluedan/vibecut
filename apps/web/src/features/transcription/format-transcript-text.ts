import type { TranscriptSegmentLite } from "./transcript-cache";

/** Seconds -> mm:ss.s (e.g. 65.3 -> "01:05.3"). */
function formatTimestamp(sec: number): string {
	const safe = Math.max(0, sec);
	const minutes = Math.floor(safe / 60);
	const seconds = safe - minutes * 60;
	return `${String(minutes).padStart(2, "0")}:${seconds
		.toFixed(1)
		.padStart(4, "0")}`;
}

/**
 * Readable, timestamped transcript: one line per segment as `[mm:ss.s–mm:ss.s]
 * text` (KTD6). Shared by both Copy and Export so the two produce byte-identical
 * text. An empty transcript yields an empty string.
 */
export function formatTranscriptText({
	segments,
}: {
	segments: readonly TranscriptSegmentLite[];
}): string {
	return segments
		.map(
			(s) =>
				`[${formatTimestamp(s.start)}–${formatTimestamp(s.end)}] ${s.text.trim()}`,
		)
		.join("\n");
}
