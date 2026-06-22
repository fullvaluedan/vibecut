import { describe, expect, test } from "bun:test";
import type { GroupMember } from "@/timeline/group-move";
import { planCollapsedNewTracks } from "@/timeline/group-move/collapse-new-tracks";

// The helper only reads trackId + elementType, so build the minimal shape.
function videoMember(
	trackId: string,
): Pick<GroupMember, "trackId" | "elementType"> {
	return { trackId, elementType: "video" };
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
			blockStartIndex: 0,
			newTrackIds: ["n1", "n2"],
		});
		expect(createTracks).toHaveLength(0);
	});
});
