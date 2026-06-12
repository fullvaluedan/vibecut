/**
 * Self-learning v1: remembers how the user reacts to AI output and feeds
 * that back into the planners as plain-language preference notes.
 *
 * Signals captured today:
 * - HyperFrames: which templates the user deletes vs. keeps on the timeline.
 * - AI CUT: runs that get undone shortly after (treated as "too aggressive").
 *
 * Everything stays on this device (localStorage) and can be cleared in
 * Settings → AI.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

const UNDO_ATTRIBUTION_WINDOW_MS = 3 * 60 * 1000;

interface TemplateStat {
	placed: number;
	deleted: number;
}

interface CutStat {
	runs: number;
	undone: number;
}

/** What the user did between an AI Cut and hitting Export. */
interface ExportDiffStats {
	/** Exported at ~the AI Cut's duration: the edit was accepted as-is. */
	kept: number;
	/** Exported meaningfully LONGER: the user put content back. */
	restored: number;
	/** Exported meaningfully SHORTER: the user cut even more. */
	trimmedMore: number;
}

interface PreferenceState {
	selfLearningEnabled: boolean;
	templateStats: Record<string, TemplateStat>;
	cutStats: Record<string, CutStat>;
	exportDiff: ExportDiffStats;
	/** Last AI CUT run, so a quick undo can be attributed to it. */
	lastCutRun: { mode: string; at: number } | null;
	/** Timeline duration right after the last AI Cut — export compares to it. */
	lastCutSnapshot: { mode: string; at: number; durationTicks: number } | null;

	setSelfLearningEnabled: (enabled: boolean) => void;
	noteTemplatesPlaced: (templateIds: string[]) => void;
	noteTemplatesDeleted: (templateIds: string[]) => void;
	noteCutRun: (mode: string, extra?: { durationTicks: number }) => void;
	noteUndo: () => void;
	/** Call when the user exports: diffs the timeline against the AI Cut. */
	noteExport: (args: { durationTicks: number }) => void;
	clearLearning: () => void;
	buildPreferenceNotes: () => string[];
}

export const usePreferenceStore = create<PreferenceState>()(
	persist(
		(set, get) => ({
			selfLearningEnabled: true,
			templateStats: {},
			cutStats: {},
			exportDiff: { kept: 0, restored: 0, trimmedMore: 0 },
			lastCutRun: null,
			lastCutSnapshot: null,

			setSelfLearningEnabled: (enabled) =>
				set({ selfLearningEnabled: enabled }),

			noteTemplatesPlaced: (templateIds) =>
				set((state) => {
					const templateStats = { ...state.templateStats };
					for (const id of templateIds) {
						const stat = templateStats[id] ?? { placed: 0, deleted: 0 };
						templateStats[id] = { ...stat, placed: stat.placed + 1 };
					}
					return { templateStats };
				}),

			noteTemplatesDeleted: (templateIds) =>
				set((state) => {
					const templateStats = { ...state.templateStats };
					for (const id of templateIds) {
						const stat = templateStats[id] ?? { placed: 0, deleted: 0 };
						templateStats[id] = { ...stat, deleted: stat.deleted + 1 };
					}
					return { templateStats };
				}),

			noteCutRun: (mode, extra) =>
				set((state) => {
					const stat = state.cutStats[mode] ?? { runs: 0, undone: 0 };
					return {
						cutStats: { ...state.cutStats, [mode]: { ...stat, runs: stat.runs + 1 } },
						lastCutRun: { mode, at: Date.now() },
						...(extra
							? {
									lastCutSnapshot: {
										mode,
										at: Date.now(),
										durationTicks: extra.durationTicks,
									},
								}
							: {}),
					};
				}),

			noteUndo: () => {
				const { lastCutRun, cutStats } = get();
				if (!lastCutRun) return;
				if (Date.now() - lastCutRun.at > UNDO_ATTRIBUTION_WINDOW_MS) {
					set({ lastCutRun: null });
					return;
				}
				const stat = cutStats[lastCutRun.mode] ?? { runs: 0, undone: 0 };
				set({
					cutStats: {
						...cutStats,
						[lastCutRun.mode]: { ...stat, undone: stat.undone + 1 },
					},
					lastCutRun: null,
					// An undone AI Cut is no baseline for the export diff.
					lastCutSnapshot: null,
				});
			},

			noteExport: ({ durationTicks }) => {
				const { lastCutSnapshot, exportDiff } = get();
				if (!lastCutSnapshot || lastCutSnapshot.durationTicks <= 0) return;
				const ratio = durationTicks / lastCutSnapshot.durationTicks;
				const bucket: keyof ExportDiffStats =
					ratio > 1.03 ? "restored" : ratio < 0.97 ? "trimmedMore" : "kept";
				set({
					exportDiff: { ...exportDiff, [bucket]: exportDiff[bucket] + 1 },
					lastCutSnapshot: null,
				});
			},

			clearLearning: () =>
				set({
					templateStats: {},
					cutStats: {},
					exportDiff: { kept: 0, restored: 0, trimmedMore: 0 },
					lastCutRun: null,
					lastCutSnapshot: null,
				}),

			buildPreferenceNotes: () => {
				const { selfLearningEnabled, templateStats, cutStats, exportDiff } =
					get();
				if (!selfLearningEnabled) return [];
				const notes: string[] = [];
				for (const [id, stat] of Object.entries(templateStats)) {
					if (stat.placed >= 2 && stat.deleted / stat.placed >= 0.5) {
						notes.push(
							`The user deleted ${stat.deleted} of the last ${stat.placed} "${id}" effects — avoid "${id}" unless it is clearly the best fit.`,
						);
					}
				}
				for (const [mode, stat] of Object.entries(cutStats)) {
					if (stat.runs >= 2 && stat.undone / stat.runs >= 0.5) {
						notes.push(
							`The user undid ${stat.undone} of ${stat.runs} recent "${mode}" passes — cut noticeably more conservatively.`,
						);
					}
				}
				const diffTotal =
					exportDiff.kept + exportDiff.restored + exportDiff.trimmedMore;
				if (diffTotal >= 2) {
					if (exportDiff.restored / diffTotal >= 0.5) {
						notes.push(
							`Before exporting, the user usually puts back some of what AI Cut removed (${exportDiff.restored} of ${diffTotal} exports) — cut more conservatively.`,
						);
					} else if (exportDiff.trimmedMore / diffTotal >= 0.5) {
						notes.push(
							`Before exporting, the user usually trims even more than AI Cut did (${exportDiff.trimmedMore} of ${diffTotal} exports) — cut more aggressively.`,
						);
					}
				}
				return notes;
			},
		}),
		{
			name: "vibecut-preferences",
			partialize: (state) => ({
				selfLearningEnabled: state.selfLearningEnabled,
				templateStats: state.templateStats,
				cutStats: state.cutStats,
				exportDiff: state.exportDiff,
				lastCutSnapshot: state.lastCutSnapshot,
			}),
		},
	),
);
