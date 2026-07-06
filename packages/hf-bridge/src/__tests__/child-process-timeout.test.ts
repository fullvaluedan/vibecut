import { describe, expect, test } from "bun:test";
import { runNode } from "../renderer";

/**
 * P0.5: a wedged render child must not block the render queue forever — the
 * timeout kills the tree and resolves with a failing code so callers' normal
 * `code !== 0` handling fires.
 *
 * FILENAME MATTERS: this file must sort BEFORE director-vision.test.ts and
 * plan-multimodal.test.ts, both of which mock.module("node:child_process") -
 * bun module mocks leak process-wide for the rest of the run, which would
 * hand these tests a fake spawn (the known suite-pollution class).
 */
describe("runNode timeout", () => {
	test("kills a hung child and resolves code 124 with a timeout note", async () => {
		const started = Date.now();
		// A child that would sit for 100s; the 500ms timeout must reap it.
		const { code, output } = await runNode(
			["-e", "setTimeout(() => {}, 100000)"],
			process.cwd(),
			{ timeoutMs: 500 },
		);
		expect(code).toBe(124);
		expect(output).toContain("timeout");
		// Must return promptly after the kill, not after the child's 100s.
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	test("a fast child is untouched by the timeout", async () => {
		const { code } = await runNode(
			["-e", "console.log('ok')"],
			process.cwd(),
			{ timeoutMs: 30_000 },
		);
		expect(code).toBe(0);
	});
});
