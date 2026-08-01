import { describe, expect, test } from "bun:test";
import { MAX_RETIME_RATE, MIN_RETIME_RATE } from "@/retime/rate";
import {
	ASSISTANT_EDIT_TOOLS,
	findAssistantTool,
	MUTATING_TOOL_NAMES,
	toAnthropicTools,
	validateToolCall,
	validateTurn,
} from "../tools";
import { ASSISTANT_TEMPLATE_IDS } from "../template-catalog";
import type { TimelineSnapshot } from "../snapshot";
import type {
	AddMarkerArgs,
	AddMotionTemplateArgs,
	AddTextArgs,
	AskUserArgs,
	CutRangeArgs,
	ExtendClipArgs,
	MoveClipArgs,
	SelectClipsArgs,
	SetSpeedArgs,
	SplitAtArgs,
	ValidationFailure,
	ValidationResult,
} from "../types";
import { sec, smallSnapshot, videoClip } from "./fixtures";

function call(name: string, args: Record<string, unknown>) {
	return { id: `call-${name}`, name, args };
}

function run(
	name: string,
	args: Record<string, unknown>,
	snapshot: TimelineSnapshot = smallSnapshot(),
): ValidationResult<unknown> {
	return validateToolCall({ call: call(name, args), snapshot });
}

function expectOk<T>(result: ValidationResult<unknown>): T {
	if (!result.ok) {
		throw new Error(`expected ok, got ${result.code}: ${result.reason}`);
	}
	return result.args as T;
}

function expectFail(result: ValidationResult<unknown>): ValidationFailure {
	if (result.ok) throw new Error("expected a refusal, got ok");
	return result;
}

describe("tool schema", () => {
	test("every tool maps onto the Anthropic tools shape", () => {
		const tools = toAnthropicTools();
		expect(tools).toHaveLength(ASSISTANT_EDIT_TOOLS.length);
		for (const tool of tools) {
			expect(typeof tool.name).toBe("string");
			expect(tool.description.length).toBeGreaterThan(20);
			expect(tool.input_schema.type).toBe("object");
			expect(tool.input_schema.additionalProperties).toBe(false);
			expect(typeof tool.input_schema.properties).toBe("object");
		}
		expect(tools.map((tool) => tool.name)).toEqual(
			ASSISTANT_EDIT_TOOLS.map((tool) => tool.name),
		);
	});

	test("the tool set is exactly the eleven the roadmap specifies", () => {
		expect(ASSISTANT_EDIT_TOOLS.map((tool) => tool.name)).toEqual([
			"cut_range",
			"delete_clip",
			"extend_clip",
			"move_clip",
			"split_at",
			"set_speed",
			"add_text",
			"add_motion_template",
			"add_marker",
			"select_clips",
			"ask_user",
		]);
	});

	test("ask_user is the only non-mutating tool", () => {
		expect(MUTATING_TOOL_NAMES).not.toContain("ask_user");
		expect(MUTATING_TOOL_NAMES).toHaveLength(ASSISTANT_EDIT_TOOLS.length - 1);
		expect(findAssistantTool("ask_user")?.mutates).toBe(false);
	});

	test("the template enum matches the motion-template catalog", () => {
		const schema = findAssistantTool("add_motion_template")?.inputSchema;
		const templateId = schema?.properties.templateId as { enum?: string[] };
		expect(templateId.enum).toEqual(ASSISTANT_TEMPLATE_IDS);
		expect(templateId.enum).toContain("lower-third");
		expect(templateId.enum).not.toContain("swiss-grid-keypoint");
	});

	test("an unknown tool name is refused, not thrown", () => {
		const failure = expectFail(run("delete_everything", {}));
		expect(failure.code).toBe("unknown_tool");
	});
});

