import { describe, expect, test } from "bun:test";
import { detectNoiseFragmentCuts } from "../noise-fragment";

const WIN = 0.05; // ENERGY_WINDOW_SEC default

/** Build an energy envelope of `totalSec` with the given second-ranges set loud. */
function buildEnvelope({
	totalSec,
	loudSecRanges = [],
	loud = 0.8,
}: {
	totalSec: number;
	loudSecRanges?: ReadonlyArray<readonly [number, number]>;
	loud?: number;
}): number[] {
	const n = Math.round(totalSec / WIN);
	const env = new Array<number>(n).fill(0);
	for (const [s, e] of loudSecRanges) {
		const from = Math.floor(s / WIN);
		const to = Math.ceil(e / WIN);
		for (let i = from; i < Math.min(n, to); i++) {
			env[i] = loud;
		}
	}
	return env;
}

const span = ({
	startSec,
	endSec,
	energy = 1,
}: {
	startSec: number;
	endSec: number;
	energy?: number;
}) => ({ startSec, endSec, energy });

describe("detectNoiseFragmentCuts", () => {
	test("flags a short LOUD word-less gap between two segments", () => {
		const features = [span({ startSec: 0, endSec: 1.0 }), span({ startSec: 1.5, endSec: 2.5 })]; // gap [1.0,1.5] = 0.5s
		const envelope = buildEnvelope({ totalSec: 2.5, loudSecRanges: [[1.0, 1.5]] });
		const ops = detectNoiseFragmentCuts({ features, envelope });
		expect(ops).toHaveLength(1);
		expect(ops[0].op).toBe("cut");
		expect(ops[0].category).toBe("noise");
		expect(ops[0].startSec).toBeCloseTo(1.0, 3);
		expect(ops[0].endSec).toBeCloseTo(1.5, 3);
	});

	test("does NOT flag a short but QUIET gap (silence, not noise)", () => {
		const features = [span({ startSec: 0, endSec: 1.0 }), span({ startSec: 1.5, endSec: 2.5 })];
		// gap windows stay at ~0.1 energy → below the 0.5×median(1.0) threshold
		const envelope = buildEnvelope({ totalSec: 2.5, loudSecRanges: [[1.0, 1.5]], loud: 0.1 });
		expect(detectNoiseFragmentCuts({ features, envelope })).toHaveLength(0);
	});

	test("does NOT flag a LONG loud gap (left to the LLM, not a fragment)", () => {
		const features = [span({ startSec: 0, endSec: 1.0 }), span({ startSec: 2.0, endSec: 3.0 })]; // gap = 1.0s > 0.5s max
		const envelope = buildEnvelope({ totalSec: 3.0, loudSecRanges: [[1.0, 2.0]] });
		expect(detectNoiseFragmentCuts({ features, envelope })).toHaveLength(0);
	});

	test("does NOT flag a sub-window gap (shorter than minFragmentSec)", () => {
		const features = [span({ startSec: 0, endSec: 1.0 }), span({ startSec: 1.03, endSec: 2.0 })]; // gap = 0.03s
		const envelope = buildEnvelope({ totalSec: 2.0, loudSecRanges: [[1.0, 1.03]] });
		expect(detectNoiseFragmentCuts({ features, envelope })).toHaveLength(0);
	});

	test("flags a loud lead-in fragment before the first word", () => {
		const features = [span({ startSec: 0.3, endSec: 1.3 })]; // lead-in gap [0,0.3]
		const envelope = buildEnvelope({ totalSec: 1.3, loudSecRanges: [[0, 0.3]] });
		const ops = detectNoiseFragmentCuts({ features, envelope });
		expect(ops).toHaveLength(1);
		expect(ops[0].startSec).toBeCloseTo(0, 3);
		expect(ops[0].endSec).toBeCloseTo(0.3, 3);
	});

	test("flags a loud tail fragment after the last word", () => {
		const features = [span({ startSec: 0, endSec: 1.0 })]; // tail gap [1.0, audioEnd=1.4]
		const envelope = buildEnvelope({ totalSec: 1.4, loudSecRanges: [[1.0, 1.4]] });
		const ops = detectNoiseFragmentCuts({ features, envelope });
		expect(ops).toHaveLength(1);
		expect(ops[0].startSec).toBeCloseTo(1.0, 3);
		expect(ops[0].endSec).toBeCloseTo(1.4, 3);
	});

	test("finds two separate noise fragments (lead-in + inter-segment)", () => {
		const features = [span({ startSec: 0.3, endSec: 1.0 }), span({ startSec: 1.5, endSec: 2.0 })];
		const envelope = buildEnvelope({
			totalSec: 2.0,
			loudSecRanges: [
				[0, 0.3],
				[1.0, 1.5],
			],
		});
		expect(detectNoiseFragmentCuts({ features, envelope })).toHaveLength(2);
	});

	test("no speech segments → no reference → no ops", () => {
		const envelope = buildEnvelope({ totalSec: 1.0, loudSecRanges: [[0, 1.0]] });
		expect(detectNoiseFragmentCuts({ features: [], envelope })).toHaveLength(0);
	});

	test("empty envelope → no ops", () => {
		expect(
			detectNoiseFragmentCuts({ features: [span({ startSec: 0, endSec: 1.0 })], envelope: [] }),
		).toHaveLength(0);
	});

	test("stable id is deterministic and prefixed", () => {
		const features = [span({ startSec: 0, endSec: 1.0 }), span({ startSec: 1.5, endSec: 2.5 })];
		const envelope = buildEnvelope({ totalSec: 2.5, loudSecRanges: [[1.0, 1.5]] });
		const a = detectNoiseFragmentCuts({ features, envelope });
		const b = detectNoiseFragmentCuts({ features, envelope });
		expect(a[0].id).toBe(b[0].id);
		expect(a[0].id.startsWith("noise-")).toBe(true);
	});
});
