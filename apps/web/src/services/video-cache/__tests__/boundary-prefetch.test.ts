import { describe, expect, test } from "bun:test";
import {
	DEFAULT_PREFETCH_LOOKAHEAD_SEC,
	findActiveClipIndex,
	isWithinBoundaryLookahead,
	type PrefetchClip,
	resolveBoundaryPrefetch,
} from "../boundary-prefetch";

// Two adjacent clips from DIFFERENT sources: clip A [0,10) then clip B [10,20),
// where B's first frame is at source time 5s (its trimStart).
const TWO_SOURCE_CLIPS: PrefetchClip[] = [
	{ mediaId: "A", startSec: 0, endSec: 10, sourceStartSec: 0 },
	{ mediaId: "B", startSec: 10, endSec: 20, sourceStartSec: 5 },
];

describe("isWithinBoundaryLookahead", () => {
	test("inside the window (0.4s before end, 0.5s lookahead)", () => {
		expect(
			isWithinBoundaryLookahead({
				playheadSec: 9.6,
				currentClipEndSec: 10,
				lookaheadSec: 0.5,
			}),
		).toBe(true);
	});

	test("outside the window (2s before end)", () => {
		expect(
			isWithinBoundaryLookahead({
				playheadSec: 8,
				currentClipEndSec: 10,
				lookaheadSec: 0.5,
			}),
		).toBe(false);
	});

	test("at or past the end is not 'approaching' (remaining <= 0)", () => {
		expect(
			isWithinBoundaryLookahead({
				playheadSec: 10,
				currentClipEndSec: 10,
				lookaheadSec: 0.5,
			}),
		).toBe(false);
	});
});

describe("findActiveClipIndex", () => {
	test("finds the clip whose span contains the playhead", () => {
		expect(
			findActiveClipIndex({ clips: TWO_SOURCE_CLIPS, playheadSec: 9.6 }),
		).toBe(0);
		expect(
			findActiveClipIndex({ clips: TWO_SOURCE_CLIPS, playheadSec: 12 }),
		).toBe(1);
	});

	test("returns -1 in a gap / past the last clip", () => {
		expect(
			findActiveClipIndex({ clips: TWO_SOURCE_CLIPS, playheadSec: 25 }),
		).toBe(-1);
	});
});

describe("resolveBoundaryPrefetch", () => {
	test("within lookahead → warms the next clip's boundary source time", () => {
		expect(
			resolveBoundaryPrefetch({
				clips: TWO_SOURCE_CLIPS,
				playheadSec: 9.6,
				lookaheadSec: 0.5,
			}),
		).toEqual({ mediaId: "B", sourceTimeSec: 5 });
	});

	test("2s before the end (outside lookahead) → no prefetch", () => {
		expect(
			resolveBoundaryPrefetch({
				clips: TWO_SOURCE_CLIPS,
				playheadSec: 8,
				lookaheadSec: 0.5,
			}),
		).toBeNull();
	});

	test("last clip (no next) → no prefetch", () => {
		// Playhead inside the final clip, well within a lookahead of its end.
		expect(
			resolveBoundaryPrefetch({
				clips: TWO_SOURCE_CLIPS,
				playheadSec: 19.7,
				lookaheadSec: 0.5,
			}),
		).toBeNull();
	});

	test("no active clip (playhead in a gap) → no prefetch", () => {
		expect(
			resolveBoundaryPrefetch({
				clips: TWO_SOURCE_CLIPS,
				playheadSec: 25,
				lookaheadSec: 0.5,
			}),
		).toBeNull();
	});

	test("same-source continuation → no prefetch (shared warm sink, no deep seek)", () => {
		// Clip B continues clip A from the SAME source (mediaId A, source time
		// picking up where A left off). Warming it would re-seek the sink that is
		// currently drawing A, so the decision must skip it.
		const sameSourceClips: PrefetchClip[] = [
			{ mediaId: "A", startSec: 0, endSec: 10, sourceStartSec: 0 },
			{ mediaId: "A", startSec: 10, endSec: 20, sourceStartSec: 10 },
		];
		expect(
			resolveBoundaryPrefetch({
				clips: sameSourceClips,
				playheadSec: 9.6,
				lookaheadSec: 0.5,
			}),
		).toBeNull();
	});

	test("default lookahead is applied when omitted", () => {
		// 0.4s before the end sits inside the 0.5s default window.
		expect(
			resolveBoundaryPrefetch({
				clips: TWO_SOURCE_CLIPS,
				playheadSec: 10 - DEFAULT_PREFETCH_LOOKAHEAD_SEC + 0.1,
			}),
		).toEqual({ mediaId: "B", sourceTimeSec: 5 });
	});

	test("empty timeline → no prefetch", () => {
		expect(
			resolveBoundaryPrefetch({ clips: [], playheadSec: 0 }),
		).toBeNull();
	});
});
