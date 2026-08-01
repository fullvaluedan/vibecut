import type { RetimeConfig } from "@/timeline";
import { clampRetimeRate, DEFAULT_RETIME_RATE } from "@/retime/rate";
import { buildRetimeCurveFromPreset } from "@/retime/curve-presets";
import { normalizeRetimeCurve, type RetimeCurve, type RetimeCurvePoint } from "@/retime/curve";

export function buildConstantRetime({
	rate,
	maintainPitch = false,
}: {
	rate: number;
	maintainPitch?: boolean;
}): RetimeConfig {
	return { rate: clampRetimeRate({ rate }), maintainPitch };
}

/**
 * T18.2: a curve retime always plays forward at a vestigial `rate: 1` (the
 * curve supersedes it for sampling - see RetimeConfig.curve in
 * timeline/types.ts) and never sets `reversed`, enforcing the v1
 * curve/reverse exclusivity at the single builder every UI path (preset
 * chips, custom point edits) goes through.
 */
export function buildCurveRetime({
	curve,
	maintainPitch = false,
}: {
	curve: RetimeCurve;
	maintainPitch?: boolean;
}): RetimeConfig {
	return {
		rate: DEFAULT_RETIME_RATE,
		maintainPitch,
		curve: normalizeRetimeCurve({ points: curve.points }),
	};
}

/** Builds a curve retime straight from a preset id (see curve-presets.ts). */
export function buildCurveRetimeFromPreset({
	presetId,
	maintainPitch = false,
}: {
	presetId: string;
	maintainPitch?: boolean;
}): RetimeConfig {
	return buildCurveRetime({
		curve: buildRetimeCurveFromPreset({ id: presetId }),
		maintainPitch,
	});
}

/** Builds a curve retime from a freely-edited point list (custom graph
 * drags), sanitizing it the same way a preset is sanitized. */
export function buildCurveRetimeFromPoints({
	points,
	maintainPitch = false,
}: {
	points: RetimeCurvePoint[];
	maintainPitch?: boolean;
}): RetimeConfig {
	return buildCurveRetime({
		curve: normalizeRetimeCurve({ points }),
		maintainPitch,
	});
}
