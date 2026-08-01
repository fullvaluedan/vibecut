"use client";

/**
 * T16.3 restore-window SHELL for manual transcript deletions (roadmap T16.2
 * point 3). Clicking a struck word range in the transcript opens this small
 * floating card: the deleted words rendered readable, and a "Restore" button
 * that only appears when a plain `editor.command.undo()` would still hit
 * exactly this delete (see `canRestoreDeletion` in restore-popover-gate.ts).
 * Anything else - a later edit landed on top of the undo stack - shows the
 * honest fallback instead of claiming a restore it cannot perform.
 *
 * Deliberately its own file and a plain fixed-position card (not wired to
 * Director category/reason or per-word partial restore) so T16.2's lineage
 * work can extend `RestoreTarget` and replace the gating call without
 * touching the anchoring/positioning logic here.
 */

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";

export interface RestoreTarget {
	/** Display-index range into the transcript's items array. */
	startIndex: number;
	endIndex: number;
	/** The struck words, in order, for the readable strikethrough list. */
	words: string[];
	/** From `canRestoreDeletion` - a plain undo would still hit this delete. */
	canRestore: boolean;
}

/** Where to anchor the card - the clicked span's viewport rect. */
export interface RestoreAnchorRect {
	top: number;
	left: number;
	bottom: number;
}

export function TranscriptRestorePopover({
	target,
	anchorRect,
	onRestore,
	onClose,
}: {
	target: RestoreTarget;
	anchorRect: RestoreAnchorRect;
	onRestore: () => void;
	onClose: () => void;
}) {
	const cardRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (
				cardRef.current &&
				target instanceof Node &&
				!cardRef.current.contains(target)
			) {
				onClose();
			}
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		// Capture phase: the transcript container's own mousedown handler would
		// otherwise run first and clear selection before this sees the click.
		window.addEventListener("pointerdown", onPointerDown, true);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("pointerdown", onPointerDown, true);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [onClose]);

	return (
		<div
			ref={cardRef}
			role="dialog"
			aria-label="Deleted words"
			className="bg-popover text-popover-foreground fixed z-50 w-64 rounded-md border p-3 text-xs shadow-[0_0_10px_rgba(0,0,0,0.15)]"
			style={{ top: anchorRect.bottom + 6, left: anchorRect.left }}
		>
			<p className="text-muted-foreground mb-1.5 font-medium">Deleted words</p>
			<p className="mb-3 leading-relaxed line-through opacity-80">
				{target.words.length > 0 ? target.words.join(" ") : "(no words)"}
			</p>
			{target.canRestore ? (
				<Button
					type="button"
					size="sm"
					variant="outline"
					className="w-full"
					onClick={onRestore}
				>
					Restore
				</Button>
			) : (
				<p className="text-muted-foreground">
					Use Ctrl+Z to restore earlier edits.
				</p>
			)}
		</div>
	);
}
