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

	it("leaves a clip abutting the RIGHT edge (elStart == regionEnd) untouched", () => {
		// Region [0,100): A fully covered, B starts exactly at 100 — abutting.
		const plan = planRegionOverwrite({
			elements: track,
			regionStart: 0,
			regionEnd: 100,
		});
		// Full-array assertions: a stray trim/delete for B would be caught.
		expect(plan.deleteIds).toEqual(["A"]);
		expect(plan.trims).toEqual([]);
	});

	it("leaves a clip abutting the LEFT edge (elEnd == regionStart) untouched", () => {
		// L ends exactly at 50; region starts at 50 → L is abutting, not covered.
		// Pins the `elEnd <= regionStart` guard arm against an accidental `<`.
		const plan = planRegionOverwrite({
			elements: [
				{ id: "L", startTime: 0, duration: 50, trimStart: 0 },
				{ id: "M", startTime: 50, duration: 100, trimStart: 0 },
			],
			regionStart: 50,
			regionEnd: 120,
		});
		expect(plan.deleteIds).toEqual([]);
		expect(plan.trims).toEqual([
			{ id: "M", startTime: 120, trimStart: 70, duration: 30 },
		]);
	});

	it("accumulates multiple trims (push, not assign)", () => {
		// Synthetic overlapping input (not a real single-track layout) purely to
		// force two head-trims through the region and prove both are returned.
		const plan = planRegionOverwrite({
			elements: [
				{ id: "X", startTime: 0, duration: 150, trimStart: 0 },
				{ id: "Y", startTime: 50, duration: 100, trimStart: 0 },
			],
			regionStart: 0,
			regionEnd: 100,
		});
		expect(plan.deleteIds).toEqual([]);
		expect(plan.trims).toEqual([
			{ id: "X", startTime: 100, trimStart: 100, duration: 50 },
			{ id: "Y", startTime: 100, trimStart: 50, duration: 50 },
		]);
	});

	it("head-trims a RETIMED survivor by source ticks (cut * rate)", () => {
		// rate 2 → sourceDuration = 2x timeline. Head-trimming 40 timeline ticks
		// must advance the in-point by 40*2 = 80 source ticks, not 40.
		const plan = planRegionOverwrite({
			elements: [{ id: "R", startTime: 0, duration: 100, trimStart: 10, rate: 2 }],
			regionStart: 0,
			regionEnd: 40,
		});
		expect(plan.deleteIds).toEqual([]);
		expect(plan.trims).toEqual([
			{ id: "R", startTime: 40, trimStart: 90, duration: 60 },
		]);
	});

	it("defaults rate to 1 when absent (in-point advances by the timeline cut)", () => {
		const plan = planRegionOverwrite({
			elements: [{ id: "Q", startTime: 0, duration: 100, trimStart: 5 }],
			regionStart: 0,
			regionEnd: 30,
		});
		expect(plan.trims).toEqual([
			{ id: "Q", startTime: 30, trimStart: 35, duration: 70 },
		]);
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
