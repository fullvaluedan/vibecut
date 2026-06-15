"use client";

/**
 * Premiere-style Effect Controls: replaces the flat Transform tab with
 * collapsible fx groups (Motion, Opacity). Rows have a keyframe stopwatch,
 * the property name, and blue scrubbable values — Position shows X/Y on one
 * row, Scale gets a Uniform Scale checkbox like Premiere's Motion effect.
 */

import { useEffect, useRef, useState } from "react";
import {
	getKeyframeAtTime,
	hasKeyframesForPath,
	resolveAnimationPathValueAtTime,
	upsertPathKeyframe,
} from "@/animation";
import type { AnimationPath } from "@/animation/types";
import { useElementPlayhead } from "@/components/editor/panels/properties/hooks/use-element-playhead";
import { useKeyframedParamProperty } from "@/components/editor/panels/properties/hooks/use-keyframed-param-property";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useEditor } from "@/editor/use-editor";
import { UpdateElementsCommand } from "@/commands/timeline/element/update-elements";
import {
	balanceTimelineAudio,
	enhanceClipAudio,
} from "@/features/editing/audio-enhance";
import {
	coerceParamValue,
	getParamChannelLayout,
} from "@/params";
import {
	getElementParams,
	readElementParamValue,
	writeElementParamValue,
	type ElementParamDefinition,
} from "@/params/registry";
import type { TimelineElement, VisualElement } from "@/timeline";
import type { MediaTime } from "@/wasm";
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

const POSITION_X = "transform.positionX";
const POSITION_Y = "transform.positionY";
const ANCHOR_X = "transform.anchorX";
const ANCHOR_Y = "transform.anchorY";
const SCALE_X = "transform.scaleX";
const SCALE_Y = "transform.scaleY";
const ROTATE = "transform.rotate";
const OPACITY = "opacity";
const VOLUME = "volume";
const MUTED = "muted";

/** Pixels of horizontal drag per display-unit step while scrubbing. */
const SCRUB_PX_PER_STEP = 2;

interface RowContext {
	element: VisualElement;
	trackId: string;
	localTime: MediaTime;
	isPlayheadWithinElementRange: boolean;
}

function findParam(
	element: TimelineElement,
	key: string,
): ElementParamDefinition | null {
	return getElementParams({ element }).find((p) => p.key === key) ?? null;
}

function formatDisplay(value: number, decimals: number): string {
	return value.toFixed(decimals);
}

function paramRange(param: ElementParamDefinition): {
	minModel?: number;
	maxModel?: number;
} {
	const candidate = param as { min?: number; max?: number };
	return {
		minModel: typeof candidate.min === "number" ? candidate.min : undefined,
		maxModel: typeof candidate.max === "number" ? candidate.max : undefined,
	};
}

/**
 * Premiere keyframe model for one property (or an X/Y pair sharing one
 * stopwatch). The stopwatch turns animation on/off — OFF removes every
 * keyframe on the property. ◀ ◆ ▶ navigate keyframes and toggle one at
 * the playhead.
 */
