"use client";

/**
 * Premiere-style Effect Controls: replaces the flat Transform tab with
 * collapsible fx groups (Motion, Opacity). Rows have a keyframe stopwatch,
 * the property name, and blue scrubbable values — Position shows X/Y on one
 * row, Scale gets a Uniform Scale checkbox like Premiere's Motion effect.
 */

import { useState } from "react";
import {
	getKeyframeAtTime,
	hasKeyframesForPath,
	resolveAnimationPathValueAtTime,
	upsertPathKeyframe,
} from "@/animation";
import type { AnimationPath } from "@/animation/types";
import { useElementPlayhead } from "@/components/editor/panels/properties/hooks/use-element-playhead";
import { useKeyframedParamProperty } from "@/components/editor/panels/properties/hooks/use-keyframed-param-property";
import { usePropertyDraft } from "@/components/editor/panels/properties/hooks/use-property-draft";
import { NumberField } from "@/components/ui/number-field";
import {
	Section,
	SectionContent,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
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
import { formatNumberForDisplay } from "@/utils/math";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	ArrowLeft01Icon,
	ArrowRight01Icon,
	KeyframeIcon,
	StopWatchIcon,
} from "@hugeicons/core-free-icons";
import { cn } from "@/utils/ui";

const POSITION_X = "transform.positionX";
const POSITION_Y = "transform.positionY";
const SCALE_X = "transform.scaleX";
const SCALE_Y = "transform.scaleY";
const ROTATE = "transform.rotate";
const OPACITY = "opacity";
const VOLUME = "volume";
const MUTED = "muted";

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
 * Row value control (W6 R1): the SAME NumberField the rest of the app uses
 * (Transform's old hand-rolled scrubbable number, with its hardcoded
 * text-sky-400 and disabled+dimmed reset, is retired). Wired the same way
 * property-param-field.tsx wires it: usePropertyDraft for typing/commit,
 * onScrub for the drag handle, onReset+isDefault for NumberField's own
 * hidden-at-default reset convention. Values display in scaled units (e.g.
 * scale 1.0 → 100.0); writes convert back to model units and clamp to the
 * param's range, same math as before, just funneled through NumberField.
 */
