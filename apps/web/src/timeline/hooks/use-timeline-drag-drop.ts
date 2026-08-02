import { useEffect, useReducer, useState, type RefObject } from "react";
import { useEditor } from "@/editor/use-editor";
import { useCommittedRef } from "@/hooks/use-committed-ref";
import {
	DragDropController,
	type DragDropConfig,
} from "@/timeline/controllers/drag-drop-controller";
import { computeTrackExpansionHeight } from "@/timeline/components/expanded-layout";
import { useTimelineStore } from "@/timeline/timeline-store";

interface UseTimelineDragDropProps {
	containerRef: RefObject<HTMLDivElement | null>;
	headerRef?: RefObject<HTMLElement | null>;
	tracksScrollRef?: RefObject<HTMLDivElement | null>;
	zoomLevel: number;
}

export function useTimelineDragDrop({
	containerRef,
	headerRef,
	tracksScrollRef,
	zoomLevel,
}: UseTimelineDragDropProps) {
	const editor = useEditor();

	const config: DragDropConfig = {
		zoomLevel,
		getContainerEl: () => containerRef.current,
		getHeaderEl: () => headerRef?.current ?? null,
		getTracksScrollEl: () => tracksScrollRef?.current ?? null,
		getActiveProjectFps: () => editor.project.getActive()?.settings.fps ?? null,
		getActiveProjectId: () =>
			editor.project.getActiveOrNull()?.metadata.id ?? null,
		getSceneTracks: () => editor.scenes.getActiveScene().tracks,
		getCurrentPlayheadTime: () => editor.playback.getCurrentTime(),
		getMediaAssets: () => editor.media.getAssets(),
		// Read live (not through the React snapshot): the drop hit-test needs the
		// same row heights the timeline is currently drawing, expansions included.
		getExtraTrackHeight: (trackIndex) => {
			const sceneTracks = editor.scenes.getActiveScene().tracks;
			const track = [
				...sceneTracks.overlay,
				sceneTracks.main,
				...sceneTracks.audio,
			][trackIndex];
			if (!track) return 0;
			return computeTrackExpansionHeight({
				track,
				expandedElementIds: useTimelineStore.getState().expandedElementIds,
			});
		},
		dragSource: editor.timeline.dragSource,
		addMediaAsset: (args) => editor.media.addMediaAsset(args),
		executeCommand: (command) => editor.command.execute({ command }),
		insertElement: (args) => editor.timeline.insertElement(args),
		addClipEffect: (args) => editor.timeline.addClipEffect(args),
	};
	const configRef = useCommittedRef(config);
	const [controller] = useState(() => new DragDropController({ configRef }));

	const [, rerender] = useReducer((n: number) => n + 1, 0);
	useEffect(() => controller.subscribe(rerender), [controller]);
	useEffect(() => () => controller.destroy(), [controller]);

	return {
		isDragOver: controller.isDragOver,
		dropTarget: controller.dropTarget,
		dragElementType: controller.dragElementType,
		dragMode: controller.dragMode,
		dragProps: {
			onDragEnter: controller.onDragEnter,
			onDragOver: controller.onDragOver,
			onDragLeave: controller.onDragLeave,
			onDrop: controller.onDrop,
		},
	};
}
