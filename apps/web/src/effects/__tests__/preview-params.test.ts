import { describe, expect, test } from "bun:test";
import {
	effectsRegistry,
	registerDefaultEffects,
	resolveEffectPasses,
} from "@/effects";
import { buildDefaultParamValues } from "@/params/registry";

/**
 * Catalogue tiles in the assets panel render with `params: {}`, and every
 * effect's defaults are deliberately neutral (a fresh clip effect must not
 * touch the frame) — which made 6 of the 7 tiles pixel-identical
 * (round-19 defect 3). `EffectDefinition.previewParams` exists so the TILE
 * path can merge non-neutral overrides over the defaults; this test guards
 * that every registered effect either (a) has previewParams that resolve to
 * a non-empty pass list through the real definition path, or (b) is exempted
 * here with a documented reason.
 *
 * Exemption list (keep the reason concrete):
 * - chroma-key: the shared tile frame (public/effects/preview.jpg) is almost
 *   entirely chroma-neutral (white background, black sweater, dark hair).
 *   Verified with the shader's reference math on the actual file: the default
 *   green key keeps 100% of pixels (tile unchanged), a white key cuts ~95% of
 *   the frame INCLUDING the subject (dark neutrals are chroma-neutral too),
 *   and the only keyable hue is the subject's own skin. No previewParams can
 *   produce a truthful tile, so the tile uses a static illustrative thumbnail
 *   instead (public/effects/chroma-key-preview.png, rendered with the same
 *   reference math; see STATIC_TILE_PREVIEWS in
 *   effects/components/assets-view.tsx).
 */
const PREVIEW_PARAMS_EXEMPTIONS: Record<string, string> = {
	"chroma-key":
		"tile frame is chroma-neutral; static /effects/chroma-key-preview.png thumbnail instead",
};

registerDefaultEffects();
const definitions = effectsRegistry.getAll();

/** Mirrors the tile path's merge in services/renderer/effect-preview.ts. */
function resolveTileParams(definition: (typeof definitions)[number]) {
	return {
		...buildDefaultParamValues(definition.params),
		...definition.previewParams,
	};
}

describe("effect previewParams (catalogue tiles)", () => {
	test("every registered effect has previewParams or a documented exemption", () => {
		for (const definition of definitions) {
			const exempt = definition.type in PREVIEW_PARAMS_EXEMPTIONS;
			if (exempt) {
				expect(
					PREVIEW_PARAMS_EXEMPTIONS[definition.type].length,
				).toBeGreaterThan(0);
				continue;
			}
			expect(
				definition.previewParams,
				`${definition.type} has no previewParams and is not in PREVIEW_PARAMS_EXEMPTIONS`,
			).toBeDefined();
		}
	});

	test("exemption list contains only registered effects", () => {
		const registered = new Set(definitions.map((d) => d.type));
		for (const type of Object.keys(PREVIEW_PARAMS_EXEMPTIONS)) {
			expect(
				registered.has(type),
				`${type} is exempted but not registered — stale exemption`,
			).toBe(true);
		}
	});

	test("non-exempt previewParams resolve to a non-empty pass list at tile size", () => {
		for (const definition of definitions) {
			if (definition.type in PREVIEW_PARAMS_EXEMPTIONS) continue;
			const passes = resolveEffectPasses({
				definition,
				effectParams: resolveTileParams(definition),
				width: 160,
				height: 160,
			});
			expect(
				passes.length,
				`${definition.type} previewParams resolve to zero passes — tile would be identical to defaults`,
			).toBeGreaterThan(0);
		}
	});

	test("non-exempt previewParams differ from the neutral defaults", () => {
		for (const definition of definitions) {
			if (definition.type in PREVIEW_PARAMS_EXEMPTIONS) continue;
			const defaults = buildDefaultParamValues(definition.params);
			const merged = resolveTileParams(definition);
			const differs = Object.keys(merged).some(
				(key) => merged[key] !== defaults[key],
			);
			expect(
				differs,
				`${definition.type} previewParams leave every param at its default`,
			).toBe(true);
		}
	});

	test("previewParams only reference declared param keys", () => {
		for (const definition of definitions) {
			if (!definition.previewParams) continue;
			const declared = new Set(definition.params.map((p) => p.key));
			for (const key of Object.keys(definition.previewParams)) {
				expect(
					declared.has(key),
					`${definition.type} previewParams key "${key}" is not a declared param`,
				).toBe(true);
			}
		}
	});
});
