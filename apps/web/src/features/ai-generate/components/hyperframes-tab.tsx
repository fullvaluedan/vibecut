"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ColorPicker } from "@/components/ui/color-picker";
import { useAiSettingsStore } from "@/features/ai-generate/store";
import { VIBE_STYLES, getStyleById } from "@/features/ai-generate/styles";
import {
	reRenderAiClip,
	reRenderFromCompDir,
} from "@/features/ai-generate/re-render";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Section,
	SectionContent,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { describeTemplateCatalog } from "@framecut/hf-bridge/templates";
import { AddMediaAssetCommand } from "@/commands/media/add-media-asset";
import { UpdateElementsCommand } from "@/commands/timeline/element/update-elements";
import { processMediaAssets } from "@/media/processing";
import { useEditor } from "@/editor/use-editor";
import { frameRateToFloat } from "@/fps/utils";
import { TICKS_PER_SECOND, mediaTimeFromSeconds } from "@/wasm";
import type { VideoElement } from "@/timeline";

type VariableValues = Record<string, string | number | boolean>;

const CATALOG = describeTemplateCatalog();

/** Looping live previews so users see what each template means. */
export function TemplateGallery({
	selectedId,
	onSelect,
}: {
	selectedId: string;
	onSelect: (id: string) => void;
}) {
	return (
		<div className="grid grid-cols-2 gap-2">
			{CATALOG.map((t) => (
				<button
					key={t.id}
					type="button"
					onClick={() => onSelect(t.id)}
					title={t.description}
					className={
						"group flex flex-col gap-1 rounded-md border p-1 text-left transition-colors " +
						(t.id === selectedId
							? "border-primary ring-primary/40 ring-1"
							: "border-border hover:border-foreground/40")
					}
				>
					<div className="bg-black/60 relative aspect-video w-full overflow-hidden rounded">
						<video
							src={`/hf-demos/${t.id}.webm`}
							muted
							loop
							autoPlay
							playsInline
							className="size-full object-cover"
						/>
					</div>
					<span className="truncate px-0.5 text-[0.65rem] font-medium">
						{t.name}
					</span>
				</button>
			))}
		</div>
	);
}

/**
 * Properties panel for a baked registry BLOCK. Blocks aren't parametrized like
 * templates, so there's no field editing or template swap — just a re-bake
 * (pulls the latest registry version + re-renders, swapping the clip in place).
 * Position/scale live on the Transform tab like any other clip.
 */
function RegistryBlockTab({
	element,
	trackId,
	blockName,
}: {
	element: VideoElement;
	trackId: string;
	blockName: string;
}) {
	const editor = useEditor();
	const [isRebaking, setIsRebaking] = useState(false);

	const reBake = async () => {
		setIsRebaking(true);
		const toastId = toast.loading("Re-baking from the registry...");
		try {
			const project = editor.project.getActive();
			const fps = Math.round(frameRateToFloat(project.settings.fps)) || 30;
			const res = await fetch("/api/hyperframes/bake", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: blockName, fps }),
			});
			if (!res.ok) {
				const err = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(err?.error ?? `Bake failed (${res.status})`);
			}
			const bakeKey = res.headers.get("x-framecut-bake-key") ?? blockName;
			const blob = await res.blob();
			const file = new File([blob], `hf-block-${blockName}.webm`, {
				type: "video/webm",
			});
			const [processed] = await processMediaAssets({ files: [file] });
			if (!processed) throw new Error("Could not process the baked block");

			const addAsset = new AddMediaAssetCommand({
				projectId: project.metadata.id,
				asset: processed,
			});
			editor.command.execute({ command: addAsset });
			const assetId = addAsset.getAssetId();
			if (!assetId) throw new Error("Could not store the baked block");

			// A re-baked block can be a different length than before; update the
			// clip's duration so it doesn't play stale (was left unchanged).
			const newDuration =
				processed.duration != null
					? mediaTimeFromSeconds({ seconds: processed.duration })
					: element.duration;

			editor.command.execute({
				command: new UpdateElementsCommand({
					updates: [
						{
							trackId,
							elementId: element.id,
							patch: {
								mediaId: assetId,
								duration: newDuration,
								sourceDuration: newDuration,
								framecutAi: {
									...element.framecutAi,
									compId: bakeKey,
									templateId: `registry:${blockName}`,
									variables: {},
									groupId: element.framecutAi?.groupId ?? bakeKey,
									registryBlock: blockName,
								},
							},
						},
					],
				}),
			});
			toast.success("Re-baked", { id: toastId });
		} catch (e) {
			toast.error("Re-bake failed", {
				id: toastId,
				description: e instanceof Error ? e.message : String(e),
			});
		} finally {
			setIsRebaking(false);
		}
	};

	return (
		<div className="flex flex-col">
			<Section showTopBorder={false}>
				<SectionHeader>
					<SectionTitle className="flex-1">HyperFrames block</SectionTitle>
				</SectionHeader>
				<SectionContent className="px-3 pb-3 flex flex-col gap-2">
					<p className="text-muted-foreground text-xs">
						<span className="text-foreground font-medium">{blockName}</span> — a
						baked registry block. It renders once on your computer and is cached,
						so dropping it again is instant.
					</p>
					<Button
						variant="outline"
						size="sm"
						disabled={isRebaking}
						onClick={() => void reBake()}
					>
						{isRebaking ? (
							<>
								<Spinner className="size-3.5" /> Re-baking...
							</>
						) : (
							"Re-bake from registry"
						)}
					</Button>
					<p className="text-muted-foreground text-[0.65rem]">
						Pulls the latest version of this block from the HyperFrames registry
						and re-renders it in place. Use the Transform tab to position and
						scale it on the canvas.
					</p>
				</SectionContent>
			</Section>
		</div>
	);
}

