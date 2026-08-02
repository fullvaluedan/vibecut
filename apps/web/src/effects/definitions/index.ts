import { effectsRegistry } from "../registry";
import { blurEffectDefinition } from "./blur";
import { chromaKeyEffectDefinition } from "./chroma-key";

const defaultEffects = [blurEffectDefinition, chromaKeyEffectDefinition];

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
