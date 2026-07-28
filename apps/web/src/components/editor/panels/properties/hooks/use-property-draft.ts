import { useState } from "react";
import { evaluateMathExpression } from "@/utils/math";

function looksLikeExpression({ input }: { input: string }): boolean {
	const trimmed = input.trim();
	if (!trimmed) return false;
	if (/[+*/]/.test(input)) return true;
	const minusIndex = trimmed.indexOf("-");
	return minusIndex > 0;
}

/**
 * Pure draft state machine, factored out of the hook below so it is testable
 * without a React renderer (this repo's `bun test` suite has no DOM). The
 * hook is a thin useState wrapper around these transitions.
 */
export interface DraftState {
	isEditing: boolean;
	draft: string;
	/** Display string captured at focus time; Escape reverts to this. */
	preEditDisplay: string;
}

export const INITIAL_DRAFT_STATE: DraftState = {
	isEditing: false,
	draft: "",
	preEditDisplay: "",
};

export function focusDraft({
	sourceDisplay,
}: {
	sourceDisplay: string;
}): DraftState {
	return { isEditing: true, draft: sourceDisplay, preEditDisplay: sourceDisplay };
}

export function changeDraft({
	state,
	nextValue,
}: {
	state: DraftState;
	nextValue: string;
}): DraftState {
	if (!state.isEditing) return state;
	return { ...state, draft: nextValue };
}

/** Enter or blur-away: keep the typed value, exit editing. Caller commits. */
export function commitDraft(): DraftState {
	return INITIAL_DRAFT_STATE;
}

/**
 * Escape: exit editing WITHOUT committing. Returns the display string the
 * caller should re-preview to revert whatever was shown mid-edit.
 */
export function cancelDraft({ state }: { state: DraftState }): {
	nextState: DraftState;
	revertDisplay: string;
} {
	return { nextState: INITIAL_DRAFT_STATE, revertDisplay: state.preEditDisplay };
}

export function resolveDraftDisplayValue({
	state,
	sourceDisplay,
}: {
	state: DraftState;
	sourceDisplay: string;
}): string {
	return state.isEditing ? state.draft : sourceDisplay;
}

export function usePropertyDraft<T>({
	displayValue: sourceDisplay,
	parse,
	onPreview,
	onCommit,
	onStartEditing,
	supportsExpressions = true,
}: {
	displayValue: string;
	parse: (input: string) => T | null;
	onPreview: (value: T) => void;
	onCommit: () => void;
	onStartEditing?: () => void;
	supportsExpressions?: boolean;
}) {
	const [state, setState] = useState<DraftState>(INITIAL_DRAFT_STATE);

	return {
		displayValue: resolveDraftDisplayValue({ state, sourceDisplay }),
		scrubTo: (value: number) => {
			const parsed = parse(String(value));
			if (parsed !== null) onPreview(parsed);
		},
		commitScrub: onCommit,
		onFocus: () => {
			setState(focusDraft({ sourceDisplay }));
			onStartEditing?.();
		},
		onChange: (
			event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
		) => {
			const nextDraft = event.target.value;
			setState((prev) => changeDraft({ state: prev, nextValue: nextDraft }));

			const parsed = parse(nextDraft);
			if (parsed !== null) {
				onPreview(parsed);
			}
		},
		onBlur: (
			event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>,
		) => {
			const nextDraft = event.target.value;
			if (supportsExpressions && looksLikeExpression({ input: nextDraft })) {
				const evaluated = evaluateMathExpression({ input: nextDraft });
				if (evaluated !== null) {
					const parsed = parse(String(evaluated));
					if (parsed !== null) onPreview(parsed);
				}
			}
			onCommit();
			setState(commitDraft());
		},
		/** Escape: revert the live preview to the pre-edit value, no commit. */
		onCancel: () => {
			const { nextState, revertDisplay } = cancelDraft({ state });
			const parsed = parse(revertDisplay);
			if (parsed !== null) onPreview(parsed);
			setState(nextState);
		},
	};
}
