import { describe, expect, test } from "bun:test";
import {
	collectBlockedLinkedSpans,
	consolidateAdjacentClips,
	isBlockedByLinkedPartner,
	type ConsolidateClip,
	type ConsolidateGroup,
} from "../consolidate-adjacent-clips";

const clip = ({
	id,
	mediaId = "M",
	startTime,
	trimStart,
	duration,
	mergeable = true,
}: {
	id: string;
	mediaId?: string;
	startTime: number;
	trimStart: number;
	duration: number;
	mergeable?: boolean;
}): ConsolidateClip => ({ id, mediaId, startTime, trimStart, duration, mergeable });

/** Rebuild clips from groups (merged), for the idempotence check. */
const clipsFromGroups = (groups: ConsolidateGroup[]): ConsolidateClip[] =>
	groups.map((g) => ({
		id: g.keepId,
		mediaId: g.mediaId,
		startTime: g.startTime,
		trimStart: g.trimStart,
		duration: g.duration,
		mergeable: g.mergeable,
	}));

const timelineEnd = (groups: ConsolidateGroup[]): number =>
	Math.max(...groups.map((g) => g.startTime + g.duration));

describe("consolidateAdjacentClips (U4/KTD5)", () => {
	// Two clips of media M, source-contiguous (trimStart meets trimEnd) AND timeline-
	// adjacent: A source [0,100) at timeline [0,100); B source [100,150) at [100,150).
	const A = clip({ id: "A", startTime: 0, trimStart: 0, duration: 100 });
	const B = clip({ id: "B", startTime: 100, trimStart: 100, duration: 50 });

	test("two contiguous same-source clips merge into one (keeper = first)", () => {
		const groups = consolidateAdjacentClips({ clips: [A, B] });
		expect(groups).toHaveLength(1);
		expect(groups[0].keepId).toBe("A");
		expect(groups[0].absorbedIds).toEqual(["B"]);
	});

	test("merged clip duration = sum of the parts", () => {
		const groups = consolidateAdjacentClips({ clips: [A, B] });
		expect(groups[0].duration).toBe(150); // 100 + 50
		expect(groups[0].startTime).toBe(0);
		expect(groups[0].trimStart).toBe(0);
	});

	test("total timeline duration is unchanged by consolidation", () => {
		const before = timelineEnd(consolidateAdjacentClips({ clips: [A, B], toleranceTicks: 0 }));
		// A ends at 100, B ends at 150; merged ends at 0+150 = 150. Same span.
		expect(before).toBe(150);
	});

	test("linked audio (same split structure) merges identically = lockstep", () => {
		// The audio track fragmented at the SAME timeline points as the video.
		const aV = consolidateAdjacentClips({ clips: [A, B] });
		const audioA = clip({ id: "vA", mediaId: "Maudio", startTime: 0, trimStart: 0, duration: 100 });
		const audioB = clip({ id: "vB", mediaId: "Maudio", startTime: 100, trimStart: 100, duration: 50 });
		const aA = consolidateAdjacentClips({ clips: [audioA, audioB] });
		// Same grouping shape: one merged clip absorbing one neighbor.
		expect(aA).toHaveLength(aV.length);
		expect(aA[0].absorbedIds).toHaveLength(aV[0].absorbedIds.length);
		expect(aA[0].duration).toBe(aV[0].duration);
	});

	test("a real source jump between clips does NOT merge (content was removed)", () => {
		// B's source starts at 130, not 100 -> 30 ticks of source removed between them.
		const Bjump = clip({ id: "B", startTime: 100, trimStart: 130, duration: 50 });
		const groups = consolidateAdjacentClips({ clips: [A, Bjump] });
		expect(groups).toHaveLength(2);
		expect(groups.every((g) => g.absorbedIds.length === 0)).toBe(true);
	});

	test("a timeline gap between clips does NOT merge (filling it would change output)", () => {
		// B is source-contiguous but sits at timeline 120, leaving a [100,120) gap.
		const Bgap = clip({ id: "B", startTime: 120, trimStart: 100, duration: 50 });
		expect(consolidateAdjacentClips({ clips: [A, Bgap] })).toHaveLength(2);
	});

	test("different media does NOT merge even when timeline-adjacent", () => {
		const Bother = clip({ id: "B", mediaId: "OTHER", startTime: 100, trimStart: 100, duration: 50 });
		expect(consolidateAdjacentClips({ clips: [A, Bother] })).toHaveLength(2);
	});

	test("a non-mergeable clip is never absorbed and breaks the run", () => {
		const mid = clip({ id: "X", startTime: 100, trimStart: 100, duration: 50, mergeable: false });
		const C = clip({ id: "C", startTime: 150, trimStart: 150, duration: 50 });
		// A | X(non-mergeable) | C(source-contiguous with X's end but X can't merge)
		const groups = consolidateAdjacentClips({ clips: [A, mid, C] });
		expect(groups.map((g) => g.keepId)).toEqual(["A", "X", "C"]);
		expect(groups.every((g) => g.absorbedIds.length === 0)).toBe(true);
	});

	test("a run of THREE contiguous slices collapses to one", () => {
		const C = clip({ id: "C", startTime: 150, trimStart: 150, duration: 25 });
		const groups = consolidateAdjacentClips({ clips: [A, B, C] });
		expect(groups).toHaveLength(1);
		expect(groups[0].absorbedIds).toEqual(["B", "C"]);
		expect(groups[0].duration).toBe(175);
	});

	test("idempotent: running again on the merged result changes nothing", () => {
		const once = consolidateAdjacentClips({ clips: [A, B] });
		const twice = consolidateAdjacentClips({ clips: clipsFromGroups(once) });
		expect(twice).toHaveLength(1);
		expect(twice[0].absorbedIds).toEqual([]); // nothing left to merge
		expect(twice[0].duration).toBe(once[0].duration);
	});

	test("sub-frame rounding within tolerance still merges; a frame-sized gap does not", () => {
		const Brounded = clip({ id: "B", startTime: 100, trimStart: 102, duration: 50 }); // 2-tick drift
		expect(consolidateAdjacentClips({ clips: [A, Brounded], toleranceTicks: 120 })).toHaveLength(1);
		const Bframe = clip({ id: "B", startTime: 100, trimStart: 4100, duration: 50 }); // ~1 frame removed
		expect(consolidateAdjacentClips({ clips: [A, Bframe], toleranceTicks: 120 })).toHaveLength(2);
	});

	test("lockstep (review F7): an unmergeable video partner blocks its linked audio from merging", () => {
		// Video V1|V2|V3 all carry an effect (unmergeable); linked audio A1|A2|A3 is
		// plain. Without the guard the audio merges into one element that then pairs
		// with EVERY video slice (linkId + timelineOverlap), so moving one slice drags
		// audio under its siblings. With the guard the audio holds its splits.
		const videoClips = [
			{ linkId: "L", startTime: 0, duration: 100, mergeable: false },
			{ linkId: "L", startTime: 100, duration: 100, mergeable: false },
			{ linkId: "L", startTime: 200, duration: 100, mergeable: false },
		];
		const blocked = collectBlockedLinkedSpans(videoClips);
		expect(blocked).toHaveLength(3);
		// Each audio slice overlaps an unmergeable same-link span -> blocked.
		for (const startTime of [0, 100, 200]) {
			expect(
				isBlockedByLinkedPartner({ linkId: "L", startTime, duration: 100, blocked }),
			).toBe(true);
		}
		// A different link (or unlinked) element is untouched.
		expect(
			isBlockedByLinkedPartner({ linkId: "OTHER", startTime: 0, duration: 100, blocked }),
		).toBe(false);
		expect(
			isBlockedByLinkedPartner({ startTime: 0, duration: 100, blocked }),
		).toBe(false);
		// Non-overlapping same-link element (elsewhere on the timeline) still merges.
		expect(
			isBlockedByLinkedPartner({ linkId: "L", startTime: 500, duration: 100, blocked }),
		).toBe(false);
	});

	test("lockstep: mergeable partners produce no blocked spans (symmetric case unchanged)", () => {
		expect(
			collectBlockedLinkedSpans([
				{ linkId: "L", startTime: 0, duration: 100, mergeable: true },
				{ startTime: 100, duration: 100, mergeable: false }, // unmergeable but unlinked
			]),
		).toEqual([]);
	});

	test("R9 (2P-U5): a pure split that removed nothing collapses back to one clip", () => {
		// Dan's mid-continuous-speech boundary: a clip split into two source-contiguous,
		// timeline-adjacent halves with NOTHING removed. No boundary should survive.
		const left = clip({ id: "L", startTime: 0, trimStart: 0, duration: 100 });
		const right = clip({ id: "R", startTime: 100, trimStart: 100, duration: 100 });
		const groups = consolidateAdjacentClips({ clips: [left, right], toleranceTicks: 120 });
		expect(groups).toHaveLength(1);
		expect(groups[0].absorbedIds).toEqual(["R"]);
		expect(groups[0].duration).toBe(200);
	});
});
