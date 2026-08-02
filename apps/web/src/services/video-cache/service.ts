import {
	Input,
	ALL_FORMATS,
	BlobSource,
	CanvasSink,
	type WrappedCanvas,
} from "mediabunny";
import { isSeekSuperseded } from "./seek-supersede";
import {
	buildSinkKey,
	isSecondarySinkKey,
	mediaIdFromSinkKey,
	selectSecondarySinksToEvict,
} from "./sink-key";

/**
 * T19.3: the cache only ever calls `dispose()` on the input and `canvases()`
 * on the sink, so those two members are typed STRUCTURALLY. mediabunny's
 * `Input`/`CanvasSink` satisfy them unchanged, and a unit test can inject a
 * fake decoder to exercise the concurrency rules without a real file.
 */
export interface DecodeInputHandle {
	dispose(): void;
}

export interface DecodeSinkHandle {
	canvases(
		startTimestamp?: number,
	): AsyncGenerator<WrappedCanvas, void, unknown>;
}

interface VideoSinkData {
	input: DecodeInputHandle;
	sink: DecodeSinkHandle;
	iterator: AsyncGenerator<WrappedCanvas, void, unknown> | null;
	currentFrame: WrappedCanvas | null;
	nextFrame: WrappedCanvas | null;
	lastTime: number;
	prefetching: boolean;
	prefetchPromise: Promise<void> | null;
}

export type DecoderFactory = (args: {
	mediaId: string;
	file: File;
}) => Promise<{ input: DecodeInputHandle; sink: DecodeSinkHandle }>;

export class VideoCache {
	// Keyed by SINK KEY, not mediaId: `mediaId` for the shared/primary sink,
	// `mediaId::consumerId` for a clip that asked for its own (T19.3).
	private sinks = new Map<string, VideoSinkData>();
	private initPromises = new Map<string, Promise<void>>();
	private frameChain = new Map<string, Promise<unknown>>();
	// Secondary sink keys, least-recently-used first. Bounds the extra decode
	// memory transitions can create (see sink-key.ts).
	private secondaryLru: string[] = [];
	private readonly createDecoder: DecoderFactory;

	constructor(options?: { createDecoder?: DecoderFactory }) {
		this.createDecoder = options?.createDecoder ?? createMediabunnyDecoder;
	}
	// Latest requested frame time per mediaId. A queued decode is superseded only
	// when a DIFFERENT time has since been requested — not by same-time RAF repeats
	// (the count-based supersession this replaced let those repeats cancel a slow
	// deep-seek forever, freezing the preview on the first frame of a long source).
	private latestSeekTime = new Map<string, number>();
	// Negative cache: mediaIds whose codec can't be decoded. Without this every
	// getFrameAt re-creates the mediabunny Input, re-throws, and the preview
	// re-probes an undecodable clip on every frame.
	private undecodableMediaIds = new Set<string>();

	async getFrameAt({
		mediaId,
		consumerId,
		file,
		time,
	}: {
		mediaId: string;
		/**
		 * T19.3: ask for a sink of this consumer's own instead of the shared
		 * per-mediaId one. Passed only by clips that provably need it (the right
		 * side of a same-source crossDissolve); every other call site is
		 * unchanged and keeps sharing one sink per file.
		 */
		consumerId?: string;
		file: File;
		time: number;
	}): Promise<WrappedCanvas | null> {
		if (this.undecodableMediaIds.has(mediaId)) return null;

		const sinkKey = buildSinkKey({ mediaId, consumerId });
		await this.ensureSink({ mediaId, sinkKey, file });

		const sinkData = this.sinks.get(sinkKey);
		if (!sinkData) return null;
		this.touchSecondary({ sinkKey });

		// Fast path: the already-decoded frame still covers this time → return it
		// synchronously without touching the async decode chain. The preview RAF
		// loop re-requests the current frame every tick (×N video nodes with an
		// overlay + PIP); running resolveFrame each time was needless per-frame
		// churn that made playback/scrubbing lag.
		if (
			sinkData.currentFrame &&
			this.isFrameValid({ frame: sinkData.currentFrame, time })
		) {
			return sinkData.currentFrame;
		}

		this.latestSeekTime.set(sinkKey, time);

		const previous = this.frameChain.get(sinkKey) ?? Promise.resolve();
		const current = previous.then(() => {
			// Skip only if a DIFFERENT time was requested since this one was queued.
			// Same-time repeats from the RAF loop fall through so a slow deep seek
			// completes and updates currentFrame instead of being cancelled forever.
			// Supersession is per SINK KEY, so two clips of one file that own
			// separate sinks can no longer cancel each other (T19.3).
			if (
				isSeekSuperseded({
					requestedTime: time,
					latestTime: this.latestSeekTime.get(sinkKey),
				})
			) {
				return sinkData.currentFrame ?? null;
			}
			return this.resolveFrame({ sinkData, time });
		});
		this.frameChain.set(
			sinkKey,
			current.catch(() => {}),
		);
		return current;
	}

