"use client";

/**
 * The Assistant tab (T17.3): chat history + composer, docked in the right
 * inspector next to Properties and Director. Always mounted (hidden via CSS
 * by `director-dock-shell.tsx`, same lifecycle discipline as the other two
 * tabs) so the mock/real service's in-flight turn and the composer's ref
 * survive a tab switch.
 *
 * Wires the pure reducer (assistant-reducer.ts) through `useAssistantChat`
 * (the MOCK service by default - see assistant-service.ts) and the
 * mini-prompt hand-off (`assistantSeedText` on `useDirectorPlanStore`).
 */

import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { SentIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { bindAction, unbindAction } from "@/actions";
import { useDirectorPlanStore } from "../../ai-generate/director/director-plan-store";
import { useAssistantChat } from "./use-assistant-chat";
import { AssistantMessageBubble } from "./assistant-message-bubble";
import { canUseQuickReply } from "./assistant-reducer";

const EXAMPLE_PROMPTS = [
	"Cut the silence at the start",
	"Add a title that says Welcome",
	"Speed up the second clip",
];

export function AssistantTab() {
	const chat = useAssistantChat();
	const dockTab = useDirectorPlanStore((s) => s.dockTab);
	const setDockTab = useDirectorPlanStore((s) => s.setDockTab);
	const assistantSeedText = useDirectorPlanStore((s) => s.assistantSeedText);
	const setAssistantSeedText = useDirectorPlanStore((s) => s.setAssistantSeedText);

	const [value, setValue] = useState("");
	const composerRef = useRef<HTMLTextAreaElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	// Ctrl+/ (registered through the actions system, definitions.ts's
	// "focus-assistant"): switch to this tab and focus the composer, from
	// anywhere in the editor.
	useEffect(() => {
		const handler = () => {
			setDockTab("assistant");
			requestAnimationFrame(() => composerRef.current?.focus());
		};
		bindAction("focus-assistant", handler);
		return () => unbindAction("focus-assistant", handler);
	}, [setDockTab]);

	// Mini-prompt hand-off: a pending seed fills and focuses the composer once,
	// then clears itself.
	useEffect(() => {
		if (assistantSeedText === null) return;
		setValue(assistantSeedText);
		setAssistantSeedText(null);
		requestAnimationFrame(() => composerRef.current?.focus());
	}, [assistantSeedText, setAssistantSeedText]);

	// Autofocus on idle (fresh turn) and on a clarifying question landing, but
	// only while this tab is actually the visible one.
	useEffect(() => {
		if (dockTab === "assistant" && chat.autofocus) {
			composerRef.current?.focus();
		}
	}, [dockTab, chat.autofocus]);

	// Auto-scroll to the newest content.
	useEffect(() => {
		const el = listRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [chat.messages]);

	const submit = () => {
		const text = value.trim();
		if (!text || chat.disabled) return;
		chat.send(text);
		setValue("");
	};

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
				{chat.messages.length === 0 ? (
					<EmptyState
						onPick={(prompt) => {
							setValue(prompt);
							requestAnimationFrame(() => composerRef.current?.focus());
						}}
					/>
				) : (
					chat.messages.map((message) => (
						<AssistantMessageBubble
							key={message.id}
							message={message}
							canQuickReply={canUseQuickReply({ state: chat.state, messageId: message.id })}
							onQuickReply={(reply) => chat.clickQuickReply({ messageId: message.id, reply })}
							onConfirm={(ops) => chat.confirmOps({ messageId: message.id, ops })}
							onCancel={() => chat.cancelOps(message.id)}
							onUndo={() => message.undo?.()}
						/>
					))
				)}
			</div>
			<div className="border-t p-2">
				<div className="flex items-end gap-1.5">
					<Textarea
						ref={composerRef}
						value={value}
						onChange={(e) => setValue(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								submit();
							}
						}}
						disabled={chat.disabled}
						placeholder="Ask for an edit: cuts, titles, speed changes..."
						className="min-h-8 flex-1 resize-none py-1.5 text-xs"
						rows={1}
					/>
					<Button
						size="icon"
						variant="ghost"
						aria-label="Send"
						disabled={chat.disabled || !value.trim()}
						onClick={submit}
					>
						<HugeiconsIcon icon={SentIcon} size={16} />
					</Button>
				</div>
			</div>
		</div>
	);
}

function EmptyState({ onPick }: { onPick: (prompt: string) => void }) {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
			<p className="text-muted-foreground text-xs">
				Ask for an edit in plain language. Try one of these, or type your own below.
			</p>
			<div className="flex flex-wrap justify-center gap-1.5">
				{EXAMPLE_PROMPTS.map((prompt) => (
					<Button
						key={prompt}
						variant="secondary"
						size="sm"
						className="h-auto rounded-full px-3 py-1.5 text-xs whitespace-normal"
						onClick={() => onPick(prompt)}
					>
						{prompt}
					</Button>
				))}
			</div>
		</div>
	);
}
