import { describe, expect, test } from "bun:test";
import type { EditorCore } from "@/core";
import { SelectionManager } from "@/core/managers/selection-manager";
import type { AnimationPath } from "@/animation/types";

// The SelectionManager constructor only does `void editor`, so a bare stub is
// enough to unit-test the pure reconciliation.
function newManager(): SelectionManager {
	return new SelectionManager({} as EditorCore);
}

const propertyPath = "opacity" as unknown as AnimationPath;

describe("SelectionManager.reconcileWithLiveElements", () => {
	test("prunes an element ref whose element is gone / re-minted", () => {
		const manager = newManager();
		manager.setSelectedElements({
			elements: [
				{ trackId: "video-main", elementId: "old" },
				{ trackId: "audio-1", elementId: "keep" },
			],
		});

		manager.reconcileWithLiveElements({
			livePairs: new Set(["audio-1:keep"]),
		});

		expect(manager.getSelectedElements()).toEqual([
			{ trackId: "audio-1", elementId: "keep" },
		]);
	});

	test("a still-live selected clip on another track keeps its ref", () => {
		const manager = newManager();
		manager.setSelectedElements({
			elements: [
				{ trackId: "video-main", elementId: "gone" },
				{ trackId: "overlay-1", elementId: "alive" },
			],
		});

		manager.reconcileWithLiveElements({
			livePairs: new Set(["overlay-1:alive", "video-main:someoneelse"]),
		});

		expect(manager.getSelectedElements()).toEqual([
			{ trackId: "overlay-1", elementId: "alive" },
		]);
	});

	test("a no-op reconcile (all live) leaves selection unchanged and does not notify", () => {
		const manager = newManager();
		manager.setSelectedElements({
			elements: [{ trackId: "video-main", elementId: "a" }],
		});
		let notified = 0;
		manager.subscribe(() => {
			notified += 1;
		});

		manager.reconcileWithLiveElements({
			livePairs: new Set(["video-main:a"]),
		});

		expect(manager.getSelectedElements()).toEqual([
			{ trackId: "video-main", elementId: "a" },
		]);
		expect(notified).toBe(0);
	});

	test("prunes orphaned keyframe refs and clears the anchor when it is gone", () => {
		const manager = newManager();
		manager.setSelectedKeyframes({
			keyframes: [
				{ trackId: "video-main", elementId: "gone", propertyPath, keyframeId: "k1" },
			],
			anchorKeyframe: {
				trackId: "video-main",
				elementId: "gone",
				propertyPath,
				keyframeId: "k1",
			},
		});

		manager.reconcileWithLiveElements({
			livePairs: new Set(["video-main:other"]),
		});

		expect(manager.getSelectedKeyframes()).toEqual([]);
		expect(manager.getKeyframeSelectionAnchor()).toBeNull();
	});

	test("keeps a live keyframe ref while dropping a dead sibling", () => {
		const manager = newManager();
		manager.setSelectedKeyframes({
			keyframes: [
				{ trackId: "video-main", elementId: "gone", propertyPath, keyframeId: "k1" },
				{ trackId: "video-main", elementId: "live", propertyPath, keyframeId: "k2" },
			],
		});

		manager.reconcileWithLiveElements({
			livePairs: new Set(["video-main:live"]),
		});

		expect(manager.getSelectedKeyframes()).toEqual([
			{ trackId: "video-main", elementId: "live", propertyPath, keyframeId: "k2" },
		]);
	});
});
