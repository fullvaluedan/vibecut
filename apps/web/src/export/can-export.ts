/**
 * Pure export-gate decision (U8).
 *
 * `editor.project.export()` returns `{ success: false, error: "Project is empty" }`
 * for a 0-duration timeline — but only AFTER `pickSaveLocation` has already
 * prompted the user for a save destination. Reading the timeline duration up
 * front lets the UI disable Export (and short-circuit handleExport) BEFORE the
 * save dialog, so an empty project fails immediately with a clear message.
 *
 * `durationTicks` is the integer-tick total from `editor.timeline.getTotalDuration()`.
 */
export function canExport({ durationTicks }: { durationTicks: number }): boolean {
	return durationTicks > 0;
}
