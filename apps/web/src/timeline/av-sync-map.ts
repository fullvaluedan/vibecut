import type { ElementRef, SceneTracks } from "@/timeline";
import {
	asMediaBacked,
	computeOffsetFrames,
	sourceOverlap,
	type MediaBacked,
} from "@/timeline/av-sync";
import type { FrameRate } from "opencut-wasm";

export interface AvSyncEntry {
	offsetFrames: number;
	partner: ElementRef;
}

export type AvSyncMap = ReadonlyMap<string, AvSyncEntry>;

interface Candidate {
	ref: ElementRef;
	media: MediaBacked;
}

function orderedTracks(tracks: SceneTracks) {
	return [...tracks.overlay, tracks.main, ...tracks.audio];
}

/**
 * Build every media clip's A/V-sync offset in ONE O(n) pass instead of the
 * per-clip O(total-elements) scan `computeAvSyncOffset` runs. Semantics are
 * identical: partner pairing prefers the shared `linkId` (falling back to same
 * `mediaId` + overlapping source for legacy clips), the closest source-
 * overlapping partner wins, and the offset math is the shared
 * `computeOffsetFrames`. An unlinked/unpaired clip gets no entry.
 *
 * Iterate tracks in the SAME order the per-clip scan does
 * ([...overlay, main, ...audio], then element order) so the "first qualifying,
 * upgrade to first source-overlapping" tie-break resolves to the same partner.
 */
export function buildAvSyncMap({
	tracks,
	fps,
}: {
	tracks: SceneTracks;
	fps: FrameRate | null;
}): AvSyncMap {
	const order = orderedTracks(tracks);

	// Index candidates by the two pairing keys, preserving iteration order so
	// the tie-break matches the per-clip scan.
	const byLinkId = new Map<string, Candidate[]>();
	const byMediaId = new Map<string, Candidate[]>();
	for (const track of order) {
		for (const el of track.elements) {
			const media = asMediaBacked(el);
			if (!media) continue;
			const candidate: Candidate = {
				ref: { trackId: track.id, elementId: el.id },
				media,
			};
			if (media.linkId !== undefined) {
				const list = byLinkId.get(media.linkId);
				if (list) list.push(candidate);
				else byLinkId.set(media.linkId, [candidate]);
			}
			const mediaList = byMediaId.get(media.mediaId);
			if (mediaList) mediaList.push(candidate);
			else byMediaId.set(media.mediaId, [candidate]);
		}
	}

	const result = new Map<string, AvSyncEntry>();
	for (const track of order) {
		for (const el of track.elements) {
			const self = asMediaBacked(el);
			if (!self) continue;
			const wantType = self.type === "video" ? "audio" : "video";

			// Linked self only pairs by linkId; unlinked self only pairs legacy
			// (mediaId + source overlap). Mirrors the per-clip predicate exactly.
			const candidates =
				self.linkId !== undefined
					? (byLinkId.get(self.linkId) ?? [])
					: (byMediaId.get(self.mediaId) ?? []);

			let partner: MediaBacked | null = null;
			let partnerRef: ElementRef | null = null;
			for (const { ref, media: other } of candidates) {
				if (other.type !== wantType) continue;
				const linked =
					self.linkId !== undefined && other.linkId === self.linkId;
				const legacy =
					self.linkId === undefined &&
					other.mediaId === self.mediaId &&
					sourceOverlap(self, other);
				if (!linked && !legacy) continue;
				// First qualifying candidate is provisional; the first that also
				// source-overlaps wins and ends the search.
				if (!partner || sourceOverlap(self, other)) {
					partner = other;
					partnerRef = ref;
					if (sourceOverlap(self, other)) break;
				}
			}

			if (!partner || !partnerRef) continue;
			result.set(el.id, {
				offsetFrames: computeOffsetFrames({ self, partner, fps }),
				partner: partnerRef,
			});
		}
	}

	return result;
}
