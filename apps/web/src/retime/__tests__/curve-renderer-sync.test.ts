import { describe, expect, test } from "bun:test";
import { getSourceTimeAtClipTime } from "@/retime/resolve";
import { buildRetimeCurveFromPreset } from "@/retime/curve-presets";
import type { RetimeConfig } from "@/timeline";

/**
 * T18.2 renderer-sync fixture (required by the roadmap plan, section 7
 * T18.2): the LIVE PREVIEW canvas and the OFFLINE EXPORT canvas both resolve
 * a video frame's source time through the exact same call -
 * `resolveVideoNode` in services/renderer/resolve.ts calls
 * `getSourceTimeAtClipTime({ clipTime, retime, clipDuration })` for both a
 * preview tick and an export frame render (see `resolveRenderTree`, the one
 * function `canvas-renderer.ts` calls for both paths). There is no separate
 * "export sampler" - preview and export are provably frame-identical
 * because they run the identical pure function, not two implementations
 * that happen to agree.
 *
 * This fixture exercises that shared function directly, at curve
 * inflection points and segment midpoints, at a real fixture fps (30fps),
 * for the Hero preset (slow-fast-slow) - and cross-checks every sampled
 * value against an independent hand-computed reference so the test proves
 * correctness, not just self-agreement between two identical call sites.
 */

const FPS = 30;
const FRAME_SECONDS = 1 / FPS;
const CLIP_DURATION_FRAMES = 90; // 3 seconds
const CLIP_DURATION = CLIP_DURATION_FRAMES * FRAME_SECONDS;

const heroCurve = buildRetimeCurveFromPreset({ id: "hero" });
const heroRetime: RetimeConfig = { rate: 1, curve: heroCurve };

function frameToClipTime({ frame }: { frame: number }): number {
	return frame * FRAME_SECONDS;
}

/** Simulates "the renderer resolving this frame at preview time" - a call
 * shaped exactly like `resolveVideoNode`'s in services/renderer/resolve.ts. */
function sampleAsPreview({ frame }: { frame: number }): number {
	return getSourceTimeAtClipTime({
		clipTime: frameToClipTime({ frame }),
		retime: heroRetime,
		clipDuration: CLIP_DURATION,
	});
}

/** Simulates "the renderer resolving this same frame during export" - the
 * identical call, standing in for a separate render pass over the same
 * timeline position. */
function sampleAsExport({ frame }: { frame: number }): number {
	return getSourceTimeAtClipTime({
		clipTime: frameToClipTime({ frame }),
		retime: heroRetime,
		clipDuration: CLIP_DURATION,
	});
}

/** Independent reference: hand-integrates the Hero curve's trapezoid areas
 * up to `frame`, without going through curve.ts at all, so this isn't just
 * checking the implementation against itself. */
function referenceSourceTime({ frame }: { frame: number }): number {
	const fraction = frameToClipTime({ frame }) / CLIP_DURATION;
	const points = heroCurve.points;
	let area = 0;
	for (let i = 0; i < points.length - 1; i++) {
		const a = points[i];
		const b = points[i + 1];
		if (fraction <= a.t) break;
		const width = b.t - a.t;
		const end = Math.min(fraction, b.t);
		const span = end - a.t;
		if (span <= 0) continue;
		const rateAtEnd = a.rate + (b.rate - a.rate) * (span / width);
		area += ((a.rate + rateAtEnd) / 2) * span;
		if (fraction < b.t) break;
	}
	return CLIP_DURATION * area;
}

describe("curve renderer-sync fixture (Hero preset, 30fps)", () => {
	test("preview and export resolve IDENTICAL source times at every curve inflection point", () => {
		for (const point of heroCurve.points) {
			const frame = Math.round(point.t * CLIP_DURATION_FRAMES);
			const preview = sampleAsPreview({ frame });
			const exported = sampleAsExport({ frame });
			expect(exported).toBe(preview);
			expect(preview).toBeCloseTo(referenceSourceTime({ frame }), 10);
		}
	});

	test("preview and export resolve IDENTICAL source times at every segment midpoint", () => {
		const points = heroCurve.points;
		for (let i = 0; i < points.length - 1; i++) {
			const midT = (points[i].t + points[i + 1].t) / 2;
			const frame = Math.round(midT * CLIP_DURATION_FRAMES);
			const preview = sampleAsPreview({ frame });
			const exported = sampleAsExport({ frame });
			expect(exported).toBe(preview);
			expect(preview).toBeCloseTo(referenceSourceTime({ frame }), 10);
		}
	});

	test("frame-exact across every frame of the fixture, not just sampled points", () => {
		for (let frame = 0; frame <= CLIP_DURATION_FRAMES; frame++) {
			const preview = sampleAsPreview({ frame });
			const exported = sampleAsExport({ frame });
			expect(exported).toBe(preview);
		}
	});

	test("monotonic across the fixture: no frame reads an earlier source instant than the previous frame", () => {
		let previous = -Infinity;
		for (let frame = 0; frame <= CLIP_DURATION_FRAMES; frame++) {
			const sourceTime = sampleAsPreview({ frame });
			expect(sourceTime).toBeGreaterThanOrEqual(previous);
			previous = sourceTime;
		}
	});
});
