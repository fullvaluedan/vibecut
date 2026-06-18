"use client";

/**
 * Shared Premiere-style "fx group" primitives. These were extracted verbatim
 * from effect-controls-tab.tsx so the Effect Controls panel and the
 * Audio/Speed/Blending panels can share one look: a collapsible group, a
 * fixed-width label column, right-aligned controls, blue scrubbable values,
 * and a keyframe stopwatch where a property is keyframable.
 *
 * `FxGroup` shows the literal "fx" badge only when `badge` is set — Effect
 * Controls passes it; the non-effect panels (Speed/Audio/Blending) omit it.
 */

import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	ArrowDown01Icon,
	ArrowLeft01Icon,
	ArrowRight01Icon,
	ArrowTurnBackwardIcon,
	ArrowUp01Icon,
	KeyframeIcon,
	StopWatchIcon,
} from "@hugeicons/core-free-icons";
import { cn } from "@/utils/ui";

/** Pixels of horizontal drag per display-unit step while scrubbing. */
const SCRUB_PX_PER_STEP = 2;

function formatDisplay({
	value,
	decimals,
}: {
	value: number;
	decimals: number;
}): string {
	return value.toFixed(decimals);
}

/**
 * The keyframe-group view-model consumed by {@link Stopwatch} and
 * {@link KfNav}. Effect Controls' `useKfGroup` hook returns exactly this
 * shape; other panels can build the same shape to reuse the controls.
 */
export interface KfGroup {
	animated: boolean;
	anyAtPlayhead: boolean;
	hasPrev: boolean;
	hasNext: boolean;
	within: boolean;
	toggleAnimation: () => void;
	toggleAtPlayhead: () => void;
	goPrev: () => void;
	goNext: () => void;
}

export function Stopwatch({ group, label }: { group: KfGroup; label: string }) {
	return (
		<button
			type="button"
			title={
				group.animated
					? `Turn off ${label} animation (removes ALL its keyframes)`
					: `Animate ${label} (adds a keyframe at the playhead)`
			}
			className={cn(
				"flex w-6 shrink-0 items-center justify-center",
				group.animated ? "text-primary" : "text-muted-foreground/60",
				!group.animated && !group.within && "opacity-40",
			)}
			onClick={group.toggleAnimation}
		>
			<HugeiconsIcon icon={StopWatchIcon} size={13} />
		</button>
	);
}

export function KfNav({ group }: { group: KfGroup }) {
	if (!group.animated) return null;
	const navBtn =
		"flex h-4 w-4 items-center justify-center disabled:opacity-25";
	return (
		<div className="text-muted-foreground flex items-center">
			<button
				type="button"
				title="Go to previous keyframe"
				className={navBtn}
				disabled={!group.hasPrev}
				onClick={group.goPrev}
			>
				<HugeiconsIcon icon={ArrowLeft01Icon} size={11} />
			</button>
			<button
				type="button"
				title={
					group.anyAtPlayhead
						? "Remove keyframe at playhead"
						: "Add keyframe at playhead"
				}
				className={cn(navBtn, group.anyAtPlayhead && "text-primary")}
				disabled={!group.within}
				onClick={group.toggleAtPlayhead}
			>
				<HugeiconsIcon
					icon={KeyframeIcon}
					size={11}
					className={cn(group.anyAtPlayhead && "fill-primary")}
				/>
			</button>
			<button
				type="button"
				title="Go to next keyframe"
				className={navBtn}
				disabled={!group.hasNext}
				onClick={group.goNext}
			>
				<HugeiconsIcon icon={ArrowRight01Icon} size={11} />
			</button>
		</div>
	);
}

/**
 * Premiere-style value control. The blue number itself is the drag surface:
 * click-and-hold then drag left/right to scrub (pointer-locked), release
 * without moving to type an exact value. Tiny ▲/▼ arrows nudge by one step.
 * Values display in scaled units (e.g. scale 1.0 → 100.0); writes convert
 * back to model units and clamp to the param's range.
 */
