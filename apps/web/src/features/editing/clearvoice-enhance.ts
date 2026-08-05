/**
 * ClearVoice quality enhancement (ClearerVoice-Studio integration).
 *
 * Sends the SELECTED clip's audible source span to the local ClearVoice
 * service (`services/audio-enhance`, reached through `/api/audio-enhance`) and
 * swaps the clip's audio for the enhanced result as ONE undoable batch:
 *
 *  - an audio clip: its `mediaId` points at the new enhanced asset (trims reset
 *    because the asset already contains exactly the used span);
 *  - a video clip with a linked separated audio element: that element is
 *    replaced, so the link and A/V sync survive;
 *  - a video clip still playing source audio: source audio is muted
 *    (`isSourceAudioEnabled: false`) and a linked enhanced audio element is
 *    inserted on an audio track.
 *
 * The pure helpers here are unit-tested; the editor plumbing mirrors the
 * round-17/18 command patterns (BatchCommand + UpdateElementsCommand).
 */

import { BatchCommand } from "@/commands";
import { InsertElementCommand } from "@/commands/timeline/element/insert-element";
import { UpdateElementsCommand } from "@/commands/timeline/element/update-elements";
import type { EditorCore } from "@/core";
import { decodeAssetAudioToFloat32 } from "@/media/audio";
import type { MediaAsset } from "@/media/types";
import type {
	AudioElement,
	CreateTimelineElement,
	TimelineElement,
	VideoElement,
} from "@/timeline";
import { generateUUID } from "@/utils/id";
import {
	TICKS_PER_SECOND,
	ZERO_MEDIA_TIME,
	mediaTimeToSeconds,
	roundMediaTime,
	type MediaTime,
} from "@/wasm";

export type ClearvoiceEnhanceTask = "denoise" | "super_resolution";

/** Stable UI order for the task options. */
export const CLEARVOICE_ENHANCE_TASK_ORDER: ClearvoiceEnhanceTask[] = [
	"denoise",
	"super_resolution",
];

export const CLEARVOICE_ENHANCE_OPTIONS: Record<
	ClearvoiceEnhanceTask,
	{ label: string; description: string }
> = {
	denoise: {
		label: "Reduce noise",
		description: "ClearVoice FRCRN - removes background noise",
	},
	super_resolution: {
		label: "Improve clarity",
		description: "ClearVoice MossFormer2 - upscales speech to 48kHz",
	},
};

/** ClearVoice's 16k models work on our analysis-rate extraction. */
const ANALYSIS_SAMPLE_RATE = 16000;

export type ClearvoiceEnhanceTarget =
	| {
			kind: "replace";
			trackId: string;
			element: AudioElement;
			asset: MediaAsset;
	  }
	| {
			kind: "video-insert";
			trackId: string;
			element: VideoElement;
			asset: MediaAsset;
			linkId: string;
	  };

type TargetResult =
	| { target: ClearvoiceEnhanceTarget }
	| { error: string };

/** The visible source span (seconds) this clip plays from its asset. */
export function computeVisibleSourceSpanSeconds({
	element,
}: {
	element: { duration: MediaTime; retime?: { rate?: number } };
}): number {
	const rate =
		element.retime && element.retime.rate ? element.retime.rate : 1;
	const durationSec = mediaTimeToSeconds({ time: element.duration });
	return durationSec / (rate > 0 ? rate : 1);
}

/** Slice the decoded asset samples to [startSec, startSec + spanSec). */
export function sliceSourceSamples({
	samples,
	sampleRate,
	startSec,
	spanSec,
}: {
	samples: Float32Array;
	sampleRate: number;
	startSec: number;
	spanSec: number;
}): Float32Array {
	if (samples.length === 0) return new Float32Array(0);
	const start = Math.max(
		0,
		Math.min(samples.length - 1, Math.floor(startSec * sampleRate)),
	);
	const span = Math.max(1, Math.floor(spanSec * sampleRate));
	return samples.subarray(start, Math.min(samples.length, start + span));
}

/** 16-bit mono PCM WAV from float samples in [-1, 1]. */
export function encodeWavBlob({
	samples,
	sampleRate,
}: {
	samples: Float32Array;
	sampleRate: number;
}): Blob {
	const numChannels = 1;
	const bitsPerSample = 16;
	const bytesPerSample = bitsPerSample / 8;
	const dataSize = samples.length * bytesPerSample;
	const buffer = new ArrayBuffer(44 + dataSize);
	const view = new DataView(buffer);

	const writeString = ({ offset, str }: { offset: number; str: string }) => {
		for (let i = 0; i < str.length; i++) {
			view.setUint8(offset + i, str.charCodeAt(i));
		}
	};

	writeString({ offset: 0, str: "RIFF" });
	view.setUint32(4, 36 + dataSize, true);
	writeString({ offset: 8, str: "WAVE" });
	writeString({ offset: 12, str: "fmt " });
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, numChannels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
	view.setUint16(32, numChannels * bytesPerSample, true);
	view.setUint16(34, bitsPerSample, true);
	writeString({ offset: 36, str: "data" });
	view.setUint32(40, dataSize, true);

	const pcm = new Int16Array(buffer, 44);
	for (let i = 0; i < samples.length; i++) {
		const clamped = Math.max(-1, Math.min(1, samples[i]));
		pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
	}
	return new Blob([buffer], { type: "audio/wav" });
}