describe("cut_range", () => {
	test("accepts a frame-snapped range and defaults the scope", () => {
		const args = expectOk<CutRangeArgs>(run("cut_range", { startSec: 2, endSec: 4 }));
		expect(args).toEqual({ startSec: 2, endSec: 4, scope: "all" });
	});

	test("keeps an explicit main-only scope", () => {
		const args = expectOk<CutRangeArgs>(
			run("cut_range", { startSec: 2, endSec: 4, scope: "main" }),
		);
		expect(args.scope).toBe("main");
	});

	test("clamps a range that runs past the end of the timeline", () => {
		const args = expectOk<CutRangeArgs>(
			run("cut_range", { startSec: 14, endSec: 40 }),
		);
		expect(args.endSec).toBe(16);
	});

	test("refuses an empty range", () => {
		expect(expectFail(run("cut_range", { startSec: 4, endSec: 4 })).code).toBe(
			"empty_range",
		);
	});

	test("refuses a range that starts past the end", () => {
		expect(expectFail(run("cut_range", { startSec: 40, endSec: 44 })).code).toBe(
			"out_of_bounds",
		);
	});

	test("refuses a negative start", () => {
		expect(expectFail(run("cut_range", { startSec: -2, endSec: 4 })).code).toBe(
			"out_of_bounds",
		);
	});

	test("refuses missing arguments", () => {
		expect(expectFail(run("cut_range", {})).code).toBe("bad_argument");
	});

	test("refuses a range overlapping a protected span", () => {
		const failure = expectFail(
			run(
				"cut_range",
				{ startSec: 1, endSec: 5 },
				smallSnapshot({
					protectedSpans: [{ start: sec(2), end: sec(3), reason: "sponsor read" }],
				}),
			),
		);
		expect(failure.code).toBe("protected_span");
		expect(failure.reason).toContain("sponsor read");
	});
});

describe("delete_clip", () => {
	test("accepts a real clip id", () => {
		expect(expectOk(run("delete_clip", { clipId: "clip-intro" }))).toEqual({
			clipId: "clip-intro",
		});
	});

	test("refuses a fabricated clip id", () => {
		const failure = expectFail(run("delete_clip", { clipId: "clip-nope" }));
		expect(failure.code).toBe("unknown_clip");
		expect(failure.detail?.clipId).toBe("clip-nope");
	});

	test("refuses a clip inside a protected span", () => {
		expect(
			expectFail(
				run(
					"delete_clip",
					{ clipId: "clip-intro" },
					smallSnapshot({
						protectedSpans: [{ start: sec(1), end: sec(2), reason: "locked" }],
					}),
				),
			).code,
		).toBe("protected_span");
	});
});

describe("extend_clip", () => {
	test("accepts growth that fits the unused tail source", () => {
		const args = expectOk<ExtendClipArgs>(
			run("extend_clip", { clipId: "clip-body", edge: "end", deltaSec: 3 }),
		);
		expect(args).toEqual({ clipId: "clip-body", edge: "end", deltaSec: 3 });
	});

	test("refuses growth past the source limit and names the maximum", () => {
		const failure = expectFail(
			run("extend_clip", { clipId: "clip-body", edge: "end", deltaSec: 5 }),
		);
		expect(failure.code).toBe("source_limit");
		expect(failure.detail?.maxSec).toBe(4);
	});

	test("accepts growth into the unused head source", () => {
		const args = expectOk<ExtendClipArgs>(
			run("extend_clip", { clipId: "clip-body", edge: "start", deltaSec: 1 }),
		);
		expect(args.deltaSec).toBe(1);
	});

	test("refuses head growth past the trimmed-off head", () => {
		expect(
			expectFail(
				run("extend_clip", { clipId: "clip-body", edge: "start", deltaSec: 3 }),
			).code,
		).toBe("source_limit");
	});

	test("refuses growth blocked by the next clip", () => {
		const failure = expectFail(
			run("extend_clip", { clipId: "clip-intro", edge: "end", deltaSec: 1 }),
		);
		expect(failure.code).toBe("overlap");
	});

	test("refuses a shrink that would leave less than one frame", () => {
		expect(
			expectFail(
				run("extend_clip", { clipId: "clip-body", edge: "end", deltaSec: -20 }),
			).code,
		).toBe("min_duration");
	});

	test("refuses a delta that rounds to zero frames", () => {
		expect(
			expectFail(
				run("extend_clip", { clipId: "clip-body", edge: "end", deltaSec: 0.001 }),
			).code,
		).toBe("bad_argument");
	});

	test("refuses an unknown edge", () => {
		expect(
			expectFail(
				run("extend_clip", { clipId: "clip-body", edge: "middle", deltaSec: 1 }),
			).code,
		).toBe("bad_argument");
	});

	test("refuses an unknown clip", () => {
		expect(
			expectFail(run("extend_clip", { clipId: "ghost", edge: "end", deltaSec: 1 }))
				.code,
		).toBe("unknown_clip");
	});

	test("a retimed clip's headroom is measured in timeline seconds", () => {
		const snapshot = smallSnapshot();
		snapshot.tracks[0].clips[1] = videoClip({
			id: "clip-body",
			trackId: "track-main",
			startSec: 6,
			durationSec: 5,
			name: "body",
			trimStartSec: 2,
			trimEndSec: 4,
			sourceDurationSec: 16,
			speed: 2,
		});
		// 4s of unused tail source plays in 2s at 2x, so 2s is the ceiling.
		expect(
			expectOk<ExtendClipArgs>(
				run(
					"extend_clip",
					{ clipId: "clip-body", edge: "end", deltaSec: 2 },
					snapshot,
				),
			).deltaSec,
		).toBe(2);
		expect(
			expectFail(
				run(
					"extend_clip",
					{ clipId: "clip-body", edge: "end", deltaSec: 3 },
					snapshot,
				),
			).code,
		).toBe("source_limit");
	});
});

