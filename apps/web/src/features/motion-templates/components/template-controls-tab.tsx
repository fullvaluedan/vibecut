"use client";

/**
 * Template Controls — edit a native motion template like Effect Controls:
 * change its fields (text, color, corner/align) and timing, and the whole
 * element (or element group) is REBUILT from the template so params AND
 * keyframes regenerate together. This is what makes the templates actually
 * editable: tweaking a single base param can't fight the baked animation,
 * but a coherent rebuild always wins.
 */

import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
	Section,
	SectionContent,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { Button } from "@/components/ui/button";
import { ColorPicker } from "@/components/ui/color-picker";
import { Input } from "@/components/ui/input";
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
	const [durationSec, setDurationSec] = useState(
		Number((element.duration / TICKS_PER_SECOND).toFixed(2)),
	);
	const [scale, setScale] = useState(element.motionTemplate?.scale ?? 1);

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
		apply(next, durationSec);
	};

	const commitDuration = (value: number) => {
		const range = template.durationRange;
		const clamped = Math.max(range.min, Math.min(range.max, value));
		setDurationSec(clamped);
		apply(variables, clamped);
	};

	const commitScale = (value: number) => {
		const clamped = Math.max(0.2, Math.min(4, value));
		setScale(clamped);
		apply(variables, durationSec, clamped);
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
			description: "Now a plain text element — edit it in the Text/Transform tabs.",
		});
	};

	return (
		<div className="flex flex-col">
			<Section showTopBorder={false}>
				<SectionHeader>
					<SectionTitle className="flex-1">{template.name}</SectionTitle>
				</SectionHeader>
				<SectionContent className="flex flex-col gap-2.5 px-3 pb-3">
					{template.fields.map((field) => {
						const raw = variables[field.key];
						const value = typeof raw === "string" ? raw : "";
						if (field.type === "color") {
							return (
								<label
									key={field.key}
									className="flex items-center justify-between gap-2 text-xs"
								>
									<span className="text-muted-foreground">{field.label}</span>
									<ColorPicker
										className="size-6 rounded border"
										value={(value || accentFallback).replace(/^#/, "")}
										onChangeEnd={(hex) =>
											commitVariable(field.key, `#${hex.replace(/^#/, "")}`)
										}
									/>
								</label>
							);
						}
						if (field.type === "enum" && field.options) {
							const current = value || field.options[0].value;
							return (
								<label
									key={field.key}
									className="flex items-center justify-between gap-2 text-xs"
								>
									<span className="text-muted-foreground">{field.label}</span>
									<Select
										value={current}
										onValueChange={(next) => commitVariable(field.key, next)}
									>
										<SelectTrigger className="h-7 w-36">
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
								</label>
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
				</SectionContent>
			</Section>

			<Section>
				<SectionHeader>
					<SectionTitle className="flex-1">Size</SectionTitle>
				</SectionHeader>
				<SectionContent className="flex flex-col gap-1.5 px-3 pb-3">
					<div className="flex items-center justify-between gap-2">
						<span className="text-muted-foreground text-xs">Scale (×)</span>
						<NumberField
							key={`scale-${scale}`}
							value={scale}
							min={0.2}
							max={4}
							onCommit={commitScale}
						/>
					</div>
					<p className="text-muted-foreground text-[0.65rem]">
						Resizes the whole template — 1 = default, 0.5 = half, 2 = double.
					</p>
				</SectionContent>
			</Section>

			<Section>
				<SectionHeader>
					<SectionTitle className="flex-1">Timing</SectionTitle>
				</SectionHeader>
				<SectionContent className="flex items-center justify-between gap-2 px-3 pb-3">
					<span className="text-muted-foreground text-xs">Duration (sec)</span>
					<NumberField
						key={durationSec}
						value={durationSec}
						min={template.durationRange.min}
						max={template.durationRange.max}
						onCommit={commitDuration}
					/>
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

/** Text input: live local echo, commits to the timeline on blur / Enter. */
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
	return (
		<label className="flex flex-col gap-1 text-xs">
			<span className="text-muted-foreground">{label}</span>
			<Input
				value={value}
				onChange={(e) => onChange(e.target.value)}
				onBlur={(e) => onCommit(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") e.currentTarget.blur();
				}}
			/>
		</label>
	);
}

function NumberField({
	value,
	min,
	max,
	onCommit,
}: {
	value: number;
	min: number;
	max: number;
	onCommit: (value: number) => void;
}) {
	const [draft, setDraft] = useState(String(value));
	return (
		<Input
			className="h-7 w-20 text-right"
			value={draft}
			onChange={(e) => setDraft(e.target.value)}
			onBlur={() => {
				const parsed = Number(draft);
				if (Number.isFinite(parsed)) onCommit(parsed);
				else setDraft(String(value));
			}}
			onKeyDown={(e) => {
				if (e.key === "Enter") e.currentTarget.blur();
			}}
			inputMode="decimal"
			placeholder={`${min}-${max}`}
		/>
	);
}
