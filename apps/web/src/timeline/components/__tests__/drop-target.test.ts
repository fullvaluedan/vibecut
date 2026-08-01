import { describe, expect, test } from "bun:test";
import type {
	AudioElement,
	AudioTrack,
	SceneTracks,
	VideoElement,
	VideoTrack,
} from "@/timeline";
import {
	computeDropTarget,
	getTrackAtY,
} from "@/timeline/components/drop-target";
import { mediaTime, TICKS_PER_SECOND, ZERO_MEDIA_TIME } from "@/wasm";

// Row geometry the hit-test must mirror (timeline/components/layout.ts):
// video 65px, audio 50px, 6px gap, 2px content padding above the first row.
// [main(65), audio(50)]  => main [2,67), audio [73,123)
// [overlay(65), main(65), audio(50)] => overlay [2,67), main [73,138),
//                                       audio [144,194)
const SECOND = TICKS_PER_SECOND;

function seconds({ value }: { value: number }) {
	return mediaTime({ ticks: value * SECOND });
}

function videoClip({
	id,
	startTime,
	duration,
}: {
	id: string;
	startTime: number;
	duration: number;
}): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		startTime: seconds({ value: startTime }),
		duration: seconds({ value: duration }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		mediaId: `media-${id}`,
		params: {
			"transform.positionX": 0,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			"transform.rotate": 0,
			opacity: 1,
		},
	};
}

