import { describe, expect, test } from "bun:test";
import {
	INITIAL_DRAFT_STATE,
	cancelDraft,
	changeDraft,
	commitDraft,
	focusDraft,
	resolveDraftDisplayValue,
	type DraftState,
} from "@/components/editor/panels/properties/hooks/use-property-draft";

/**
 * These are the pure state transitions usePropertyDraft's useState wraps
 * (this repo's `bun test` has no DOM, so the hook itself can't be rendered
 * directly, see MEMORY/hooks convention in use-visible-clips.test.ts).
 * W6 R2: Enter commits the typed draft; Escape reverts to the pre-edit
 * value WITHOUT committing. These tests exercise both key paths end to end
 * through the same transitions the NumberField wiring calls.
 */

describe("resolveDraftDisplayValue", () => {
	test("not editing: shows the live source value", () => {
		const shown = resolveDraftDisplayValue({
			state: INITIAL_DRAFT_STATE,
			sourceDisplay: "45.0",
		});
		expect(shown).toBe("45.0");
	});

	test("editing: shows the in-progress draft, not the source", () => {
		const state = focusDraft({ sourceDisplay: "45.0" });
		const typed = changeDraft({ state, nextValue: "9" });
		const shown = resolveDraftDisplayValue({ state: typed, sourceDisplay: "45.0" });
		expect(shown).toBe("9");
	});
});

describe("Enter key path (commit)", () => {
	test("keeps the typed value and exits editing (caller commits separately)", () => {
		let state: DraftState = focusDraft({ sourceDisplay: "45.0" });
		state = changeDraft({ state, nextValue: "90" });

		// Enter -> NumberField blurs -> usePropertyDraft's onBlur runs commitDraft().
		const afterEnter = commitDraft();

		expect(afterEnter).toEqual(INITIAL_DRAFT_STATE);
		expect(afterEnter.isEditing).toBe(false);
		// Once not editing, the display falls back to sourceDisplay, which by
		// then reflects the committed value (90) fed back from the parent.
		expect(resolveDraftDisplayValue({ state: afterEnter, sourceDisplay: "90" })).toBe(
			"90",
		);
	});
});

describe("Escape key path (cancel)", () => {
	test("reverts to the pre-edit display, discarding what was typed", () => {
		let state: DraftState = focusDraft({ sourceDisplay: "45.0" });
		state = changeDraft({ state, nextValue: "999" });

		const { nextState, revertDisplay } = cancelDraft({ state });

		expect(revertDisplay).toBe("45.0"); // the value captured at focus time, not "999"
		expect(nextState).toEqual(INITIAL_DRAFT_STATE);
	});

	test("mid-edit changes never leak into the reverted value even after several edits", () => {
		let state: DraftState = focusDraft({ sourceDisplay: "1.5" });
		state = changeDraft({ state, nextValue: "1.6" });
		state = changeDraft({ state, nextValue: "1.65" });
		state = changeDraft({ state, nextValue: "abc" });

		const { revertDisplay } = cancelDraft({ state });
		expect(revertDisplay).toBe("1.5");
	});

	test("cancel is distinct from commit: it never returns the typed draft", () => {
		let state: DraftState = focusDraft({ sourceDisplay: "0" });
		state = changeDraft({ state, nextValue: "500" });

		const commitResult = commitDraft();
		const { revertDisplay } = cancelDraft({ state });

		// Enter's path (commitDraft) carries no value at all; the CALLER's
		// draft.draft ("500") is what gets committed. Escape's path explicitly
		// returns the ORIGINAL value instead of the typed one.
		expect(commitResult).toEqual(INITIAL_DRAFT_STATE);
		expect(revertDisplay).not.toBe("500");
		expect(revertDisplay).toBe("0");
	});
});

describe("changeDraft", () => {
	test("no-ops when not editing (defensive, shouldn't be reachable via the UI)", () => {
		const result = changeDraft({ state: INITIAL_DRAFT_STATE, nextValue: "5" });
		expect(result).toBe(INITIAL_DRAFT_STATE);
	});
});
