"use client";

import { useEffect, useState } from "react";
import { useTimelineStore } from "@/timeline/timeline-store";
import { useActionHandler } from "@/actions/use-action-handler";
import { CloseGapsCommand } from "@/commands/timeline/track/close-gaps";
import { RemoveRangesCommand } from "@/commands/timeline/track/remove-ranges";
import { usePropertiesStore } from "@/components/editor/panels/properties/stores/properties-store";
import { useEditor } from "@/editor/use-editor";
import { useElementSelection } from "@/timeline/hooks/element/use-element-selection";
import {
	addMediaTime,
	maxMediaTime,
	mediaTime,
	mediaTimeFromSeconds,
	minMediaTime,
	subMediaTime,
	TICKS_PER_SECOND,
	ZERO_MEDIA_TIME,
} from "@/wasm";
import { useKeyframeSelection } from "@/timeline/hooks/element/use-keyframe-selection";
import { getElementsAtTime, hasMediaId } from "@/timeline";
import { cancelInteraction } from "@/editor/cancel-interaction";
import { invokeAction } from "@/actions";
import { toast } from "sonner";
import { useGapSelectionStore } from "@/timeline/gap-selection-store";
import { usePlaceToolStore } from "@/preview/place-tool-store";
import { usePreferenceStore } from "@/features/ai-generate/preference-store";
import { canToggleSourceAudio } from "@/timeline/audio-separation";
import {
	activateScope,
	clearActiveScope,
	type ScopeEntry,
} from "@/selection/scope";
import { useCommittedRef } from "@/hooks/use-committed-ref";

