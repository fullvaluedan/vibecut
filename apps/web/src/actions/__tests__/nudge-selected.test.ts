import { describe, expect, it } from "bun:test";
import { frameOffsetTicks } from "@/timeline/frame-offset";

/**
 * The keyboard-nudge action (Alt+←/→, U6) shifts the selection by one frame via
 * the same group-move pipeline as a mouse drag (collision/track rules match) —
 * that wiring is live-verified (docs/TO-VERIFY.md). The PURE piece is the
 * fps→ticks delta math below, which is unit-testable without the wasm runtime.
 *
 * 90_000 ticks/second is the wasm `TICKS_PER_SECOND` at time of writing; the
 * test passes it in explicitly so it never depends on the runtime constant.
 */
const TICKS_PER_SECOND = 90_000;

describe("frameOffsetTicks", () => {
	it("is one frame of ticks forward at 30fps (default frames=1, direction=1)", () => {
		expect(
			frameOffsetTicks({
				ticksPerSecond: TICKS_PER_SECOND,
				fpsNumerator: 30,
				fpsDenominator: 1,
			}),
		).toBe(3_000);
	});

	it("negates for a backward nudge", () => {
		expect(
			frameOffsetTicks({
				ticksPerSecond: TICKS_PER_SECOND,
				fpsNumerator: 30,
				fpsDenominator: 1,
				direction: -1,
			}),
		).toBe(-3_000);
	});

	it("scales by the frame count", () => {
		expect(
			frameOffsetTicks({
				ticksPerSecond: TICKS_PER_SECOND,
				fpsNumerator: 30,
				fpsDenominator: 1,
				frames: 5,
			}),
		).toBe(15_000);
	});

	it("rounds to the nearest integer tick for fractional fps (29.97 = 30000/1001)", () => {
		// 90000 * 1001 / 30000 = 3003 exactly
		expect(
			frameOffsetTicks({
				ticksPerSecond: TICKS_PER_SECOND,
				fpsNumerator: 30_000,
				fpsDenominator: 1_001,
			}),
		).toBe(3_003);
	});

	it("returns an integer tick count (never a fraction) so MediaTime stays on its lattice", () => {
		const ticks = frameOffsetTicks({
			ticksPerSecond: TICKS_PER_SECOND,
			fpsNumerator: 24_000,
			fpsDenominator: 1_001,
		});
		expect(Number.isInteger(ticks)).toBe(true);
	});
});