function useKfGroup({
	ctx,
	entries,
}: {
	ctx: RowContext;
	entries: { path: string; value: number }[];
}) {
	const { element, trackId, localTime, isPlayheadWithinElementRange } = ctx;
	const editor = useEditor();
	const channels = entries.map((entry) => ({
		...entry,
		keys: ((element.animations?.[entry.path as AnimationPath] as
			| { keys?: { id: string; time: number }[] }
			| undefined)?.keys ?? []) as { id: string; time: number }[],
	}));
	const animated = channels.some((c) => c.keys.length > 0);
	const atPlayhead = entries.map((entry) => ({
		path: entry.path,
		kf: getKeyframeAtTime({
			animations: element.animations,
			propertyPath: entry.path,
			time: localTime,
		}),
	}));
	const anyAtPlayhead = atPlayhead.some((a) => a.kf);
	const allTimes = [
		...new Set(channels.flatMap((c) => c.keys.map((k) => k.time))),
	].sort((a, b) => a - b);
	const EPSILON = 2; // ticks
	const prevTime = [...allTimes].reverse().find((t) => t < localTime - EPSILON);
	const nextTime = allTimes.find((t) => t > localTime + EPSILON);

	const addAllAtPlayhead = () =>
		editor.timeline.upsertKeyframes({
			keyframes: entries.map((entry) => ({
				trackId,
				elementId: element.id,
				propertyPath: entry.path as AnimationPath,
				time: localTime,
				value: entry.value,
			})),
		});

	const toggleAnimation = () => {
		if (animated) {
			editor.timeline.removeKeyframes({
				keyframes: channels.flatMap((c) =>
					c.keys.map((k) => ({
						trackId,
						elementId: element.id,
						propertyPath: c.path as AnimationPath,
						keyframeId: k.id,
					})),
				),
			});
			return;
		}
		if (!isPlayheadWithinElementRange) return;
		addAllAtPlayhead();
	};

	const toggleAtPlayhead = () => {
		if (!isPlayheadWithinElementRange) return;
		if (anyAtPlayhead) {
			editor.timeline.removeKeyframes({
				keyframes: atPlayhead
					.filter((a) => a.kf)
					.map((a) => ({
						trackId,
						elementId: element.id,
						propertyPath: a.path as AnimationPath,
						keyframeId: (a.kf as { id: string }).id,
					})),
			});
			return;
		}
		addAllAtPlayhead();
	};

	const seekToLocal = (t: number | undefined) => {
		if (t === undefined) return;
		editor.playback.seek({
			time: (element.startTime + t) as typeof element.startTime,
		});
	};

	return {
		animated,
		anyAtPlayhead,
		hasPrev: prevTime !== undefined,
		hasNext: nextTime !== undefined,
		within: isPlayheadWithinElementRange,
		toggleAnimation,
		toggleAtPlayhead,
		goPrev: () => seekToLocal(prevTime),
		goNext: () => seekToLocal(nextTime),
	};
}

type KfGroup = ReturnType<typeof useKfGroup>;

