import { describe, expect, test } from "bun:test";
import {
	DEFAULT_RETIME_RATE,
	clampRetimeForReverse,
	isRetimeReversed,
} from "@/retime/rate";

describe("isRetimeReversed", () => {
	test("true only when reversed is exactly true", () => {
		expect(isRetimeReversed({ retime: { reversed: true } })).toBe(true);
		expect(isRetimeReversed({ retime: { reversed: false } })).toBe(false);
		expect(isRetimeReversed({ retime: {} })).toBe(false);
		expect(isRetimeReversed({})).toBe(false);
		expect(isRetimeReversed({ retime: undefined })).toBe(false);
	});
});

describe("clampRetimeForReverse", () => {
	test("pins rate to 1x while reversed", () => {
		expect(clampRetimeForReverse({ rate: 2, reversed: true })).toBe(
			DEFAULT_RETIME_RATE,
		);
		expect(clampRetimeForReverse({ rate: 0.25, reversed: true })).toBe(
			DEFAULT_RETIME_RATE,
		);
	});

	test("leaves rate untouched when not reversed", () => {
		expect(clampRetimeForReverse({ rate: 2, reversed: false })).toBe(2);
		expect(clampRetimeForReverse({ rate: 0.25, reversed: false })).toBe(0.25);
	});
});
