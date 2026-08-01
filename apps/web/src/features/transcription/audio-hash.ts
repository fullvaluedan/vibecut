/**
 * The timeline-audio hash, extracted from `transcript-cache.ts` so the pure
 * consumers (the transcript lineage) can compute it without importing the whole
 * transcription pipeline (zustand stores, mediabunny, the transcription service).
 *
 * `transcript-cache.ts` keeps `computeTimelineAudioHash(editor)` as the public
 * name everything already calls; it delegates here, so there is exactly ONE
 * definition of "which media plays when, with what trims".
 *
 * Pure + wasm-free -> bun-testable.
 */

/** A track, as loosely as the hash reads it (elements are narrowed inside). */
export interface AudioHashTrack {
	elements: readonly unknown[];
}

/** The active scene's tracks, as loosely as the hash reads them. */
export interface AudioHashTracks {
	main: AudioHashTrack;
	overlay: readonly AudioHashTrack[];
	audio: readonly AudioHashTrack[];
}

/**
 * Hash of everything that affects the timeline's WORDS: which media plays when,
 * with what trims. Volume/effects/text don't change the transcript. Elements are
 * sorted before hashing so track ORDER never changes the result.
 */
export function computeAudioHash({ tracks }: { tracks: AudioHashTracks }): string {
	const parts: string[] = [];
	for (const track of [tracks.main, ...tracks.overlay, ...tracks.audio]) {
		for (const el of track.elements) {
			const obj = el as {
				type?: string;
				mediaId?: string;
				startTime?: number;
				duration?: number;
				trimStart?: number;
				trimEnd?: number;
				isSourceAudioEnabled?: boolean;
			};
			if (obj.type !== "video" && obj.type !== "audio") continue;
			if (obj.type === "video" && obj.isSourceAudioEnabled === false) continue;
			parts.push(
				[
					obj.mediaId ?? "",
					Math.round(obj.startTime ?? 0),
					Math.round(obj.duration ?? 0),
					Math.round(obj.trimStart ?? 0),
					Math.round(obj.trimEnd ?? 0),
				].join(":"),
			);
		}
	}
	parts.sort();
	// djb2 over the joined string - collision-safe enough for a local cache.
	let hash = 5381;
	const joined = parts.join("|");
	for (let i = 0; i < joined.length; i++) {
		hash = ((hash << 5) + hash + joined.charCodeAt(i)) | 0;
	}
	return `${parts.length}-${(hash >>> 0).toString(36)}`;
}
