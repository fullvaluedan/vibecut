import { describe, expect, test } from "bun:test";
import { computeRollTarget } from "../roll";

// Two adjacent 1-second clips at 120_000 ticks/second, full source windows
// (rate 1, no trim). A is [0, 100k], B is [100k, 100k]. minDuration is a single
// frame at 30fps == 4_000 ticks. The numbers below use 100_000-tick clips so
// the source/timeline arithmetic stays easy to follow.
const base = {
	clipAStartTimeTicks: 0,
	clipADurationTicks: 100_000,
	clipATrimStartTicks: 0,
	clipATrimEndTicks: 0,
	clipASourceDurationTicks: 100_000,
	clipARate: 1,
	clipBStartTimeTicks: 100_000,
	clipBDurationTicks: 100_000,
	clipBTrimStartTicks: 0,
	clipBTrimEndTicks: 0,
	clipBSourceDurationTicks: 100_000,
	clipBRate: 1,
	deltaTicks: 0,
	minDurationTicks: 4_000,
};

describe("computeRollTarget", () => {
	test("positive roll: A grows from tail, B shrinks from head (with source available)", () => {
		// Give A spare source on the right (trimEnd 30k) and B spare source on the
		// left (trimStart 30k) so a +25k roll is not source-blocked.
		const result = computeRollTarget({
			...base,
			clipATrimEndTicks: 30_000,
			clipASourceDurationTicks: 130_000,
			clipBTrimStartTicks: 30_000,
			clipBSourceDurationTicks: 130_000,
			deltaTicks: 25_000,
		});
		expect(result).toEqual({
			clipAStartTimeTicks: 0,
			clipADurationTicks: 125_000,
			clipATrimStartTicks: 0,
			clipATrimEndTicks: 5_000,
			clipBStartTimeTicks: 125_000,
			clipBDurationTicks: 75_000,
			clipBTrimStartTicks: 55_000,
			clipBTrimEndTicks: 0,
		});
	});

	test("negative roll: A shrinks, B grows and pulls its head left", () => {
		// A needs trimStart room is irrelevant; B needs trimStart room to pull left.
		const result = computeRollTarget({
			...base,
			clipBTrimStartTicks: 30_000,
			clipBSourceDurationTicks: 130_000,
			deltaTicks: -25_000,
		});
		// A shrinks by 25k and hands that source back to its tail: trimEnd 0 -> 25k.
		expect(result).toEqual({
			clipAStartTimeTicks: 0,
			clipADurationTicks: 75_000,
			clipATrimStartTicks: 0,
			clipATrimEndTicks: 25_000,
			clipBStartTimeTicks: 75_000,
			clipBDurationTicks: 125_000,
			clipBTrimStartTicks: 5_000,
			clipBTrimEndTicks: 0,
		});
	});

	test("the pair's combined span and outer boundaries stay fixed", () => {
		const result = computeRollTarget({
			...base,
			clipATrimEndTicks: 30_000,
			clipASourceDurationTicks: 130_000,
			clipBTrimStartTicks: 30_000,
			clipBSourceDurationTicks: 130_000,
			deltaTicks: 25_000,
		});
		// A's start is pinned, B's end is pinned, the cut moved but nothing else.
		expect(result?.clipAStartTimeTicks).toBe(0);
		const bEnd = result!.clipBStartTimeTicks + result!.clipBDurationTicks;
		expect(bEnd).toBe(200_000);
		// Combined on-timeline span unchanged.
		expect(result!.clipADurationTicks + result!.clipBDurationTicks).toBe(
			200_000,
		);
		// The cut is shared: A's end == B's start.
		expect(result!.clipAStartTimeTicks + result!.clipADurationTicks).toBe(
			result!.clipBStartTimeTicks,
		);
	});

	test("clamp: A reaches minimum duration on a negative roll", () => {
		// A is only 10k; -8k would leave 2k (< 4k min). Clamp to -(10k-4k) = -6k.
		const result = computeRollTarget({
			...base,
			clipADurationTicks: 10_000,
			clipASourceDurationTicks: 10_000,
			clipBStartTimeTicks: 10_000,
			clipBTrimStartTicks: 100_000,
			clipBSourceDurationTicks: 200_000,
			deltaTicks: -8_000,
		});
		expect(result?.clipADurationTicks).toBe(4_000);
		expect(result?.clipBStartTimeTicks).toBe(4_000);
		expect(result?.clipBDurationTicks).toBe(106_000);
		expect(result?.clipBTrimStartTicks).toBe(94_000);
	});

	test("clamp: B reaches minimum duration on a positive roll", () => {
		// B is only 10k; +8k would leave 2k (< 4k min). Clamp to +(10k-4k) = 6k.
		const result = computeRollTarget({
			...base,
			clipATrimEndTicks: 100_000,
			clipASourceDurationTicks: 200_000,
			clipBDurationTicks: 10_000,
			clipBSourceDurationTicks: 100_000,
			deltaTicks: 8_000,
		});
		expect(result?.clipADurationTicks).toBe(106_000);
		expect(result?.clipBStartTimeTicks).toBe(106_000);
		expect(result?.clipBDurationTicks).toBe(4_000);
		expect(result?.clipATrimEndTicks).toBe(94_000);
	});

	test("clamp: A's source exhausted (trimEnd) on a positive roll", () => {
		// A has only 30k trimEnd; +40k clamps to +30k, leaving trimEnd 0.
		const result = computeRollTarget({
			...base,
			clipATrimEndTicks: 30_000,
			clipASourceDurationTicks: 130_000,
			deltaTicks: 40_000,
		});
		expect(result?.clipADurationTicks).toBe(130_000);
		expect(result?.clipATrimEndTicks).toBe(0);
		expect(result?.clipBStartTimeTicks).toBe(130_000);
		expect(result?.clipBDurationTicks).toBe(70_000);
		expect(result?.clipBTrimStartTicks).toBe(30_000);
	});

	test("clamp: B's source exhausted (trimStart) on a negative roll", () => {
		// B has only 20k trimStart; -30k clamps to -20k, leaving trimStart 0.
		const result = computeRollTarget({
			...base,
			clipBTrimStartTicks: 20_000,
			clipBSourceDurationTicks: 120_000,
			deltaTicks: -30_000,
		});
		expect(result?.clipADurationTicks).toBe(80_000);
		expect(result?.clipBStartTimeTicks).toBe(80_000);
		expect(result?.clipBDurationTicks).toBe(120_000);
		expect(result?.clipBTrimStartTicks).toBe(0);
	});

	test("retime: clip A rate=2 with no trimEnd blocks a positive roll", () => {
		// A consumes source at 2x; trimEnd 0 means max delta = 0/2 = 0. Unchanged.
		const result = computeRollTarget({
			...base,
			clipARate: 2,
			clipASourceDurationTicks: 100_000,
			deltaTicks: 50_000,
		});
		expect(result).toEqual({
			clipAStartTimeTicks: 0,
			clipADurationTicks: 100_000,
			clipATrimStartTicks: 0,
			clipATrimEndTicks: 0,
			clipBStartTimeTicks: 100_000,
			clipBDurationTicks: 100_000,
			clipBTrimStartTicks: 0,
			clipBTrimEndTicks: 0,
		});
	});

	test("retime: clip A rate=2 consumes source at 2x on an allowed positive roll", () => {
		// A has 100k trimEnd at rate 2 → max delta = 100k/2 = 50k. +20k is fine.
		// sourceDeltaA = 20k * 2 = 40k consumed from trimEnd.
		const result = computeRollTarget({
			...base,
			clipARate: 2,
			clipATrimEndTicks: 100_000,
			clipASourceDurationTicks: 300_000,
			clipBTrimStartTicks: 100_000,
			clipBSourceDurationTicks: 200_000,
			deltaTicks: 20_000,
		});
		expect(result?.clipADurationTicks).toBe(120_000);
		expect(result?.clipATrimEndTicks).toBe(60_000); // 100k - 40k
		expect(result?.clipBStartTimeTicks).toBe(120_000);
		expect(result?.clipBDurationTicks).toBe(80_000);
		// B at rate 1: sourceDeltaB = 20k, trimStart 100k -> 120k.
		expect(result?.clipBTrimStartTicks).toBe(120_000);
	});

	test("retime: clip B rate=0.5 consumes source at 0.5x on a negative roll", () => {
		// B at rate 0.5: max leftward = trimStart / 0.5 = 50k/0.5 = 100k of timeline.
		// -25k roll: sourceDeltaB = 25k * 0.5 = 12.5k, trimStart 50k -> 37.5k.
		const result = computeRollTarget({
			...base,
			clipBRate: 0.5,
			clipBTrimStartTicks: 50_000,
			clipBSourceDurationTicks: 200_000,
			deltaTicks: -25_000,
		});
		expect(result?.clipADurationTicks).toBe(75_000);
		expect(result?.clipBStartTimeTicks).toBe(75_000);
		expect(result?.clipBDurationTicks).toBe(125_000);
		expect(result?.clipBTrimStartTicks).toBe(37_500); // 50k - 12.5k
	});

	test("retime: clip B rate=0.5 but A has no trimEnd blocks a positive roll", () => {
		// A at rate 1 with trimEnd 0 → max delta = 0, even though B has room.
		const result = computeRollTarget({
			...base,
			clipBRate: 0.5,
			clipBTrimStartTicks: 50_000,
			clipBSourceDurationTicks: 200_000,
			deltaTicks: 25_000,
		});
		expect(result?.clipADurationTicks).toBe(100_000);
		expect(result?.clipBStartTimeTicks).toBe(100_000);
		expect(result?.clipBDurationTicks).toBe(100_000);
	});

	test("retime: both clips rate!=1 with no spare source block the roll", () => {
		const result = computeRollTarget({
			...base,
			clipARate: 2,
			clipASourceDurationTicks: 200_000,
			clipBRate: 0.5,
			clipBSourceDurationTicks: 50_000,
			deltaTicks: 20_000,
		});
		expect(result?.clipADurationTicks).toBe(100_000);
		expect(result?.clipBDurationTicks).toBe(100_000);
		expect(result?.clipBStartTimeTicks).toBe(100_000);
	});

	test("not adjacent: gap between clips returns null", () => {
		const result = computeRollTarget({
			...base,
			clipBStartTimeTicks: 150_000,
			deltaTicks: 25_000,
		});
		expect(result).toBeNull();
	});

	test("not adjacent: overlapping clips return null", () => {
		const result = computeRollTarget({
			...base,
			clipADurationTicks: 150_000,
			clipASourceDurationTicks: 150_000,
			deltaTicks: 25_000,
		});
		expect(result).toBeNull();
	});

	test("zero delta is a no-op and returns the unchanged clips", () => {
		const result = computeRollTarget({ ...base, deltaTicks: 0 });
		expect(result).toEqual({
			clipAStartTimeTicks: 0,
			clipADurationTicks: 100_000,
			clipATrimStartTicks: 0,
			clipATrimEndTicks: 0,
			clipBStartTimeTicks: 100_000,
			clipBDurationTicks: 100_000,
			clipBTrimStartTicks: 0,
			clipBTrimEndTicks: 0,
		});
	});

	test("both clips at minimum duration: no roll possible, returns unchanged", () => {
		const result = computeRollTarget({
			...base,
			clipADurationTicks: 4_000,
			clipASourceDurationTicks: 4_000,
			clipBStartTimeTicks: 4_000,
			clipBDurationTicks: 4_000,
			clipBSourceDurationTicks: 4_000,
			deltaTicks: 1_000,
		});
		// minDelta = max(4k-4k, 0) = 0, maxDelta = min(0, 4k-4k) = 0 -> clamp to 0.
		expect(result?.clipADurationTicks).toBe(4_000);
		expect(result?.clipBDurationTicks).toBe(4_000);
		expect(result?.clipBStartTimeTicks).toBe(4_000);
	});

	test("both sources exhausted but durations roomy: roll applies normally", () => {
		// A trimEnd 100k (max +100k), B trimStart 100k (max -100k); +50k is valid.
		const result = computeRollTarget({
			...base,
			clipATrimEndTicks: 100_000,
			clipASourceDurationTicks: 200_000,
			clipBTrimStartTicks: 100_000,
			clipBSourceDurationTicks: 200_000,
			deltaTicks: 50_000,
		});
		expect(result?.clipADurationTicks).toBe(150_000);
		expect(result?.clipATrimEndTicks).toBe(50_000);
		expect(result?.clipBStartTimeTicks).toBe(150_000);
		expect(result?.clipBDurationTicks).toBe(50_000);
		expect(result?.clipBTrimStartTicks).toBe(150_000);
	});

	test("degenerate: clip with zero visible source still rolls to consume the rest", () => {
		// A visible span = 100k - 50k - 50k = 0; trimEnd 50k allows +50k roll.
		const result = computeRollTarget({
			...base,
			clipATrimStartTicks: 50_000,
			clipATrimEndTicks: 50_000,
			clipASourceDurationTicks: 100_000,
			clipBTrimStartTicks: 50_000,
			clipBSourceDurationTicks: 150_000,
			deltaTicks: 50_000,
		});
		expect(result?.clipADurationTicks).toBe(150_000);
		expect(result?.clipATrimStartTicks).toBe(50_000);
		expect(result?.clipATrimEndTicks).toBe(0);
		expect(result?.clipBStartTimeTicks).toBe(150_000);
		expect(result?.clipBDurationTicks).toBe(50_000);
		expect(result?.clipBTrimStartTicks).toBe(100_000);
	});

	test("clip B sourced from the middle of the file (non-zero trimStart and trimEnd)", () => {
		// B: trimStart 20k, trimEnd 30k. +15k roll: A trimEnd 100k allows it,
		// B trimStart 20k -> 35k; trimEnd untouched.
		const result = computeRollTarget({
			...base,
			clipATrimEndTicks: 100_000,
			clipASourceDurationTicks: 200_000,
			clipBTrimStartTicks: 20_000,
			clipBTrimEndTicks: 30_000,
			clipBSourceDurationTicks: 150_000,
			deltaTicks: 15_000,
		});
		expect(result?.clipADurationTicks).toBe(115_000);
		expect(result?.clipATrimEndTicks).toBe(85_000);
		expect(result?.clipBStartTimeTicks).toBe(115_000);
		expect(result?.clipBDurationTicks).toBe(85_000);
		expect(result?.clipBTrimStartTicks).toBe(35_000);
		expect(result?.clipBTrimEndTicks).toBe(30_000);
	});

	test("cascade clamp: A's source bound is tighter than A's min-duration floor (blocked)", () => {
		// A floor: delta >= 4k - 50k = -46k. A source: delta <= 10k. B duration:
		// delta <= 60k-4k = 56k. B source: delta >= 0. So minDelta=0, maxDelta=10k.
		// But the prompt's row makes both bounds contradictory by removing B's
		// trimStart room (delta>=0) while requesting +20k -> clamps to 10k here,
		// where A's source (10k) is the binding ceiling.
		const result = computeRollTarget({
			...base,
			clipADurationTicks: 50_000,
			clipATrimEndTicks: 10_000,
			clipASourceDurationTicks: 60_000,
			clipBStartTimeTicks: 50_000,
			clipBDurationTicks: 60_000,
			clipBTrimStartTicks: 5_000,
			clipBSourceDurationTicks: 65_000,
			deltaTicks: 20_000,
		});
		// maxDelta = min(A source 10k, B dur 56k) = 10k. clamp +20k -> +10k.
		expect(result?.clipADurationTicks).toBe(60_000);
		expect(result?.clipATrimEndTicks).toBe(0);
		expect(result?.clipBStartTimeTicks).toBe(60_000);
		expect(result?.clipBDurationTicks).toBe(50_000);
		expect(result?.clipBTrimStartTicks).toBe(15_000);
	});

	test("cascade clamp: B's source bound wins on a negative roll", () => {
		// A floor: delta >= 4k - 60k = -56k. B source: delta >= -10k. So minDelta
		// = max(-56k, -10k) = -10k. Requesting -20k clamps to -10k.
		const result = computeRollTarget({
			...base,
			clipADurationTicks: 60_000,
			clipASourceDurationTicks: 60_000,
			clipBStartTimeTicks: 60_000,
			clipBDurationTicks: 50_000,
			clipBTrimStartTicks: 10_000,
			clipBSourceDurationTicks: 60_000,
			deltaTicks: -20_000,
		});
		expect(result?.clipADurationTicks).toBe(50_000);
		expect(result?.clipBStartTimeTicks).toBe(50_000);
		expect(result?.clipBDurationTicks).toBe(60_000);
		expect(result?.clipBTrimStartTicks).toBe(0);
	});

	test("invariant: trimStart + visibleSpan + trimEnd == sourceDuration holds after a roll", () => {
		const result = computeRollTarget({
			...base,
			clipATrimEndTicks: 30_000,
			clipASourceDurationTicks: 130_000,
			clipBTrimStartTicks: 30_000,
			clipBSourceDurationTicks: 130_000,
			deltaTicks: 25_000,
		})!;
		// Clip A (rate 1): visible source span == duration.
		const aVisible = result.clipADurationTicks * 1;
		expect(
			result.clipATrimStartTicks + aVisible + result.clipATrimEndTicks,
		).toBe(130_000);
		// Clip B (rate 1): visible source span == duration.
		const bVisible = result.clipBDurationTicks * 1;
		expect(
			result.clipBTrimStartTicks + bVisible + result.clipBTrimEndTicks,
		).toBe(130_000);
	});

	test("rate defaults to 1 when omitted", () => {
		const result = computeRollTarget({
			clipAStartTimeTicks: 0,
			clipADurationTicks: 100_000,
			clipATrimStartTicks: 0,
			clipATrimEndTicks: 40_000,
			clipASourceDurationTicks: 140_000,
			clipBStartTimeTicks: 100_000,
			clipBDurationTicks: 100_000,
			clipBTrimStartTicks: 0,
			clipBTrimEndTicks: 0,
			clipBSourceDurationTicks: 100_000,
			deltaTicks: 20_000,
			minDurationTicks: 4_000,
		});
		// rate 1 both sides: +20k consumes 20k of A's trimEnd.
		expect(result?.clipADurationTicks).toBe(120_000);
		expect(result?.clipATrimEndTicks).toBe(20_000);
		expect(result?.clipBStartTimeTicks).toBe(120_000);
	});
});