describe("move_clip", () => {
	test("accepts a move within the same lane", () => {
		const args = expectOk<MoveClipArgs>(
			run("move_clip", { clipId: "clip-title", toStartSec: 8 }),
		);
		expect(args).toEqual({ clipId: "clip-title", toStartSec: 8 });
	});

	test("the magnetic main track absorbs an overlapping landing", () => {
		const args = expectOk<MoveClipArgs>(
			run("move_clip", { clipId: "clip-body", toStartSec: 0 }),
		);
		expect(args.toStartSec).toBe(0);
	});

	test("with the magnet off an overlapping landing is refused", () => {
		const failure = expectFail(
			run(
				"move_clip",
				{ clipId: "clip-body", toStartSec: 0 },
				smallSnapshot({ magnetEnabled: false }),
			),
		);
		expect(failure.code).toBe("overlap");
		expect(failure.detail?.blockedBy).toBe("clip-intro");
	});

	test("refuses an incompatible lane", () => {
		const failure = expectFail(
			run("move_clip", { clipId: "clip-title", toStartSec: 0, toTrack: "A1" }),
		);
		expect(failure.code).toBe("wrong_track_type");
	});

	test("refuses a lane that does not exist", () => {
		expect(
			expectFail(
				run("move_clip", { clipId: "clip-title", toStartSec: 0, toTrack: "V9" }),
			).code,
		).toBe("unknown_track");
	});

	test("accepts a request for a brand new lane", () => {
		const args = expectOk<MoveClipArgs>(
			run("move_clip", { clipId: "clip-intro", toStartSec: 2, toTrack: "new" }),
		);
		expect(args.toNewTrack).toBe(true);
	});

	test("refuses a new lane once the video track cap is reached", () => {
		const snapshot = smallSnapshot();
		for (let index = 2; index <= 8; index += 1) {
			snapshot.tracks.push({
				id: `track-v${index}`,
				label: `V${index}`,
				type: "video",
				isMain: false,
				clips: [],
			});
		}
		const failure = expectFail(
			run(
				"move_clip",
				{ clipId: "clip-intro", toStartSec: 2, toTrack: "new" },
				snapshot,
			),
		);
		expect(failure.code).toBe("track_cap");
		expect(failure.detail?.cap).toBe(8);
	});

	test("refuses a negative start", () => {
		expect(
			expectFail(run("move_clip", { clipId: "clip-title", toStartSec: -1 })).code,
		).toBe("out_of_bounds");
	});

	test("refuses an unknown clip", () => {
		expect(
			expectFail(run("move_clip", { clipId: "ghost", toStartSec: 1 })).code,
		).toBe("unknown_clip");
	});
});