function Stopwatch({ group, label }: { group: KfGroup; label: string }) {
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

function KfNav({ group }: { group: KfGroup }) {
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
function ValueField({
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
	const display = scrubText ?? formatDisplay(resolved * factor, decimals);

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
				setScrubText(formatDisplay(shown, decimals));
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
								setDraft(formatDisplay(resolved * factor + step, decimals));
							}
							if (e.key === "ArrowDown") {
								e.preventDefault();
								nudge(-1);
								setDraft(formatDisplay(resolved * factor - step, decimals));
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

function Row({
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

function FxGroup({
	title,
	children,
}: {
	title: string;
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
				<span className="text-[10px] font-bold italic text-primary/80">fx</span>
				<span className="text-xs font-semibold">{title}</span>
			</button>
			{open && <div className="flex flex-col">{children}</div>}
		</div>
	);
}

/** One keyframable scalar property (Rotation, Opacity). */
function SingleRow({
	ctx,
	paramKey,
	label,
	factor,
	decimals,
	suffix,
	iconLabel,
}: {
	ctx: RowContext;
	paramKey: string;
	label: string;
	factor: number;
	decimals: number;
	suffix?: string;
	iconLabel?: string;
}) {
	const { element, trackId, localTime, isPlayheadWithinElementRange } = ctx;
	const param = findParam(element, paramKey);
	const fallbackParam: ElementParamDefinition =
		param ??
		({ key: paramKey, label, type: "number", default: 0 } as ElementParamDefinition);
	const baseValue =
		(param ? readElementParamValue({ element, param }) : null) ??
		fallbackParam.default;
	const resolved = resolveAnimationPathValueAtTime({
		animations: element.animations,
		propertyPath: paramKey,
		localTime,
		fallbackValue: baseValue,
	});
	const animated = useKeyframedParamProperty({
		param: fallbackParam,
		trackId,
		elementId: element.id,
		animations: element.animations,
		propertyPath: paramKey as AnimationPath,
		localTime,
		isPlayheadWithinElementRange,
		resolvedValue: resolved,
		buildBaseUpdates: ({ value }) =>
			writeElementParamValue({ element, param: fallbackParam, value }),
	});
	const resolvedNumber = typeof resolved === "number" ? resolved : 0;
	const kfGroup = useKfGroup({
		ctx,
		entries: [{ path: paramKey, value: resolvedNumber }],
	});
	if (!param) return null;
	const defaultNumber =
		typeof param.default === "number" ? param.default : 0;

	return (
		<Row label={label} stopwatch={<Stopwatch group={kfGroup} label={label} />}>
			<KfNav group={kfGroup} />
			<ValueField
				resolved={resolvedNumber}
				factor={factor}
				decimals={decimals}
				suffix={suffix}
				iconLabel={iconLabel}
				{...paramRange(param)}
				isDefault={resolvedNumber === defaultNumber}
				onPreviewModel={(v) => animated.onPreview(v)}
				onCommit={animated.onCommit}
				onResetModel={() => {
					animated.onPreview(defaultNumber);
					animated.onCommit();
				}}
			/>
		</Row>
	);
}

/** Position: X and Y side by side, one stopwatch for both channels. */
function PositionRow({ ctx }: { ctx: RowContext }) {
	const { element, trackId, localTime, isPlayheadWithinElementRange } = ctx;
	const editor = useEditor();
	const paramX = findParam(element, POSITION_X);
	const paramY = findParam(element, POSITION_Y);

	const resolve = (key: string, param: ElementParamDefinition | null) => {
		const base =
			(param ? readElementParamValue({ element, param }) : null) ??
			param?.default ??
			0;
		const value = resolveAnimationPathValueAtTime({
			animations: element.animations,
			propertyPath: key,
			localTime,
			fallbackValue: base,
		});
		return typeof value === "number" ? value : 0;
	};
	const x = resolve(POSITION_X, paramX);
	const y = resolve(POSITION_Y, paramY);

	const previewAxis = (
		param: ElementParamDefinition,
		key: AnimationPath,
		value: number,
	) => {
		const animatedChannel =
			hasKeyframesForPath({
				animations: element.animations,
				propertyPath: key,
			}) && isPlayheadWithinElementRange;
		if (animatedChannel) {
			editor.timeline.previewElements({
				updates: [
					{
						trackId,
						elementId: element.id,
						updates: {
							animations: upsertPathKeyframe({
								animations: element.animations,
								propertyPath: key,
								time: localTime,
								value,
								channelLayout: getParamChannelLayout({ param }),
								coerceValue: ({ value: next }) =>
									coerceParamValue({ param, value: next }),
							}),
						},
					},
				],
			});
			return;
		}
		editor.timeline.previewElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					updates: writeElementParamValue({ element, param, value }),
				},
			],
		});
	};

	const commit = () => editor.timeline.commitPreview();
	const kfGroup = useKfGroup({
		ctx,
		entries: [
			{ path: POSITION_X, value: x },
			{ path: POSITION_Y, value: y },
		],
	});

	if (!paramX || !paramY) return null;

	return (
		<Row
			label="Position"
			stopwatch={<Stopwatch group={kfGroup} label="position" />}
		>
			<KfNav group={kfGroup} />
			<ValueField
				resolved={x}
				factor={1}
				decimals={1}
				iconLabel="X"
				{...paramRange(paramX)}
				isDefault={x === paramX.default}
				onPreviewModel={(v) => previewAxis(paramX, POSITION_X, v)}
				onCommit={commit}
				onResetModel={() => {
					previewAxis(paramX, POSITION_X, Number(paramX.default) || 0);
					commit();
				}}
			/>
			<ValueField
				resolved={y}
				factor={1}
				decimals={1}
				iconLabel="Y"
				{...paramRange(paramY)}
				isDefault={y === paramY.default}
				onPreviewModel={(v) => previewAxis(paramY, POSITION_Y, v)}
				onCommit={commit}
				onResetModel={() => {
					previewAxis(paramY, POSITION_Y, Number(paramY.default) || 0);
					commit();
				}}
			/>
			<button
				type="button"
				title="Center horizontally in frame"
				className="text-muted-foreground hover:text-foreground px-0.5 text-[10px]"
				onClick={() => {
					previewAxis(paramX, POSITION_X, 0);
					commit();
				}}
			>
				⇔
			</button>
			<button
				type="button"
				title="Center vertically in frame"
				className="text-muted-foreground hover:text-foreground px-0.5 text-[10px]"
				onClick={() => {
					previewAxis(paramY, POSITION_Y, 0);
					commit();
				}}
			>
				⇕
			</button>
		</Row>
	);
}

/**
 * Anchor Point: X and Y side by side, one stopwatch for both channels — the
 * pivot for scale/rotation, in element-local pixels offset from the center.
 * Mirrors PositionRow; (0,0) is the default (center) and is export-safe.
 */
function AnchorRow({ ctx }: { ctx: RowContext }) {
	const { element, trackId, localTime, isPlayheadWithinElementRange } = ctx;
	const editor = useEditor();
	const paramX = findParam(element, ANCHOR_X);
	const paramY = findParam(element, ANCHOR_Y);

	const resolve = (key: string, param: ElementParamDefinition | null) => {
		const base =
			(param ? readElementParamValue({ element, param }) : null) ??
			param?.default ??
			0;
		const value = resolveAnimationPathValueAtTime({
			animations: element.animations,
			propertyPath: key,
			localTime,
			fallbackValue: base,
		});
		return typeof value === "number" ? value : 0;
	};
	const x = resolve(ANCHOR_X, paramX);
	const y = resolve(ANCHOR_Y, paramY);

	const previewAxis = (
		param: ElementParamDefinition,
		key: AnimationPath,
		value: number,
	) => {
		const animatedChannel =
			hasKeyframesForPath({
				animations: element.animations,
				propertyPath: key,
			}) && isPlayheadWithinElementRange;
		if (animatedChannel) {
			editor.timeline.previewElements({
				updates: [
					{
						trackId,
						elementId: element.id,
						updates: {
							animations: upsertPathKeyframe({
								animations: element.animations,
								propertyPath: key,
								time: localTime,
								value,
								channelLayout: getParamChannelLayout({ param }),
								coerceValue: ({ value: next }) =>
									coerceParamValue({ param, value: next }),
							}),
						},
					},
				],
			});
			return;
		}
		editor.timeline.previewElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					updates: writeElementParamValue({ element, param, value }),
				},
			],
		});
	};

	const commit = () => editor.timeline.commitPreview();
	const kfGroup = useKfGroup({
		ctx,
		entries: [
			{ path: ANCHOR_X, value: x },
			{ path: ANCHOR_Y, value: y },
		],
	});

	if (!paramX || !paramY) return null;

	return (
		<Row
			label="Anchor Point"
			stopwatch={<Stopwatch group={kfGroup} label="anchor point" />}
		>
			<KfNav group={kfGroup} />
			<ValueField
				resolved={x}
				factor={1}
				decimals={1}
				iconLabel="X"
				{...paramRange(paramX)}
				isDefault={x === paramX.default}
				onPreviewModel={(v) => previewAxis(paramX, ANCHOR_X, v)}
				onCommit={commit}
				onResetModel={() => {
					previewAxis(paramX, ANCHOR_X, Number(paramX.default) || 0);
					commit();
				}}
			/>
			<ValueField
				resolved={y}
				factor={1}
				decimals={1}
				iconLabel="Y"
				{...paramRange(paramY)}
				isDefault={y === paramY.default}
				onPreviewModel={(v) => previewAxis(paramY, ANCHOR_Y, v)}
				onCommit={commit}
				onResetModel={() => {
					previewAxis(paramY, ANCHOR_Y, Number(paramY.default) || 0);
					commit();
				}}
			/>
		</Row>
	);
}

