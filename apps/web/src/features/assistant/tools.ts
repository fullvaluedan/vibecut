/**
 * The EDIT-TOOL SCHEMA for the prompt-to-edit assistant (T17.1).
 *
 * Two things live here and nowhere else:
 *  1. the typed tool definitions the model is given (name, description, JSON
 *     schema), and their mapping onto the Anthropic tools wire shape;
 *  2. one PURE validator per tool.
 *
 * Validators take a `TimelineSnapshot` and the raw arguments and return either
 * normalized arguments or a refusal carrying a machine-readable code plus a
 * human sentence. They never touch a store, so T17.2 can re-run the very same
 * validator at execute time against a fresh snapshot and get the same verdict.
 * That is what makes "validate the whole turn, then apply it as one batch"
 * possible without a half-applied prompt.
 *
 * The clamps deliberately reuse the editor's own math where it exists:
 * `getResizeBoundBreakdown` for extension headroom (the exact function the drag
 * handles use), `getMinDurationForFps` for the one-frame floor,
 * `clampRetimeRate`'s bounds for speed, `canElementGoOnTrack` for lane
 * compatibility, and `MAX_VIDEO_TRACKS` / `MAX_AUDIO_TRACKS` for lane budget.
 * A refusal here therefore means the UI would have refused too.
 */

import type { FrameRate } from "opencut-wasm";
import type { ElementType, TrackType } from "@/timeline";
import {
	getMinDurationForFps,
	getResizeBoundBreakdown,
	type GroupResizeMember,
	type ResizeBoundReason,
} from "@/timeline/group-resize";
import { canElementGoOnTrack } from "@/timeline/placement/compatibility";
import {
	MAX_AUDIO_TRACKS,
	MAX_VIDEO_TRACKS,
} from "@/timeline/placement/track-cap";
import { MAX_RETIME_RATE, MIN_RETIME_RATE } from "@/retime/rate";
import {
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	roundFrameTime,
	type MediaTime,
} from "@/wasm";
import {
	ASSISTANT_TEMPLATE_CATALOG,
	ASSISTANT_TEMPLATE_IDS,
	findAssistantTemplate,
} from "./template-catalog";
import {
	findSnapshotClip,
	findSnapshotTrack,
	snapshotClipEnd,
	type SnapshotClip,
	type SnapshotTrack,
	type TimelineSnapshot,
} from "./snapshot";
import type {
	AddMarkerArgs,
	AddMotionTemplateArgs,
	AddTextArgs,
	AskUserArgs,
	AssistantToolName,
	CutRangeArgs,
	CutScope,
	DeleteClipArgs,
	ExtendClipArgs,
	MoveClipArgs,
	SelectClipsArgs,
	SetSpeedArgs,
	SplitAtArgs,
	ToolCall,
	TurnValidation,
	ValidatedToolCall,
	ValidationFailure,
	ValidationFailureCode,
	ValidationResult,
} from "./types";

/** Longest text or marker note the assistant may write. */
const MAX_TEXT_CHARS = 240;
/** Longest clarifying question, so a stalling model cannot write an essay. */
const MAX_QUESTION_CHARS = 400;
/** Ceiling on a single inserted text or template clip. */
const MAX_INSERT_DURATION_SEC = 600;
const DEFAULT_TEXT_DURATION_SEC = 5;
/** Ceiling on one `select_clips` call. */
const MAX_SELECTION = 200;

// --- Small argument readers ------------------------------------------------

function fail(
	code: ValidationFailureCode,
	reason: string,
	detail?: Record<string, string | number | boolean>,
): ValidationFailure {
	return detail ? { ok: false, code, reason, detail } : { ok: false, code, reason };
}

