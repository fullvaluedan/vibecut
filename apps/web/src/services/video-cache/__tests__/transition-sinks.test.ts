import { describe, expect, test } from "bun:test";
import type { WrappedCanvas } from "mediabunny";
import { VideoCache, type DecoderFactory } from "../service";
import {
	buildSinkKey,
	isSecondarySinkKey,
	MAX_SECONDARY_SINKS,
	mediaIdFromSinkKey,
	selectSecondarySinksToEvict,
} from "../sink-key";

const FRAME_SEC = 1 / 30;

interface DecoderStats {
	/** `canvases()` calls - one per SEEK (the expensive operation). */
	seeks: number;
	/** Generator pulls - one per decoded frame. */
	decodes: number;
	disposals: number;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A decoder stand-in: yields synthetic frames on a 30fps grid, charging a
 * configurable cost for a seek and for each decoded frame. It measures the
 * exact behaviour the transition fix targets, with no real file involved.
 */
function fakeDecoder({
	stats,
	seekMs = 0,
	decodeMs = 0,
}: {
	stats: DecoderStats;
	seekMs?: number;
	decodeMs?: number;
}): DecoderFactory {
	return async () => ({
		input: {
			dispose: () => {
				stats.disposals += 1;
			},
		},
		sink: {
			canvases: async function* (startTimestamp = 0) {
				stats.seeks += 1;
				if (seekMs > 0) await sleep(seekMs);
				let index = Math.floor(startTimestamp / FRAME_SEC);
				while (index < 100_000) {
					stats.decodes += 1;
					if (decodeMs > 0) await sleep(decodeMs);
					yield {
						canvas: { width: 2, height: 2 },
						timestamp: index * FRAME_SEC,
						duration: FRAME_SEC,
					} as unknown as WrappedCanvas;
					index += 1;
				}
			},
		},
	});
}

function file(): File {
	return new File([new Uint8Array([0])], "clip.mp4", { type: "video/mp4" });
}

/**
 * The split-then-crossfade access pattern: two clips cut from ONE file, read
 * on the same frame at two source times far enough apart that no iterator can
 * walk between them.
 */
async function runCrossfade({
	cache,
	consumerId,
	frames,
}: {
	cache: VideoCache;
	/** undefined = the pre-T19.3 behaviour (both readers share one sink). */
	consumerId?: string;
	frames: number;
}): Promise<{ leftTimes: number[]; rightTimes: number[] }> {
	const source = file();
	const leftTimes: number[] = [];
	const rightTimes: number[] = [];

	for (let index = 0; index < frames; index += 1) {
		const left = await cache.getFrameAt({
			mediaId: "m",
			file: source,
			time: 1 + index * FRAME_SEC,
		});
		const right = await cache.getFrameAt({
			mediaId: "m",
			consumerId,
			file: source,
			time: 30 + index * FRAME_SEC,
		});
		leftTimes.push(left?.timestamp ?? Number.NaN);
		rightTimes.push(right?.timestamp ?? Number.NaN);
	}

	return { leftTimes, rightTimes };
}

describe("sink keys", () => {
	test("a consumerId produces a distinct, attributable key", () => {
		expect(buildSinkKey({ mediaId: "m" })).toBe("m");
		expect(buildSinkKey({ mediaId: "m", consumerId: "clip-1" })).toBe(
			"m::clip-1",
		);
		expect(isSecondarySinkKey({ key: "m" })).toBe(false);
		expect(isSecondarySinkKey({ key: "m::clip-1" })).toBe(true);
		expect(mediaIdFromSinkKey({ key: "m::clip-1" })).toBe("m");
		expect(mediaIdFromSinkKey({ key: "m" })).toBe("m");
	});

	test("eviction drops the least-recently-used past the budget", () => {
		expect(
			selectSecondarySinksToEvict({ lruKeys: ["a", "b"], budget: 4 }),
		).toEqual([]);
		expect(
			selectSecondarySinksToEvict({
				lruKeys: ["a", "b", "c", "d", "e", "f"],
				budget: 4,
			}),
		).toEqual(["a", "b"]);
	});
});

describe("two concurrent readers of one mediaId", () => {
	test("SHARED sink: every interleaved read re-seeks (the supersede storm)", async () => {
		const stats: DecoderStats = { seeks: 0, decodes: 0, disposals: 0 };
		const cache = new VideoCache({ createDecoder: fakeDecoder({ stats }) });

		await runCrossfade({ cache, frames: 10 });

		// 10 frames x 2 readers, each one landing on a time the sink is not
		// parked at: one seek per read.
		expect(stats.seeks).toBe(20);
		expect(cache.getStats().totalSinks).toBe(1);
	});

	test("PER-CONSUMER sinks: two seeks total, and both readers get the RIGHT frame", async () => {
		const stats: DecoderStats = { seeks: 0, decodes: 0, disposals: 0 };
		const cache = new VideoCache({ createDecoder: fakeDecoder({ stats }) });

		const { leftTimes, rightTimes } = await runCrossfade({
			cache,
			consumerId: "clip-right",
			frames: 10,
		});

		expect(stats.seeks).toBe(2);
		expect(cache.getStats().totalSinks).toBe(2);
		expect(cache.getStats().secondarySinks).toBe(1);

		// Correctness, not just cost: each reader must stay on ITS OWN side of
		// the file, within a frame of what it asked for, and move forward.
		for (let index = 0; index < leftTimes.length; index += 1) {
			const requestedLeft = 1 + index * FRAME_SEC;
			const requestedRight = 30 + index * FRAME_SEC;
			expect(Math.abs(leftTimes[index] - requestedLeft)).toBeLessThanOrEqual(
				FRAME_SEC + 1e-9,
			);
			expect(Math.abs(rightTimes[index] - requestedRight)).toBeLessThanOrEqual(
				FRAME_SEC + 1e-9,
			);
			if (index > 0) {
				expect(leftTimes[index]).toBeGreaterThanOrEqual(leftTimes[index - 1]);
				expect(rightTimes[index]).toBeGreaterThanOrEqual(rightTimes[index - 1]);
			}
		}
	});

	test("SHARED sink: concurrent readers hand each other the WRONG frame", async () => {
		// The regression this fix exists for. `resolveNode` resolves the render
		// tree's children with Promise.all, so both sides of a crossfade are in
		// flight on the same tick. With one sink the second request overwrites
		// `latestSeekTime`, the first one's queued decode is superseded, and it
		// falls back to whatever frame the sink happens to be parked on.
		const source = file();
		const sharedStats: DecoderStats = { seeks: 0, decodes: 0, disposals: 0 };
		const sharedCache = new VideoCache({
			createDecoder: fakeDecoder({ stats: sharedStats }),
		});
		const [sharedLeft, sharedRight] = await Promise.all([
			sharedCache.getFrameAt({ mediaId: "m", file: source, time: 1 }),
			sharedCache.getFrameAt({ mediaId: "m", file: source, time: 30 }),
		]);
		// "Wrong" covers both failure shapes: a frame from the other side of the
		// file, and no frame at all (the superseded decode returns the sink's
		// empty cache, which the renderer draws as a dropped layer).
		const isNear = ({
			frame,
			time,
		}: {
			frame: WrappedCanvas | null;
			time: number;
		}) => frame !== null && Math.abs(frame.timestamp - time) <= FRAME_SEC + 1e-9;
		expect(
			isNear({ frame: sharedLeft, time: 1 }) &&
				isNear({ frame: sharedRight, time: 30 }),
		).toBe(false);

		const keyedStats: DecoderStats = { seeks: 0, decodes: 0, disposals: 0 };
		const keyedCache = new VideoCache({
			createDecoder: fakeDecoder({ stats: keyedStats }),
		});
		const [keyedLeft, keyedRight] = await Promise.all([
			keyedCache.getFrameAt({ mediaId: "m", file: source, time: 1 }),
			keyedCache.getFrameAt({
				mediaId: "m",
				consumerId: "clip-right",
				file: source,
				time: 30,
			}),
		]);
		expect(Math.abs((keyedLeft?.timestamp ?? 0) - 1)).toBeLessThanOrEqual(
			FRAME_SEC + 1e-9,
		);
		expect(Math.abs((keyedRight?.timestamp ?? 0) - 30)).toBeLessThanOrEqual(
			FRAME_SEC + 1e-9,
		);
	});

	test("the per-consumer sink is dramatically cheaper in wall-clock decode time", async () => {
		const sharedStats: DecoderStats = { seeks: 0, decodes: 0, disposals: 0 };
		const sharedCache = new VideoCache({
			createDecoder: fakeDecoder({ stats: sharedStats, seekMs: 8 }),
		});
		const beforeStart = performance.now();
		await runCrossfade({ cache: sharedCache, frames: 10 });
		const beforeMs = performance.now() - beforeStart;

		const keyedStats: DecoderStats = { seeks: 0, decodes: 0, disposals: 0 };
		const keyedCache = new VideoCache({
			createDecoder: fakeDecoder({ stats: keyedStats, seekMs: 8 }),
		});
		const afterStart = performance.now();
		await runCrossfade({
			cache: keyedCache,
			consumerId: "clip-right",
			frames: 10,
		});
		const afterMs = performance.now() - afterStart;

		expect(sharedStats.seeks).toBe(20);
		expect(keyedStats.seeks).toBe(2);
		// Ten times fewer seeks; assert a conservative 3x wall-clock win so the
		// test cannot flake on a busy machine.
		// Measured on this harness (8ms simulated seek, 10 crossfade frames):
		// shared sink ~306ms / 20 seeks / 50 decodes, per-consumer ~33ms /
		// 2 seeks / 22 decodes. The assertion keeps a conservative 3x margin so
		// it cannot flake on a busy machine.
		expect(afterMs * 3).toBeLessThan(beforeMs);
	});
});

describe("secondary sink budget and teardown", () => {
	test("secondary sinks never exceed the shared budget", async () => {
		const stats: DecoderStats = { seeks: 0, decodes: 0, disposals: 0 };
		const cache = new VideoCache({ createDecoder: fakeDecoder({ stats }) });
		const source = file();

		for (let index = 0; index < MAX_SECONDARY_SINKS + 3; index += 1) {
			await cache.getFrameAt({
				mediaId: "m",
				consumerId: `clip-${index}`,
				file: source,
				time: index,
			});
		}

		expect(cache.getStats().secondarySinks).toBe(MAX_SECONDARY_SINKS);
		expect(stats.disposals).toBe(3);
	});

	test("clearVideo disposes the primary sink AND every secondary of that media", async () => {
		const stats: DecoderStats = { seeks: 0, decodes: 0, disposals: 0 };
		const cache = new VideoCache({ createDecoder: fakeDecoder({ stats }) });
		const source = file();

		await cache.getFrameAt({ mediaId: "m", file: source, time: 0 });
		await cache.getFrameAt({
			mediaId: "m",
			consumerId: "clip-1",
			file: source,
			time: 5,
		});
		await cache.getFrameAt({ mediaId: "other", file: source, time: 0 });
		expect(cache.getStats().totalSinks).toBe(3);

		cache.clearVideo({ mediaId: "m" });
		expect(cache.getStats().totalSinks).toBe(1);
		expect(cache.getStats().secondarySinks).toBe(0);
		expect(stats.disposals).toBe(2);

		cache.clearAll();
		expect(cache.getStats().totalSinks).toBe(0);
	});
});
