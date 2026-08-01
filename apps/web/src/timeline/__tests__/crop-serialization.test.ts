import { describe, expect, test } from "bun:test";
import type { VideoElement } from "@/timeline";
import { isNoOpCrop } from "@/rendering/crop";
import { ZERO_MEDIA_TIME, mediaTime } from "@/wasm";

function buildLegacyVideoElementJson(): string {
	// Simulates a project saved BEFORE T18.1: no `crop` key at all on the
	// serialized element (JSON.stringify never emitted `undefined` values
	// either, so this is exactly what an old project file looks like on
	// disk/IndexedDB).
	const element: Omit<VideoElement, "crop"> = {
		id: "el-1",
		type: "video",
		name: "Clip",
		mediaId: "media-1",
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: 1000 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {
			"transform.positionX": 0,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			"transform.rotate": 0,
			opacity: 1,
		},
	};
	return JSON.stringify(element);
}

describe("crop serialization backward compatibility", () => {
	test("an old project's video element (no crop field) loads with crop undefined", () => {
		const parsed = JSON.parse(buildLegacyVideoElementJson()) as VideoElement;
		expect(parsed.crop).toBeUndefined();
		expect(isNoOpCrop(parsed.crop)).toBe(true);
		expect(Object.hasOwn(parsed, "crop")).toBe(false);
	});

	test("a crop rect round-trips through JSON exactly", () => {
		const element: VideoElement = {
			id: "el-2",
			type: "video",
			name: "Clip",
			mediaId: "media-1",
			startTime: mediaTime({ ticks: 0 }),
			duration: mediaTime({ ticks: 1000 }),
			trimStart: ZERO_MEDIA_TIME,
			trimEnd: ZERO_MEDIA_TIME,
			crop: { left: 0.1, top: 0.05, right: 0.1, bottom: 0.05 },
			params: {
				"transform.positionX": 0,
				"transform.positionY": 0,
				"transform.scaleX": 1,
				"transform.scaleY": 1,
				"transform.rotate": 0,
				opacity: 1,
			},
		};
		const roundTripped = JSON.parse(JSON.stringify(element)) as VideoElement;
		expect(roundTripped.crop).toEqual(element.crop);
	});
});
