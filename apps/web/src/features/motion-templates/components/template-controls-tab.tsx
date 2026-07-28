"use client";

/**
 * Template Controls — edit a native motion template like Effect Controls:
 * change its fields (text, color, corner/align) and timing, and the whole
 * element (or element group) is REBUILT from the template so params AND
 * keyframes regenerate together. This is what makes the templates actually
 * editable: tweaking a single base param can't fight the baked animation,
 * but a coherent rebuild always wins.
 */

import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { Button } from "@/components/ui/button";
import { ColorPicker } from "@/components/ui/color-picker";
import { Input } from "@/components/ui/input";
import { SliderNumberPair } from "@/components/ui/slider-number-pair";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useEditor } from "@/editor/use-editor";
import { useAiSettingsStore } from "@/features/ai-generate/store";
import { getStyleById } from "@/features/ai-generate/styles";
import {
	getMotionTemplate,
	getMotionTemplateGroup,
	type TemplateVariables,
} from "@/features/motion-templates/templates";
import { UpdateElementsCommand } from "@/commands/timeline/element/update-elements";
import type { TextElement } from "@/timeline";
import { TICKS_PER_SECOND } from "@/wasm";
import { loadFonts } from "@/fonts/google-fonts";

const SCALE_MIN = 0.2;
const SCALE_MAX = 4;
/** Two decimals: the same precision the duration seed already rounded to. */
const NUMBER_STEP = 0.01;

