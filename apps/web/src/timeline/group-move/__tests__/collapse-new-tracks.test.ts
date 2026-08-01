import { describe, expect, test } from "bun:test";
import type { GroupMember } from "@/timeline/group-move";
import { planCollapsedNewTracks } from "@/timeline/group-move/collapse-new-tracks";

// The helper only reads trackId + elementType, so build the minimal shape.
function videoMember(
	trackId: string,
): Pick<GroupMember, "trackId" | "elementType"> {
	return { trackId, elementType: "video" };
}

function audioMember(
	trackId: string,
): Pick<GroupMember, "trackId" | "elementType"> {
	return { trackId, elementType: "audio" };
}

describe("planCollapsedNewTracks", () => {
	test("collapses N clips from ONE source track into ONE new track", () => {
		const { createTracks, newTrackIdBySourceTrackId } = planCollapsedNewTracks({
			sortedMembers: [
				videoMember("main"),
				videoMember("main"),
				videoMember("main"),
			],
			videoBudget: 7,
			audioBudget: 8,
			blockStartIndex: 0,
			newTrackIds: ["n1", "n2", "n3"],
		});
		expect(createTracks).toHaveLength(1);
		expect(createTracks[0]).toEqual({ id: "n1", type: "video", index: 0 });
		expect(newTrackIdBySourceTrackId.get("main")).toBe("n1");
	});

	test("creates one new track PER distinct source track", () => {
		const { createTracks } = planCollapsedNewTracks({
			sortedMembers: [videoMember("v1"), videoMember("v2"), videoMember("v1")],
			videoBudget: 7,
			audioBudget: 8,
			blockStartIndex: 2,
			newTrackIds: ["n1", "n2", "n3"],
		});
		expect(createTracks).toHaveLength(2);
		expect(createTracks.map((t) => t.index)).toEqual([2, 3]);
	});

	test("caps new VIDEO tracks to the budget; over-budget sources are dropped", () => {
		const { createTracks, newTrackIdBySourceTrackId } = planCollapsedNewTracks({
			sortedMembers: [videoMember("v1"), videoMember("v2"), videoMember("v3")],
			videoBudget: 1,
			audioBudget: 8,
			blockStartIndex: 0,
			newTrackIds: ["n1", "n2", "n3"],
		});
		expect(createTracks).toHaveLength(1);
		expect(newTrackIdBySourceTrackId.has("v1")).toBe(true);
		expect(newTrackIdBySourceTrackId.has("v2")).toBe(false);
		expect(newTrackIdBySourceTrackId.has("v3")).toBe(false);
	});

	test("zero budget yields no new video tracks at all", () => {
		const { createTracks } = planCollapsedNewTracks({
			sortedMembers: [videoMember("v1"), videoMember("v2")],
			videoBudget: 0,
			audioBudget: 8,
			blockStartIndex: 0,
			newTrackIds: ["n1", "n2"],
		});
		expect(createTracks).toHaveLength(0);
	});

	test("caps new AUDIO tracks to the budget; over-budget sources are dropped", () => {
		const { createTracks, newTrackIdBySourceTrackId } = planCollapsedNewTracks({
			sortedMembers: [audioMember("a1"), audioMember("a2"), audioMember("a3")],
			videoBudget: 7,
			audioBudget: 1,
			blockStartIndex: 0,
			newTrackIds: ["n1", "n2", "n3"],
		});
		expect(createTracks).toHaveLength(1);
		expect(createTracks[0]).toEqual({ id: "n1", type: "audio", index: 0 });
		expect(newTrackIdBySourceTrackId.has("a1")).toBe(true);
		expect(newTrackIdBySourceTrackId.has("a2")).toBe(false);
		expect(newTrackIdBySourceTrackId.has("a3")).toBe(false);
	});

	test("zero audio budget yields no new audio tracks at all", () => {
		const { createTracks } = planCollapsedNewTracks({
			sortedMembers: [audioMember("a1"), audioMember("a2")],
			videoBudget: 7,
			audioBudget: 0,
			blockStartIndex: 0,
			newTrackIds: ["n1", "n2"],
		});
		expect(createTracks).toHaveLength(0);
	});

	test("below-cap audio creates one new track per distinct source track", () => {
		const { createTracks, newTrackIdBySourceTrackId } = planCollapsedNewTracks({
			sortedMembers: [audioMember("a1"), audioMember("a2"), audioMember("a1")],
			videoBudget: 7,
			audioBudget: 8,
			blockStartIndex: 1,
			newTrackIds: ["n1", "n2", "n3"],
		});
		expect(createTracks).toHaveLength(2);
		expect(createTracks.map((t) => t.type)).toEqual(["audio", "audio"]);
		expect(newTrackIdBySourceTrackId.get("a1")).toBe("n1");
		expect(newTrackIdBySourceTrackId.get("a2")).toBe("n2");
	});

	test("mixed video+audio group respects both budgets independently", () => {
		const { createTracks, newTrackIdBySourceTrackId } = planCollapsedNewTracks({
			sortedMembers: [
				videoMember("v1"),
				audioMember("a1"),
				videoMember("v2"),
				audioMember("a2"),
			],
			videoBudget: 1,
			audioBudget: 1,
			blockStartIndex: 0,
			newTrackIds: ["n1", "n2", "n3", "n4"],
		});
		expect(createTracks).toHaveLength(2);
		expect(createTracks.map((t) => t.type)).toEqual(["video", "audio"]);
		expect(newTrackIdBySourceTrackId.has("v1")).toBe(true);
		expect(newTrackIdBySourceTrackId.has("a1")).toBe(true);
		expect(newTrackIdBySourceTrackId.has("v2")).toBe(false);
		expect(newTrackIdBySourceTrackId.has("a2")).toBe(false);
	});
});
