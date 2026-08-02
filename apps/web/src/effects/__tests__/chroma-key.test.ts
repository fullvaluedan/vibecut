import { beforeAll, describe, expect, test } from "bun:test";
import { effectsRegistry, resolveEffectPasses } from "@/effects";
import { registerDefaultEffects } from "@/effects/definitions";
import {
	CHROMA_KEY_EFFECT_TYPE,
	CHROMA_KEY_SHADER,
	applyChromaKeyToPixel,
	buildChromaKeyPasses,
	chromaKeyAlpha,
	chromaKeyChroma,
	chromaKeyDespill,
	chromaKeyLuma,
	keyColorToUniform,
	readChromaKeySettings,
	type Rgb,
} from "@/effects/definitions/chroma-key";
import { buildDefaultParamValues } from "@/params/registry";

/**
 * The functions under test are the TS mirror of
 * rust/crates/effects/src/shaders/chroma_key.wgsl. Every expected value below
 * is hand-derived from BT.601 so a change to either side shows up as a failing
 * number, not as a silently different picture.
 *
 * Reference figures for pure green (#00FF00), the default key:
 *   luma       0.587
 *   chroma     (Cb -0.331264, Cr -0.418688)
 *   |chroma|   0.533888  <- a neutral grey sits this far from the key
 */
const GREEN: Rgb = { r: 0, g: 1, b: 0 };
const KEY_CHROMA_MAGNITUDE = 0.533888;

const DEFAULT_SETTINGS = {
	similarity: 0.2,
	smoothness: 0.1,
	spill: 0,
	shadow: 0,
};

/**
 * The colour param is stored as hex, decomposed to LINEAR components for
 * keyframing, and re-encoded to the sampler's space for the uniform, so an
 * exact 1.0 comes back as 0.9999999999999999. Compare per channel.
 */
function expectVec4({
	actual,
	expected,
}: {
	actual: unknown;
	expected: [number, number, number, number];
}) {
	expect(Array.isArray(actual)).toBe(true);
	const values = actual as number[];
	expect(values).toHaveLength(4);
	for (let index = 0; index < 4; index++) {
		expect(values[index]).toBeCloseTo(expected[index], 9);
	}
}

