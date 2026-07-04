/**
 * UI state for the timeline
 * For core logic, use EditorCore instead.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Frames the playhead jumps on Shift+←/→ (the "jump" actions) by default. */
export const DEFAULT_TIMELINE_NUDGE_FRAMES = 15;
const MIN_TIMELINE_NUDGE_FRAMES = 1;
const MAX_TIMELINE_NUDGE_FRAMES = 600;

/** Round + clamp a requested nudge to a sane whole-frame count. */
function clampNudgeFrames(frames: number): number {
	if (!Number.isFinite(frames)) return DEFAULT_TIMELINE_NUDGE_FRAMES;
	return Math.max(
		MIN_TIMELINE_NUDGE_FRAMES,
		Math.min(MAX_TIMELINE_NUDGE_FRAMES, Math.round(frames)),
	);
}

interface TimelineStore {
	snappingEnabled: boolean;
	toggleSnapping: () => void;
	rippleEditingEnabled: boolean;
	toggleRippleEditing: () => void;
	videoWaveformsEnabled: boolean;
	toggleVideoWaveforms: () => void;
	linkedSelectionEnabled: boolean;
	toggleLinkedSelection: () => void;
	/** How many frames Shift+←/→ nudges the playhead (configurable in Settings). */
	timelineNudgeFrames: number;
	setTimelineNudgeFrames: (frames: number) => void;
	expandedElementIds: Set<string>;
	toggleElementExpanded: (elementId: string) => void;
}

export const useTimelineStore = create<TimelineStore>()(
	persist(
		(set) => ({
			snappingEnabled: true,

			toggleSnapping: () => {
				set((state) => ({ snappingEnabled: !state.snappingEnabled }));
			},

			rippleEditingEnabled: false,

			toggleRippleEditing: () => {
				set((state) => ({
					rippleEditingEnabled: !state.rippleEditingEnabled,
				}));
			},

			videoWaveformsEnabled: true,

			toggleVideoWaveforms: () => {
				set((state) => ({
					videoWaveformsEnabled: !state.videoWaveformsEnabled,
				}));
			},

			linkedSelectionEnabled: true,

			toggleLinkedSelection: () => {
				set((state) => ({
					linkedSelectionEnabled: !state.linkedSelectionEnabled,
				}));
			},

			timelineNudgeFrames: DEFAULT_TIMELINE_NUDGE_FRAMES,

			setTimelineNudgeFrames: (frames) => {
				set({ timelineNudgeFrames: clampNudgeFrames(frames) });
			},

			expandedElementIds: new Set<string>(),

			toggleElementExpanded: (elementId) => {
				set((state) => {
					const next = new Set(state.expandedElementIds);
					if (next.has(elementId)) {
						next.delete(elementId);
					} else {
						next.add(elementId);
					}
					return { expandedElementIds: next };
				});
			},
		}),
		{
			name: "timeline-store",
			partialize: (state) => ({
				snappingEnabled: state.snappingEnabled,
				rippleEditingEnabled: state.rippleEditingEnabled,
				videoWaveformsEnabled: state.videoWaveformsEnabled,
				linkedSelectionEnabled: state.linkedSelectionEnabled,
				timelineNudgeFrames: state.timelineNudgeFrames,
			}),
			version: 2,
			migrate: (persisted) => {
				const p = persisted as Record<string, unknown> | null;
				// linkedSelectionEnabled was added later — default it ON for
				// older persisted stores that predate the field.
				if (p && p.linkedSelectionEnabled === undefined) {
					p.linkedSelectionEnabled = true;
				}
				// timelineNudgeFrames (v2) — default for stores that predate it.
				if (p && p.timelineNudgeFrames === undefined) {
					p.timelineNudgeFrames = DEFAULT_TIMELINE_NUDGE_FRAMES;
				}
				return p as never;
			},
		},
	),
);