function readString(args: Record<string, unknown>, key: string): string | null {
	const value = args[key];
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(args: Record<string, unknown>, key: string): number | null {
	const value = args[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(args: Record<string, unknown>, key: string): boolean | null {
	const value = args[key];
	return typeof value === "boolean" ? value : null;
}

function round3(value: number): number {
	return Math.round(value * 1000) / 1000;
}

/** Project a request in seconds onto the project's frame grid. */
function snapSeconds({
	seconds,
	fps,
}: {
	seconds: number;
	fps: FrameRate;
}): { time: MediaTime; sec: number } {
	const time = roundFrameTime({
		time: mediaTimeFromSeconds({ seconds }),
		fps,
	});
	return { time, sec: round3(mediaTimeToSeconds({ time })) };
}

function secOf(ticks: number): number {
	return round3(mediaTimeToSeconds({ time: ticks as MediaTime }));
}

function trackOfClip(
	snapshot: TimelineSnapshot,
	clip: SnapshotClip,
): SnapshotTrack {
	const track = snapshot.tracks.find((entry) => entry.id === clip.trackId);
	if (!track) {
		throw new Error(`Snapshot is inconsistent: no track for clip ${clip.id}`);
	}
	return track;
}

/** Half-open overlap between two tick spans. */
function spansOverlap(
	a: { start: number; end: number },
	b: { start: number; end: number },
): boolean {
	return a.start < b.end && b.start < a.end;
}

function protectedOverlap(
	snapshot: TimelineSnapshot,
	span: { start: number; end: number },
): { reason: string; fromSec: number; toSec: number } | null {
	for (const protectedSpan of snapshot.protectedSpans) {
		if (
			spansOverlap(span, {
				start: protectedSpan.start as number,
				end: protectedSpan.end as number,
			})
		) {
			return {
				reason: protectedSpan.reason,
				fromSec: secOf(protectedSpan.start as number),
				toSec: secOf(protectedSpan.end as number),
			};
		}
	}
	return null;
}

const TRACK_TYPE_LABEL: Record<TrackType, string> = {
	video: "video",
	audio: "audio",
	text: "text",
	graphic: "graphic",
	effect: "effect",
};

/** The neighbor bounds a drag on this clip would see on its own lane. */
function neighborBounds({
	clip,
	track,
}: {
	clip: SnapshotClip;
	track: SnapshotTrack;
}): { left: MediaTime | null; right: MediaTime | null } {
	const start = clip.startTime as number;
	const end = snapshotClipEnd(clip);
	let left: number | null = null;
	let right: number | null = null;
	for (const other of track.clips) {
		if (other.id === clip.id) continue;
		const otherEnd = snapshotClipEnd(other);
		if (otherEnd <= start && (left === null || otherEnd > left)) left = otherEnd;
		const otherStart = other.startTime as number;
		if (otherStart >= end && (right === null || otherStart < right)) {
			right = otherStart;
		}
	}
	return {
		left: left === null ? null : (left as MediaTime),
		right: right === null ? null : (right as MediaTime),
	};
}

const BOUND_REASON_CODE: Record<ResizeBoundReason, ValidationFailureCode> = {
	"source-limit": "source_limit",
	neighbor: "overlap",
	"min-duration": "min_duration",
};

const BOUND_REASON_TEXT: Record<ResizeBoundReason, string> = {
	"source-limit": "there is no more source footage on that edge",
	neighbor: "the neighbouring clip is in the way",
	"min-duration": "the clip would drop below one frame",
};

// --- Validators ------------------------------------------------------------

function validateCutRange(
	args: Record<string, unknown>,
	snapshot: TimelineSnapshot,
): ValidationResult<CutRangeArgs> {
	const startSec = readNumber(args, "startSec");
	const endSec = readNumber(args, "endSec");
	if (startSec === null || endSec === null) {
		return fail(
			"bad_argument",
			"cut_range needs numeric startSec and endSec values.",
		);
	}
	if (startSec < 0) {
		return fail("out_of_bounds", "A cut cannot start before the timeline does.", {
			startSec,
		});
	}
	const total = snapshot.totalDuration as number;
	const start = snapSeconds({ seconds: startSec, fps: snapshot.fps });
	const end = snapSeconds({ seconds: endSec, fps: snapshot.fps });
	if ((end.time as number) <= (start.time as number)) {
		return fail(
			"empty_range",
			"The cut range is empty: endSec must be later than startSec by at least one frame.",
			{ startSec: start.sec, endSec: end.sec },
		);
	}
	if ((start.time as number) >= total) {
		return fail(
			"out_of_bounds",
			`The cut starts at ${start.sec}s but the timeline ends at ${secOf(total)}s.`,
			{ startSec: start.sec, timelineEndSec: secOf(total) },
		);
	}
	const clampedEnd = Math.min(end.time as number, total);
	const blocked = protectedOverlap(snapshot, {
		start: start.time as number,
		end: clampedEnd,
	});
	if (blocked) {
		return fail(
			"protected_span",
			`That range overlaps a protected section (${blocked.fromSec}s to ${blocked.toSec}s): ${blocked.reason}.`,
			blocked,
		);
	}
	const rawScope = readString(args, "scope");
	const scope: CutScope = rawScope === "main" ? "main" : "all";
	return {
		ok: true,
		args: { startSec: start.sec, endSec: secOf(clampedEnd), scope },
	};
}

function validateDeleteClip(
	args: Record<string, unknown>,
	snapshot: TimelineSnapshot,
): ValidationResult<DeleteClipArgs> {
	const clipId = readString(args, "clipId");
	if (!clipId) {
		return fail("bad_argument", "delete_clip needs a clipId.");
	}
	const clip = findSnapshotClip(snapshot, clipId);
	if (!clip) {
		return fail(
			"unknown_clip",
			`There is no clip with id ${clipId} on this timeline.`,
			{ clipId },
		);
	}
	const blocked = protectedOverlap(snapshot, {
		start: clip.startTime as number,
		end: snapshotClipEnd(clip),
	});
	if (blocked) {
		return fail(
			"protected_span",
			`That clip sits in a protected section (${blocked.fromSec}s to ${blocked.toSec}s): ${blocked.reason}.`,
			{ clipId, ...blocked },
		);
	}
	return { ok: true, args: { clipId } };
}

function validateExtendClip(
	args: Record<string, unknown>,
	snapshot: TimelineSnapshot,
): ValidationResult<ExtendClipArgs> {
	const clipId = readString(args, "clipId");
	const rawEdge = readString(args, "edge");
	const deltaSec = readNumber(args, "deltaSec");
	if (!clipId || deltaSec === null) {
		return fail(
			"bad_argument",
			"extend_clip needs a clipId and a numeric deltaSec.",
		);
	}
	if (rawEdge !== "start" && rawEdge !== "end") {
		return fail("bad_argument", 'extend_clip edge must be "start" or "end".', {
			edge: String(rawEdge),
		});
	}
	const clip = findSnapshotClip(snapshot, clipId);
	if (!clip) {
		return fail(
			"unknown_clip",
			`There is no clip with id ${clipId} on this timeline.`,
			{ clipId },
		);
	}
	const snapped = snapSeconds({ seconds: deltaSec, fps: snapshot.fps });
	if ((snapped.time as number) === 0) {
		return fail(
			"bad_argument",
			"That change rounds to zero frames, so it would do nothing.",
			{ clipId, deltaSec },
		);
	}
	const track = trackOfClip(snapshot, clip);
	const bounds = neighborBounds({ clip, track });
	const side = rawEdge === "end" ? "right" : "left";
	const member: GroupResizeMember = {
		trackId: clip.trackId,
		elementId: clip.id,
		startTime: clip.startTime,
		duration: clip.duration,
		trimStart: clip.trimStart,
		trimEnd: clip.trimEnd,
		...(clip.sourceDuration !== undefined
			? { sourceDuration: clip.sourceDuration }
			: {}),
		sourceDurationRequired: clip.sourceDurationRequired,
		...(clip.speed !== undefined
			? { retime: { rate: clip.speed, maintainPitch: clip.maintainPitch } }
			: {}),
		leftNeighborBound: bounds.left,
		rightNeighborBound: bounds.right,
		// The magnet pins a main-track clip's start on a left trim, exactly as the
		// resize controller does, so the source extent becomes the only floor.
		...(side === "left" && snapshot.magnetEnabled && track.isMain
			? { leftBoundLifted: true }
			: {}),
	};
	const breakdown = getResizeBoundBreakdown({
		member,
		side,
		minDuration: getMinDurationForFps(snapshot.fps),
	});
	// A positive deltaSec always means GROW, whichever edge it is. The resize math
	// signs its delta by side (a left handle grows on a negative delta), so flip
	// here and keep the model's arguments intuitive.
	const signedDelta = side === "right" ? (snapped.time as number) : -(snapped.time as number);
	if (signedDelta < (breakdown.minimum as number)) {
		const reason = breakdown.minimumReason;
		return fail(
			BOUND_REASON_CODE[reason],
			`That edge cannot move that far: ${BOUND_REASON_TEXT[reason]}.`,
			{
				clipId,
				edge: rawEdge,
				requestedSec: snapped.sec,
				maxSec: secOf(
					side === "right"
						? (breakdown.minimum as number)
						: -(breakdown.minimum as number),
				),
			},
		);
	}
	if (
		breakdown.maximum !== null &&
		signedDelta > (breakdown.maximum as number)
	) {
		const reason = breakdown.maximumReason ?? "source-limit";
		return fail(
			BOUND_REASON_CODE[reason],
			`That edge cannot move that far: ${BOUND_REASON_TEXT[reason]}.`,
			{
				clipId,
				edge: rawEdge,
				requestedSec: snapped.sec,
				maxSec: secOf(
					side === "right"
						? (breakdown.maximum as number)
						: -(breakdown.maximum as number),
				),
			},
		);
	}
	return {
		ok: true,
		args: { clipId, edge: rawEdge, deltaSec: snapped.sec },
	};
}

function validateMoveClip(
	args: Record<string, unknown>,
	snapshot: TimelineSnapshot,
): ValidationResult<MoveClipArgs> {
	const clipId = readString(args, "clipId");
	const toStartSec = readNumber(args, "toStartSec");
	if (!clipId || toStartSec === null) {
		return fail(
			"bad_argument",
			"move_clip needs a clipId and a numeric toStartSec.",
		);
	}
	const clip = findSnapshotClip(snapshot, clipId);
	if (!clip) {
		return fail(
			"unknown_clip",
			`There is no clip with id ${clipId} on this timeline.`,
			{ clipId },
		);
	}
	if (toStartSec < 0) {
		return fail("out_of_bounds", "A clip cannot start before the timeline does.", {
			clipId,
			toStartSec,
		});
	}
	const start = snapSeconds({ seconds: toStartSec, fps: snapshot.fps });
	const requested = readString(args, "toTrack");
	if (requested === "new") {
		const capped = wouldExceedTrackCap({ snapshot, elementType: clip.type });
		if (capped) return capped;
		return { ok: true, args: { clipId, toStartSec: start.sec, toNewTrack: true } };
	}
	const currentTrack = trackOfClip(snapshot, clip);
	let target = currentTrack;
	if (requested) {
		const resolved = findSnapshotTrack(snapshot, requested);
		if (!resolved) {
			return fail(
				"unknown_track",
				`There is no track called ${requested}. Use one of the lane labels from the context, or "new".`,
				{ clipId, toTrack: requested },
			);
		}
		if (
			!canElementGoOnTrack({
				elementType: clip.type,
				trackType: resolved.type,
			})
		) {
			return fail(
				"wrong_track_type",
				`A ${clip.type} clip cannot live on ${resolved.label}, which is a ${TRACK_TYPE_LABEL[resolved.type]} lane.`,
				{ clipId, toTrack: resolved.label, trackType: resolved.type },
			);
		}
		target = resolved;
	}
	const span = {
		start: start.time as number,
		end: (start.time as number) + (clip.duration as number),
	};
	// Overlap is legal on the magnetic main track (the executor ripple-inserts
	// there, exactly like a drop). Anywhere else a landing on top of another clip
	// is a refusal the model can retry from, naming the clip in the way.
	const magnetAbsorbs = target.isMain && snapshot.magnetEnabled;
	if (!magnetAbsorbs) {
		for (const other of target.clips) {
			if (other.id === clip.id) continue;
			if (
				spansOverlap(span, {
					start: other.startTime as number,
					end: snapshotClipEnd(other),
				})
			) {
				return fail(
					"overlap",
					`${target.label} is already occupied at ${start.sec}s by "${other.mediaName ?? other.name}".`,
					{
						clipId,
						toTrack: target.label,
						blockedBy: other.id,
						blockedFromSec: secOf(other.startTime as number),
						blockedToSec: secOf(snapshotClipEnd(other)),
					},
				);
			}
		}
	}
	return {
		ok: true,
		args: {
			clipId,
			toStartSec: start.sec,
			...(target.id === clip.trackId ? {} : { toTrackId: target.id }),
		},
	};
}

/** Lane budget for a would-be NEW track of the type this element needs. */
function wouldExceedTrackCap({
	snapshot,
	elementType,
}: {
	snapshot: TimelineSnapshot;
	elementType: ElementType;
}): ValidationFailure | null {
	const videoCount = snapshot.tracks.filter(
		(track) => track.type === "video",
	).length;
	const audioCount = snapshot.tracks.filter(
		(track) => track.type === "audio",
	).length;
	if (
		(elementType === "video" || elementType === "image") &&
		videoCount >= MAX_VIDEO_TRACKS
	) {
		return fail(
			"track_cap",
			`This project already has the maximum of ${MAX_VIDEO_TRACKS} video tracks, so no new one can be added.`,
			{ cap: MAX_VIDEO_TRACKS, kind: "video" },
		);
	}
	if (elementType === "audio" && audioCount >= MAX_AUDIO_TRACKS) {
		return fail(
			"track_cap",
			`This project already has the maximum of ${MAX_AUDIO_TRACKS} audio tracks, so no new one can be added.`,
			{ cap: MAX_AUDIO_TRACKS, kind: "audio" },
		);
	}
	return null;
}

function validateSplitAt(
	args: Record<string, unknown>,
	snapshot: TimelineSnapshot,
): ValidationResult<SplitAtArgs> {
	const clipId = readString(args, "clipId");
	const atSec = readNumber(args, "atSec");
	if (!clipId || atSec === null) {
		return fail("bad_argument", "split_at needs a clipId and a numeric atSec.");
	}
	const clip = findSnapshotClip(snapshot, clipId);
	if (!clip) {
		return fail(
			"unknown_clip",
			`There is no clip with id ${clipId} on this timeline.`,
			{ clipId },
		);
	}
	const at = snapSeconds({ seconds: atSec, fps: snapshot.fps });
	const minDuration = getMinDurationForFps(snapshot.fps) as number;
	const start = clip.startTime as number;
	const end = snapshotClipEnd(clip);
	if ((at.time as number) <= start || (at.time as number) >= end) {
		return fail(
			"out_of_bounds",
			`The split point ${at.sec}s is outside that clip, which runs ${secOf(start)}s to ${secOf(end)}s.`,
			{ clipId, atSec: at.sec, fromSec: secOf(start), toSec: secOf(end) },
		);
	}
	if (
		(at.time as number) - start < minDuration ||
		end - (at.time as number) < minDuration
	) {
		return fail(
			"min_duration",
			"Splitting there would leave a piece shorter than one frame.",
			{ clipId, atSec: at.sec },
		);
	}
	return { ok: true, args: { clipId, atSec: at.sec } };
}

function validateSetSpeed(
	args: Record<string, unknown>,
	snapshot: TimelineSnapshot,
): ValidationResult<SetSpeedArgs> {
	const clipId = readString(args, "clipId");
	const rate = readNumber(args, "rate");
	if (!clipId || rate === null) {
		return fail("bad_argument", "set_speed needs a clipId and a numeric rate.");
	}
	const clip = findSnapshotClip(snapshot, clipId);
	if (!clip) {
		return fail(
			"unknown_clip",
			`There is no clip with id ${clipId} on this timeline.`,
			{ clipId },
		);
	}
	if (clip.type !== "video" && clip.type !== "audio") {
		return fail(
			"not_retimable",
			`Speed only applies to video and audio clips, and "${clip.mediaName ?? clip.name}" is ${clip.type}.`,
			{ clipId, kind: clip.type },
		);
	}
	if (rate < MIN_RETIME_RATE || rate > MAX_RETIME_RATE) {
		return fail(
			"speed_range",
			`Speed must be between ${MIN_RETIME_RATE}x and ${MAX_RETIME_RATE}x.`,
			{ clipId, rate, min: MIN_RETIME_RATE, max: MAX_RETIME_RATE },
		);
	}
	return {
		ok: true,
		args: {
			clipId,
			rate: round3(rate),
			maintainPitch: readBoolean(args, "maintainPitch") ?? false,
		},
	};
}

function validateInsertTiming({
	args,
	snapshot,
	fallbackDurationSec,
	minDurationSec,
	maxDurationSec,
}: {
	args: Record<string, unknown>;
	snapshot: TimelineSnapshot;
	fallbackDurationSec: number;
	minDurationSec: number;
	maxDurationSec: number;
}): { atSec: number; durationSec: number } | ValidationFailure {
	const rawAt = readNumber(args, "atSec");
	const atSeconds = rawAt ?? mediaTimeToSeconds({ time: snapshot.playhead });
	if (atSeconds < 0) {
		return fail("out_of_bounds", "A clip cannot start before the timeline does.", {
			atSec: atSeconds,
		});
	}
	const at = snapSeconds({ seconds: atSeconds, fps: snapshot.fps });
	const rawDuration = readNumber(args, "durationSec") ?? fallbackDurationSec;
	if (rawDuration <= 0) {
		return fail("bad_argument", "durationSec must be greater than zero.", {
			durationSec: rawDuration,
		});
	}
	// Duration is CLAMPED rather than refused: the template registry clamps it
	// the same way when an item is placed, so refusing here would reject work the
	// editor itself would happily normalize.
	const clamped = Math.min(
		Math.max(rawDuration, minDurationSec),
		Math.min(maxDurationSec, MAX_INSERT_DURATION_SEC),
	);
	const duration = snapSeconds({ seconds: clamped, fps: snapshot.fps });
	return { atSec: at.sec, durationSec: duration.sec };
}

function validateAddText(
	args: Record<string, unknown>,
	snapshot: TimelineSnapshot,
): ValidationResult<AddTextArgs> {
	const text = readString(args, "text");
	if (!text) {
		return fail("bad_argument", "add_text needs the words to display.");
	}
	if (text.length > MAX_TEXT_CHARS) {
		return fail(
			"bad_argument",
			`Text is limited to ${MAX_TEXT_CHARS} characters; that one is ${text.length}.`,
			{ length: text.length, max: MAX_TEXT_CHARS },
		);
	}
	const timing = validateInsertTiming({
		args,
		snapshot,
		fallbackDurationSec: DEFAULT_TEXT_DURATION_SEC,
		minDurationSec: 0.1,
		maxDurationSec: MAX_INSERT_DURATION_SEC,
	});
	if ("ok" in timing) return timing;
	return { ok: true, args: { text, ...timing } };
}

function validateAddMotionTemplate(
	args: Record<string, unknown>,
	snapshot: TimelineSnapshot,
): ValidationResult<AddMotionTemplateArgs> {
	const templateId = readString(args, "templateId");
	if (!templateId) {
		return fail("bad_argument", "add_motion_template needs a templateId.");
	}
	const template = findAssistantTemplate(templateId);
	if (!template) {
		return fail(
			"unknown_template",
			`There is no template called ${templateId}. Available templates: ${ASSISTANT_TEMPLATE_IDS.join(", ")}.`,
			{ templateId },
		);
	}
	const timing = validateInsertTiming({
		args,
		snapshot,
		fallbackDurationSec: template.defaultDurationSec,
		minDurationSec: template.minDurationSec,
		maxDurationSec: template.maxDurationSec,
	});
	if ("ok" in timing) return timing;

	const rawVariables = args.variables;
	const variables: Record<string, string> = {};
	if (rawVariables !== undefined && rawVariables !== null) {
		if (typeof rawVariables !== "object" || Array.isArray(rawVariables)) {
			return fail(
				"bad_argument",
				"variables must be an object of field keys to values.",
				{ templateId },
			);
		}
		// Unknown keys are DROPPED rather than refused, matching how the existing
		// HyperFrames plan sanitizer treats a stray variable. Enum fields are
		// checked though: a bad corner or alignment would silently misplace the
		// graphic, which the user would read as a bug.
		for (const field of template.fields) {
			const value = (rawVariables as Record<string, unknown>)[field.key];
			if (value === undefined || value === null) continue;
			if (typeof value !== "string" && typeof value !== "number") continue;
			const text = String(value).trim();
			if (!text) continue;
			if (field.options && !field.options.includes(text)) {
				return fail(
					"bad_argument",
					`"${text}" is not a valid ${field.label} for ${template.name}. Choose one of: ${field.options.join(", ")}.`,
					{ templateId, field: field.key, value: text },
				);
			}
			variables[field.key] = text.slice(0, MAX_TEXT_CHARS);
		}
	}
	return { ok: true, args: { templateId, ...timing, variables } };
}

function validateAddMarker(
	args: Record<string, unknown>,
	snapshot: TimelineSnapshot,
): ValidationResult<AddMarkerArgs> {
	const rawAt = readNumber(args, "atSec");
	const atSeconds = rawAt ?? mediaTimeToSeconds({ time: snapshot.playhead });
	if (atSeconds < 0) {
		return fail("out_of_bounds", "A marker cannot sit before the timeline starts.", {
			atSec: atSeconds,
		});
	}
	const at = snapSeconds({ seconds: atSeconds, fps: snapshot.fps });
	const note = readString(args, "note");
	if (note && note.length > MAX_TEXT_CHARS) {
		return fail(
			"bad_argument",
			`Marker notes are limited to ${MAX_TEXT_CHARS} characters.`,
			{ length: note.length, max: MAX_TEXT_CHARS },
		);
	}
	return { ok: true, args: { atSec: at.sec, ...(note ? { note } : {}) } };
}

function validateSelectClips(
	args: Record<string, unknown>,
	snapshot: TimelineSnapshot,
): ValidationResult<SelectClipsArgs> {
	const raw = args.clipIds;
	if (!Array.isArray(raw) || raw.length === 0) {
		return fail("bad_argument", "select_clips needs a non-empty clipIds array.");
	}
	if (raw.length > MAX_SELECTION) {
		return fail(
			"bad_argument",
			`select_clips is limited to ${MAX_SELECTION} clips at a time.`,
			{ count: raw.length, max: MAX_SELECTION },
		);
	}
	const clipIds: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string" || !entry.trim()) {
			return fail("bad_argument", "Every entry in clipIds must be a clip id.");
		}
		const clipId = entry.trim();
		if (!findSnapshotClip(snapshot, clipId)) {
			return fail(
				"unknown_clip",
				`There is no clip with id ${clipId} on this timeline.`,
				{ clipId },
			);
		}
		if (!clipIds.includes(clipId)) clipIds.push(clipId);
	}
	return { ok: true, args: { clipIds } };
}

function validateAskUser(
	args: Record<string, unknown>,
): ValidationResult<AskUserArgs> {
	const question = readString(args, "question");
	if (!question) {
		return fail("bad_argument", "ask_user needs a question.");
	}
	if (question.length > MAX_QUESTION_CHARS) {
		return fail(
			"bad_argument",
			`Keep the question under ${MAX_QUESTION_CHARS} characters.`,
			{ length: question.length, max: MAX_QUESTION_CHARS },
		);
	}
	const rawOptions = args.options;
	let options: string[] | undefined;
	if (Array.isArray(rawOptions)) {
		const cleaned = rawOptions
			.filter((entry): entry is string => typeof entry === "string")
			.map((entry) => entry.trim())
			.filter(Boolean)
			.slice(0, 5);
		if (cleaned.length) options = cleaned;
	}
	return { ok: true, args: { question, ...(options ? { options } : {}) } };
}

// --- Tool definitions ------------------------------------------------------

/** A JSON-Schema object, as the provider expects an `input_schema` to look. */
export interface ToolInputSchema {
	type: "object";
	properties: Record<string, unknown>;
	required?: string[];
	additionalProperties: false;
}

export interface AssistantToolDefinition {
	name: AssistantToolName;
	description: string;
	inputSchema: ToolInputSchema;
	/** False only for `ask_user`, the one tool that changes nothing. */
	mutates: boolean;
	validate: (
		args: Record<string, unknown>,
		snapshot: TimelineSnapshot,
	) => ValidationResult<unknown>;
}

const CLIP_ID_PROPERTY = {
	type: "string",
	description: "The clip id exactly as it appears in the context. Never invent one.",
} as const;

export const ASSISTANT_EDIT_TOOLS: AssistantToolDefinition[] = [
	{
		name: "cut_range",
		description:
			"Remove a span of time from the timeline and close the gap. Use this for 'cut out the part from X to Y'. Times are seconds on the current timeline.",
		mutates: true,
		inputSchema: {
			type: "object",
			properties: {
				startSec: { type: "number", description: "Where the removal starts." },
				endSec: { type: "number", description: "Where the removal ends." },
				scope: {
					type: "string",
					enum: ["all", "main"],
					description:
						"'all' removes the span from every lane (the usual choice). 'main' touches only the main video track and its linked audio.",
				},
			},
			required: ["startSec", "endSec"],
			additionalProperties: false,
		},
		validate: validateCutRange,
	},
	{
		name: "delete_clip",
		description:
			"Delete one clip. With the main track magnet on, deleting a main clip closes the gap behind it.",
		mutates: true,
		inputSchema: {
			type: "object",
			properties: { clipId: CLIP_ID_PROPERTY },
			required: ["clipId"],
			additionalProperties: false,
		},
		validate: validateDeleteClip,
	},
	{
		name: "extend_clip",
		description:
			"Grow or shrink one edge of a clip. A positive deltaSec grows the clip, a negative one shrinks it, whichever edge you name. A clip can only grow into source footage it has not used yet; the context lists that headroom per clip.",
		mutates: true,
		inputSchema: {
			type: "object",
			properties: {
				clipId: CLIP_ID_PROPERTY,
				edge: {
					type: "string",
					enum: ["start", "end"],
					description: "Which edge to move.",
				},
				deltaSec: {
					type: "number",
					description: "Seconds to grow (positive) or shrink (negative).",
				},
			},
			required: ["clipId", "edge", "deltaSec"],
			additionalProperties: false,
		},
		validate: validateExtendClip,
	},
	{
		name: "move_clip",
		description:
			"Move a clip to a new start time, optionally onto a different lane. toTrack takes a lane label from the context (for example V2 or A1) or the word 'new' for a fresh lane of the same kind.",
		mutates: true,
		inputSchema: {
			type: "object",
			properties: {
				clipId: CLIP_ID_PROPERTY,
				toStartSec: { type: "number", description: "The new start time." },
				toTrack: {
					type: "string",
					description: "Lane label such as V2 or A1, or 'new'. Omit to stay put.",
				},
			},
			required: ["clipId", "toStartSec"],
			additionalProperties: false,
		},
		validate: validateMoveClip,
	},
	{
		name: "split_at",
		description: "Split one clip in two at a time inside it.",
		mutates: true,
		inputSchema: {
			type: "object",
			properties: {
				clipId: CLIP_ID_PROPERTY,
				atSec: { type: "number", description: "Where to cut the clip." },
			},
			required: ["clipId", "atSec"],
			additionalProperties: false,
		},
		validate: validateSplitAt,
	},
	{
		name: "set_speed",
		description: `Change a video or audio clip's playback rate. 1 is normal, 2 is twice as fast, 0.5 is half speed. Allowed range ${MIN_RETIME_RATE} to ${MAX_RETIME_RATE}.`,
		mutates: true,
		inputSchema: {
			type: "object",
			properties: {
				clipId: CLIP_ID_PROPERTY,
				rate: { type: "number", description: "The new playback rate." },
				maintainPitch: {
					type: "boolean",
					description: "Keep the original pitch when the rate changes.",
				},
			},
			required: ["clipId", "rate"],
			additionalProperties: false,
		},
		validate: validateSetSpeed,
	},
	{
		name: "add_text",
		description:
			"Add a plain text clip. Use add_motion_template instead when the user wants a designed title, lower third, or callout.",
		mutates: true,
		inputSchema: {
			type: "object",
			properties: {
				text: { type: "string", description: "The exact words to show." },
				atSec: {
					type: "number",
					description: "Where it starts. Defaults to the playhead.",
				},
				durationSec: {
					type: "number",
					description: `How long it stays on screen. Defaults to ${DEFAULT_TEXT_DURATION_SEC} seconds.`,
				},
			},
			required: ["text"],
			additionalProperties: false,
		},
		validate: validateAddText,
	},
	{
		name: "add_motion_template",
		description:
			"Insert one of the built-in animated graphics. Each template declares its own variables; pass only those keys.",
		mutates: true,
		inputSchema: {
			type: "object",
			properties: {
				templateId: {
					type: "string",
					enum: ASSISTANT_TEMPLATE_IDS,
					description: "Which template to place.",
				},
				atSec: {
					type: "number",
					description: "Where it starts. Defaults to the playhead.",
				},
				durationSec: {
					type: "number",
					description: "How long it runs. Defaults to the template's own default.",
				},
				variables: {
					type: "object",
					description:
						"Template variables, for example {\"text\":\"Hello\"}. Unknown keys are ignored.",
					additionalProperties: { type: "string" },
				},
			},
			required: ["templateId"],
			additionalProperties: false,
		},
		validate: validateAddMotionTemplate,
	},
	{
		name: "add_marker",
		description: "Drop a marker on the timeline, optionally with a short note.",
		mutates: true,
		inputSchema: {
			type: "object",
			properties: {
				atSec: {
					type: "number",
					description: "Where the marker goes. Defaults to the playhead.",
				},
				note: { type: "string", description: "A short label." },
			},
			required: [],
			additionalProperties: false,
		},
		validate: validateAddMarker,
	},
	{
		name: "select_clips",
		description:
			"Select clips in the editor so the user can see what you mean. Changes nothing else.",
		mutates: true,
		inputSchema: {
			type: "object",
			properties: {
				clipIds: {
					type: "array",
					items: { type: "string" },
					description: "Clip ids from the context.",
				},
			},
			required: ["clipIds"],
			additionalProperties: false,
		},
		validate: validateSelectClips,
	},
	{
		name: "ask_user",
		description:
			"Ask one short clarifying question when the request is ambiguous. The question must be grounded in what is actually on this timeline: name the clips, lanes, or timecodes you are choosing between. Use this instead of guessing, especially before anything destructive.",
		mutates: false,
		inputSchema: {
			type: "object",
			properties: {
				question: {
					type: "string",
					description:
						"The question, referring to real clips or times from the context.",
				},
				options: {
					type: "array",
					items: { type: "string" },
					description: "Up to five short answers the user can pick from.",
				},
			},
			required: ["question"],
			additionalProperties: false,
		},
		validate: (args) => validateAskUser(args),
	},
];

const TOOLS_BY_NAME = new Map<string, AssistantToolDefinition>(
	ASSISTANT_EDIT_TOOLS.map((tool) => [tool.name, tool]),
);

export function findAssistantTool(name: string): AssistantToolDefinition | null {
	return TOOLS_BY_NAME.get(name) ?? null;
}

/** The tool names that change the project. `ask_user` is the only exception. */
export const MUTATING_TOOL_NAMES: AssistantToolName[] = ASSISTANT_EDIT_TOOLS.filter(
	(tool) => tool.mutates,
).map((tool) => tool.name);

// --- Provider mapping ------------------------------------------------------

export interface AnthropicToolSpec {
	name: string;
	description: string;
	input_schema: ToolInputSchema;
}

/** The tool list in the Anthropic messages-API shape. Order is stable. */
export function toAnthropicTools(): AnthropicToolSpec[] {
	return ASSISTANT_EDIT_TOOLS.map((tool) => ({
		name: tool.name,
		description: tool.description,
		input_schema: tool.inputSchema,
	}));
}

// --- Validation entry points ----------------------------------------------

/** Validate one raw tool call against a snapshot. */
export function validateToolCall({
	call,
	snapshot,
}: {
	call: ToolCall;
	snapshot: TimelineSnapshot;
}): ValidationResult<unknown> {
	const tool = findAssistantTool(call.name);
	if (!tool) {
		return fail(
			"unknown_tool",
			`${call.name} is not a tool this editor offers.`,
			{ tool: call.name },
		);
	}
	const args =
		call.args && typeof call.args === "object" && !Array.isArray(call.args)
			? call.args
			: {};
	return tool.validate(args, snapshot);
}

/**
 * Validate a whole turn. Stops at the FIRST failure, because T17.2 applies a
 * turn all-or-nothing: there is no value in collecting further verdicts once the
 * batch is already doomed, and stopping keeps the refusal message about one
 * concrete problem instead of a list.
 */
export function validateTurn({
	calls,
	snapshot,
}: {
	calls: readonly ToolCall[];
	snapshot: TimelineSnapshot;
}): TurnValidation {
	const validated: ValidatedToolCall[] = [];
	for (const call of calls) {
		const result = validateToolCall({ call, snapshot });
		if (!result.ok) return { ok: false, call, failure: result };
		validated.push({
			id: call.id,
			name: call.name,
			args: result.args,
		} as ValidatedToolCall);
	}
	return { ok: true, calls: validated };
}

/** The template catalog, re-exported so callers need one import for the schema. */
export { ASSISTANT_TEMPLATE_CATALOG };
