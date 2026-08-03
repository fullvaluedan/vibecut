/**
 * Pure probe-stage math + run identity for the authored HyperFrames engine
 * (probe-render-first hard rule): how long a chunk's probe is, which run a
 * scope maps to (drives manifest reuse), and the gate that BLOCKS the full
 * render until the probe set is approved. No editor/fetch deps, so the rules
 * are unit-testable apart from the run loop (mirrors chunk-plan.ts).
 */

/** Probe length cap: the first ~3-5s of each chunk is enough to judge the look. */
export const PROBE_SEC = 4;

/**
 * Seconds of a chunk to probe-render. Never longer than the chunk itself - a
 * chunk shorter than PROBE_SEC probes its full length (the probe then IS the
 * full render's opening, and the full render is cheap anyway).
 */
export function probeDurationSec(chunkLenSec: number): number {
	if (!Number.isFinite(chunkLenSec) || chunkLenSec <= 0) return 0;
	return Math.min(chunkLenSec, PROBE_SEC);
}

/** FNV-1a 32-bit, hex - a stable, dependency-free id hash. */
function fnv1a(input: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * A light fingerprint of the run's transcript: text + rough timing, so an edit
 * that changes WHAT is said (or a re-transcription) yields a different runId
 * and stale renders are never reused against new speech.
 */
export function transcriptFingerprint(
	segments: { start: number; end: number; text: string }[],
): string {
	return fnv1a(
		segments
			.map((s) => `${s.start.toFixed(1)}:${s.end.toFixed(1)}:${s.text}`)
			.join("|"),
	);
}

/**
 * The run identity. Everything that changes the authored output is in the key:
 * scope geometry, canvas, look, direction, selected assets, and the transcript.
 * Same inputs → same runId → a re-run reuses the manifest's rendered chunks;
 * any change → a fresh run that probes + asks for approval again.
 */
export function runIdForScope({
	startSec,
	endSec,
	width,
	height,
	fps,
	lookName,
	direction,
	selectionNames,
	segments,
}: {
	startSec: number;
	endSec: number;
	width: number;
	height: number;
	fps: number;
	lookName: string;
	direction: string;
	selectionNames: string[];
	segments: { start: number; end: number; text: string }[];
}): string {
	const key = JSON.stringify([
		startSec.toFixed(2),
		endSec.toFixed(2),
		width,
		height,
		fps,
		lookName,
		direction,
		[...selectionNames].sort(),
		transcriptFingerprint(segments),
	]);
	return `run-${fnv1a(key)}`;
}

/**
 * THE PROBE GATE: the full render may start only when the run's probe set
 * exists, is approved, and every probe has a comp to render from. Approval
 * lives on the persisted draft (the variant-picker store keeps it across a
 * dialog close), so closing the review never forces a re-probe.
 */
export function canStartFullRender(
	probeSet: { approved: boolean; probes: { compId?: string }[] } | null,
): boolean {
	return (
		!!probeSet &&
		probeSet.approved &&
		probeSet.probes.length > 0 &&
		probeSet.probes.every((p) => !!p.compId)
	);
}
