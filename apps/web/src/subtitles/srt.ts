import type { ParseSubtitleResult, SubtitleCue } from "./types";

const TIMESTAMP_SEPARATOR = /\s*-->\s*/;
const TIMESTAMP_PATTERN =
	/^(\d{2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{1,3})/;

export function parseSrt({ input }: { input: string }): ParseSubtitleResult {
	const normalized = input.replace(/\r\n?/g, "\n").trim();
	if (!normalized) {
		return {
			captions: [],
			skippedCueCount: 0,
			warnings: [],
		};
	}

	const blocks = normalized.split(/\n{2,}/);
	const cues: SubtitleCue[] = [];
	let skippedCueCount = 0;

	for (const block of blocks) {
		const lines = block
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);

		if (lines.length < 2) {
			skippedCueCount += 1;
			continue;
		}

		const timestampIndex = TIMESTAMP_SEPARATOR.test(lines[0]) ? 0 : 1;
		const timestampLine = lines[timestampIndex];
		if (!timestampLine || !TIMESTAMP_PATTERN.test(timestampLine)) {
			skippedCueCount += 1;
			continue;
		}

		const textLines = lines.slice(timestampIndex + 1);
		const text = textLines.join("\n").trim();
		if (!text) {
			skippedCueCount += 1;
			continue;
		}

		const [rawStart, rawEnd] = timestampLine.split(TIMESTAMP_SEPARATOR);
		if (!rawStart || !rawEnd) {
			skippedCueCount += 1;
			continue;
		}

		const startTime = parseSrtTimestamp({ input: rawStart });
		const endTime = parseSrtTimestamp({ input: rawEnd });
		const duration = endTime - startTime;

		if (
			!Number.isFinite(startTime) ||
			!Number.isFinite(endTime) ||
			duration <= 0
		) {
			skippedCueCount += 1;
			continue;
		}

		cues.push({
			text,
			startTime,
			duration,
		});
	}

	return {
		captions: cues,
		skippedCueCount,
		warnings: [],
	};
}

/** Seconds -> "HH:MM:SS,mmm", the SRT timestamp format `parseSrtTimestamp` reads back. */
function formatSrtTimestamp({ seconds }: { seconds: number }): string {
	const totalMs = Math.round(Math.max(0, seconds) * 1000);
	const milliseconds = totalMs % 1000;
	const totalSeconds = Math.floor(totalMs / 1000);
	const secs = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const minutes = totalMinutes % 60;
	const hours = Math.floor(totalMinutes / 60);
	return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(milliseconds).padStart(3, "0")}`;
}

/**
 * Serialize cues to SRT text (the writer half of this module's parser). Cues
 * with no duration or empty text are skipped rather than emitted as a
 * malformed block. The transcript export menu (features/transcription/
 * export-transcript.ts) is the production call site; this module's own tests
 * are the second, verifying a parse(write(x)) round trip.
 */
export function writeSrt({ cues }: { cues: readonly SubtitleCue[] }): string {
	const blocks = cues
		.filter((cue) => cue.duration > 0 && cue.text.trim().length > 0)
		.map((cue, index) => {
			const start = formatSrtTimestamp({ seconds: cue.startTime });
			const end = formatSrtTimestamp({ seconds: cue.startTime + cue.duration });
			return `${index + 1}\n${start} --> ${end}\n${cue.text.trim()}`;
		});
	if (blocks.length === 0) return "";
	return `${blocks.join("\n\n")}\n`;
}

function parseSrtTimestamp({ input }: { input: string }): number {
	const normalized = input.trim().replace(",", ".");
	const match = normalized.match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{1,3})$/);
	if (!match) {
		return Number.NaN;
	}

	const [, hours, minutes, seconds, milliseconds] = match;
	const parsedHours = Number.parseInt(hours, 10);
	const parsedMinutes = Number.parseInt(minutes, 10);
	const parsedSeconds = Number.parseInt(seconds, 10);
	const parsedMilliseconds = Number.parseInt(milliseconds.padEnd(3, "0"), 10);

	return (
		parsedHours * 3600 +
		parsedMinutes * 60 +
		parsedSeconds +
		parsedMilliseconds / 1000
	);
}
