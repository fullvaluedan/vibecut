/**
 * The CONTEXT SERIALIZER for the prompt-to-edit assistant (T17.1).
 *
 * Turns a `TimelineSnapshot` into the compact JSON the model reads: tracks with
 * their lane labels, clips with ids and timings and extension headroom, markers,
 * the current selection, the playhead, the project format, and a transcript
 * window around the playhead.
 *
 * SIZE DISCIPLINE. A 30-minute project can hold hundreds of clips, so the
 * serializer spends its budget by RELEVANCE rather than by order:
 *   1. selected clips,
 *   2. clips overlapping the focus window around the playhead,
 *   3. everything else, nearest to the playhead first.
 * Clips that do not make the cut are collapsed per track into a count plus the
 * span they cover, so the model still knows they exist (and can ask about them)
 * without paying per-clip tokens. If the result still exceeds the character
 * budget, the budgets shrink and the whole build repeats, so the output is a
 * pure function of the snapshot plus the options: same input, same bytes.
 *
 * The character budget is the proxy for tokens (roughly 4 characters per token
 * for this kind of JSON). The default leaves a 30-minute, 100-clip project far
 * under the 8k-token target from the roadmap.
 */

import { mediaTimeToSeconds, TICKS_PER_SECOND, type MediaTime } from "@/wasm";
import {
	allSnapshotClips,
	linkedSnapshotClips,
	snapshotClipEnd,
	type SnapshotClip,
	type SnapshotTrack,
	type TimelineSnapshot,
} from "./snapshot";

/** Bumped when the serialized shape changes in a way the model would notice. */
export const ASSISTANT_CONTEXT_VERSION = 1;

export interface AssistantContextOptions {
	/** Half-width of the playhead focus window, in seconds. */
	focusWindowSec?: number;
	/** Hard ceiling on individually serialized clips. */
	maxClips?: number;
	/** Half-width of the transcript window around the playhead, in seconds. */
	transcriptWindowSec?: number;
	/** Ceiling on the transcript excerpt, in characters. */
	maxTranscriptChars?: number;
	/** Ceiling on the whole serialized context, in characters. */
	maxChars?: number;
	/** Ceiling on serialized markers. */
	maxMarkers?: number;
}

export const DEFAULT_CONTEXT_OPTIONS: Required<AssistantContextOptions> = {
	focusWindowSec: 20,
	maxClips: 60,
	transcriptWindowSec: 30,
	maxTranscriptChars: 2400,
	maxChars: 24_000,
	maxMarkers: 40,
};

export interface AssistantContextClip {
	id: string;
	/** Lane label, e.g. "V1". */
	track: string;
	/** Media name when the clip plays media, otherwise the clip's own name. */
	name: string;
	kind: string;
	startSec: number;
	endSec: number;
	/** Seconds of unused source before/after the visible span. */
	headroomSec?: { start: number; end: number };
	/** Present only when retimed. */
	speed?: number;
	/** Ids of clips that move with this one (its separated audio half). */
	linkedTo?: string[];
	/** Motion-template id for template text clips. */
	template?: string;
	selected?: true;
}

export interface AssistantContextTrack {
	label: string;
	type: string;
	main?: true;
	clipCount: number;
	clips: AssistantContextClip[];
	/** Clips left out of `clips`, collapsed to a count and the span they cover. */
	omitted?: { count: number; fromSec: number; toSec: number };
}

export interface AssistantContextTranscript {
	source: "lineage" | "cache" | "none";
	fromSec: number;
	toSec: number;
	text: string;
	/** True when the excerpt was cut short by the character budget. */
	clipped?: true;
}

export interface AssistantContext {
	version: number;
	project: {
		name: string;
		fps: number;
		aspect: string;
		size: string;
		durationSec: number;
	};
	timeline: {
		mainTrackMagnet: boolean;
		rippleEditing: boolean;
		snapping: boolean;
	};
	playheadSec: number;
	selectedClipIds: string[];
	tracks: AssistantContextTrack[];
	markers: { atSec: number; note?: string }[];
	transcript?: AssistantContextTranscript;
	protectedSpans?: { fromSec: number; toSec: number; reason: string }[];
	/** True when anything was summarized or clipped away. */
	truncated: boolean;
	/** Plain sentences telling the model what it is not seeing. */
	notes: string[];
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}

function toSec(time: MediaTime): number {
	return round2(mediaTimeToSeconds({ time }));
}

function ticksToSec(ticks: number): number {
	return round2(mediaTimeToSeconds({ time: ticks as MediaTime }));
}

