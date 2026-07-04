/**
 * Self-learning v1: remembers how the user reacts to AI output and feeds
 * that back into the planners as plain-language preference notes.
 *
 * Signals captured today:
 * - HyperFrames: which native templates the user deletes vs. keeps.
 * - HyperFrames: authored (custom-generated) graphics kept vs. deleted in
 *   aggregate — these carry a unique `authored:<compId>` id per run, so they
 *   can't aggregate per-id like templates; they share one bucket instead.
 * - AI CUT: runs that get undone shortly after (treated as "too aggressive").
 *
 * Everything stays on this device (localStorage) and can be cleared in
 * Settings → AI.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

const UNDO_ATTRIBUTION_WINDOW_MS = 3 * 60 * 1000;

/** Authored HyperFrames graphics carry this templateId prefix. */
const AUTHORED_PREFIX = "authored:";

/** Which planner a set of notes is for — keeps AI-Cut noise out of the
 * graphics author brief, and vice-versa. */
export type PreferenceScope = "all" | "graphics" | "cut";

interface TemplateStat {
	placed: number;
	deleted: number;
}

interface CutStat {
	runs: number;
	undone: number;
}

/** Aggregate keep/delete for AUTHORED (custom-generated) graphics. */
interface GraphicsStat {
	placed: number;
	deleted: number;
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
	graphicsStats: GraphicsStat;
	exportDiff: ExportDiffStats;
	/** Last AI CUT run, so a quick undo can be attributed to it. */
	lastCutRun: { mode: string; at: number } | null;
	/** Timeline duration right after the last AI Cut — export compares to it. */
	lastCutSnapshot: { mode: string; at: number; durationTicks: number } | null;

	setSelfLearningEnabled: (enabled: boolean) => void;
	noteTemplatesPlaced: (templateIds: string[]) => void;
	noteTemplatesDeleted: (templateIds: string[]) => void;
	/** An authored HyperFrames graphic landed on the timeline. */
	noteGraphicsPlaced: () => void;
	noteCutRun: (mode: string, extra?: { durationTicks: number }) => void;
	noteUndo: () => void;
	/** Call when the user exports: diffs the timeline against the AI Cut. */
	noteExport: (args: { durationTicks: number }) => void;
	clearLearning: () => void;
	buildPreferenceNotes: (scope?: PreferenceScope) => string[];
}

export const usePreferenceStore = create<PreferenceState>()(
	persist(
		(set, get) => ({
			selfLearningEnabled: true,
			templateStats: {},
			cutStats: {},
			graphicsStats: { placed: 0, deleted: 0 },
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
					let authoredDeleted = 0;
					for (const id of templateIds) {
						// Authored graphics have a unique id per run — aggregate them in
						// one bucket instead of polluting templateStats with singletons.
						if (id.startsWith(AUTHORED_PREFIX)) {
							authoredDeleted++;
							continue;
						}
						const stat = templateStats[id] ?? { placed: 0, deleted: 0 };
						templateStats[id] = { ...stat, deleted: stat.deleted + 1 };
					}
					return {
						templateStats,
						graphicsStats: authoredDeleted
							? {
									...state.graphicsStats,
									deleted: state.graphicsStats.deleted + authoredDeleted,
								}
							: state.graphicsStats,
					};
				}),

			noteGraphicsPlaced: () =>
				set((state) => ({
					graphicsStats: {
						...state.graphicsStats,
						placed: state.graphicsStats.placed + 1,
					},
				})),

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
					graphicsStats: { placed: 0, deleted: 0 },
					exportDiff: { kept: 0, restored: 0, trimmedMore: 0 },
					lastCutRun: null,
					lastCutSnapshot: null,
				}),

			buildPreferenceNotes: (scope = "all") => {
				const {
					selfLearningEnabled,
					templateStats,
					cutStats,
					graphicsStats,
					exportDiff,
				} = get();
				if (!selfLearningEnabled) return [];
				// "graphics" notes guide the HyperFrames author/template planner;
				// "cut" notes guide AI CUT. "all" (settings display) gets both.
				const wantGraphics = scope === "all" || scope === "graphics";
				const wantCut = scope === "all" || scope === "cut";
				const notes: string[] = [];

				if (wantGraphics) {
					for (const [id, stat] of Object.entries(templateStats)) {
						if (stat.placed >= 2 && stat.deleted / stat.placed >= 0.5) {
							notes.push(
								`The user deleted ${stat.deleted} of the last ${stat.placed} "${id}" effects — avoid "${id}" unless it is clearly the best fit.`,
							);
						}
					}
					if (
						graphicsStats.placed >= 2 &&
						graphicsStats.deleted / graphicsStats.placed >= 0.5
					) {
						notes.push(
							`The user removed ${graphicsStats.deleted} of the last ${graphicsStats.placed} authored graphics — be more selective: add a graphic only where the transcript clearly calls for one, keep it minimal (a single clean element beats a busy multi-layer composition), and keep it short-lived.`,
						);
					}
				}

				if (wantCut) {
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
				graphicsStats: state.graphicsStats,
				exportDiff: state.exportDiff,
				lastCutSnapshot: state.lastCutSnapshot,
			}),
		},
	),
);
