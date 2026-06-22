import { describe, expect, test } from "bun:test";
import {
	activeSpans,
	dropSpan,
	draftToPlacementInputs,
	includeSpan,
	placedSpans,
	swapSpan,
	type DraftSpan,
} from "@/features/ai-generate/director/assembly-draft";

function draftSpan(partial: Partial<DraftSpan> & { id: string }): DraftSpan {
	return {
		assetId: "a",
		clipName: "clip.mp4",
		sourceStartSec: 0,
		sourceEndSec: 2,
		sourceDurationSec: 10,
		dropped: false,
		...partial,
	};
}

// three 2s spans (5-7, 0-2, 3-5 in source) — current positions should be 0,2,4
const SPANS: DraftSpan[] = [
	draftSpan({ id: "s0", sourceStartSec: 5, sourceEndSec: 7 }),
	draftSpan({ id: "s1", sourceStartSec: 0, sourceEndSec: 2 }),
	draftSpan({ id: "s2", sourceStartSec: 3, sourceEndSec: 5 }),
];

describe("placedSpans (original→current mapping)", () => {
	test("lays active spans back-to-back; each carries original + floating current", () => {
		const placed = placedSpans(SPANS);
		expect(placed.map((s) => [s.currentStartSec, s.currentEndSec])).toEqual([
			[0, 2],
			[2, 4],
			[4, 6],
		]);
		// originals are preserved alongside the current position
		expect(placed[0]).toMatchObject({ sourceStartSec: 5, sourceEndSec: 7 });
	});

	test("a dropped span is excluded and the rest ripple to close the gap", () => {
		const placed = placedSpans(dropSpan({ spans: SPANS, id: "s1" }));
		expect(placed.map((s) => s.id)).toEqual(["s0", "s2"]);
		expect(placed.map((s) => s.currentStartSec)).toEqual([0, 2]); // s2 moved up
	});
});

describe("drop / include", () => {
	test("drop flags (not deletes) so the span survives for re-include", () => {
		const dropped = dropSpan({ spans: SPANS, id: "s2" });
		expect(dropped).toHaveLength(3); // still present
		expect(activeSpans(dropped).map((s) => s.id)).toEqual(["s0", "s1"]);
		const restored = includeSpan({ spans: dropped, id: "s2" });
		expect(activeSpans(restored).map((s) => s.id)).toEqual(["s0", "s1", "s2"]);
	});
});

describe("swapSpan", () => {
	test("changes source/clip/text but keeps the id and ordinal", () => {
		const swapped = swapSpan({ spans: SPANS, id: "s1", alternate: {
			assetId: "b",
			clipName: "retake.mp4",
			sourceStartSec: 1,
			sourceEndSec: 4, // a 3s take
			sourceDurationSec: 8,
			text: "the better take",
		} });
		const s1 = swapped.find((s) => s.id === "s1");
		expect(s1).toMatchObject({
			id: "s1",
			assetId: "b",
			clipName: "retake.mp4",
			sourceStartSec: 1,
			sourceEndSec: 4,
			text: "the better take",
		});
		// still in position 1; its new 3s length pushes s2's current start to 5
		const placed = placedSpans(swapped);
		expect(placed.map((s) => s.currentStartSec)).toEqual([0, 2, 5]);
	});
});

describe("draftToPlacementInputs", () => {
	test("emits placement inputs only for active spans, in order", () => {
		const inputs = draftToPlacementInputs(dropSpan({ spans: SPANS, id: "s0" }));
		expect(inputs.map((i) => i.mediaId)).toEqual(["a", "a"]);
		expect(inputs[0]).toMatchObject({ sourceStartSec: 0, sourceEndSec: 2 });
	});
});