function greatestCommonDivisor(a: number, b: number): number {
	return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

/** "1920x1080" reduces to "16:9". Falls back to the raw ratio when it will not. */
export function describeAspect({
	width,
	height,
}: {
	width: number;
	height: number;
}): string {
	if (width <= 0 || height <= 0) return "unknown";
	const divisor = greatestCommonDivisor(width, height) || 1;
	return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
}

/**
 * How far each edge of a clip can still be dragged outward, in seconds of
 * timeline time. Ignores neighbors on purpose: neighbors are visible in the
 * serialized clip list, while unused source is not, so this is the number the
 * model cannot otherwise infer. The extend VALIDATOR still applies the full
 * bound set (neighbors, minimum duration, magnet) before anything executes.
 */
function headroomSec(clip: SnapshotClip): { start: number; end: number } | null {
	if (clip.sourceDuration === undefined) {
		return clip.sourceDurationRequired ? { start: 0, end: 0 } : null;
	}
	const rate = clip.speed && clip.speed > 0 ? clip.speed : 1;
	const start = (clip.trimStart as number) / rate;
	const end = (clip.trimEnd as number) / rate;
	return { start: ticksToSec(start), end: ticksToSec(end) };
}

/** Selected first, then focus-window overlap, then nearest to the playhead. */
function relevanceRank({
	clip,
	selectedIds,
	playheadTicks,
	focusTicks,
}: {
	clip: SnapshotClip;
	selectedIds: ReadonlySet<string>;
	playheadTicks: number;
	focusTicks: number;
}): { tier: number; distance: number } {
	const start = clip.startTime as number;
	const end = snapshotClipEnd(clip);
	const distance =
		playheadTicks < start
			? start - playheadTicks
			: playheadTicks > end
				? playheadTicks - end
				: 0;
	if (selectedIds.has(clip.id)) return { tier: 0, distance };
	if (distance <= focusTicks) return { tier: 1, distance };
	return { tier: 2, distance };
}

/** The ids that survive the clip budget, chosen by relevance, order-independent. */
function pickRelevantClipIds({
	snapshot,
	options,
}: {
	snapshot: TimelineSnapshot;
	options: Required<AssistantContextOptions>;
}): Set<string> {
	const clips = allSnapshotClips(snapshot);
	if (clips.length <= options.maxClips) {
		return new Set(clips.map((clip) => clip.id));
	}
	const selectedIds = new Set(snapshot.selection.map((ref) => ref.elementId));
	const playheadTicks = snapshot.playhead as number;
	const focusTicks = options.focusWindowSec * TICKS_PER_SECOND;
	const ranked = clips
		.map((clip) => ({
			clip,
			...relevanceRank({ clip, selectedIds, playheadTicks, focusTicks }),
		}))
		.sort(
			(a, b) =>
				a.tier - b.tier ||
				a.distance - b.distance ||
				(a.clip.startTime as number) - (b.clip.startTime as number) ||
				a.clip.id.localeCompare(b.clip.id),
		);
	return new Set(
		ranked.slice(0, options.maxClips).map((entry) => entry.clip.id),
	);
}

function serializeClip({
	clip,
	track,
	snapshot,
	selectedIds,
}: {
	clip: SnapshotClip;
	track: SnapshotTrack;
	snapshot: TimelineSnapshot;
	selectedIds: ReadonlySet<string>;
}): AssistantContextClip {
	const headroom = headroomSec(clip);
	const linked = linkedSnapshotClips(snapshot, clip).map((other) => other.id);
	return {
		id: clip.id,
		track: track.label,
		name: clip.mediaName ?? clip.name,
		kind: clip.type,
		startSec: toSec(clip.startTime),
		endSec: ticksToSec(snapshotClipEnd(clip)),
		...(headroom ? { headroomSec: headroom } : {}),
		...(clip.speed !== undefined && clip.speed !== 1 ? { speed: clip.speed } : {}),
		...(linked.length ? { linkedTo: linked } : {}),
		...(clip.templateId ? { template: clip.templateId } : {}),
		...(selectedIds.has(clip.id) ? { selected: true as const } : {}),
	};
}

function serializeTranscript({
	snapshot,
	options,
}: {
	snapshot: TimelineSnapshot;
	options: Required<AssistantContextOptions>;
}): AssistantContextTranscript | null {
	const { transcript } = snapshot;
	if (transcript.source === "none" || transcript.words.length === 0) return null;
	const playheadSec = mediaTimeToSeconds({ time: snapshot.playhead });
	const fromSec = Math.max(0, playheadSec - options.transcriptWindowSec);
	const toSec = playheadSec + options.transcriptWindowSec;
	const inWindow = transcript.words.filter(
		(word) => word.endSec >= fromSec && word.startSec <= toSec,
	);
	if (inWindow.length === 0) return null;
	const full = inWindow.map((word) => word.text.trim()).join(" ").trim();
	if (!full) return null;
	const clipped = full.length > options.maxTranscriptChars;
	return {
		source: transcript.source,
		fromSec: round2(Math.max(fromSec, inWindow[0].startSec)),
		toSec: round2(Math.min(toSec, inWindow[inWindow.length - 1].endSec)),
		text: clipped ? `${full.slice(0, options.maxTranscriptChars)}...` : full,
		...(clipped ? { clipped: true as const } : {}),
	};
}

function buildOnce({
	snapshot,
	options,
}: {
	snapshot: TimelineSnapshot;
	options: Required<AssistantContextOptions>;
}): AssistantContext {
	const selectedIds = new Set(snapshot.selection.map((ref) => ref.elementId));
	const keptIds = pickRelevantClipIds({ snapshot, options });
	const notes: string[] = [];
	let truncated = false;

	const tracks: AssistantContextTrack[] = snapshot.tracks.map((track) => {
		const kept = track.clips.filter((clip) => keptIds.has(clip.id));
		const dropped = track.clips.filter((clip) => !keptIds.has(clip.id));
		const entry: AssistantContextTrack = {
			label: track.label,
			type: track.type,
			...(track.isMain ? { main: true as const } : {}),
			clipCount: track.clips.length,
			clips: kept.map((clip) =>
				serializeClip({ clip, track, snapshot, selectedIds }),
			),
		};
		if (dropped.length > 0) {
			truncated = true;
			entry.omitted = {
				count: dropped.length,
				fromSec: toSec(dropped[0].startTime),
				toSec: ticksToSec(snapshotClipEnd(dropped[dropped.length - 1])),
			};
		}
		return entry;
	});

	const totalOmitted = tracks.reduce(
		(sum, track) => sum + (track.omitted?.count ?? 0),
		0,
	);
	if (totalOmitted > 0) {
		notes.push(
			`${totalOmitted} clips further from the playhead are summarized as counts. Ask the user or move the playhead if you need their ids.`,
		);
	}

	const markers = snapshot.markers.slice(0, options.maxMarkers).map((marker) => ({
		atSec: toSec(marker.atTime),
		...(marker.note ? { note: marker.note } : {}),
	}));
	if (snapshot.markers.length > markers.length) {
		truncated = true;
		notes.push(
			`${snapshot.markers.length - markers.length} more markers exist beyond the ones listed.`,
		);
	}

	const transcript = serializeTranscript({ snapshot, options });
	if (transcript?.clipped) truncated = true;
	if (snapshot.transcript.source === "none") {
		notes.push(
			"No transcript is available for this project, so do not reason about spoken words.",
		);
	}

	return {
		version: ASSISTANT_CONTEXT_VERSION,
		project: {
			name: snapshot.projectName,
			fps: round2(snapshot.fps.numerator / snapshot.fps.denominator),
			aspect: describeAspect(snapshot.canvas),
			size: `${snapshot.canvas.width}x${snapshot.canvas.height}`,
			durationSec: toSec(snapshot.totalDuration),
		},
		timeline: {
			mainTrackMagnet: snapshot.magnetEnabled,
			rippleEditing: snapshot.rippleEditingEnabled,
			snapping: snapshot.snappingEnabled,
		},
		playheadSec: toSec(snapshot.playhead),
		selectedClipIds: snapshot.selection.map((ref) => ref.elementId),
		tracks,
		markers,
		...(transcript ? { transcript } : {}),
		...(snapshot.protectedSpans.length
			? {
					protectedSpans: snapshot.protectedSpans.map((span) => ({
						fromSec: toSec(span.start),
						toSec: toSec(span.end),
						reason: span.reason,
					})),
				}
			: {}),
		truncated,
		notes,
	};
}

/**
 * Serialize a snapshot into the model-facing context, shrinking the budgets
 * until the result fits `maxChars`. Deterministic: the retry ladder is fixed,
 * so the same snapshot always produces the same bytes.
 */
export function serializeAssistantContext({
	snapshot,
	options,
}: {
	snapshot: TimelineSnapshot;
	options?: AssistantContextOptions;
}): AssistantContext {
	const base: Required<AssistantContextOptions> = {
		...DEFAULT_CONTEXT_OPTIONS,
		...options,
	};
	let current = base;
	let context = buildOnce({ snapshot, options: current });
	// Fixed ladder: halve the clip and transcript budgets up to four times. Four
	// halvings take 60 clips to 3 and 2400 transcript characters to 150, which is
	// smaller than any realistic budget, so the loop always terminates well
	// before it runs out of steps.
	for (let step = 0; step < 4; step += 1) {
		if (measureContextChars(context) <= base.maxChars) break;
		current = {
			...current,
			maxClips: Math.max(3, Math.floor(current.maxClips / 2)),
			maxTranscriptChars: Math.max(
				150,
				Math.floor(current.maxTranscriptChars / 2),
			),
			maxMarkers: Math.max(5, Math.floor(current.maxMarkers / 2)),
		};
		context = buildOnce({ snapshot, options: current });
	}
	if (measureContextChars(context) > base.maxChars) {
		context = {
			...context,
			truncated: true,
			notes: [
				...context.notes,
				"This project is large enough that the context is heavily summarized. Prefer asking the user which section they mean.",
			],
		};
	}
	return context;
}

/** The serialized size, in characters. The token proxy the budget is set in. */
export function measureContextChars(context: AssistantContext): number {
	return JSON.stringify(context).length;
}

/** Rough token estimate for logging and budget checks (4 characters per token). */
export function estimateContextTokens(context: AssistantContext): number {
	return Math.ceil(measureContextChars(context) / 4);
}
