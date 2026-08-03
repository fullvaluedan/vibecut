import { describe, expect, test } from "bun:test";
import { buildSegmentInsertSpecs } from "../place-segment-spec";

describe("buildSegmentInsertSpecs - audio never comes from render segments", () => {
	test("a segment WITH audio is still placed muted (the invariant)", () => {
		const [spec] = buildSegmentInsertSpecs([
			{
				assetId: "a1",
				startSec: 0,
				durationSec: 90,
				hasAudio: true, // an SFX-carrying render must not leak into export
			},
		]);
		expect(spec.isSourceAudioEnabled).toBe(false);
	});

	test("every segment in a batch is muted, audio or not", () => {
		const specs = buildSegmentInsertSpecs([
			{ assetId: "a1", startSec: 0, durationSec: 90, hasAudio: false },
			{ assetId: "a2", startSec: 90, durationSec: 90, hasAudio: true },
			{ assetId: "a3", startSec: 180, durationSec: 45, hasAudio: false },
		]);
		expect(specs.map((s) => s.isSourceAudioEnabled)).toEqual([
			false,
			false,
			false,
		]);
	});

	test("pass-through fields + the authored:chunk templateId fallback", () => {
		const [withIds, withoutIds] = buildSegmentInsertSpecs([
			{
				assetId: "a1",
				startSec: -3, // clamped to 0
				durationSec: 90,
				hasAudio: false,
				compId: "comp-1",
				templateId: "authored:comp-1",
				name: "HyperFrames: 0:00–1:30",
				brief: "the brief",
			},
			{ assetId: "a2", startSec: 90, durationSec: 90, hasAudio: false },
		]);
		expect(withIds.startSec).toBe(0);
		expect(withIds.compId).toBe("comp-1");
		expect(withIds.templateId).toBe("authored:comp-1");
		expect(withIds.name).toBe("HyperFrames: 0:00–1:30");
		expect(withIds.brief).toBe("the brief");
		expect(withoutIds.compId).toBeUndefined();
		expect(withoutIds.templateId).toBe("authored:chunk");
	});
});
