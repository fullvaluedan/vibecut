import { describe, expect, test } from "bun:test";
import {
	destructiveSecondsForCall,
	formatOpSeconds,
	formatOpTimecode,
	summarizeValidatedCall,
	summarizeValidatedCalls,
} from "../op-summary";
import type { ValidatedToolCall } from "../types";
import { smallSnapshot } from "./fixtures";

const snapshot = smallSnapshot();

describe("formatting helpers", () => {
	test("seconds always carry one decimal", () => {
		expect(formatOpSeconds(2)).toBe("2.0");
		expect(formatOpSeconds(2.04)).toBe("2.0");
		expect(formatOpSeconds(4.71)).toBe("4.7");
		expect(formatOpSeconds(-1.5)).toBe("1.5");
	});

	test("positions read as timecode", () => {
		expect(formatOpTimecode(0)).toBe("0:00");
		expect(formatOpTimecode(30)).toBe("0:30");
		expect(formatOpTimecode(65.4)).toBe("1:05");
		expect(formatOpTimecode(3723)).toBe("1:02:03");
	});
});

describe("summarizeValidatedCall", () => {
	test("cut_range names the scope", () => {
		expect(
			summarizeValidatedCall({
				call: {
					id: "1",
					name: "cut_range",
					args: { startSec: 2.1, endSec: 4.7, scope: "all" },
				},
				snapshot,
			}),
		).toBe("Cut 2.1s to 4.7s across all tracks");
		expect(
			summarizeValidatedCall({
				call: {
					id: "1",
					name: "cut_range",
					args: { startSec: 2, endSec: 4, scope: "main" },
				},
				snapshot,
			}),
		).toBe("Cut 2.0s to 4.0s on the main track");
	});

	test("delete_clip prefers the media name", () => {
		expect(
			summarizeValidatedCall({
				call: { id: "1", name: "delete_clip", args: { clipId: "clip-body" } },
				snapshot,
			}),
		).toBe('Delete "body.mp4"');
	});

	test("delete_clip falls back to the id for a clip that is gone", () => {
		expect(
			summarizeValidatedCall({
				call: { id: "1", name: "delete_clip", args: { clipId: "ghost" } },
				snapshot,
			}),
		).toBe("Delete clip ghost");
	});

	test("extend_clip reads as extend or trim, per edge and sign", () => {
		const call = (
			edge: "start" | "end",
			deltaSec: number,
		): ValidatedToolCall => ({
			id: "1",
			name: "extend_clip",
			args: { clipId: "clip-body", edge, deltaSec },
		});
		expect(summarizeValidatedCall({ call: call("end", 2), snapshot })).toBe(
			'Extend "body.mp4" by 2.0s',
		);
		expect(summarizeValidatedCall({ call: call("start", 2), snapshot })).toBe(
			'Extend "body.mp4" by 2.0s at the start',
		);
		expect(summarizeValidatedCall({ call: call("end", -1.5), snapshot })).toBe(
			'Trim 1.5s off the end of "body.mp4"',
		);
		expect(summarizeValidatedCall({ call: call("start", -1), snapshot })).toBe(
			'Trim 1.0s off the start of "body.mp4"',
		);
	});

	test("move_clip names the destination lane", () => {
		expect(
			summarizeValidatedCall({
				call: {
					id: "1",
					name: "move_clip",
					args: { clipId: "clip-body", toStartSec: 30 },
				},
				snapshot,
			}),
		).toBe('Move "body.mp4" to 0:30');
		expect(
			summarizeValidatedCall({
				call: {
					id: "1",
					name: "move_clip",
					args: { clipId: "clip-title", toStartSec: 12, toTrackId: "track-text" },
				},
				snapshot,
			}),
		).toBe('Move "Kinetic title" to 0:12 on T1');
		expect(
			summarizeValidatedCall({
				call: {
					id: "1",
					name: "move_clip",
					args: { clipId: "clip-body", toStartSec: 12, toNewTrack: true },
				},
				snapshot,
			}),
		).toBe('Move "body.mp4" to 0:12 on a new lane');
	});

	test("the remaining tools each read as one plain sentence", () => {
		const cases: [ValidatedToolCall, string][] = [
			[
				{ id: "1", name: "split_at", args: { clipId: "clip-body", atSec: 8 } },
				'Split "body.mp4" at 0:08',
			],
			[
				{
					id: "1",
					name: "set_speed",
					args: { clipId: "clip-body", rate: 2, maintainPitch: false },
				},
				'Set "body.mp4" to 2x speed',
			],
			[
				{
					id: "1",
					name: "set_speed",
					args: { clipId: "clip-body", rate: 0.5, maintainPitch: true },
				},
				'Set "body.mp4" to 0.5x speed, keeping the pitch',
			],
			[
				{
					id: "1",
					name: "add_text",
					args: { text: "Hello", atSec: 30, durationSec: 5 },
				},
				'Add the text "Hello" at 0:30',
			],
			[
				{
					id: "1",
					name: "add_motion_template",
					args: {
						templateId: "lower-third",
						atSec: 30,
						durationSec: 4,
						variables: {},
					},
				},
				"Add Lower third at 0:30",
			],
			[
				{ id: "1", name: "add_marker", args: { atSec: 30 } },
				"Add a marker at 0:30",
			],
			[
				{ id: "1", name: "add_marker", args: { atSec: 30, note: "hook" } },
				'Add the marker "hook" at 0:30',
			],
			[
				{ id: "1", name: "select_clips", args: { clipIds: ["clip-body"] } },
				"Select 1 clip",
			],
			[
				{
					id: "1",
					name: "select_clips",
					args: { clipIds: ["clip-body", "clip-intro"] },
				},
				"Select 2 clips",
			],
			[
				{ id: "1", name: "ask_user", args: { question: "Which intro?" } },
				"Ask: Which intro?",
			],
		];
		for (const [call, expected] of cases) {
			expect(summarizeValidatedCall({ call, snapshot })).toBe(expected);
		}
	});

	test("summarizeValidatedCalls keeps call order", () => {
		expect(
			summarizeValidatedCalls({
				calls: [
					{ id: "1", name: "delete_clip", args: { clipId: "clip-body" } },
					{ id: "2", name: "add_marker", args: { atSec: 30 } },
				],
				snapshot,
			}),
		).toEqual(['Delete "body.mp4"', "Add a marker at 0:30"]);
	});
});

