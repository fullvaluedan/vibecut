"use client";

/**
 * The Assistant mini-prompt, in the preview toolbar (T17.3). Retired from its
 * original one-shot design (that fired a single `/api/assistant` request via
 * `run-assistant.ts` - still in the tree, just no longer wired to this
 * surface, same parked-not-deleted discipline as `surface-flags.ts`'s other
 * flags): typing here and pressing Enter now just opens/focuses the Assistant
 * dock tab with the text pre-filled, so the actual turn - streaming reply,
 * clarifying questions, confirmation lists, the applied chip - all happens in
 * one place (`features/assistant/components/assistant-tab.tsx`).
 */

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { useDirectorPlanStore } from "@/features/ai-generate/director/director-plan-store";

const PLACEHOLDER = 'Ask AI: "cut the silence", "add a title that says Welcome"...';

export function AssistantPrompt() {
	const [value, setValue] = useState("");
	const setDockTab = useDirectorPlanStore((s) => s.setDockTab);
	const setAssistantSeedText = useDirectorPlanStore((s) => s.setAssistantSeedText);

	const open = () => {
		const text = value.trim();
		setAssistantSeedText(text);
		setDockTab("assistant");
		setValue("");
	};

	return (
		<div className="relative w-full max-w-xl min-w-40">
			<Input
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => {
					// The editor's global hotkeys must not fire while typing here;
					// the typable-element guard handles that, but Enter is ours.
					if (e.key === "Enter") {
						e.preventDefault();
						open();
					}
				}}
				placeholder={PLACEHOLDER}
				className="h-8 text-xs"
				spellCheck={false}
			/>
		</div>
	);
}
