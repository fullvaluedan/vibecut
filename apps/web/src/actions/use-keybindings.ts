import { useEffect } from "react";
import { invokeAction } from "@/actions";
import { useEditor } from "@/editor/use-editor";
import { useKeybindingsStore } from "@/actions/keybindings-store";
import { isAppleDevice } from "@/utils/platform";
import {
	isInteractiveDOMElement,
	isTypableDOMElement,
	shouldLetNativeCopyRun,
} from "@/utils/browser";
import { isRepeatSafeAction } from "@/actions/repeat-policy";

/**
 * A bare key has no Ctrl/Cmd/Alt/Shift held — mirrors `getActiveModifier` in
 * the keybindings store. Modifier combos still fire even when a native control
 * is focused; only bare keys defer to native activation/type-ahead.
 */
function isBareKeyEvent(ev: KeyboardEvent): boolean {
	const ctrl = isAppleDevice() ? ev.metaKey : ev.ctrlKey;
	return !ctrl && !ev.altKey && !ev.shiftKey;
}

/**
 * a composable that hooks to the caller component's
 * lifecycle and hooks to the keyboard events to fire
 * the appropriate actions based on keybindings
 */
export function useKeybindingsListener() {
	const editor = useEditor();
	const {
		keybindings,
		getKeybindingString,
		overlayDepth,
		isLoadingProject,
		isRecording,
	} = useKeybindingsStore();

	useEffect(() => {
		const eventOptions: AddEventListenerOptions = { capture: true };
		const handleKeyDown = (ev: KeyboardEvent) => {
			const normalizedKey = (ev.key ?? "").toLowerCase();

			// IME composition: keyCode 229 / isComposing means the keystroke is
			// being consumed by an input method editor — never act on it.
			if (ev.isComposing || ev.keyCode === 229) return;

			if (overlayDepth > 0 || isLoadingProject || isRecording) {
				return;
			}

			const binding = getKeybindingString(ev);
			const activeElement = document.activeElement;
			const isTextInput =
				activeElement instanceof HTMLElement &&
				isTypableDOMElement({ element: activeElement });
			const boundAction = binding ? keybindings.get(binding) : undefined;

			if (normalizedKey === "escape" && isTextInput) {
				activeElement.blur();
				return;
			}

			if (!binding) return;
			if (!boundAction) return;

			if (isTextInput) return;

			// Native-activation bail: a bare key while a natively keyboard-
			// activatable control (button/link/select/menuitem/…) is focused must
			// run the browser's own Space/Enter activation or select type-ahead.
			// Return WITHOUT preventDefault. Modifier combos still fire.
			if (
				isBareKeyEvent(ev) &&
				activeElement instanceof HTMLElement &&
				isInteractiveDOMElement(activeElement)
			) {
				return;
			}

			// Held-key auto-repeat: keep firing for continuous nav (seek / frame-
			// step / jump / edit-point hop); fire one-shot & toggle actions once
			// per physical press.
			if (ev.repeat && !isRepeatSafeAction(boundAction)) return;

			if (boundAction === "paste-copied") {
				if (!editor.clipboard.hasEntry()) return;
				ev.preventDefault();
				invokeAction("paste-copied", undefined, "keypress");
				return;
			}

			// Mirror the paste-copied empty-bail: with nothing selected on the
			// timeline, let the browser's native Ctrl+C copy page-text selections.
			if (
				shouldLetNativeCopyRun({
					boundAction,
					hasTimelineSelection:
						editor.selection.getSelectedElements().length > 0 ||
						editor.selection.getSelectedKeyframes().length > 0,
				})
			) {
				return;
			}

			// Ctrl+R (open-speed-panel) no-ops without a selected element, so only
			// preventDefault — eating the browser reload — when there IS one.
			if (
				boundAction === "open-speed-panel" &&
				editor.selection.getSelectedElements().length === 0
			) {
				return;
			}

			ev.preventDefault();

			switch (boundAction) {
				case "seek-forward":
					invokeAction("seek-forward", { seconds: 1 }, "keypress");
					break;
				case "seek-backward":
					invokeAction("seek-backward", { seconds: 1 }, "keypress");
					break;
				// jump-forward / jump-backward fall through to the default: the
				// handler reads the configurable frame nudge itself rather than a
				// fixed seconds value forced here.
				default:
					invokeAction(boundAction, undefined, "keypress");
			}
		};

		document.addEventListener("keydown", handleKeyDown, eventOptions);

		return () => {
			document.removeEventListener("keydown", handleKeyDown, eventOptions);
		};
	}, [
		keybindings,
		getKeybindingString,
		overlayDepth,
		isLoadingProject,
		isRecording,
		editor,
	]);
}