function readErrorMessage(body: unknown): string | undefined {
	if (typeof body !== "object" || body === null) return undefined;
	if (!("error" in body)) return undefined;
	const value: unknown = body.error;
	return typeof value === "string" ? value : undefined;
}

function findLinkedAudioElement({
	tracks,
	linkId,
}: {
	tracks: ReturnType<EditorCore["scenes"]["getActiveScene"]>["tracks"];
	linkId: string;
}): { trackId: string; element: AudioElement } | null {
	for (const track of [...tracks.overlay, tracks.main, ...tracks.audio]) {
		if (track.type !== "audio") continue;
		for (const element of track.elements) {
			if (element.type === "audio" && element.linkId === linkId) {
				return { trackId: track.id, element };
			}
		}
	}
	return null;
}

/** Resolve the audio-bearing target for ONE selected element. */
export function resolveEnhanceTargetForElement({
	editor,
	trackId,
	element,
}: {
	editor: EditorCore;
	trackId: string;
	element: TimelineElement;
}): TargetResult {
	if (element.type === "audio") {
		if (element.sourceType !== "upload") {
			return {
				error:
					"Library audio clips can't be enhanced yet - use a clip from your media.",
			};
		}
		const asset = editor.media
			.getAssets()
			.find((a) => a.id === element.mediaId);
		if (!asset || asset.hasAudio === false) {
			return { error: "This clip's source media was not found." };
		}
		return { target: { kind: "replace", trackId, element, asset } };
	}

	if (element.type === "video") {
		const asset = editor.media
			.getAssets()
			.find((a) => a.id === element.mediaId);
		if (!asset || asset.hasAudio === false) {
			return { error: "This video clip has no audio to enhance." };
		}
		if (element.linkId) {
			const tracks = editor.scenes.getActiveScene().tracks;
			const linked = findLinkedAudioElement({
				tracks,
				linkId: element.linkId,
			});
			if (linked) {
				return {
					target: {
						kind: "replace",
						trackId: linked.trackId,
						element: linked.element,
						asset,
					},
				};
			}
		}
		if (element.isSourceAudioEnabled === false) {
			return {
				error: "This clip's source audio is off - select its audio clip instead.",
			};
		}
		return {
			target: {
				kind: "video-insert",
				trackId,
				element,
				asset,
				linkId: element.linkId ?? generateUUID(),
			},
		};
	}

	return { error: "Select an audio or video clip." };
}

/**
 * Resolve the single enhancement target from the current selection. A linked
 * video + separated-audio pair counts as ONE target (the audio element wins);
 * two unrelated clips are rejected - v1 enhances one clip at a time.
 */
export function resolveEnhanceTargetFromSelection({
	editor,
}: {
	editor: EditorCore;
}): TargetResult {
	const refs = editor.selection.getSelectedElements();
	const pairs = editor.timeline.getElementsWithTracks({ elements: refs });
	const seen = new Set<string>();
	let single: ClearvoiceEnhanceTarget | null = null;

	for (const { track, element } of pairs) {
		const result = resolveEnhanceTargetForElement({
			editor,
			trackId: track.id,
			element,
		});
		if ("error" in result) continue;
		const key = result.target.element.id;
		if (seen.has(key)) continue;
		seen.add(key);
		if (single && single !== result.target) {
			return { error: "Select one audio clip to enhance." };
		}
		single = result.target;
	}

	return single ? { target: single } : { error: "Select an audio or video clip first." };
}

function assertEnhanceableRetime(element: TimelineElement): void {
	if (
		"retime" in element &&
		element.retime &&
		(element.retime.reversed || element.retime.curve)
	) {
		throw new Error(
			"Reversed and speed-curved clips can't be enhanced yet - set them back to normal speed first.",
		);
	}
}

function buildSourceDuration({ spanSec }: { spanSec: number }) {
	return roundMediaTime({ time: spanSec * TICKS_PER_SECOND });
}

/**
 * Run one enhancement: extract the clip's source span, POST it to the
 * ClearVoice service, import the result as a media asset, and swap the
 * timeline audio in a single undoable batch.
 */
