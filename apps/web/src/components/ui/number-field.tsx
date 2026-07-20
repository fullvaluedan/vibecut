"use client";

import { cn } from "@/utils/ui";
import { clamp } from "@/utils/math";
import { useRef, useState, useLayoutEffect, type ComponentProps } from "react";
import { useFocusLock } from "@/hooks/use-focus-lock";
import { Button } from "@/components/ui/button";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowTurnBackwardIcon } from "@hugeicons/core-free-icons";

const SUFFIX_GAP_PX = 6;

const DRAG_SENSITIVITIES = {
	default: 1,
	slow: 0.5,
} as const;

type DragSensitivity = "default" | "slow";

/**
 * Live scrub precision modifiers, read from the pointer-move event every
 * frame (not captured once at drag start) so holding or releasing Ctrl/Shift
 * mid-drag changes sensitivity immediately. Ctrl = fine (1/10 the base
 * per-pixel step), Shift = coarse (10x). Neither held = the base rate.
 */
const PRECISION_MODIFIERS = {
	fine: 0.1,
	coarse: 10,
} as const;

export function getScrubPrecisionMultiplier({
	ctrlKey,
	shiftKey,
}: {
	ctrlKey: boolean;
	shiftKey: boolean;
}): number {
	if (ctrlKey) return PRECISION_MODIFIERS.fine;
	if (shiftKey) return PRECISION_MODIFIERS.coarse;
	return 1;
}

type ScrubRange = {
	from: number;
	to: number;
	pixelsPerUnit: number;
};

type ScrubClamp = {
	min?: number;
	max?: number;
};

function clampScrubValue({
	value,
	min,
	max,
}: {
	value: number;
	min?: number;
	max?: number;
}): number {
	if (min != null && max != null) return clamp({ value, min, max });
	if (min != null) return Math.max(min, value);
	if (max != null) return Math.min(max, value);
	return value;
}

function getActiveRange({
	value,
	direction,
	ranges,
}: {
	value: number;
	direction: number;
	ranges: readonly ScrubRange[];
}): ScrubRange | undefined {
	return ranges.find((range) =>
		direction > 0
			? value >= range.from && value < range.to
			: value > range.from && value <= range.to,
	);
}

function scrubAcrossRanges({
	startValue,
	pixelDelta,
	ranges,
	min,
	max,
}: {
	startValue: number;
	pixelDelta: number;
	ranges: readonly ScrubRange[];
	min?: number;
	max?: number;
}): number {
	let currentValue = clampScrubValue({ value: startValue, min, max });
	let remainingPixels = pixelDelta;

	while (remainingPixels !== 0) {
		const direction = Math.sign(remainingPixels);

		const range = getActiveRange({ value: currentValue, direction, ranges });
		if (!range) break;

		const boundary = direction > 0 ? range.to : range.from;
		const pixelsToBoundary =
			Math.abs(boundary - currentValue) * range.pixelsPerUnit;

		if (Math.abs(remainingPixels) <= pixelsToBoundary) {
			currentValue += remainingPixels / range.pixelsPerUnit;
			break;
		}

		currentValue = boundary;
		remainingPixels -= direction * pixelsToBoundary;
	}

	return clampScrubValue({ value: currentValue, min, max });
}

interface NumberFieldProps
	extends Omit<ComponentProps<"input">, "size" | "type"> {
	icon?: React.ReactNode;
	suffix?: string;
	suffixClassName?: string;
	dragSensitivity?: DragSensitivity;
	scrubRanges?: readonly ScrubRange[];
	scrubClamp?: ScrubClamp;
	onScrub?: (value: number) => void;
	onScrubEnd?: () => void;
	allowExpressions?: boolean;
	onReset?: () => void;
	isDefault?: boolean;
	/**
	 * Escape: called before the input blurs, distinct from onBlur's commit
	 * path. Typical wiring is `usePropertyDraft`'s `onCancel`, which reverts
	 * the in-progress typed draft to its pre-edit value without committing.
	 */
	onCancel?: () => void;
}

