import { cloneAnimations } from "@/animation";
import type { ElementAnimations } from "@/animation/types";
import type { MediaAsset } from "@/media/types";
import { DEFAULTS } from "@/timeline/defaults";
import { generateUUID } from "@/utils/id";
import type {
	CreateUploadAudioElement,
	CreateVideoElement,
	TimelineElement,
	AudioElement,
	VideoElement,
} from "../types";

type MediaAudioState = Pick<MediaAsset, "hasAudio">;

export function isSourceAudioEnabled({
	element,
}: {
	element: VideoElement;
}): boolean {
	return element.isSourceAudioEnabled !== false;
}

export function isSourceAudioSeparated({
	element,
}: {
	element: VideoElement;
}): boolean {
	return !isSourceAudioEnabled({ element });
}

export function canExtractSourceAudio(
	element: TimelineElement,
	mediaAsset: MediaAudioState | null | undefined,
): element is VideoElement {
	return (
		element.type === "video" &&
		isSourceAudioEnabled({ element }) &&
		!!mediaAsset &&
		mediaAsset.hasAudio !== false
	);
}

export function canRecoverSourceAudio(
	element: TimelineElement,
): element is VideoElement {
	return element.type === "video" && isSourceAudioSeparated({ element });
}

export function canToggleSourceAudio(
	element: TimelineElement,
	mediaAsset: MediaAudioState | null | undefined,
): element is VideoElement {
	return (
		canRecoverSourceAudio(element) || canExtractSourceAudio(element, mediaAsset)
	);
}

export function doesElementHaveEnabledAudio({
	element,
	mediaAsset,
}: {
	element: AudioElement | VideoElement;
	mediaAsset?: MediaAudioState | null;
}): boolean {
	if (element.type === "audio") {
		return true;
	}

	return (
		!!mediaAsset &&
		mediaAsset.hasAudio !== false &&
		isSourceAudioEnabled({ element })
	);
}

export function buildSeparatedAudioElement({
	sourceElement,
}: {
	// Accepts a not-yet-inserted create-shape (Omit<VideoElement,"id">) too, so the
	// separated audio can be built BEFORE insert (drag-from-bin batch). A full
	// VideoElement is still assignable. Only non-id fields are read.
	sourceElement: CreateVideoElement;
}): CreateUploadAudioElement {
	return {
		type: "audio",
		sourceType: "upload",
		mediaId: sourceElement.mediaId,
		name: sourceElement.name,
		duration: sourceElement.duration,
		startTime: sourceElement.startTime,
		trimStart: sourceElement.trimStart,
		trimEnd: sourceElement.trimEnd,
		sourceDuration: sourceElement.sourceDuration,
		params: {
			volume:
				typeof sourceElement.params.volume === "number"
					? sourceElement.params.volume
					: DEFAULTS.element.volume,
			muted: sourceElement.params.muted === true,
		},
		retime: sourceElement.retime
			? {
					rate: sourceElement.retime.rate,
					maintainPitch: sourceElement.retime.maintainPitch,
				}
			: undefined,
		animations: cloneVolumeAnimations({
			animations: sourceElement.animations,
		}),
	};
}

/**
 * Build a video + its separated source-audio as a LINKED pair, ready to insert in
 * one batch (drag-from-bin) instead of insert-then-toggle. The video is returned
 * pre-marked separated (`isSourceAudioEnabled: false`) and both share a fresh
 * `linkId`. Returns null when there's nothing to separate — mirrors
 * `canExtractSourceAudio` but works on a not-yet-inserted create-shape (which has
 * no `id`, so it can't satisfy the `TimelineElement`-typed guards): a video whose
 * source audio is still enabled, on an asset whose audio wasn't detected absent.
 */
export function buildSeparatedVideoAudioPair({
	videoElement,
	mediaAsset,
}: {
	videoElement: CreateVideoElement;
	mediaAsset: MediaAudioState | null | undefined;
}): { video: CreateVideoElement; audio: CreateUploadAudioElement } | null {
	if (
		videoElement.isSourceAudioEnabled === false ||
		!mediaAsset ||
		mediaAsset.hasAudio === false
	) {
		return null;
	}
	const linkId = generateUUID();
	return {
		video: { ...videoElement, isSourceAudioEnabled: false, linkId },
		audio: { ...buildSeparatedAudioElement({ sourceElement: videoElement }), linkId },
	};
}

export function getSourceAudioActionLabel({
	element,
}: {
	element: VideoElement;
}): "Extract audio" | "Recover audio" {
	return isSourceAudioSeparated({ element })
		? "Recover audio"
		: "Extract audio";
}

function cloneVolumeAnimations({
	animations,
}: {
	animations: ElementAnimations | undefined;
}): ElementAnimations | undefined {
	const volumeData = animations?.volume;
	if (!volumeData) {
		return undefined;
	}

	return cloneAnimations({
		animations: { volume: volumeData },
		shouldRegenerateKeyframeIds: true,
	});
}
