import { describe, expect, it } from "bun:test";
import {
	planRegionOverwrite,
	type OverwriteRegionElement,
} from "@/timeline/controllers/overwrite-region";

/**
 * `executeMediaOverwrite` drops a clip on top of an existing one at the old
 * clip's start, for the NEW media's full length, and clears that region without
 * rippling. This is the pure geometry behind it. The replaced clip is always
 * element-0 starting at `regionStart`, so every case here starts a region on a
 * clip boundary (no left-edge straddle).
 */
describe("planRegionOverwrite", () => {
	const track: OverwriteRegionElement[] = [
		{ id: "A", startTime: 0, duration: 100, trimStart: 0 },
		{ id: "B", startTime: 100, duration: 50, trimStart: 0 },
		{ id: "C", startTime: 150, duration: 100, trimStart: 10 },
	];

	it("longer drop deletes fully-covered clips and head-trims the straddled one", () => {
		// New 200-tick clip on A → region [0, 200): A and B vanish, C's head is cut.
		const plan = planRegionOverwrite({
			elements: track,
			regionStart: 0,
			regionEnd: 200,
		});
		expect(plan.deleteIds).toEqual(["A", "B"]);
		expect(plan.trims).toEqual([
			{ id: "C", startTime: 200, trimStart: 60, duration: 50 },
		]);
	});

	it("shorter drop keeps the replaced clip's tail and leaves neighbours alone", () => {
		// New 40-tick clip on A → region [0, 40): A head-trimmed to [40,100), no gap.
		const plan = planRegionOverwrite({
			elements: track,
			regionStart: 0,
			regionEnd: 40,
		});
		expect(plan.deleteIds).toEqual([]);
		expect(plan.trims).toEqual([
			{ id: "A", startTime: 40, trimStart: 40, duration: 60 },
		]);
	});

	it("exact-length drop just deletes the replaced clip", () => {
		const plan = planRegionOverwrite({
			elements: track,
			regionStart: 0,
			regionEnd: 100,
		});
		expect(plan.deleteIds).toEqual(["A"]);
		expect(plan.trims).toEqual([]);
	});

	it("leaves clips that only touch the region edge untouched", () => {
		// Region [0,100): B starts exactly at 100 — abutting, not overlapping.
		const plan = planRegionOverwrite({
			elements: track,
			regionStart: 0,
			regionEnd: 100,
		});
		expect(plan.trims.some((t) => t.id === "B")).toBe(false);
		expect(plan.deleteIds).not.toContain("B");
	});

	it("defensive: a clip starting before the region is tail-trimmed, not split", () => {
		const plan = planRegionOverwrite({
			elements: [{ id: "X", startTime: 50, duration: 100, trimStart: 5 }],
			regionStart: 100,
			regionEnd: 200,
		});
		expect(plan.deleteIds).toEqual([]);
		expect(plan.trims).toEqual([
			{ id: "X", startTime: 50, trimStart: 5, duration: 50 },
		]);
	});
});