function audioClip({
	id,
	startTime,
	duration,
}: {
	id: string;
	startTime: number;
	duration: number;
}): AudioElement {
	return {
		id,
		type: "audio",
		name: id,
		startTime: seconds({ value: startTime }),
		duration: seconds({ value: duration }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		sourceType: "upload",
		mediaId: `media-${id}`,
		params: { volume: 1, muted: false },
	};
}

function videoTrack({
	id,
	elements = [],
}: {
	id: string;
	elements?: VideoElement[];
}): VideoTrack {
	return { id, type: "video", name: id, muted: false, hidden: false, elements };
}

function audioTrack({
	id,
	elements = [],
}: {
	id: string;
	elements?: AudioElement[];
}): AudioTrack {
	return { id, type: "audio", name: id, muted: false, elements };
}

function buildTracks({
	overlay = [],
	main = videoTrack({ id: "main" }),
	audio = [],
}: {
	overlay?: VideoTrack[];
	main?: VideoTrack;
	audio?: AudioTrack[];
} = {}): SceneTracks {
	return { overlay, main, audio };
}

/**
 * A media drop (bin drag / file drop): `preferMainTrack` on, 1px per second at
 * zoom 1 so `mouseX` reads directly as seconds.
 */
function dropMedia({
	tracks,
	mouseX = 5,
	mouseY,
	elementType = "video",
	durationSec = 1,
	preferMainTrack = true,
	getExtraTrackHeight,
}: {
	tracks: SceneTracks;
	mouseX?: number;
	mouseY: number;
	elementType?: "video" | "image" | "audio";
	durationSec?: number;
	preferMainTrack?: boolean;
	getExtraTrackHeight?: (trackIndex: number) => number;
}) {
	return computeDropTarget({
		elementType,
		mouseX,
		mouseY,
		tracks,
		playheadTime: ZERO_MEDIA_TIME,
		isExternalDrop: false,
		elementDuration: seconds({ value: durationSec }),
		pixelsPerSecond: 1,
		zoomLevel: 1,
		preferMainTrack,
		getExtraTrackHeight,
	});
}

describe("getTrackAtY", () => {
	const tracks = [videoTrack({ id: "main" }), audioTrack({ id: "a1" })];

	test("rows start below the 2px content padding", () => {
		expect(getTrackAtY({ mouseY: 1, tracks })).toBeNull();
		expect(getTrackAtY({ mouseY: 2, tracks })?.trackIndex).toBe(0);
		expect(getTrackAtY({ mouseY: 66, tracks })?.trackIndex).toBe(0);
		// The gap between the rows is a hit only while dragging vertically.
		expect(getTrackAtY({ mouseY: 70, tracks })).toBeNull();
		expect(getTrackAtY({ mouseY: 73, tracks })?.trackIndex).toBe(1);
		expect(getTrackAtY({ mouseY: 122, tracks })?.trackIndex).toBe(1);
		expect(getTrackAtY({ mouseY: 123, tracks })).toBeNull();
	});

	test("relativeY is measured from the row top, not the content top", () => {
		expect(getTrackAtY({ mouseY: 2, tracks })?.relativeY).toBe(0);
		expect(getTrackAtY({ mouseY: 73, tracks })?.relativeY).toBe(0);
	});

	test("an expanded keyframe row grows the track it belongs to", () => {
		// One 20px keyframe lane on the video track: it now spans [2,87) and the
		// audio lane starts at 93 instead of 73.
		const getExtraHeight = (trackIndex: number) => (trackIndex === 0 ? 20 : 0);
		expect(getTrackAtY({ mouseY: 80, tracks, getExtraHeight })?.trackIndex).toBe(
			0,
		);
		expect(getTrackAtY({ mouseY: 100, tracks, getExtraHeight })?.trackIndex).toBe(
			1,
		);
		// Without the expansion the same y lands a whole lane off (the old drift).
		expect(getTrackAtY({ mouseY: 80, tracks })?.trackIndex).toBe(1);
	});
});

describe("media drop targeting (T15.1)", () => {
	test("empty main track: a bin drop below the tracks lands on main", () => {
		const target = dropMedia({ tracks: buildTracks(), mouseY: 400 });
		expect(target.isNewTrack).toBe(false);
		expect(target.trackIndex).toBe(0);
		expect(target.xPosition).toBe(seconds({ value: 5 }));
	});

	test("empty main track: a drop in the overlay area still lands on main", () => {
		const tracks = buildTracks({
			overlay: [videoTrack({ id: "v2" })],
		});
		// y=10 is the top half of the overlay lane (the "make a new lane" zone).
		const target = dropMedia({ tracks, mouseY: 10 });
		expect(target.isNewTrack).toBe(false);
		// Main sits below the one overlay lane.
		expect(target.trackIndex).toBe(1);
	});

	test("empty main track: head gravity still pulls a near-zero drop to 0", () => {
		const target = dropMedia({ tracks: buildTracks(), mouseX: 1, mouseY: 400 });
		expect(target.isNewTrack).toBe(false);
		expect(target.xPosition).toBe(ZERO_MEDIA_TIME);
	});

	test("occupied timeline: a drop below the tracks with an audio lane present lands on main", () => {
		// The reported bug: after the first drop auto-separates audio, the lowest
		// track is an audio lane, so a below-the-tracks drop spawned V2.
		const tracks = buildTracks({
			main: videoTrack({
				id: "main",
				elements: [videoClip({ id: "v1", startTime: 0, duration: 2 })],
			}),
			audio: [
				audioTrack({
					id: "a1",
					elements: [audioClip({ id: "a-v1", startTime: 0, duration: 2 })],
				}),
			],
		});
		const target = dropMedia({ tracks, mouseY: 400 });
		expect(target.isNewTrack).toBe(false);
		expect(target.trackIndex).toBe(0);
		expect(target.xPosition).toBe(seconds({ value: 5 }));
	});

	test("occupied timeline: a drop ON an audio lane lands on main, never the lane", () => {
		const tracks = buildTracks({
			main: videoTrack({
				id: "main",
				elements: [videoClip({ id: "v1", startTime: 0, duration: 2 })],
			}),
			audio: [audioTrack({ id: "a1" })],
		});
		// y=90 is inside the audio lane row [73,123).
		const target = dropMedia({ tracks, mouseY: 90 });
		expect(target.isNewTrack).toBe(false);
		expect(target.trackIndex).toBe(0);
	});

	test("a drop over the ruler strip lands on main, not a new top track", () => {
		const tracks = buildTracks({
			main: videoTrack({
				id: "main",
				elements: [videoClip({ id: "v1", startTime: 0, duration: 2 })],
			}),
			audio: [audioTrack({ id: "a1" })],
		});
		// The ruler sits above the tracks scroll area, so mouseY arrives negative.
		const target = dropMedia({ tracks, mouseY: -30 });
		expect(target.isNewTrack).toBe(false);
		expect(target.trackIndex).toBe(0);
	});

	test("V1 occupied for the clip's whole span still targets main (insert flow)", () => {
		const tracks = buildTracks({
			main: videoTrack({
				id: "main",
				elements: [videoClip({ id: "v1", startTime: 0, duration: 20 })],
			}),
			audio: [audioTrack({ id: "a1" })],
		});
		// Drop at 5s, right inside the covering clip, on the main row (y=30).
		const target = dropMedia({ tracks, mouseY: 30 });
		expect(target.isNewTrack).toBe(false);
		expect(target.trackIndex).toBe(0);
		expect(target.xPosition).toBe(seconds({ value: 5 }));
	});

	test("a gap too short for the clip still targets main", () => {
		// Clips at [0,2) and [6,10): the 4s gap cannot hold a 6s drop at 5s.
		const tracks = buildTracks({
			main: videoTrack({
				id: "main",
				elements: [
					videoClip({ id: "v1", startTime: 0, duration: 2 }),
					videoClip({ id: "v2", startTime: 6, duration: 4 }),
				],
			}),
		});
		const target = dropMedia({ tracks, mouseY: 30, durationSec: 6 });
		expect(target.isNewTrack).toBe(false);
		expect(target.trackIndex).toBe(0);
	});

	test("the overlay area above an occupied main still makes a new overlay track", () => {
		const tracks = buildTracks({
			overlay: [
				videoTrack({
					id: "v2",
					elements: [videoClip({ id: "o1", startTime: 0, duration: 20 })],
				}),
			],
			main: videoTrack({
				id: "main",
				elements: [videoClip({ id: "v1", startTime: 0, duration: 20 })],
			}),
		});
		// y=10 is the top half of the occupied overlay lane [2,67).
		const target = dropMedia({ tracks, mouseY: 10 });
		expect(target.isNewTrack).toBe(true);
		expect(target.trackIndex).toBe(0);
		expect(target.insertPosition).toBe("above");
	});

	test("an audio drop is not pulled onto the main video track", () => {
		const tracks = buildTracks({
			main: videoTrack({
				id: "main",
				elements: [videoClip({ id: "v1", startTime: 0, duration: 2 })],
			}),
			audio: [audioTrack({ id: "a1" })],
		});
		const target = dropMedia({ tracks, mouseY: 400, elementType: "audio" });
		expect(target.isNewTrack).toBe(false);
		// The existing audio lane, below main.
		expect(target.trackIndex).toBe(1);
	});

	test("the hit-test honours expanded keyframe rows", () => {
		const tracks = buildTracks({
			overlay: [videoTrack({ id: "v2" })],
			main: videoTrack({
				id: "main",
				elements: [videoClip({ id: "v1", startTime: 0, duration: 20 })],
			}),
		});
		// The overlay lane carries a 20px keyframe lane, so it spans [2,87) and
		// y=80 is still the overlay lane's LOWER half (a "new lane below" ask).
		const target = dropMedia({
			tracks,
			mouseY: 80,
			getExtraTrackHeight: (trackIndex) => (trackIndex === 0 ? 20 : 0),
		});
		expect(target.isNewTrack).toBe(false);
		// Free overlay lane under the cursor, so the drop lands there.
		expect(target.trackIndex).toBe(0);
	});
});

describe("drop targeting without main-track preference (clip drags)", () => {
	test("out-of-bounds below uses the resolved existing track instead of a new one", () => {
		// The discarded-result fallthrough: the below-the-tracks branch asks for an
		// existing lane, and that answer used to be thrown away for a new top track.
		const tracks = buildTracks();
		const target = dropMedia({
			tracks,
			mouseY: 400,
			preferMainTrack: false,
		});
		expect(target.isNewTrack).toBe(false);
		expect(target.trackIndex).toBe(0);
	});

	test("out-of-bounds above still makes a new top track", () => {
		const tracks = buildTracks({
			main: videoTrack({
				id: "main",
				elements: [videoClip({ id: "v1", startTime: 0, duration: 20 })],
			}),
		});
		const target = dropMedia({
			tracks,
			mouseY: -30,
			preferMainTrack: false,
		});
		expect(target.isNewTrack).toBe(true);
		expect(target.trackIndex).toBe(0);
	});
});
