import { describe, expect, test } from "bun:test";
import { runWithConcurrency } from "../concurrency";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("runWithConcurrency", () => {
	test("never exceeds the limit, but does parallelize", async () => {
		let inFlight = 0;
		let max = 0;
		await runWithConcurrency(
			Array.from({ length: 10 }, (_, i) => i),
			3,
			async () => {
				inFlight++;
				max = Math.max(max, inFlight);
				await tick();
				inFlight--;
			},
		);
		expect(max).toBeLessThanOrEqual(3);
		expect(max).toBeGreaterThan(1);
	});

	test("limit of 1 fully serializes", async () => {
		let inFlight = 0;
		let max = 0;
		await runWithConcurrency([1, 2, 3, 4], 1, async () => {
			inFlight++;
			max = Math.max(max, inFlight);
			await tick(3);
			inFlight--;
		});
		expect(max).toBe(1);
	});

	test("runs each item exactly once", async () => {
		const items = ["a", "b", "c", "d", "e"];
		const seen: string[] = [];
		await runWithConcurrency(items, 2, async (it) => {
			await tick(1);
			seen.push(it);
		});
		expect(seen.sort()).toEqual([...items].sort());
	});

	test("a worker throw rejects the whole run", async () => {
		await expect(
			runWithConcurrency([1, 2, 3], 2, async (n) => {
				if (n === 2) throw new Error("boom");
			}),
		).rejects.toThrow("boom");
	});

	test("empty input resolves immediately", async () => {
		const seen: number[] = [];
		await runWithConcurrency([], 4, async (n: number) => {
			seen.push(n);
		});
		expect(seen).toEqual([]);
	});
});
