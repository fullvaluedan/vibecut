/**
 * VibeCut style themes for AI effects — named accents inspired by the
 * HyperFrames visual styles. The active style colors all NEW generations
 * and can be batch-applied to existing AI clips.
 */

export interface VibeStyle {
	id: string;
	name: string;
	accent: string;
	/** Typeface for template text — the look's typographic identity. A
	 *  web-safe system family (renders in the browser preview AND the headless
	 *  export); the renderer falls back to sans-serif if unavailable. */
	fontFamily: string;
	/** One-line aesthetic, also fed to the AI planner so it picks fitting
	 *  templates + pacing for this look. */
	description: string;
}

export const VIBE_STYLES: VibeStyle[] = [
	{ id: "ember", name: "Ember", accent: "#FF6E20", fontFamily: "Arial", description: "Warm, punchy YouTube look — bold sans, orange accent" },
	{ id: "electric", name: "Electric", accent: "#3B82F6", fontFamily: "Verdana", description: "Cool tech explainer — wide sans, electric blue" },
	{ id: "acid", name: "Acid", accent: "#A3E635", fontFamily: "Impact", description: "Loud, high-energy — heavy display type, lime pop" },
	{ id: "magenta", name: "Magenta", accent: "#EC4899", fontFamily: "Trebuchet MS", description: "Playful modern — rounded sans, hot pink" },
	{ id: "gold", name: "Editorial", accent: "#EAB308", fontFamily: "Georgia", description: "Premium editorial / documentary — serif, restrained gold, slower pacing" },
	{ id: "mono", name: "Terminal", accent: "#F5F5F5", fontFamily: "Courier New", description: "Technical / code — monospace, clean monochrome" },
];

export function getStyleById(id: string): VibeStyle {
	return VIBE_STYLES.find((s) => s.id === id) ?? VIBE_STYLES[0];
}