	/**
	 * Best-effort, lowest-priority warm of a frame the playhead is about to cross
	 * into (U8 boundary prefetch). It routes through the SAME `getFrameAt` path,
	 * so the supersede-by-time guarantee (KTD3 / commit 68ba04c7) is preserved
	 * unchanged: a newer DISTINCT seek on this mediaId (a real user scrub) still
	 * wins and is never starved by this prefetch, because the queued prefetch
	 * decode bails the moment a different latest time is recorded (see
	 * `isSeekSuperseded`). The decoded frame is intentionally discarded here; it
	 * lands in the sink cache for the crossing and stays evictable by the normal
	 * cache policy if the crossing never happens (playback paused / seeked away).
	 */
	prefetchFrameAt({
		mediaId,
		consumerId,
		file,
		time,
	}: {
		mediaId: string;
		consumerId?: string;
		file: File;
		time: number;
	}): void {
		void this.getFrameAt({ mediaId, consumerId, file, time }).catch(() => {});
	}

	private async resolveFrame({
		sinkData,
		time,
	}: {
		sinkData: VideoSinkData;
		time: number;
	}): Promise<WrappedCanvas | null> {
		if (sinkData.nextFrame && sinkData.nextFrame.timestamp <= time) {
			sinkData.currentFrame = sinkData.nextFrame;
			sinkData.nextFrame = null;
			this.startPrefetch({ sinkData });
		}

		if (
			sinkData.currentFrame &&
			this.isFrameValid({ frame: sinkData.currentFrame, time })
		) {
			if (!sinkData.nextFrame && !sinkData.prefetching) {
				this.startPrefetch({ sinkData });
			}
			return sinkData.currentFrame;
		}

		if (
			sinkData.iterator &&
			sinkData.currentFrame &&
			time >= sinkData.lastTime &&
			time < sinkData.lastTime + 2.0
		) {
			const frame = await this.iterateToTime({ sinkData, targetTime: time });
			if (frame) {
				if (!sinkData.nextFrame && !sinkData.prefetching) {
					this.startPrefetch({ sinkData });
				}
				return frame;
			}
		}

		const frame = await this.seekToTime({ sinkData, time });
		if (frame && !sinkData.nextFrame && !sinkData.prefetching) {
			this.startPrefetch({ sinkData });
		}
		return frame;
	}

	private isFrameValid({
		frame,
		time,
	}: {
		frame: WrappedCanvas;
		time: number;
	}): boolean {
		return time >= frame.timestamp && time < frame.timestamp + frame.duration;
	}
	private async iterateToTime({
		sinkData,
		targetTime,
	}: {
		sinkData: VideoSinkData;
		targetTime: number;
	}): Promise<WrappedCanvas | null> {
		if (!sinkData.iterator) return null;

		try {
			while (true) {
				// Wait for any pending prefetch to finish before touching iterator
				if (sinkData.prefetching && sinkData.prefetchPromise) {
					await sinkData.prefetchPromise;
				}

				// Check if the nextFrame (which might have just arrived) is what we need
				if (
					sinkData.nextFrame &&
					sinkData.nextFrame.timestamp <= targetTime + 0.05 // Tolerance
				) {
					sinkData.currentFrame = sinkData.nextFrame;
					sinkData.nextFrame = null;
				} else {
					const { value: frame, done } = await sinkData.iterator.next();

					if (done || !frame) break;

					sinkData.currentFrame = frame;
				}

				const frame = sinkData.currentFrame;
				if (!frame) break;

				sinkData.lastTime = frame.timestamp;

				if (this.isFrameValid({ frame, time: targetTime })) {
					return frame;
				}

				if (frame.timestamp > targetTime + 1.0) break;
			}
		} catch (error) {
			console.warn("Iterator failed, will restart:", error);
			sinkData.iterator = null;
		}

		return null;
	}
	private async seekToTime({
		sinkData,
		time,
	}: {
		sinkData: VideoSinkData;
		time: number;
	}): Promise<WrappedCanvas | null> {
		try {
			if (sinkData.prefetching && sinkData.prefetchPromise) {
				await sinkData.prefetchPromise;
			}

			if (sinkData.iterator) {
				await sinkData.iterator.return();
				sinkData.iterator = null;
			}

			sinkData.nextFrame = null;
			sinkData.iterator = sinkData.sink.canvases(time);
			sinkData.lastTime = time;

			// Fetch current frame
			const { value: frame } = await sinkData.iterator.next();

			if (frame) {
				sinkData.currentFrame = frame;
				this.startPrefetch({ sinkData });
				return frame;
			}
		} catch (error) {
			console.warn("Failed to seek video:", error);
		}

		return null;
	}

	private startPrefetch({ sinkData }: { sinkData: VideoSinkData }): void {
		if (sinkData.prefetching || !sinkData.iterator || sinkData.nextFrame) {
			return;
		}

		sinkData.prefetching = true;
		sinkData.prefetchPromise = this.prefetchNextFrame({ sinkData });
	}

