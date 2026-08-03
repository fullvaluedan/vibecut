/**
 * Remotion media pack (T20.3): pure serializers that turn a VibeCut timeline
 * into the pack the external dan-video Remotion kits consume. The format
 * contract is docs/remotion-media-pack-v1.md - this module is its only
 * writer, so the doc and the code cannot drift in two places.
 *
 * Everything here is pure and DOM-free (times arrive as ticks plus an
 * explicit `ticksPerSecond`, media arrives as lean descriptors) so the whole
 * module is unit-testable without an editor, a File, or the wasm pull-in.
 * Reading bytes and writing to disk lives in remotion-pack-save.ts.
 */

import type { SceneTracks, TimelineTrack, VideoElement } from "@/timeline/types";
import type {
	TranscriptSegmentLite,
	TranscriptWordLite,
} from "@/features/transcription/transcript-cache";

export const REMOTION_PACK_FORMAT = "framecut-remotion-pack";
export const REMOTION_PACK_BUNDLE_FORMAT = "framecut-remotion-pack-bundle";
export const REMOTION_PACK_VERSION = 1;

/**
 * Forward-compatible slot for the T20.1 style preference profiles. Until
 * that lands the exporter always serializes `styleProfile: null`; the field
 * names here are the contract the profile system serializes into.
 */
export interface RemotionStyleProfile {
	palette: { accent: string; supporting: string[] };
	fonts: { display: string; body: string };
	motionStyle: "calm" | "standard" | "punchy";
	density: "sparse" | "balanced" | "dense";
}

export interface RemotionPackFps {
	numerator: number;
	denominator: number;
}

/** Lean media descriptor: everything the pack needs to know about an asset. */
export interface RemotionPackMediaInput {
	id: string;
	name: string;
	kind: "image" | "video" | "audio";
	/** Stored file name (extension source), e.g. "interview.mp4". */
	fileName: string;
	/** Mime fallback for the extension when the file name has none. */
	mimeType?: string;
	durationSec?: number;
	fps?: number;
	width?: number;
	height?: number;
	hasAudio?: boolean;
	hasAlpha?: boolean;
}

export interface RemotionPackInput {
	project: {
		id: string;
		name: string;
		fps: RemotionPackFps;
		width: number;
		height: number;
	};
	tracks: SceneTracks;
	media: RemotionPackMediaInput[];
	/** Project content duration in SECONDS. */
	totalDurationSec: number;
	/** Timeline ticks per second (MediaTime conversion). */
	ticksPerSecond: number;
	transcript?: {
		segments: TranscriptSegmentLite[];
		words?: TranscriptWordLite[];
	} | null;
	/** Absent or null until T20.1 lands. */
	styleProfile?: RemotionStyleProfile | null;
	/** Injectable for deterministic tests. */
	generatedAt?: string;
}

export type RemotionTrackRole =
	| "main-video"
	| "overlay-video"
	| "overlay-text"
	| "overlay-graphic"
	| "overlay-effect"
	| "audio";

export interface RemotionFramecutAiRef {
	compId: string;
	templateId?: string;
	registryBlock?: string;
	groupId?: string;
}

export interface RemotionEdlClip {
	id: string;
	name: string;
	kind: "video" | "image" | "audio" | "text" | "sticker" | "graphic" | "effect";
	timelineStartSec: number;
	durationSec: number;
	hidden?: boolean;
	mediaId?: string;
	mediaPath?: string;
	/** Library audio is a URL reference, not packed media. */
	sourceUrl?: string;
	trimStartSec?: number;
	trimEndSec?: number;
	sourceDurationSec?: number;
	retime?: { rate: number; reversed?: boolean };
	linkId?: string;
	framecutAi?: RemotionFramecutAiRef;
}

export interface RemotionEdlTrack {
	id: string;
	name: string;
	role: RemotionTrackRole;
	muted?: boolean;
	hidden?: boolean;
	clips: RemotionEdlClip[];
}

export interface RemotionEdl {
	format: "framecut-edl";
	version: number;
	fps: RemotionPackFps;
	durationSec: number;
	tracks: RemotionEdlTrack[];
}

export interface RemotionTranscript {
	format: "framecut-transcript";
	version: number;
	segments: TranscriptSegmentLite[];
	words?: TranscriptWordLite[];
}

