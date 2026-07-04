import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as mediabunny from "mediabunny";
import { VideoCache } from "../service";

// A file that is not a decodable video makes `initializeSink` throw (mediabunny
// reports "unsupported or unrecognizable format") — the same failure path as a
// real undecodable codec (e.g. HEVC the browser can't decode).
function makeUndecodableFile(): File {
	return new File([new Uint8Array([1, 2, 3, 4])], "junk.mp4", {
		type: "video/mp4",
	});
}

describe("VideoCache negative cache", () => {
	afterEach(() => {
		mock.restore();
	});

	test("getFrameAt returns null for an undecodable file", async () => {
		const cache = new VideoCache();
		const frame = await cache.getFrameAt({
			mediaId: "m1",
			file: makeUndecodableFile(),
			time: 0,
		});
		expect(frame).toBeNull();
	});

	test("a second getFrameAt for a known-undecodable mediaId does not re-probe", async () => {
		const cache = new VideoCache();
		const file = makeUndecodableFile();

		// Spy on the mediabunny Input constructor: it is created once per
		// initializeSink attempt. The negative cache must prevent a second attempt.
		const inputSpy = spyOn(mediabunny, "Input");

		await cache.getFrameAt({ mediaId: "m1", file, time: 0 });
		const callsAfterFirst = inputSpy.mock.calls.length;
		expect(callsAfterFirst).toBeGreaterThan(0);

		const frame = await cache.getFrameAt({ mediaId: "m1", file, time: 1 });
		expect(frame).toBeNull();
		// No new Input was constructed — the negative cache short-circuited.
		expect(inputSpy.mock.calls.length).toBe(callsAfterFirst);
	});

	test("clearVideo clears the negative cache so the media can be retried", async () => {
		const cache = new VideoCache();
		const file = makeUndecodableFile();
		const inputSpy = spyOn(mediabunny, "Input");

		await cache.getFrameAt({ mediaId: "m1", file, time: 0 });
		const callsAfterFirst = inputSpy.mock.calls.length;

		cache.clearVideo({ mediaId: "m1" });

		// After clearing, a fresh attempt is allowed (Input is constructed again).
		await cache.getFrameAt({ mediaId: "m1", file, time: 0 });
		expect(inputSpy.mock.calls.length).toBeGreaterThan(callsAfterFirst);
	});
});
