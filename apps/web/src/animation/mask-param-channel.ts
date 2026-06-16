// Pure resolver for animated SCALAR mask properties (U9), mirroring
// `graphic-param-channel.ts`. Mask scalar params (feather, centerX, centerY,
// rotation, scale, expand) are keyframed on `ElementAnimations` under the
// `mask.<key>` paths and resolved into the mask's effective params for a frame
// via `resolveAnimationPathValueAtTime`.
//
// Only the scalar fields above are animatable here; freeform path POINTS (the
// bezier points array) are explicitly OUT OF SCOPE (they need custom array
// interpolation — deferred). Fields without a channel fall back to their static
// value, so a static mask resolves to its params unchanged.
//
// Kept wasm-free (imports only `@/animation/resolve`) so it can be unit-tested
// without the wasm bridge.

import type { ElementAnimations } from "@/animation/types";
import type { BaseMaskParams } from "@/masks/types";

import { resolveAnimationPathValueAtTime } from "./resolve";

export const MASK_PARAM_PATH_PREFIX = "mask.";

/**
 * The scalar mask params that can be keyframed. Not every mask type carries
 * every key (e.g. a split mask has no `scale`); we only resolve a key when it
 * is actually present on the mask's params object.
 */
export const ANIMATABLE_MASK_SCALAR_KEYS = [
	"feather",
	"centerX",
	"centerY",
	"rotation",
	"scale",
	"expand",
] as const;

export type AnimatableMaskScalarKey =
	(typeof ANIMATABLE_MASK_SCALAR_KEYS)[number];

export function buildMaskParamPath({
	paramKey,
}: {
	paramKey: AnimatableMaskScalarKey;
}): string {
	return `${MASK_PARAM_PATH_PREFIX}${paramKey}`;
}

export function isMaskParamPath(propertyPath: string): boolean {
	return propertyPath.startsWith(MASK_PARAM_PATH_PREFIX);
}

/**
 * Returns true when the element has at least one `mask.*` animation channel.
 * Used to guard the render hot path: a mask with no mask channels skips the
 * per-frame resolution entirely and renders with its static params.
 */
export function hasAnimatedMaskParams({
	animations,
}: {
	animations: ElementAnimations | undefined;
}): boolean {
	if (!animations) {
		return false;
	}
	for (const key of ANIMATABLE_MASK_SCALAR_KEYS) {
		if (animations[buildMaskParamPath({ paramKey: key })]) {
			return true;
		}
	}
	return false;
}

/**
 * Resolves the animated scalar mask params at `localTime`. Each scalar field
 * present on `params` that has a `mask.<key>` channel is pulled from that
 * channel; every other field (including non-scalar params like `path`,
 * `strokeColor`, `inverted`) is left at its static value.
 *
 * Returns the original `params` reference unchanged when nothing animates, so a
 * static mask is a true no-op.
 */
export function resolveMaskParamsAtTime<TParams extends BaseMaskParams>({
	params,
	animations,
	localTime,
}: {
	params: TParams;
	animations: ElementAnimations | undefined;
	localTime: number;
}): TParams {
	if (!animations) {
		return params;
	}

	const safeLocalTime = Math.max(0, localTime);
	const overlay: Partial<Record<AnimatableMaskScalarKey, number>> = {};
	let changed = false;

	for (const key of ANIMATABLE_MASK_SCALAR_KEYS) {
		const staticValue = readScalarMaskValue({ params, key });
		if (staticValue === undefined) {
			continue;
		}

		const path = buildMaskParamPath({ paramKey: key });
		if (!animations[path]) {
			continue;
		}

		const nextValue = resolveAnimationPathValueAtTime({
			animations,
			propertyPath: path,
			localTime: safeLocalTime,
			fallbackValue: staticValue,
		});

		if (nextValue === staticValue) {
			continue;
		}

		overlay[key] = nextValue;
		changed = true;
	}

	if (!changed) {
		return params;
	}

	// `Object.assign` returns `TParams & overlay`, which is assignable to
	// `TParams` — no type assertion needed. The overlay only ever carries scalar
	// keys that already exist on `params`, so the merged value preserves shape.
	return Object.assign({ ...params }, overlay);
}

/**
 * Reads a scalar mask param that may be absent on a given mask type (e.g. a
 * split mask has no `scale`). Returns undefined when missing or non-numeric, so
 * the resolver only animates fields the mask actually carries.
 */
function readScalarMaskValue({
	params,
	key,
}: {
	params: BaseMaskParams;
	key: AnimatableMaskScalarKey;
}): number | undefined {
	const value = Object.entries(params).find(
		([entryKey]) => entryKey === key,
	)?.[1];
	return typeof value === "number" ? value : undefined;
}