describe("split_at", () => {
	test("accepts a point inside the clip", () => {
		expect(
			expectOk<SplitAtArgs>(run("split_at", { clipId: "clip-body", atSec: 10 })),
		).toEqual({ clipId: "clip-body", atSec: 10 });
	});

	test("refuses a point outside the clip", () => {
		expect(
			expectFail(run("split_at", { clipId: "clip-body", atSec: 2 })).code,
		).toBe("out_of_bounds");
	});

	test("refuses a point that would leave a sub-frame piece", () => {
		const snapshot = smallSnapshot();
		// A clip whose start sits between frames: a frame-aligned split just after
		// it leaves less than one frame behind.
		snapshot.tracks[1].clips[0] = {
			...snapshot.tracks[1].clips[0],
			startTime: 600 as unknown as (typeof snapshot.tracks)[1]["clips"][0]["startTime"],
		};
		expect(
			expectFail(
				run("split_at", { clipId: "clip-title", atSec: 1 / 30 }, snapshot),
			).code,
		).toBe("min_duration");
	});

	test("refuses an unknown clip", () => {
		expect(expectFail(run("split_at", { clipId: "ghost", atSec: 1 })).code).toBe(
			"unknown_clip",
		);
	});
});

describe("set_speed", () => {
	test("accepts a rate inside the editor's range", () => {
		expect(
			expectOk<SetSpeedArgs>(run("set_speed", { clipId: "clip-body", rate: 2 })),
		).toEqual({ clipId: "clip-body", rate: 2, maintainPitch: false });
	});

	test("carries maintainPitch through", () => {
		expect(
			expectOk<SetSpeedArgs>(
				run("set_speed", { clipId: "clip-body", rate: 0.5, maintainPitch: true }),
			).maintainPitch,
		).toBe(true);
	});

	test("refuses a rate outside the editor's range", () => {
		const failure = expectFail(run("set_speed", { clipId: "clip-body", rate: 10 }));
		expect(failure.code).toBe("speed_range");
		expect(failure.detail?.min).toBe(MIN_RETIME_RATE);
		expect(failure.detail?.max).toBe(MAX_RETIME_RATE);
	});

	test("refuses a clip type that cannot be retimed", () => {
		expect(
			expectFail(run("set_speed", { clipId: "clip-title", rate: 2 })).code,
		).toBe("not_retimable");
	});

	test("refuses an unknown clip", () => {
		expect(expectFail(run("set_speed", { clipId: "ghost", rate: 2 })).code).toBe(
			"unknown_clip",
		);
	});
});

describe("add_text", () => {
	test("defaults the start to the playhead and the duration to five seconds", () => {
		expect(expectOk<AddTextArgs>(run("add_text", { text: "Hello" }))).toEqual({
			text: "Hello",
			atSec: 7,
			durationSec: 5,
		});
	});

	test("accepts explicit timing", () => {
		expect(
			expectOk<AddTextArgs>(
				run("add_text", { text: "Hello", atSec: 2, durationSec: 3 }),
			),
		).toEqual({ text: "Hello", atSec: 2, durationSec: 3 });
	});

	test("refuses empty text", () => {
		expect(expectFail(run("add_text", { text: "   " })).code).toBe("bad_argument");
	});

	test("refuses text past the character limit", () => {
		expect(
			expectFail(run("add_text", { text: "x".repeat(300) })).code,
		).toBe("bad_argument");
	});

	test("refuses a negative start", () => {
		expect(
			expectFail(run("add_text", { text: "Hello", atSec: -1 })).code,
		).toBe("out_of_bounds");
	});
});