function NumberField({
	className,
	icon,
	suffix,
	suffixClassName,
	disabled,
	dragSensitivity = "default",
	scrubRanges,
	scrubClamp,
	onScrub,
	onScrubEnd,
	value,
	allowExpressions = true,
	onKeyDown,
	onFocus,
	onBlur,
	onMouseDown,
	onReset,
	isDefault = false,
	onCancel,
	ref,
	...props
}: NumberFieldProps & { ref?: React.Ref<HTMLInputElement> }) {
	const iconRef = useRef<HTMLButtonElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const ghostRef = useRef<HTMLSpanElement>(null);
	const startValueRef = useRef(0);
	const cumulativeDeltaRef = useRef(0);
	// Escape calls onCancel then blurs to exit editing, but that blur must
	// NOT also run the normal commit-on-blur path (onBlur). This flag is set
	// synchronously right before the Escape-triggered blur() call and read
	// (then cleared) by the blur handler below.
	const isCancellingRef = useRef(false);
	const [isInputFocused, setIsInputFocused] = useState(false);
	const [suffixLeft, setSuffixLeft] = useState(0);
	const ghostValue = Array.isArray(value) ? value.join(", ") : String(value ?? "");

	useLayoutEffect(() => {
		if (!suffix) {
			setSuffixLeft(0);
			return;
		}
		if (!ghostRef.current || !inputRef.current) return;
		if (ghostRef.current.textContent !== ghostValue) {
			ghostRef.current.textContent = ghostValue;
		}
		const paddingLeft =
			parseFloat(getComputedStyle(inputRef.current).paddingLeft) || 0;
		setSuffixLeft(paddingLeft + ghostRef.current.offsetWidth);
	}, [ghostValue, suffix]);

	const { containerRef: wrapperRef } = useFocusLock<HTMLDivElement>({
		isActive: isInputFocused,
		onDismiss: () => inputRef.current?.blur(),
		cursor: "text",
		allowSelector: "input, textarea, [contenteditable]",
	});

	const handleIconPointerDown = (event: React.PointerEvent) => {
		if (!onScrub || disabled || event.button !== 0) return;
		const parsed = parseFloat(String(value ?? "0"));
		startValueRef.current = Number.isNaN(parsed) ? 0 : parsed;
		cumulativeDeltaRef.current = 0;
		// Pointer CAPTURE, not pointer lock: Chromium leaves the cursor
		// invisible after exitPointerLock until the next click, which read as
		// "my mouse disappeared" after every scrub.
		try {
			iconRef.current?.setPointerCapture(event.pointerId);
		} catch {
			// capture is best-effort; document listeners still track the drag
		}
		const previousCursor = document.body.style.cursor;
		document.body.style.cursor = "ew-resize";

		const handlePointerMove = (moveEvent: PointerEvent) => {
			const precisionMultiplier = getScrubPrecisionMultiplier({
				ctrlKey: moveEvent.ctrlKey,
				shiftKey: moveEvent.shiftKey,
			});
			// Scale THIS frame's movement only, then accumulate, so a modifier
			// pressed or released mid-drag changes sensitivity live without
			// retroactively rescaling pixels already accounted for.
			cumulativeDeltaRef.current += moveEvent.movementX * precisionMultiplier;
			const newValue = scrubRanges
				? scrubAcrossRanges({
						startValue: startValueRef.current,
						pixelDelta: cumulativeDeltaRef.current,
						ranges: scrubRanges,
						min: scrubClamp?.min,
						max: scrubClamp?.max,
					})
				: startValueRef.current +
					cumulativeDeltaRef.current * DRAG_SENSITIVITIES[dragSensitivity];
			onScrub(newValue);
		};

		const handlePointerUp = () => {
			document.removeEventListener("pointermove", handlePointerMove);
			document.removeEventListener("pointerup", handlePointerUp);
			document.body.style.cursor = previousCursor;
			onScrubEnd?.();
		};

		document.addEventListener("pointermove", handlePointerMove);
		document.addEventListener("pointerup", handlePointerUp);
	};

	const canScrub = Boolean(icon && onScrub);

	const inputNode = (
		<input
			type={allowExpressions ? "text" : "number"}
			inputMode={allowExpressions ? "decimal" : undefined}
			ref={inputRef}
			disabled={disabled}
			value={value}
			className="text-sm leading-none bg-transparent outline-none min-w-0 flex-1 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
			onMouseDown={(event) => {
				const inputElement = event.currentTarget;
				const shouldPreventNativeCaretPlacement =
					event.button === 0 && document.activeElement !== inputElement;
				if (shouldPreventNativeCaretPlacement) {
					event.preventDefault();
					inputElement.focus();
					inputElement.select();
				}
				onMouseDown?.(event);
			}}
			onFocus={(event) => {
				setIsInputFocused(true);
				event.currentTarget.select();
				onFocus?.(event);
			}}
			onKeyDown={(event) => {
				if (event.key === "Enter") {
					// Enter commits: blur runs the normal onBlur commit path.
					event.currentTarget.blur();
				} else if (event.key === "Escape") {
					// Escape reverts: run the distinct cancel path, then blur
					// WITHOUT letting that blur also commit.
					isCancellingRef.current = true;
					onCancel?.();
					event.currentTarget.blur();
				}
				onKeyDown?.(event);
			}}
			onBlur={(event) => {
				setIsInputFocused(false);
				if (isCancellingRef.current) {
					isCancellingRef.current = false;
				} else {
					onBlur?.(event);
				}
			}}
			{...props}
		/>
	);

	return (
		<div
			ref={wrapperRef}
			className={cn(
				"border-border bg-accent flex h-7 w-full min-w-0 items-center rounded-md border text-sm outline-none cursor-text disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 focus-within:border-primary focus-within:ring-0 focus-within:ring-primary/10 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
				disabled && "pointer-events-none cursor-not-allowed opacity-50",
				className,
			)}
		>
			{icon &&
				(canScrub ? (
					<button
						ref={iconRef}
						type="button"
						aria-label="Drag to adjust value"
						disabled={disabled}
						className="text-muted-foreground [&_svg]:size-3.5! shrink-0 select-none pl-2.5 text-sm leading-none cursor-ew-resize"
						onMouseDown={(event) => event.preventDefault()}
						onPointerDown={handleIconPointerDown}
					>
						{icon}
					</button>
				) : (
					<span className="text-muted-foreground [&_svg]:size-3.5! shrink-0 select-none pl-2.5 text-sm leading-none">
						{icon}
					</span>
				))}
			<span
				className={cn(
					"relative flex flex-1 min-w-0 items-center",
					icon ? "px-1.5" : "pl-2.5",
					onReset ? "pr-0" : "pr-2.5",
				)}
			>
				{inputNode}
				{suffix && (
					<>
						{/* Ghost mirrors value text to measure width for suffix positioning */}
						<span
							ref={ghostRef}
							className="invisible absolute text-sm leading-none whitespace-pre pointer-events-none"
							aria-hidden="true"
						>
							{ghostValue}
						</span>
						<span
							className={cn(
								"absolute top-1/2 -translate-y-1/2 select-none pointer-events-none text-sm leading-none",
								suffixClassName,
							)}
							style={{ left: suffixLeft + SUFFIX_GAP_PX }}
						>
							{suffix}
						</span>
					</>
				)}
			</span>
			{onReset && !isDefault && (
				<div className="shrink-0 pr-2 flex items-center">
					<Button
						variant="text"
						size="text"
						aria-label="Reset to default"
						onClick={onReset}
					>
						<HugeiconsIcon icon={ArrowTurnBackwardIcon} className="size-3.5!" />
					</Button>
				</div>
			)}
		</div>
	);
}

export { NumberField };
