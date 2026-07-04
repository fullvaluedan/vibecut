/**
 * Global gesture cursor — pins `document.body`'s cursor (and disables text
 * selection) for the lifetime of a timeline drag/resize gesture, then
 * restores both. The drag/resize listeners live on `document`, so the pointer
 * routinely leaves the clip rect mid-gesture; without pinning the body cursor
 * it flickers to whatever element sits under the pointer. Restoring on EVERY
 * gesture-end path (commit, cancel, threshold-abort, destroy) is essential —
 * a missed restore leaves the cursor stuck globally.
 *
 * The save/restore pattern mirrors `use-box-select.ts` and
 * `number-field.tsx`, which capture the previous value and put it back.
 */
export type GestureCursor = "grabbing" | "ew-resize";

export interface GestureCursorLock {
	/** Restore the body cursor + user-select. Safe to call more than once. */
	release: () => void;
}

export function lockGestureCursor({
	cursor,
}: {
	cursor: GestureCursor;
}): GestureCursorLock {
	const previousCursor = document.body.style.cursor;
	const previousUserSelect = document.body.style.userSelect;

	document.body.style.cursor = cursor;
	document.body.style.userSelect = "none";

	let released = false;
	return {
		release: () => {
			if (released) return;
			released = true;
			document.body.style.cursor = previousCursor;
			document.body.style.userSelect = previousUserSelect;
		},
	};
}
