"use client";

import type {
	ParamDefinition,
	NumberParamDefinition,
	ParamValue,
} from "@/params";
import {
	formatNumberForDisplay,
	getFractionDigitsForStep,
	snapToStep,
} from "@/utils/math";
import { SectionField } from "@/components/section";
import { NumberField } from "@/components/ui/number-field";
import { Switch } from "@/components/ui/switch";
import { ColorPicker } from "@/components/ui/color-picker";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { usePropertyDraft } from "../hooks/use-property-draft";
import { KeyframeToggle } from "./keyframe-toggle";
import { Textarea } from "@/components/ui/textarea";

/** Fonts available on effectively every computer (Premiere-style quick list). */
const COMMON_FONTS = [
	"Arial",
	"Helvetica",
	"Verdana",
	"Tahoma",
	"Trebuchet MS",
	"Segoe UI",
	"Georgia",
	"Times New Roman",
	"Garamond",
	"Courier New",
	"Impact",
	"Comic Sans MS",
];

export function PropertyParamField({
	param,
	value,
	onPreview,
	onCommit,
	keyframe,
}: {
	param: ParamDefinition;
	value: ParamValue;
	onPreview: (value: ParamValue) => void;
	onCommit: () => void;
	keyframe?: {
		isActive: boolean;
		isDisabled: boolean;
		onToggle: () => void;
	};
}) {
	return (
		<SectionField
			label={param.label}
			beforeLabel={
				keyframe && param.keyframable !== false ? (
					<KeyframeToggle
						isActive={keyframe.isActive}
						isDisabled={keyframe.isDisabled}
						title={`Toggle ${param.label.toLowerCase()} keyframe`}
						onToggle={keyframe.onToggle}
					/>
				) : undefined
			}
		>
			<ParamInput
				param={param}
				value={value}
				onPreview={onPreview}
				onCommit={onCommit}
			/>
		</SectionField>
	);
}

function ParamInput({
	param,
	value,
	onPreview,
	onCommit,
}: {
	param: ParamDefinition;
	value: ParamValue;
	onPreview: (value: ParamValue) => void;
	onCommit: () => void;
}) {
	if (param.type === "number") {
		return (
			<NumberParamField
				param={param}
				value={typeof value === "number" ? value : Number(value)}
				onPreview={onPreview}
				onCommit={onCommit}
			/>
		);
	}

	if (param.type === "boolean") {
		return (
			<Switch
				checked={Boolean(value)}
				onCheckedChange={(checked) => {
					onPreview(checked);
					onCommit();
				}}
			/>
		);
	}

	if (param.type === "select") {
		// Premiere-style: short option lists render as buttons, not dropdowns.
		if (param.options.length <= 4) {
			return (
				<div className="border-input bg-accent flex w-full overflow-hidden rounded-md border">
					{param.options.map((option) => (
						<button
							key={option.value}
							type="button"
							onClick={() => {
								onPreview(option.value);
								onCommit();
							}}
							className={
								"h-8 flex-1 text-xs transition-colors " +
								(String(value) === option.value
									? "bg-primary text-primary-foreground font-medium"
									: "text-muted-foreground hover:text-foreground")
							}
						>
							{option.label}
						</button>
					))}
				</div>
			);
		}
		return (
			<Select
				value={String(value)}
				onValueChange={(selected) => {
					onPreview(selected);
					onCommit();
				}}
			>
				<SelectTrigger className="w-full">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{param.options.map((option) => (
						<SelectItem key={option.value} value={option.value}>
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		);
	}

	if (param.type === "color") {
		return (
			<ColorPicker
				value={String(value).replace(/^#/, "").toUpperCase()}
				onChange={(color) => onPreview(`#${color}`)}
				onChangeEnd={(color) => {
					onPreview(`#${color}`);
					onCommit();
				}}
			/>
		);
	}

	if (param.type === "text") {
		return (
			<Textarea
				value={String(value)}
				onChange={(event) => onPreview(event.currentTarget.value)}
				onBlur={onCommit}
			/>
		);
	}

	if (param.type === "font") {
		const current = String(value);
		const fonts = COMMON_FONTS.includes(current)
			? COMMON_FONTS
			: [current, ...COMMON_FONTS];
		return (
			<Select
				value={current}
				onValueChange={(selected) => {
					onPreview(selected);
					onCommit();
				}}
			>
				<SelectTrigger className="w-full">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{fonts.map((font) => (
						<SelectItem key={font} value={font}>
							<span style={{ fontFamily: font }}>{font}</span>
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		);
	}

	return null;
}

function NumberParamField({
	param,
	value,
	onPreview,
	onCommit,
}: {
	param: NumberParamDefinition;
	value: number;
	onPreview: (value: number) => void;
	onCommit: () => void;
}) {
	const { min, max, step, displayMultiplier = 1 } = param;
	const displayValue = value * displayMultiplier;
	const clampDisplayValue = (nextDisplayValue: number) =>
		Math.max(
			min,
			max !== undefined ? Math.min(max, nextDisplayValue) : nextDisplayValue,
		);

	const previewFromDisplay = (displayVal: number) => {
		const clamped = clampDisplayValue(
			snapToStep({ value: displayVal, step }),
		);
		onPreview(clamped / displayMultiplier);
	};

	const maxFractionDigits = getFractionDigitsForStep({ step });

	const draft = usePropertyDraft({
		displayValue: formatNumberForDisplay({
			value: displayValue,
			maxFractionDigits,
		}),
		parse: (input) => {
			const parsed = parseFloat(input);
			if (Number.isNaN(parsed)) return null;
			return clampDisplayValue(snapToStep({ value: parsed, step }));
		},
		onPreview: previewFromDisplay,
		onCommit,
	});

	const handleReset = () => {
		onPreview(param.default);
		onCommit();
	};

	return (
		<div className="flex w-full items-center gap-1">
			<div className="min-w-0 flex-1">
				<NumberField
					icon={param.shortLabel}
					value={draft.displayValue}
					dragSensitivity="slow"
					isDefault={value === param.default}
					onFocus={draft.onFocus}
					onChange={draft.onChange}
					onBlur={draft.onBlur}
					onScrub={previewFromDisplay}
					onScrubEnd={onCommit}
					onReset={handleReset}
				/>
			</div>
			{param.key === "fontSize" && (
				<div className="flex flex-col">
					<button
						type="button"
						aria-label="Increase"
						className="text-muted-foreground hover:text-foreground flex h-4 w-5 items-center justify-center text-[0.6rem] leading-none"
						onClick={() => {
							previewFromDisplay(displayValue + (step || 1));
							onCommit();
						}}
					>
						▲
					</button>
					<button
						type="button"
						aria-label="Decrease"
						className="text-muted-foreground hover:text-foreground flex h-4 w-5 items-center justify-center text-[0.6rem] leading-none"
						onClick={() => {
							previewFromDisplay(displayValue - (step || 1));
							onCommit();
						}}
					>
						▼
					</button>
				</div>
			)}
		</div>
	);
}
