/**
 * VibeCut style themes for AI effects — named accents inspired by the
 * HyperFrames visual styles. The active style colors all NEW generations
 * and can be batch-applied to existing AI clips.
 */

export interface VibeStyle {
	id: string;
	name: string;
	accent: string;
	description: string;
}

export const VIBE_STYLES: VibeStyle[] = [
	{ id: "ember", name: "Ember", accent: "#FF6E20", description: "Warm burn — the default" },
	{ id: "electric", name: "Electric", accent: "#3B82F6", description: "Cool tech blue" },
	{ id: "acid", name: "Acid", accent: "#A3E635", description: "Loud lime pop" },
	{ id: "magenta", name: "Magenta", accent: "#EC4899", description: "Hot pink energy" },
	{ id: "gold", name: "Gold", accent: "#EAB308", description: "Premium yellow-gold" },
	{ id: "mono", name: "Mono", accent: "#F5F5F5", description: "Clean monochrome" },
];

export function getStyleById(id: string): VibeStyle {
	return VIBE_STYLES.find((s) => s.id === id) ?? VIBE_STYLES[0];
}
