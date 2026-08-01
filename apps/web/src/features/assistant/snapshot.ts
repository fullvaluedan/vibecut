/**
 * The TIMELINE SNAPSHOT the prompt-to-edit assistant reasons over (T17.1).
 *
 * One immutable, plain-data picture of the editor at the moment a prompt was
 * sent. Two consumers:
 *  - `context.ts` serializes it (lossily, by relevance) into the compact JSON
 *    the model sees;
 *  - `tools.ts` validates every tool call against it, with no store access at
 *    all, so T17.2 can re-run the exact same validators at execute time against
 *    a freshly taken snapshot and get the exact same verdicts.
 *
 * Tick fields keep their `MediaTime` brand so the extend validator can reuse the
 * REAL resize math (`getResizeBoundBreakdown`) rather than a second copy of it.
 * Seconds appear only at the serializer boundary, where the model reads them.
 */

import type { FrameRate } from "opencut-wasm";
import type {
	Bookmark,
	ElementRef,
	ElementType,
	SceneTracks,
	TimelineElement,
	TimelineTrack,
	TrackType,
} from "@/timeline";
import type { MediaTime } from "@/wasm";

/** One clip, flattened out of its track so lookups are a single pass. */
export interface SnapshotClip {
	id: string;
	trackId: string;
	type: ElementType;
	/** The clip's own name as shown on the timeline. */
	name: string;
	/** The source media's name, when this clip plays a media asset. */
	mediaName?: string;
	startTime: MediaTime;
	duration: MediaTime;
	trimStart: MediaTime;
	trimEnd: MediaTime;
	sourceDuration?: MediaTime;
	/**
	 * True for types that always have real footage behind them (video, audio).
	 * Mirrors `GroupResizeMember.sourceDurationRequired`: a missing
	 * `sourceDuration` on one of these means zero headroom, not free extension.
	 */
	sourceDurationRequired: boolean;
	/** Video and its separated audio half share this. */
	linkId?: string;
	/** Retime rate; absent or 1 means normal speed. */
	speed?: number;
	maintainPitch?: boolean;
	/** Set on native motion-template text clips. */
	templateId?: string;
}

export interface SnapshotTrack {
	id: string;
	/** V1, V2, A1, T1, G1, FX1 - the same badge the timeline column shows. */
	label: string;
	type: TrackType;
	isMain: boolean;
	/** Sorted by start time, then id, so serialization is deterministic. */
	clips: SnapshotClip[];
}

export interface SnapshotMarker {
	atTime: MediaTime;
	note?: string;
	color?: string;
	duration?: MediaTime;
}

export interface SnapshotWord {
	startSec: number;
	endSec: number;
	text: string;
}

export interface SnapshotTranscript {
	/**
	 * - `lineage`: served from the T16.1 transcript lineage (survives edits).
	 * - `cache`: served from the plain transcript cache.
	 * - `none`: nothing transcribed yet.
	 */
	source: "lineage" | "cache" | "none";
	/** Words in CURRENT timeline seconds, ascending. */
	words: SnapshotWord[];
}

/**
 * A span the assistant must not remove or overwrite. Nothing produces these
 * today; the field exists so a future protected-range feature (locked tracks,
 * a pinned sponsor read) becomes a snapshot input rather than a validator edit.
 */
export interface SnapshotProtectedSpan {
	start: MediaTime;
	end: MediaTime;
	reason: string;
}

export interface TimelineSnapshot {
	projectId: string;
	projectName: string;
	fps: FrameRate;
	canvas: { width: number; height: number };
	/** Total timeline length. */
	totalDuration: MediaTime;
	playhead: MediaTime;
	selection: ElementRef[];
	/** Main-track magnet (CapCut behavior), default ON. */
	magnetEnabled: boolean;
	/** Cross-track ripple editing; a strict superset of the magnet. */
	rippleEditingEnabled: boolean;
	snappingEnabled: boolean;
	/** V1 first, then V2..Vn, then text/graphic/effect lanes, then A1..An. */
	tracks: SnapshotTrack[];
	markers: SnapshotMarker[];
	transcript: SnapshotTranscript;
	protectedSpans: SnapshotProtectedSpan[];
}

// --- Lookups ---------------------------------------------------------------

