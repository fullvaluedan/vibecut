import { describe, expect, test } from "bun:test";
import {
	planMainTrackElements,
	type AssemblySpanInput,
} from "@/features/ai-generate/director/assembly-placement";

const TPS = 1000; // ticks per second, for clean numbers

function span(partial: Partial<AssemblySpanInput>): AssemblySpanInput {
	return {
		mediaId: "m",
		name: "clip",
		sourceStartSec: 0,
		sourceEndSec: 1,
		sourceDurationSec: 10,
		...partial,
	};
}

describe("planMainTrackElements", () => {
	test("lays spans back-to-back from t=0 with source-accurate trims", () => {
		const specs = planMainTrackElements({
			spans: [
				span({ mediaId: "a", sourceStartSec: 2, sourceEndSec: 5, sourceDurationSec: 10 }),
				span({ mediaId: "b", sourceStartSec: 0, sourceEndSec: 4, sourceDurationSec: 8 }),
			],
			ticksPerSecond: TPS,
		});
		expect(specs).toHaveLength(2);
		// first: 3s span (2-5) at t=0, trimStart=2s, trimEnd=10-5=5s
		expect(specs[0]).toMatchObject({
			mediaId: "a",
			startTimeTicks: 0,
			durationTicks: 3000,
			trimStartTicks: 2000,
			trimEndTicks: 5000,
			sourceDurationTicks: 10000,
		});
		// second starts where the first ends (3000), 4s span, trimStart=0, trimEnd=8-4=4s
		expect(specs[1]).toMatchObject({
			mediaId: "b",
			startTimeTicks: 3000,
			durationTicks: 4000,
			trimStartTicks: 0,
			trimEndTicks: 4000,
		});
	});

	test("skips degenerate (zero/negative-length) spans without advancing the cursor", () => {
		const specs = planMainTrackElements({
			spans: [
				span({ mediaId: "a", sourceStartSec: 0, sourceEndSec: 2 }),
				span({ mediaId: "bad", sourceStartSec: 5, sourceEndSec: 5 }), // zero length
				span({ mediaId: "c", sourceStartSec: 0, sourceEndSec: 1 }),
			],
			ticksPerSecond: TPS,
		});
		expect(specs.map((s) => s.mediaId)).toEqual(["a", "c"]);
		expect(specs[1].startTimeTicks).toBe(2000); // c sits right after a, not after a gap
	});

	test("defaults isSourceAudioEnabled to true; respects an explicit false", () => {
		const specs = planMainTrackElements({
			spans: [
				span({ mediaId: "a" }),
				span({ mediaId: "b", isSourceAudioEnabled: false }),
			],
			ticksPerSecond: TPS,
		});
		expect(specs[0].isSourceAudioEnabled).toBe(true);
		expect(specs[1].isSourceAudioEnabled).toBe(false);
	});

	test("empty input yields no elements", () => {
		expect(planMainTrackElements({ spans: [], ticksPerSecond: TPS })).toEqual([]);
	});
});
