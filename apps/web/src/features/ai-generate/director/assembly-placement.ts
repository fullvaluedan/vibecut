/**
 * Pure placement geometry for the assembled rough cut (FrameCut auto-assemble,
 * P3). Turns the planner's ordered source spans into back-to-back main-track
 * element specs: each span keeps its source in/out (trimStart/trimEnd) and lands
 * at the running sum of the prior spans' lengths. Wasm-free → bun-testable.
 */

/** One ordered span to place, in SOURCE seconds, with its clip's full length. */
export interface AssemblySpanInput {
	mediaId: string;
	name: string;
	sourceStartSec: number;
	sourceEndSec: number;
	/** Full source-clip duration (seconds) — used to derive trimEnd. */
	sourceDurationSec: number;
	isSourceAudioEnabled?: boolean;
}

/** A resolved main-track element, in integer ticks. */
export interface MainTrackElementSpec {
	mediaId: string;
	name: string;
	startTimeTicks: number;
	durationTicks: number;
	trimStartTicks: number;
	trimEndTicks: number;
	sourceDurationTicks: number;
	isSourceAudioEnabled: boolean;
}

/**
 * Lay spans back-to-back from t=0. Each element's on-timeline duration is its
 * source span length; trimStart = source in-point; trimEnd = how much of the
 * source is left after the out-point. Degenerate (zero/negative-length) spans are
 * skipped so they never become 0-duration clips. `ticksPerSecond` is injected so
 * this stays wasm-free.
 */
export function planMainTrackElements({
	spans,
	ticksPerSecond,
}: {
	spans: readonly AssemblySpanInput[];
	ticksPerSecond: number;
}): MainTrackElementSpec[] {
	const specs: MainTrackElementSpec[] = [];
	let cursorTicks = 0;
	for (const span of spans) {
		const sourceStartTicks = Math.max(
			0,
			Math.round(span.sourceStartSec * ticksPerSecond),
		);
		const sourceEndTicks = Math.round(span.sourceEndSec * ticksPerSecond);
		const sourceDurationTicks = Math.max(
			0,
			Math.round(span.sourceDurationSec * ticksPerSecond),
		);
		const durationTicks = sourceEndTicks - sourceStartTicks;
		if (durationTicks <= 0) continue; // skip a degenerate span

		specs.push({
			mediaId: span.mediaId,
			name: span.name,
			startTimeTicks: cursorTicks,
			durationTicks,
			trimStartTicks: sourceStartTicks,
			trimEndTicks: Math.max(0, sourceDurationTicks - sourceEndTicks),
			sourceDurationTicks,
			isSourceAudioEnabled: span.isSourceAudioEnabled ?? true,
		});
		cursorTicks += durationTicks;
	}
	return specs;
}
