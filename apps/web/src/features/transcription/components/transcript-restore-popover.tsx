"use client";

/**
 * The restore window. Clicking a red pipe (or, in the no-lineage fallback, a
 * struck word) opens this small floating card.
 *
 * T16.3 built the SHELL for plain manual deletions: the deleted words rendered
 * readable, and a "Restore" button that only appears when a plain
 * `editor.command.undo()` would still hit exactly that delete (`canRestoreDeletion`).
 * That mode is unchanged and is still what the panel falls back to when no
 * transcript lineage explains the timeline.
 *
 * T16.2 adds the SEAM mode it was built to be extended with: the cut's
 * provenance (Director category + reason + source timecodes, or "Manual
 * delete"), one row per merged removal span, and word-level SELECTION over the
 * struck words - click, click-drag, or click-then-shift-click - driving a
 * "Restore N words" button next to "Restore all". Selection is tracked by index
 * exactly like the main transcript's (KTD2), never the native Selection API.
 *
 * The anchoring/positioning logic is shared by both modes and untouched.
 */

/* eslint-disable jsx-a11y/no-static-element-interactions, jsx-a11y/mouse-events-have-key-events -- Mouse-only index-drag selection over the struck words, matching transcript-text.tsx (KTD2); keyboard word-selection is the same documented deferral (OQ3). "Restore all" is a real button and always reachable by keyboard. */

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils/ui";
import type { SeamWindowModel } from "@/features/transcription/seam-window-model";

/** T16.3 mode: one manual deletion, restorable only by a plain undo. */
export interface RestoreTarget {
	kind: "deletion";
	/** Display-index range into the transcript's items array. */
	startIndex: number;
	endIndex: number;
	/** The struck words, in order, for the readable strikethrough list. */
	words: string[];
	/** From `canRestoreDeletion` - a plain undo would still hit this delete. */
	canRestore: boolean;
}

/** T16.2 mode: a lineage seam, with provenance and per-word restore. */
export interface SeamRestoreTarget extends SeamWindowModel {
	kind: "seam";
}

/** Where to anchor the card - the clicked span's viewport rect. */
export interface RestoreAnchorRect {
	top: number;
	left: number;
	bottom: number;
}

/** Inclusive index range into the seam's removed words. */
export interface SeamWordRange {
	startIndex: number;
	endIndex: number;
}