function PropertyValueField({
	resolved,
	factor,
	decimals,
	suffix,
	iconLabel,
	isDefault,
	minModel,
	maxModel,
	onPreviewModel,
	onCommit,
	onResetModel,
	className,
}: {
	resolved: number;
	factor: number;
	decimals: number;
	suffix?: string;
	iconLabel?: string;
	isDefault: boolean;
	minModel?: number;
	maxModel?: number;
	onPreviewModel: (modelValue: number) => void;
	onCommit: () => void;
	onResetModel?: () => void;
	className?: string;
}) {
	const displayValue = resolved * factor;

	const clampDisplayValue = (nextDisplayValue: number) => {
		let next = nextDisplayValue;
		if (minModel !== undefined) next = Math.max(minModel * factor, next);
		if (maxModel !== undefined) next = Math.min(maxModel * factor, next);
		return next;
	};

	/** Clamps in display units, writes the model-unit value. */
	const previewFromDisplay = (nextDisplayValue: number) => {
		onPreviewModel(clampDisplayValue(nextDisplayValue) / factor);
	};

	const draft = usePropertyDraft({
		displayValue: formatNumberForDisplay({
			value: displayValue,
			fractionDigits: decimals,
		}),
		parse: (input) => {
			const parsed = parseFloat(input);
			if (Number.isNaN(parsed)) return null;
			return clampDisplayValue(parsed);
		},
		onPreview: previewFromDisplay,
		onCommit,
	});

	return (
		<div className={cn("w-20 shrink-0", className)}>
			<NumberField
				icon={iconLabel}
				suffix={suffix}
				value={draft.displayValue}
				dragSensitivity="slow"
				isDefault={isDefault}
				onFocus={draft.onFocus}
				onChange={draft.onChange}
				onBlur={draft.onBlur}
				onCancel={draft.onCancel}
				onScrub={previewFromDisplay}
				onScrubEnd={onCommit}
				onReset={onResetModel}
			/>
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

/**
 * Twirl-down fx group (W6 R8): was a hand-rolled border/chevron button;
 * now the same Section/SectionHeader/SectionContent shell every other
 * properties tab uses, so Transform shares the boxed twirl-down rhythm.
 * Optional isAnyNonDefault/onResetGroup wire a group-level reset icon into
 * the header (W6 R3, single-row Opacity; group-reset follow-up, multi-row
 * Motion/Audio). Every group below uses it.
 */
function FxGroup({
	title,
	sectionKey,
	isAnyNonDefault,
	onResetGroup,
	children,
}: {
	title: string;
	sectionKey: string;
	isAnyNonDefault?: boolean;
	onResetGroup?: () => void;
	children: React.ReactNode;
}) {
	return (
		<Section collapsible sectionKey={sectionKey} showTopBorder={false}>
			<SectionHeader isAnyNonDefault={isAnyNonDefault} onResetGroup={onResetGroup}>
				<span className="text-[10px] font-bold italic text-primary/80 mr-1.5">
					fx
				</span>
				<SectionTitle>{title}</SectionTitle>
			</SectionHeader>
			<SectionContent>
				<SectionFields>{children}</SectionFields>
			</SectionContent>
		</Section>
	);
}

/**
 * Pure resolved-value/default/reset logic for one keyframable scalar property
 * (Rotation, Opacity, Level). Factored out of the row renderer (W6 group-reset
 * follow-up) so the parent (`EffectControlsTab`) can call the SAME function to
 * aggregate a group's "any row non-default" state and build its combined
 * reset. Identical inputs (ctx + paramKey) always resolve to the identical
 * value/default, so a group's reset button and `SingleRow`'s own per-row reset
 * can never disagree about what "default" means for that property.
 */
function useSingleValueState({
	ctx,
	paramKey,
}: {
	ctx: RowContext;
	paramKey: string;
}) {
	const { element, trackId, localTime, isPlayheadWithinElementRange } = ctx;
	const param = findParam(element, paramKey);
	const fallbackParam: ElementParamDefinition =
		param ??
		({ key: paramKey, label: paramKey, type: "number", default: 0 } as ElementParamDefinition);
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
	const defaultNumber =
		typeof fallbackParam.default === "number" ? fallbackParam.default : 0;

	return {
		param,
		resolvedNumber,
		defaultNumber,
		isDefault: !param || resolvedNumber === defaultNumber,
		onPreview: animated.onPreview,
		onCommit: animated.onCommit,
		onReset: () => {
			animated.onPreview(defaultNumber);
			animated.onCommit();
		},
	};
}

/** One keyframable scalar property (Rotation, Opacity, Level): renders a row
 * around `useSingleValueState`'s resolved/default/reset logic. */
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
	const state = useSingleValueState({ ctx, paramKey });
	const { param, resolvedNumber, isDefault, onPreview, onCommit, onReset } = state;
	const kfGroup = useKfGroup({
		ctx,
		entries: [{ path: paramKey, value: resolvedNumber }],
	});
	if (!param) return null;

	return (
		<Row label={label} stopwatch={<Stopwatch group={kfGroup} label={label} />}>
			<KfNav group={kfGroup} />
			<PropertyValueField
				resolved={resolvedNumber}
				factor={factor}
				decimals={decimals}
				suffix={suffix}
				iconLabel={iconLabel}
				{...paramRange(param)}
				isDefault={isDefault}
				onPreviewModel={(v) => onPreview(v)}
				onCommit={onCommit}
				onResetModel={onReset}
			/>
		</Row>
	);
}

/**
 * Pure resolved-value/default/reset logic for Position (X + Y). Same lift
 * rationale as `useSingleValueState` above: the parent's Motion group-reset
 * aggregates this SAME computation, so it can never disagree with
 * `PositionRow`'s own per-axis reset about what "default" means.
 */
function usePositionState({ ctx }: { ctx: RowContext }) {
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
	const defaultX = typeof paramX?.default === "number" ? paramX.default : 0;
	const defaultY = typeof paramY?.default === "number" ? paramY.default : 0;

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
	const previewX = (value: number) => {
		if (paramX) previewAxis(paramX, POSITION_X, value);
	};
	const previewY = (value: number) => {
		if (paramY) previewAxis(paramY, POSITION_Y, value);
	};

	return {
		paramX,
		paramY,
		x,
		y,
		defaultX,
		defaultY,
		isDefaultX: !paramX || x === defaultX,
		isDefaultY: !paramY || y === defaultY,
		isAnyNonDefault:
			Boolean(paramX && paramY) && (x !== defaultX || y !== defaultY),
		previewX,
		previewY,
		commit,
		resetX: () => {
			previewX(defaultX);
			commit();
		},
		resetY: () => {
			previewY(defaultY);
			commit();
		},
	};
}

/** Position: X and Y side by side, one stopwatch for both channels. */
function PositionRow({ ctx }: { ctx: RowContext }) {
	const pos = usePositionState({ ctx });
	const { paramX, paramY, x, y, isDefaultX, isDefaultY, previewX, previewY, commit } = pos;
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
			<PropertyValueField
				resolved={x}
				factor={1}
				decimals={1}
				iconLabel="X"
				{...paramRange(paramX)}
				isDefault={isDefaultX}
				onPreviewModel={previewX}
				onCommit={commit}
				onResetModel={pos.resetX}
			/>
			<PropertyValueField
				resolved={y}
				factor={1}
				decimals={1}
				iconLabel="Y"
				{...paramRange(paramY)}
				isDefault={isDefaultY}
				onPreviewModel={previewY}
				onCommit={commit}
				onResetModel={pos.resetY}
			/>
			<button
				type="button"
				title="Center horizontally in frame"
				className="text-muted-foreground hover:text-foreground px-0.5 text-[10px]"
				onClick={() => {
					previewX(0);
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
					previewY(0);
					commit();
				}}
			>
				⇕
			</button>
		</Row>
	);
}

