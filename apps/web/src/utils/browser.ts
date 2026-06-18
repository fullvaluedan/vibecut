export function downloadBlob({
	blob,
	filename,
}: {
	blob: Blob;
	filename: string;
}): void {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	document.body.appendChild(anchor);
	anchor.click();
	document.body.removeChild(anchor);
	URL.revokeObjectURL(url);
}

export function findScrollParent({
	element,
}: {
	element: HTMLElement;
}): HTMLElement | null {
	let parent = element.parentElement;
	while (parent) {
		const { overflow, overflowX } = window.getComputedStyle(parent);
		if (/auto|scroll/.test(overflow + overflowX)) return parent;
		parent = parent.parentElement;
	}
	return null;
}

export function isTypableDOMElement({
	element,
}: {
	element: HTMLElement;
}): boolean {
	if (element.isContentEditable) return true;

	if (element.tagName === "INPUT") {
		return !(element as HTMLInputElement).disabled;
	}

	if (element.tagName === "TEXTAREA") {
		return !(element as HTMLTextAreaElement).disabled;
	}

	return false;
}

/**
 * Selector for elements the browser can natively keyboard-activate
 * (Space/Enter activation, select type-ahead). Bare-key shortcuts must NOT
 * `preventDefault` while one of these is focused, or they hijack native
 * affordances. Every entry excludes `tabindex="-1"`: such elements are
 * programmatically focused, not keyboard tab stops, so native activation does
 * NOT apply to them and editor shortcuts MUST keep firing. This matters because
 * the timeline clip body is a `<button tabindex="-1">` — without the exclusion,
 * a focused clip would suppress split / play / every bare-key shortcut.
 */
export const INTERACTIVE_DOM_SELECTOR = [
	'button:not([tabindex="-1"])',
	'a[href]:not([tabindex="-1"])',
	'select:not([tabindex="-1"])',
	'[role="button"]:not([tabindex="-1"])',
	'[role="menuitem"]:not([tabindex="-1"])',
	'[role="option"]:not([tabindex="-1"])',
	'[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * The minimal element surface this predicate needs. The DOM `HTMLElement`
 * satisfies it structurally, so real elements pass directly; tests can supply
 * a tiny stub instead of standing up a full DOM (bun test has none by default).
 */
export interface MatchableElement {
	matches(selectors: string): boolean;
	closest(selectors: string): unknown;
}

/**
 * True when `element` (or a `.closest(...)` ancestor) is a natively
 * keyboard-activatable control per {@link INTERACTIVE_DOM_SELECTOR}. Mirrors
 * the style of {@link isTypableDOMElement}.
 */
export function isInteractiveDOMElement(element: MatchableElement): boolean {
	if (element.matches(INTERACTIVE_DOM_SELECTOR)) return true;
	return element.closest(INTERACTIVE_DOM_SELECTOR) !== null;
}

/**
 * Decide whether a `copy-selected` keypress should fall through to the native
 * browser copy (so the user can copy selected page text) instead of running
 * the editor's clipboard copy. Mirrors the existing `paste-copied` empty-bail:
 * with nothing selected on the timeline, let the browser handle Ctrl+C.
 */
export function shouldLetNativeCopyRun({
	boundAction,
	hasTimelineSelection,
}: {
	boundAction: string;
	hasTimelineSelection: boolean;
}): boolean {
	return boundAction === "copy-selected" && !hasTimelineSelection;
}
