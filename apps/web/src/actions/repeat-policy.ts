/**
 * Which actions are safe to auto-repeat when a key is held down.
 *
 * Held-key auto-repeat (`KeyboardEvent.repeat`) is desirable for continuous
 * navigation — scrubbing, frame-stepping, jumping, and edit-point hopping all
 * want to keep firing while the key is down. Everything else is a one-shot or
 * a toggle (split, duplicate, undo/redo, snapping/bookmark toggles, tool
 * switches) where auto-repeat would fire the edit dozens of times per press.
 *
 * We model this as an explicit *keep-list* of repeat-safe actions rather than a
 * block-list: the safe set is small and well-understood, and the conservative
 * default for any action NOT listed here (including future actions) is to fire
 * once per physical press.
 */
const REPEAT_SAFE_ACTIONS: ReadonlySet<string> = new Set([
	"seek-forward",
	"seek-backward",
	"frame-step-forward",
	"frame-step-backward",
	"jump-forward",
	"jump-backward",
	"go-to-previous-edit",
	"go-to-next-edit",
	"nudge-selected-left",
	"nudge-selected-right",
]);

/** True when `action` should keep firing on held-key auto-repeat. */
export function isRepeatSafeAction(action: string): boolean {
	return REPEAT_SAFE_ACTIONS.has(action);
}