export interface RemotionManifestMedia {
	id: string;
	name: string;
	path: string;
	kind: "image" | "video" | "audio";
	durationSec?: number;
	fps?: number;
	width?: number;
	height?: number;
	hasAudio?: boolean;
	hasAlpha?: boolean;
	roles: ("main" | "overlay" | "audio")[];
	generated: boolean;
	framecutAi?: RemotionFramecutAiRef;
}

export interface RemotionManifest {
	format: typeof REMOTION_PACK_FORMAT;
	version: number;
	generatedAt: string;
	generator: "vibecut";
	project: {
		id: string;
		name: string;
		fps: RemotionPackFps;
		canvas: { width: number; height: number };
		durationSec: number;
	};
	files: { edl: string; transcript: string | null };
	styleProfile: RemotionStyleProfile | null;
	tracks: {
		id: string;
		name: string;
		role: RemotionTrackRole;
		clipCount: number;
		durationSec: number;
	}[];
	media: RemotionManifestMedia[];
	framecutAi: {
		compId: string;
		templateId?: string;
		registryBlock?: string;
		mediaId: string;
		clipIds: string[];
	}[];
}

export interface BuiltRemotionPack {
	manifest: RemotionManifest;
	edl: RemotionEdl;
	transcript: RemotionTranscript | null;
	/** Media files to write, in pack-relative path order. */
	mediaFiles: { mediaId: string; path: string }[];
}

export type RemotionPackBundleFile =
	| { path: string; encoding: "utf8"; text: string }
	| { path: string; encoding: "base64"; data: string };

export interface RemotionPackBundle {
	format: typeof REMOTION_PACK_BUNDLE_FORMAT;
	version: number;
	manifest: RemotionManifest;
	files: RemotionPackBundleFile[];
}

const MIME_EXTENSIONS: Record<string, string> = {
	"video/webm": "webm",
	"video/mp4": "mp4",
	"video/quicktime": "mov",
	"audio/mpeg": "mp3",
	"audio/wav": "wav",
	"audio/x-wav": "wav",
	"audio/ogg": "ogg",
	"audio/aac": "aac",
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
};

/** Lowercased, non-alphanumerics collapsed to "-", capped at 40 chars. */
export function slugifyMediaName({ name }: { name: string }): string {
	const base = name.includes(".")
		? name.slice(0, name.lastIndexOf("."))
		: name;
	const slug = base
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "");
	return slug || "media";
}

export function mediaExtension({
	fileName,
	mimeType,
}: {
	fileName: string;
	mimeType?: string;
}): string {
	const dot = fileName.lastIndexOf(".");
	if (dot > 0 && dot < fileName.length - 1) {
		return fileName.slice(dot + 1).toLowerCase();
	}
	return (mimeType && MIME_EXTENSIONS[mimeType]) || "bin";
}

/** Pack-relative media path. The asset id guarantees uniqueness. */
export function mediaPackPath({
	media,
}: {
	media: RemotionPackMediaInput;
}): string {
	const slug = slugifyMediaName({ name: media.fileName || media.name });
	const ext = mediaExtension({
		fileName: media.fileName,
		mimeType: media.mimeType,
	});
	return `media/${media.id}-${slug}.${ext}`;
}

function trackRole({
	track,
	isMain,
}: {
	track: TimelineTrack;
	isMain: boolean;
}): RemotionTrackRole {
	if (isMain) return "main-video";
	if (track.type === "audio") return "audio";
	if (track.type === "video") return "overlay-video";
	if (track.type === "text") return "overlay-text";
	if (track.type === "effect") return "overlay-effect";
	return "overlay-graphic";
}

function toFramecutAiRef(
	framecutAi: NonNullable<VideoElement["framecutAi"]>,
): RemotionFramecutAiRef {
	const ref: RemotionFramecutAiRef = {
		compId: framecutAi.compId,
		groupId: framecutAi.groupId,
	};
	if (framecutAi.templateId) ref.templateId = framecutAi.templateId;
	if (framecutAi.registryBlock) ref.registryBlock = framecutAi.registryBlock;
	return ref;
}

/**
 * Build the whole logical pack in one pass so the EDL, the manifest and the
 * media file list cannot disagree (they share the same path map).
 */
