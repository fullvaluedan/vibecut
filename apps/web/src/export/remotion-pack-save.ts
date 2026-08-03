/**
 * T20.3 orchestration for the Remotion media pack export: gathers the
 * timeline, media and transcript from the editor, builds the pack with the
 * pure builders in remotion-pack.ts, and writes it out. Primary path is a
 * File System Access DIRECTORY write (the pack is a folder of files a
 * Remotion kit reads straight off disk); where showDirectoryPicker is
 * missing the pack degrades to a single JSON bundle (media as base64 - the
 * size tradeoff is documented in docs/remotion-media-pack-v1.md).
 */

import type { EditorCore } from "@/core";
import { TICKS_PER_SECOND } from "@/wasm";
import { saveBufferWithPicker } from "@/export";
import {
	getCachedWords,
	getExportableTranscript,
	type TranscriptSegmentLite,
	type TranscriptWordLite,
} from "@/features/transcription/transcript-cache";
import { readTranscriptLineage } from "@/features/transcription/lineage";
import {
	arrayBufferToBase64,
	buildRemotionPack,
	buildRemotionPackBundle,
	type RemotionPackMediaInput,
} from "./remotion-pack";

declare global {
	interface Window {
		/** File System Access API directory picker - Chromium only. */
		showDirectoryPicker?: (options: {
			id?: string;
			mode?: "read" | "readwrite";
		}) => Promise<FileSystemDirectoryHandle>;
	}
}

export type RemotionPackSaveOutcome =
	| "saved-directory"
	| "saved-bundle"
	| "downloaded-bundle"
	| "cancelled";

/**
 * The best available transcript for the pack: segments from the exportable
 * (lineage-aware) path, words from the same source the segments came from so
 * the two never mix coordinate spaces.
 */
function getPackTranscript(editor: EditorCore): {
	segments: TranscriptSegmentLite[];
	words?: TranscriptWordLite[];
} | null {
	const segments = getExportableTranscript(editor);
	if (!segments || segments.length === 0) return null;
	const cachedWords = getCachedWords(editor);
	if (cachedWords.length > 0) return { segments, words: cachedWords };
	const lineage = readTranscriptLineage({ editor });
	if (lineage.status === "explained" && lineage.words.length > 0) {
		return { segments, words: lineage.words };
	}
	return { segments };
}

async function writeTextFile({
	directory,
	name,
	text,
}: {
	directory: FileSystemDirectoryHandle;
	name: string;
	text: string;
}): Promise<void> {
	const handle = await directory.getFileHandle(name, { create: true });
	const writable = await handle.createWritable();
	await writable.write(text);
	await writable.close();
}

/** Export the active scene's timeline as a Remotion media pack. */
export async function exportRemotionPack({
	editor,
}: {
	editor: EditorCore;
}): Promise<RemotionPackSaveOutcome> {
	const activeProject = editor.project.getActive();
	const tracks = editor.scenes.getActiveScene().tracks;
	const mediaAssets = editor.media.getAssets();
	const totalDurationSec =
		editor.timeline.getTotalDuration() / TICKS_PER_SECOND;

	const media: RemotionPackMediaInput[] = mediaAssets.map((asset) => ({
		id: asset.id,
		name: asset.name,
		kind: asset.type,
		fileName: asset.file?.name || asset.name,
		mimeType: asset.file?.type || undefined,
		durationSec: asset.duration,
		fps: asset.fps,
		width: asset.width,
		height: asset.height,
		hasAudio: asset.hasAudio,
		hasAlpha: asset.hasAlpha,
	}));

	const pack = buildRemotionPack({
		project: {
			id: activeProject.metadata.id,
			name: activeProject.metadata.name,
			fps: activeProject.settings.fps,
			width: activeProject.settings.canvasSize.width,
			height: activeProject.settings.canvasSize.height,
		},
		tracks,
		media,
		totalDurationSec,
		ticksPerSecond: TICKS_PER_SECOND,
		transcript: getPackTranscript(editor),
		// T20.1 style profiles land in a sibling worktree; until they merge the
		// slot is always null (docs/remotion-media-pack-v1.md).
		styleProfile: null,
	});

	const assetById = new Map(mediaAssets.map((asset) => [asset.id, asset]));

	if (window.showDirectoryPicker) {
		let directory: FileSystemDirectoryHandle;
		try {
			directory = await window.showDirectoryPicker({
				id: "vibecut-remotion-pack",
				mode: "readwrite",
			});
		} catch (e) {
			if (e instanceof DOMException && e.name === "AbortError") {
				return "cancelled";
			}
			throw e;
		}
		await writeTextFile({
			directory,
			name: "manifest.json",
			text: JSON.stringify(pack.manifest, null, 2),
		});
		await writeTextFile({
			directory,
			name: "edl.json",
			text: JSON.stringify(pack.edl, null, 2),
		});
		if (pack.transcript) {
			await writeTextFile({
				directory,
				name: "transcript.json",
				text: JSON.stringify(pack.transcript, null, 2),
			});
		}
		const mediaDir = await directory.getDirectoryHandle("media", {
			create: true,
		});
		for (const file of pack.mediaFiles) {
			const asset = assetById.get(file.mediaId);
			if (!asset?.file) continue;
			const name = file.path.slice("media/".length);
			const handle = await mediaDir.getFileHandle(name, { create: true });
			const writable = await handle.createWritable();
			await writable.write(asset.file);
			await writable.close();
		}
		return "saved-directory";
	}

	// Fallback: single JSON bundle with base64 media (see the spec's size
	// tradeoff note), saved through the same picker pattern as video exports.
	const mediaData = new Map<string, string>();
	for (const file of pack.mediaFiles) {
		const asset = assetById.get(file.mediaId);
		if (!asset?.file) continue;
		mediaData.set(
			file.mediaId,
			arrayBufferToBase64({ buffer: await asset.file.arrayBuffer() }),
		);
	}
	const bundle = buildRemotionPackBundle({ pack, mediaData });
	const buffer = new TextEncoder().encode(JSON.stringify(bundle)).buffer;
	const result = await saveBufferWithPicker({
		buffer,
		filename: `${activeProject.metadata.name}.remotion-pack.json`,
		mimeType: "application/json",
	});
	if (result === "cancelled") return "cancelled";
	return result === "saved" ? "saved-bundle" : "downloaded-bundle";
}
