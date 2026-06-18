import { describe, expect, test } from "bun:test";
import {
	buildMoveCarveInputs,
	type MoveCarveElement,
} from "../move-overwrite-plan";
import { planClipDrop } from "../overwrite-plan";

// Two existing clips on the target track plus the clip being moved. The moved
// clip starts on this same track (the same-track-move case, the hot path).
const movedId = "moved";
function track(): MoveCarveElement[] {
	return [
		{ id: movedId, startTime: 0, duration: 1000 },
		{ id: "a", startTime: 2000, duration: 2000 }, // [2000, 4000)
		{ id: "b", startTime: 5000, duration: 1000 }, // [5000, 6000)
	];
}

describe("buildMoveCarveInputs — moved clip exclusion", () => {
	test("the moved clip is never in existingClips (same-track move)", () => {
		const result = buildMoveCarveInputs({
			targetTrackElements: track(),
			movedElementId: movedId,
			newStart: 2500,
			newDuration: 1000,
		});
		// Only "a" and "b" survive — the moved clip itself is excluded.
		expect(result.existingClips).toHaveLength(2);
		expect(
			result.existingClips.some((clip) => clip.startTime === 0),
		).toBe(false);
	});

	test("the moved clip never appears in the carve delete set", () => {
		// Move the clip onto its own original-ish region: even if its old and new
		// spans overlap, it must not delete itself.
		const inputs = buildMoveCarveInputs({
			targetTrackElements: track(),
			movedElementId: movedId,
			newStart: 2500,
			newDuration: 1000,
		});
		const plan = planClipDrop({
			existingClips: inputs.existingClips,
			incomingStart: inputs.incomingStart,
			incomingEnd: inputs.incomingEnd,
			mode: "overwrite",
		});
		// The delete range is [2500, 3500); only fragments of "a"/"b" can fall in
		// it. The moved clip is absent from existingClips, so it is structurally
		// impossible for it to be a delete victim.
		expect(plan.deleteRange).toEqual({ start: 2500, end: 3500 });
		expect(
			inputs.existingClips.find((clip) => clip.startTime === 0),
		).toBeUndefined();
	});
});

describe("buildMoveCarveInputs — overlap gate", () => {
	test("overlap → carve (gate true)", () => {
		const result = buildMoveCarveInputs({
			targetTrackElements: track(),
			movedElementId: movedId,
			newStart: 2500, // lands inside clip "a" [2000, 4000)
			newDuration: 1000,
		});
		expect(result.overlaps).toBe(true);
	});

	test("no overlap → ordinary move (gate false)", () => {
		const result = buildMoveCarveInputs({
			targetTrackElements: track(),
			movedElementId: movedId,
			newStart: 7000, // empty region after "b"
			newDuration: 1000,
		});
		expect(result.overlaps).toBe(false);
	});

	test("touching edges do NOT count as overlap (half-open)", () => {
		// New span [4000, 5000): ends exactly where "b" starts, starts exactly
		// where "a" ends. No interior intersection → no carve.
		const result = buildMoveCarveInputs({
			targetTrackElements: track(),
			movedElementId: movedId,
			newStart: 4000,
			newDuration: 1000,
		});
		expect(result.overlaps).toBe(false);
	});

	test("a move whose ONLY overlap is itself does not carve", () => {
		// A single-clip track holding just the moved clip; moving it within empty
		// space must not register an overlap against its own old position.
		const single: MoveCarveElement[] = [
			{ id: movedId, startTime: 1000, duration: 1000 }, // [1000, 2000)
		];
		const result = buildMoveCarveInputs({
			targetTrackElements: single,
			movedElementId: movedId,
			newStart: 1500, // overlaps its OWN old span only
			newDuration: 1000,
		});
		expect(result.existingClips).toHaveLength(0);
		expect(result.overlaps).toBe(false);
	});
});

describe("buildMoveCarveInputs — cross-track move", () => {
	test("moved clip absent from the target track is handled uniformly", () => {
		// Moving onto a DIFFERENT track: the moved clip simply isn't in the
		// target's elements. The filter is a no-op; overlap is computed against
		// the destination's real clips.
		const destination: MoveCarveElement[] = [
			{ id: "x", startTime: 0, duration: 3000 }, // [0, 3000)
		];
		const result = buildMoveCarveInputs({
			targetTrackElements: destination,
			movedElementId: movedId, // not present here
			newStart: 1000,
			newDuration: 1000,
		});
		expect(result.existingClips).toHaveLength(1);
		expect(result.overlaps).toBe(true);
	});
});
