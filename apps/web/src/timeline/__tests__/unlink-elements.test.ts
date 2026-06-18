import { describe, expect, test } from "bun:test";
import type { MediaTime } from "@/wasm";
import type { AudioElement, SceneTracks, VideoElement } from "@/timeline";
import { unlinkElementsInSceneTracks } from "@/timeline/unlink-elements";

// Build a MediaTime without importing the wasm-backed `@/wasm` runtime (it can't
// load under bun). The transform never reads time fields, so any integer tick
// works; a type guard narrows `number` to `MediaTime` with no unsafe assertion
// (mirrors `requireMediaTime` in wasm/media-time.ts).
function isTick(value: number): value is MediaTime {
	return Number.isInteger(value);
}
function tick(value: number): MediaTime {
	if (!isTick(value)) {
		throw new Error(`expected integer ticks, got ${value}`);
	}
	return value;
}
const T0 = tick(0);

function video({ id, linkId }: { id: string; linkId?: string }): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		startTime: T0,
		duration: T0,
		trimStart: T0,
		trimEnd: T0,
		mediaId: "media",
		params: {},
		...(linkId ? { linkId } : {}),
	};
}

function audio({ id, linkId }: { id: string; linkId?: string }): AudioElement {
	return {
		id,
		type: "audio",
		name: id,
		startTime: T0,
		duration: T0,
		trimStart: T0,
		trimEnd: T0,
		sourceType: "upload",
		mediaId: "media",
		params: {},
		...(linkId ? { linkId } : {}),
	};
}

function tracksOf({
	main = [],
	audio: audioEls = [],
	overlay = [],
}: {
	main?: VideoElement[];
	audio?: AudioElement[];
	overlay?: VideoElement[];
}): SceneTracks {
	return {
		overlay: overlay.length
			? [
					{
						id: "overlay-1",
						type: "video",
						name: "Overlay",
						muted: false,
						hidden: false,
						elements: overlay,
					},
				]
			: [],
		main: {
			id: "main",
			type: "video",
			name: "Main",
			muted: false,
			hidden: false,
			elements: main,
		},
		audio: audioEls.length
			? [
					{
						id: "audio-1",
						type: "audio",
						name: "Audio",
						muted: false,
						elements: audioEls,
					},
				]
			: [],
	};
}

function linkIdOf({
	tracks,
	id,
}: {
	tracks: SceneTracks;
	id: string;
}): string | undefined {
	for (const track of [...tracks.overlay, tracks.main, ...tracks.audio]) {
		const found = track.elements.find((el) => el.id === id);
		if (found) return found.linkId;
	}
	return undefined;
}

describe("unlinkElementsInSceneTracks", () => {
	test("clears linkId on both halves of a linked A/V pair", () => {
		const tracks = tracksOf({
			main: [video({ id: "v1", linkId: "L1" })],
			audio: [audio({ id: "a1", linkId: "L1" })],
		});

		const result = unlinkElementsInSceneTracks({
			tracks,
			refs: [{ trackId: "main", elementId: "v1" }],
		});

		expect(linkIdOf({ tracks: result.tracks, id: "v1" })).toBeUndefined();
		expect(linkIdOf({ tracks: result.tracks, id: "a1" })).toBeUndefined();
		expect(result.cleared).toHaveLength(2);
	});

	test("dissolves a 3+ member link group from any single member", () => {
		const tracks = tracksOf({
			main: [video({ id: "v1", linkId: "L1" })],
			audio: [audio({ id: "a1", linkId: "L1" })],
			overlay: [video({ id: "v2", linkId: "L1" })],
		});

		// Reference only the overlay member; the whole group must dissolve.
		const result = unlinkElementsInSceneTracks({
			tracks,
			refs: [{ trackId: "overlay-1", elementId: "v2" }],
		});

		expect(linkIdOf({ tracks: result.tracks, id: "v1" })).toBeUndefined();
		expect(linkIdOf({ tracks: result.tracks, id: "a1" })).toBeUndefined();
		expect(linkIdOf({ tracks: result.tracks, id: "v2" })).toBeUndefined();
		expect(result.cleared).toHaveLength(3);
	});

	test("leaves unrelated link groups untouched", () => {
		const tracks = tracksOf({
			main: [video({ id: "v1", linkId: "L1" }), video({ id: "v2", linkId: "L2" })],
			audio: [audio({ id: "a1", linkId: "L1" }), audio({ id: "a2", linkId: "L2" })],
		});

		const result = unlinkElementsInSceneTracks({
			tracks,
			refs: [{ trackId: "main", elementId: "v1" }],
		});

		expect(linkIdOf({ tracks: result.tracks, id: "v1" })).toBeUndefined();
		expect(linkIdOf({ tracks: result.tracks, id: "a1" })).toBeUndefined();
		expect(linkIdOf({ tracks: result.tracks, id: "v2" })).toBe("L2");
		expect(linkIdOf({ tracks: result.tracks, id: "a2" })).toBe("L2");
		expect(result.cleared).toHaveLength(2);
	});

	test("is a no-op (same tracks object) when the ref has no linkId", () => {
		const tracks = tracksOf({ main: [video({ id: "v1" })] });

		const result = unlinkElementsInSceneTracks({
			tracks,
			refs: [{ trackId: "main", elementId: "v1" }],
		});

		expect(result.cleared).toHaveLength(0);
		expect(result.tracks).toBe(tracks);
	});

	test("is a no-op when refs is empty", () => {
		const tracks = tracksOf({
			main: [video({ id: "v1", linkId: "L1" })],
			audio: [audio({ id: "a1", linkId: "L1" })],
		});

		const result = unlinkElementsInSceneTracks({ tracks, refs: [] });

		expect(result.cleared).toHaveLength(0);
		expect(result.tracks).toBe(tracks);
	});
});
