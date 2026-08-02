"use client";

/**
 * One message bubble in the Assistant chat (T17.3), branched by
 * `AssistantMessage.kind`:
 * - text: the assistant's running reply, markdown-lite (bold, lists) via the
 *   existing `ReactMarkdownWrapper`.
 * - clarifying: a highlighted bubble with quick-reply chips.
 * - confirmation: the proposed multi-op change list with Confirm/Cancel.
 * - applied: the "Applied: N changes" chip with a one-click Undo.
 * - error: the assistant's plain-language failure explanation, never a stack
 *   trace (the mock and T17.2's real executor both guarantee this upstream).
 */

import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
	ArrowExpandIcon,
	Bookmark02Icon,
	CheckmarkCircle02Icon,
	Delete02Icon,
	MoveIcon,
	ScissorIcon,
	DashboardSpeed01Icon,
	SplitIcon,
	TextIcon,
} from "@hugeicons/core-free-icons";
import { AlertCircleIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ReactMarkdownWrapper } from "@/components/ui/react-markdown-wrapper";
import { cn } from "@/utils/ui";
import type { AssistantMessage } from "./assistant-reducer";
import type { AssistantOpIcon, AssistantProposedOp } from "./assistant-service";

const OP_ICONS: Record<AssistantOpIcon, IconSvgElement> = {
	cut: ScissorIcon,
	delete: Delete02Icon,
	extend: ArrowExpandIcon,
	move: MoveIcon,
	speed: DashboardSpeed01Icon,
	text: TextIcon,
	marker: Bookmark02Icon,
	split: SplitIcon,
};

export function AssistantMessageBubble({
	message,
	onQuickReply,
	canQuickReply,
	onConfirm,
	onCancel,
	onUndo,
}: {
	message: AssistantMessage;
	onQuickReply: (reply: string) => void;
	canQuickReply: boolean;
	onConfirm: (ops: AssistantProposedOp[]) => void;
	onCancel: () => void;
	onUndo: () => void;
}) {
	const isUser = message.role === "user";

	if (message.role === "system-status") {
		return (
			<div className="flex justify-center py-1">
				<div className="w-full max-w-[92%]">
					{message.kind === "confirmation" ? (
						<ConfirmationCard ops={message.ops ?? []} onConfirm={onConfirm} onCancel={onCancel} />
					) : (
						<AppliedChip
							count={message.appliedCount ?? 0}
							canUndo={typeof message.undo === "function"}
							onUndo={onUndo}
						/>
					)}
				</div>
			</div>
		);
	}

	return (
		<div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
			<div
				className={cn(
					"max-w-[85%] rounded-md px-3 py-2 text-sm",
					isUser && "bg-primary text-primary-foreground",
					!isUser && message.kind === "clarifying" && "bg-accent border-primary/40 border",
					!isUser && message.kind === "error" && "bg-destructive/10 border-destructive/30 border text-destructive",
					!isUser && message.kind === "text" && "bg-muted text-foreground",
				)}
			>
				{message.kind === "error" ? (
					<div className="flex items-start gap-1.5">
						<HugeiconsIcon icon={AlertCircleIcon} size={14} className="mt-0.5 shrink-0" />
						<span>{message.text || "That didn't work."}</span>
					</div>
				) : isUser ? (
					<span className="whitespace-pre-wrap">{message.text}</span>
				) : (
					<ReactMarkdownWrapper>{message.text || "…"}</ReactMarkdownWrapper>
				)}

				{message.kind === "clarifying" && message.quickReplies && message.quickReplies.length > 0 ? (
					<div className="mt-2 flex flex-wrap gap-1.5">
						{message.quickReplies.map((reply) => (
							<Button
								key={reply}
								variant="secondary"
								size="sm"
								disabled={!canQuickReply}
								className="h-7 rounded-full px-2.5 text-xs"
								onClick={() => onQuickReply(reply)}
							>
								{reply}
							</Button>
						))}
					</div>
				) : null}
			</div>
		</div>
	);
}

function ConfirmationCard({
	ops,
	onConfirm,
	onCancel,
}: {
	ops: AssistantProposedOp[];
	onConfirm: (ops: AssistantProposedOp[]) => void;
	onCancel: () => void;
}) {
	return (
		<div className="border-caution/40 bg-caution/5 rounded-md border p-2.5 text-sm">
			<p className="text-muted-foreground mb-1.5 text-xs font-medium">
				This changes {ops.length} thing{ops.length === 1 ? "" : "s"} - review before applying:
			</p>
			<ul className="mb-2 space-y-1">
				{ops.map((op) => (
					<li key={op.id} className="flex items-start gap-1.5">
						<HugeiconsIcon icon={OP_ICONS[op.icon]} size={14} className="text-muted-foreground mt-0.5 shrink-0" />
						<span className="min-w-0 flex-1">{op.summary}</span>
						<span className="text-muted-foreground shrink-0 font-mono text-[10px]">{op.timecode}</span>
					</li>
				))}
			</ul>
			<div className="flex gap-1.5">
				<Button size="sm" className="h-7 text-xs" onClick={() => onConfirm(ops)}>
					Confirm
				</Button>
				<Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onCancel}>
					Cancel
				</Button>
			</div>
		</div>
	);
}

function AppliedChip({
	count,
	canUndo,
	onUndo,
}: {
	count: number;
	canUndo: boolean;
	onUndo: () => void;
}) {
	return (
		<div className="flex items-center justify-center gap-1.5">
			<Badge variant="secondary" className="gap-1 font-normal">
				<HugeiconsIcon icon={CheckmarkCircle02Icon} size={12} />
				Applied: {count} change{count === 1 ? "" : "s"}
			</Badge>
			{canUndo ? (
				<Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={onUndo}>
					Undo
				</Button>
			) : null}
		</div>
	);
}