/** Every clip in track order, then start order. Deterministic. */
export function allSnapshotClips(
	snapshot: TimelineSnapshot,
): readonly SnapshotClip[] {
	return snapshot.tracks.flatMap((track) => track.clips);
}

export function findSnapshotClip(
	snapshot: TimelineSnapshot,
	clipId: string,
): SnapshotClip | null {
	for (const track of snapshot.tracks) {
		for (const clip of track.clips) {
			if (clip.id === clipId) return clip;
		}
	}
	return null;
}

export function findSnapshotTrack(
	snapshot: TimelineSnapshot,
	trackIdOrLabel: string,
): SnapshotTrack | null {
	const needle = trackIdOrLabel.trim();
	return (
		snapshot.tracks.find((track) => track.id === needle) ??
		snapshot.tracks.find(
			(track) => track.label.toLowerCase() === needle.toLowerCase(),
		) ??
		null
	);
}

/** The clip's end time, in ticks. */
export function snapshotClipEnd(clip: SnapshotClip): number {
	return (clip.startTime as number) + (clip.duration as number);
}

/** Every clip linked to this one (its separated audio half, or its video half). */
export function linkedSnapshotClips(
	snapshot: TimelineSnapshot,
	clip: SnapshotClip,
): SnapshotClip[] {
	if (!clip.linkId) return [];
	return allSnapshotClips(snapshot).filter(
		(other) => other.id !== clip.id && other.linkId === clip.linkId,
	);
}

// --- Building from the live editor ----------------------------------------

/**
 * Premiere-style track badges: main is V1, video overlays count upward from the
 * bottom of the overlay stack, audio counts downward, and text/graphic/effect
 * lanes get their own series. Kept in step with the timeline label column
 * (`timeline/components/index.tsx`); duplicated rather than imported so this
 * data module never depends on a React component.
 */
export function buildTrackLabels(tracks: SceneTracks): Map<string, string> {
	const labels = new Map<string, string>();
	labels.set(tracks.main.id, "V1");
	let videoNumber = 1;
	const counters: Record<string, number> = {};
	for (const track of [...tracks.overlay].reverse()) {
		if (track.type === "video") {
			videoNumber += 1;
			labels.set(track.id, `V${videoNumber}`);
			continue;
		}
		const prefix =
			track.type === "text" ? "T" : track.type === "effect" ? "FX" : "G";
		counters[prefix] = (counters[prefix] ?? 0) + 1;
		labels.set(track.id, `${prefix}${counters[prefix]}`);
	}
	tracks.audio.forEach((track, index) => {
		labels.set(track.id, `A${index + 1}`);
	});
	return labels;
}

const SOURCE_BACKED_TYPES: ReadonlySet<ElementType> = new Set<ElementType>([
	"video",
	"audio",
]);

function toSnapshotClip({
	element,
	trackId,
	mediaNames,
}: {
	element: TimelineElement;
	trackId: string;
	mediaNames: ReadonlyMap<string, string>;
}): SnapshotClip {
	const mediaId = "mediaId" in element ? element.mediaId : undefined;
	const retime = "retime" in element ? element.retime : undefined;
	const templateId =
		element.type === "text" ? element.motionTemplate?.templateId : undefined;
	return {
		id: element.id,
		trackId,
		type: element.type,
		name: element.name,
		...(mediaId && mediaNames.has(mediaId)
			? { mediaName: mediaNames.get(mediaId) as string }
			: {}),
		startTime: element.startTime,
		duration: element.duration,
		trimStart: element.trimStart,
		trimEnd: element.trimEnd,
		...(element.sourceDuration !== undefined
			? { sourceDuration: element.sourceDuration }
			: {}),
		sourceDurationRequired: SOURCE_BACKED_TYPES.has(element.type),
		...(element.linkId ? { linkId: element.linkId } : {}),
		...(retime?.rate !== undefined ? { speed: retime.rate } : {}),
		...(retime?.maintainPitch !== undefined
			? { maintainPitch: retime.maintainPitch }
			: {}),
		...(templateId ? { templateId } : {}),
	};
}

