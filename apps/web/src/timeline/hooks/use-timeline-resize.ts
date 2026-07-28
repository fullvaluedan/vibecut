import { useEffect, useReducer, useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { useCommittedRef } from "@/hooks/use-committed-ref";
import { useShiftKey } from "@/hooks/use-shift-key";
import { useTimelineStore } from "@/timeline/timeline-store";
import { registerCanceller } from "@/editor/cancel-interaction";
import {
	ResizeController,
	type ResizeConfig,
} from "@/timeline/controllers/resize-controller";
import type { GroupResizeUpdate, ResizeSide } from "@/timeline/group-resize";
import { computeRippleTrimShifts } from "@/timeline/ripple-trim";
import { BatchCommand } from "@/commands";
import { UpdateElementsCommand } from "@/commands/timeline";
import { RippleShiftElementsCommand } from "@/commands/timeline/element/ripple-shift-elements";
import type { SnapPoint } from "@/timeline/snapping";
import type { TimelineElement } from "@/timeline";

export type { ResizeSide };

function toElementUpdates(updates: GroupResizeUpdate[]) {
	return updates.map(({ trackId, elementId, patch }) => ({
		trackId,
		elementId,
		patch: patch as Partial<TimelineElement>,
	}));
}

interface UseTimelineResizeProps {
	zoomLevel: number;
	onSnapPointChange?: (snapPoint: SnapPoint | null) => void;
}

export function useTimelineResize({
	zoomLevel,
	onSnapPointChange,
}: UseTimelineResizeProps) {
	const editor = useEditor();
	const isShiftHeldRef = useShiftKey();
	const snappingEnabled = useTimelineStore((state) => state.snappingEnabled);

	const config: ResizeConfig = {
		zoomLevel,
		snappingEnabled,
		isShiftHeld: () => isShiftHeldRef.current,
		getSceneTracks: () => editor.scenes.getActiveScene().tracks,
		getCurrentPlayheadTime: () => editor.playback.getCurrentTime(),
		getActiveProjectFps: () => editor.project.getActive()?.settings.fps ?? null,
		discardPreview: () => editor.timeline.discardPreview(),
		previewElements: (updates) =>
			editor.timeline.previewElements({
				updates: updates.map(({ trackId, elementId, patch }) => ({
					trackId,
					elementId,
					updates: patch as Partial<TimelineElement>,
				})),
			}),
		commitElements: (updates, ripple) => {
			if (!ripple) {
				editor.timeline.updateElements({
					updates: toElementUpdates(updates),
				});
				return;
			}
			// Cross-track ripple trim (Dan's fork): ONE BatchCommand carrying the
			// resize plus an explicit shift of every downstream element on ALL
			// tracks (one undo). The command manager's per-track ripple heuristic
			// is suppressed for this commit: the batch already contains the whole
			// ripple, and the heuristic would re-shift gapped clips a second time.
			const shifts = computeRippleTrimShifts({
				tracks: editor.scenes.getActiveScene().tracks,
				pivotTime: ripple.pivotTime,
				deltaTime: ripple.deltaTime,
				excludeElementIds: ripple.excludeElementIds,
			});
			const resizeCommand = new UpdateElementsCommand({
				updates: toElementUpdates(updates),
			});
			const command =
				shifts.length > 0
					? new BatchCommand([
							resizeCommand,
							new RippleShiftElementsCommand({ shifts }),
						])
					: resizeCommand;
			editor.command.execute({ command, suppressRipple: true });
		},
		onSnapPointChange,
	};
	const configRef = useCommittedRef(config);
	const [controller] = useState(() => new ResizeController({ configRef }));

	const [, rerender] = useReducer((n: number) => n + 1, 0);
	useEffect(() => controller.subscribe(rerender), [controller]);

	useEffect(() => {
		if (!controller.isResizing) return;
		return registerCanceller({ fn: () => controller.cancel() });
	}, [controller.isResizing, controller]);

	useEffect(() => () => controller.destroy(), [controller]);

	return {
		isResizing: controller.isResizing,
		handleResizeStart: controller.onResizeStart,
	};
}
