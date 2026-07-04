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
 * legacy clips that predate linking.
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

	let partnerRef: ElementRef | null = null;
	let partner: MediaBacked | null = null;
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
			// Prefer the closest source-overlapping partner.
			if (!partner || sourceOverlap(self, other)) {
				partner = other;
				partnerRef = { trackId: track.id, elementId: candidate.id };
				if (sourceOverlap(self, other)) break;
			}
		}
		if (partner && partnerRef && sourceOverlap(self, partner)) break;
	}
	if (!partner || !partnerRef) return null;

	const offsetFrames = computeOffsetFrames({ self, partner, fps });
	return { offsetFrames, partner: partnerRef };
}