export function TranscriptRestorePopover({
	target,
	anchorRect,
	onRestore,
	onRestoreWords,
	onClose,
}: {
	target: RestoreTarget | SeamRestoreTarget;
	anchorRect: RestoreAnchorRect;
	/** Deletion mode: undo. Seam mode: restore every removed word. */
	onRestore: () => void;
	/** Seam mode only: restore the selected sub-range. */
	onRestoreWords?: (range: SeamWordRange) => void;
	onClose: () => void;
}) {
	const cardRef = useRef<HTMLDivElement>(null);
	const anchorIndexRef = useRef<number | null>(null);
	const [selection, setSelection] = useState<SeamWordRange | null>(null);

	// NOTE: the selection state is reset by REMOUNTING - the panel keys this card
	// on the seam (or deletion) it is showing, so switching targets gives a fresh
	// card rather than one carrying a stale word range.

	useEffect(() => {
		const onPointerDown = (event: PointerEvent) => {
			const clicked = event.target;
			if (
				cardRef.current &&
				clicked instanceof Node &&
				!cardRef.current.contains(clicked)
			) {
				onClose();
			}
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		const onMouseUp = () => {
			anchorIndexRef.current = null;
		};
		// Capture phase: the transcript container's own mousedown handler would
		// otherwise run first and clear selection before this sees the click.
		window.addEventListener("pointerdown", onPointerDown, true);
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("mouseup", onMouseUp);
		return () => {
			window.removeEventListener("pointerdown", onPointerDown, true);
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("mouseup", onMouseUp);
		};
	}, [onClose]);

	const selectedCount = useMemo(
		() => (selection ? selection.endIndex - selection.startIndex + 1 : 0),
		[selection],
	);

	const extendTo = ({ index, from }: { index: number; from: number }) =>
		setSelection({
			startIndex: Math.min(from, index),
			endIndex: Math.max(from, index),
		});

	const handleWordMouseDown = ({
		event,
		index,
	}: {
		event: React.MouseEvent;
		index: number;
	}) => {
		event.preventDefault();
		event.stopPropagation();
		if (event.shiftKey && selection) {
			const from = anchorIndexRef.current ?? selection.startIndex;
			anchorIndexRef.current = from;
			extendTo({ index, from });
			return;
		}
		anchorIndexRef.current = index;
		setSelection({ startIndex: index, endIndex: index });
	};

	const handleWordMouseOver = ({ index }: { index: number }) => {
		const from = anchorIndexRef.current;
		if (from == null) return;
		extendTo({ index, from });
	};

	const card = (children: React.ReactNode) => (
		<div
			ref={cardRef}
			role="dialog"
			aria-label="Deleted words"
			className="bg-popover text-popover-foreground fixed z-50 w-72 rounded-md border p-3 text-xs shadow-[0_0_10px_rgba(0,0,0,0.15)]"
			style={{ top: anchorRect.bottom + 6, left: anchorRect.left }}
		>
			{children}
		</div>
	);

	if (target.kind === "deletion") {
		return card(
			<>
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
			</>,
		);
	}

	return card(
		<>
			<div className="mb-2 flex items-baseline justify-between gap-2">
				<p className="text-muted-foreground font-medium">Removed here</p>
				<span className="text-muted-foreground/80">{target.removedLabel}</span>
			</div>

			<div className="mb-2 flex flex-col gap-1.5">
				{target.provenance.map((line, index) => (
					<div key={index} className="flex flex-col">
						<div className="flex items-baseline justify-between gap-2">
							<span className="text-destructive font-medium">{line.label}</span>
							<span className="text-muted-foreground/80 shrink-0 tabular-nums">
								{line.timecode}
							</span>
						</div>
						{line.detail && (
							<span className="text-muted-foreground leading-snug">
								{line.detail}
							</span>
						)}
					</div>
				))}
			</div>

			{target.spans.length > 1 && (
				<p className="text-muted-foreground/80 mb-2">
					Spans: {target.spans.join(" | ")}
				</p>
			)}

			<div
				className="mb-2 max-h-32 cursor-text overflow-y-auto leading-relaxed select-none"
				onMouseDown={(event) => event.stopPropagation()}
			>
				{target.words.length === 0 && (
					<span className="text-muted-foreground">(no words)</span>
				)}
				{target.words.map((word, index) => {
					const selected =
						selection != null &&
						index >= selection.startIndex &&
						index <= selection.endIndex;
					return (
						<span key={index}>
							<span
								data-word-index={index}
								className={cn(
									"cursor-pointer rounded-sm line-through opacity-80",
									selected && "bg-primary/25 opacity-100",
								)}
								onMouseDown={(event) => handleWordMouseDown({ event, index })}
								onMouseOver={() => handleWordMouseOver({ index })}
							>
								{word}
							</span>{" "}
						</span>
					);
				})}
			</div>

			<div className="flex gap-1.5">
				<Button
					type="button"
					size="sm"
					variant="outline"
					className="flex-1"
					disabled={selection == null || onRestoreWords == null}
					onClick={() => {
						if (selection && onRestoreWords) onRestoreWords(selection);
					}}
				>
					{selectedCount > 0
						? `Restore ${selectedCount} word${selectedCount === 1 ? "" : "s"}`
						: "Restore selected"}
				</Button>
				<Button
					type="button"
					size="sm"
					variant="outline"
					className="flex-1"
					onClick={onRestore}
				>
					Restore all
				</Button>
			</div>
		</>,
	);
}