describe("add_motion_template", () => {
	test("accepts a template with its declared variables", () => {
		const args = expectOk<AddMotionTemplateArgs>(
			run("add_motion_template", {
				templateId: "lower-third",
				variables: { title: "Dan", subtitle: "Director", align: "left" },
			}),
		);
		expect(args).toEqual({
			templateId: "lower-third",
			atSec: 7,
			durationSec: 4,
			variables: { title: "Dan", subtitle: "Director", align: "left" },
		});
	});

	test("drops variables the template does not declare", () => {
		const args = expectOk<AddMotionTemplateArgs>(
			run("add_motion_template", {
				templateId: "kinetic-title",
				variables: { text: "BIG", nonsense: "drop me" },
			}),
		);
		expect(args.variables).toEqual({ text: "BIG" });
	});

	test("clamps a duration outside the template's range", () => {
		const args = expectOk<AddMotionTemplateArgs>(
			run("add_motion_template", {
				templateId: "lower-third",
				durationSec: 999,
			}),
		);
		expect(args.durationSec).toBe(12);
	});

	test("refuses an unknown template and lists the real ones", () => {
		const failure = expectFail(
			run("add_motion_template", { templateId: "explode" }),
		);
		expect(failure.code).toBe("unknown_template");
		expect(failure.reason).toContain("lower-third");
	});

	test("refuses an invalid enum value", () => {
		const failure = expectFail(
			run("add_motion_template", {
				templateId: "lower-third",
				variables: { align: "middle" },
			}),
		);
		expect(failure.code).toBe("bad_argument");
		expect(failure.reason).toContain("left");
	});

	test("refuses variables that are not an object", () => {
		expect(
			expectFail(
				run("add_motion_template", {
					templateId: "lower-third",
					variables: ["nope"],
				}),
			).code,
		).toBe("bad_argument");
	});
});

describe("add_marker", () => {
	test("defaults to the playhead", () => {
		expect(expectOk<AddMarkerArgs>(run("add_marker", {}))).toEqual({ atSec: 7 });
	});

	test("keeps a short note", () => {
		expect(
			expectOk<AddMarkerArgs>(run("add_marker", { atSec: 3, note: "hook" })),
		).toEqual({ atSec: 3, note: "hook" });
	});

	test("refuses a negative time", () => {
		expect(expectFail(run("add_marker", { atSec: -3 })).code).toBe("out_of_bounds");
	});

	test("refuses an oversized note", () => {
		expect(
			expectFail(run("add_marker", { note: "x".repeat(300) })).code,
		).toBe("bad_argument");
	});
});

describe("select_clips", () => {
	test("accepts real ids and removes duplicates", () => {
		expect(
			expectOk<SelectClipsArgs>(
				run("select_clips", { clipIds: ["clip-intro", "clip-intro", "clip-body"] }),
			),
		).toEqual({ clipIds: ["clip-intro", "clip-body"] });
	});

	test("refuses an empty list", () => {
		expect(expectFail(run("select_clips", { clipIds: [] })).code).toBe(
			"bad_argument",
		);
	});

	test("refuses a fabricated id", () => {
		expect(
			expectFail(run("select_clips", { clipIds: ["clip-intro", "ghost"] })).code,
		).toBe("unknown_clip");
	});
});

describe("ask_user", () => {
	test("accepts a question with options", () => {
		expect(
			expectOk<AskUserArgs>(
				run("ask_user", {
					question: "Do you mean the intro at 0s or the body clip at 6s?",
					options: ["the intro", "the body clip", ""],
				}),
			),
		).toEqual({
			question: "Do you mean the intro at 0s or the body clip at 6s?",
			options: ["the intro", "the body clip"],
		});
	});

	test("refuses an empty question", () => {
		expect(expectFail(run("ask_user", { question: "  " })).code).toBe(
			"bad_argument",
		);
	});

	test("refuses an essay", () => {
		expect(
			expectFail(run("ask_user", { question: "x".repeat(500) })).code,
		).toBe("bad_argument");
	});
});

describe("validateTurn", () => {
	const snapshot = smallSnapshot();

	test("returns every normalized call when the whole turn is valid", () => {
		const result = validateTurn({
			calls: [
				call("delete_clip", { clipId: "clip-intro" }),
				call("add_marker", { atSec: 3, note: "here" }),
			],
			snapshot,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.calls).toHaveLength(2);
			expect(result.calls[0]).toEqual({
				id: "call-delete_clip",
				name: "delete_clip",
				args: { clipId: "clip-intro" },
			});
		}
	});

	test("stops at the first refusal so nothing gets half applied", () => {
		const result = validateTurn({
			calls: [
				call("delete_clip", { clipId: "clip-intro" }),
				call("delete_clip", { clipId: "ghost" }),
				call("add_marker", { atSec: 3 }),
			],
			snapshot,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.failure.code).toBe("unknown_clip");
			expect(result.call.args.clipId).toBe("ghost");
		}
	});
});
