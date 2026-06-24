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

/**
 * Slice the SPEECH intervals out of the decoded samples and concatenate them
 * back-to-back into one buffer for VAD-gated transcription (U4) — so a long
 * source's silence is never fed to Whisper. Returns the buffer AND the matching
 * concat map, both derived from the SAME sample-accurate slice boundaries (so
 * `remapBufferTimes` lines up exactly with what was transcribed — no rounding
 * drift between the two). Intervals are clamped to the sample range; empty/zero
 * slices are skipped.
 */
export function concatSpeechSamples({
	samples,
	sampleRate,
	speech,
}: {
	samples: Float32Array;
	sampleRate: number;
	speech: readonly { startSec: number; endSec: number }[];
}): { buffer: Float32Array; segments: ConcatSegment[] } {
	const slices: { from: number; to: number; timelineStartSec: number }[] = [];
	let total = 0;
	for (const iv of speech) {
		const from = Math.max(0, Math.round(iv.startSec * sampleRate));
		const to = Math.min(samples.length, Math.round(iv.endSec * sampleRate));
		if (to > from) {
			slices.push({ from, to, timelineStartSec: iv.startSec });
			total += to - from;
		}
	}
	const buffer = new Float32Array(total);
	const segments: ConcatSegment[] = [];
	let cursor = 0;
	for (const slice of slices) {
		buffer.set(samples.subarray(slice.from, slice.to), cursor);
		const length = slice.to - slice.from;
		segments.push({
			bufferStartSec: cursor / sampleRate,
			timelineStartSec: slice.timelineStartSec,
			durationSec: length / sampleRate,
		});
		cursor += length;
	}
	return { buffer, segments };
}
