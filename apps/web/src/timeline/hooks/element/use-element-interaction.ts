import { useEffect, useReducer, useState, type RefObject } from "react";
import { useEditor } from "@/editor/use-editor";
import { useCommittedRef } from "@/hooks/use-committed-ref";
import { useShiftKey } from "@/hooks/use-shift-key";
import { useElementSelection } from "@/timeline/hooks/element/use-element-selection";
import { registerCanceller } from "@/editor/cancel-interaction";
import {
	ElementInteractionController,
	type ElementInteractionDeps,
	type ElementInteractionDepsRef,
} from "@/timeline/controllers/element-interaction-controller";
import type { SnapPoint } from "@/timeline/snapping";

interface UseElementInteractionProps {
	zoomLevel: number;
	tracksContainerRef: RefObject<HTMLDivElement | null>;
	tracksScrollRef: RefObject<HTMLDivElement | null>;
	headerRef?: RefObject<HTMLElement | null>;
	snappingEnabled: boolean;
	onSnapPointChange?: (snapPoint: SnapPoint | null) => void;
}

export function useElementInteraction({
	zoomLevel,
	tracksContainerRef,
	tracksScrollRef,
	headerRef,
	snappingEnabled,
	onSnapPointChange,
}: UseElementInteractionProps) {
	const editor = useEditor();
	const isShiftHeldRef = useShiftKey();
	const selection = useElementSelection();

	const deps: ElementInteractionDeps = {
		viewport: {
			getZoomLevel: () => zoomLevel,
			getTracksScrollEl: () => tracksScrollRef.current,
			getTracksContainerEl: () => tracksContainerRef.current,
			getHeaderEl: () => headerRef?.current ?? null,
		},
		input: {
			isShiftHeld: () => isShiftHeldRef.current,
		},
		scene: {
			getTracks: () => editor.scenes.getActiveScene().tracks,
			getBookmarks: () => editor.scenes.getActiveScene()?.bookmarks ?? [],
			getActiveFps: () => editor.project.getActive()?.settings.fps ?? null,
		},
		selection: {
			// Read the LIVE selection manager, not the React snapshot. The snapshot
			// (useElementSelection -> useSyncExternalStore) lags within a single
			// synchronous tick, so a selection set inside a mousedown handler — e.g.
			// Track Select Forward's selectForwardFrom — is not yet visible when the
			// move controller snapshots the selection to build its drag group. Reading
			// the manager directly makes select-then-drag-in-one-gesture move the whole
			// forward group, not just the clicked clip.
			getSelected: () => editor.selection.getSelectedElements(),
			isSelected: (ref) =>
				editor.selection
					.getSelectedElements()
					.some(
						(selected) =>
							selected.trackId === ref.trackId &&
							selected.elementId === ref.elementId,
					),
			select: selection.selectElement,
			selectMany: (elements) => selection.setElementSelection({ elements }),
			handleClick: selection.handleElementClick,
			clearKeyframeSelection: () => editor.selection.clearKeyframeSelection(),
		},
		playback: {
			getCurrentTime: () => editor.playback.getCurrentTime(),
		},
		timeline: {
			moveElements: (args) => editor.timeline.moveElements(args),
			// U4: single-clip overwrite/insert MOVE onto an occupied existing track.
			commitMoveOverwrite: (args) => editor.timeline.moveOverwrite(args),
			// Slip body-drag: preview/commit a trim-only patch (source window slides;
			// startTime/duration untouched), mirroring use-timeline-resize's wiring.
			previewSlip: ({ patches }) =>
				editor.timeline.previewElements({
					updates: patches.map(({ trackId, elementId, trimStart, trimEnd }) => ({
						trackId,
						elementId,
						updates: { trimStart, trimEnd },
					})),
				}),
			discardSlipPreview: () => editor.timeline.discardPreview(),
			commitSlip: ({ patches }) =>
				editor.timeline.updateElements({
					updates: patches.map(({ trackId, elementId, trimStart, trimEnd }) => ({
						trackId,
						elementId,
						patch: { trimStart, trimEnd },
					})),
				}),
			// Slide body-drag: preview/commit a full position+trim patch per element
			// (the clip's startTime + each neighbour's startTime/duration/trim). Each
			// field is optional, so only the changed ones are merged.
			previewSlide: ({ patches }) =>
				editor.timeline.previewElements({
					updates: patches.map(
						({ trackId, elementId, ...changes }) => ({
							trackId,
							elementId,
							updates: changes,
						}),
					),
				}),
			discardSlidePreview: () => editor.timeline.discardPreview(),
			commitSlide: ({ patches }) =>
				editor.timeline.updateElements({
					updates: patches.map(({ trackId, elementId, ...changes }) => ({
						trackId,
						elementId,
						patch: changes,
					})),
				}),
		},
		snap: {
			isEnabled: () => snappingEnabled,
			onChange: onSnapPointChange,
		},
	};
	const depsRef = useCommittedRef(deps) as ElementInteractionDepsRef;
	const [controller] = useState(
		() => new ElementInteractionController({ depsRef }),
	);

	const [, rerender] = useReducer((n: number) => n + 1, 0);
	useEffect(() => controller.subscribe(rerender), [controller]);

	useEffect(() => {
		if (!controller.isActive) return;
		return registerCanceller({ fn: () => controller.cancel() });
	}, [controller.isActive, controller]);

	useEffect(() => () => controller.destroy(), [controller]);

	return {
		dragView: controller.view,
		handleElementMouseDown: controller.onElementMouseDown,
		handleElementClick: controller.onElementClick,
	};
}
