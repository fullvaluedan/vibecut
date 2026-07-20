/**
 * Pure serializers for the Transcript tab's Export menu (W4/R1). Every format
 * reads the same segment array (the TranscriptionResult source of truth via
 * transcript-cache's lite shape) - no second transcription path, no second
 * timestamp formatter. SRT reuses the ONE writer in subtitles/srt.ts instead
 * of growing a second serializer here.
 */

import { formatTimestamp } from "./format-transcript-text";
import { writeSrt } from "@/subtitles/srt";
import type { TranscriptSegmentLite } from "./transcript-cache";

/**
 * Plain-text export. `includeTimecodes` toggles the `[mm:ss.s-mm:ss.s]`
 * prefix used by Copy/formatTranscriptText; off, it's just the words. An
 * empty transcript yields an empty string either way.
 */
export function formatTranscriptTxt({
	segments,
	includeTimecodes,
}: {
	segments: readonly TranscriptSegmentLite[];
	includeTimecodes: boolean;
}): string {
	return segments
		.map((segment) => {
			const text = segment.text.trim();
			if (!includeTimecodes) return text;
			return `[${formatTimestamp(segment.start)}-${formatTimestamp(segment.end)}] ${text}`;
		})
		.join("\n");
}

/** Quote a CSV field only when it needs it (comma, quote, or newline); double any internal quotes. */
function csvField(value: string): string {
	if (/[",\r\n]/.test(value)) {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return value;
}

/** Seconds -> fixed 3-decimal string ("65.300"), sortable/parseable in a spreadsheet. */
function csvTimestamp(sec: number): string {
	return Math.max(0, sec).toFixed(3);
}

/**
 * CSV export: `start,end,text` (the `speaker` column the research spec
 * describes is omitted - TranscriptionResult carries no speaker labels, so a
 * speaker column would just be empty everywhere).
 */
export function formatTranscriptCsv({
	segments,
}: {
	segments: readonly TranscriptSegmentLite[];
}): string {
	const header = "start,end,text";
	const rows = segments.map((segment) =>
		[
			csvTimestamp(segment.start),
			csvTimestamp(segment.end),
			csvField(segment.text.trim()),
		].join(","),
	);
	return [header, ...rows].join("\r\n");
}

/**
 * SRT export: map segments to subtitle cues and hand them to the shared
 * writer (subtitles/srt.ts) - the second call site for that writer, the
 * first being its own round-trip tests.
 */
export function formatTranscriptSrt({
	segments,
}: {
	segments: readonly TranscriptSegmentLite[];
}): string {
	return writeSrt({
		cues: segments.map((segment) => ({
			text: segment.text,
			startTime: segment.start,
			duration: Math.max(0, segment.end - segment.start),
		})),
	});
}