describe("destructiveSecondsForCall", () => {
	test("a cut counts its span", () => {
		expect(
			destructiveSecondsForCall({
				call: {
					id: "1",
					name: "cut_range",
					args: { startSec: 2, endSec: 6.5, scope: "all" },
				},
				snapshot,
			}),
		).toBeCloseTo(4.5, 5);
	});

	test("a delete counts the clip's length", () => {
		expect(
			destructiveSecondsForCall({
				call: { id: "1", name: "delete_clip", args: { clipId: "clip-body" } },
				snapshot,
			}),
		).toBeCloseTo(10, 5);
	});

	test("a delete of a clip that is gone counts nothing", () => {
		expect(
			destructiveSecondsForCall({
				call: { id: "1", name: "delete_clip", args: { clipId: "ghost" } },
				snapshot,
			}),
		).toBe(0);
	});

	test("inserts and markers remove nothing", () => {
		for (const call of [
			{
				id: "1",
				name: "add_text" as const,
				args: { text: "hi", atSec: 1, durationSec: 5 },
			},
			{ id: "2", name: "add_marker" as const, args: { atSec: 1 } },
			{
				id: "3",
				name: "extend_clip" as const,
				args: { clipId: "clip-body", edge: "end" as const, deltaSec: -3 },
			},
		]) {
			expect(destructiveSecondsForCall({ call, snapshot })).toBe(0);
		}
	});
});
