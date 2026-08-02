import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import type { FrameRate } from "opencut-wasm";
import type { MouseEvent as ReactMouseEvent } from "react";
import type {
	AudioElement,
	AudioTrack,
	SceneTracks,
	TimelineElement,
	TimelineTrack,
	VideoElement,
	VideoTrack,
} from "@/timeline";
import type { GroupResizeUpdate } from "@/timeline/group-resize";
import type { RippleTrimCommit } from "@/timeline/ripple-trim";
import { mediaTime, TICKS_PER_SECOND, ZERO_MEDIA_TIME } from "@/wasm";

// --- Environment stubs (the controller listens on `document` and pins the body
// cursor; neither exists under `bun test`). ---

const documentHandlers = new Map<string, (event: MouseEvent) => void>();
const documentStub = {
	body: { style: { cursor: "", userSelect: "" } },
	addEventListener: (type: string, fn: (event: MouseEvent) => void) => {
		documentHandlers.set(type, fn);
	},
	removeEventListener: (type: string) => {
		documentHandlers.delete(type);
	},
};

// Installed for THIS file only, then removed: a half-real global `document`
// leaks into other suites (sonner, for one, initialises differently when it
// sees a document and then calls DOM APIs this stub does not have).
beforeAll(() => {
	(globalThis as unknown as { document: unknown }).document = documentStub;
});
afterAll(() => {
	delete (globalThis as unknown as { document?: unknown }).document;
});

let storeState = {
	snappingEnabled: false,
	rippleEditingEnabled: false,
	mainTrackMagnetEnabled: true,
	linkedSelectionEnabled: true,
};
mock.module("@/timeline/timeline-store", () => ({
	useTimelineStore: { getState: () => storeState },
}));

import {
	ResizeController,
	type ResizeConfig,
	type ResizePreviewUpdate,
} from "@/timeline/controllers/resize-controller";
import { BASE_TIMELINE_PIXELS_PER_SECOND } from "@/timeline/scale";

const FPS: FrameRate = { numerator: 30, denominator: 1 };
const FRAME = 4_000;

function vid({
	id,
	startTime,
	duration,
	linkId,
}: {
	id: string;
	startTime: number;
	duration: number;
	linkId?: string;
}): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		startTime: mediaTime({ ticks: startTime }),
		duration: mediaTime({ ticks: duration }),
		trimStart: mediaTime({ ticks: 10 * FRAME }),
		trimEnd: mediaTime({ ticks: 10 * FRAME }),
		sourceDuration: mediaTime({ ticks: 30 * FRAME }),
		mediaId: `media-${id}`,
		...(linkId ? { linkId } : {}),
		params: {
			"transform.positionX": 0,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			"transform.rotate": 0,
			opacity: 1,
		},
	} as VideoElement;
}

function aud({
	id,
	startTime,
	duration,
	linkId,
}: {
	id: string;
	startTime: number;
	duration: number;
	linkId?: string;
}): AudioElement {
	return {
		id,
		type: "audio",
		name: id,
		startTime: mediaTime({ ticks: startTime }),
		duration: mediaTime({ ticks: duration }),
		trimStart: mediaTime({ ticks: 10 * FRAME }),
		trimEnd: mediaTime({ ticks: 10 * FRAME }),
		sourceDuration: mediaTime({ ticks: 30 * FRAME }),
		sourceType: "upload",
		mediaId: `media-${id}`,
		...(linkId ? { linkId } : {}),
		params: {},
	} as unknown as AudioElement;
}

/** Three butted main clips with separated audio, an overlay title, and an
 * unlinked music bed. */
function buildProject(): SceneTracks {
	const main: VideoTrack = {
		id: "main",
		type: "video",
		name: "V1",
		muted: false,
		hidden: false,
		elements: [
			vid({ id: "a", startTime: 0, duration: 10 * FRAME, linkId: "l-a" }),
			vid({ id: "b", startTime: 10 * FRAME, duration: 10 * FRAME, linkId: "l-b" }),
			vid({ id: "c", startTime: 20 * FRAME, duration: 10 * FRAME, linkId: "l-c" }),
		],
	};
	const overlay: VideoTrack = {
		id: "overlay-0",
		type: "video",
		name: "V2",
		muted: false,
		hidden: false,
		elements: [vid({ id: "title", startTime: 20 * FRAME, duration: 5 * FRAME })],
	};
	const voice = {
		id: "audio-0",
		type: "audio",
		name: "A1",
		muted: false,
		elements: [
			aud({ id: "a-au", startTime: 0, duration: 10 * FRAME, linkId: "l-a" }),
			aud({ id: "b-au", startTime: 10 * FRAME, duration: 10 * FRAME, linkId: "l-b" }),
			aud({ id: "c-au", startTime: 20 * FRAME, duration: 10 * FRAME, linkId: "l-c" }),
		],
	} as unknown as AudioTrack;
	return { overlay: [overlay], main, audio: [voice] };
}

