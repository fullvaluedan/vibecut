/**
 * HUMAN SUMMARIES for validated assistant tool calls (T17.2).
 *
 * One sentence per call, in the user's language rather than the schema's. Two
 * consumers, and they must agree word for word or a confirmation list would
 * describe something different from the chip that follows it:
 *  - the `proposed-ops` event, shown before a large or destructive turn is
 *    applied;
 *  - the `applied` chip, shown after.
 *
 * Pure: snapshot in, strings out, no store and no command layer. The turn
 * service also reads `destructiveSecondsForCall` here, so the confirmation
 * threshold is measured by the same module that describes the op.
 */

import { mediaTimeToSeconds } from "@/wasm";
import {
	findSnapshotClip,
	findSnapshotTrack,
	type SnapshotClip,
	type TimelineSnapshot,
} from "./snapshot";
import { findAssistantTemplate } from "./template-catalog";
import type { ValidatedToolCall } from "./types";

/** Seconds with one decimal, so "2" and "2.04" both read as "2.0". */
export function formatOpSeconds(seconds: number): string {
	return Math.abs(seconds).toFixed(1);
}

/** A timeline position as the ruler shows it: 0:30, 4:05, 1:02:03. */
export function formatOpTimecode(seconds: number): string {
	const total = Math.max(0, Math.round(seconds));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const secs = total % 60;
	const padded = String(secs).padStart(2, "0");
	if (hours > 0) {
		return `${hours}:${String(minutes).padStart(2, "0")}:${padded}`;
	}
	return `${minutes}:${padded}`;
}

/** What the user calls this clip: the media file when there is one, else the
 * clip's own timeline name. Quoted, because a bare name reads as a typo. */
export function describeClip(clip: SnapshotClip): string {
	return `"${clip.mediaName ?? clip.name}"`;
}

function clipLabel(snapshot: TimelineSnapshot, clipId: string): string {
	const clip = findSnapshotClip(snapshot, clipId);
	return clip ? describeClip(clip) : `clip ${clipId}`;
}

function trackLabel(snapshot: TimelineSnapshot, trackId: string): string {
	return findSnapshotTrack(snapshot, trackId)?.label ?? trackId;
}

/**
 * How much timeline a call REMOVES, in seconds. Only the two tools that take
 * footage away count: the confirmation threshold exists to catch a big
 * destructive turn, and an insert or a marker takes nothing away however many
 * of them a turn contains (the op-count threshold covers those).
 */
export function destructiveSecondsForCall({
	call,
	snapshot,
}: {
	call: ValidatedToolCall;
	snapshot: TimelineSnapshot;
}): number {
	if (call.name === "cut_range") {
		return Math.max(0, call.args.endSec - call.args.startSec);
	}
	if (call.name === "delete_clip") {
		const clip = findSnapshotClip(snapshot, call.args.clipId);
		if (!clip) return 0;
		return mediaTimeToSeconds({ time: clip.duration });
	}
	return 0;
}

export function summarizeValidatedCall({
	call,
	snapshot,
}: {
	call: ValidatedToolCall;
	snapshot: TimelineSnapshot;
}): string {
	switch (call.name) {
		case "cut_range": {
			const where =
				call.args.scope === "main" ? "on the main track" : "across all tracks";
			return `Cut ${formatOpSeconds(call.args.startSec)}s to ${formatOpSeconds(call.args.endSec)}s ${where}`;
		}
		case "delete_clip":
			return `Delete ${clipLabel(snapshot, call.args.clipId)}`;
		case "extend_clip": {
			const label = clipLabel(snapshot, call.args.clipId);
			const amount = formatOpSeconds(call.args.deltaSec);
			const edge = call.args.edge === "start" ? "start" : "end";
			if (call.args.deltaSec >= 0) {
				return call.args.edge === "start"
					? `Extend ${label} by ${amount}s at the start`
					: `Extend ${label} by ${amount}s`;
			}
			return `Trim ${amount}s off the ${edge} of ${label}`;
		}
		case "move_clip": {
			const label = clipLabel(snapshot, call.args.clipId);
			const at = formatOpTimecode(call.args.toStartSec);
			if (call.args.toNewTrack) return `Move ${label} to ${at} on a new lane`;
			if (call.args.toTrackId) {
				return `Move ${label} to ${at} on ${trackLabel(snapshot, call.args.toTrackId)}`;
			}
			return `Move ${label} to ${at}`;
		}
		case "split_at":
			return `Split ${clipLabel(snapshot, call.args.clipId)} at ${formatOpTimecode(call.args.atSec)}`;
		case "set_speed": {
			const label = clipLabel(snapshot, call.args.clipId);
			const pitch = call.args.maintainPitch ? ", keeping the pitch" : "";
			return `Set ${label} to ${call.args.rate}x speed${pitch}`;
		}
		case "add_text":
			return `Add the text "${call.args.text}" at ${formatOpTimecode(call.args.atSec)}`;
		case "add_motion_template": {
			const template = findAssistantTemplate(call.args.templateId);
			return `Add ${template?.name ?? call.args.templateId} at ${formatOpTimecode(call.args.atSec)}`;
		}
		case "add_marker":
			return call.args.note
				? `Add the marker "${call.args.note}" at ${formatOpTimecode(call.args.atSec)}`
				: `Add a marker at ${formatOpTimecode(call.args.atSec)}`;
		case "select_clips": {
			const count = call.args.clipIds.length;
			return `Select ${count} ${count === 1 ? "clip" : "clips"}`;
		}
		case "ask_user":
			return `Ask: ${call.args.question}`;
	}
}

export function summarizeValidatedCalls({
	calls,
	snapshot,
}: {
	calls: readonly ValidatedToolCall[];
	snapshot: TimelineSnapshot;
}): string[] {
	return calls.map((call) => summarizeValidatedCall({ call, snapshot }));
}