describe("chroma key colour math (shader reference implementation)", () => {
	test("BT.601 luma and chroma match the shader's coefficients", () => {
		expect(chromaKeyLuma({ color: GREEN })).toBeCloseTo(0.587, 6);
		const chroma = chromaKeyChroma({ color: GREEN });
		expect(chroma.cb).toBeCloseTo(-0.331264, 6);
		expect(chroma.cr).toBeCloseTo(-0.418688, 6);
		expect(Math.hypot(chroma.cb, chroma.cr)).toBeCloseTo(
			KEY_CHROMA_MAGNITUDE,
			5,
		);
	});

	test("a neutral colour has no chroma at any brightness", () => {
		for (const level of [0, 0.25, 0.5, 1]) {
			const chroma = chromaKeyChroma({
				color: { r: level, g: level, b: level },
			});
			expect(chroma.cb).toBeCloseTo(0, 6);
			expect(chroma.cr).toBeCloseTo(0, 6);
		}
	});

	test("a pixel of exactly the key colour is fully cut out", () => {
		expect(
			chromaKeyAlpha({
				pixel: GREEN,
				keyColor: GREEN,
				settings: DEFAULT_SETTINGS,
			}),
		).toBe(0);
	});

	test("neutral pixels stay fully opaque at the default similarity", () => {
		for (const level of [0, 0.5, 1]) {
			expect(
				chromaKeyAlpha({
					pixel: { r: level, g: level, b: level },
					keyColor: GREEN,
					settings: DEFAULT_SETTINGS,
				}),
			).toBe(1);
		}
	});

	/**
	 * This pixel is 53.17% of the way from mid-grey to pure green, which puts
	 * its chroma distance at 0.250 - exactly halfway across the soft edge
	 * [similarity, similarity + smoothness] = [0.20, 0.30]. smoothstep is
	 * symmetric, so the alpha there is 0.5.
	 */
	test("a near-key pixel lands in the middle of the smoothstep band", () => {
		const nearGreen: Rgb = { r: 0.234131, g: 0.765869, b: 0.234131 };
		const chroma = chromaKeyChroma({ color: nearGreen });
		const keyChroma = chromaKeyChroma({ color: GREEN });
		expect(
			Math.hypot(chroma.cb - keyChroma.cb, chroma.cr - keyChroma.cr),
		).toBeCloseTo(0.25, 4);

		expect(
			chromaKeyAlpha({
				pixel: nearGreen,
				keyColor: GREEN,
				settings: DEFAULT_SETTINGS,
			}),
		).toBeCloseTo(0.5, 3);
	});

	test("alpha rises monotonically as a pixel moves away from the key", () => {
		const alphas = [0, 0.25, 0.5, 0.75, 1].map((mix) =>
			chromaKeyAlpha({
				pixel: {
					r: mix * 0.5,
					g: 1 - mix * 0.5,
					b: mix * 0.5,
				},
				keyColor: GREEN,
				settings: DEFAULT_SETTINGS,
			}),
		);
		for (let index = 1; index < alphas.length; index++) {
			expect(alphas[index]).toBeGreaterThanOrEqual(alphas[index - 1]);
		}
		expect(alphas[0]).toBe(0);
		expect(alphas[alphas.length - 1]).toBe(1);
	});

	test("smoothness 0 gives a hard edge at similarity", () => {
		const hard = { similarity: 0.3, smoothness: 0, spill: 0, shadow: 0 };
		// Grey sits at 0.533888, well past the 0.3 threshold.
		expect(
			chromaKeyAlpha({
				pixel: { r: 0.5, g: 0.5, b: 0.5 },
				keyColor: GREEN,
				settings: hard,
			}),
		).toBe(1);
		expect(
			chromaKeyAlpha({ pixel: GREEN, keyColor: GREEN, settings: hard }),
		).toBe(0);
	});
});

describe("chroma key shadow preservation", () => {
	/**
	 * A shadow cast on a green floor keeps the floor's hue but loses most of
	 * its brightness, and darkening green shrinks its chroma too - so at a
	 * generous similarity the shadow keys out along with the floor. That is
	 * the case the shadow parameter exists for.
	 */
	const DARK_GREEN: Rgb = { r: 0, g: 0.25, b: 0 };
	const GENEROUS = { similarity: 0.6, smoothness: 0.1, spill: 0, shadow: 0 };

	test("without it, a shadow on the key surface is keyed away", () => {
		expect(
			chromaKeyAlpha({
				pixel: DARK_GREEN,
				keyColor: GREEN,
				settings: GENEROUS,
			}),
		).toBe(0);
	});

	test("at full strength the shadow comes back as partial alpha", () => {
		// key luma 0.587 - 0.15 margin = 0.437 of range; the shadow's luma is
		// 0.587 * 0.25 = 0.14675, so it sits 66.4% of the way down.
		expect(
			chromaKeyAlpha({
				pixel: DARK_GREEN,
				keyColor: GREEN,
				settings: { ...GENEROUS, shadow: 1 },
			}),
		).toBeCloseTo(0.664, 3);
	});

	test("the lit key surface itself is never brought back", () => {
		expect(
			chromaKeyAlpha({
				pixel: GREEN,
				keyColor: GREEN,
				settings: { ...GENEROUS, shadow: 1 },
			}),
		).toBe(0);
	});

	test("shadow strength scales the recovered alpha linearly", () => {
		const full = chromaKeyAlpha({
			pixel: DARK_GREEN,
			keyColor: GREEN,
			settings: { ...GENEROUS, shadow: 1 },
		});
		const half = chromaKeyAlpha({
			pixel: DARK_GREEN,
			keyColor: GREEN,
			settings: { ...GENEROUS, shadow: 0.5 },
		});
		expect(half).toBeCloseTo(full / 2, 6);
	});
});

