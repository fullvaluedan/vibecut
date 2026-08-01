/**
 * Per-template smart defaults for `add_motion_template` (T17.4).
 *
 * `validateAddMotionTemplate` (tools.ts) only fills `variables` with keys the
 * model actually sent; a field it left out is simply ABSENT from the object,
 * not defaulted there. Until now the only fallback for an absent field was
 * each template builder's own hardcoded inline value (`templates.ts`'s
 * `str(variables, "accent", args.accent)` and friends), which is why "add a
 * title that says X" always produced the exact same look no matter the
 * project: a fixed white or fixed project-style accent, never anything
 * derived from the video itself.
 *
 * This module fills those same gaps one level higher, before
 * `template.build()` ever runs, from the project's own palette instead of a
 * constant:
 *  - a field named "accent" (every pill/bar fill or pill-text color across
 *    the catalog) gets the project-derived accent (`color-utils.deriveAccent`);
 *  - a field named "color" (the two templates whose text sits directly on the
 *    canvas with no pill behind it - kinetic-title, title-subtitle) gets the
 *    project-derived, contrast-safe foreground (`color-utils.pickForeground`);
 *  - a field named "font" (only kinetic-title has one) gets a role-appropriate
 *    face instead of the generic one the field's own metadata carries for the
 *    Template Controls dropdown;
 *  - any other enum field (a corner or a side - the templates' only
 *    variable-driven POSITION controls) gets the template's own declared
 *    default, which is already the sensible placement for that template's
 *    role (callout-pill: top-right; lower-third: left, which combined with
 *    its fixed near-bottom Y reads as bottom-left).
 *
 * Duration is NOT handled here: `validateInsertTiming` (tools.ts) already
 * falls back to `template.defaultDurationSec` - each template's own declared
 * default - whenever the model omits `durationSec`, so there is no gap left
 * to fill by the time a call reaches the executor.
 *
 * LLM-supplied variables always win: a key already present in `variables`
 * (non-empty) is left exactly as the model set it.
 */

import { findAssistantTemplate } from "./template-catalog";
import { deriveAccent, pickForeground } from "./color-utils";

/**
 * Role-appropriate font override for templates whose field list exposes a
 * font CHOICE. Only `kinetic-title` has one today: a punchy pop-in title
 * reads better in a bold display face than the generic default the field
 * carries for the dropdown's own initial value.
 */
const TEMPLATE_FONT_DEFAULTS: Readonly<Record<string, string>> = {
	"kinetic-title": "Anton",
};

/**
 * Fill the gaps in an `add_motion_template` call's `variables` with the
 * project's own palette and each template's own position/font defaults.
 * Pure: no editor access, so it can run in `planAddMotionTemplate` (which is
 * itself pure with respect to the editor) and be unit-tested with a plain hex
 * string.
 */
export function applyTemplateDefaults({
	templateId,
	variables,
	backgroundColor,
}: {
	templateId: string;
	variables: Readonly<Record<string, string>>;
	/** The project canvas background color, e.g. `TimelineSnapshot.background`. */
	backgroundColor: string;
}): Record<string, string> {
	const template = findAssistantTemplate(templateId);
	if (!template) return { ...variables };

	const filled: Record<string, string> = { ...variables };
	const accent = deriveAccent(backgroundColor);
	const foreground = pickForeground(backgroundColor);

	for (const field of template.fields) {
		if (filled[field.key] !== undefined && filled[field.key] !== "") continue;
		if (field.key === "accent") {
			filled[field.key] = accent;
		} else if (field.key === "color") {
			filled[field.key] = foreground;
		} else if (field.key === "font") {
			filled[field.key] = TEMPLATE_FONT_DEFAULTS[templateId] ?? field.default ?? "Inter";
		} else if (field.type === "enum" && field.default) {
			filled[field.key] = field.default;
		}
	}
	return filled;
}