export function TemplateControlsTab({
	element,
}: {
	element: TextElement;
	trackId: string;
}) {
	const editor = useEditor();
	const styleId = useAiSettingsStore((s) => s.styleId);
	const marker = element.motionTemplate;
	const template = marker ? getMotionTemplate(marker.templateId) : undefined;

	// Seed every field so the panel shows the clip's actual starting values
	// (round-16 elements were created with empty variables).
	const accentSeed = getStyleById(styleId).accent;
	const initialVariables = useMemo<TemplateVariables>(() => {
		const seeded: TemplateVariables = {};
		for (const field of template?.fields ?? []) {
			const existing = marker?.variables?.[field.key];
			if (existing !== undefined && existing !== "") {
				seeded[field.key] = existing;
			} else if (field.default !== undefined && field.default !== "") {
				seeded[field.key] = field.default;
			} else if (field.type === "color") {
				seeded[field.key] = accentSeed;
			}
		}
		return seeded;
	}, [marker, template, accentSeed]);
	const [variables, setVariables] =
		useState<TemplateVariables>(initialVariables);
	// C4 fix: a timeline trim can push element.duration outside the template's
	// declared durationRange (trims never clamp to it). Seed the field already
	// clamped so the tab opens showing a value consistent with what the
	// Duration slider can express, instead of one only the number half could
	// show.
	const rawDurationSec = element.duration / TICKS_PER_SECOND;
	const seededDurationSec = template
		? Math.min(
				template.durationRange.max,
				Math.max(template.durationRange.min, rawDurationSec),
			)
		: rawDurationSec;
	const [durationSec, setDurationSec] = useState(
		Number(seededDurationSec.toFixed(2)),
	);
	const [scale, setScale] = useState(element.motionTemplate?.scale ?? 1);
	// The shared SliderNumberPair splits every edit into onPreview (may fire
	// many times per drag or keystroke) and onCommit (no arguments). React
	// state alone is not enough here because usePropertyDraft can preview and
	// commit inside the SAME tick, so these refs carry the latest previewed
	// value into the commit that follows.
	const durationRef = useRef(durationSec);
	const scaleRef = useRef(scale);

	if (!marker || !template) {
		return (
			<div className="text-muted-foreground p-3 text-xs">
				This element is no longer linked to a template.
			</div>
		);
	}

	const accentFallback = getStyleById(styleId).accent;

	/** Rebuild all sibling elements from the template and patch in one undo. */
	const apply = (
		nextVariables: TemplateVariables,
		nextDurationSec: number,
		nextScale: number = scale,
	) => {
		const tracks = editor.scenes.getActiveScene().tracks;
		const siblings = getMotionTemplateGroup({
			tracks,
			groupId: marker.groupId,
		});
		if (!siblings.length) return;
		const accent =
			typeof nextVariables.accent === "string" && nextVariables.accent
				? nextVariables.accent
				: accentFallback;
		// Preserve the look's font the element was created with across rebuilds.
		const existingFont = siblings[0].element.params?.fontFamily;
		const built = template.build({
			startTime: siblings[0].element.startTime,
			durationSec: nextDurationSec,
			variables: nextVariables,
			accent,
			canvasSize: editor.project.getActive().settings.canvasSize,
			groupId: marker.groupId,
			fromAi: siblings[0].element.name.startsWith("AI:"),
			scale: nextScale,
			fontFamily: typeof existingFont === "string" ? existingFont : undefined,
		});
		const count = Math.min(built.length, siblings.length);
		const updates = [];
		for (let i = 0; i < count; i++) {
			const next = built[i] as TextElement;
			updates.push({
				trackId: siblings[i].trackId,
				elementId: siblings[i].element.id,
				patch: {
					params: next.params,
					animations: next.animations,
					duration: next.duration,
					hidden: !!next.hidden,
					motionTemplate: next.motionTemplate,
				} as Partial<TextElement>,
			});
		}
		editor.command.execute({ command: new UpdateElementsCommand({ updates }) });
	};

	const commitVariable = (key: string, value: string) => {
		const next = { ...variables, [key]: value };
		setVariables(next);
		// A picked Google font must be fetched before it renders in the preview.
		if (key === "font" && value) void loadFonts({ families: [value] });
		apply(next, durationRef.current, scaleRef.current);
	};

	/** Slider drag / typing: move the readout only, no undo entry yet. */
	const previewDuration = (value: number) => {
		const range = template.durationRange;
		const clamped = Math.max(range.min, Math.min(range.max, value));
		durationRef.current = clamped;
		setDurationSec(clamped);
	};

	/** Release / Enter / blur: one rebuild, one undo step (unchanged). */
	const commitDuration = () => {
		apply(variables, durationRef.current, scaleRef.current);
	};

	const previewScale = (value: number) => {
		const clamped = Math.max(SCALE_MIN, Math.min(SCALE_MAX, value));
		scaleRef.current = clamped;
		setScale(clamped);
	};

	const commitScale = () => {
		apply(variables, durationRef.current, scaleRef.current);
	};

	const detach = () => {
		const tracks = editor.scenes.getActiveScene().tracks;
		const siblings = getMotionTemplateGroup({
			tracks,
			groupId: marker.groupId,
		});
		editor.command.execute({
			command: new UpdateElementsCommand({
				updates: siblings.map((s) => ({
					trackId: s.trackId,
					elementId: s.element.id,
					patch: { motionTemplate: undefined } as Partial<TextElement>,
				})),
			}),
		});
		toast.info("Template detached", {
			description:
				"Now a plain text element — edit it in the Text/Transform tabs.",
		});
	};

	return (
		<div className="flex flex-col">
			<Section showTopBorder={false}>
				<SectionHeader>
					<SectionTitle className="flex-1">{template.name}</SectionTitle>
				</SectionHeader>
				<SectionContent>
					<SectionFields>
						{template.fields.map((field) => {
							const raw = variables[field.key];
							const value = typeof raw === "string" ? raw : "";
							if (field.type === "color") {
								return (
									<SectionField key={field.key} label={field.label}>
										<ColorPicker
											value={(value || accentFallback)
												.replace(/^#/, "")
												.toUpperCase()}
											onChangeEnd={(hex) =>
												commitVariable(field.key, `#${hex.replace(/^#/, "")}`)
											}
										/>
									</SectionField>
								);
							}
							if (field.type === "enum" && field.options) {
								const current = value || field.options[0].value;
								return (
									<SectionField key={field.key} label={field.label}>
										<Select
											value={current}
											onValueChange={(next) => commitVariable(field.key, next)}
										>
											<SelectTrigger className="w-full">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												{field.options.map((o) => (
													<SelectItem key={o.value} value={o.value}>
														{o.label}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</SectionField>
								);
							}
							return (
								<TextField
									key={field.key}
									label={field.label}
									value={value}
									onChange={(next) =>
										setVariables((prev) => ({ ...prev, [field.key]: next }))
									}
									onCommit={(next) => commitVariable(field.key, next)}
								/>
							);
						})}
					</SectionFields>
				</SectionContent>
			</Section>

			<Section>
				<SectionHeader>
					<SectionTitle className="flex-1">Size</SectionTitle>
				</SectionHeader>
				<SectionContent>
					<SectionFields>
						<SectionField label="Scale (×)">
							<SliderNumberPair
								icon="S"
								value={scale}
								min={SCALE_MIN}
								max={SCALE_MAX}
								step={NUMBER_STEP}
								onPreview={previewScale}
								onCommit={commitScale}
							/>
						</SectionField>
						<p className="text-muted-foreground text-[0.65rem]">
							Resizes the whole template. 1 = default, 0.5 = half, 2 = double.
						</p>
					</SectionFields>
				</SectionContent>
			</Section>

			<Section>
				<SectionHeader>
					<SectionTitle className="flex-1">Timing</SectionTitle>
				</SectionHeader>
				<SectionContent>
					<SectionFields>
						<SectionField label="Duration (sec)">
							<SliderNumberPair
								icon="D"
								value={durationSec}
								min={template.durationRange.min}
								max={template.durationRange.max}
								step={NUMBER_STEP}
								onPreview={previewDuration}
								onCommit={commitDuration}
							/>
						</SectionField>
					</SectionFields>
				</SectionContent>
			</Section>

			<div className="px-3 pb-3">
				<Button
					variant="outline"
					size="sm"
					className="w-full text-xs"
					onClick={detach}
				>
					Detach template (make plain text)
				</Button>
			</div>
		</div>
	);
}

/**
 * Text input: live local echo, commits to the timeline on blur / Enter,
 * reverts to the pre-edit text on Escape. Escape-reverts matches the shared
 * NumberField contract, so every field in this tab now cancels the same way.
 */
function TextField({
	label,
	value,
	onChange,
	onCommit,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	onCommit: (value: string) => void;
}) {
	const preEditRef = useRef(value);
	const isCancellingRef = useRef(false);
	return (
		<SectionField label={label}>
			<Input
				value={value}
				onFocus={() => {
					preEditRef.current = value;
				}}
				onChange={(e) => onChange(e.target.value)}
				onBlur={(e) => {
					if (isCancellingRef.current) {
						isCancellingRef.current = false;
						return;
					}
					onCommit(e.target.value);
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.currentTarget.blur();
					} else if (e.key === "Escape") {
						isCancellingRef.current = true;
						onChange(preEditRef.current);
						e.currentTarget.blur();
					}
				}}
			/>
		</SectionField>
	);
}
