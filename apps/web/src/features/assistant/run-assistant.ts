/**
 * The preview prompt box: one natural-language ask → one editor action.
 * Claude routes the request (server-side, /api/assistant) into a strict
 * command schema railed to what VibeCut can actually do — video, audio,
 * graphics, HyperFrames, captions — and this module executes it.
 */

import { toast } from "sonner";
import type { EditorCore } from "@/core";
import {
	buildAiAuthHeaders,
	useAiSettingsStore,
} from "@/features/ai-generate/store";
import {
	buildLibraryAudioElement,
	buildTextElement,
} from "@/timeline/element-utils";
import { mediaTimeFromSeconds } from "@/wasm";
import { processMediaAssets } from "@/media/processing";
import { useAssetsPanelStore } from "@/components/editor/panels/assets/assets-panel-store";
import type { AssistantCommand } from "@/app/api/assistant/route";
import type { HeygenSound } from "@/app/api/heygen/audio-search/route";
import type { BrollResult } from "@/app/api/broll/search/route";

export async function runAssistant({
	editor,
	prompt,
	onStage,
}: {
	editor: EditorCore;
	prompt: string;
	onStage?: (stage: string) => void;
}): Promise<void> {
	onStage?.("Thinking...");
	const res = await fetch("/api/assistant", {
		method: "POST",
		headers: { "content-type": "application/json", ...buildAiAuthHeaders() },
		body: JSON.stringify({ prompt }),
	});
	if (!res.ok) {
		const err = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(err?.error ?? `Assistant failed (${res.status})`);
	}
	const { command } = (await res.json()) as { command: AssistantCommand };

	switch (command.command) {
		case "reject":
			toast.info("I can't help with that here", {
				description:
					command.reason ||
					"The prompt box edits this video: cuts, b-roll, music, effects, text, and captions.",
			});
			return;

		case "ai_cut": {
			const mode = command.mode;
			onStage?.("Cutting...");
			if (mode === "silences") {
				const { runRemoveSilences } = await import(
					"@/features/editing/remove-silences"
				);
				const r = await runRemoveSilences({ editor });
				toast.success(
					`Removed ${r.cuts} silence${r.cuts === 1 ? "" : "s"} (${r.removedSec.toFixed(1)}s)`,
					{ description: "Ctrl+Z restores everything." },
				);
				return;
			}
			const { runRemoveRepeats, runFullCleanup, runYouTubeCut } = await import(
				"@/features/editing/remove-repeats"
			);
			const fn =
				mode === "repeats"
					? () => runRemoveRepeats({ editor, onProgress: onStage })
					: mode === "cleanup"
						? () => runFullCleanup({ editor, onProgress: onStage })
						: () => runYouTubeCut({ editor, onProgress: onStage });
			const r = await fn();
			toast.success(
				r.cuts === 0
					? "Nothing to cut"
					: `AI Cut: ${r.cuts} cut${r.cuts === 1 ? "" : "s"}, ${r.removedSec.toFixed(1)}s removed`,
				{ description: "Ctrl+Z restores everything." },
			);
			return;
		}

		case "run_hyperframes": {
			const { runHyperframes } = await import(
				"@/features/ai-generate/run-hyperframes"
			);
			if (command.direction?.trim()) {
				useAiSettingsStore.getState().setHfDirection(command.direction.trim());
			}
			const result = await runHyperframes({
				editor,
				onProgress: (p) => onStage?.(p.detail ?? "Generating effects..."),
			});
			toast.success(
				`HyperFrames: placed ${result.placed} effect${result.placed === 1 ? "" : "s"}`,
				{
					description: result.skipped.length
						? `${result.skipped.length} skipped`
						: undefined,
				},
			);
			return;
		}

		case "find_audio": {
			const { heygenApiKey } = useAiSettingsStore.getState();
			if (!heygenApiKey) {
				toast.error("Music & SFX search needs a HeyGen API key", {
					description: "Add one in Settings → AI → Integrations.",
				});
				return;
			}
			onStage?.(`Searching ${command.audioType === "music" ? "music" : "sound effects"}...`);
			const searchRes = await fetch("/api/heygen/audio-search", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-framecut-heygen-key": heygenApiKey,
				},
				body: JSON.stringify({
					query: command.query,
					type: command.audioType,
					limit: 1,
				}),
			});
			if (!searchRes.ok) {
				const err = (await searchRes.json().catch(() => null)) as {
					error?: string;
				} | null;
				throw new Error(err?.error ?? `Audio search failed (${searchRes.status})`);
			}
			const { sounds } = (await searchRes.json()) as { sounds: HeygenSound[] };
			const top = sounds[0];
			if (!top) {
				toast.info(`No ${command.audioType === "music" ? "music" : "sound effect"} found for "${command.query}"`);
				return;
			}
			onStage?.(`Adding "${top.name}"...`);
			await insertRemoteAudioAtPlayhead({
				editor,
				url: `/api/heygen/audio-proxy?url=${encodeURIComponent(top.audioUrl)}`,
				name: top.name,
				durationSec: top.duration ?? undefined,
			});
			toast.success(`Added "${top.name}" at the playhead`, {
				description: "More options live in the Sounds panel → Music & SFX tab.",
			});
			return;
		}

		case "find_broll": {
			const { serpApiKey } = useAiSettingsStore.getState();
			if (!serpApiKey) {
				toast.error("Find b-roll needs a SerpAPI key", {
					description: "Add one in Settings → AI → Integrations.",
				});
				return;
			}
			onStage?.(`Searching b-roll: ${command.query}...`);
			const searchRes = await fetch("/api/broll/search", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-framecut-serpapi-key": serpApiKey,
				},
				body: JSON.stringify({ query: command.query, limit: 4 }),
			});
			if (!searchRes.ok) {
				const err = (await searchRes.json().catch(() => null)) as {
					error?: string;
				} | null;
				throw new Error(err?.error ?? `B-roll search failed (${searchRes.status})`);
			}
			const { results } = (await searchRes.json()) as { results: BrollResult[] };
			if (!results.length) {
				toast.info(`No b-roll found for "${command.query}"`);
				return;
			}
			onStage?.(`Importing ${results.length} b-roll images...`);
			let imported = 0;
			for (const result of results) {
				try {
					const imgRes = await fetch(
						`/api/broll/fetch?url=${encodeURIComponent(result.imageUrl)}`,
					);
					if (!imgRes.ok) continue;
					const blob = await imgRes.blob();
					const ext = blob.type.split("/")[1]?.split("+")[0] || "jpg";
					const file = new File(
						[blob],
						`broll-${command.query.replace(/\W+/g, "-").slice(0, 40)}-${imported + 1}.${ext}`,
						{ type: blob.type },
					);
					const [asset] = await processMediaAssets({ files: [file] });
					if (!asset) continue;
					await editor.media.addMediaAsset({
						projectId: editor.project.getActive().metadata.id,
						asset,
					});
					imported += 1;
				} catch {
					// Skip failed downloads; report what landed.
				}
			}
			if (imported === 0) {
				throw new Error("Found results but none could be downloaded.");
			}
			useAssetsPanelStore.getState().setActiveTab("media");
			toast.success(
				`Added ${imported} b-roll image${imported === 1 ? "" : "s"} to your media bin`,
				{ description: "Stills for now — drag them in and add motion. Stock video b-roll is on the roadmap." },
			);
			return;
		}

		case "add_text": {
			const element = buildTextElement({
				raw: {
					name: command.text.slice(0, 24) || "Text",
					params: { content: command.text },
				},
				startTime: editor.playback.getCurrentTime(),
			});
			editor.timeline.insertElement({ element, placement: { mode: "auto" } });
			toast.success("Text added at the playhead", {
				description: "Style it in the properties panel on the right.",
			});
			return;
		}

		case "open_captions": {
			useAssetsPanelStore.getState().setActiveTab("captions");
			toast.info("Captions panel opened", {
				description:
					"Generate captions there, then one-click styles (Neon Accent, Pill Karaoke...) apply to them.",
			});
			return;
		}
	}
}

async function insertRemoteAudioAtPlayhead({
	editor,
	url,
	name,
	durationSec,
}: {
	editor: EditorCore;
	url: string;
	name: string;
	durationSec?: number;
}): Promise<void> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Audio download failed (${response.status})`);
	}
	const arrayBuffer = await response.arrayBuffer();
	const audioContext = new AudioContext();
	const buffer = await audioContext.decodeAudioData(arrayBuffer);
	const element = buildLibraryAudioElement({
		sourceUrl: url,
		name,
		duration: mediaTimeFromSeconds({ seconds: durationSec ?? buffer.duration }),
		startTime: editor.playback.getCurrentTime(),
		buffer,
	});
	editor.timeline.insertElement({
		placement: { mode: "auto", trackType: "audio" },
		element,
	});
}
