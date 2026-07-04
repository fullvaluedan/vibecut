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
 */
export function timelineChangedWhileStale({
	stale,
	liveHash,
	expectedHash,
}: {
	stale: boolean;
	liveHash: string;
	expectedHash: string;
}): boolean {
	return stale && liveHash !== "" && liveHash !== expectedHash;
}
