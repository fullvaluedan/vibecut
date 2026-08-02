/**
 * The motion-template catalog as the edit assistant sees it (T17.1).
 *
 * A thin, plain-data projection of `MOTION_TEMPLATES` so the tool schema, the
 * validator and the system prompt all describe the SAME set with the SAME typed
 * parameters, and so the single import of the template registry lives in one
 * file rather than being scattered across the schema and the route.
 *
 * Internal templates (the Swiss grid key points) are excluded: they exist to
 * serve a layout, not to be inserted by name.
 */

import { MOTION_TEMPLATES } from "@/features/motion-templates/templates";

export interface AssistantTemplateField {
	key: string;
	label: string;
	type: "text" | "color" | "enum";
	/** Allowed values for an enum field. */
	options?: string[];
	default?: string;
}

export interface AssistantTemplateSpec {
	id: string;
	name: string;
	description: string;
	defaultDurationSec: number;
	minDurationSec: number;
	maxDurationSec: number;
	fields: AssistantTemplateField[];
}

/** Alphabetical by id so the prompt and the schema are byte-stable. */
export const ASSISTANT_TEMPLATE_CATALOG: AssistantTemplateSpec[] =
	MOTION_TEMPLATES.filter((template) => !template.internal)
		.map((template) => ({
			id: template.id,
			name: template.name,
			description: template.description,
			defaultDurationSec: template.defaultDurationSec,
			minDurationSec: template.durationRange.min,
			maxDurationSec: template.durationRange.max,
			fields: template.fields.map((field) => ({
				key: field.key,
				label: field.label,
				type: field.type,
				...(field.options
					? { options: field.options.map((option) => option.value) }
					: {}),
				...(field.default !== undefined ? { default: field.default } : {}),
			})),
		}))
		.sort((a, b) => a.id.localeCompare(b.id));

export const ASSISTANT_TEMPLATE_IDS: string[] = ASSISTANT_TEMPLATE_CATALOG.map(
	(template) => template.id,
);

export function findAssistantTemplate(
	templateId: string,
): AssistantTemplateSpec | null {
	return (
		ASSISTANT_TEMPLATE_CATALOG.find(
			(template) => template.id === templateId,
		) ?? null
	);
}
