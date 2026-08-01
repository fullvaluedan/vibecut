/**
 * The EXECUTOR: validated tool calls to timeline commands (T17.2).
 *
 * Architecture rule from the roadmap (section 6): the model never touches
 * timeline state. It emits tool calls, `tools.ts` validates every one of them
 * against a pure snapshot, and only then does this module turn them into
 * commands from the EXISTING command layer. Nothing here is a new editing
 * primitive: every op maps onto a command the UI already drives.
 *
 * TWO HALVES, deliberately split.
 *  - `planAssistantTurn` is PURE with respect to the editor: it reads only the
 *    `TimelineSnapshot` and produces the command objects plus their human
 *    summaries. Commands reach `EditorCore` themselves at `execute()` time, so
 *    planning can be unit-tested with a fixture snapshot and no live editor.
 *  - `executeAssistantTurn` wraps the plan in ONE `BatchCommand` and runs it
 *    through `editor.command.execute`, so a whole turn is a single undo step.
 *
 * ATOMICITY. Planning happens only after `validateTurn` returned `ok: true` for
 * the WHOLE turn. One invalid call means the turn service never calls in here,
 * so nothing is ever half-applied. `planAssistantTurn` therefore assumes its
 * calls are valid and normalized, and never re-clamps them.
 *
 * SEMANTICS the T17.1 validators assumed, honored here:
 *  - `move_clip` onto the main track with the magnet ON is a RIPPLE-INSERT: the
 *    downstream main clips (and their linked audio) open a hole first. That is
 *    why `validateMoveClip` lets an overlap through on main when the magnet is
 *    on and refuses it everywhere else.
 *  - `extend_clip.deltaSec` is positive-grows on EITHER edge; the resize math
 *    signs its own delta by side, so the sign is flipped here exactly once.
 *  - a LEFT-edge trim of a main-track clip with the magnet ON pins the clip's
 *    start and slides the tail instead, matching `ResizeController`.
 *  - `cut_range` scope `"all"` cuts every lane; `"main"` cuts the main track
 *    plus the audio lanes holding linked partners of the affected main clips.
 *
 * MAGNET POST-PASS. `CommandManager.execute` runs its own magnet gap-close
 * after any command while the magnet is on. It composes with the explicit
 * shifts below rather than fighting them: `computeMagnetGapShifts` treats every
 * element that moved WHOLE as "settled" and never slides it a second time, so
 * an assistant ripple-insert leaves only the genuine gap (the clip's origin)
 * for the post-pass to close. Nothing here passes `suppressRipple`, because a
 * turn can mix a ripple-insert with a plain delete and the delete still needs
 * its gap closed.
 */

