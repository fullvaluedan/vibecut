/**
 * Pure timestamp remap (Plan A / U4) — wasm-free, unit-tested. VAD-gated
 * transcription transcribes ONLY the speech intervals (concatenated into one
 * buffer with known offsets), so every word/segment time comes back in
 * BUFFER-time. This shifts each back to absolute TIMELINE-time. The subtlest
 * part of the VAD pass (a wrong offset misplaces every cut), so it lives here as
 * a tested core, not inline in the worker.
 */

/** One speech interval's place in the concatenated transcription buffer. */
export interface ConcatSegment {
	/** Where this interval starts in the concatenated buffer (seconds). */
	bufferStartSec: number;
	/** Where it starts on the real timeline (seconds). */
	timelineStartSec: number;
	/** Interval length (same in buffer- and timeline-time). */
	durationSec: number;
}

/** A timed item (word or segment) with text. */
export interface TimedItem {
	start: number;
	end: number;
	text: string;
}

const EPS = 1e-6;

/**
 * Remap buffer-time items to timeline-time using the concat map. An item is
 * placed by the segment its START falls in (shift by `timelineStart -
 * bufferStart`); its end is clamped to that segment's timeline end so a word that
 * overruns a concat seam can't bleed into the next interval. Items that fall in
 * no segment (shouldn't happen) are dropped defensively. Output preserves order.
 */
export function remapBufferTimes({
	times,
	segments,
}: {
	times: readonly TimedItem[];
	segments: readonly ConcatSegment[];
}): TimedItem[] {
	const out: TimedItem[] = [];
	for (const item of times) {
		// Half-open [bufferStart, bufferStart+duration): a time exactly on a concat
		// seam belongs to the NEXT interval, not the one ending there.
		const seg = segments.find(
			(s) =>
				item.start >= s.bufferStartSec - EPS &&
				item.start < s.bufferStartSec + s.durationSec,
		);
		if (!seg) continue;
		const delta = seg.timelineStartSec - seg.bufferStartSec;
		const segTimelineEnd = seg.timelineStartSec + seg.durationSec;
		const start = item.start + delta;
		const end = Math.min(item.end + delta, segTimelineEnd);
		if (end > start) out.push({ start, end, text: item.text });
	}
	return out;
}

/**
 * Build the concat map from speech intervals (ascending, timeline-time): laying
 * them back-to-back in a single buffer. The Nth interval's `bufferStart` is the
 * running sum of the prior durations.
 */
export function buildConcatSegments(
	speech: readonly { startSec: number; endSec: number }[],
): ConcatSegment[] {
	const segments: ConcatSegment[] = [];
	let bufferCursor = 0;
	for (const iv of speech) {
		const durationSec = iv.endSec - iv.startSec;
		if (durationSec <= 0) continue;
		segments.push({
			bufferStartSec: bufferCursor,
			timelineStartSec: iv.startSec,
			durationSec,
		});
		bufferCursor += durationSec;
	}
	return segments;
}