describe("chroma key spill suppression", () => {
	test("spill 0 leaves the colour untouched", () => {
		const pixel: Rgb = { r: 0.4, g: 0.7, b: 0.3 };
		expect(chromaKeyDespill({ pixel, keyColor: GREEN, spill: 0 })).toEqual(
			pixel,
		);
	});

	test("full spill flattens the key colour itself to its own luma", () => {
		const despilled = chromaKeyDespill({
			pixel: GREEN,
			keyColor: GREEN,
			spill: 1,
		});
		expect(despilled.r).toBeCloseTo(0.587, 6);
		expect(despilled.g).toBeCloseTo(0.587, 6);
		expect(despilled.b).toBeCloseTo(0.587, 6);
	});

	test("a colour opposite the key is left alone", () => {
		// Magenta's chroma is exactly the negative of green's, so the
		// projection onto the key direction clamps to zero.
		const magenta: Rgb = { r: 1, g: 0, b: 1 };
		const despilled = chromaKeyDespill({
			pixel: magenta,
			keyColor: GREEN,
			spill: 1,
		});
		expect(despilled.r).toBeCloseTo(1, 6);
		expect(despilled.g).toBeCloseTo(0, 6);
		expect(despilled.b).toBeCloseTo(1, 6);
	});

	test("a neutral colour has nothing to despill", () => {
		const grey: Rgb = { r: 0.5, g: 0.5, b: 0.5 };
		const despilled = chromaKeyDespill({
			pixel: grey,
			keyColor: GREEN,
			spill: 1,
		});
		expect(despilled.r).toBeCloseTo(0.5, 6);
		expect(despilled.g).toBeCloseTo(0.5, 6);
		expect(despilled.b).toBeCloseTo(0.5, 6);
	});

	test("a green-tinted skin tone loses only part of its green", () => {
		const spilled: Rgb = { r: 0.6, g: 0.85, b: 0.45 };
		const despilled = chromaKeyDespill({
			pixel: spilled,
			keyColor: GREEN,
			spill: 1,
		});
		// Green comes down, the other two come up towards the same luma.
		expect(despilled.g).toBeLessThan(spilled.g);
		expect(despilled.b).toBeGreaterThan(spilled.b);
		expect(despilled.g).toBeGreaterThan(chromaKeyLuma({ color: spilled }));
	});
});

describe("applyChromaKeyToPixel (straight-alpha output)", () => {
	test("the source alpha multiplies through, it is never premultiplied in", () => {
		const pixel: Rgb = { r: 0.5, g: 0.5, b: 0.5 };
		const result = applyChromaKeyToPixel({
			pixel,
			sourceAlpha: 0.5,
			keyColor: GREEN,
			settings: DEFAULT_SETTINGS,
		});
		expect(result.alpha).toBeCloseTo(0.5, 6);
		// Colour channels stay at full strength: blend.wgsl multiplies by
		// alpha at composite time.
		expect(result.color.r).toBeCloseTo(0.5, 6);
		expect(result.color.g).toBeCloseTo(0.5, 6);
		expect(result.color.b).toBeCloseTo(0.5, 6);
	});

	test("a transparent source pixel stays transparent", () => {
		expect(
			applyChromaKeyToPixel({
				pixel: { r: 0.5, g: 0.5, b: 0.5 },
				sourceAlpha: 0,
				keyColor: GREEN,
				settings: DEFAULT_SETTINGS,
			}).alpha,
		).toBe(0);
	});
});