function toSnapshotTrack({
	track,
	label,
	isMain,
	mediaNames,
}: {
	track: TimelineTrack;
	label: string;
	isMain: boolean;
	mediaNames: ReadonlyMap<string, string>;
}): SnapshotTrack {
	const clips = track.elements
		.map((element) =>
			toSnapshotClip({ element, trackId: track.id, mediaNames }),
		)
		.sort(
			(a, b) =>
				(a.startTime as number) - (b.startTime as number) ||
				a.id.localeCompare(b.id),
		);
	return { id: track.id, label, type: track.type, isMain, clips };
}

/**
 * The narrow editor slice this module reads. The real `EditorCore` satisfies it,
 * and a test fixture can too. Same structural-interface trick the transcript
 * lineage uses (`LineageEditor`).
 */
export interface AssistantSnapshotEditor {
	project: {
		getActive: () => {
			metadata: { id: string; name: string };
			settings: { fps: FrameRate; canvasSize: { width: number; height: number } };
		};
	};
	scenes: {
		getActiveScene: () => { tracks: SceneTracks; bookmarks: Bookmark[] };
	};
	playback: { getCurrentTime: () => MediaTime };
	selection: { getSelectedElements: () => ElementRef[] };
	timeline: { getTotalDuration: () => MediaTime };
	media: { getAssets: () => { id: string; name: string }[] };
}

/**
 * Take a snapshot of the live editor. The transcript and the toolbar toggles are
 * INJECTED rather than read here: both live in zustand stores whose read paths
 * (`readTranscriptLineage`, `useTimelineStore`) belong to the caller, which keeps
 * this function free of store imports and trivially testable.
 */
export function buildTimelineSnapshot({
	editor,
	transcript,
	toggles,
	protectedSpans = [],
}: {
	editor: AssistantSnapshotEditor;
	transcript?: SnapshotTranscript;
	toggles?: {
		magnetEnabled?: boolean;
		rippleEditingEnabled?: boolean;
		snappingEnabled?: boolean;
	};
	protectedSpans?: SnapshotProtectedSpan[];
}): TimelineSnapshot {
	const project = editor.project.getActive();
	const scene = editor.scenes.getActiveScene();
	const labels = buildTrackLabels(scene.tracks);
	const mediaNames = new Map(
		editor.media.getAssets().map((asset) => [asset.id, asset.name]),
	);

	const videoOverlays = scene.tracks.overlay.filter(
		(track) => track.type === "video",
	);
	const otherOverlays = scene.tracks.overlay.filter(
		(track) => track.type !== "video",
	);
	const ordered: { track: TimelineTrack; isMain: boolean }[] = [
		{ track: scene.tracks.main, isMain: true },
		// Overlay video lanes read bottom-up so V2 comes before V3.
		...[...videoOverlays].reverse().map((track) => ({ track, isMain: false })),
		...[...otherOverlays].reverse().map((track) => ({ track, isMain: false })),
		...scene.tracks.audio.map((track) => ({ track, isMain: false })),
	];

	return {
		projectId: project.metadata.id,
		projectName: project.metadata.name,
		fps: project.settings.fps,
		canvas: {
			width: project.settings.canvasSize.width,
			height: project.settings.canvasSize.height,
		},
		totalDuration: editor.timeline.getTotalDuration(),
		playhead: editor.playback.getCurrentTime(),
		selection: editor.selection.getSelectedElements(),
		magnetEnabled: toggles?.magnetEnabled ?? true,
		rippleEditingEnabled: toggles?.rippleEditingEnabled ?? false,
		snappingEnabled: toggles?.snappingEnabled ?? true,
		tracks: ordered.map(({ track, isMain }) =>
			toSnapshotTrack({
				track,
				label: labels.get(track.id) ?? track.name,
				isMain,
				mediaNames,
			}),
		),
		markers: scene.bookmarks
			.map((bookmark) => ({
				atTime: bookmark.time,
				...(bookmark.note ? { note: bookmark.note } : {}),
				...(bookmark.color ? { color: bookmark.color } : {}),
				...(bookmark.duration !== undefined
					? { duration: bookmark.duration }
					: {}),
			}))
			.sort((a, b) => (a.atTime as number) - (b.atTime as number)),
		transcript: transcript ?? { source: "none", words: [] },
		protectedSpans,
	};
}
