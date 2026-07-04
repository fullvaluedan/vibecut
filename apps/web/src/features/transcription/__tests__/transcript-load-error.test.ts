import { describe, expect, test } from "bun:test";
import {
	classifyTranscriptLoadError,
	isNoAudioError,
} from "../transcript-load-error";

describe("classifyTranscriptLoadError", () => {
	test("ignores a cancel we initiated (our own unmount/supersede abort)", () => {
		expect(
			classifyTranscriptLoadError({ message: "Cancelled", ownAbort: true }),
		).toBe("ignore");
	});

	test("a cancel we did NOT initiate surfaces as an error, not a stuck spinner", () => {
		// The joined-run-cancelled-by-someone-else case: previously swallowed and
		// left the panel spinning forever.
		expect(
			classifyTranscriptLoadError({ message: "Cancelled", ownAbort: false }),
		).toBe("error");
	});

	test("a no-audio timeline is an empty state", () => {
		expect(
			classifyTranscriptLoadError({
				message: "Add some footage to the timeline first.",
				ownAbort: false,
			}),
		).toBe("empty");
	});

	test("a real failure is an error", () => {
		expect(
			classifyTranscriptLoadError({
				message: "Cloud transcription failed (500).",
				ownAbort: false,
			}),
		).toBe("error");
	});

	test("isNoAudioError matches the footage/no-speech throws", () => {
		expect(isNoAudioError("Add some footage to the timeline first.")).toBe(true);
		expect(isNoAudioError("no speech detected")).toBe(true);
		expect(isNoAudioError("Cloud transcription failed (500).")).toBe(false);
	});
});