export function HyperframesTab({
	element,
	trackId,
}: {
	element: VideoElement;
	trackId: string;
}) {
	const editor = useEditor();
	const ai = element.framecutAi;
	const [templateId, setTemplateId] = useState(ai?.templateId ?? CATALOG[0].id);
	const [isRendering, setIsRendering] = useState(false);
	const [isRestyling, setIsRestyling] = useState(false);
	const [isStudioBusy, setIsStudioBusy] = useState(false);
	const [isPulling, setIsPulling] = useState(false);

	const openInStudio = async () => {
		if (!ai) return;
		setIsStudioBusy(true);
		const toastId = toast.loading("Starting HyperFrames Studio...");
		try {
			const res = await fetch("/api/hyperframes/studio", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ compId: ai.compId }),
			});
			if (!res.ok) {
				const err = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(err?.error ?? `Studio failed (${res.status})`);
			}
			const { url } = (await res.json()) as { url: string };
			window.open(url, "_blank", "noopener");
			toast.success("Studio opened in a new tab", {
				id: toastId,
				description:
					'Edit the composition there, then come back and click "Pull changes from Studio".',
				duration: 8000,
			});
		} catch (e) {
			toast.error("Could not open Studio", {
				id: toastId,
				description: e instanceof Error ? e.message : String(e),
			});
		} finally {
			setIsStudioBusy(false);
		}
	};

	const pullFromStudio = async () => {
		setIsPulling(true);
		const toastId = toast.loading("Re-rendering with your Studio edits...");
		try {
			await reRenderFromCompDir({ editor, trackId, element });
			toast.success("Clip updated with your Studio edits", { id: toastId });
		} catch (e) {
			toast.error("Could not pull Studio edits", {
				id: toastId,
				description: e instanceof Error ? e.message : String(e),
			});
		} finally {
			setIsPulling(false);
		}
	};
	const styleId = useAiSettingsStore((s) => s.styleId);
	const setStyleId = useAiSettingsStore((s) => s.setStyleId);

	const applyStyleToAll = async () => {
		setIsRestyling(true);
		const accent = getStyleById(styleId).accent;
		try {
			const tracks = editor.scenes.getActiveScene().tracks;
			const targets: { trackId: string; element: VideoElement }[] = [];
			for (const track of tracks.overlay) {
				if (track.type !== "video") continue;
				for (const el of track.elements) {
					// Baked registry blocks have framecutAi but no native template
					// (templateId "registry:<name>"); reRenderAiClip can't restyle
					// them and threw, aborting the whole batch. Skip them.
					if (
						el.type === "video" &&
						el.framecutAi &&
						!el.framecutAi.registryBlock
					) {
						targets.push({ trackId: track.id, element: el });
					}
				}
			}
			if (!targets.length) {
				toast.info("No AI clips on the timeline to restyle");
				return;
			}
			let done = 0;
			for (const target of targets) {
				const meta = target.element.framecutAi;
				if (!meta) continue;
				await reRenderAiClip({
					editor,
					trackId: target.trackId,
					element: target.element,
					templateId: meta.templateId,
					variables: { ...meta.variables, accent },
				});
				done += 1;
				toast.loading(`Restyling ${done}/${targets.length}...`, { id: "restyle" });
			}
			toast.success(`Restyled ${done} AI clip${done === 1 ? "" : "s"}`, { id: "restyle" });
		} catch (e) {
			toast.error("Restyle failed", {
				id: "restyle",
				description: e instanceof Error ? e.message : String(e),
			});
		} finally {
			setIsRestyling(false);
		}
	};

	const template = CATALOG.find((t) => t.id === templateId) ?? CATALOG[0];

	const initialValues = useMemo<VariableValues>(() => {
		const values: VariableValues = {};
		for (const v of template.variables) {
			const carried = ai?.variables?.[v.id];
			values[v.id] =
				carried !== undefined ? carried : (v.default as string | number | boolean);
		}
		return values;
		// Re-seed when switching templates (keeps shared ids like text/accent).
	}, [template, ai]);

	const [values, setValues] = useState<VariableValues>(initialValues);
	const [seededFor, setSeededFor] = useState(template.id);
	if (seededFor !== template.id) {
		setSeededFor(template.id);
		setValues(initialValues);
	}

	if (!ai) {
		return (
			<div className="text-muted-foreground p-4 text-xs">
				This clip wasn't generated by HyperFrames.
			</div>
		);
	}

	if (ai.registryBlock) {
		return (
			<RegistryBlockTab
				element={element}
				trackId={trackId}
				blockName={ai.registryBlock}
			/>
		);
	}

	const applySwap = async () => {
		setIsRendering(true);
		try {
			const project = editor.project.getActive();
			const fps = Math.round(frameRateToFloat(project.settings.fps)) || 30;
			const { width, height } = project.settings.canvasSize;
			const elementDurationSec = element.duration / TICKS_PER_SECOND;
			const durationSec = Math.min(
				Math.max(elementDurationSec, template.minDurationSec),
				template.maxDurationSec,
			);

			const res = await fetch("/api/hyperframes/render", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					templateId: template.id,
					durationSec,
					fps,
					width,
					height,
					variables: values,
				}),
			});
			if (!res.ok) {
				const err = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(err?.error ?? `Render failed (${res.status})`);
			}
			const compId = res.headers.get("x-framecut-comp-id") ?? ai.compId;
			const blob = await res.blob();
			const file = new File([blob], `hf-${template.id}-swap.webm`, {
				type: "video/webm",
			});
			const [processed] = await processMediaAssets({ files: [file] });
			if (!processed) throw new Error("Could not process the rendered video");

			const addAsset = new AddMediaAssetCommand({
				projectId: project.metadata.id,
				asset: processed,
			});
			editor.command.execute({ command: addAsset });
			const assetId = addAsset.getAssetId();
			if (!assetId) throw new Error("Could not store the rendered video");

			const durationTime = mediaTimeFromSeconds({ seconds: durationSec });
			editor.command.execute({
				command: new UpdateElementsCommand({
					updates: [
						{
							trackId,
							elementId: element.id,
							patch: {
								mediaId: assetId,
								name: `AI: ${template.id}`,
								duration: durationTime,
								sourceDuration: durationTime,
								framecutAi: {
									compId,
									templateId: template.id,
									variables: values,
									groupId: ai.groupId,
								},
							},
						},
					],
				}),
			});
			toast.success(`Updated to ${template.name}`);
		} catch (e) {
			toast.error("Template swap failed", {
				description: e instanceof Error ? e.message : String(e),
			});
		} finally {
			setIsRendering(false);
		}
	};

	return (
		<div className="flex flex-col">
			<Section showTopBorder={false}>
				<SectionHeader>
					<SectionTitle className="flex-1">Template</SectionTitle>
				</SectionHeader>
				<SectionContent className="px-3 pb-2 flex flex-col gap-2">
					<TemplateGallery
						selectedId={template.id}
						onSelect={setTemplateId}
					/>
					<p className="text-muted-foreground text-xs">{template.description}</p>
				</SectionContent>
			</Section>

			<Section showTopBorder={false}>
				<SectionHeader>
					<SectionTitle className="flex-1">Style theme</SectionTitle>
				</SectionHeader>
				<SectionContent className="px-3 pb-3 flex flex-col gap-2">
					<div className="flex flex-wrap gap-1.5">
						{VIBE_STYLES.map((s) => (
							<button
								key={s.id}
								type="button"
								title={`${s.name} — ${s.description}`}
								onClick={() => {
									setStyleId(s.id);
									setValues((prev) =>
										"accent" in prev ? { ...prev, accent: s.accent } : prev,
									);
								}}
								className={
									"size-6 rounded-full border-2 transition-transform hover:scale-110 " +
									(styleId === s.id ? "border-white" : "border-transparent")
								}
								style={{ backgroundColor: s.accent }}
							/>
						))}
					</div>
					<Button
						variant="outline"
						size="sm"
						disabled={isRestyling}
						onClick={() => void applyStyleToAll()}
					>
						{isRestyling ? (
							<>
								<Spinner className="size-3.5" /> Restyling all AI clips...
							</>
						) : (
							`Apply ${getStyleById(styleId).name} to all AI clips`
						)}
					</Button>
				</SectionContent>
			</Section>

			<Section showTopBorder={false}>
				<SectionHeader>
					<SectionTitle className="flex-1">Content</SectionTitle>
				</SectionHeader>
				<SectionContent className="px-3 pb-3 flex flex-col gap-2">
					{template.variables.map((v) => {
						const value = values[v.id];
						if (v.type === "color") {
							return (
								<label
									key={v.id}
									className="flex items-center justify-between gap-2 text-xs"
								>
									<span className="text-muted-foreground">{v.label}</span>
									<ColorPicker
										className="size-6 rounded border"
										value={String(value).replace(/^#/, "")}
										onChangeEnd={(hex) =>
											setValues((prev) => ({
												...prev,
												[v.id]: `#${hex.replace(/^#/, "")}`,
											}))
										}
									/>
								</label>
							);
						}
						if (v.type === "enum" && v.options) {
							return (
								<label key={v.id} className="flex items-center justify-between gap-2 text-xs">
									<span className="text-muted-foreground">{v.label}</span>
									<Select
										value={String(value)}
										onValueChange={(next) =>
											setValues((prev) => ({ ...prev, [v.id]: next }))
										}
									>
										<SelectTrigger className="h-7 w-36">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{(v.options as { value: string; label: string }[]).map(
												(o) => (
													<SelectItem key={o.value} value={o.value}>
														{o.label}
													</SelectItem>
												),
											)}
										</SelectContent>
									</Select>
								</label>
							);
						}
						return (
							<label key={v.id} className="flex flex-col gap-1 text-xs">
								<span className="text-muted-foreground">{v.label}</span>
								<Input
									value={String(value)}
									onChange={(e) =>
										setValues((prev) => ({ ...prev, [v.id]: e.target.value }))
									}
								/>
							</label>
						);
					})}
					<Button
						className="mt-1"
						disabled={isRendering}
						onClick={() => void applySwap()}
					>
						{isRendering ? (
							<>
								<Spinner className="size-3.5" /> Rendering...
							</>
						) : (
							"Render & apply"
						)}
					</Button>
					<p className="text-muted-foreground text-[0.65rem]">
						Re-renders this clip on your computer (~10–15s) and swaps it in
						place. Undo restores the previous version.
					</p>
				</SectionContent>
			</Section>

			<Section showTopBorder={false}>
				<SectionHeader>
					<SectionTitle className="flex-1">HyperFrames Studio</SectionTitle>
				</SectionHeader>
				<SectionContent className="px-3 pb-3 flex flex-col gap-2">
					<Button
						variant="outline"
						size="sm"
						disabled={isStudioBusy}
						onClick={() => void openInStudio()}
					>
						{isStudioBusy ? (
							<>
								<Spinner className="size-3.5" /> Starting Studio...
							</>
						) : (
							"Edit in HyperFrames Studio"
						)}
					</Button>
					<Button
						variant="outline"
						size="sm"
						disabled={isPulling}
						onClick={() => void pullFromStudio()}
					>
						{isPulling ? (
							<>
								<Spinner className="size-3.5" /> Re-rendering...
							</>
						) : (
							"Pull changes from Studio"
						)}
					</Button>
					<p className="text-muted-foreground text-[0.65rem]">
						Studio opens this clip's full composition in a new tab — the same
						editing windows as HyperFrames Studio. When you're done, pull the
						changes to re-render the clip in place.
					</p>
				</SectionContent>
			</Section>
		</div>
	);
}
