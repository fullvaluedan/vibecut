import { describe, expect, test } from "bun:test";
import {
	describeAspect,
	estimateContextTokens,
	measureContextChars,
	serializeAssistantContext,
} from "../context";
import { largeSnapshot, sec, smallSnapshot, videoClip } from "./fixtures";

/** 8k tokens is the roadmap's ceiling; 4 characters per token is the proxy. */
const TOKEN_TARGET = 8000;

function serialize(snapshot: Parameters<typeof serializeAssistantContext>[0]["snapshot"]) {
	return serializeAssistantContext({ snapshot });
}

describe("serializeAssistantContext (small fixture snapshot)", () => {
	const context = serialize(smallSnapshot());

	test("project header, toggles, playhead and selection", () => {
		expect(context.version).toBe(1);
		expect(context.project).toEqual({
			name: "Demo project",
			fps: 30,
			aspect: "16:9",
			size: "1920x1080",
			durationSec: 16,
		});
		expect(context.timeline).toEqual({
			mainTrackMagnet: true,
			rippleEditing: false,
			snapping: true,
		});
		expect(context.playheadSec).toBe(7);
		expect(context.selectedClipIds).toEqual(["clip-body"]);
		expect(context.truncated).toBe(false);
		expect(context.notes).toEqual([]);
	});

	test("tracks keep lane labels, order and per-clip detail", () => {
		expect(context.tracks.map((track) => track.label)).toEqual(["V1", "T1", "A1"]);
		expect(context.tracks[0].main).toBe(true);
		expect(context.tracks[1].main).toBeUndefined();
		expect(context.tracks[0].clips).toEqual([
			{
				id: "clip-intro",
				track: "V1",
				name: "intro.mp4",
				kind: "video",
				startSec: 0,
				endSec: 6,
				headroomSec: { start: 0, end: 0 },
				linkedTo: ["clip-intro-audio"],
			},
			{
				id: "clip-body",
				track: "V1",
				name: "body.mp4",
				kind: "video",
				startSec: 6,
				endSec: 16,
				headroomSec: { start: 2, end: 4 },
				selected: true,
			},
		]);
	});

	test("a text clip carries its template and no source headroom", () => {
		expect(context.tracks[1].clips[0]).toEqual({
			id: "clip-title",
			track: "T1",
			name: "Kinetic title",
			kind: "text",
			startSec: 1,
			endSec: 4,
			template: "kinetic-title",
		});
	});

	test("markers and the transcript window around the playhead", () => {
		expect(context.markers).toEqual([{ atSec: 5, note: "hook lands" }]);
		expect(context.transcript).toEqual({
			source: "lineage",
			fromSec: 0.5,
			toSec: 8.2,
			text: "hello and welcome here is everything",
		});
	});

	test("linked partners are reported from both sides", () => {
		expect(context.tracks[2].clips[0].linkedTo).toEqual(["clip-intro"]);
	});

	test("serialization is deterministic", () => {
		const a = JSON.stringify(serialize(smallSnapshot()));
		const b = JSON.stringify(serialize(smallSnapshot()));
		expect(a).toBe(b);
	});

	test("a retimed clip reports its speed and scaled headroom", () => {
		const snapshot = smallSnapshot();
		snapshot.tracks[0].clips[1] = videoClip({
			id: "clip-body",
			trackId: "track-main",
			startSec: 6,
			durationSec: 5,
			name: "body",
			mediaName: "body.mp4",
			trimStartSec: 2,
			trimEndSec: 4,
			sourceDurationSec: 16,
			speed: 2,
		});
		const clip = serialize(snapshot).tracks[0].clips[1];
		expect(clip.speed).toBe(2);
		expect(clip.headroomSec).toEqual({ start: 1, end: 2 });
	});

	test("no transcript produces a note instead of an empty section", () => {
		const context = serialize(
			smallSnapshot({ transcript: { source: "none", words: [] } }),
		);
		expect(context.transcript).toBeUndefined();
		expect(context.notes.join(" ")).toContain("No transcript");
	});
});