export async function enhanceAudioTarget({
	editor,
	target,
	task,
}: {
	editor: EditorCore;
	target: ClearvoiceEnhanceTarget;
	task: ClearvoiceEnhanceTask;
}): Promise<{ assetName: string; mode: "replaced" | "inserted" }> {
	const element = target.element;
	assertEnhanceableRetime(element);

	const startSec = mediaTimeToSeconds({ time: element.trimStart });
	const spanSec = computeVisibleSourceSpanSeconds({ element });
	const decoded = await decodeAssetAudioToFloat32({
		asset: target.asset,
		sampleRate: ANALYSIS_SAMPLE_RATE,
	});
	if (!decoded || decoded.samples.length === 0) {
		throw new Error("No decodable audio in this clip.");
	}
	const sliced = sliceSourceSamples({
		samples: decoded.samples,
		sampleRate: decoded.sampleRate,
		startSec,
		spanSec,
	});
	if (sliced.length < 1600) {
		throw new Error("The clip's audio is too short to enhance.");
	}
	const requestWav = encodeWavBlob({
		samples: sliced,
		sampleRate: decoded.sampleRate,
	});

	const label = CLEARVOICE_ENHANCE_OPTIONS[task].label;
	const baseName = (element.name || "audio").replace(/\.[^.]+$/, "");
	const assetName = `${baseName} - ${label}`;

	// Raw WAV body + query task: the Python service's multipart parser caps
	// parts at 1 MB, which would reject any clip longer than ~30 seconds, so
	// the proxy and service use a raw-body transport instead.
	const res = await fetch(
		`/api/audio-enhance?task=${encodeURIComponent(task)}`,
		{
			method: "POST",
			headers: { "content-type": "audio/wav" },
			body: requestWav,
		},
	);
	if (!res.ok) {
		const body = await res.json().catch(() => null);
		throw new Error(
			readErrorMessage(body) ?? `Audio enhancement failed (${res.status}).`,
		);
	}
	const enhanced = await res.blob();
	if (enhanced.size === 0) {
		throw new Error("The enhancer returned an empty result.");
	}

	const project = editor.project.getActive();
	if (!project) throw new Error("No active project.");
	const enhancedFile = new File([enhanced], `${assetName}.wav`, {
		type: "audio/wav",
	});
	const newAsset = await editor.media.addMediaAsset({
		projectId: project.metadata.id,
		asset: {
			name: assetName,
			type: "audio",
			hasAudio: true,
			duration: spanSec,
			file: enhancedFile,
		},
	});
	if (!newAsset) {
		throw new Error("Could not save the enhanced audio (browser storage).");
	}

	const sourceDuration = buildSourceDuration({ spanSec });

	if (target.kind === "replace") {
		editor.command.execute({
			command: new UpdateElementsCommand({
				updates: [
					{
						trackId: target.trackId,
						elementId: target.element.id,
						patch: {
							mediaId: newAsset.id,
							sourceType: "upload",
							trimStart: ZERO_MEDIA_TIME,
							trimEnd: ZERO_MEDIA_TIME,
							sourceDuration,
						} as Partial<TimelineElement>,
					},
				],
			}),
		});
		return { assetName, mode: "replaced" };
	}

	const insertedElement = {
		type: "audio",
		sourceType: "upload",
		mediaId: newAsset.id,
		name: assetName,
		startTime: target.element.startTime,
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		duration: target.element.duration,
		sourceDuration,
		linkId: target.linkId,
		retime: target.element.retime,
		params: {},
	} as CreateTimelineElement;

	editor.command.execute({
		command: new BatchCommand([
			new UpdateElementsCommand({
				updates: [
					{
						trackId: target.trackId,
						elementId: target.element.id,
						patch: {
							isSourceAudioEnabled: false,
							linkId: target.linkId,
						} as Partial<TimelineElement>,
					},
				],
			}),
			new InsertElementCommand({
				element: insertedElement,
				placement: { mode: "auto", trackType: "audio" },
			}),
		]),
	});
	return { assetName, mode: "inserted" };
}

/** Audio-tab entry: enhance the element shown in the inspector. */
export async function enhanceClipQuality({
	editor,
	trackId,
	element,
	task,
}: {
	editor: EditorCore;
	trackId: string;
	element: TimelineElement;
	task: ClearvoiceEnhanceTask;
}): Promise<{ assetName: string; mode: "replaced" | "inserted" }> {
	const result = resolveEnhanceTargetForElement({ editor, trackId, element });
	if ("error" in result) throw new Error(result.error);
	return enhanceAudioTarget({ editor, target: result.target, task });
}

/** Toolbar entry: enhance whatever audio-bearing clip is selected. */
export async function enhanceSelectedAudio({
	editor,
	task,
}: {
	editor: EditorCore;
	task: ClearvoiceEnhanceTask;
}): Promise<{ assetName: string; mode: "replaced" | "inserted" }> {
	const result = resolveEnhanceTargetFromSelection({ editor });
	if ("error" in result) throw new Error(result.error);
	return enhanceAudioTarget({ editor, target: result.target, task });
}
