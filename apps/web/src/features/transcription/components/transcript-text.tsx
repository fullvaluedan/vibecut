"use client";

/**
 * Renders the transcript as inline, click-draggable spans (word-level, or
 * segment-level in degraded mode, KTD4). Selection is tracked by ARRAY INDEX,
 * not the native Selection API (KTD2): mousedown on a span anchors, mouseover
 * while the button is held extends, a plain click selects one item, and clicking
 * empty space clears. One delegated listener set on the container reads the
 * target span's index (a long transcript can run to thousands of spans and
 * per-span listeners are an avoidable cost).
 *
 * W4/R2 adds two read-only overlays on top of that SAME selection model,
 * neither of which touches it: mousedown also seeks the playhead to the
 * clicked item's start time (`onSeek`), and `activeIndex` (computed by the
 * caller from the live playback time) gets a distinct highlight while it
 * plays. W4/R3 adds `query`: matching substrings are marked and non-matching
 * items dim, purely visual - the underlying item array and its indices are
 * never filtered, so ripple-delete's index math (R4) is untouched.
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
	start: number;
	end: number;
}

/** Split `text` into matched/unmatched runs against a case-insensitive `query`. */
function splitByQuery({
	text,
	query,
}: {
	text: string;
	query: string;
}): { text: string; matched: boolean }[] {
	if (!query) return [{ text, matched: false }];
	const lowerText = text.toLowerCase();
	const lowerQuery = query.toLowerCase();
	const parts: { text: string; matched: boolean }[] = [];
	let cursor = 0;
	while (cursor < text.length) {
		const foundAt = lowerText.indexOf(lowerQuery, cursor);
		if (foundAt === -1) {
			parts.push({ text: text.slice(cursor), matched: false });
			break;
		}
		if (foundAt > cursor) {
			parts.push({ text: text.slice(cursor, foundAt), matched: false });
		}
		parts.push({
			text: text.slice(foundAt, foundAt + query.length),
			matched: true,
		});
		cursor = foundAt + query.length;
	}
	return parts;
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
	onSeek,
	activeIndex,
	query,
}: {
	items: readonly TranscriptItem[];
	granularity: TranscriptGranularity;
	selection: TranscriptSelection | null;
	onSelectionChange: (selection: TranscriptSelection | null) => void;
	onDeleteSelection?: () => void;
	removedIndices?: ReadonlySet<number>;
	/** Click-a-word seeks the playhead (W4/R2) - the clicked item's start, in seconds. */
	onSeek?: (seconds: number) => void;
	/** The item playing right now, from the live playhead (W4/R2), or null between words. */
	activeIndex?: number | null;
	/** Live search text (W4/R3) - matches are marked, everything else dims. */
	query?: string;
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
		// Click-a-word seeks (R2). Fires on every mousedown, drag-select included -
		// the anchor word is where the click landed, so seeking there matches intent.
		onSeek?.(items[index].start);
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
				const playing = !removed && !selected && activeIndex === index;
				const hasQuery = !!query && !removed;
				const isMatch =
					hasQuery && item.text.toLowerCase().includes(query.toLowerCase());
				const parts = hasQuery
					? splitByQuery({ text: item.text, query: query as string })
					: [{ text: item.text, matched: false }];
				return (
					<span key={index}>
						<span
							data-index={index}
							className={cn(
								"rounded-sm",
								selected && "bg-primary/25",
								playing && "bg-primary/10 ring-1 ring-primary/50",
								removed &&
									"text-muted-foreground pointer-events-none line-through opacity-60",
								hasQuery && !isMatch && "opacity-40",
							)}
						>
							{parts.map((part, partIndex) =>
								part.matched ? (
									<mark
										key={partIndex}
										className="rounded-[2px] bg-amber-400/60 text-inherit"
									>
										{part.text}
									</mark>
								) : (
									<span key={partIndex}>{part.text}</span>
								),
							)}
						</span>{" "}
					</span>
				);
			})}
		</div>
	);
}
