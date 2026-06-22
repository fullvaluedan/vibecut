/**
 * Remove Silences: analyzes the timeline's mixed audio, finds stretches with
 * no speech/sound, and cuts them out across all tracks (ripple).
 */

import { RemoveRangesCommand, type TimeRange } from "@/commands/timeline/track/remove-ranges";
import { decodeAudioToFloat32 } from "@/media/audio";
import { extractTimelineAudio } from "@/media/mediabunny";
import { DEFAULT_TRANSCRIPTION_SAMPLE_RATE } from "@/transcription/audio";
import { TICKS_PER_SECOND } from "@/wasm";
import type { EditorCore } from "@/core";
import {
	collectVideoClipSpansSec,
	refineSilenceRanges,
} from "./silence-refine";

const WINDOW_SEC = 0.05;
const MIN_SILENCE_SEC = 0.6;
/** Keep this much breathing room around speech on each side of a cut. */
const PADDING_SEC = 0.15;
const RMS_THRESHOLD = 0.015;
/** Snap a cut edge this close to a clip boundary out to it (kills padding slivers). */
const SNAP_SEC = 0.25;
/** Drop a refined range shorter than this (matches the detector's own floor). */
const MIN_REMOVED_SEC = 0.2;

export function detectSilentRangesSec({
	samples,
	sampleRate,
}: {
	samples: Float32Array;
	sampleRate: number;
}): { start: number; end: number }[] {
	const windowSize = Math.round(WINDOW_SEC * sampleRate);
	const windowCount = Math.floor(samples.length / windowSize);
	const silentWindows: boolean[] = new Array(windowCount);

	for (let w = 0; w < windowCount; w++) {
		let sum = 0;
		const base = w * windowSize;
		for (let i = 0; i < windowSize; i++) {
			const s = samples[base + i];
			sum += s * s;
		}
		silentWindows[w] = Math.sqrt(sum / windowSize) < RMS_THRESHOLD;
	}

	const ranges: { start: number; end: number }[] = [];
	let runStart = -1;
	for (let w = 0; w <= windowCount; w++) {
		const isSilent = w < windowCount && silentWindows[w];
		if (isSilent && runStart < 0) runStart = w;
		if (!isSilent && runStart >= 0) {
			const startSec = runStart * WINDOW_SEC;
			const endSec = w * WINDOW_SEC;
			if (endSec - startSec >= MIN_SILENCE_SEC) {
				ranges.push({
					start: startSec + PADDING_SEC,
					end: endSec - PADDING_SEC,
				});
			}
			runStart = -1;
		}
	}
	return ranges.filter((r) => r.end - r.start >= 0.2);
}

export async function runRemoveSilences({
	editor,
}: {
	editor: EditorCore;
}): Promise<{ cuts: number; removedSec: number }> {
	const totalDuration = editor.timeline.getTotalDuration();
	if (totalDuration / TICKS_PER_SECOND < 1) {
		throw new Error("Add some footage to the timeline first.");
	}
	const audioBlob = await extractTimelineAudio({
		tracks: editor.scenes.getActiveScene().tracks,
		mediaAssets: editor.media.getAssets(),
		totalDuration,
	});
	const { samples, sampleRate } = await decodeAudioToFloat32({
		audioBlob,
		sampleRate: DEFAULT_TRANSCRIPTION_SAMPLE_RATE,
	});
	const silent = detectSilentRangesSec({ samples, sampleRate });
	// Issue 2: never delete a whole VIDEO clip on low audio (quiet showcase/b-roll
	// footage), and snap cut edges to clip boundaries so a cut never leaves a
	// ~4-frame remnant.
	const refined = refineSilenceRanges({
		ranges: silent,
		clipSpans: collectVideoClipSpansSec({
			tracks: editor.scenes.getActiveScene().tracks,
			ticksPerSecond: TICKS_PER_SECOND,
		}),
		snapSec: SNAP_SEC,
		minSec: MIN_REMOVED_SEC,
	});
	if (!refined.length) {
		return { cuts: 0, removedSec: 0 };
	}
	const ranges: TimeRange[] = refined.map((r) => ({
		start: Math.round(r.start * TICKS_PER_SECOND),
		end: Math.round(r.end * TICKS_PER_SECOND),
	}));
	const command = new RemoveRangesCommand({ ranges });
	editor.command.execute({ command });
	const removedSec = refined.reduce((acc, r) => acc + (r.end - r.start), 0);
	return { cuts: command.getRemovedCount(), removedSec };
}
