import { describe, expect, test } from "bun:test";
import { pauseThenSeek } from "@/timeline/controllers/playhead-controller";
import { mediaTime } from "@/wasm";

describe("pauseThenSeek", () => {
	test("pauses before seeking when playback is playing", () => {
		const calls: string[] = [];
		const pause = () => calls.push("pause");
		const seek = () => calls.push("seek");
		const time = mediaTime({ ticks: 1000 });

		pauseThenSeek({ isPlaying: true, pause, seek, time });

		expect(calls).toEqual(["pause", "seek"]);
	});

	test("only seeks, does not pause, when already paused", () => {
		const calls: string[] = [];
		const pause = () => calls.push("pause");
		const seek = () => calls.push("seek");
		const time = mediaTime({ ticks: 500 });

		pauseThenSeek({ isPlaying: false, pause, seek, time });

		expect(calls).toEqual(["seek"]);
	});

	test("always seeks to the given time", () => {
		let seekedTo: ReturnType<typeof mediaTime> | null = null;
		const time = mediaTime({ ticks: 4200 });

		pauseThenSeek({
			isPlaying: true,
			pause: () => {},
			seek: (t) => {
				seekedTo = t;
			},
			time,
		});

		expect(seekedTo).toBe(time);
	});
});
