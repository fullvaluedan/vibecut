"use client";

/**
 * Renders the transcript as inline, click-draggable spans (word-level, or
 * segment-level in degraded mode, KTD4). Selection is tracked by ARRAY INDEX,
 * not the native Selection API (KTD2): mousedown on a span anchors, mouseover
 * while the button is held extends, a plain click selects one item, and clicking
 * empty space clears. One delegated listener set on the container reads the
 * target span's index (a long transcript can run to thousands of spans and
 * per-span listeners are an avoidable cost).
 */

/* eslint-disable jsx-a11y/no-static-element-interactions, jsx-a11y/no-noninteractive-tabindex, jsx-a11y/mouse-events-have-key-events -- Mouse-only index-drag selection (KTD2); keyboard word-selection is a documented deferral (OQ3). The container is focusable (tabIndex) so Delete/Backspace can ripple-delete the active selection. */

import { useEffect, useRef } from "react";
import { cn } from "@/utils/ui";
import type {
	TranscriptGranularity,
	TranscriptSelection,
} from "@/features/transcription/resolve-selection-to-range";
import { normalizeSelection } from "@/features/transcription/transcript-selection";

interface TranscriptItem {
	text: string;
}

function indexFromEvent(event: {
	target: EventTarget | null;
}): number | null {
	const target = event.target;
	if (!(target instanceof Element)) return null;
	const el = target.closest("[data-index]");
	if (!el) return null;
	const raw = el.getAttribute("data-index");
	if (raw == null) return null;
	const index = Number(raw);
	return Number.isNaN(index) ? null : index;
}

export function TranscriptText({
	items,
	granularity,
	selection,
	onSelectionChange,
	onDeleteSelection,
	removedIndices,
}: {
	items: readonly TranscriptItem[];
	granularity: TranscriptGranularity;
	selection: TranscriptSelection | null;
	onSelectionChange: (selection: TranscriptSelection | null) => void;
	onDeleteSelection?: () => void;
	removedIndices?: ReadonlySet<number>;
}) {
	const anchorRef = useRef<number | null>(null);

	// End the drag even if the button is released outside the container.
	useEffect(() => {
		const onUp = () => {
			anchorRef.current = null;
		};
		window.addEventListener("mouseup", onUp);
		return () => window.removeEventListener("mouseup", onUp);
	}, []);

	const handleMouseDown = (event: React.MouseEvent) => {
		const index = indexFromEvent(event);
		if (index == null) {
			// Clicking empty space clears the selection.
			onSelectionChange(null);
			anchorRef.current = null;
			return;
		}
		anchorRef.current = index;
		onSelectionChange(
			normalizeSelection({ anchorIndex: index, focusIndex: index, granularity }),
		);
	};

	const handleMouseOver = (event: React.MouseEvent) => {
		if (anchorRef.current == null) return;
		const index = indexFromEvent(event);
		if (index == null) return;
		onSelectionChange(
			normalizeSelection({
				anchorIndex: anchorRef.current,
				focusIndex: index,
				granularity,
			}),
		);
	};

	const handleKeyDown = (event: React.KeyboardEvent) => {
		if (!selection || !onDeleteSelection) return;
		if (event.key === "Delete" || event.key === "Backspace") {
			event.preventDefault();
			onDeleteSelection();
		}
	};

	return (
		<div
			className="text-foreground cursor-text overflow-y-auto p-4 text-sm leading-relaxed select-none outline-none"
			tabIndex={0}
			onMouseDown={handleMouseDown}
			onMouseOver={handleMouseOver}
			onKeyDown={handleKeyDown}
		>
			{items.map((item, index) => {
				const selected =
					selection != null &&
					index >= selection.startIndex &&
					index <= selection.endIndex;
				const removed = removedIndices?.has(index) ?? false;
				return (
					<span key={index}>
						<span
							data-index={index}
							className={cn(
								"rounded-sm",
								selected && "bg-primary/25",
								removed &&
									"text-muted-foreground pointer-events-none line-through opacity-60",
							)}
						>
							{item.text}
						</span>{" "}
					</span>
				);
			})}
		</div>
	);
}
