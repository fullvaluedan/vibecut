import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import type {
	TCanvasSize,
	TProjectMetadata,
	TProjectSettings,
} from "@/project/types";
import { formatDate } from "@/utils/date";
import { formatTimecode, mediaTimeToSeconds } from "opencut-wasm";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { NumberField } from "@/components/ui/number-field";
import { FPS_PRESETS } from "@/fps/presets";
import { floatToFrameRate, frameRateToFloat } from "@/fps/utils";
import { useEditorStore } from "@/editor/editor-store";
import { dimensionToAspectRatio } from "@/utils/geometry";
import { formatNumberForDisplay } from "@/utils/math";
import { usePropertyDraft } from "@/components/editor/panels/properties/hooks/use-property-draft";
import { useState } from "react";
import { cn } from "@/utils/ui";
import { HugeiconsIcon } from "@hugeicons/react";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { OcSquarePlusIcon } from "@/components/icons";

function InfoRow({
	label,
	value,
}: {
	label: string;
	value: string | React.ReactNode;
}) {
	return (
		<div className="flex justify-between items-center py-0 last:pb-0">
			<span className="text-muted-foreground text-sm">{label}</span>
			<span className="text-sm font-medium">{value}</span>
		</div>
	);
}

const PRESET_LABELS: Record<string, string> = {
	"1:1": "1:1",
	"16:9": "16:9",
	"9:16": "9:16",
	"4:3": "4:3",
};

function areCanvasSizesEqual({
	left,
	right,
}: {
	left: TCanvasSize;
	right: TCanvasSize;
}) {
	return left.width === right.width && left.height === right.height;
}

function formatCanvasDimension({ value }: { value: number }) {
	return formatNumberForDisplay({ value, maxFractionDigits: 0 });
}

function parseCanvasDimension({ input }: { input: string }): number | null {
	const trimmed = input.trim();
	if (!trimmed) return null;

	const parsed = Number(trimmed);
	if (!Number.isFinite(parsed)) return null;

	const rounded = Math.round(parsed);
	return rounded > 0 ? rounded : null;
}

function useCanvasDimensionDraft({
	value,
	onCommit,
}: {
	value: number;
	onCommit: (value: number) => void;
}) {
	const [pendingValue, setPendingValue] = useState(value);

	return usePropertyDraft({
		displayValue: formatCanvasDimension({ value }),
		parse: (input) => parseCanvasDimension({ input }),
		onStartEditing: () => {
			setPendingValue(value);
		},
		onPreview: (nextValue) => {
			setPendingValue(nextValue);
		},
		onCommit: () => {
			if (pendingValue !== value) {
				onCommit(pendingValue);
			}
		},
	});
}

/**
 * Editable Sequence Settings: frame rate + resolution/aspect. Reuses the EXACT
 * same control logic and the same `updateSettings` call path as the Assets →
 * Settings tab (`panels/assets/views/settings/index.tsx`), so there is a single
 * source of truth (the undoable `UpdateProjectSettingsCommand`).
 *
 * Rendered only when the caller passes a live project `settings` + an
 * `onUpdateSettings` handler (the editor, where there is an active project).
 * On the projects landing page no handler is passed, so the dialog stays
 * read-only — you cannot edit a non-active project's settings from there.
 */
