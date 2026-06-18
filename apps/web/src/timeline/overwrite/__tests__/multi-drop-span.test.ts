import { describe, expect, test } from "bun:test";
import {
	buildMultiDropSpan,
	type MultiDropClip,
} from "../multi-drop-span";
import { planClipDrop } from "../overwrite-plan";

const clip = (duration: number): MultiDropClip => ({ duration });

describe("buildMultiDropSpan — combined span + offsets", () => {
	test("single clip: span is [start, start+duration), one offset at start", () => {
		const span = buildMultiDropSpan({ clips: [clip(1000)], start: 500 });
		expect(span).toEqual({
			start: 500,
			end: 1500,
			offsets: [500],
		});
	});

	test("two clips lay out back-to-back from start", () => {
		const span = buildMultiDropSpan({
			clips: [clip(1000), clip(2000)],
			start: 500,
		});
		expect(span.start).toBe(500);
		expect(span.end).toBe(3500); // 500 + 1000 + 2000
		expect(span.offsets).toEqual([500, 1500]);
	});

	test("three clips: each offset is the running sum of prior durations", () => {
		const span = buildMultiDropSpan({
			clips: [clip(100), clip(200), clip(300)],
			start: 0,
		});
		expect(span.offsets).toEqual([0, 100, 300]);
		expect(span.end).toBe(600);
	});

	test("offsets length always matches the clip count", () => {
		const clips = [clip(10), clip(20), clip(30), clip(40)];
		const span = buildMultiDropSpan({ clips, start: 7 });
		expect(span.offsets).toHaveLength(clips.length);
	});

	test("clips placed back-to-back leave no gap or overlap between them", () => {
		const clips = [clip(1000), clip(2000), clip(500)];
		const { offsets } = buildMultiDropSpan({ clips, start: 1000 });
		for (let i = 1; i < clips.length; i++) {
			const prevEnd = offsets[i - 1] + clips[i - 1].duration;
			expect(offsets[i]).toBe(prevEnd);
		}
	});

	test("empty clip list is a degenerate zero-length span", () => {
		const span = buildMultiDropSpan({ clips: [], start: 500 });
		expect(span).toEqual({ start: 500, end: 500, offsets: [] });
	});
});

// The combined span feeds planClipDrop unchanged — these assert the U5 contract:
// carve ONCE over [start, end), then the back-to-back clips fill the carved hole.
describe("buildMultiDropSpan — feeds planClipDrop as one carve", () => {
	test("combined span covering an existing clip carves the whole run (overwrite)", () => {
		// Existing clip [600, 2600). Drop two clips (1000 + 2000) at 1000 ->
		// combined span [1000, 4000). The carve deletes inside [1000, 4000).
		const span = buildMultiDropSpan({
			clips: [clip(1000), clip(2000)],
			start: 1000,
		});
		const plan = planClipDrop({
			existingClips: [{ startTime: 600, duration: 2000 }], // [600, 2600)
			incomingStart: span.start,
			incomingEnd: span.end,
			mode: "overwrite",
		});
		// Splits the enclosing clip at A only (B=4000 is past its end); deletes the
		// [1000, 2600) fragment inside the combined span.
		expect(plan.splitTimes).toEqual([1000]);
		expect(plan.deleteRange).toEqual({ start: 1000, end: 4000 });
	});

	test("combined span ripples once on insert (deltaTicks == total duration)", () => {
		const span = buildMultiDropSpan({
			clips: [clip(1000), clip(2000)],
			start: 1000,
		});
		const plan = planClipDrop({
			existingClips: [{ startTime: 600, duration: 2000 }],
			incomingStart: span.start,
			incomingEnd: span.end,
			mode: "insert",
		});
		expect(plan.deleteRange).toBeNull();
		expect(plan.rippleShift).toEqual({ fromTime: 1000, deltaTicks: 3000 });
	});
});