interface Harness {
	controller: ResizeController;
	tracks: SceneTracks;
	previews: ResizePreviewUpdate[][];
	commits: Array<{
		updates: GroupResizeUpdate[];
		ripple: RippleTrimCommit | null;
	}>;
}

function newHarness(): Harness {
	const tracks = buildProject();
	const previews: ResizePreviewUpdate[][] = [];
	const commits: Harness["commits"] = [];
	const config: ResizeConfig = {
		zoomLevel: 1,
		snappingEnabled: false,
		isShiftHeld: () => false,
		getSceneTracks: () => tracks,
		getCurrentPlayheadTime: () => ZERO_MEDIA_TIME,
		getActiveProjectFps: () => FPS,
		discardPreview: () => {},
		previewElements: (updates) => previews.push(updates),
		commitElements: (updates, ripple) => commits.push({ updates, ripple }),
	};
	const controller = new ResizeController({ configRef: { current: config } });
	return { controller, tracks, previews, commits };
}

function grab({
	harness,
	elementId,
	trackId,
	side,
}: {
	harness: Harness;
	elementId: string;
	trackId: string;
	side: "left" | "right";
}): void {
	const track = [
		...harness.tracks.overlay,
		harness.tracks.main,
		...harness.tracks.audio,
	].find((candidate) => candidate.id === trackId) as TimelineTrack;
	const element = track.elements.find(
		(candidate) => candidate.id === elementId,
	) as TimelineElement;
	harness.controller.onResizeStart({
		event: {
			clientX: 0,
			altKey: false,
			stopPropagation: () => {},
			preventDefault: () => {},
		} as unknown as ReactMouseEvent,
		element,
		track,
		side,
	});
}

/** Move the mouse by exactly `frames` frames' worth of pixels. */
function dragFrames(frames: number): void {
	const ticks = frames * FRAME;
	const clientX = (ticks / TICKS_PER_SECOND) * BASE_TIMELINE_PIXELS_PER_SECOND;
	documentHandlers.get("mousemove")?.({ clientX } as MouseEvent);
}

function release(): void {
	documentHandlers.get("mouseup")?.({} as MouseEvent);
}

function startTimeOf({
	preview,
	elementId,
}: {
	preview: ResizePreviewUpdate[];
	elementId: string;
}): number | undefined {
	return preview.find((update) => update.elementId === elementId)?.patch
		.startTime as number | undefined;
}

