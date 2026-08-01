"use client";

import { useState } from "react";
import { TransitionTopIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/utils/ui";
import {
	getExportMimeType,
	getExportFileExtension,
	pickSaveLocation,
	writeBufferToHandle,
	downloadBuffer,
} from "@/export";
import { canExport } from "@/export/can-export";
import {
	deriveOutputSize,
	computeEffectiveBitrate,
	formatBitrate,
} from "@/export/resolution-utils";
import { getCachedTranscript } from "@/features/transcription/transcript-cache";
import { formatTranscriptSrt } from "@/features/transcription/export-transcript";
import { Check, Copy, Download, RotateCcw } from "lucide-react";
import {
	EXPORT_FORMAT_VALUES,
	EXPORT_QUALITY_VALUES,
	type ExportFormat,
	type ExportQuality,
} from "@/export";
import {
	Section,
	SectionContent,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { useEditor } from "@/editor/use-editor";
import { DEFAULT_EXPORT_OPTIONS } from "@/export/defaults";
import {
	compositeAiOverlays,
	collectAiOverlayClips,
} from "@/features/ai-generate/composite-export";
import { usePreferenceStore } from "@/features/ai-generate/preference-store";
import { toast } from "sonner";

function isExportFormat(value: string): value is ExportFormat {
	return EXPORT_FORMAT_VALUES.some((formatValue) => formatValue === value);
}

function isExportQuality(value: string): value is ExportQuality {
	return EXPORT_QUALITY_VALUES.some((qualityValue) => qualityValue === value);
}

export function ExportButton() {
	const [isExportPopoverOpen, setIsExportPopoverOpen] = useState(false);
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActiveOrNull());
	const isExporting = useEditor((e) => e.project.getExportState().isExporting);
	const hasProject = !!activeProject;

	const handlePopoverOpenChange = ({ open }: { open: boolean }) => {
		if (!open) {
			// A running export must NOT be torn down just because the popover was
			// dismissed (outside-click / Escape / focus loss) — that read as the
			// export "cancelling itself" at 5%. Keep the popover open while
			// exporting; the explicit Cancel button is the only way to stop it.
			if (isExporting) return;
			editor.project.cancelExport();
			editor.project.clearExportState();
		}
		setIsExportPopoverOpen(open);
	};

	return (
		<Popover
			open={isExportPopoverOpen}
			onOpenChange={(open) => handlePopoverOpenChange({ open })}
		>
			<PopoverTrigger asChild>
				<button
					type="button"
					className={cn(
						"flex items-center gap-1.5 rounded-md bg-[#38BDF8] px-[0.12rem] py-[0.12rem] text-white",
						hasProject ? "cursor-pointer" : "cursor-not-allowed opacity-50",
					)}
					onClick={hasProject ? () => setIsExportPopoverOpen(true) : undefined}
					disabled={!hasProject}
					onKeyDown={(event) => {
						if (hasProject && (event.key === "Enter" || event.key === " ")) {
							event.preventDefault();
							setIsExportPopoverOpen(true);
						}
					}}
				>
					<div className="relative flex items-center gap-1.5 rounded-[0.6rem] bg-linear-270 from-[#2567EC] to-[#37B6F7] px-4 py-1 shadow-[0_1px_3px_0px_rgba(0,0,0,0.65)]">
						<HugeiconsIcon icon={TransitionTopIcon} className="z-50 size-3.5" />
						<span className="z-50 text-[0.875rem]">Export</span>
						<div className="absolute top-0 left-0 z-10 flex size-full items-center justify-center rounded-[0.6rem] bg-linear-to-t from-white/0 to-white/50">
							<div className="absolute top-[0.08rem] z-50 h-[calc(100%-2px)] w-[calc(100%-2px)] rounded-[0.6rem] bg-linear-270 from-[#2567EC] to-[#37B6F7]"></div>
						</div>
					</div>
				</button>
			</PopoverTrigger>
			{hasProject && <ExportPopover onOpenChange={setIsExportPopoverOpen} />}
		</Popover>
	);
}

function ExportPopover({
	onOpenChange,
}: {
	onOpenChange: (open: boolean) => void;
}) {
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());
	const exportState = useEditor((e) => e.project.getExportState());
	const { isExporting, progress, result: exportResult } = exportState;
	// Read the timeline duration up front so an empty project disables Export and
	// short-circuits handleExport BEFORE pickSaveLocation — otherwise the save
	// dialog is shown only to fail with "Project is empty" right after.
	const totalDuration = useEditor((e) => e.timeline.getTotalDuration());
	const canExportProject = canExport({ durationTicks: totalDuration });
	const [format, setFormat] = useState<ExportFormat>(
		DEFAULT_EXPORT_OPTIONS.format,
	);
	const [quality, setQuality] = useState<ExportQuality>(
		DEFAULT_EXPORT_OPTIONS.quality,
	);
	const [shouldIncludeAudio, setShouldIncludeAudio] = useState<boolean>(
		DEFAULT_EXPORT_OPTIONS.includeAudio ?? true,
	);
	const [resolutionPreset, setResolutionPreset] = useState<"project" | "2160" | "1080" | "720">(
		"project",
	);
	const [shouldExportSrt, setShouldExportSrt] = useState(false);

	const canvasSize = activeProject.settings.canvasSize;
	const projectPixels = canvasSize.width * canvasSize.height;
	const outputSize = deriveOutputSize({
		preset: resolutionPreset,
		projectWidth: canvasSize.width,
		projectHeight: canvasSize.height,
	});
	const outputPixels = outputSize.width * outputSize.height;

	const cachedTranscript = getCachedTranscript(editor);
	const hasTranscript = !!cachedTranscript && cachedTranscript.length > 0;

	const lowBitrate = formatBitrate(
		computeEffectiveBitrate({ quality: "low", projectPixels, outputPixels }),
	);
	const mediumBitrate = formatBitrate(
		computeEffectiveBitrate({
			quality: "medium",
			projectPixels,
			outputPixels,
		}),
	);
	const highBitrate = formatBitrate(
		computeEffectiveBitrate({ quality: "high", projectPixels, outputPixels }),
	);
	const veryHighBitrate = formatBitrate(
		computeEffectiveBitrate({
			quality: "very_high",
			projectPixels,
			outputPixels,
		}),
	);

	const handleExport = async () => {
		if (!activeProject) return;
		// Bail before pickSaveLocation: an empty timeline can't export, so don't
		// prompt for a save destination only to fail with "Project is empty".
		if (!canExport({ durationTicks: editor.timeline.getTotalDuration() })) {
			toast.error("Add footage to the timeline first");
			return;
		}

		const tracks = editor.scenes.getActiveScene().tracks;
		const mediaAssets = editor.media.getAssets();
		// Predict the final container up front: AI/alpha overlays force an mp4
		// burn-in (compositeAiOverlays below), so the save dialog can show the
		// correct extension before we encode. collectAiOverlayClips is pure.
		const willComposite =
			collectAiOverlayClips({ tracks, mediaAssets }).length > 0;
		const downloadFormat: ExportFormat = willComposite ? "mp4" : format;
		const filename = `${activeProject.metadata.name}${getExportFileExtension({ format: downloadFormat })}`;
		const mimeType = getExportMimeType({ format: downloadFormat });

		// Ask WHERE to save FIRST — cancelling here costs nothing instead of
		// throwing away a finished (often minutes-long) encode.
		const location = await pickSaveLocation({ filename, mimeType });
		if (location.kind === "cancelled") return;

		const result = await editor.project.export({
			options: {
				format,
				quality,
				fps: activeProject.settings.fps,
				includeAudio: shouldIncludeAudio,
				outputSize: resolutionPreset === "project" ? undefined : outputSize,
			},
		});

		if (result.cancelled) {
			editor.project.clearExportState();
			return;
		}
		if (!result.success || !result.buffer) return;

		// Self-learning: compare what's being exported against the last
		// AI Cut: did the user keep it, restore content, or trim more?
		usePreferenceStore.getState().noteExport({
			durationTicks: editor.timeline.getTotalDuration() as number,
		});
		// FrameCut AI overlays (alpha WebMs) are excluded from the canvas
		// render — burn them in with local ffmpeg before saving.
		let buffer = result.buffer;
		try {
			const composite = await compositeAiOverlays({
				baseBuffer: result.buffer,
				baseName: `base${getExportFileExtension({ format })}`,
				tracks,
				mediaAssets,
				canvasSize: editor.project.getActive().settings.canvasSize,
			});
			buffer = composite.buffer;
		} catch (e) {
			toast.error("Couldn't burn in AI effects", {
				description: e instanceof Error ? e.message : String(e),
			});
		}

		if (location.kind === "handle") {
			try {
				await writeBufferToHandle({ handle: location.handle, buffer, mimeType });
				toast.success("Exported", {
					description: "Saved to your chosen folder — next export defaults there.",
				});
			} catch {
				downloadBuffer({ buffer, filename, mimeType });
				toast.success("Exported", { description: "Saved to your downloads." });
			}
		} else {
			// No File System Access API — fall back to a plain download.
			downloadBuffer({ buffer, filename, mimeType });
			toast.success("Exported", { description: "Saved to your downloads." });
		}

		if (shouldExportSrt && cachedTranscript && cachedTranscript.length > 0) {
			const srtContent = formatTranscriptSrt({ segments: cachedTranscript });
			const srtFilename = filename.replace(/\.[^.]+$/, ".srt");
			const srtBlob = new Blob([srtContent], { type: "text/plain" });
			const srtUrl = URL.createObjectURL(srtBlob);
			const srtLink = document.createElement("a");
			srtLink.href = srtUrl;
			srtLink.download = srtFilename;
			document.body.appendChild(srtLink);
			srtLink.click();
			document.body.removeChild(srtLink);
			URL.revokeObjectURL(srtUrl);
		}

		editor.project.clearExportState();
		onOpenChange(false);
	};

	const handleCancel = () => {
		editor.project.cancelExport();
	};

	return (
		<PopoverContent className="bg-background mr-4 flex w-80 flex-col p-0">
			{exportResult && !exportResult.success ? (
				<ExportError
					error={exportResult.error || "Unknown error occurred"}
					onRetry={handleExport}
				/>
			) : (
				<>
					<div className="flex items-center justify-between p-3 border-b">
						<h3 className="font-medium text-sm">
							{isExporting ? "Exporting project" : "Export project"}
						</h3>
					</div>

					<div className="flex flex-col gap-4">
						{!isExporting && (
							<>
								<div className="flex flex-col">
t							<Section
									collapsible
									defaultOpen={true}
									showTopBorder={false}
								>
									<SectionHeader>
										<SectionTitle>Resolution</SectionTitle>
									</SectionHeader>
									<SectionContent>
										<div className="flex flex-col gap-2">
											<select
												value={resolutionPreset}
												onChange={(e) => {
													const value = e.target.value as "project" | "2160" | "1080" | "720";
													setResolutionPreset(value);
												}}
												className="w-full rounded border border-input bg-background px-3 py-2 text-sm"
											>
												<option value="project">
													Project size ({canvasSize.width}x{canvasSize.height})
												</option>
												<option value="2160">2160p</option>
												<option value="1080">1080p</option>
												<option value="720">720p</option>
											</select>
											{resolutionPreset !== "project" && (
												<p className="text-muted-foreground text-xs">
													Output: {outputSize.width}x{outputSize.height}
												</p>
											)}
										</div>
									</SectionContent>
								</Section>

									<Section
										collapsible
										defaultOpen={true}
										showTopBorder={false}
									>
										<SectionHeader>
											<SectionTitle>Format</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<RadioGroup
												value={format}
												onValueChange={(value) => {
													if (isExportFormat(value)) {
														setFormat(value);
													}
												}}
											>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="mp4" id="mp4" />
													<Label htmlFor="mp4">
														MP4 (H.264) - Better compatibility
													</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="webm" id="webm" />
													<Label htmlFor="webm">
														WebM (VP9) - Smaller file size
													</Label>
												</div>
											</RadioGroup>
										</SectionContent>
									</Section>

									<Section collapsible defaultOpen={true}>
										<SectionHeader>
											<SectionTitle>Quality</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<RadioGroup
												value={quality}
												onValueChange={(value) => {
													if (isExportQuality(value)) {
														setQuality(value);
													}
												}}
											>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="low" id="low" />
													<Label htmlFor="low">Low ({lowBitrate})</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="medium" id="medium" />
													<Label htmlFor="medium">Medium ({mediumBitrate})</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="high" id="high" />
													<Label htmlFor="high">High ({highBitrate})</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="very_high" id="very_high" />
													<Label htmlFor="very_high">
														Very high ({veryHighBitrate})
													</Label>
												</div>
											</RadioGroup>
										</SectionContent>
									</Section>

									<Section collapsible defaultOpen={true}>
										<SectionHeader>
											<SectionTitle>Audio</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<div className="flex items-center space-x-2">
												<Checkbox
													id="include-audio"
													checked={shouldIncludeAudio}
													onCheckedChange={(checked) =>
														setShouldIncludeAudio(!!checked)
													}
												/>
												<Label htmlFor="include-audio">
													Include audio in export
												</Label>
											</div>
										</SectionContent>
									</Section>

									{hasTranscript && (
										<Section collapsible defaultOpen={true}>
											<SectionHeader>
												<SectionTitle>Captions</SectionTitle>
											</SectionHeader>
											<SectionContent>
												<div className="flex items-center space-x-2">
													<Checkbox
														id="export-srt"
														checked={shouldExportSrt}
														onCheckedChange={(checked) =>
															setShouldExportSrt(!!checked)
														}
													/>
													<Label htmlFor="export-srt">
														Also export captions (.srt)
													</Label>
												</div>
											</SectionContent>
										</Section>
									)}
								</div>

								<div className="p-3 pt-0">
									<Button
										onClick={handleExport}
										disabled={!canExportProject}
										className="w-full gap-2"
									>
										<Download className="size-4" />
										Export
									</Button>
									{!canExportProject && (
										<p className="text-muted-foreground mt-2 text-xs">
											Add footage to the timeline to export.
										</p>
									)}
								</div>
							</>
						)}

						{isExporting && (
							<div className="space-y-4 p-3">
								<div className="flex flex-col gap-2">
									<div className="flex items-center justify-between text-center">
										<p className="text-muted-foreground text-sm">
											{Math.round(progress * 100)}%
										</p>
										<p className="text-muted-foreground text-sm">100%</p>
									</div>
									<Progress value={progress * 100} className="w-full" />
								</div>

								<Button
									variant="outline"
									className="w-full rounded-md"
									onClick={handleCancel}
								>
									Cancel
								</Button>
							</div>
						)}
					</div>
				</>
			)}
		</PopoverContent>
	);
}

function ExportError({
	error,
	onRetry,
}: {
	error: string;
	onRetry: () => void;
}) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		await navigator.clipboard.writeText(error);
		setCopied(true);
		setTimeout(() => setCopied(false), 1000);
	};

	return (
		<div className="space-y-4 p-3">
			<div className="flex flex-col gap-1.5">
				<p className="text-destructive text-sm font-medium">Export failed</p>
				<p className="text-muted-foreground text-xs">{error}</p>
			</div>

			<div className="flex gap-2">
				<Button
					variant="outline"
					size="sm"
					className="h-8 flex-1 text-xs"
					onClick={handleCopy}
				>
					{copied ? <Check className="text-constructive" /> : <Copy />}
					Copy
				</Button>
				<Button
					variant="outline"
					size="sm"
					className="h-8 flex-1 text-xs"
					onClick={onRetry}
				>
					<RotateCcw />
					Retry
				</Button>
			</div>
		</div>
	);
}