export function ValueField({
	resolved,
	factor,
	decimals,
	suffix,
	iconLabel,
	isDefault,
	step = 1,
	minModel,
	maxModel,
	onPreviewModel,
	onCommit,
	onResetModel,
}: {
	resolved: number;
	factor: number;
	decimals: number;
	suffix?: string;
	iconLabel?: string;
	isDefault: boolean;
	/** Increment per arrow click / per few px of drag, in DISPLAY units. */
	step?: number;
	minModel?: number;
	maxModel?: number;
	onPreviewModel: (modelValue: number) => void;
	onCommit: () => void;
	onResetModel?: () => void;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	// Live readout while dragging: previews don't flow back into `resolved`
	// until commit, so the scrub keeps its own display text.
	const [scrubText, setScrubText] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const display =
		scrubText ?? formatDisplay({ value: resolved * factor, decimals });

	useEffect(() => {
		if (editing) {
			inputRef.current?.focus();
			inputRef.current?.select();
		}
	}, [editing]);

	const clampModel = (value: number) => {
		let next = value;
		if (minModel !== undefined) next = Math.max(minModel, next);
		if (maxModel !== undefined) next = Math.min(maxModel, next);
		return next;
	};
	/** Previews the clamped value and returns it in display units. */
	const previewDisplay = (displayValue: number): number => {
		const clampedModel = clampModel(displayValue / factor);
		onPreviewModel(clampedModel);
		return clampedModel * factor;
	};

	const nudge = (direction: 1 | -1) => {
		previewDisplay(resolved * factor + direction * step);
		onCommit();
	};

	const startScrub = (event: React.PointerEvent<HTMLElement>) => {
		if (event.button !== 0 || editing) return;
		event.preventDefault();
		const surface = event.currentTarget;
		const startDisplay = resolved * factor;
		let cumulative = 0;
		let scrubbing = false;

		const onMove = (move: PointerEvent) => {
			cumulative += move.movementX;
			if (!scrubbing && Math.abs(cumulative) >= 3) {
				scrubbing = true;
				// Pointer CAPTURE, not pointer lock: Chromium leaves the cursor
				// invisible after exitPointerLock until the next click.
				try {
					surface.setPointerCapture(event.pointerId);
				} catch {
					// capture is best-effort
				}
				document.body.style.cursor = "ew-resize";
			}
			if (scrubbing) {
				const shown = previewDisplay(
					startDisplay + (cumulative / SCRUB_PX_PER_STEP) * step,
				);
				// Don't let the drag distance pile up past a min/max bound —
				// otherwise the value "sticks" until you drag all the way back.
				const cumulativeAtShown =
					((shown - startDisplay) / step) * SCRUB_PX_PER_STEP;
				if (Math.abs(cumulative - cumulativeAtShown) > SCRUB_PX_PER_STEP) {
					cumulative = cumulativeAtShown;
				}
				setScrubText(formatDisplay({ value: shown, decimals }));
			}
		};
		const onUp = () => {
			document.removeEventListener("pointermove", onMove);
			document.removeEventListener("pointerup", onUp);
			document.body.style.cursor = "";
			setScrubText(null);
			if (scrubbing) {
				onCommit();
			} else {
				// A plain click: switch to typing with the value pre-selected.
				setDraft(display);
				setEditing(true);
			}
		};
		document.addEventListener("pointermove", onMove);
		document.addEventListener("pointerup", onUp);
	};

	return (
		<div className="flex items-center gap-0.5">
			{onResetModel && (
				<button
					type="button"
					title={isDefault ? "Already at default" : "Reset to default"}
					disabled={isDefault}
					className={cn(
						"text-muted-foreground hover:text-foreground",
						isDefault && "cursor-default opacity-25 hover:text-muted-foreground",
					)}
					onClick={onResetModel}
				>
					<HugeiconsIcon icon={ArrowTurnBackwardIcon} size={11} />
				</button>
			)}
			<div className="bg-foreground/5 hover:bg-foreground/10 flex h-6 min-w-[76px] items-center justify-end gap-1 rounded px-1.5">
				{iconLabel && (
					<span className="text-muted-foreground select-none text-[10px]">
						{iconLabel}
					</span>
				)}
				{editing ? (
					<input
						ref={inputRef}
						value={draft}
						className="w-full min-w-0 bg-transparent text-right text-xs font-medium text-sky-400 outline-none"
						onChange={(e) => {
							setDraft(e.target.value);
							const parsed = parseFloat(e.target.value);
							if (Number.isFinite(parsed)) previewDisplay(parsed);
						}}
						onBlur={() => {
							setEditing(false);
							onCommit();
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === "Escape") {
								e.currentTarget.blur();
							}
							if (e.key === "ArrowUp") {
								e.preventDefault();
								nudge(1);
								setDraft(
									formatDisplay({ value: resolved * factor + step, decimals }),
								);
							}
							if (e.key === "ArrowDown") {
								e.preventDefault();
								nudge(-1);
								setDraft(
									formatDisplay({ value: resolved * factor - step, decimals }),
								);
							}
						}}
					/>
				) : (
					<span
						className="cursor-ew-resize select-none whitespace-nowrap text-xs font-medium text-sky-400"
						title="Drag to scrub, click to type"
						onPointerDown={startScrub}
					>
						{display}
						{suffix ?? ""}
					</span>
				)}
				<div className="flex flex-col">
					<button
						type="button"
						tabIndex={-1}
						title={`+${step}`}
						className="text-muted-foreground hover:text-sky-400 flex h-[11px] items-center"
						onClick={() => nudge(1)}
					>
						<HugeiconsIcon icon={ArrowUp01Icon} size={10} />
					</button>
					<button
						type="button"
						tabIndex={-1}
						title={`-${step}`}
						className="text-muted-foreground hover:text-sky-400 flex h-[11px] items-center"
						onClick={() => nudge(-1)}
					>
						<HugeiconsIcon icon={ArrowDown01Icon} size={10} />
					</button>
				</div>
			</div>
		</div>
	);
}

export function Row({
	label,
	stopwatch,
	children,
	indent = true,
}: {
	label: string;
	stopwatch?: React.ReactNode;
	children: React.ReactNode;
	indent?: boolean;
}) {
	return (
		<div className={cn("flex h-7 items-center gap-1 pr-2", indent && "pl-1")}>
			{stopwatch ?? <span className="w-6 shrink-0" />}
			<span className="w-[84px] shrink-0 truncate text-xs text-foreground/75">
				{label}
			</span>
			<div className="flex min-w-0 flex-1 items-center justify-end gap-1">
				{children}
			</div>
		</div>
	);
}

export function FxGroup({
	title,
	badge = false,
	children,
}: {
	title: string;
	/** Show the literal "fx" badge in the header (Effect Controls only). */
	badge?: boolean;
	children: React.ReactNode;
}) {
	const [open, setOpen] = useState(true);
	return (
		<div className="border-b py-1 last:border-b-0">
			<button
				type="button"
				className="flex w-full items-center gap-1.5 px-1 py-1 text-left"
				onClick={() => setOpen((o) => !o)}
			>
				<HugeiconsIcon
					icon={open ? ArrowDown01Icon : ArrowRight01Icon}
					size={14}
					className="text-muted-foreground"
				/>
				{badge && (
					<span className="text-[10px] font-bold italic text-primary/80">fx</span>
				)}
				<span className="text-xs font-semibold">{title}</span>
			</button>
			{open && <div className="flex flex-col">{children}</div>}
		</div>
	);
}