describe("chroma key uniform mapping", () => {
	test("the colour param maps to a vec4 in the sampler's own space", () => {
		expectVec4({
			actual: keyColorToUniform({ color: "#00FF00" }),
			expected: [0, 1, 0, 1],
		});
	});

	test("a mid-tone colour survives the linear round trip", () => {
		const [r, g, b, a] = keyColorToUniform({ color: "#336699" });
		expect(r).toBeCloseTo(0x33 / 255, 5);
		expect(g).toBeCloseTo(0x66 / 255, 5);
		expect(b).toBeCloseTo(0x99 / 255, 5);
		expect(a).toBe(1);
	});

	test("an unparseable colour falls back to the default key", () => {
		expectVec4({
			actual: keyColorToUniform({ color: "not a colour" }),
			expected: [0, 1, 0, 1],
		});
	});

	test("sliders are read in 0..100 and packed in 0..1", () => {
		expect(
			readChromaKeySettings({
				effectParams: {
					similarity: 20,
					smoothness: 10,
					spill: 50,
					shadow: 0,
				},
			}),
		).toEqual({ similarity: 0.2, smoothness: 0.1, spill: 0.5, shadow: 0 });
	});

	test("buildPasses emits one pass with exactly the schema's five uniforms", () => {
		const passes = buildChromaKeyPasses({
			effectParams: {
				keyColor: "#00FF00",
				similarity: 20,
				smoothness: 10,
				spill: 50,
				shadow: 0,
			},
		});

		expect(passes).toHaveLength(1);
		expect(passes[0].shader).toBe(CHROMA_KEY_SHADER);
		expect(Object.keys(passes[0].uniforms).sort()).toEqual([
			"u_key_color",
			"u_shadow",
			"u_similarity",
			"u_smoothness",
			"u_spill",
		]);
		expect(passes[0].uniforms.u_similarity).toBeCloseTo(0.2, 6);
		expect(passes[0].uniforms.u_smoothness).toBeCloseTo(0.1, 6);
		expect(passes[0].uniforms.u_spill).toBeCloseTo(0.5, 6);
		expect(passes[0].uniforms.u_shadow).toBe(0);
		expectVec4({
			actual: passes[0].uniforms.u_key_color,
			expected: [0, 1, 0, 1],
		});
	});

	test("a keyed colour other than green reaches the uniform", () => {
		const passes = buildChromaKeyPasses({
			effectParams: { keyColor: "#0000FF", similarity: 30 },
		});
		expectVec4({
			actual: passes[0].uniforms.u_key_color,
			expected: [0, 0, 1, 1],
		});
		expect(passes[0].uniforms.u_similarity).toBeCloseTo(0.3, 6);
	});

	test("all-zero sliders still emit a pass (no neutral early-out)", () => {
		expect(
			buildChromaKeyPasses({
				effectParams: {
					keyColor: "#00FF00",
					similarity: 0,
					smoothness: 0,
					spill: 0,
					shadow: 0,
				},
			}),
		).toHaveLength(1);
	});
});

describe("chroma key registration", () => {
	beforeAll(() => {
		if (!effectsRegistry.has(CHROMA_KEY_EFFECT_TYPE)) registerDefaultEffects();
	});

	test("the effect is registered with the plan's defaults", () => {
		const definition = effectsRegistry.get(CHROMA_KEY_EFFECT_TYPE);
		expect(definition.name).toBe("Chroma key");
		expect(buildDefaultParamValues(definition.params)).toEqual({
			keyColor: "#00FF00",
			similarity: 20,
			smoothness: 10,
			spill: 50,
			shadow: 0,
		});
	});

	test("resolveEffectPasses routes through buildPasses", () => {
		const definition = effectsRegistry.get(CHROMA_KEY_EFFECT_TYPE);
		const passes = resolveEffectPasses({
			definition,
			effectParams: buildDefaultParamValues(definition.params),
			width: 1920,
			height: 1080,
		});
		expect(passes).toHaveLength(1);
		expect(passes[0].shader).toBe(CHROMA_KEY_SHADER);
		expectVec4({
			actual: passes[0].uniforms.u_key_color,
			expected: [0, 1, 0, 1],
		});
	});

	test("the declared pass template agrees with buildPasses", () => {
		const definition = effectsRegistry.get(CHROMA_KEY_EFFECT_TYPE);
		const effectParams = buildDefaultParamValues(definition.params);
		expect(
			definition.renderer.passes[0].uniforms({
				effectParams,
				width: 1920,
				height: 1080,
			}),
		).toEqual(buildChromaKeyPasses({ effectParams })[0].uniforms);
	});

	test("blur is still registered alongside it", () => {
		expect(effectsRegistry.has("blur")).toBe(true);
	});
});
