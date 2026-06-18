import { afterEach, describe, expect, mock, test } from "bun:test";

// The claude-code degrade path spawns the `claude` CLI; stub node:child_process
// before importing the module (mirrors plan-multimodal.test.ts).
type FakeChild = {
	stdout: { on: (ev: string, cb: (d: Buffer) => void) => void };
	stderr: { on: (ev: string, cb: (d: Buffer) => void) => void };
	stdin: { write: (s: string) => void; end: () => void };
	on: (ev: string, cb: (code: number) => void) => void;
};
let fakeSpawn: () => FakeChild = () => {
	throw new Error("fakeSpawn not configured for this test");
};
mock.module("node:child_process", () => ({ spawn: () => fakeSpawn() }));

const {
	buildDirectorVisionPrompt,
	buildDirectorVisionBlocks,
	buildDirectorPrompt,
	planDirectorVision,
} = await import("../author");
import type { DirectorSegment, DirectorVisionFrame } from "../author";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function jsonResponse(obj: unknown, status = 200): Response {
	return new Response(JSON.stringify(obj), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const seg = (
	overrides: Partial<DirectorSegment> &
		Pick<DirectorSegment, "startSec" | "endSec" | "text">,
): DirectorSegment => overrides;

const SEGMENTS: DirectorSegment[] = [
	seg({ startSec: 0, endSec: 2, text: "intro line", wpm: 130 }),
	seg({ startSec: 2, endSec: 4, text: "middle line", wpm: 120 }),
	seg({ startSec: 4, endSec: 6, text: "closing line", wpm: 110 }),
];

const FRAMES: DirectorVisionFrame[] = [
	{ segmentIndex: 0, mediaType: "image/jpeg", dataBase64: "FRAME0" },
	{ segmentIndex: 2, mediaType: "image/jpeg", dataBase64: "FRAME2" },
];

describe("buildDirectorVisionPrompt", () => {
	test("extends the base prompt with a VISION addendum + per-frame time map", () => {
		const prompt = buildDirectorVisionPrompt({
			segments: SEGMENTS,
			totalSec: 6,
			frames: FRAMES,
		});
		// Carries the whole text-only prompt...
		expect(prompt).toContain("SIGNAL TABLE:");
		expect(prompt).toContain("take_select");
		// ...plus the vision layer mapping each frame to its segment's time range.
		expect(prompt).toContain("VISION:");
		expect(prompt).toContain("Frame 1: the segment at 0.0-2.0s");
		expect(prompt).toContain("Frame 2: the segment at 4.0-6.0s");
		expect(prompt).toContain("off-screen");
	});

	test("with no frames it is exactly the text-only prompt (no regression)", () => {
		const base = buildDirectorPrompt({ segments: SEGMENTS, totalSec: 6 });
		const visionEmpty = buildDirectorVisionPrompt({
			segments: SEGMENTS,
			totalSec: 6,
			frames: [],
		});
		expect(visionEmpty).toBe(base);
	});
});

describe("buildDirectorVisionBlocks", () => {
	test("emits the frames as image blocks in order, then one trailing text block", () => {
		const blocks = buildDirectorVisionBlocks({
			segments: SEGMENTS,
			totalSec: 6,
			frames: FRAMES,
		});
		expect(blocks).toHaveLength(3); // 2 images + 1 text
		expect(blocks[0]).toEqual({
			type: "image",
			mediaType: "image/jpeg",
			dataBase64: "FRAME0",
		});
		expect(blocks[1]).toEqual({
			type: "image",
			mediaType: "image/jpeg",
			dataBase64: "FRAME2",
		});
		expect(blocks[2].type).toBe("text");
	});
});

describe("planDirectorVision — api-key (vision capable)", () => {
	test("sends the frames, returns a sanitized plan, not degraded", async () => {
		let body: Record<string, unknown> = {};
		globalThis.fetch = (async (_url: string, opts: { body: string }) => {
			body = JSON.parse(opts.body);
			return jsonResponse({
				content: [
					{
						type: "text",
						text: JSON.stringify({
							operations: [
								{
									op: "cut",
									startSec: 4,
									endSec: 6,
									reason: "speaker off-screen",
									confidence: 0.8,
								},
							],
						}),
					},
				],
				usage: { input_tokens: 50, output_tokens: 10 },
			});
		}) as unknown as typeof fetch;

		const res = await planDirectorVision({
			segments: SEGMENTS,
			totalSec: 6,
			frames: FRAMES,
			auth: { mode: "api-key", apiKey: "sk-test" },
		});

		expect(res.degraded).toBe(false);
		expect(res.plan.operations).toHaveLength(1);
		expect(res.plan.operations[0].op).toBe("cut");
		expect(res.plan.operations[0].id).toMatch(/^op_/); // sanitizer assigned an id
		expect(res.usage).toEqual({ inputTokens: 50, outputTokens: 10 });
		// Frames actually rode along, images first; strong vision model by default.
		const content = (body.messages as { content: { type: string }[] }[])[0]
			.content;
		expect(content[0].type).toBe("image");
		expect(content[content.length - 1].type).toBe("text");
		expect(body.model).toBe("claude-opus-4-8");
	});
});

describe("planDirectorVision — claude-code (degrades to text)", () => {
	test("a vision-incapable backend yields a valid plan flagged degraded (R3)", async () => {
		fakeSpawn = () => ({
			stdout: {
				on: (ev: string, cb: (d: Buffer) => void) => {
					if (ev === "data") {
						queueMicrotask(() =>
							cb(
								Buffer.from(
									JSON.stringify({
										result: JSON.stringify({
											operations: [
												{
													op: "cut",
													startSec: 2,
													endSec: 4,
													reason: "filler",
													confidence: 0.6,
												},
											],
										}),
										usage: { input_tokens: 20, output_tokens: 5 },
									}),
								),
							),
						);
					}
				},
			},
			stderr: { on: () => {} },
			stdin: { write: () => {}, end: () => {} },
			on: (ev: string, cb: (code: number) => void) => {
				if (ev === "close") queueMicrotask(() => cb(0));
			},
		});

		const res = await planDirectorVision({
			segments: SEGMENTS,
			totalSec: 6,
			frames: FRAMES,
			auth: { mode: "claude-code" },
		});

		expect(res.degraded).toBe(true);
		expect(res.plan.operations).toHaveLength(1);
		expect(res.plan.operations[0].op).toBe("cut");
	});
});
