import { describe, expect, test } from "bun:test";
import type {
	ImageElement,
	VideoElement,
	VideoTrack,
} from "@/timeline";
import type { MediaTime } from "@/wasm";
import { cloneTrackForDuplicate } from "../duplicate-track";

// The pure helper treats every field except `id`/`linkId` as opaque, so the
// fixtures only need the right SHAPE — the times can be plain branded numbers
// (no wasm MediaTime math is performed). `ticks` mints a branded MediaTime via a
// type guard (mirroring `@/wasm`'s `requireMediaTime`) so no `as` cast is needed
// and the `@/wasm` runtime (and its wasm binary) is never imported.
function isMediaTime(value: number): value is MediaTime {
	return Number.isInteger(value);
}
function ticks(n: number): MediaTime {
	if (!isMediaTime(n)) {
		throw new Error(`ticks(): expected an integer, got ${n}`);
	}
	return n;
}

function videoElement({
	id,
	linkId,
	overrides,
}: {
	id: string;
	linkId?: string;
	overrides?: Partial<VideoElement>;
}): VideoElement {
	const element: VideoElement = {
		id,
		name: `clip ${id}`,
		type: "video",
		mediaId: `media-${id}`,
		startTime: ticks(0),
		duration: ticks(100),
		trimStart: ticks(5),
		trimEnd: ticks(7),
		sourceDuration: ticks(112),
		params: { opacity: 1 },
		...(linkId !== undefined ? { linkId } : {}),
		...overrides,
	};
	return element;
}

// A second visual element type used to model a linked pair on one track. The
// helper's linkId remap is type-agnostic, so an image stands in for "the other
// member of the link group" without leaving the VideoTrack element union.
function imageElement({
	id,
	linkId,
}: {
	id: string;
	linkId?: string;
}): ImageElement {
	const element: ImageElement = {
		id,
		name: `image ${id}`,
		type: "image",
		mediaId: `media-${id}`,
		startTime: ticks(0),
		duration: ticks(100),
		trimStart: ticks(0),
		trimEnd: ticks(0),
		params: {},
		...(linkId !== undefined ? { linkId } : {}),
	};
	return element;
}

function videoTrack(elements: (VideoElement | ImageElement)[]): VideoTrack {
	return {
		id: "source-track",
		name: "Video 1",
		type: "video",
		hidden: false,
		muted: false,
		elements,
	};
}