/**
 * Scale with Premiere's Uniform Scale behavior: checked → one "Scale" value
 * drives both axes; unchecked → separate Scale Height / Scale Width rows.
 */
function ScaleRows({ ctx }: { ctx: RowContext }) {
	const { element, trackId, localTime, isPlayheadWithinElementRange } = ctx;
	const editor = useEditor();
	const paramX = findParam(element, SCALE_X);
	const paramY = findParam(element, SCALE_Y);

	const resolve = (key: string, param: ElementParamDefinition | null) => {
		const base =
			(param ? readElementParamValue({ element, param }) : null) ??
			param?.default ??
			1;
		const value = resolveAnimationPathValueAtTime({
			animations: element.animations,
			propertyPath: key,
			localTime,
			fallbackValue: base,
		});
		return typeof value === "number" ? value : 1;
	};
	const sx = resolve(SCALE_X, paramX);
	const sy = resolve(SCALE_Y, paramY);
	const [uniform, setUniform] = useState(sx === sy);

	const previewAxis = (
		param: ElementParamDefinition,
		key: AnimationPath,
		value: number,
		baseElement: TimelineElement,
	): { animations?: TimelineElement["animations"]; element: TimelineElement } => {
		const animatedChannel =
			hasKeyframesForPath({
				animations: element.animations,
				propertyPath: key,
			}) && isPlayheadWithinElementRange;
		if (animatedChannel) {
			return {
				element: baseElement,
				animations: upsertPathKeyframe({
					animations: baseElement.animations,
					propertyPath: key,
					time: localTime,
					value,
					channelLayout: getParamChannelLayout({ param }),
					coerceValue: ({ value: next }) =>
						coerceParamValue({ param, value: next }),
				}),
			};
		}
		return {
			element: writeElementParamValue({ element: baseElement, param, value }),
		};
	};

	const previewScale = (value: number, axes: "both" | "x" | "y") => {
		if (!paramX || !paramY) return;
		let working: TimelineElement = element;
		if (axes === "both" || axes === "x") {
			const out = previewAxis(paramX, SCALE_X, value, working);
			working = out.animations
				? { ...out.element, animations: out.animations }
				: out.element;
		}
		if (axes === "both" || axes === "y") {
			const out = previewAxis(paramY, SCALE_Y, value, working);
			working = out.animations
				? { ...out.element, animations: out.animations }
				: out.element;
		}
		editor.timeline.previewElements({
			updates: [{ trackId, elementId: element.id, updates: working }],
		});
	};
	const commit = () => editor.timeline.commitPreview();
	const kfGroup = useKfGroup({
		ctx,
		entries: [
			{ path: SCALE_X, value: sx },
			{ path: SCALE_Y, value: sy },
		],
	});

	if (!paramX || !paramY) return null;
	const defaultScale = Number(paramX.default) || 1;

	return (
		<>
			<Row
				label={uniform ? "Scale" : "Scale Height"}
				stopwatch={<Stopwatch group={kfGroup} label="scale" />}
			>
				<KfNav group={kfGroup} />
				<ValueField
					resolved={sy}
					factor={100}
					decimals={1}
					iconLabel="S"
					{...paramRange(paramY)}
					isDefault={uniform ? sx === defaultScale && sy === defaultScale : sy === defaultScale}
					onPreviewModel={(v) => previewScale(v, uniform ? "both" : "y")}
					onCommit={commit}
					onResetModel={() => {
						previewScale(defaultScale, uniform ? "both" : "y");
						commit();
					}}
				/>
			</Row>
			<Row label="Scale Width">
				<div className={cn(uniform && "pointer-events-none opacity-40")}>
					<ValueField
						resolved={sx}
						factor={100}
						decimals={1}
						iconLabel="W"
						{...paramRange(paramX)}
						isDefault={sx === defaultScale}
						onPreviewModel={(v) => previewScale(v, "x")}
						onCommit={commit}
						onResetModel={() => {
							previewScale(defaultScale, "x");
							commit();
						}}
					/>
				</div>
			</Row>
			<Row label="">
				<label className="flex cursor-pointer items-center gap-2 text-xs text-foreground/75">
					<Checkbox
						checked={uniform}
						onCheckedChange={(checked) => {
							const next = checked === true;
							setUniform(next);
							if (next && sx !== sy) {
								previewScale(sy, "both");
								commit();
							}
						}}
					/>
					Uniform Scale
				</label>
			</Row>
		</>
	);
}