export function useEditorActions() {
	const editor = useEditor();
	const { selectedElements, setElementSelection } = useElementSelection();
	const { selectedKeyframes, clearKeyframeSelection } = useKeyframeSelection();
	const selectedMaskPointSelection = useEditor((e) =>
		e.selection.getSelectedMaskPointSelection(),
	);
	const toggleSnapping = useTimelineStore((s) => s.toggleSnapping);
	const rippleEditingEnabled = useTimelineStore((s) => s.rippleEditingEnabled);
	const toggleRippleEditing = useTimelineStore((s) => s.toggleRippleEditing);
	const hasTimelineSelection =
		selectedElements.length > 0 ||
		selectedKeyframes.length > 0 ||
		selectedMaskPointSelection !== null;
	const hasTimelineSelectionRef = useCommittedRef(hasTimelineSelection);
	const clearTimelineSelectionRef = useCommittedRef(() => {
		editor.selection.clearSelection();
	});
	const clearTimelineActiveSelectionRef = useCommittedRef(() => {
		editor.selection.clearMostSpecificSelection();
	});
	const [timelineScope] = useState<ScopeEntry>(() => ({
		hasSelection: () => hasTimelineSelectionRef.current,
		clear: () => {
			clearTimelineSelectionRef.current();
		},
		clearActive: () => {
			clearTimelineActiveSelectionRef.current();
		},
	}));

	useEffect(() => {
		if (!hasTimelineSelection) {
			return;
		}

		return activateScope({ entry: timelineScope });
	}, [hasTimelineSelection, timelineScope]);

	useActionHandler(
		"toggle-play",
		() => {
			editor.playback.toggle();
		},
		undefined,
	);

	useActionHandler(
		"stop-playback",
		() => {
			if (editor.playback.getIsPlaying()) {
				editor.playback.toggle();
			}
			editor.playback.seek({ time: ZERO_MEDIA_TIME });
		},
		undefined,
	);

	useActionHandler(
		"seek-forward",
		(args) => {
			const seconds = args?.seconds ?? 1;
			const delta = mediaTimeFromSeconds({ seconds });
			editor.playback.seek({
				time: minMediaTime({
					a: editor.timeline.getTotalDuration(),
					b: addMediaTime({
						a: editor.playback.getCurrentTime(),
						b: delta,
					}),
				}),
			});
		},
		undefined,
	);

	useActionHandler(
		"seek-backward",
		(args) => {
			const seconds = args?.seconds ?? 1;
			const delta = mediaTimeFromSeconds({ seconds });
			editor.playback.seek({
				time: maxMediaTime({
					a: ZERO_MEDIA_TIME,
					b: subMediaTime({
						a: editor.playback.getCurrentTime(),
						b: delta,
					}),
				}),
			});
		},
		undefined,
	);

	useActionHandler(
		"frame-step-forward",
		() => {
			const fps = editor.project.getActive().settings.fps;
			const ticksPerFrame = mediaTime({
				ticks: Math.round(
					(TICKS_PER_SECOND * fps.denominator) / fps.numerator,
				),
			});
			editor.playback.seek({
				time: minMediaTime({
					a: editor.timeline.getTotalDuration(),
					b: addMediaTime({
						a: editor.playback.getCurrentTime(),
						b: ticksPerFrame,
					}),
				}),
			});
		},
		undefined,
	);

	useActionHandler(
		"frame-step-backward",
		() => {
			const fps = editor.project.getActive().settings.fps;
			const ticksPerFrame = mediaTime({
				ticks: Math.round(
					(TICKS_PER_SECOND * fps.denominator) / fps.numerator,
				),
			});
			editor.playback.seek({
				time: maxMediaTime({
					a: ZERO_MEDIA_TIME,
					b: subMediaTime({
						a: editor.playback.getCurrentTime(),
						b: ticksPerFrame,
					}),
				}),
			});
		},
		undefined,
	);

	useActionHandler(
		"jump-forward",
		(args) => {
			const seconds = args?.seconds ?? 5;
			const delta = mediaTimeFromSeconds({ seconds });
			editor.playback.seek({
				time: minMediaTime({
					a: editor.timeline.getTotalDuration(),
					b: addMediaTime({
						a: editor.playback.getCurrentTime(),
						b: delta,
					}),
				}),
			});
		},
		undefined,
	);

	useActionHandler(
		"jump-backward",
		(args) => {
			const seconds = args?.seconds ?? 5;
			const delta = mediaTimeFromSeconds({ seconds });
			editor.playback.seek({
				time: maxMediaTime({
					a: ZERO_MEDIA_TIME,
					b: subMediaTime({
						a: editor.playback.getCurrentTime(),
						b: delta,
					}),
				}),
			});
		},
		undefined,
	);

	useActionHandler(
		"goto-start",
		() => {
			editor.playback.seek({ time: ZERO_MEDIA_TIME });
		},
		undefined,
	);

	useActionHandler(
		"goto-end",
		() => {
			editor.playback.seek({ time: editor.timeline.getTotalDuration() });
		},
		undefined,
	);

	useActionHandler(
		"split",
		() => {
			const currentTime = editor.playback.getCurrentTime();
			const tracks = editor.scenes.getActiveScene().tracks;
			const elementsToSplit =
				selectedElements.length > 0
					? selectedElements
					: getElementsAtTime({
							tracks,
							time: currentTime,
						});

			if (elementsToSplit.length === 0) return;

			editor.timeline.splitElements({
				elements: elementsToSplit,
				splitTime: currentTime,
			});
		},
		undefined,
	);

	// Premiere's Q/W: ripple trim from the previous/next edit point to the
	// playhead — removes that span on every track and pulls later clips left.
	const collectEditPoints = (): number[] => {
		const tracks = editor.scenes.getActiveScene().tracks;
		const points = new Set<number>([0]);
		for (const track of [tracks.main, ...tracks.overlay, ...tracks.audio]) {
			for (const element of track.elements) {
				points.add(element.startTime);
				points.add(element.startTime + element.duration);
			}
		}
		return [...points].sort((a, b) => a - b);
	};
	const rippleTrimToPlayhead = (direction: "previous" | "next") => {
		const now = editor.playback.getCurrentTime();
		const points = collectEditPoints();
		const EPSILON = 2;
		const boundary =
			direction === "previous"
				? [...points].reverse().find((t) => t < now - EPSILON)
				: points.find((t) => t > now + EPSILON);
		if (boundary === undefined) return;
		const range =
			direction === "previous"
				? { start: boundary, end: now as number }
				: { start: now as number, end: boundary };
		if (range.end - range.start <= EPSILON) return;
		editor.command.execute({
			command: new RemoveRangesCommand({ ranges: [range] }),
		});
		if (direction === "previous") {
			editor.playback.seek({ time: range.start as typeof now });
		}
	};
	useActionHandler("split-left", () => rippleTrimToPlayhead("previous"), undefined);
	useActionHandler("split-right", () => rippleTrimToPlayhead("next"), undefined);

	useActionHandler(
		"delete-selected",
		() => {
			// A selected gap (clicked between two clips) ripple-deletes first.
			if (rippleDeleteSelectedGap()) return;
			// With nothing selected, Delete closes the timeline gap under the
			// playhead (click a gap to park the playhead there, then Delete).
			const closeGapAtPlayhead = () => {
				const command = new CloseGapsCommand({
					scope: "at-time",
					time: editor.playback.getCurrentTime(),
				});
				editor.command.execute({ command });
			};
			switch (editor.selection.getActiveSelectionKind()) {
				case "mask-points":
					if (!selectedMaskPointSelection) {
						return;
					}
					editor.timeline.deleteFreeformPathMaskPoints({
						trackId: selectedMaskPointSelection.trackId,
						elementId: selectedMaskPointSelection.elementId,
						maskId: selectedMaskPointSelection.maskId,
						pointIds: selectedMaskPointSelection.pointIds,
					});
					return;
				case "keyframes":
					if (selectedKeyframes.length === 0) {
						return;
					}
					editor.timeline.removeKeyframes({ keyframes: selectedKeyframes });
					clearKeyframeSelection();
					return;
				case "elements":
					if (selectedElements.length === 0) {
						closeGapAtPlayhead();
						return;
					}
					// Self-learning: deleting AI effects is a "didn't like it"
					// signal for those templates.
					usePreferenceStore.getState().noteTemplatesDeleted(
						editor.timeline
							.getElementsWithTracks({ elements: selectedElements })
							.flatMap(({ element }) =>
								element.type === "video" && element.framecutAi
									? [element.framecutAi.templateId]
									: [],
							),
					);
					editor.timeline.deleteElements({
						elements: selectedElements,
					});
					return;
				default:
					closeGapAtPlayhead();
					return;
			}
		},
		undefined,
	);

	useActionHandler(
		"toggle-source-audio",
		() => {
			if (selectedElements.length !== 1) {
				return;
			}

			const selectedElement = editor.timeline.getElementsWithTracks({
				elements: selectedElements,
			})[0];
			if (!selectedElement) {
				return;
			}

			const mediaAsset = (() => {
				const { element } = selectedElement;
				if (!hasMediaId(element)) {
					return null;
				}

				return (
					editor.media
						.getAssets()
						.find((asset) => asset.id === element.mediaId) ?? null
				);
			})();
			if (!canToggleSourceAudio(selectedElement.element, mediaAsset)) {
				return;
			}

			editor.timeline.toggleSourceAudioSeparation({
				trackId: selectedElement.track.id,
				elementId: selectedElement.element.id,
			});
		},
		undefined,
	);

	useActionHandler(
		"select-all",
		() => {
			const scene = editor.scenes.getActiveScene();
			const allElements = [
				...scene.tracks.overlay,
				scene.tracks.main,
				...scene.tracks.audio,
			].flatMap((track) =>
				track.elements.map((element) => ({
					trackId: track.id,
					elementId: element.id,
				})),
			);
			setElementSelection({ elements: allElements });
		},
		undefined,
	);

	useActionHandler(
		"cancel-interaction",
		() => {
			// Escape clears a selected gap and disarms the forward-select tool
			// before falling through to the usual cancel/deselect chain.
			const gapStore = useGapSelectionStore.getState();
			if (gapStore.gap) {
				gapStore.setGap(null);
				return;
			}
			const toolStore = usePlaceToolStore.getState();
			if (toolStore.tool?.kind === "track-select-forward") {
				toolStore.setTool(null);
				return;
			}
			if (!cancelInteraction()) {
				invokeAction("deselect-all");
			}
		},
		undefined,
	);

	useActionHandler(
		"deselect-all",
		() => {
			if (!clearActiveScope()) {
				editor.selection.clearMostSpecificSelection();
			}
		},
		undefined,
	);

	useActionHandler(
		"duplicate-selected",
		() => {
			editor.timeline.duplicateElements({
				elements: selectedElements,
			});
		},
		undefined,
	);

	useActionHandler(
		"toggle-elements-muted-selected",
		() => {
			editor.timeline.toggleElementsMuted({ elements: selectedElements });
		},
		undefined,
	);

	useActionHandler(
		"toggle-elements-visibility-selected",
		() => {
			editor.timeline.toggleElementsVisibility({ elements: selectedElements });
		},
		undefined,
	);

	useActionHandler(
		"toggle-bookmark",
		() => {
			editor.scenes.toggleBookmark({ time: editor.playback.getCurrentTime() });
		},
		undefined,
	);

	// Premiere's Up/Down: jump the playhead between edit points (every clip
	// boundary on every track).
	const goToEdit = (direction: "prev" | "next") => {
		const tracks = editor.scenes.getActiveScene().tracks;
		const points = new Set<number>([0]);
		for (const track of [tracks.main, ...tracks.overlay, ...tracks.audio]) {
			for (const element of track.elements) {
				points.add(element.startTime);
				points.add(element.startTime + element.duration);
			}
		}
		const sorted = [...points].sort((a, b) => a - b);
		const now = editor.playback.getCurrentTime();
		const EPSILON_TICKS = 2;
		const target =
			direction === "next"
				? sorted.find((t) => t > now + EPSILON_TICKS)
				: [...sorted].reverse().find((t) => t < now - EPSILON_TICKS);
		if (target !== undefined) {
			editor.playback.seek({ time: target as typeof now });
		}
	};
	useActionHandler("go-to-previous-edit", () => goToEdit("prev"), undefined);
	useActionHandler("go-to-next-edit", () => goToEdit("next"), undefined);

	// Premiere gap ripple delete: with a gap selected, Delete removes the
	// gap's span on every track — unless clips on another track overlap the
	// span, in which case it's blocked (exactly Premiere's rule).
	const rippleDeleteSelectedGap = (): boolean => {
		const { gap, setGap } = useGapSelectionStore.getState();
		if (!gap || selectedElements.length > 0) return false;
		const tracks = editor.scenes.getActiveScene().tracks;
		const blocking = [tracks.main, ...tracks.overlay, ...tracks.audio]
			.filter((track) => track.id !== gap.trackId)
			.flatMap((track) =>
				track.elements.filter(
					(el) =>
						(el.startTime as number) < gap.end &&
						el.startTime + el.duration > gap.start,
				),
			);
		if (blocking.length > 0) {
			toast.error("Ripple delete blocked", {
				description:
					"A clip on another track overlaps this gap (Premiere blocks this too). Use Close Gaps to close what's common to all tracks.",
			});
			return true;
		}
		editor.command.execute({
			command: new RemoveRangesCommand({
				ranges: [{ start: gap.start, end: gap.end }],
			}),
		});
		setGap(null);
		return true;
	};

	// Premiere Shift+Delete: remove the selection's time span on every track
	// and pull everything after it left — one undo step.
	useActionHandler(
		"ripple-delete",
		() => {
			if (rippleDeleteSelectedGap()) return;
			if (selectedElements.length === 0) return;
			const withTracks = editor.timeline.getElementsWithTracks({
				elements: selectedElements,
			});
			// Scope each ripple to the selected clip's OWN track. Without this, the
			// cut span was extracted from every track — so ripple-deleting an
			// overlay/HyperFrames block sliced out the footage beneath it. A
			// linked A/V pair selects both halves, so both their tracks ripple.
			const ranges = withTracks.map(({ element, track }) => ({
				start: element.startTime as number,
				end: (element.startTime + element.duration) as number,
				trackId: track.id,
			}));
			if (!ranges.length) return;
			editor.command.execute({
				command: new RemoveRangesCommand({ ranges }),
			});
		},
		undefined,
	);

	// Premiere D: select the clip(s) under the playhead. Unlike split, the
	// playhead parked on a clip's first frame counts as "on" that clip.
	useActionHandler(
		"select-clip-at-playhead",
		() => {
			const now = editor.playback.getCurrentTime();
			const tracks = editor.scenes.getActiveScene().tracks;
			const hits = [tracks.main, ...tracks.overlay, ...tracks.audio].flatMap(
				(track) =>
					track.elements
						.filter(
							(el) => now >= el.startTime && now < el.startTime + el.duration,
						)
						.map((el) => ({ trackId: track.id, elementId: el.id })),
			);
			if (hits.length) {
				editor.selection.setSelectedElements({ elements: hits });
			}
		},
		undefined,
	);

	// Premiere A: arms the Track Select Forward TOOL — click the timeline to
	// select everything to the right (Shift+click = single track). Pressing A
	// again (or Escape) returns to the selection tool.
	useActionHandler(
		"track-select-forward",
		() => {
			const { tool, setTool } = usePlaceToolStore.getState();
			setTool(
				tool?.kind === "track-select-forward"
					? null
					: { kind: "track-select-forward" },
			);
		},
		undefined,
	);

	// Premiere V: the Selection (arrow) tool — clears any armed place tool so
	// the default move/trim cursor is active.
	useActionHandler(
		"activate-selection-tool",
		() => {
			usePlaceToolStore.getState().setTool(null);
		},
		undefined,
	);

	// Premiere Ctrl/Cmd+R: jump to the Speed panel for the selection.
	useActionHandler(
		"open-speed-panel",
		() => {
			const first = editor.timeline.getElementsWithTracks({
				elements: selectedElements,
			})[0];
			if (!first) return;
			usePropertiesStore
				.getState()
				.setActiveTab({ elementType: first.element.type, tabId: "speed" });
		},
		undefined,
	);

	useActionHandler(
		"copy-selected",
		() => {
			editor.clipboard.copy();
		},
		undefined,
	);

	useActionHandler(
		"paste-copied",
		() => {
			editor.clipboard.paste();
		},
		undefined,
	);

	useActionHandler(
		"toggle-snapping",
		() => {
			toggleSnapping();
		},
		undefined,
	);

	useActionHandler(
		"toggle-ripple-editing",
		() => {
			toggleRippleEditing();
		},
		undefined,
	);

	useActionHandler(
		"undo",
		() => {
			// Self-learning: undoing right after an AI CUT pass means it was
			// too aggressive — remember that.
			usePreferenceStore.getState().noteUndo();
			editor.command.undo();
		},
		undefined,
	);

	useActionHandler(
		"redo",
		() => {
			editor.command.redo();
		},
		undefined,
	);

	// todo: potnetially unify these two actions:
	useActionHandler(
		"remove-media-asset",
		(args) => {
			if (!args) return;
			editor.media.removeMediaAsset({
				projectId: args.projectId,
				id: args.assetId,
			});
		},
		undefined,
	);

	useActionHandler(
		"remove-media-assets",
		(args) => {
			if (!args) return;
			editor.media.removeMediaAssets({
				projectId: args.projectId,
				ids: args.assetIds,
			});
		},
		undefined,
	);
}
