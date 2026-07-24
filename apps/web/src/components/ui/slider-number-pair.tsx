"use client";

import { Slider } from "@/components/ui/slider";
import { NumberField } from "@/components/ui/number-field";
import { usePropertyDraft } from "@/components/editor/panels/properties/hooks/use-property-draft";
import {
	clamp,
	formatNumberForDisplay,
	getFractionDigitsForStep,
	snapToStep,
} from "@/utils/math";
import { cn } from "@/utils/ui";

/**
 * Pure clamp+snap shared by both halves of the pair, so the slider thumb and
 * the typed number always converge on the same value regardless of which
 * control produced it (the "one onPreview/onCommit contract" W6 R4 asks
 * for). Exported for unit testing.
 */
export function clampSliderNumberValue({
	value,
	min,
	max,
	step,
}: {
	value: number;
	min: number;
	max: number;
	step: number;
}): number {
	return clamp({ value: snapToStep({ value, step }), min, max });
}

/**
 * C4 fix: BOTH halves must show the SAME number for an out-of-range value
 * (e.g. a timeline trim pushes a motion template's duration outside its
 * declared durationRange with no clamp of its own). Previously the Slider
 * read `clampSliderNumberValue(value)` while the NumberField's draft read the
 * raw `value`, so an out-of-range value displayed two different numbers. One
 * clamped value now feeds both halves. Exported for a headless unit test
 * (this repo's `bun test` suite has no DOM).
 */
export function resolveSliderNumberPairDisplay({
	value,
	min,
	max,
	step,
	maxFractionDigits,
}: {
	value: number;
	min: number;
	max: number;
	step: number;
	maxFractionDigits: number;
}): { sliderValue: number; numberFieldDisplay: string } {
	const sliderValue = clampSliderNumberValue({ value, min, max, step });
	return {
		sliderValue,
		numberFieldDisplay: formatNumberForDisplay({
			value: sliderValue,
			maxFractionDigits,
		}),
	};
}

interface SliderNumberPairProps {
	value: number;
	min: number;
	max: number;
	step?: number;
	icon?: React.ReactNode;
	suffix?: string;
	disabled?: boolean;
	className?: string;
	isDefault?: boolean;
	onReset?: () => void;
	onPreview: (value: number) => void;
	onCommit: () => void;
}

/**
 * Radix Slider + NumberField sharing one value: dragging the slider previews
 * the number field's display, typing in the number field moves the slider.
 * Bounded numeric params (both min and max declared) auto-get this pairing;
 * see property-param-field.tsx.
 */
export function SliderNumberPair({
	value,
	min,
	max,
	step = 1,
	icon,
	suffix,
	disabled,
	className,
	isDefault,
	onReset,
	onPreview,
	onCommit,
}: SliderNumberPairProps) {
	const maxFractionDigits = getFractionDigitsForStep({ step });
	const clampValue = (nextValue: number) =>
		clampSliderNumberValue({ value: nextValue, min, max, step });
	// C4 fix: one clamped value feeds both halves, so an out-of-range `value`
	// never shows a different number on the Slider than on the NumberField.
	const { sliderValue, numberFieldDisplay } = resolveSliderNumberPairDisplay({
		value,
		min,
		max,
		step,
		maxFractionDigits,
	});

	const draft = usePropertyDraft({
		displayValue: numberFieldDisplay,
		parse: (input) => {
			const parsed = parseFloat(input);
			if (Number.isNaN(parsed)) return null;
			return clampValue(parsed);
		},
		onPreview,
		onCommit,
	});

	return (
		<div className={cn("flex w-full items-center gap-2", className)}>
			<Slider
				className="flex-1"
				min={min}
				max={max}
				step={step}
				disabled={disabled}
				value={[sliderValue]}
				onValueChange={([nextValue]) => onPreview(clampValue(nextValue))}
				onValueCommit={() => onCommit()}
			/>
			<div className="w-20 shrink-0">
				<NumberField
					icon={icon}
					suffix={suffix}
					disabled={disabled}
					value={draft.displayValue}
					dragSensitivity="slow"
					isDefault={isDefault}
					onFocus={draft.onFocus}
					onChange={draft.onChange}
					onBlur={draft.onBlur}
					onCancel={draft.onCancel}
					onScrub={(nextValue) => onPreview(clampValue(nextValue))}
					onScrubEnd={onCommit}
					onReset={onReset}
				/>
			</div>
		</div>
	);
}