describe("magnet trim through the resize controller", () => {
	beforeEach(() => {
		documentHandlers.clear();
		storeState = {
			snappingEnabled: false,
			rippleEditingEnabled: false,
			mainTrackMagnetEnabled: true,
			linkedSelectionEnabled: true,
		};
	});

	test("RIGHT handle: extending a main clip pushes downstream main clips and their linked audio, live and on commit", () => {
		const harness = newHarness();
		grab({ harness, elementId: "a", trackId: "main", side: "right" });
		dragFrames(5);

		const preview = harness.previews[harness.previews.length - 1];
		expect(startTimeOf({ preview, elementId: "b" })).toBe(15 * FRAME);
		expect(startTimeOf({ preview, elementId: "b-au" })).toBe(15 * FRAME);
		expect(startTimeOf({ preview, elementId: "c" })).toBe(25 * FRAME);
		expect(startTimeOf({ preview, elementId: "c-au" })).toBe(25 * FRAME);
		// Overlay clips are never magnetic.
		expect(startTimeOf({ preview, elementId: "title" })).toBeUndefined();

		release();
		const commit = harness.commits[0];
		expect(commit.ripple).toEqual({
			pivotTime: mediaTime({ ticks: 10 * FRAME }),
			deltaTime: mediaTime({ ticks: 5 * FRAME }),
			excludeElementIds: new Set(["a", "a-au"]),
			scope: "main-track",
		});
		expect(commit.updates[0].patch.duration).toBe(mediaTime({ ticks: 15 * FRAME }));
	});

	test("LEFT handle: a head trim keeps the clip butted and slides the tail back instead", () => {
		const harness = newHarness();
		grab({ harness, elementId: "b", trackId: "main", side: "left" });
		dragFrames(3);

		const preview = harness.previews[harness.previews.length - 1];
		// The trimmed clip does NOT move; only its content changes.
		expect(startTimeOf({ preview, elementId: "b" })).toBe(10 * FRAME);
		expect(startTimeOf({ preview, elementId: "c" })).toBe(17 * FRAME);
		expect(startTimeOf({ preview, elementId: "c-au" })).toBe(17 * FRAME);

		release();
		const commit = harness.commits[0];
		expect(commit.updates[0].patch.startTime).toBe(mediaTime({ ticks: 10 * FRAME }));
		expect(commit.updates[0].patch.duration).toBe(mediaTime({ ticks: 7 * FRAME }));
		expect(commit.ripple).toEqual({
			pivotTime: mediaTime({ ticks: 20 * FRAME }),
			deltaTime: mediaTime({ ticks: -3 * FRAME }),
			excludeElementIds: new Set(["b", "b-au"]),
			scope: "main-track",
		});
	});

	test("LEFT handle: the lifted bound lets a butted clip reveal more head (magnet OFF it cannot move at all)", () => {
		const harness = newHarness();
		grab({ harness, elementId: "b", trackId: "main", side: "left" });
		dragFrames(-4);

		const preview = harness.previews[harness.previews.length - 1];
		expect(startTimeOf({ preview, elementId: "b" })).toBe(10 * FRAME);
		expect(startTimeOf({ preview, elementId: "c" })).toBe(24 * FRAME);

		storeState = { ...storeState, mainTrackMagnetEnabled: false };
		const plain = newHarness();
		grab({ harness: plain, elementId: "b", trackId: "main", side: "left" });
		dragFrames(-4);

		const plainPreview = plain.previews[plain.previews.length - 1];
		// Butted against clip a, so with the magnet off the drag is refused.
		expect(startTimeOf({ preview: plainPreview, elementId: "b" })).toBe(10 * FRAME);
		expect(startTimeOf({ preview: plainPreview, elementId: "c" })).toBeUndefined();
	});

	test("magnet OFF is today's behavior: only the linked pair is previewed and the commit carries no shift", () => {
		storeState = { ...storeState, mainTrackMagnetEnabled: false };
		const harness = newHarness();
		grab({ harness, elementId: "a", trackId: "main", side: "right" });
		dragFrames(-5);

		const preview = harness.previews[harness.previews.length - 1];
		expect(preview).toHaveLength(2);
		expect(startTimeOf({ preview, elementId: "b" })).toBeUndefined();

		release();
		expect(harness.commits[0].ripple).toBeNull();
	});

	test("ripple editing wins when both toggles are on: the shift covers overlay lanes too, once", () => {
		storeState = {
			...storeState,
			rippleEditingEnabled: true,
			mainTrackMagnetEnabled: true,
		};
		const harness = newHarness();
		grab({ harness, elementId: "a", trackId: "main", side: "right" });
		dragFrames(5);

		const preview = harness.previews[harness.previews.length - 1];
		expect(startTimeOf({ preview, elementId: "title" })).toBe(25 * FRAME);
		expect(startTimeOf({ preview, elementId: "b" })).toBe(15 * FRAME);
		// One entry per shifted element: nothing is shifted twice.
		expect(preview.filter((update) => update.elementId === "b")).toHaveLength(1);

		release();
		expect(harness.commits[0].ripple?.scope).toBe("all-tracks");
	});

	test("trimming an OVERLAY clip is never magnetic", () => {
		const harness = newHarness();
		grab({ harness, elementId: "title", trackId: "overlay-0", side: "right" });
		dragFrames(2);

		expect(harness.previews[harness.previews.length - 1]).toHaveLength(1);
		release();
		expect(harness.commits[0].ripple).toBeNull();
	});
});