export function buildRemotionPack(input: RemotionPackInput): BuiltRemotionPack {
	const { ticksPerSecond } = input;
	const toSec = (ticks: number) => ticks / ticksPerSecond;

	const pathByMediaId = new Map<string, string>();
	for (const media of input.media) {
		pathByMediaId.set(media.id, mediaPackPath({ media }));
	}

	// role/generation accumulation per referenced asset
	const usageByMediaId = new Map<
		string,
		{ roles: Set<"main" | "overlay" | "audio">; framecutAi?: RemotionFramecutAiRef }
	>();
	const noteUsage = ({
		mediaId,
		role,
		framecutAi,
	}: {
		mediaId: string;
		role: "main" | "overlay" | "audio";
		framecutAi?: RemotionFramecutAiRef;
	}) => {
		let usage = usageByMediaId.get(mediaId);
		if (!usage) {
			usage = { roles: new Set() };
			usageByMediaId.set(mediaId, usage);
		}
		usage.roles.add(role);
		if (framecutAi && !usage.framecutAi) usage.framecutAi = framecutAi;
	};

	const edlTracks: RemotionEdlTrack[] = [];
	const manifestTracks: RemotionManifest["tracks"] = [];
	const compsByMediaId = new Map<
		string,
		{ ref: RemotionFramecutAiRef; clipIds: string[] }
	>();

	const pushTrack = ({
		track,
		isMain,
	}: {
		track: TimelineTrack;
		isMain: boolean;
	}) => {
		const role = trackRole({ track, isMain });
		const usageRole =
			role === "main-video" ? "main" : role === "audio" ? "audio" : "overlay";
		const clips: RemotionEdlClip[] = [];
		for (const element of track.elements) {
			const clip: RemotionEdlClip = {
				id: element.id,
				name: element.name,
				kind: element.type,
				timelineStartSec: toSec(element.startTime),
				durationSec: toSec(element.duration),
			};
			if ("hidden" in element && element.hidden) clip.hidden = true;
			if (element.linkId) clip.linkId = element.linkId;
			if (element.type === "video" || element.type === "image") {
				clip.mediaId = element.mediaId;
				const path = pathByMediaId.get(element.mediaId);
				if (path) clip.mediaPath = path;
				clip.trimStartSec = toSec(element.trimStart);
				clip.trimEndSec = toSec(element.trimEnd);
				if (element.sourceDuration !== undefined) {
					clip.sourceDurationSec = toSec(element.sourceDuration);
				}
				let aiRef: RemotionFramecutAiRef | undefined;
				if (element.type === "video") {
					if (
						element.retime &&
						(element.retime.rate !== 1 || element.retime.reversed)
					) {
						clip.retime = { rate: element.retime.rate };
						if (element.retime.reversed) clip.retime.reversed = true;
					}
					if (element.framecutAi) {
						aiRef = toFramecutAiRef(element.framecutAi);
						clip.framecutAi = aiRef;
					}
				}
				noteUsage({ mediaId: element.mediaId, role: usageRole, framecutAi: aiRef });
				if (aiRef) {
					let comp = compsByMediaId.get(element.mediaId);
					if (!comp) {
						comp = { ref: aiRef, clipIds: [] };
						compsByMediaId.set(element.mediaId, comp);
					}
					comp.clipIds.push(element.id);
				}
			} else if (element.type === "audio") {
				if (element.sourceType === "upload") {
					clip.mediaId = element.mediaId;
					const path = pathByMediaId.get(element.mediaId);
					if (path) clip.mediaPath = path;
					noteUsage({ mediaId: element.mediaId, role: usageRole });
				} else {
					clip.sourceUrl = element.sourceUrl;
				}
				clip.trimStartSec = toSec(element.trimStart);
				clip.trimEndSec = toSec(element.trimEnd);
				if (element.sourceDuration !== undefined) {
					clip.sourceDurationSec = toSec(element.sourceDuration);
				}
				if (
					element.retime &&
					(element.retime.rate !== 1 || element.retime.reversed)
				) {
					clip.retime = { rate: element.retime.rate };
					if (element.retime.reversed) clip.retime.reversed = true;
				}
			}
			clips.push(clip);
		}
		const edlTrack: RemotionEdlTrack = {
			id: track.id,
			name: track.name,
			role,
			clips,
		};
		if ("muted" in track && track.muted) edlTrack.muted = true;
		if ("hidden" in track && track.hidden) edlTrack.hidden = true;
		edlTracks.push(edlTrack);
		const durationSec = clips.reduce(
			(max, clip) => Math.max(max, clip.timelineStartSec + clip.durationSec),
			0,
		);
		manifestTracks.push({
			id: track.id,
			name: track.name,
			role,
			clipCount: clips.length,
			durationSec,
		});
	};

	pushTrack({ track: input.tracks.main, isMain: true });
	for (const track of input.tracks.overlay) {
		pushTrack({ track, isMain: false });
	}
	for (const track of input.tracks.audio) {
		pushTrack({ track, isMain: false });
	}

	const edl: RemotionEdl = {
		format: "framecut-edl",
		version: REMOTION_PACK_VERSION,
		fps: input.project.fps,
		durationSec: input.totalDurationSec,
		tracks: edlTracks,
	};

	const transcript: RemotionTranscript | null = input.transcript
		? {
				format: "framecut-transcript",
				version: REMOTION_PACK_VERSION,
				segments: input.transcript.segments,
				...(input.transcript.words && input.transcript.words.length > 0
					? { words: input.transcript.words }
					: {}),
			}
		: null;

	const manifestMedia: RemotionManifestMedia[] = [];
	const mediaFiles: { mediaId: string; path: string }[] = [];
	for (const media of input.media) {
		const usage = usageByMediaId.get(media.id);
		if (!usage) continue; // unreferenced assets are not packed
		const path = pathByMediaId.get(media.id) as string;
		const entry: RemotionManifestMedia = {
			id: media.id,
			name: media.name,
			path,
			kind: media.kind,
			roles: [...usage.roles].sort(),
			generated: !!usage.framecutAi,
		};
		if (media.durationSec !== undefined) entry.durationSec = media.durationSec;
		if (media.fps !== undefined) entry.fps = media.fps;
		if (media.width !== undefined) entry.width = media.width;
		if (media.height !== undefined) entry.height = media.height;
		if (media.hasAudio !== undefined) entry.hasAudio = media.hasAudio;
		if (media.hasAlpha !== undefined) entry.hasAlpha = media.hasAlpha;
		if (usage.framecutAi) entry.framecutAi = usage.framecutAi;
		manifestMedia.push(entry);
		mediaFiles.push({ mediaId: media.id, path });
	}

	const manifest: RemotionManifest = {
		format: REMOTION_PACK_FORMAT,
		version: REMOTION_PACK_VERSION,
		generatedAt: input.generatedAt ?? new Date().toISOString(),
		generator: "vibecut",
		project: {
			id: input.project.id,
			name: input.project.name,
			fps: input.project.fps,
			canvas: { width: input.project.width, height: input.project.height },
			durationSec: input.totalDurationSec,
		},
		files: { edl: "edl.json", transcript: transcript ? "transcript.json" : null },
		styleProfile: input.styleProfile ?? null,
		tracks: manifestTracks,
		media: manifestMedia,
		framecutAi: [...compsByMediaId.entries()].map(([mediaId, comp]) => ({
			compId: comp.ref.compId,
			...(comp.ref.templateId ? { templateId: comp.ref.templateId } : {}),
			...(comp.ref.registryBlock
				? { registryBlock: comp.ref.registryBlock }
				: {}),
			mediaId,
			clipIds: comp.clipIds,
		})),
	};

	return { manifest, edl, transcript, mediaFiles };
}

