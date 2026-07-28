import { describe, expect, test } from "bun:test";
import {
	AUX_PASS_TIMEOUT_MS,
	composePassSignal,
	isTimeoutAbort,
	PLAN_PASS_TIMEOUT_MS,
} from "../pass-timeout";

describe("composePassSignal (round 12 U3/R4)", () => {
	test("aborts when the run's cancel signal aborts", () => {
		const controller = new AbortController();
		const composed = composePassSignal({
			cancel: controller.signal,
			timeoutMs: 60_000,
		});
		expect(composed.aborted).toBe(false);
		controller.abort();
		expect(composed.aborted).toBe(true);
	});

	test("aborts on its own after timeoutMs, with a TimeoutError reason", async () => {
		const composed = composePassSignal({
			cancel: new AbortController().signal,
			timeoutMs: 5,
		});
		expect(composed.aborted).toBe(false);
		await new Promise((r) => setTimeout(r, 50));
		expect(composed.aborted).toBe(true);
		expect(isTimeoutAbort(composed.reason)).toBe(true);
	});

	test("stands alone without a cancel signal (the eval / tests pass none)", async () => {
		const composed = composePassSignal({ timeoutMs: 5 });
		await new Promise((r) => setTimeout(r, 50));
		expect(composed.aborted).toBe(true);
		expect(isTimeoutAbort(composed.reason)).toBe(true);
	});

	test("a user cancel is NOT a timeout abort (it must still read as 'stopped')", () => {
		const controller = new AbortController();
		const composed = composePassSignal({
			cancel: controller.signal,
			timeoutMs: 60_000,
		});
		controller.abort();
		expect(isTimeoutAbort(composed.reason)).toBe(false);
	});

	test("isTimeoutAbort rejects plain errors and non-errors", () => {
		expect(isTimeoutAbort(new Error("TimeoutError"))).toBe(false);
		expect(isTimeoutAbort("TimeoutError")).toBe(false);
		expect(isTimeoutAbort(undefined)).toBe(false);
	});

	test("the plan pass gets the longer leash", () => {
		expect(PLAN_PASS_TIMEOUT_MS).toBe(300_000);
		expect(AUX_PASS_TIMEOUT_MS).toBe(180_000);
		expect(PLAN_PASS_TIMEOUT_MS).toBeGreaterThan(AUX_PASS_TIMEOUT_MS);
	});
});