/** Mute checkbox row (Premiere's Channel Volume "Bypass" equivalent). */
function MuteRow({ ctx }: { ctx: RowContext }) {
	const { element, trackId } = ctx;
	const editor = useEditor();
	const param = findParam(element, MUTED);
	if (!param) return null;
	const muted = readElementParamValue({ element, param }) === true;
	const setMuted = (next: boolean) => {
		editor.command.execute({
			command: new UpdateElementsCommand({
				updates: [
					{
						trackId,
						elementId: element.id,
						patch: {
							params: {
								...("params" in element ? element.params : {}),
								muted: next,
							},
						} as Partial<TimelineElement>,
					},
				],
			}),
		});
	};
	return (
		<Row label="">
			<label className="flex cursor-pointer items-center gap-2 text-xs text-foreground/75">
				<Checkbox
					checked={muted}
					onCheckedChange={(checked) => setMuted(checked === true)}
				/>
				Mute
			</label>
		</Row>
	);
}

/** One-click loudness tools: enhance this clip / balance the whole timeline. */
function AudioToolsRow({ ctx }: { ctx: RowContext }) {
	const { element, trackId } = ctx;
	const editor = useEditor();
	const [busy, setBusy] = useState<string | null>(null);

	const run = async (label: string, fn: () => Promise<string>) => {
		if (busy) return;
		setBusy(label);
		const toastId = toast.loading(`${label}...`);
		try {
			const message = await fn();
			toast.success(message, {
				id: toastId,
				description: "Ctrl+Z restores the previous levels.",
			});
		} catch (e) {
			toast.error(`${label} failed`, {
				id: toastId,
				description: e instanceof Error ? e.message : String(e),
			});
		} finally {
			setBusy(null);
		}
	};

	return (
		<div className="flex flex-col gap-1.5 py-1 pl-7 pr-2">
			<Button
				variant="outline"
				size="sm"
				disabled={!!busy}
				onClick={() =>
					void run("Enhance audio", async () => {
						const { volumeDb } = await enhanceClipAudio({
							editor,
							trackId,
							element,
						});
						return `Enhanced — level set to ${volumeDb.toFixed(1)} dB`;
					})
				}
			>
				{busy === "Enhance audio" ? "Enhancing..." : "Enhance audio"}
			</Button>
			<Button
				variant="outline"
				size="sm"
				disabled={!!busy}
				onClick={() =>
					void run("Balance all clips", async () => {
						const { adjusted } = await balanceTimelineAudio({ editor });
						return `Balanced ${adjusted} clip${adjusted === 1 ? "" : "s"} to the same loudness`;
					})
				}
			>
				{busy === "Balance all clips" ? "Balancing..." : "Balance all clips"}
			</Button>
			<p className="text-muted-foreground text-[0.65rem]">
				Enhance levels this clip's speech to a dialog target; Balance evens
				out every clip on the timeline.
			</p>
		</div>
	);
}

