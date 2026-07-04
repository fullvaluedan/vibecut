import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { SceneTracks, TimelineElement, TimelineTrack } from "@/timeline";
import { addMediaTime } from "@/wasm";
import {
	collectBlockedLinkedSpans,
	consolidateAdjacentClips,
	isBlockedByLinkedPartner,
	type BlockedLinkedSpan,
	type ConsolidateClip,
} from "@/features/ai-generate/director/consolidate-adjacent-clips";

/**
 * Merge sub-frame rounding only: 1ms in ticks. Far below one frame, so a real
 * removed source gap between two clips is never mistaken for contiguity.
 */
const CONTIGUITY_TOLERANCE_TICKS = 120;

/** A retimed clip's source-vs-timeline math breaks the contiguity check; only merge
 * rate-1 (or un-retimed) media slices. */
function isRateOne(retime: { rate: number } | undefined): boolean {
	return retime === undefined || retime.rate === 1;
}

/**
 * A clip is mergeable only when it is a plain raw media slice: a video, or an
 * uploaded audio element (`mediaId`), with no retime and nothing the merge can't
 * carry (effects / masks / animations / AI recipe). Anything else is never merged
 * and also breaks a run so its neighbors don't merge across it.
 */
function toConsolidateClip(el: TimelineElement): ConsolidateClip {
	const hasMedia = "mediaId" in el;
	const anyEl = el as unknown as {
		retime?: { rate: number };
		effects?: unknown[];
		masks?: unknown[];
		animations?: unknown;
		framecutAi?: unknown;
	};
	const mergeable =
		hasMedia &&
		(el.type === "video" || el.type === "audio") &&
		isRateOne(anyEl.retime) &&
		!(anyEl.effects && anyEl.effects.length > 0) &&
		!(anyEl.masks && anyEl.masks.length > 0) &&
		!anyEl.animations &&
		!anyEl.framecutAi;
	return {
		id: el.id,
		mediaId: hasMedia ? (el as unknown as { mediaId: string }).mediaId : "",
		startTime: el.startTime,
		trimStart: el.trimStart,
		duration: el.duration,
		mergeable,
	};
}

/** Rebuild one track's element list with adjacent same-source slices merged. */
function consolidateTrack<T extends TimelineTrack>(
	track: T,
	blocked: readonly BlockedLinkedSpan[],
): T {
	const byId = new Map(track.elements.map((el) => [el.id, el]));
	const groups = consolidateAdjacentClips({
		clips: track.elements.map((el) => {
			const clip = toConsolidateClip(el);
			// Lockstep (review F7): a linked element overlapping an unmergeable partner
			// span holds its splits too, so linked pairing stays slice-to-slice.
			if (
				clip.mergeable &&
				isBlockedByLinkedPartner({
					linkId: el.linkId,
					startTime: el.startTime,
					duration: el.duration,
					blocked,
				})
			) {
				return { ...clip, mergeable: false };
			}
			return clip;
		}),
		toleranceTicks: CONTIGUITY_TOLERANCE_TICKS,
	});
	const elements: TimelineElement[] = [];
	for (const group of groups) {
		const keep = byId.get(group.keepId);
		if (!keep) continue;
		if (group.absorbedIds.length === 0) {
			elements.push(keep);
			continue;
		}
		// Merged clip: keep the first slice's id / start / trimStart, extend duration to
		// the sum, and take the LAST absorbed slice's trimEnd (the merged span's end).
		let duration = keep.duration;
		for (const id of group.absorbedIds) {
			const absorbed = byId.get(id);
			if (absorbed) duration = addMediaTime({ a: duration, b: absorbed.duration });
		}
		const lastId = group.absorbedIds[group.absorbedIds.length - 1];
		const lastAbsorbed = byId.get(lastId);
		elements.push({
			...keep,
			duration,
			...(lastAbsorbed ? { trimEnd: lastAbsorbed.trimEnd } : {}),
		} as TimelineElement);
	}
	return { ...track, elements };
}

/**
 * Consolidation pass (KTD5): merge consecutive same-source contiguous clips on every
 * track into one, collapsing the fragment count a heavy recut leaves behind without
 * changing any output. Reads the CURRENT (post-removal) timeline at execute time, so
 * it runs LAST in the Director apply BatchCommand and everything is one undo. Video
 * and its linked audio merge in lockstep because the cuts fragmented every track at
 * the same points. Representation-only: total duration and every frame are unchanged.
 */
export class ConsolidateAdjacentClipsCommand extends Command {
	private savedState: SceneTracks | null = null;

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;
		const tracks = this.savedState;
		// Lockstep pre-pass (review F7): spans of unmergeable LINKED elements across
		// every track, so their partners on other tracks hold their splits too.
		const blocked = collectBlockedLinkedSpans(
			[tracks.main, ...tracks.overlay, ...tracks.audio].flatMap((track) =>
				track.elements.map((el) => ({
					linkId: el.linkId,
					startTime: el.startTime,
					duration: el.duration,
					mergeable: toConsolidateClip(el).mergeable,
				})),
			),
		);
		const next: SceneTracks = {
			...tracks,
			main: consolidateTrack(tracks.main, blocked),
			overlay: tracks.overlay.map((t) => consolidateTrack(t, blocked)),
			audio: tracks.audio.map((t) => consolidateTrack(t, blocked)),
		};
		editor.timeline.updateTracks(next);
		// Merging drops the absorbed elements; declare the reconciled selection so undo
		// restores the pre-consolidation selection cleanly (mirrors RemoveRangesCommand).
		return { selection: editor.selection.getSnapshot() };
	}

	undo(): void {
		if (this.savedState) {
			EditorCore.getInstance().timeline.updateTracks(this.savedState);
		}
	}
}
