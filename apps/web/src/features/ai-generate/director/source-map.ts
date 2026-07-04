/**
 * Source-aware transcript mapping for the Director (U3).
 *
 * The assembled timeline interleaves source clips; to select the best take and
 * align B-roll to narration, the Director must answer two questions:
 *   1. "what SOURCE position does this TIMELINE moment correspond to?"
 *      → `timelineTimeToSource`
 *   2. "which source asset said each transcript line, and where in that source?"
 *      → `groupTranscriptByAsset`
 *
 * Mapping math (retime + trim aware) reuses the canonical `getSourceTimeAtClipTime`
 * — the exact mapping `audio-manager.ts` composes as
 * `clip.trimStart + getSourceTimeAtClipTime({ clipTime, retime })` — rather than
 * the trim/retime-unaware `getElementLocalTime` clamp. Because that helper and its
 * only dependency (`clampRetimeRate`) are wasm-free, this module is bun-testable
 * without the opencut-wasm binary; the only `@/timeline` import is type-only.
 */

import { getSourceTimeAtClipTime } from "@/retime/resolve";
import type { RetimeConfig } from "@/timeline";

// Ticks per second — a wasm-free local copy of `@/wasm`'s `TICKS_PER_SECOND`
// (120_000), kept inline so this pure mapping module can be unit-tested under
// `bun test` without loading the opencut-wasm binary (matches the precedent in
// `timeline/__tests__/razor.test.ts` and the v22→v23 storage migration).
const TICKS_PER_SECOND = 120_000;

/**
 * The minimal main-track element shape the source map reads. The real
 * `VideoElement`/`AudioElement` satisfy it structurally — callers pass
 * `tracks.main.elements` directly.
 */
export interface SourceMapElement {
	/** Stable element id. */
	id: string;
	/** The source asset this element references. */
	mediaId: string;
	/** Timeline start, in ticks. */
	startTime: number;
	/** On-timeline duration, in ticks. */
	duration: number;
	/** Source in-point, in ticks. */
	trimStart: number;
	/** Playback retime (rate); absent means 1×. */
	retime?: RetimeConfig;
}

/** A resolved source location: which asset, and where in it (seconds). */
export interface SourceLocation {
	assetId: string;
	sourceSec: number;
}

/**
 * Map a TIMELINE time (ticks) to the SOURCE position of the main-track element
 * under it. Retime-aware (a 2× clip consumes source twice as fast) and trim-aware
 * (the in-point offsets the source). Returns `null` over a gap (no element).
 *
 * Boundaries are half-open `[startTime, startTime + duration)` to match the rest
 * of the timeline geometry: at an exact cut between two adjacent clips the later
 * clip wins.
 */
export function timelineTimeToSource({
	timelineTicks,
	elements,
}: {
	timelineTicks: number;
	elements: readonly SourceMapElement[];
}): SourceLocation | null {
	const element = elements.find(
		(candidate) =>
			candidate.startTime <= timelineTicks &&
			timelineTicks < candidate.startTime + candidate.duration,
	);
	if (!element) {
		return null;
	}

	const clipTime = timelineTicks - element.startTime;
	const sourceTicks =
		element.trimStart +
		getSourceTimeAtClipTime({ clipTime, retime: element.retime });

	return { assetId: element.mediaId, sourceSec: sourceTicks / TICKS_PER_SECOND };
}

/** A transcript segment in TIMELINE time (seconds), as produced by Whisper over the assembled timeline. */
export interface TranscriptSegment {
	/** Timeline start, in seconds. */
	start: number;
	/** Timeline end, in seconds. */
	end: number;
	text: string;
}

/** A segment re-anchored to its source asset, carrying where it begins in that source. */
export interface AssetTranscriptSegment extends TranscriptSegment {
	/** Where this segment starts in the SOURCE asset, in seconds. */
	sourceStartSec: number;
}

/** All transcript covered by one source asset, in timeline order. */
export interface AssetTranscript {
	assetId: string;
	segments: AssetTranscriptSegment[];
}

/**
 * Group timeline transcript segments by the source asset that covers each one,
 * so the take-selector can compare what each source clip actually said (two clips
 * of the same scripted line surface as two entries to align). A segment is
 * attributed to the asset under its MIDPOINT (robust to a boundary clipping the
 * head/tail), and carries its source start time. Segments over a gap are dropped.
 *
 * Insertion order of the returned array is first-appearance order of each asset.
 */
export function groupTranscriptByAsset({
	segments,
	elements,
}: {
	segments: readonly TranscriptSegment[];
	elements: readonly SourceMapElement[];
}): AssetTranscript[] {
	const byAsset = new Map<string, AssetTranscript>();

	for (const segment of segments) {
		const midpointSec = (segment.start + segment.end) / 2;
		const located = timelineTimeToSource({
			timelineTicks: Math.round(midpointSec * TICKS_PER_SECOND),
			elements,
		});
		if (!located) {
			continue;
		}

		// Anchor to the segment's start in source where possible; fall back to the
		// midpoint's source time if the start lands in a gap (e.g. a segment whose
		// head was trimmed off at assembly).
		const atStart = timelineTimeToSource({
			timelineTicks: Math.round(segment.start * TICKS_PER_SECOND),
			elements,
		});
		const sourceStartSec =
			atStart && atStart.assetId === located.assetId
				? atStart.sourceSec
				: located.sourceSec;

		let entry = byAsset.get(located.assetId);
		if (!entry) {
			entry = { assetId: located.assetId, segments: [] };
			byAsset.set(located.assetId, entry);
		}
		entry.segments.push({ ...segment, sourceStartSec });
	}

	return [...byAsset.values()];
}
