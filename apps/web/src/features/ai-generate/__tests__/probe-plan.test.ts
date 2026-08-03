import { describe, expect, test } from "bun:test";
import {
	PROBE_SEC,
	probeDurationSec,
	runIdForScope,
	transcriptFingerprint,
	canStartFullRender,
} from "../probe-plan";

describe("probeDurationSec - probe duration math", () => {
	test("caps at PROBE_SEC for long chunks (the first ~3-5s)", () => {
		expect(PROBE_SEC).toBeGreaterThanOrEqual(3);
		expect(PROBE_SEC).toBeLessThanOrEqual(5);
		expect(probeDurationSec(90)).toBe(PROBE_SEC);
		expect(probeDurationSec(150)).toBe(PROBE_SEC);
	});

	test("never exceeds the chunk: short chunks probe their full length", () => {
		expect(probeDurationSec(2)).toBe(2);
		expect(probeDurationSec(PROBE_SEC)).toBe(PROBE_SEC);
	});

	test("zero/negative/garbage lengths probe nothing", () => {
		expect(probeDurationSec(0)).toBe(0);
		expect(probeDurationSec(-5)).toBe(0);
		expect(probeDurationSec(Number.NaN)).toBe(0);
	});
});

const BASE = {
	startSec: 0,
	endSec: 180,
	width: 1920,
	height: 1080,
	fps: 30,
	lookName: "Cream",
	direction: "recap the key points",
	selectionNames: ["title-card", "lower-third"],
	segments: [
		{ start: 0, end: 4.5, text: "hello world" },
		{ start: 5, end: 9, text: "second line" },
	],
};

describe("runIdForScope - run identity drives manifest reuse", () => {
	test("same inputs give the same runId (a re-run reuses rendered chunks)", () => {
		expect(runIdForScope(BASE)).toBe(runIdForScope({ ...BASE }));
		expect(runIdForScope(BASE)).toMatch(/^run-[0-9a-f]{8}$/);
	});

	test("selection ORDER does not matter", () => {
		expect(
			runIdForScope({ ...BASE, selectionNames: ["lower-third", "title-card"] }),
		).toBe(runIdForScope(BASE));
	});

	test("every brief-affecting input changes the runId", () => {
		const id = runIdForScope(BASE);
		expect(runIdForScope({ ...BASE, direction: "other" })).not.toBe(id);
		expect(runIdForScope({ ...BASE, lookName: "Ink" })).not.toBe(id);
		expect(runIdForScope({ ...BASE, endSec: 90 })).not.toBe(id);
		expect(runIdForScope({ ...BASE, fps: 60 })).not.toBe(id);
		expect(
			runIdForScope({ ...BASE, selectionNames: ["title-card"] }),
		).not.toBe(id);
		expect(
			runIdForScope({
				...BASE,
				segments: [{ start: 0, end: 4.5, text: "different speech" }],
			}),
		).not.toBe(id);
	});

	test("transcriptFingerprint reacts to text and timing", () => {
		const fp = transcriptFingerprint(BASE.segments);
		expect(fp).toMatch(/^[0-9a-f]{8}$/);
		expect(
			transcriptFingerprint([{ start: 0, end: 4.5, text: "hello world!" }]),
		).not.toBe(fp);
		expect(
			transcriptFingerprint([{ start: 1, end: 4.5, text: "hello world" }]),
		).not.toBe(fp);
	});
});

describe("canStartFullRender - the probe gate", () => {
	const probes = [{ compId: "c0" }, { compId: "c1" }];

	test("BLOCKS before approval (no full render without it)", () => {
		expect(canStartFullRender(null)).toBe(false);
		expect(canStartFullRender({ approved: false, probes })).toBe(false);
	});

	test("blocks when a probe has no comp to render from", () => {
		expect(
			canStartFullRender({ approved: true, probes: [{ compId: "c0" }, {}] }),
		).toBe(false);
		expect(canStartFullRender({ approved: true, probes: [] })).toBe(false);
	});

	test("opens only when approved and every probe is renderable", () => {
		expect(canStartFullRender({ approved: true, probes })).toBe(true);
	});
});
