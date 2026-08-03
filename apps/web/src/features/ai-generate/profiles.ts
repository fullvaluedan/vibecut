/**
 * Style preference profiles: a saved, named design spec (palette, fonts,
 * motion style, density) the user builds once and every generation honors,
 * for HyperFrames authored compositions AND the Remotion media-pack export
 * (the pack manifest serializes these same field names: palette / fonts /
 * motion / density). The six VIBE_STYLES are the factory-default profile
 * set, expressed through these same types so there is one concept, not two.
 *
 * Pure + dependency-free on purpose: the store, the brief compiler, the run
 * orchestrators, and the panel UI all share these types and helpers.
 */

export type HfMotionStyle = "calm" | "standard" | "punchy";
export type HfDensity = "sparse" | "balanced" | "dense";

export interface HfDesignSpec {
	palette: {
		/** Primary accent color (hex), the palette's anchor. */
		accent: string;
		/** Supporting colors (hex), secondary surface/text colors. */
		supporting: string[];
	};
	fonts: {
		/** Headline / display typeface. */
		display: string;
		/** Body / caption typeface. */
		body: string;
	};
	motion: HfMotionStyle;
	density: HfDensity;
}

/** A design spec plus the name of the profile it came from. */
export interface HfDesignProfile {
	name: string;
	spec: HfDesignSpec;
}

/** Options offered by the profile editor's segmented controls, in order. */
export const HF_MOTION_STYLES: HfMotionStyle[] = [
	"calm",
	"standard",
	"punchy",
];
export const HF_DENSITIES: HfDensity[] = ["sparse", "balanced", "dense"];

/**
 * Font choices offered by the profile editor: the system-safe families the
 * factory looks already use plus the registered motion-template fonts.
 * Generation loads Google families on demand (`loadFonts`).
 */
export const PROFILE_FONT_OPTIONS = [
	"Inter",
	"Poppins",
	"Montserrat",
	"Oswald",
	"Bebas Neue",
	"Anton",
	"Arial",
	"Verdana",
	"Trebuchet MS",
	"Impact",
	"Georgia",
	"Courier New",
];

/** How the brief describes each motion style to the authoring skill. */
export const HF_MOTION_BRIEFS: Record<HfMotionStyle, string> = {
	calm: "calm - slow, gentle easing, longer holds, minimal movement",
	standard: "standard - moderate pacing, ease-out entrances, comfortable holds",
	punchy: "punchy - fast entrances, snappy easing, high energy, shorter holds",
};

/** How the brief describes each density to the authoring skill. */
export const HF_DENSITY_BRIEFS: Record<HfDensity, string> = {
	sparse: "sparse - few graphics, generous breathing room",
	balanced: "balanced - a graphic every few spoken points",
	dense: "dense - graphics at most moments, layered information",
};

/** Deep copy so stored profiles never share references with live edits. */
export function cloneDesignSpec(spec: HfDesignSpec): HfDesignSpec {
	return {
		palette: {
			accent: spec.palette.accent,
			supporting: [...spec.palette.supporting],
		},
		fonts: { ...spec.fonts },
		motion: spec.motion,
		density: spec.density,
	};
}

/**
 * One-line planner-friendly rendering of a design spec, used where only a
 * short text channel exists (the native-template planner's look context).
 */
export function describeDesignSpec(spec: HfDesignSpec): string {
	const supporting = spec.palette.supporting.filter((c) => c.trim());
	return [
		`accent ${spec.palette.accent}${supporting.length ? `, supporting ${supporting.join(", ")}` : ""}`,
		`display type ${spec.fonts.display}, body ${spec.fonts.body}`,
		`${spec.motion} motion`,
		`${spec.density} density`,
	].join("; ");
}
