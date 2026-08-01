/**
 * While the transcript panel shows a local post-delete preview (stale), ANY external
 * timeline change (undo, redo, or a manual edit) desyncs the live timeline from the
 * local words/segments coordinates, so a further ripple-delete would resolve against
 * stale coords and cut the wrong footage. Detect it by comparing the live audio hash
 * against the hash captured right after the last local delete: a mismatch while stale
 * means the user must Refresh before deleting again.
 *
 * An empty `liveHash` (hash could not be computed) is treated as "no change detected"
 * so a transient read failure never blocks deletes on its own.
 *
 * T16.1 note 2 / T16.2: the hash comparison is deliberately over-strict once a
 * LINEAGE explains the live timeline. The panel then reads its words straight from
 * the lineage, so an undo, a redo, a further Director cut or a per-word restore all
 * leave the displayed coordinates CORRECT rather than stale - the very thing this
 * guard exists to catch cannot happen. `lineageExplained` short-circuits it so
 * transcript deletes keep working instead of demanding a needless Refresh. It stays
 * false (and the old guard stands) whenever the lineage is missing or cannot explain
 * the timeline, which is exactly when the local preview coordinates CAN drift.
 */
export function timelineChangedWhileStale({
	stale,
	liveHash,
	expectedHash,
	lineageExplained = false,
}: {
	stale: boolean;
	liveHash: string;
	expectedHash: string;
	/** `readTranscriptLineage().status === "explained"` for the live timeline. */
	lineageExplained?: boolean;
}): boolean {
	if (lineageExplained) return false;
	return stale && liveHash !== "" && liveHash !== expectedHash;
}
