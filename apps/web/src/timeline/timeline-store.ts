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
	/**
	 * Magnetic main track (CapCut's core timeline behavior), default ON. Only
	 * main-track clips and their linked partners auto-move. Ripple editing is a
	 * cross-track superset, so when both are on the ripple path wins and the
	 * magnet path is skipped (see `timeline/magnet.ts`).
	 */
	mainTrackMagnetEnabled: boolean;
	toggleMainTrackMagnet: () => void;
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

			mainTrackMagnetEnabled: true,

			toggleMainTrackMagnet: () => {
				set((state) => ({
					mainTrackMagnetEnabled: !state.mainTrackMagnetEnabled,
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
				mainTrackMagnetEnabled: state.mainTrackMagnetEnabled,
				videoWaveformsEnabled: state.videoWaveformsEnabled,
				linkedSelectionEnabled: state.linkedSelectionEnabled,
				timelineNudgeFrames: state.timelineNudgeFrames,
			}),
			version: 3,
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
				// mainTrackMagnetEnabled (v3): existing projects open with the
				// magnet ON (Dan, 2026-08-01). Safe with no data migration: the
				// magnet only affects FUTURE edits, it never reflows a saved
				// layout by itself, and the toggle is one click away.
				if (p && p.mainTrackMagnetEnabled === undefined) {
					p.mainTrackMagnetEnabled = true;
				}
				return p as never;
			},
		},
	),
);
