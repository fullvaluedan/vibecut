import type { HfTemplate } from "../types";
import { lowerThird } from "./lower-third";
import { kineticTitle } from "./kinetic-title";
import { numberPop } from "./number-pop";
import { calloutPill } from "./callout-pill";
import { sectionBreak } from "./section-break";

export const HF_TEMPLATES: HfTemplate[] = [
	lowerThird,
	kineticTitle,
	numberPop,
	calloutPill,
	sectionBreak,
];

export function getTemplate(id: string): HfTemplate | undefined {
	return HF_TEMPLATES.find((t) => t.id === id);
}

/** Compact catalog used in the planner prompt and exposed to the UI. */
export function describeTemplateCatalog(): {
	id: string;
	name: string;
	description: string;
	whenToUse: string;
	minDurationSec: number;
	maxDurationSec: number;
	variables: { id: string; type: string; label: string; default: unknown; options?: unknown }[];
}[] {
	return HF_TEMPLATES.map((t) => ({
		id: t.id,
		name: t.name,
		description: t.description,
		whenToUse: t.whenToUse,
		minDurationSec: t.minDurationSec,
		maxDurationSec: t.maxDurationSec,
		variables: t.variables.map((v) => ({
			id: v.id,
			type: v.type,
			label: v.label,
			default: v.default,
			options: v.options,
		})),
	}));
}