export function EffectControlsTab({
	element,
	trackId,
}: {
	element: VisualElement;
	trackId: string;
}) {
	const { localTime, isPlayheadWithinElementRange } = useElementPlayhead({
		startTime: element.startTime,
		duration: element.duration,
	});
	const ctx: RowContext = {
		element,
		trackId,
		localTime,
		isPlayheadWithinElementRange,
	};

	return (
		<div className="flex flex-col px-2 pt-2">
			<FxGroup title="Motion">
				<PositionRow ctx={ctx} />
				<ScaleRows ctx={ctx} />
				<SingleRow
					ctx={ctx}
					paramKey={ROTATE}
					label="Rotation"
					factor={1}
					decimals={1}
					suffix="°"
					iconLabel="∠"
				/>
				<AnchorRow ctx={ctx} />
			</FxGroup>
			<FxGroup title="Opacity">
				<SingleRow
					ctx={ctx}
					paramKey={OPACITY}
					label="Opacity"
					factor={100}
					decimals={0}
					suffix="%"
					iconLabel="O"
				/>
			</FxGroup>
			{findParam(element, VOLUME) && (
				<FxGroup title="Audio">
					<SingleRow
						ctx={ctx}
						paramKey={VOLUME}
						label="Level"
						factor={1}
						decimals={1}
						suffix=" dB"
						iconLabel="♪"
					/>
					<MuteRow ctx={ctx} />
					<AudioToolsRow ctx={ctx} />
				</FxGroup>
			)}
			<p className="text-muted-foreground px-1 pt-2 text-[0.65rem]">
				Drag a blue value to scrub it, click to type. The diamond sets a
				keyframe at the playhead — open the clip's keyframe lanes on the
				timeline to fine-tune curves.
			</p>
		</div>
	);
}
