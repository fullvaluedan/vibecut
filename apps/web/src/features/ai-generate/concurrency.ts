/**
 * Bounded-concurrency runner — process `items` with at most `limit` workers
 * in flight. Dependency-free. Used to fan out HyperFrames author calls (the
 * Claude side) without stacking them; the LOCAL render step is serialized
 * separately by the render queue in the bridge, so this only bounds the
 * network/model side.
 *
 * A worker that throws rejects the whole run (used to surface a hard
 * "Cancelled"); callers that want per-item tolerance catch inside the worker.
 */
export async function runWithConcurrency<T>(
	items: T[],
	limit: number,
	worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
	const max = Math.max(1, Math.floor(limit));
	let next = 0;
	const runners = Array.from({ length: Math.min(max, items.length) }, async () => {
		while (true) {
			const i = next++;
			if (i >= items.length) return;
			await worker(items[i], i);
		}
	});
	await Promise.all(runners);
}