function SequenceSettingsControls({
	settings,
	onUpdateSettings,
}: {
	settings: TProjectSettings;
	onUpdateSettings: (settings: Partial<TProjectSettings>) => void;
}) {
	const { canvasPresets } = useEditorStore();
	const currentCanvasSize = settings.canvasSize;
	const canvasSizeMode = settings.canvasSizeMode ?? "preset";
	const lastCustomCanvasSize = settings.lastCustomCanvasSize ?? null;

	const presetItems = canvasPresets.map((preset, index) => {
		const ratio = dimensionToAspectRatio(preset);
		return {
			id: index.toString(),
			label: PRESET_LABELS[ratio] ?? ratio,
			canvasSize: preset,
		};
	});

	const selectedPresetId =
		canvasSizeMode === "preset"
			? (presetItems.find((preset) =>
					areCanvasSizesEqual({
						left: preset.canvasSize,
						right: currentCanvasSize,
					}),
				)?.id ?? null)
			: null;

	const updateCustomCanvasSize = ({
		canvasSize,
	}: {
		canvasSize: TCanvasSize;
	}) => {
		const shouldUpdateCanvasSize = !areCanvasSizesEqual({
			left: canvasSize,
			right: currentCanvasSize,
		});
		const shouldUpdateLastCustomCanvasSize =
			lastCustomCanvasSize === null ||
			!areCanvasSizesEqual({
				left: canvasSize,
				right: lastCustomCanvasSize,
			});
		const shouldUpdateCanvasSizeMode = canvasSizeMode !== "custom";

		if (
			!shouldUpdateCanvasSize &&
			!shouldUpdateLastCustomCanvasSize &&
			!shouldUpdateCanvasSizeMode
		) {
			return;
		}

		onUpdateSettings({
			...(shouldUpdateCanvasSize ? { canvasSize } : {}),
			...(shouldUpdateCanvasSizeMode
				? { canvasSizeMode: "custom" as const }
				: {}),
			lastCustomCanvasSize: canvasSize,
		});
	};

	const selectPresetCanvasSize = ({
		canvasSize,
	}: {
		canvasSize: TCanvasSize;
	}) => {
		const shouldUpdateCanvasSize = !areCanvasSizesEqual({
			left: canvasSize,
			right: currentCanvasSize,
		});
		const shouldUpdateCanvasSizeMode = canvasSizeMode !== "preset";

		if (!shouldUpdateCanvasSize && !shouldUpdateCanvasSizeMode) return;

		onUpdateSettings({
			...(shouldUpdateCanvasSize ? { canvasSize } : {}),
			...(shouldUpdateCanvasSizeMode
				? { canvasSizeMode: "preset" as const }
				: {}),
		});
	};

	const selectCustomCanvasSize = () => {
		updateCustomCanvasSize({
			canvasSize: lastCustomCanvasSize ?? currentCanvasSize,
		});
	};

	const widthDraft = useCanvasDimensionDraft({
		value: currentCanvasSize.width,
		onCommit: (width) =>
			updateCustomCanvasSize({
				canvasSize: { width, height: currentCanvasSize.height },
			}),
	});

	const heightDraft = useCanvasDimensionDraft({
		value: currentCanvasSize.height,
		onCommit: (height) =>
			updateCustomCanvasSize({
				canvasSize: { width: currentCanvasSize.width, height },
			}),
	});

	const isCustomSelected = canvasSizeMode === "custom";

	return (
		<>
			<div className="flex justify-between items-center gap-2">
				<span className="text-muted-foreground text-sm">Frame rate</span>
				<Select
					value={String(Math.round(frameRateToFloat(settings.fps)))}
					onValueChange={(value) => {
						const fps = floatToFrameRate(parseFloat(value));
						onUpdateSettings({ fps });
					}}
				>
					<SelectTrigger className="h-7 w-28">
						<SelectValue placeholder="Select a frame rate" />
					</SelectTrigger>
					<SelectContent>
						{FPS_PRESETS.map((preset) => (
							<SelectItem key={preset.value} value={preset.value}>
								{preset.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			<div className="flex flex-col gap-1">
				<span className="text-muted-foreground text-sm">Resolution / aspect</span>
				<div className="flex flex-col gap-1">
					{presetItems.map((preset) => (
						<ResolutionItem
							key={preset.id}
							label={`${preset.label} · ${preset.canvasSize.width}×${preset.canvasSize.height}`}
							isSelected={selectedPresetId === preset.id}
							onClick={() => {
								selectPresetCanvasSize({ canvasSize: preset.canvasSize });
							}}
						/>
					))}
					<ResolutionItem
						label="Custom"
						previewIcon={<OcSquarePlusIcon />}
						isSelected={isCustomSelected}
						onClick={selectCustomCanvasSize}
						uiOptions={
							<div className="flex items-center gap-2 text-foreground">
								<NumberField
									value={widthDraft.displayValue}
									className="w-full"
									aria-label="Canvas width"
									onFocus={widthDraft.onFocus}
									onChange={widthDraft.onChange}
									onBlur={widthDraft.onBlur}
								/>
								<NumberField
									value={heightDraft.displayValue}
									className="w-full"
									aria-label="Canvas height"
									onFocus={heightDraft.onFocus}
									onChange={heightDraft.onChange}
									onBlur={heightDraft.onBlur}
								/>
							</div>
						}
					/>
				</div>
			</div>
		</>
	);
}

function ResolutionItem({
	label,
	previewIcon,
	isSelected,
	onClick,
	uiOptions,
}: {
	label: string;
	previewIcon?: React.ReactNode;
	isSelected: boolean;
	onClick: () => void;
	uiOptions?: React.ReactNode;
}) {
	return (
		<Button
			variant={isSelected ? "secondary" : "ghost"}
			className={cn(
				"px-2 py-0 flex flex-col h-fit w-full",
				!isSelected && "border border-transparent opacity-75!",
			)}
			onClick={onClick}
		>
			<div className="w-full flex justify-between items-center h-8">
				<div className="flex-1 flex items-center gap-2">
					{previewIcon && (
						<div className="flex items-center justify-center size-5">
							{previewIcon}
						</div>
					)}
					<span className="text-sm truncate">{label}</span>
				</div>
				<div>
					{isSelected && <HugeiconsIcon icon={Tick02Icon} className="size-4" />}
				</div>
			</div>
			{uiOptions && isSelected && (
				<div className="w-full pb-2">{uiOptions}</div>
			)}
		</Button>
	);
}

export function ProjectInfoDialog({
	isOpen,
	onOpenChange,
	project,
	settings,
	onUpdateSettings,
}: {
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
	project: TProjectMetadata;
	/**
	 * Live project settings. Pass together with `onUpdateSettings` to surface
	 * the editable Sequence Settings controls (frame rate + resolution). Omit
	 * both to keep the dialog read-only (e.g. the projects landing page, where
	 * there is no active project to update).
	 */
	settings?: TProjectSettings;
	onUpdateSettings?: (settings: Partial<TProjectSettings>) => void;
}) {
	const durationSeconds = mediaTimeToSeconds({ time: project.duration });
	const durationFormatted =
		project.duration > 0
		? (formatTimecode({ time: project.duration, format: durationSeconds >= 3600 ? "HH:MM:SS" : "MM:SS" }) ?? "")
		: "0:00";

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent onOpenAutoFocus={(event) => event.preventDefault()}>
				<DialogHeader>
					<DialogTitle className="truncate max-w-[350px]">
						{project.name}
					</DialogTitle>
				</DialogHeader>

				<DialogBody className="flex flex-col gap-3">
					<div className="flex flex-col">
						<InfoRow label="Duration" value={durationFormatted} />
						<InfoRow
							label="Created"
							value={formatDate({ date: project.createdAt })}
						/>
						<InfoRow
							label="Modified"
							value={formatDate({ date: project.updatedAt })}
						/>
						<InfoRow
							label="Project ID"
							value={
								<code className="text-xs bg-muted px-1.5 py-0.5 rounded">
									{project.id.slice(0, 8)}
								</code>
							}
						/>
					</div>
					{settings && onUpdateSettings && (
						<SequenceSettingsControls
							settings={settings}
							onUpdateSettings={onUpdateSettings}
						/>
					)}
				</DialogBody>
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Close
					</Button>
					<Button onClick={() => onOpenChange(false)}>Done</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
