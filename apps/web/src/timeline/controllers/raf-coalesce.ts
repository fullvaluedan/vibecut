/**
 * Coalesces a burst of values (e.g. raw mousemove events) down to at most one
 * `flush` per animation frame, always with the LATEST value. A drag fires
 * mousemove far faster than the display refreshes; processing every event
 * re-renders the timeline many times per frame for no visible gain. Pushing
 * through this collapses each frame to a single update with the newest coords,
 * so drag results are unchanged — only the update cadence drops.
 *
 * The scheduler is injected so the coalescer is unit-testable with a fake
 * frame clock (real usage passes requestAnimationFrame / cancelAnimationFrame).
 */
export interface FrameScheduler {
	request: (callback: () => void) => number;
	cancel: (handle: number) => void;
}

export interface RafCoalescer<T> {
	/** Record the latest value, scheduling a flush for the next frame. */
	push: (value: T) => void;
	/** Flush any pending value synchronously now and cancel the pending frame. */
	flushNow: () => void;
	/** Drop any pending value and cancel the pending frame without flushing. */
	cancel: () => void;
}

export function createRafCoalescer<T>({
	scheduler,
	flush,
}: {
	scheduler: FrameScheduler;
	flush: (value: T) => void;
}): RafCoalescer<T> {
	let latest: T | null = null;
	let hasPending = false;
	let handle: number | null = null;

	const run = (): void => {
		handle = null;
		if (!hasPending) return;
		const value = latest as T;
		hasPending = false;
		latest = null;
		flush(value);
	};

	return {
		push(value: T): void {
			latest = value;
			hasPending = true;
			if (handle === null) {
				handle = scheduler.request(run);
			}
		},
		flushNow(): void {
			if (handle !== null) {
				scheduler.cancel(handle);
				handle = null;
			}
			run();
		},
		cancel(): void {
			if (handle !== null) {
				scheduler.cancel(handle);
				handle = null;
			}
			hasPending = false;
			latest = null;
		},
	};
}