import type { FrameRate } from "opencut-wasm";
import { BatchCommand } from "@/commands/batch-command";
import type { Command } from "@/commands/base-command";
import { DeleteElementsCommand } from "@/commands/timeline/element/delete-elements";
import { InsertElementCommand } from "@/commands/timeline/element/insert-element";
import { MoveElementCommand } from "@/commands/timeline/element/move-elements";
import { RippleShiftElementsCommand } from "@/commands/timeline/element/ripple-shift-elements";
import { SplitElementsCommand } from "@/commands/timeline/element/split-elements";
import { UpdateElementsCommand } from "@/commands/timeline/element/update-elements";
import { AddTrackCommand } from "@/commands/timeline/track/add-track";
import {
	RemoveRangesCommand,
	type TimeRange,
} from "@/commands/timeline/track/remove-ranges";
import { ToggleBookmarkCommand } from "@/commands/scene/toggle-bookmark";
import { UpdateBookmarkCommand } from "@/commands/scene/update-bookmark";
import { getStyleById } from "@/features/ai-generate/styles";
import { getMotionTemplate } from "@/features/motion-templates/templates";
import { canRestoreDeletion } from "@/features/transcription/restore-popover-gate";
import { applyTemplateDefaults } from "./template-defaults";
import type { ElementRef, TimelineElement } from "@/timeline";
import { buildTextElement } from "@/timeline/element-utils";
import {
	computeLinkedResize,
	type GroupResizeMember,
	type GroupResizeUpdate,
} from "@/timeline/group-resize";
import { getTrackTypeForElementType } from "@/timeline/placement/compatibility";
import type { PlannedElementMove } from "@/timeline/group-move";
import { generateUUID } from "@/utils/id";
import {
	addMediaTime,
	type MediaTime,
	mediaTimeFromSeconds,
	roundFrameTime,
	subMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";
import {
	destructiveSecondsForCall,
	summarizeValidatedCall,
} from "./op-summary";
import { SelectClipsCommand } from "./select-clips-command";
import {
	findSnapshotClip,
	findSnapshotTrack,
	snapshotClipEnd,
	type SnapshotClip,
	type SnapshotTrack,
	type TimelineSnapshot,
} from "./snapshot";
import type { ValidatedToolCall } from "./types";

/** Palette and type face a motion template is built with. Defaults to the
 * project's default AI style so a template inserted by prompt looks exactly
 * like the same template inserted from the Text tab. */
export interface AssistantTemplateLook {
	accent: string;
	fontFamily?: string;
}

const DEFAULT_LOOK_STYLE_ID = "ember";

/** One validated call, planned: what it will do and what it says it did. */
export interface PlannedAssistantOp {
	call: ValidatedToolCall;
	/** The one-sentence description shown in the confirmation list and the chip. */
	summary: string;
	/** Commands this call contributes. Empty for `ask_user`. */
	commands: Command[];
	/** Seconds of timeline this op removes; drives the confirmation threshold. */
	destructiveSeconds: number;
}

export interface AssistantTurnPlan {
	ops: PlannedAssistantOp[];
	/** Every op's commands, flattened in call order. */
	commands: Command[];
	/** Ops that actually change the project (everything except `ask_user`). */
	mutatingCount: number;
	/** Total seconds removed across the turn. */
	destructiveSeconds: number;
	/** Set when the turn contains an `ask_user` call. */
	question: { question: string; options?: string[] } | null;
}

/** The narrow editor slice the executor drives. `EditorCore` satisfies it. */
export interface AssistantExecutorEditor {
	command: {
		execute: (args: { command: Command }) => Command;
		undo: () => void;
		peekUndoCommand: () => Command | null;
	};
	/**
	 * Show-me mode (T17.4): seek + pause after an additive-only turn lands, so
	 * the user sees exactly what was inserted. Optional so tests that only
	 * exercise the command path (no playback stub) keep working unchanged.
	 */
	playback?: {
		seek: (args: { time: MediaTime }) => void;
		pause: () => void;
	};
}

/** Drives the "Applied N changes - Undo" chip. */
export interface AssistantUndoHandle {
	/** True while a plain undo would still revert exactly this apply. */
	canUndo: () => boolean;
	/** Undo it. False when the batch is no longer the top of the undo stack. */
	undo: () => boolean;
}

export interface AssistantApplyResult {
	/** The command handle the manager pushed; compare it against the stack top. */
	batch: Command;
	/** How many mutating ops the turn applied. */
	appliedCount: number;
	undo: AssistantUndoHandle;
}

// --- Tick helpers ----------------------------------------------------------

/**
 * Seconds to ticks on the project's frame grid, by the SAME two steps the
 * validators used (`tools.ts` `snapSeconds`). Going through the identical path
 * matters: a validated argument is a rounded-to-3dp second, and re-deriving it
 * any other way could land a tick off the frame the validator cleared.
 */
function toTicks({
	seconds,
	fps,
}: {
	seconds: number;
	fps: FrameRate;
}): MediaTime {
	return roundFrameTime({ time: mediaTimeFromSeconds({ seconds }), fps });
}

function trackOf(
	snapshot: TimelineSnapshot,
	clip: SnapshotClip,
): SnapshotTrack | null {
	return snapshot.tracks.find((track) => track.id === clip.trackId) ?? null;
}

function spansOverlap(
	a: { start: number; end: number },
	b: { start: number; end: number },
): boolean {
	return a.start < b.end && b.start < a.end;
}

/**
 * Linked partners of a clip that also OVERLAP it on the timeline: the same
 * `mode: "timeline"` rule `findLinkedPartners` uses for selection, move and
 * trim, so split halves pair same-side instead of the whole row ganging up.
 * Computed from the snapshot so planning stays editor-free.
 */
function timelineLinkedPartners(
	snapshot: TimelineSnapshot,
	clip: SnapshotClip,
): SnapshotClip[] {
	if (!clip.linkId) return [];
	const span = { start: clip.startTime as number, end: snapshotClipEnd(clip) };
	const partners: SnapshotClip[] = [];
	for (const track of snapshot.tracks) {
		for (const candidate of track.clips) {
			if (candidate.id === clip.id) continue;
			if (candidate.linkId !== clip.linkId) continue;
			if (
				!spansOverlap(span, {
					start: candidate.startTime as number,
					end: snapshotClipEnd(candidate),
				})
			) {
				continue;
			}
			partners.push(candidate);
		}
	}
	return partners;
}

function refOf(clip: SnapshotClip): ElementRef {
	return { trackId: clip.trackId, elementId: clip.id };
}

// --- Per-tool planners -----------------------------------------------------

/**
 * `cut_range`. `RemoveRangesCommand` cuts EVERY track for a range with no
 * `trackId` and exactly one track for a scoped range, so "all" is one range and
 * "main" is one range per lane in scope. The scoped ranges are independent (a
 * different track each), so the command's descending-start replay sequences
 * them without any of them invalidating another.
 */
function planCutRange({
	args,
	snapshot,
}: {
	args: { startSec: number; endSec: number; scope: "all" | "main" };
	snapshot: TimelineSnapshot;
}): Command[] {
	const start = toTicks({ seconds: args.startSec, fps: snapshot.fps });
	const end = toTicks({ seconds: args.endSec, fps: snapshot.fps });
	if ((end as number) <= (start as number)) return [];

	if (args.scope === "all") {
		return [
			new RemoveRangesCommand({
				ranges: [{ start: start as number, end: end as number }],
			}),
		];
	}

	const main = snapshot.tracks.find((track) => track.isMain);
	if (!main) return [];
	const span = { start: start as number, end: end as number };
	const trackIds: string[] = [main.id];
	for (const clip of main.clips) {
		if (
			!spansOverlap(span, {
				start: clip.startTime as number,
				end: snapshotClipEnd(clip),
			})
		) {
			continue;
		}
		for (const partner of timelineLinkedPartners(snapshot, clip)) {
			if (!trackIds.includes(partner.trackId)) trackIds.push(partner.trackId);
		}
	}
	const ranges: TimeRange[] = trackIds.map((trackId) => ({
		start: start as number,
		end: end as number,
		trackId,
	}));
	return [new RemoveRangesCommand({ ranges })];
}

/** `delete_clip`: the clip plus its separated audio half, one command. The
 * magnet's gap close is the command manager's post-pass, not ours. */
function planDeleteClip({
	args,
	snapshot,
}: {
	args: { clipId: string };
	snapshot: TimelineSnapshot;
}): Command[] {
	const clip = findSnapshotClip(snapshot, args.clipId);
	if (!clip) return [];
	const elements = [
		refOf(clip),
		...timelineLinkedPartners(snapshot, clip).map(refOf),
	];
	return [new DeleteElementsCommand({ elements })];
}

/** The nearest non-member neighbor bounds on a clip's own lane, exactly as the
 * drag handles measure them (and as `validateExtendClip` measured them). */
function neighborBounds({
	clip,
	track,
	excludeIds,
}: {
	clip: SnapshotClip;
	track: SnapshotTrack;
	excludeIds: ReadonlySet<string>;
}): { left: MediaTime | null; right: MediaTime | null } {
	const start = clip.startTime as number;
	const end = snapshotClipEnd(clip);
	let left: number | null = null;
	let right: number | null = null;
	for (const other of track.clips) {
		if (other.id === clip.id || excludeIds.has(other.id)) continue;
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

function toResizeMember({
	clip,
	snapshot,
	excludeIds,
}: {
	clip: SnapshotClip;
	snapshot: TimelineSnapshot;
	excludeIds: ReadonlySet<string>;
}): GroupResizeMember {
	const track = trackOf(snapshot, clip);
	const bounds = track
		? neighborBounds({ clip, track, excludeIds })
		: { left: null, right: null };
	return {
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
	};
}

/**
 * The magnet's tail slide for a LEFT-edge main trim, computed from the
 * snapshot. Mirrors `computeMagnetTrimShifts`: main-track elements at or after
 * the pivot, plus their linked partners wherever they live, all moved by one
 * signed delta. Duplicated against the snapshot rather than called with live
 * `SceneTracks` so planning needs no editor.
 */
function magnetTailShifts({
	snapshot,
	pivotTime,
	deltaTime,
	excludeIds,
}: {
	snapshot: TimelineSnapshot;
	pivotTime: MediaTime;
	deltaTime: MediaTime;
	excludeIds: ReadonlySet<string>;
}): { trackId: string; elementId: string; newStartTime: MediaTime }[] {
	if ((deltaTime as number) === 0) return [];
	const main = snapshot.tracks.find((track) => track.isMain);
	if (!main) return [];
	const shifts: {
		trackId: string;
		elementId: string;
		newStartTime: MediaTime;
	}[] = [];
	const claimed = new Set<string>();
	for (const clip of main.clips) {
		if (excludeIds.has(clip.id)) continue;
		if ((clip.startTime as number) < (pivotTime as number)) continue;
		if (claimed.has(clip.id)) continue;
		claimed.add(clip.id);
		shifts.push({
			trackId: clip.trackId,
			elementId: clip.id,
			newStartTime: addMediaTime({ a: clip.startTime, b: deltaTime }),
		});
		for (const partner of timelineLinkedPartners(snapshot, clip)) {
			if (claimed.has(partner.id) || excludeIds.has(partner.id)) continue;
			claimed.add(partner.id);
			shifts.push({
				trackId: partner.trackId,
				elementId: partner.id,
				newStartTime: addMediaTime({ a: partner.startTime, b: deltaTime }),
			});
		}
	}
	return shifts;
}

/**
 * `extend_clip`, through the editor's REAL resize math (`computeLinkedResize`),
 * so a retimed clip consumes `delta * rate` of source and a linked pair moves
 * as one gesture, exactly as a drag would.
 *
 * The right edge is bounded by the next clip on the lane (the validator refused
 * anything past it), so a right-edge grow never needs a downstream push. The
 * left edge with the magnet on main is the case that does: the start is pinned,
 * so the clip eats into the tail and the tail slides by the negated delta.
 */
function planExtendClip({
	args,
	snapshot,
}: {
	args: { clipId: string; edge: "start" | "end"; deltaSec: number };
	snapshot: TimelineSnapshot;
}): Command[] {
	const clip = findSnapshotClip(snapshot, args.clipId);
	if (!clip) return [];
	const track = trackOf(snapshot, clip);
	const partners = timelineLinkedPartners(snapshot, clip);
	const memberIds = new Set([clip.id, ...partners.map((p) => p.id)]);
	const side = args.edge === "end" ? "right" : "left";
	// A positive deltaSec always GROWS. The resize math signs its delta by side
	// (a left handle grows on a negative delta), so flip here exactly once - the
	// same flip `validateExtendClip` made when it checked the bounds.
	const magnitude = toTicks({ seconds: args.deltaSec, fps: snapshot.fps });
	const deltaTime = (
		side === "right" ? (magnitude as number) : -(magnitude as number)
	) as MediaTime;
	const magnetLeft =
		side === "left" && snapshot.magnetEnabled && (track?.isMain ?? false);

	const members = [clip, ...partners].map((member) => {
		const built = toResizeMember({
			clip: member,
			snapshot,
			excludeIds: memberIds,
		});
		return magnetLeft ? { ...built, leftBoundLifted: true } : built;
	});
	const result = computeLinkedResize({
		members,
		side,
		deltaTime,
		fps: snapshot.fps,
	});
	// Magnet LEFT trims write each member's committed start back over the resize
	// patch: a head trim changes the clip's content, never its position, and the
	// gap it would have opened is closed by the tail shift below.
	const pinned: GroupResizeUpdate[] = magnetLeft
		? result.updates.map((update) => {
				const member = members.find(
					(entry) => entry.elementId === update.elementId,
				);
				return member
					? { ...update, patch: { ...update.patch, startTime: member.startTime } }
					: update;
			})
		: result.updates;

	const commands: Command[] = [
		new UpdateElementsCommand({
			updates: pinned.map((update) => ({
				trackId: update.trackId,
				elementId: update.elementId,
				patch: update.patch as Partial<TimelineElement>,
			})),
		}),
	];
	if (magnetLeft) {
		const shifts = magnetTailShifts({
			snapshot,
			pivotTime: clip.startTime,
			// A magnet left trim negates the resize delta: the clip grew leftward on
			// a negative delta, so the tail moves right by the same amount.
			deltaTime: subMediaTime({
				a: ZERO_MEDIA_TIME,
				b: result.deltaTime,
			}),
			excludeIds: memberIds,
		});
		if (shifts.length > 0) {
			commands.push(new RippleShiftElementsCommand({ shifts }));
		}
	}
	return commands;
}

/**
 * The ripple-insert hole for a magnet move onto the main track: every main clip
 * starting at or after the landing point (plus its linked audio) slides right
 * by the moved clip's length, so the move lands in a real gap instead of on top
 * of a neighbor. Same geometry as `computeRippleInsertShifts`, read off the
 * snapshot.
 */
function rippleInsertShifts({
	snapshot,
	target,
	insertStart,
	shiftDuration,
	excludeIds,
}: {
	snapshot: TimelineSnapshot;
	target: SnapshotTrack;
	insertStart: MediaTime;
	shiftDuration: MediaTime;
	excludeIds: ReadonlySet<string>;
}): { trackId: string; elementId: string; newStartTime: MediaTime }[] {
	if ((shiftDuration as number) <= 0) return [];
	const shifts: {
		trackId: string;
		elementId: string;
		newStartTime: MediaTime;
	}[] = [];
	const claimed = new Set<string>();
	for (const clip of target.clips) {
		if (excludeIds.has(clip.id)) continue;
		if ((clip.startTime as number) < (insertStart as number)) continue;
		if (claimed.has(clip.id)) continue;
		claimed.add(clip.id);
		shifts.push({
			trackId: clip.trackId,
			elementId: clip.id,
			newStartTime: addMediaTime({ a: clip.startTime, b: shiftDuration }),
		});
		for (const partner of timelineLinkedPartners(snapshot, clip)) {
			if (claimed.has(partner.id) || excludeIds.has(partner.id)) continue;
			claimed.add(partner.id);
			shifts.push({
				trackId: partner.trackId,
				elementId: partner.id,
				newStartTime: addMediaTime({ a: partner.startTime, b: shiftDuration }),
			});
		}
	}
	return shifts;
}

/**
 * `move_clip`. A linked partner moves by the SAME delta on its own lane, so a
 * video and its separated audio never drift apart. `toNewTrack` creates a lane
 * of the clip's own kind first; `AddTrackCommand` resolves its id in the
 * constructor, so the move can target it inside the same batch.
 */
function planMoveClip({
	args,
	snapshot,
}: {
	args: { clipId: string; toStartSec: number; toTrackId?: string; toNewTrack?: true };
	snapshot: TimelineSnapshot;
}): Command[] {
	const clip = findSnapshotClip(snapshot, args.clipId);
	if (!clip) return [];
	const newStart = toTicks({ seconds: args.toStartSec, fps: snapshot.fps });
	const delta = subMediaTime({ a: newStart, b: clip.startTime });
	const partners = timelineLinkedPartners(snapshot, clip);
	const movingIds = new Set([clip.id, ...partners.map((p) => p.id)]);

	const commands: Command[] = [];
	let targetTrackId = args.toTrackId ?? clip.trackId;
	let targetTrack: SnapshotTrack | null = null;
	if (args.toNewTrack) {
		const addTrack = new AddTrackCommand({
			type: getTrackTypeForElementType({ elementType: clip.type }),
		});
		commands.push(addTrack);
		targetTrackId = addTrack.getTrackId();
	} else {
		targetTrack = findSnapshotTrack(snapshot, targetTrackId);
	}

	if (targetTrack?.isMain && snapshot.magnetEnabled) {
		const shifts = rippleInsertShifts({
			snapshot,
			target: targetTrack,
			insertStart: newStart,
			shiftDuration: clip.duration,
			excludeIds: movingIds,
		});
		if (shifts.length > 0) {
			commands.push(new RippleShiftElementsCommand({ shifts }));
		}
	}

	const moves: PlannedElementMove[] = [
		{
			elementId: clip.id,
			sourceTrackId: clip.trackId,
			targetTrackId,
			newStartTime: newStart,
		},
		...partners.map((partner) => ({
			elementId: partner.id,
			sourceTrackId: partner.trackId,
			// A partner keeps its own lane; only the named clip changes track.
			targetTrackId: partner.trackId,
			newStartTime: addMediaTime({ a: partner.startTime, b: delta }),
		})),
	];
	commands.push(new MoveElementCommand({ moves }));
	return commands;
}

/** `split_at`: the clip and any linked partner that also spans the cut point,
 * so a video and its separated audio split on the same frame. */
function planSplitAt({
	args,
	snapshot,
}: {
	args: { clipId: string; atSec: number };
	snapshot: TimelineSnapshot;
}): Command[] {
	const clip = findSnapshotClip(snapshot, args.clipId);
	if (!clip) return [];
	const splitTime = toTicks({ seconds: args.atSec, fps: snapshot.fps });
	const at = splitTime as number;
	const elements = [
		refOf(clip),
		...timelineLinkedPartners(snapshot, clip)
			.filter(
				(partner) =>
					(partner.startTime as number) < at && at < snapshotClipEnd(partner),
			)
			.map(refOf),
	];
	return [new SplitElementsCommand({ elements, splitTime })];
}

/** `set_speed`: one retime patch. The update pipeline's retime rule re-derives
 * the clip's duration from the new rate, so nothing else has to be computed. */
function planSetSpeed({
	args,
	snapshot,
}: {
	args: { clipId: string; rate: number; maintainPitch: boolean };
	snapshot: TimelineSnapshot;
}): Command[] {
	const clip = findSnapshotClip(snapshot, args.clipId);
	if (!clip) return [];
	return [
		new UpdateElementsCommand({
			updates: [
				{
					trackId: clip.trackId,
					elementId: clip.id,
					patch: {
						retime: { rate: args.rate, maintainPitch: args.maintainPitch },
					} as Partial<TimelineElement>,
				},
			],
		}),
	];
}

/** `add_text`: the same builder and placement the Text tab's "Add to timeline"
 * uses, with the model's words and timing. */
function planAddText({
	args,
	snapshot,
}: {
	args: { text: string; atSec: number; durationSec: number };
	snapshot: TimelineSnapshot;
}): Command[] {
	const element = buildTextElement({
		raw: {
			name: args.text.slice(0, 24) || "Text",
			duration: toTicks({ seconds: args.durationSec, fps: snapshot.fps }),
			params: { content: args.text },
		},
		startTime: toTicks({ seconds: args.atSec, fps: snapshot.fps }),
	});
	return [new InsertElementCommand({ element, placement: { mode: "auto" } })];
}

/**
 * `add_motion_template`: the registry builds the pieces, one insert each, the
 * same call shape the Motion templates gallery makes.
 *
 * T17.4: before the registry ever sees the model's `variables`, the gaps the
 * model left (no corner, no accent, no color) are filled from the project's
 * OWN palette and each template's own position defaults
 * (`applyTemplateDefaults`), so "add a title that says X" looks designed
 * against this project's background instead of landing the same
 * fixed-white-on-fixed-accent look every time. Anything the model DID set
 * passes through unchanged - the defaults only fill absent keys.
 */
function planAddMotionTemplate({
	args,
	snapshot,
	look,
}: {
	args: {
		templateId: string;
		atSec: number;
		durationSec: number;
		variables: Record<string, string>;
	};
	snapshot: TimelineSnapshot;
	look: AssistantTemplateLook;
}): Command[] {
	const template = getMotionTemplate(args.templateId);
	if (!template) return [];
	const variables = applyTemplateDefaults({
		templateId: args.templateId,
		variables: args.variables,
		backgroundColor: snapshot.background,
	});
	const elements = template.build({
		startTime: toTicks({ seconds: args.atSec, fps: snapshot.fps }),
		durationSec: args.durationSec,
		variables,
		accent: look.accent,
		canvasSize: snapshot.canvas,
		groupId: generateUUID(),
		fromAi: true,
		...(look.fontFamily ? { fontFamily: look.fontFamily } : {}),
	});
	return elements.map(
		(element) => new InsertElementCommand({ element, placement: { mode: "auto" } }),
	);
}

/**
 * `add_marker`. There is no add-bookmark command, only a toggle, so a toggle at
 * a time that ALREADY holds a marker would delete it. The snapshot says whether
 * one is there, so the toggle is skipped in that case and only the note is
 * written.
 */
function planAddMarker({
	args,
	snapshot,
}: {
	args: { atSec: number; note?: string };
	snapshot: TimelineSnapshot;
}): Command[] {
	const time = toTicks({ seconds: args.atSec, fps: snapshot.fps });
	const exists = snapshot.markers.some(
		(marker) => (marker.atTime as number) === (time as number),
	);
	const commands: Command[] = [];
	if (!exists) commands.push(new ToggleBookmarkCommand(time));
	if (args.note) {
		commands.push(
			new UpdateBookmarkCommand({ time, updates: { note: args.note } }),
		);
	}
	return commands;
}

function planSelectClips({
	args,
	snapshot,
}: {
	args: { clipIds: string[] };
	snapshot: TimelineSnapshot;
}): Command[] {
	const refs: ElementRef[] = [];
	for (const clipId of args.clipIds) {
		const clip = findSnapshotClip(snapshot, clipId);
		if (clip) refs.push(refOf(clip));
	}
	if (refs.length === 0) return [];
	return [new SelectClipsCommand({ refs })];
}

// --- Planning --------------------------------------------------------------

function planCall({
	call,
	snapshot,
	look,
}: {
	call: ValidatedToolCall;
	snapshot: TimelineSnapshot;
	look: AssistantTemplateLook;
}): Command[] {
	switch (call.name) {
		case "cut_range":
			return planCutRange({ args: call.args, snapshot });
		case "delete_clip":
			return planDeleteClip({ args: call.args, snapshot });
		case "extend_clip":
			return planExtendClip({ args: call.args, snapshot });
		case "move_clip":
			return planMoveClip({ args: call.args, snapshot });
		case "split_at":
			return planSplitAt({ args: call.args, snapshot });
		case "set_speed":
			return planSetSpeed({ args: call.args, snapshot });
		case "add_text":
			return planAddText({ args: call.args, snapshot });
		case "add_motion_template":
			return planAddMotionTemplate({ args: call.args, snapshot, look });
		case "add_marker":
			return planAddMarker({ args: call.args, snapshot });
		case "select_clips":
			return planSelectClips({ args: call.args, snapshot });
		case "ask_user":
			// `ask_user` mutates nothing: a turn containing it produces no batch at
			// all, and the caller surfaces the question instead.
			return [];
	}
}

/**
 * Turn a fully validated turn into commands. Call this ONLY after
 * `validateTurn` returned `ok: true` against the snapshot passed in here.
 */
export function planAssistantTurn({
	calls,
	snapshot,
	look,
}: {
	calls: readonly ValidatedToolCall[];
	snapshot: TimelineSnapshot;
	look?: AssistantTemplateLook;
}): AssistantTurnPlan {
	const resolvedLook = look ?? defaultTemplateLook();
	const ops: PlannedAssistantOp[] = calls.map((call) => ({
		call,
		summary: summarizeValidatedCall({ call, snapshot }),
		commands: planCall({ call, snapshot, look: resolvedLook }),
		destructiveSeconds: destructiveSecondsForCall({ call, snapshot }),
	}));
	const ask = calls.find((call) => call.name === "ask_user");
	return {
		ops,
		commands: ops.flatMap((op) => op.commands),
		mutatingCount: ops.filter((op) => op.call.name !== "ask_user").length,
		destructiveSeconds: ops.reduce((total, op) => total + op.destructiveSeconds, 0),
		question:
			ask && ask.name === "ask_user"
				? {
						question: ask.args.question,
						...(ask.args.options ? { options: ask.args.options } : {}),
					}
				: null,
	};
}

export function defaultTemplateLook(): AssistantTemplateLook {
	const style = getStyleById(DEFAULT_LOOK_STYLE_ID);
	return { accent: style.accent, fontFamily: style.fontFamily };
}

// --- Execution -------------------------------------------------------------

/**
 * Whether a plain undo would still revert exactly this apply. Reuses the T16.3
 * restore gate rather than restating it: the rule ("the captured command must
 * still be the identity `peekUndoCommand()` returns") is the same one, and the
 * helper is generic over the command type for exactly this reason.
 */
export function canUndoAssistantApply({
	batch,
	topUndoCommand,
}: {
	batch: Command | null;
	topUndoCommand: Command | null;
}): boolean {
	return canRestoreDeletion({ deletionCommand: batch, topUndoCommand });
}

export function buildAssistantUndoHandle({
	editor,
	batch,
}: {
	editor: AssistantExecutorEditor;
	batch: Command;
}): AssistantUndoHandle {
	const canUndo = () =>
		canUndoAssistantApply({
			batch,
			topUndoCommand: editor.command.peekUndoCommand(),
		});
	return {
		canUndo,
		undo: () => {
			if (!canUndo()) return false;
			editor.command.undo();
			return true;
		},
	};
}

/**
 * Apply a planned turn as ONE undoable batch. Returns null when the turn
 * produced no commands at all (a pure `ask_user` turn, or a turn whose only
 * calls were no-ops), so the caller can tell "nothing to apply" from "applied
 * nothing".
 */
export function executeAssistantTurn({
	plan,
	editor,
}: {
	plan: AssistantTurnPlan;
	editor: AssistantExecutorEditor;
}): AssistantApplyResult | null {
	if (plan.commands.length === 0) return null;
	const batch = editor.command.execute({
		command: new BatchCommand(plan.commands),
	});
	return {
		batch,
		appliedCount: plan.mutatingCount,
		undo: buildAssistantUndoHandle({ editor, batch }),
	};
}

// --- Show-me mode (T17.4) ---------------------------------------------------

/**
 * True for a turn that is nothing but inserts - every call is `add_text` or
 * `add_motion_template`, with no destructive or repositioning op mixed in.
 * That is the "show me" case: there is exactly one sensible place to look
 * (where the thing just landed), so the turn earns an automatic seek instead
 * of leaving the user to scrub for it. An empty turn is not additive-only:
 * there would be nothing to show.
 */
export function isAdditiveOnlyTurn(calls: readonly ValidatedToolCall[]): boolean {
	return (
		calls.length > 0 &&
		calls.every((call) => call.name === "add_text" || call.name === "add_motion_template")
	);
}

/**
 * The earliest inserted element's start time across an additive-only turn's
 * calls, on the project's frame grid. Null when the turn inserted nothing
 * (should not happen when `isAdditiveOnlyTurn` is true, but this stays total
 * either way rather than assuming its own precondition).
 */
export function earliestInsertStart({
	calls,
	snapshot,
}: {
	calls: readonly ValidatedToolCall[];
	snapshot: TimelineSnapshot;
}): MediaTime | null {
	let earliest: number | null = null;
	for (const call of calls) {
		if (call.name !== "add_text" && call.name !== "add_motion_template") continue;
		const ticks = toTicks({ seconds: call.args.atSec, fps: snapshot.fps }) as number;
		if (earliest === null || ticks < earliest) earliest = ticks;
	}
	return earliest === null ? null : (earliest as MediaTime);
}

/**
 * The show-me post-apply hook. Called from `turn-service.ts` AFTER
 * `executeAssistantTurn` has already landed the batch - deliberately outside
 * `plan.commands`, so a plain Ctrl+Z still cleanly reverts only the inserted
 * element(s) and this never becomes part of that one undo step.
 *
 * Selection needs no separate step here: every insert already returns a
 * `CommandResult.selection` (see `InsertElementCommand.execute`), and
 * `BatchCommand`/`CommandManager` already apply the LAST one, so by the time
 * this runs the just-inserted element is already selected and the Template
 * Controls tab is already one click away.
 */
export function showInsertedElement({
	calls,
	snapshot,
	editor,
}: {
	calls: readonly ValidatedToolCall[];
	snapshot: TimelineSnapshot;
	editor: AssistantExecutorEditor;
}): void {
	if (!editor.playback) return;
	if (!isAdditiveOnlyTurn(calls)) return;
	const startTime = earliestInsertStart({ calls, snapshot });
	if (startTime === null) return;
	editor.playback.seek({ time: startTime });
	editor.playback.pause();
}
