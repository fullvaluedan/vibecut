import { describe, expect, test } from "bun:test";
import {
	clampFadesToDuration,
	computeFadeGain,
	resolveFadePair,
} from "@/timeline/audio-fade";

describe("computeFadeGain", () => {
	test("t=0 gain is 0 when fading in", () => {
		expect(
			computeFadeGain({
				localTimeSec: 0,
				durationSec: 10,
				fadeInSec: 2,
				fadeOutSec: 0,
			}),
		).toBeCloseTo(0, 5);
	});

	test("t=fadeIn gain is 1", () => {
		expect(
			computeFadeGain({
				localTimeSec: 2,
				durationSec: 10,
				fadeInSec: 2,
				fadeOutSec: 0,
			}),
		).toBeCloseTo(1, 5);
	});

	test("mid fade-in is a quarter-arc (sine), not linear", () => {
		const gain = computeFadeGain({
			localTimeSec: 1,
			durationSec: 10,
			fadeInSec: 2,
			fadeOutSec: 0,
		});
		// sin(0.5 * pi/2) ~= 0.7071, not the linear 0.5.
		expect(gain).toBeCloseTo(Math.SQRT1_2, 5);
		expect(gain).not.toBeCloseTo(0.5, 2);
	});

	test("fade-out tail is symmetric with fade-in", () => {
		const fadeInGain = computeFadeGain({
			localTimeSec: 1,
			durationSec: 10,
			fadeInSec: 2,
			fadeOutSec: 0,
		});
		const fadeOutGain = computeFadeGain({
			localTimeSec: 9, // 1s from the end, mirroring 1s into a 2s fade-in
			durationSec: 10,
			fadeInSec: 0,
			fadeOutSec: 2,
		});
		expect(fadeOutGain).toBeCloseTo(fadeInGain, 5);
	});

	test("t=duration gain is 0 when fading out", () => {
		expect(
			computeFadeGain({
				localTimeSec: 10,
				durationSec: 10,
				fadeInSec: 0,
				fadeOutSec: 3,
			}),
		).toBeCloseTo(0, 5);
	});

	test("gain is 1 outside both fade windows", () => {
		expect(
			computeFadeGain({
				localTimeSec: 5,
				durationSec: 10,
				fadeInSec: 1,
				fadeOutSec: 1,
			}),
		).toBeCloseTo(1, 5);
	});

	test("no fades set: gain is always 1", () => {
		expect(
			computeFadeGain({
				localTimeSec: 0,
				durationSec: 10,
				fadeInSec: 0,
				fadeOutSec: 0,
			}),
		).toBe(1);
		expect(
			computeFadeGain({
				localTimeSec: 10,
				durationSec: 10,
				fadeInSec: 0,
				fadeOutSec: 0,
			}),
		).toBe(1);
	});

	test("zero-duration clip: gain is 1 (no divide-by-zero)", () => {
		expect(
			computeFadeGain({
				localTimeSec: 0,
				durationSec: 0,
				fadeInSec: 2,
				fadeOutSec: 2,
			}),
		).toBe(1);
	});

	test("requested fades that would cross are clamped before computing gain", () => {
		// A 3s clip with a requested 5s fade-in leaves no room for a 5s fade-out;
		// fade-in wins (the default read-time priority), fade-out is squeezed to 0.
		const gainAtEnd = computeFadeGain({
			localTimeSec: 3,
			durationSec: 3,
			fadeInSec: 5,
			fadeOutSec: 5,
		});
		// If fade-out had any room, this would be < 1 near the end; instead the
		// clamp gives fade-in the whole clip and fade-out none of it, so gain at
		// the very end should equal the (still-ramping) fade-in curve, i.e. 1.
		expect(gainAtEnd).toBeCloseTo(1, 5);
	});
});

describe("resolveFadePair", () => {
	test("fadeIn priority clamps fadeOut when they would overlap", () => {
		const result = resolveFadePair({
			fadeInSec: 4,
			fadeOutSec: 4,
			durationSec: 5,
			priority: "fadeIn",
		});
		expect(result.fadeInSec).toBe(4);
		expect(result.fadeOutSec).toBe(1);
	});

	test("fadeOut priority clamps fadeIn when they would overlap", () => {
		const result = resolveFadePair({
			fadeInSec: 4,
			fadeOutSec: 4,
			durationSec: 5,
			priority: "fadeOut",
		});
		expect(result.fadeOutSec).toBe(4);
		expect(result.fadeInSec).toBe(1);
	});

	test("the two never cross: sum is always <= durationSec", () => {
		const result = resolveFadePair({
			fadeInSec: 100,
			fadeOutSec: 100,
			durationSec: 7,
			priority: "fadeIn",
		});
		expect(result.fadeInSec + result.fadeOutSec).toBeLessThanOrEqual(7);
	});

	test("negative and non-finite input is treated as 0", () => {
		const result = resolveFadePair({
			fadeInSec: -5,
			fadeOutSec: Number.NaN,
			durationSec: 10,
			priority: "fadeIn",
		});
		expect(result.fadeInSec).toBe(0);
		expect(result.fadeOutSec).toBe(0);
	});

	test("fits within duration when there is room: both pass through unchanged", () => {
		const result = resolveFadePair({
			fadeInSec: 1,
			fadeOutSec: 1,
			durationSec: 10,
			priority: "fadeIn",
		});
		expect(result).toEqual({ fadeInSec: 1, fadeOutSec: 1 });
	});
});

describe("clampFadesToDuration (trim interaction)", () => {
	test("trimming a clip shorter than its stored fades clamps them to fit", () => {
		// Stored fades assume a 10s clip; the clip is then trimmed to 3s.
		const result = clampFadesToDuration({
			fadeInSec: 4,
			fadeOutSec: 4,
			durationSec: 3,
		});
		expect(result.fadeInSec + result.fadeOutSec).toBeLessThanOrEqual(3);
		expect(result.fadeInSec).toBe(3);
		expect(result.fadeOutSec).toBe(0);
	});

	test("trimming leaves fades untouched when they still fit", () => {
		const result = clampFadesToDuration({
			fadeInSec: 1,
			fadeOutSec: 1,
			durationSec: 3,
		});
		expect(result).toEqual({ fadeInSec: 1, fadeOutSec: 1 });
	});

	test("re-extending the clip is not modeled here (pure function): a fresh call with the larger duration returns the original fades", () => {
		const shrunk = clampFadesToDuration({
			fadeInSec: 4,
			fadeOutSec: 4,
			durationSec: 3,
		});
		expect(shrunk.fadeOutSec).toBe(0);

		const restored = clampFadesToDuration({
			fadeInSec: 4,
			fadeOutSec: 4,
			durationSec: 10,
		});
		expect(restored).toEqual({ fadeInSec: 4, fadeOutSec: 4 });
	});
});