/**
 * The non-Chromium fallback: one self-contained JSON document. `mediaData`
 * maps mediaId to base64-encoded bytes; paths match the directory shape so a
 * kit can unpack and then read only that.
 */
export function buildRemotionPackBundle({
	pack,
	mediaData,
}: {
	pack: BuiltRemotionPack;
	mediaData: Map<string, string>;
}): RemotionPackBundle {
	const files: RemotionPackBundleFile[] = [
		{
			path: "edl.json",
			encoding: "utf8",
			text: JSON.stringify(pack.edl, null, 2),
		},
	];
	if (pack.transcript) {
		files.push({
			path: "transcript.json",
			encoding: "utf8",
			text: JSON.stringify(pack.transcript, null, 2),
		});
	}
	for (const file of pack.mediaFiles) {
		const data = mediaData.get(file.mediaId);
		if (data === undefined) continue;
		files.push({ path: file.path, encoding: "base64", data });
	}
	return {
		format: REMOTION_PACK_BUNDLE_FORMAT,
		version: REMOTION_PACK_VERSION,
		manifest: pack.manifest,
		files,
	};
}

/** Chunked btoa: a naive spread blows the call stack on multi-MB buffers. */
export function arrayBufferToBase64({ buffer }: { buffer: ArrayBuffer }): string {
	const bytes = new Uint8Array(buffer);
	const CHUNK = 0x8000;
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += CHUNK) {
		binary += String.fromCharCode(
			...bytes.subarray(offset, offset + CHUNK),
		);
	}
	return btoa(binary);
}
