import { describe, expect, test } from "bun:test";
import { enqueueRender } from "../renderer";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("enqueueRender — global render serialization", () => {
	test("tasks never overlap (one render at a time)", async () => {
		let inFlight = 0;
		let max = 0;
		const task = async () => {
			inFlight++;
			max = Math.max(max, inFlight);
			await tick();
			inFlight--;
			return "ok";
		};
		await Promise.all([
			enqueueRender(task),
			enqueueRender(task),
			enqueueRender(task),
			enqueueRender(task),
		]);
		expect(max).toBe(1);
	});

	test("a failing task rejects but never breaks the chain", async () => {
		await expect(
			enqueueRender(async () => {
				throw new Error("render boom");
			}),
		).rejects.toThrow("render boom");
		// The queue still processes the next task.
		const after = await enqueueRender(async () => "after");
		expect(after).toBe("after");
	});

	test("preserves FIFO order", async () => {
		const order: number[] = [];
		await Promise.all(
			[1, 2, 3].map((n) =>
				enqueueRender(async () => {
					await tick(2);
					order.push(n);
				}),
			),
		);
		expect(order).toEqual([1, 2, 3]);
	});
});
