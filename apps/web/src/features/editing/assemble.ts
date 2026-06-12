/**
 * Assemble: lay every (non-ephemeral) bin asset onto the timeline
 * back-to-back, in the bin's current sort order, starting after any
 * existing main-track content — turning the project into one video.
 */

import type { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
import { TICKS_PER_SECOND, mediaTimeFromSeconds } from "@/wasm";
import { DEFAULT_NEW_ELEMENT_DURATION } from "@/timeline/creation";
import { insertMediaAsset } from "./insert-media";

export function assembleBinToTimeline({
	editor,
	assets,
}: {
	editor: EditorCore;
	assets: MediaAsset[];
}): { added: number; skipped: number } {
	const tracks = editor.scenes.getActiveScene().tracks;
	// Assets already placed ANYWHERE on the timeline (any track — users often
	// drop footage on V2) must not be assembled again: doubling a long video
	// stacks its audio over itself and wrecks every transcript-based AI pass.
	const usedMediaIds = new Set(
		[tracks.main, ...tracks.overlay, ...tracks.audio].flatMap((track) =>
			track.elements.flatMap((el) =>
				"mediaId" in el && el.mediaId ? [el.mediaId] : [],
			),
		),
	);
	const usable = assets.filter((a) => !a.ephemeral && !usedMediaIds.has(a.id));
	if (!usable.length) {
		return { added: 0, skipped: 0 };
	}

	const mainTrackId = tracks.main.id;
	// Start after existing content on ANY track, not just main — appending at
	// 0 under footage that lives on V2 overlaps it in time.
	let cursorSec = [tracks.main, ...tracks.overlay, ...tracks.audio].reduce(
		(end, track) =>
			track.elements.reduce(
				(trackEnd, el) =>
					Math.max(trackEnd, (el.startTime + el.duration) / TICKS_PER_SECOND),
				end,
			),
		0,
	);

	let added = 0;
	let skipped = 0;
	for (const asset of usable) {
		const durationSec =
			asset.duration ?? DEFAULT_NEW_ELEMENT_DURATION / TICKS_PER_SECOND;
		const startTime = mediaTimeFromSeconds({ seconds: cursorSec });
		const placement =
			asset.type === "audio"
				? ({ mode: "auto" } as const)
				: ({ mode: "explicit", trackId: mainTrackId } as const);
		const { elementId } = insertMediaAsset({
			editor,
			asset,
			startTime,
			placement,
		});
		if (elementId) {
			added += 1;
			cursorSec += durationSec;
		} else {
			skipped += 1;
		}
	}

	return { added, skipped };
}
