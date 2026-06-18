import { describe, expect, mock, test } from "bun:test";

// `mask-param-channel` transitively reaches `opencut-wasm` (via `./resolve` →
// `./interpolation` → `@/wasm`), whose top-level binary init fails under
// `bun test`. Stub the `@/wasm` surface with pure JS shims so the module loads;
// this test only inspects static key lists, so none of the shims are exercised.
// The stub MUST be registered before the production module is imported, so it is
// pulled in via `await import` below.
mock.module("@/wasm", () => {
	const passTime = <T extends { time?: number }>(args: T) => args.time ?? 0;
	return {
		TICKS_PER_SECOND: 1_000_000,
		ZERO_MEDIA_TIME: 0,
		mediaTime: ({ ticks }: { ticks: number }) => ticks,
		roundMediaTime: ({ time }: { time: number }) => Math.round(time),
		mediaTimeFromSeconds: ({ seconds }: { seconds: number }) =>
			Math.round(seconds * 1_000_000),
		mediaTimeToSeconds: ({ time }: { time: number }) => time / 1_000_000,
		addMediaTime: ({ a, b }: { a: number; b: number }) => a + b,
		subMediaTime: ({ a, b }: { a: number; b: number }) => a - b,
		maxMediaTime: ({ a, b }: { a: number; b: number }) => Math.max(a, b),
		minMediaTime: ({ a, b }: { a: number; b: number }) => Math.min(a, b),
		clampMediaTime: ({
			time,
			min,
			max,
		}: {
			time: number;
			min: number;
			max: number;
		}) => Math.min(Math.max(time, min), max),
		roundFrameTime: passTime,
		roundFrameTicks: ({ ticks }: { ticks: number }) => ticks,
		snapSeekMediaTime: passTime,
		lastFrameMediaTime: ({ duration }: { duration: number }) => duration,
		parseMediaTimecode: () => null,
	};
});

const { ANIMATION_PROPERTY_PATHS } = await import("@/animation/types");
const { ANIMATABLE_MASK_SCALAR_KEYS, MASK_PARAM_PATH_PREFIX } = await import(
	"@/animation/mask-param-channel"
);

// Guards against drift between the two parallel lists: the scalar mask keys that
// the resolver animates and the `mask.*` paths the keyframe engine advertises in
// `ANIMATION_PROPERTY_PATHS`. Adding a key to one without the other silently
// breaks either resolution or the keyframe UI.
describe("mask scalar keys <-> ANIMATION_PROPERTY_PATHS sync", () => {
	const maskPropertyPaths = ANIMATION_PROPERTY_PATHS.filter((path) =>
		path.startsWith(MASK_PARAM_PATH_PREFIX),
	);

	test("every animatable scalar key has a matching mask.<key> path", () => {
		for (const key of ANIMATABLE_MASK_SCALAR_KEYS) {
			expect(ANIMATION_PROPERTY_PATHS).toContain(
				`${MASK_PARAM_PATH_PREFIX}${key}`,
			);
		}
	});

	test("every mask.* path corresponds to an animatable scalar key", () => {
		const scalarKeys = new Set<string>(ANIMATABLE_MASK_SCALAR_KEYS);
		for (const path of maskPropertyPaths) {
			const key = path.slice(MASK_PARAM_PATH_PREFIX.length);
			expect(scalarKeys.has(key)).toBe(true);
		}
	});

	test("the two lists are the same size (exact 1:1 mapping)", () => {
		expect(maskPropertyPaths).toHaveLength(ANIMATABLE_MASK_SCALAR_KEYS.length);
	});
});
