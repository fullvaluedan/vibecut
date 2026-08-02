import { effectsRegistry } from "../registry";
import { blurEffectDefinition } from "./blur";
import { colorAdjustEffectDefinition } from "./color-adjust";
import { glowEffectDefinition } from "./glow";
import { noiseEffectDefinition } from "./noise";
import { pixelateEffectDefinition } from "./pixelate";
import { vignetteEffectDefinition } from "./vignette";

const defaultEffects = [
	blurEffectDefinition,
	colorAdjustEffectDefinition,
	pixelateEffectDefinition,
	vignetteEffectDefinition,
	glowEffectDefinition,
	noiseEffectDefinition,
];

export function registerDefaultEffects(): void {
	for (const definition of defaultEffects) {
		if (effectsRegistry.has(definition.type)) {
			continue;
		}
		effectsRegistry.register({
			key: definition.type,
			definition,
		});
	}
}
