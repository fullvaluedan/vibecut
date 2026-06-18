import { describe, expect, it } from "bun:test";
import {
	INTERACTIVE_DOM_SELECTOR,
	isInteractiveDOMElement,
	shouldLetNativeCopyRun,
} from "@/utils/browser";
import { isRepeatSafeAction } from "@/actions/repeat-policy";
import { formatKey } from "@/actions/use-keyboard-shortcuts-help";

/**
 * `isInteractiveDOMElement` composes `element.matches(sel) || element.closest(sel)`.
 * bun test has no DOM, so we stub those two calls to test the COMPOSITION. The
 * selector string's `:not([tabindex="-1"])` semantics — a focused clip body
 * (`<button tabindex="-1">`) must NOT count as interactive, so bare-key editor
 * shortcuts keep firing — are CSS-level and live-verified (docs/TO-VERIFY.md),
 * not reproducible without a real DOM; the selector-shape test below guards them.
 */
function makeElementStub({
	selfMatches,
	ancestorMatches = false,
}: {
	selfMatches: boolean;
	ancestorMatches?: boolean;
}): { matches(sel: string): boolean; closest(sel: string): unknown } {
	return {
		matches: () => selfMatches,
		closest: () => (selfMatches || ancestorMatches ? {} : null),
	};
}

describe("isInteractiveDOMElement", () => {
	it("is true when the focused element itself matches the interactive selector", () => {
		expect(isInteractiveDOMElement(makeElementStub({ selfMatches: true }))).toBe(
			true,
		);
	});

	it("is true when an interactive ancestor matches via closest()", () => {
		expect(
			isInteractiveDOMElement(
				makeElementStub({ selfMatches: false, ancestorMatches: true }),
			),
		).toBe(true);
	});

	it("is false when neither the element nor an ancestor matches", () => {
		expect(
			isInteractiveDOMElement(makeElementStub({ selfMatches: false })),
		).toBe(false);
	});

	it("excludes tabindex=-1 from every selector entry (a focused clip keeps firing shortcuts)", () => {
		// Each activatable entry carries :not([tabindex="-1"]), so the timeline
		// clip body (<button tabindex="-1">) is NOT treated as interactive and
		// bare-key shortcuts still fire when a clip is focused. Real-DOM behavior
		// is in docs/TO-VERIFY.md.
		const entries = INTERACTIVE_DOM_SELECTOR.split(",").map((s) => s.trim());
		expect(entries.length).toBeGreaterThan(0);
		for (const entry of entries) {
			expect(entry).toContain(':not([tabindex="-1"])');
		}
	});
});

describe("shouldLetNativeCopyRun", () => {
	it("returns true for copy-selected with no timeline selection", () => {
		expect(
			shouldLetNativeCopyRun({
				boundAction: "copy-selected",
				hasTimelineSelection: false,
			}),
		).toBe(true);
	});

	it("returns false for copy-selected with a timeline selection", () => {
		expect(
			shouldLetNativeCopyRun({
				boundAction: "copy-selected",
				hasTimelineSelection: true,
			}),
		).toBe(false);
	});

	it("returns false for any other action (never blocks editor copy logic)", () => {
		expect(
			shouldLetNativeCopyRun({
				boundAction: "split",
				hasTimelineSelection: false,
			}),
		).toBe(false);
	});
});

describe("isRepeatSafeAction", () => {
	it("is true for scrub/seek/step/jump actions (auto-repeat desired)", () => {
		expect(isRepeatSafeAction("seek-forward")).toBe(true);
		expect(isRepeatSafeAction("seek-backward")).toBe(true);
		expect(isRepeatSafeAction("frame-step-forward")).toBe(true);
		expect(isRepeatSafeAction("frame-step-backward")).toBe(true);
		expect(isRepeatSafeAction("jump-forward")).toBe(true);
		expect(isRepeatSafeAction("jump-backward")).toBe(true);
		expect(isRepeatSafeAction("go-to-previous-edit")).toBe(true);
		expect(isRepeatSafeAction("go-to-next-edit")).toBe(true);
	});

	it("is false for one-shot / toggle actions", () => {
		expect(isRepeatSafeAction("split")).toBe(false);
		expect(isRepeatSafeAction("duplicate-selected")).toBe(false);
		expect(isRepeatSafeAction("undo")).toBe(false);
		expect(isRepeatSafeAction("redo")).toBe(false);
		expect(isRepeatSafeAction("toggle-snapping")).toBe(false);
		expect(isRepeatSafeAction("toggle-bookmark")).toBe(false);
		expect(isRepeatSafeAction("track-select-forward")).toBe(false);
		expect(isRepeatSafeAction("activate-selection-tool")).toBe(false);
	});
});

describe("formatKey", () => {
	it('returns "-" for the zoom-out key (no bogus + corruption)', () => {
		expect(formatKey({ key: "-" })).toBe("-");
	});

	it("still renders modifier combos with + as the separator", () => {
		// ctrl maps to the platform special key; the + separator is preserved
		const formatted = formatKey({ key: "ctrl+c" });
		expect(formatted).toContain("+");
		expect(formatted.split("+").filter(Boolean).length).toBe(2);
	});

	it("maps arrow/named keys", () => {
		expect(formatKey({ key: "left" })).toBe("←");
		expect(formatKey({ key: "space" })).toBe("Space");
		expect(formatKey({ key: "enter" })).toBe("Enter");
	});
});
