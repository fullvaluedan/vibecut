import type { ElementRef, SceneTracks, TimelineElement } from "@/timeline";
import { frameRateToFloat } from "@/fps/utils";
import { TICKS_PER_SECOND } from "@/wasm";
import type { FrameRate } from "opencut-wasm";

export interface MediaBacked {
	type: "video" | "audio";
	mediaId: string;
	startTime: number;
	trimStart: number;
	duration: number;
	linkId?: string;
}

export function asMediaBacked(el: TimelineElement): MediaBacked | null {
	if ((el.type === "video" || el.type === "audio") && "mediaId" in el) {
		return el as unknown as MediaBacked;
	}
	return null;
}

export function sourceOverlap(a: MediaBacked, b: MediaBacked): boolean {
	return (
		a.trimStart < b.trimStart + b.duration &&
		a.trimStart + a.duration > b.trimStart
	);
}

/** Overlap of the two clips' SOURCE spans in ticks (<= 0 means no overlap). */
export function sourceOverlapAmount(a: MediaBacked, b: MediaBacked): number {
	return (
		Math.min(a.trimStart + a.duration, b.trimStart + b.duration) -
		Math.max(a.trimStart, b.trimStart)
	);
}

/** Overlap of the two clips' TIMELINE spans in ticks (<= 0 means no overlap). */
export function timelineOverlapAmount(a: MediaBacked, b: MediaBacked): number {
	return (
		Math.min(a.startTime + a.duration, b.startTime + b.duration) -
		Math.max(a.startTime, b.startTime)
	);
}

export interface AvSyncPartnerCandidate {
	ref: ElementRef;
	media: MediaBacked;
}

/**
 * Whether `candidate` should replace `current` as `self`'s A/V partner.
 * Pairing picks the LARGEST source overlap (tie-break: largest timeline
 * overlap; remaining ties keep the earlier candidate in track order).
 *
 * The old rule ("first source-overlapping candidate wins") mispaired after a
 * split + extend: a video extended across an old cut source-overlaps BOTH
 * audio halves, and the first half won even when the other was the true
 * partner, so the sync badge fired on a genuinely in-sync pair (LIVE-TEST
 * item 10). Shared by `computeAvSyncOffset` and `buildAvSyncMap` so the two
 * always resolve the same partner.
 */
export function isBetterAvSyncPartner({
	self,
	current,
	candidate,
}: {
	self: MediaBacked;
	current: AvSyncPartnerCandidate | null;
	candidate: AvSyncPartnerCandidate;
}): boolean {
	if (!current) return true;
	const candidateSource = Math.max(0, sourceOverlapAmount(self, candidate.media));
	const currentSource = Math.max(0, sourceOverlapAmount(self, current.media));
	if (candidateSource !== currentSource) {
		return candidateSource > currentSource;
	}
	const candidateTimeline = Math.max(
		0,
		timelineOverlapAmount(self, candidate.media),
	);
	const currentTimeline = Math.max(
		0,
		timelineOverlapAmount(self, current.media),
	);
	return candidateTimeline > currentTimeline;
}

/**
 * The signed frame drift of a video/audio pair, audio relative to video:
 *   (start − trimStart)_audio − (start − trimStart)_video
 * Positive = audio is later than the picture. Shared by the per-clip
 * `computeAvSyncOffset` and the once-per-tracks `buildAvSyncMap` so both
 * report identical values.
 */
export function computeOffsetFrames({
	self,
	partner,
	fps,
}: {
	self: MediaBacked;
	partner: MediaBacked;
	fps: FrameRate | null;
}): number {
	const video = self.type === "video" ? self : partner;
	const audio = self.type === "audio" ? self : partner;
	const offsetTicks =
		audio.startTime - audio.trimStart - (video.startTime - video.trimStart);
	const fpsFloat = fps ? frameRateToFloat(fps) : 30;
	return Math.round((offsetTicks / TICKS_PER_SECOND) * fpsFloat);
}

/**
 * The frame offset between a clip and its A/V partner (the audio separated
 * from a video, or vice-versa). Two clips are "in sync" when their source
 * origin lands at the same timeline position:
 *   (start − trimStart)_audio  ===  (start − trimStart)_video
 * A non-zero difference is the drift, reported in frames (audio relative to
 * video: positive = audio is later than the picture).
 *
 * Partner pairing prefers the shared `linkId` (still found after the clips
 * drift apart) and falls back to same `mediaId` + overlapping source span for
 * legacy clips that predate linking. Among qualifying candidates the LARGEST
 * source overlap wins (see `isBetterAvSyncPartner`).
 */
export function computeAvSyncOffset({
	element,
	tracks,
	fps,
}: {
	element: TimelineElement;
	tracks: SceneTracks;
	fps: FrameRate | null;
}): { offsetFrames: number; partner: ElementRef } | null {
	const self = asMediaBacked(element);
	if (!self) return null;
	const wantType = self.type === "video" ? "audio" : "video";

	let best: AvSyncPartnerCandidate | null = null;
	for (const track of [...tracks.overlay, tracks.main, ...tracks.audio]) {
		for (const candidate of track.elements) {
			const other = asMediaBacked(candidate);
			if (!other || other.type !== wantType) continue;
			const linked =
				self.linkId !== undefined && other.linkId === self.linkId;
			const legacy =
				self.linkId === undefined &&
				other.mediaId === self.mediaId &&
				sourceOverlap(self, other);
			if (!linked && !legacy) continue;
			const next = {
				ref: { trackId: track.id, elementId: candidate.id },
				media: other,
			};
			if (isBetterAvSyncPartner({ self, current: best, candidate: next })) {
				best = next;
			}
		}
	}
	if (!best) return null;

	const offsetFrames = computeOffsetFrames({ self, partner: best.media, fps });
	return { offsetFrames, partner: best.ref };
}
