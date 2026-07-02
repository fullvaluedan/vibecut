import { describe, expect, test } from "bun:test";
import {
	createRafCoalescer,
	type FrameScheduler,
} from "@/timeline/controllers/raf-coalesce";

/** A fake frame clock: request() queues one callback; tick() runs the queue. */
function fakeScheduler() {
	let nextHandle = 1;
	const queued = new Map<number, () => void>();
	const scheduler: FrameScheduler = {
		request(callback) {
			const handle = nextHandle++;
			queued.set(handle, callback);
			return handle;
		},
		cancel(handle) {
			queued.delete(handle);
		},
	};
	return {
		scheduler,
		tick() {
			const callbacks = [...queued.values()];
			queued.clear();
			for (const cb of callbacks) cb();
		},
		pending: () => queued.size,
	};
}

describe("createRafCoalescer", () => {
	test("10 events in one frame flush once with the last value", () => {
		const clock = fakeScheduler();
		const flushed: number[] = [];
		const coalescer = createRafCoalescer<{ x: number }>({
			scheduler: clock.scheduler,
			flush: (v) => flushed.push(v.x),
		});

		for (let i = 0; i < 10; i++) coalescer.push({ x: i });
		expect(clock.pending()).toBe(1); // only one frame requested
		expect(flushed).toEqual([]); // nothing flushed until the frame fires

		clock.tick();
		expect(flushed).toEqual([9]); // exactly one flush, with the last coords
	});

	test("a new frame is scheduled for the next burst", () => {
		const clock = fakeScheduler();
		const flushed: number[] = [];
		const coalescer = createRafCoalescer<number>({
			scheduler: clock.scheduler,
			flush: (v) => flushed.push(v),
		});

		coalescer.push(1);
		clock.tick();
		coalescer.push(2);
		coalescer.push(3);
		clock.tick();
		expect(flushed).toEqual([1, 3]);
	});

	test("flushNow applies the pending value synchronously and cancels the frame", () => {
		const clock = fakeScheduler();
		const flushed: number[] = [];
		const coalescer = createRafCoalescer<number>({
			scheduler: clock.scheduler,
			flush: (v) => flushed.push(v),
		});

		coalescer.push(5);
		coalescer.push(7);
		coalescer.flushNow();
		expect(flushed).toEqual([7]);
		expect(clock.pending()).toBe(0); // frame was cancelled

		clock.tick();
		expect(flushed).toEqual([7]); // no double flush
	});

	test("flushNow with nothing pending is a no-op", () => {
		const clock = fakeScheduler();
		const flushed: number[] = [];
		const coalescer = createRafCoalescer<number>({
			scheduler: clock.scheduler,
			flush: (v) => flushed.push(v),
		});
		coalescer.flushNow();
		expect(flushed).toEqual([]);
	});

	test("cancel drops the pending value without flushing", () => {
		const clock = fakeScheduler();
		const flushed: number[] = [];
		const coalescer = createRafCoalescer<number>({
			scheduler: clock.scheduler,
			flush: (v) => flushed.push(v),
		});

		coalescer.push(9);
		coalescer.cancel();
		clock.tick();
		expect(flushed).toEqual([]);
		expect(clock.pending()).toBe(0);
	});
});
