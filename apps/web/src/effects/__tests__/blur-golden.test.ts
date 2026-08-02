import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { effectsRegistry, resolveEffectPasses } from "@/effects";
import { registerDefaultEffects } from "@/effects/definitions";
import { buildDefaultParamValues } from "@/params/registry";
import type { EffectPass } from "@/effects/types";

/**
 * Blur regression golden.
 *
 * These hashes cover the EXACT payload the thumbnail path
 * (services/renderer/effect-preview.ts -> gpuRenderer.applyEffect) hands to the
 * wasm compositor for a blurred fixture: the ordered pass list, each pass's
 * shader id, and every uniform name/value. They were captured BEFORE the T19.0
 * uniform-schema refactor of rust/crates/effects/src/pipeline.rs and must not
 * move: the schema generalization is required to be byte-identical for blur.
 *
 * The Rust half of the same proof lives in
 * rust/crates/effects/src/pipeline.rs (`packs_blur_uniforms_byte_for_byte`),
 * which asserts the packed uniform buffer bytes for one of these passes.
 */
const PREVIEW_TILE_GOLDEN = "1e8c6fabaa882b5f35408fc04de3baca";
const EXPORT_FRAME_GOLDEN = "b26e2542de62d2ec424f721249202e11";

/** Preview tiles render at 160x160 (effect-preview.ts PREVIEW_SIZE). */
const PREVIEW_SIZE = 160;

function hashPasses({ passes }: { passes: EffectPass[] }): string {
	const canonical = passes.map((pass) => ({
		shader: pass.shader,
		uniforms: Object.keys(pass.uniforms)
			.sort()
			.map((key) => [key, pass.uniforms[key]] as const),
	}));
	return createHash("md5").update(JSON.stringify(canonical)).digest("hex");
}

function blurPasses({
	intensity,
	width,
	height,
}: {
	intensity: number;
	width: number;
	height: number;
}): EffectPass[] {
	const definition = effectsRegistry.get("blur");
	const params = {
		...buildDefaultParamValues(definition.params),
		intensity,
	};
	return resolveEffectPasses({
		definition,
		effectParams: params,
		width,
		height,
	});
}

describe("blur golden (uniform-schema regression)", () => {
	beforeAll(() => {
		if (!effectsRegistry.has("blur")) registerDefaultEffects();
	});

	test("preview-tile pass list is unchanged", () => {
		const passes = blurPasses({
			intensity: 15,
			width: PREVIEW_SIZE,
			height: PREVIEW_SIZE,
		});
		expect(hashPasses({ passes })).toBe(PREVIEW_TILE_GOLDEN);
	});

	test("export-frame pass list is unchanged", () => {
		const passes = blurPasses({ intensity: 60, width: 1920, height: 1080 });
		expect(hashPasses({ passes })).toBe(EXPORT_FRAME_GOLDEN);
	});

	test("every blur pass carries exactly the three schema uniforms", () => {
		const passes = blurPasses({ intensity: 60, width: 1920, height: 1080 });
		expect(passes.length).toBeGreaterThan(0);
		for (const pass of passes) {
			expect(pass.shader).toBe("gaussian-blur");
			expect(Object.keys(pass.uniforms).sort()).toEqual([
				"u_direction",
				"u_sigma",
				"u_step",
			]);
			expect(typeof pass.uniforms.u_sigma).toBe("number");
			expect(typeof pass.uniforms.u_step).toBe("number");
			expect(pass.uniforms.u_direction).toHaveLength(2);
		}
	});

	test("a neutral blur resolves to zero passes", () => {
		expect(
			blurPasses({ intensity: 0, width: 1920, height: 1080 }),
		).toHaveLength(0);
	});
});
