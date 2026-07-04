import { describe, expect, it } from "bun:test";
import { finiteDurationOrUndefined } from "@/media/duration";

/**
 * `getMediaDuration` resolves `HTMLMediaElement.duration` through this guard (U8)
 * so a streaming/malformed audio file (Infinity/NaN/0) falls back to
 * DEFAULT_NEW_ELEMENT_DURATION instead of pasting a zero-length element or
 * throwing in mediaTimeFromSeconds. The DOM read is browser-only; the guard is
 * the pure, testable piece.
 */
describe("finiteDurationOrUndefined", () => {
	it("returns undefined for Infinity (live/streaming source)", () => {
		expect(finiteDurationOrUndefined(Infinity)).toBeUndefined();
	});

	it("returns undefined for NaN (metadata not yet loaded)", () => {
		expect(finiteDurationOrUndefined(NaN)).toBeUndefined();
	});

	it("returns undefined for 0 (malformed / empty media)", () => {
		expect(finiteDurationOrUndefined(0)).toBeUndefined();
	});

	it("returns undefined for a negative duration", () => {
		expect(finiteDurationOrUndefined(-5)).toBeUndefined();
	});

	it("returns a finite positive duration unchanged", () => {
		expect(finiteDurationOrUndefined(12.5)).toBe(12.5);
	});
});