describe("cloneTrackForDuplicate", () => {
	test("assigns the requested new track id", () => {
		const clone = cloneTrackForDuplicate({
			track: videoTrack([videoElement({ id: "a" })]),
			newTrackId: "new-track",
		});
		expect(clone.id).toBe("new-track");
		expect(clone.type).toBe("video");
		expect(clone.name).toBe("Video 1");
		// Track-level flags carry over verbatim.
		expect(clone.hidden).toBe(false);
		expect(clone.muted).toBe(false);
	});

	test("every element gets a new, unique id (distinct from the source)", () => {
		const source = videoTrack([
			videoElement({ id: "a" }),
			videoElement({ id: "b" }),
			videoElement({ id: "c" }),
		]);
		const clone = cloneTrackForDuplicate({
			track: source,
			newTrackId: "new-track",
		});

		const cloneIds = clone.elements.map((element) => element.id);
		// None of the new ids match a source id.
		const sourceIds = new Set(source.elements.map((element) => element.id));
		for (const id of cloneIds) {
			expect(sourceIds.has(id)).toBe(false);
		}
		// All new ids are unique among themselves.
		expect(new Set(cloneIds).size).toBe(cloneIds.length);
		expect(cloneIds.length).toBe(3);
	});

	test("preserves animations, trims, masks, retime, params, name", () => {
		// Content of animations/masks is irrelevant to the helper (preserved by
		// reference); empty-but-typed values exercise the preservation assertion
		// without fabricating shapes.
		const animations: VideoElement["animations"] = {};
		const masks: VideoElement["masks"] = [];
		const source = videoTrack([
			videoElement({
				id: "a",
				overrides: {
					name: "Hero shot",
					trimStart: ticks(11),
					trimEnd: ticks(22),
					duration: ticks(333),
					startTime: ticks(44),
					animations,
					retime: { rate: 0.5, maintainPitch: true },
					masks,
					params: { opacity: 0.8, scale: 2 },
				},
			}),
		]);
		const clone = cloneTrackForDuplicate({
			track: source,
			newTrackId: "new-track",
		});
		const copied = clone.elements[0];
		const original = source.elements[0];

		// Identity changed; everything else preserved by reference/value.
		expect(copied.id).not.toBe(original.id);
		expect(copied.name).toBe("Hero shot");
		expect(copied.trimStart).toBe(ticks(11));
		expect(copied.trimEnd).toBe(ticks(22));
		expect(copied.duration).toBe(ticks(333));
		expect(copied.startTime).toBe(ticks(44));
		expect(copied.animations).toEqual(original.animations);
		expect(copied.params).toEqual({ opacity: 0.8, scale: 2 });
		if (original.type === "video" && copied.type === "video") {
			expect(copied.retime).toEqual(original.retime);
			expect(copied.masks).toEqual(original.masks);
		}
	});

	test("a linked A/V pair maps to ONE new shared linkId (not the source's)", () => {
		const source = videoTrack([
			videoElement({ id: "v", linkId: "link-1" }),
			imageElement({ id: "a", linkId: "link-1" }),
		]);
		const clone = cloneTrackForDuplicate({
			track: source,
			newTrackId: "new-track",
		});

		const [v, a] = clone.elements;
		// Both copied members share a single linkId...
		expect(v.linkId).toBeDefined();
		expect(v.linkId).toBe(a.linkId);
		// ...which is NOT the source's linkId...
		expect(v.linkId).not.toBe("link-1");
		// ...and is not unlinked.
		expect(v.linkId).not.toBeUndefined();
	});

	test("drops a linkId whose partner is on another track (no dangling group-of-one)", () => {
		// The source track holds a SINGLE element carrying `link-cross`; its
		// conceptual partner (the separated audio) lives on a different track that
		// is not part of this duplicate. Re-keying it would produce a dangling
		// group-of-one, so the clone must be unlinked instead.
		const source = videoTrack([videoElement({ id: "v", linkId: "link-cross" })]);
		const clone = cloneTrackForDuplicate({
			track: source,
			newTrackId: "new-track",
		});
		expect(clone.elements[0].linkId).toBeUndefined();
		// The source is left untouched.
		expect(source.elements[0].linkId).toBe("link-cross");
	});

	test("an unlinked element stays unlinked", () => {
		const source = videoTrack([
			videoElement({ id: "v", linkId: "link-1" }),
			imageElement({ id: "a", linkId: "link-1" }),
			videoElement({ id: "solo" }),
		]);
		const clone = cloneTrackForDuplicate({
			track: source,
			newTrackId: "new-track",
		});
		const solo = clone.elements[2];
		expect(solo.linkId).toBeUndefined();
	});

	test("two independent link groups stay independent in the copy", () => {
		const source = videoTrack([
			videoElement({ id: "v1", linkId: "group-1" }),
			imageElement({ id: "a1", linkId: "group-1" }),
			videoElement({ id: "v2", linkId: "group-2" }),
			imageElement({ id: "a2", linkId: "group-2" }),
		]);
		const clone = cloneTrackForDuplicate({
			track: source,
			newTrackId: "new-track",
		});
		const [cv1, ca1, cv2, ca2] = clone.elements;

		// Each group is internally consistent...
		expect(cv1.linkId).toBe(ca1.linkId);
		expect(cv2.linkId).toBe(ca2.linkId);
		// ...the two groups differ from each other...
		expect(cv1.linkId).not.toBe(cv2.linkId);
		// ...and neither reuses a source linkId.
		expect(cv1.linkId).not.toBe("group-1");
		expect(cv2.linkId).not.toBe("group-2");
	});

	test("does not mutate the source track or its elements", () => {
		const source = videoTrack([
			videoElement({ id: "v", linkId: "link-1" }),
			imageElement({ id: "a", linkId: "link-1" }),
		]);
		cloneTrackForDuplicate({ track: source, newTrackId: "new-track" });
		expect(source.id).toBe("source-track");
		expect(source.elements[0].id).toBe("v");
		expect(source.elements[0].linkId).toBe("link-1");
		expect(source.elements[1].linkId).toBe("link-1");
	});
});