	private async prefetchNextFrame({
		sinkData,
	}: {
		sinkData: VideoSinkData;
	}): Promise<void> {
		if (!sinkData.iterator) {
			sinkData.prefetching = false;
			sinkData.prefetchPromise = null;
			return;
		}

		try {
			const { value: frame, done } = await sinkData.iterator.next();

			if (done || !frame) {
				sinkData.prefetching = false;
				sinkData.prefetchPromise = null;
				return;
			}

			sinkData.nextFrame = frame;
			sinkData.prefetching = false;
			sinkData.prefetchPromise = null;
		} catch (error) {
			console.warn("Prefetch failed:", error);
			sinkData.prefetching = false;
			sinkData.prefetchPromise = null;
			sinkData.iterator = null;
		}
	}
	/** Mark a secondary sink as most-recently-used and evict past the budget. */
	private touchSecondary({ sinkKey }: { sinkKey: string }): void {
		if (!isSecondarySinkKey({ key: sinkKey })) return;

		const existing = this.secondaryLru.indexOf(sinkKey);
		if (existing !== -1) {
			this.secondaryLru.splice(existing, 1);
		}
		this.secondaryLru.push(sinkKey);

		for (const victim of selectSecondarySinksToEvict({
			lruKeys: this.secondaryLru,
		})) {
			this.disposeSink({ sinkKey: victim });
		}
	}

	private disposeSink({ sinkKey }: { sinkKey: string }): void {
		const sinkData = this.sinks.get(sinkKey);
		if (sinkData) {
			if (sinkData.iterator) {
				void sinkData.iterator.return();
			}
			sinkData.input.dispose();
			this.sinks.delete(sinkKey);
		}

		this.initPromises.delete(sinkKey);
		this.frameChain.delete(sinkKey);
		this.latestSeekTime.delete(sinkKey);

		const lruIndex = this.secondaryLru.indexOf(sinkKey);
		if (lruIndex !== -1) {
			this.secondaryLru.splice(lruIndex, 1);
		}
	}

	private async ensureSink({
		mediaId,
		sinkKey,
		file,
	}: {
		mediaId: string;
		sinkKey: string;
		file: File;
	}): Promise<void> {
		if (this.undecodableMediaIds.has(mediaId)) return;
		if (this.sinks.has(sinkKey)) return;

		if (this.initPromises.has(sinkKey)) {
			await this.initPromises.get(sinkKey);
			return;
		}

		const initPromise = this.initializeSink({ mediaId, sinkKey, file });
		this.initPromises.set(sinkKey, initPromise);

		try {
			await initPromise;
		} catch {
			// initializeSink already logged. Record the failure so we stop
			// re-creating the Input and re-throwing on every subsequent frame.
			// Undecodability is a property of the FILE, so it is tracked per
			// mediaId and short-circuits every sink key for it.
			this.undecodableMediaIds.add(mediaId);
		} finally {
			this.initPromises.delete(sinkKey);
		}
	}
	private async initializeSink({
		mediaId,
		sinkKey,
		file,
	}: {
		mediaId: string;
		sinkKey: string;
		file: File;
	}): Promise<void> {
		const { input, sink } = await this.createDecoder({ mediaId, file });

		this.sinks.set(sinkKey, {
			input,
			sink,
			iterator: null,
			currentFrame: null,
			nextFrame: null,
			lastTime: -1,
			prefetching: false,
			prefetchPromise: null,
		});
	}

	clearVideo({ mediaId }: { mediaId: string }): void {
		// One mediaId can own a primary sink plus any number of secondary ones.
		for (const sinkKey of [...this.sinks.keys(), ...this.initPromises.keys()]) {
			if (mediaIdFromSinkKey({ key: sinkKey }) !== mediaId) continue;
			this.disposeSink({ sinkKey });
		}

		this.disposeSink({ sinkKey: mediaId });
		this.undecodableMediaIds.delete(mediaId);
	}

	clearAll(): void {
		for (const sinkKey of [...this.sinks.keys()]) {
			this.clearVideo({ mediaId: mediaIdFromSinkKey({ key: sinkKey }) });
		}
	}

	getStats() {
		return {
			totalSinks: this.sinks.size,
			secondarySinks: Array.from(this.sinks.keys()).filter((key) =>
				isSecondarySinkKey({ key }),
			).length,
			activeSinks: Array.from(this.sinks.values()).filter((s) => s.iterator)
				.length,
			cachedFrames: Array.from(this.sinks.values()).filter(
				(s) => s.currentFrame,
			).length,
		};
	}
}

const createMediabunnyDecoder: DecoderFactory = async ({ mediaId, file }) => {
	const input = new Input({
		source: new BlobSource(file),
		formats: ALL_FORMATS,
	});

	try {
		const videoTrack = await input.getPrimaryVideoTrack();
		if (!videoTrack) {
			throw new Error("No video track found");
		}

		const canDecode = await videoTrack.canDecode();
		if (!canDecode) {
			throw new Error("Video codec not supported for decoding");
		}

		return {
			input,
			sink: new CanvasSink(videoTrack, {
				poolSize: 3,
				fit: "contain",
			}),
		};
	} catch (error) {
		input.dispose();
		console.error(`Failed to initialize video sink for ${mediaId}:`, error);
		throw error;
	}
};

export const videoCache = new VideoCache();