/**
 * Pure resolved-value/default/reset logic for Scale (X + Y). Same lift as
 * `usePositionState` above. The Uniform Scale checkbox stays LOCAL UI state in
 * `ScaleRows` (it only picks which axis a live scrub drives, never what
 * "default" means), so it is deliberately NOT part of this shared computation.
 * A group reset always restores BOTH axes regardless of that toggle.
 */
function useScaleState({ ctx }: { ctx: RowContext }) {
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
	const defaultScale = typeof paramX?.default === "number" ? paramX.default : 1;

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

	return {
		paramX,
		paramY,
		sx,
		sy,
		defaultScale,
		isDefaultSx: !paramX || sx === defaultScale,
		isDefaultSy: !paramY || sy === defaultScale,
		isAnyNonDefault:
			Boolean(paramX && paramY) && (sx !== defaultScale || sy !== defaultScale),
		previewScale,
		commit,
		resetBoth: () => {
			previewScale(defaultScale, "both");
			commit();
		},
	};
}

/**
 * Scale with Premiere's Uniform Scale behavior: checked → one "Scale" value
 * drives both axes; unchecked → separate Scale Height / Scale Width rows.
 */
function ScaleRows({ ctx }: { ctx: RowContext }) {
	const scaleState = useScaleState({ ctx });
	const { paramX, paramY, sx, sy, defaultScale, isDefaultSx, isDefaultSy, previewScale, commit } =
		scaleState;
	const [uniform, setUniform] = useState(sx === sy);
	const kfGroup = useKfGroup({
		ctx,
		entries: [
			{ path: SCALE_X, value: sx },
			{ path: SCALE_Y, value: sy },
		],
	});

	if (!paramX || !paramY) return null;

	return (
		<>
			<Row
				label={uniform ? "Scale" : "Scale Height"}
				stopwatch={<Stopwatch group={kfGroup} label="scale" />}
			>
				<KfNav group={kfGroup} />
				<PropertyValueField
					resolved={sy}
					factor={100}
					decimals={1}
					iconLabel="S"
					{...paramRange(paramY)}
					isDefault={uniform ? isDefaultSx && isDefaultSy : isDefaultSy}
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
					<PropertyValueField
						resolved={sx}
						factor={100}
						decimals={1}
						iconLabel="W"
						{...paramRange(paramX)}
						isDefault={isDefaultSx}
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
	const editor = useEditor();

	// Group-level reset (W6 follow-up): Motion and Audio are MULTI-ROW groups, so
	// their header reset aggregates each row's OWN resolved/default computation:
	// usePositionState/useScaleState/useSingleValueState, the SAME hooks the rows
	// below call to render themselves. So a group's "non-default" flag and its
	// reset action can never disagree with any individual row's.
	const positionState = usePositionState({ ctx });
	const scaleState = useScaleState({ ctx });
	const rotationState = useSingleValueState({ ctx, paramKey: ROTATE });
	const opacityState = useSingleValueState({ ctx, paramKey: OPACITY });
	// Volume only exists on some element types; the hook is still called
	// unconditionally (Rules of Hooks) and resolves to isDefault=true (no
	// contribution) when the element has no volume param.
	const volumeState = useSingleValueState({ ctx, paramKey: VOLUME });

	const motionIsAnyNonDefault =
		positionState.isAnyNonDefault ||
		scaleState.isAnyNonDefault ||
		!rotationState.isDefault;
	const resetMotionGroup = () => {
		// Preview every field first, ONE commit last: commitPreview() flushes the
		// whole accumulated preview overlay as a single TracksSnapshotCommand, so
		// resetting Position + Scale + Rotation together is one undo step, not three.
		positionState.previewX(positionState.defaultX);
		positionState.previewY(positionState.defaultY);
		scaleState.previewScale(scaleState.defaultScale, "both");
		rotationState.onPreview(rotationState.defaultNumber);
		editor.timeline.commitPreview();
	};

	// Audio's group reset covers Level (the only field with a per-row reset
	// affordance). Mute is a plain on/off bypass with no reset button of its own,
	// so it's deliberately left out of "non-default" here: the group flag would
	// otherwise promise a reset the row itself can't deliver (see PATCHES.md).
	const audioIsAnyNonDefault = !volumeState.isDefault;

	return (
		<div className="flex flex-col px-2 pt-2">
			<FxGroup
				title="Motion"
				sectionKey="effect-controls:motion"
				isAnyNonDefault={motionIsAnyNonDefault}
				onResetGroup={resetMotionGroup}
			>
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
			</FxGroup>
			<FxGroup
				title="Opacity"
				sectionKey="effect-controls:opacity"
				isAnyNonDefault={!opacityState.isDefault}
				onResetGroup={opacityState.onReset}
			>
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
				<FxGroup
					title="Audio"
					sectionKey="effect-controls:audio"
					isAnyNonDefault={audioIsAnyNonDefault}
					onResetGroup={volumeState.onReset}
				>
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