describe("serializeAssistantContext (30 minute, 100 clip project)", () => {
	const snapshot = largeSnapshot();
	const context = serialize(snapshot);
	const totalClips = snapshot.tracks.reduce(
		(sum, track) => sum + track.clips.length,
		0,
	);

	test("fits well inside the 8k token target", () => {
		expect(totalClips).toBe(136);
		expect(measureContextChars(context)).toBeLessThanOrEqual(24_000);
		expect(estimateContextTokens(context)).toBeLessThan(TOKEN_TARGET);
	});

	test("keeps the clip budget and summarizes the rest as counts", () => {
		const listed = context.tracks.reduce(
			(sum, track) => sum + track.clips.length,
			0,
		);
		const omitted = context.tracks.reduce(
			(sum, track) => sum + (track.omitted?.count ?? 0),
			0,
		);
		expect(listed).toBe(60);
		expect(listed + omitted).toBe(totalClips);
		expect(context.truncated).toBe(true);
		expect(context.notes.join(" ")).toContain("summarized as counts");
	});

	test("track clip counts survive truncation", () => {
		expect(context.tracks.map((track) => track.clipCount)).toEqual([100, 24, 12]);
	});

	test("relevance keeps the selection and the playhead region", () => {
		const listedIds = new Set(
			context.tracks.flatMap((track) => track.clips.map((clip) => clip.id)),
		);
		expect(listedIds.has("main-050")).toBe(true);
		expect(listedIds.has("main-049")).toBe(true);
		expect(listedIds.has("main-051")).toBe(true);
		// The far ends of a 30 minute timeline lose to the playhead region.
		expect(listedIds.has("main-000")).toBe(false);
		expect(listedIds.has("main-099")).toBe(false);
	});

	test("the transcript is a window around the playhead, not the whole 30 minutes", () => {
		expect(context.transcript?.fromSec).toBeGreaterThan(869);
		expect(context.transcript?.toSec).toBeLessThan(931);
		expect(context.transcript?.text.length).toBeLessThanOrEqual(2404);
	});

	test("a wider window is clipped to the character budget", () => {
		const wide = serializeAssistantContext({
			snapshot,
			options: { transcriptWindowSec: 600 },
		});
		expect(wide.transcript?.clipped).toBe(true);
		expect(wide.transcript?.text.length).toBeLessThanOrEqual(2403);
	});

	test("markers are capped and the drop is reported", () => {
		expect(context.markers).toHaveLength(40);
		expect(context.notes.join(" ")).toContain("more markers");
	});

	test("a tighter character budget shrinks further and still terminates", () => {
		const tight = serializeAssistantContext({
			snapshot,
			options: { maxChars: 4000 },
		});
		expect(measureContextChars(tight)).toBeLessThan(
			measureContextChars(context),
		);
		expect(tight.truncated).toBe(true);
	});

	test("large-project serialization is deterministic too", () => {
		expect(JSON.stringify(serialize(largeSnapshot()))).toBe(
			JSON.stringify(context),
		);
	});
});

describe("describeAspect", () => {
	test("reduces common canvas sizes", () => {
		expect(describeAspect({ width: 1920, height: 1080 })).toBe("16:9");
		expect(describeAspect({ width: 1080, height: 1920 })).toBe("9:16");
		expect(describeAspect({ width: 1080, height: 1080 })).toBe("1:1");
	});

	test("degrades safely on nonsense input", () => {
		expect(describeAspect({ width: 0, height: 1080 })).toBe("unknown");
	});
});

describe("protected spans", () => {
	test("are serialized in seconds when present", () => {
		const context = serialize(
			smallSnapshot({
				protectedSpans: [
					{ start: sec(2), end: sec(4), reason: "sponsor read" },
				],
			}),
		);
		expect(context.protectedSpans).toEqual([
			{ fromSec: 2, toSec: 4, reason: "sponsor read" },
		]);
	});
});
