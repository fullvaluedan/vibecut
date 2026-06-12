"use client";

/**
 * The prompt box under the preview: ask for an edit in plain language.
 * Railed to what VibeCut can do — cuts, b-roll, music/SFX, HyperFrames,
 * text, captions. Everything else is politely refused server-side.
 */

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useEditor } from "@/editor/use-editor";
import { runAssistant } from "@/features/assistant/run-assistant";

const PLACEHOLDER =
	'Ask AI: "edit this like a YouTube video", "find b-roll of a city at night", "add tense music"...';

export function AssistantPrompt() {
	const editor = useEditor();
	const [value, setValue] = useState("");
	const [stage, setStage] = useState<string | null>(null);
	const busyRef = useRef(false);

	const submit = async () => {
		const prompt = value.trim();
		if (!prompt || busyRef.current) return;
		busyRef.current = true;
		setStage("Thinking...");
		try {
			await runAssistant({ editor, prompt, onStage: setStage });
			setValue("");
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			toast.error("That didn't work", { description: message });
		} finally {
			busyRef.current = false;
			setStage(null);
		}
	};

	return (
		<div className="relative w-full max-w-xl min-w-40">
			<Input
				value={stage ?? value}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => {
					// The editor's global hotkeys must not fire while typing here;
					// the typable-element guard handles that, but Enter is ours.
					if (e.key === "Enter") {
						e.preventDefault();
						void submit();
					}
				}}
				disabled={stage !== null}
				placeholder={PLACEHOLDER}
				className="h-8 pr-8 text-xs"
				spellCheck={false}
			/>
			{stage !== null && (
				<Spinner className="absolute top-2 right-2.5 size-4" />
			)}
		</div>
	);
}
