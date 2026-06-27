/**
 * The HyperFrames panel is a PROMPT GENERATOR. The user's panel selections
 * (which templates/blocks/styles they checked) plus the active look, their
 * free-form direction, and the targeted segment of the timeline compile into
 * ONE authoring prompt for the `/hyperframes` skill.
 *
 * Key contract (Dan's spec): the selections are PREFERENCES, not guarantees.
 * The skill uses its best judgment — it tries to fit the selected assets to
 * the spoken moments, but is free to skip any that don't suit the content.
 *
 * Pure + dependency-free on purpose so it is unit-testable in isolation and
 * usable from both the in-app run and a skill/job hand-off.
 */

export interface HfSelectionAsset {
	/** Registry name or native template id. */
	name: string;
	kind: "template" | "block" | "component" | "example";
	/** Human title for the prompt. */
	title: string;
	/** One-line description of what it is / when to use it. */
	description?: string;
	tags?: string[];
	/**
	 * true => the asset fills the whole frame (a chart, map, code window, or a
	 * whole-video example like swiss-grid). The skill is told these REFRAME the
	 * footage rather than sit transparently over it.
	 */
	fullFrame?: boolean;
}

export interface HfPromptScope {
	/** What the run targets. */
	kind: "timeline" | "clip" | "nested";
	/** e.g. "the whole timeline", a clip name, or a nested-sequence name. */
	label: string;
	/** Segment bounds on the source timeline, in seconds. */
	startSec: number;
	endSec: number;
}

export interface HfLook {
	name: string;
	description: string;
	accent?: string;
	fontFamily?: string;
}

export interface CompileHyperframesPromptInput {
	/** Enabled assets from the panel (the user's selection). */
	selections: HfSelectionAsset[];
	look?: HfLook;
	/** Free-form text from the HyperFrames prompt box. */
	direction?: string;
	scope: HfPromptScope;
	/** Transcript of the targeted segment, timestamps in seconds, segment-relative. */
	transcript: string;
	canvas: { width: number; height: number; fps: number };
	/**
	 * Plain-language taste learned from how the user edited past AI output
	 * (self-learning store). SOFT guidance — secondary to the explicit direction.
	 */
	preferenceNotes?: string[];
	/**
	 * How many timed graphics to fit in this scope (chunked runs derive this
	 * from the segment length). Without it the model decides on its own — which
	 * is how a whole-video run used to yield a single graphic.
	 */
	densityHint?: string;
	/**
	 * Real registry compositions the user PICKED — their actual HTML, for the
	 * author to adapt (keep the design, retarget the content). Truncated per-comp
	 * by the renderer to stay within the token budget.
	 */
	referenceCompositions?: { name: string; title: string; html: string }[];
	/**
	 * Movement-aware safe-zone instruction from vision speaker detection
	 * (`computeSafeZone`), e.g. "the left third stays clear … place the graphic
	 * there". Present only when Director Vision is on; omitted otherwise so the
	 * brief's robust lower-third default applies. The skill brief honors a named
	 * SPEAKER LOCATION precisely.
	 */
	speakerSafeZone?: string;
}

/**
 * Cap for LOOSE-inspiration reference HTML. Kept modest: the skill only needs the
 * design language (layout, type, color, motion), and a smaller brief authors faster.
 */
const REFERENCE_HTML_MAX_CHARS = 6000;

/**
 * Cap for the BASE composition (the user's chosen style). Larger, because the skill
 * must preserve its <style> block VERBATIM — truncating the CSS would force it to
 * improvise the missing styles, which is exactly the drift we're preventing.
 */
const BASE_HTML_MAX_CHARS = 16000;

function secs(n: number): string {
	return (Math.round(n * 10) / 10).toFixed(1);
}

function renderSelectionGroup(assets: HfSelectionAsset[]): string {
	return assets
		.map((a) => {
			const frame = a.fullFrame ? " [full-frame]" : "";
			const desc = a.description ? ` — ${a.description}` : "";
			return `  - ${a.title} (${a.name})${frame}${desc}`;
		})
		.join("\n");
}

/**
 * Build the `/hyperframes` skill authoring prompt from the panel selections.
 * The output is a single string ready to hand to the skill (or to show the
 * user as the exact prompt that will run).
 */
export function compileHyperframesPrompt(
	input: CompileHyperframesPromptInput,
): string {
	const {
		selections,
		look,
		direction,
		scope,
		transcript,
		canvas,
		preferenceNotes,
		densityHint,
		referenceCompositions,
	} = input;
	const durationSec = Math.max(0, scope.endSec - scope.startSec);

	const lines: string[] = [];

	lines.push(
		`Author a HyperFrames overlay composition for a video editor (VibeCut).`,
	);
	lines.push("");
	lines.push(
		`GOAL: author graphics that HELP THE VIEWER FOLLOW AND RECAP the content. Every graphic must carry INFORMATION the viewer cannot get from the audio alone — a structured summary of the points being made, a chart of data/comparison mentioned, or a diagram that explains a concept. A graphic that only labels what the speaker is already saying is worthless — do NOT make it. These overlay the footage on a NEW transparent track (no opaque full-frame fill unless a selected full-frame asset deliberately reframes the shot).`,
	);
	lines.push("");
	lines.push(`WHAT TO BUILD — pick the form that genuinely helps THIS content:`);
	lines.push(
		`  - RECAP / KEY-POINTS LIST: when the speaker makes several points on a topic, show a 3-5 item list summarizing them so the viewer can follow. Reveal items as each is discussed and keep the list on screen while the topic continues — a running recap, not a single line. Do NOT number the items (no "01/02/03") — the points stand on their own; separate them with a small accent dot, a thin rule, or whitespace.`,
	);
	lines.push(
		`  - DATA CHART: when there are numbers, a comparison, or change over time (scores, dates, before/after, model-vs-model), build an animated chart from the REAL numbers in the transcript — bars, a line, or a progress fill. No pie charts, dashboards, gridlines, legends, or chart-library output; build it with SVG/CSS.`,
	);
	lines.push(
		`  - EXPLANATORY CARD: when a concept needs unpacking, show its structure — a labeled A-vs-B comparison, a before/after, or the parts of the thing.`,
	);
	lines.push(`Prefer FEWER, information-dense graphics, each held long enough to read.`);
	lines.push("");
	lines.push(
		`NEVER author: a segment or section title, a single-label "pill", a numbered "01 / 02 / 03" section break, a generic "KEY POINT" eyebrow card, or anything that merely restates the spoken line. Those add nothing and are banned.`,
	);
	lines.push(
		`RENDER TARGET: ${canvas.width}x${canvas.height} @ ${canvas.fps}fps, total duration ${secs(durationSec)}s. Author every animation seekable and within [0, ${secs(durationSec)}]s — the editor places this composition at ${secs(scope.startSec)}s on ${scope.label}.`,
	);
	if (densityHint?.trim()) {
		lines.push(`DENSITY: ${densityHint.trim()}`);
	}
	if (input.speakerSafeZone?.trim()) {
		lines.push(
			`SPEAKER LOCATION / SAFE ZONE (detected from this clip's footage — honor it precisely; keep the graphic entirely out of the speaker's region): ${input.speakerSafeZone.trim()}`,
		);
	}

	// Selections. ONE pick → use it (the user's deliberate choice, honored — this is
	// what stopped Swiss Grid being silently skipped). MANY picks → a PALETTE: the
	// skill chooses the best-fitting FORM per moment (code → code window, data →
	// chart, several points → recap list), so no single style is forced onto every
	// moment. Examples are LOOKS; blocks are ready GRAPHIC FORMS; components, effects.
	lines.push("");
	const examples = selections.filter((s) => s.kind === "example");
	const blocks = selections.filter((s) => s.kind === "block");
	const components = selections.filter((s) => s.kind === "component" || s.kind === "template");

	if (selections.length > 1) {
		lines.push(
			`ASSET PALETTE — the user selected these as the options for this video. For EACH moment, build the ONE graphic whose FORM best fits the spoken content, chosen from this palette. Pick the best fit EVERY time — do NOT force one asset, and do NOT default to the same look repeatedly; vary it with the content.`,
		);
		if (examples.length) {
			lines.push("");
			lines.push(
				`STYLES / LOOKS (full editorial designs — use one for a recap LIST of several key points, or a data chart in that style):`,
			);
			lines.push(renderSelectionGroup(examples));
		}
		if (blocks.length) {
			lines.push("");
			lines.push(
				`GRAPHIC FORMS (ready-made graphics — use the one whose form matches the content):`,
			);
			lines.push(renderSelectionGroup(blocks));
		}
		if (components.length) {
			lines.push("");
			lines.push(`EFFECTS / SNIPPETS (layer subtly, only when they suit):`);
			lines.push(renderSelectionGroup(components));
		}
		lines.push("");
		lines.push(
			`MATCH BY CONTENT: several points on a topic → a recap LIST in a style; numbers, a trend, or a comparison → a data CHART; code → a code-snippet form; a place or region → the matching map; a social post or app shown on screen → that app's block; a name or quote → a lower-third; a brand/logo → the logo form; a process or decision → a flowchart/decision-tree. A moment with no strong fit gets NOTHING.`,
		);
	} else if (selections.length === 1) {
		const only = selections[0];
		lines.push(
			`SELECTED ASSET — the user explicitly chose "${only.title}" (${only.name}). USE it: build its graphic in its exact design wherever the content fits, and do NOT substitute a different aesthetic. The style is the LOOK, not the layout — within it, build the informative STRUCTURE the content needs (a recap LIST, a real DATA CHART, an explanatory diagram). Where the content does not suit this asset, make NOTHING rather than forcing it.`,
		);
		lines.push(renderSelectionGroup(selections));
	} else {
		lines.push(
			`No specific assets were selected — use your own judgment to add tasteful, INFORMATIVE overlays (recap lists, data charts, explanatory cards) where the transcript warrants them.`,
		);
	}

	// Reference compositions. The PICKED STYLE's composition is the skill's STYLE
	// SOURCE — it must copy the base's design system (fonts, colors, type scale,
	// motion) EXACTLY (anti-drift: this is what stopped the skill inventing a
	// terminal/monospace look), but build the informative STRUCTURE the content
	// needs rather than copy the base's single layout. Others stay loose inspiration.
	const refs = (referenceCompositions ?? []).filter((r) => r.html.trim());
	// A SINGLE chosen example is the STYLE SOURCE (copy its design system exactly).
	// In palette mode the references are real designs to MATCH when that asset is the
	// one chosen for a moment — no single style is forced.
	const baseRef =
		selections.length === 1 && examples.length === 1
			? refs.find((r) => r.name === examples[0].name)
			: undefined;
	const otherRefs = refs.filter((r) => r !== baseRef);

	if (baseRef) {
		const html =
			baseRef.html.length > BASE_HTML_MAX_CHARS
				? `${baseRef.html.slice(0, BASE_HTML_MAX_CHARS)}\n<!-- ...truncated... -->`
				: baseRef.html;
		lines.push("");
		lines.push(
			`STYLE SOURCE — the user's chosen "${baseRef.title}" composition is below. COPY its DESIGN SYSTEM exactly: reuse its font-family declarations, color values, type scale, spacing, and motion language VERBATIM, and use ONLY those — never introduce a different font (no monospace/terminal/code) or a different palette. But do NOT just copy its single layout with new text: BUILD the structure THIS content needs (a 3-5 point recap list, a data chart, a labeled diagram) IN that exact design system. Same design system, right structure — every graphic must still read unmistakably as "${baseRef.title}".`,
		);
		lines.push("");
		lines.push(
			`--- ${baseRef.title} (${baseRef.name}) — STYLE SOURCE: copy its design system, build the right structure ---`,
		);
		lines.push("```html");
		lines.push(html);
		lines.push("```");
	}
	if (otherRefs.length) {
		lines.push("");
		lines.push(
			baseRef
				? `REFERENCE COMPOSITIONS (loose inspiration only — the STYLE SOURCE above wins any conflict):`
				: `REFERENCE DESIGNS — the real design of selected assets. When you choose one of these for a moment, COPY its fonts, colors, and layout exactly (retarget only the content) — never invent a different look for it:`,
		);
		for (const ref of otherRefs) {
			const html =
				ref.html.length > REFERENCE_HTML_MAX_CHARS
					? `${ref.html.slice(0, REFERENCE_HTML_MAX_CHARS)}\n<!-- ...truncated... -->`
					: ref.html;
			lines.push("");
			lines.push(`--- ${ref.title} (${ref.name}) ---`);
			lines.push("```html");
			lines.push(html);
			lines.push("```");
		}
	}

	// Look.
	if (look?.name) {
		lines.push("");
		lines.push(
			`VISUAL LOOK: "${look.name}" — ${look.description}${
				look.accent ? `. Accent color ${look.accent}` : ""
			}${look.fontFamily ? `. Typeface ${look.fontFamily}` : ""}.`,
		);
	}

	// Direction.
	if (direction?.trim()) {
		lines.push("");
		lines.push(
			`USER DIRECTION (follow this even when it overrides the defaults): ${direction.trim()}`,
		);
	}

	// Learned preferences — taste inferred from past edits. Soft guidance, and
	// explicitly subordinate to the user's direction above.
	const notes = (preferenceNotes ?? []).filter((n) => n.trim());
	if (notes.length) {
		lines.push("");
		lines.push(
			`LEARNED PREFERENCES (inferred from how the user edited past AI graphics — apply as SOFT guidance, and let the USER DIRECTION above win any conflict):`,
		);
		for (const note of notes) lines.push(`  - ${note.trim()}`);
	}

	// Transcript.
	lines.push("");
	lines.push(
		`TRANSCRIPT of ${scope.label} (timestamps in seconds, relative to this segment):`,
	);
	lines.push(transcript.trim() || "(no speech in this segment)");

	// Hard requirements.
	lines.push("");
	lines.push("REQUIREMENTS:");
	lines.push(
		"- Transparent background; these are overlays, not a full-frame scene (unless a selected full-frame asset is explicitly used to reframe the footage).",
	);
	lines.push(
		"- Time each graphic to the moment it supports and HOLD it long enough to read (a list or chart needs several seconds on screen). Build it from the REAL content of the transcript — the actual points, numbers, names — never invent data; copy numbers and names EXACTLY as spoken.",
	);
	lines.push(
		"- A recap list = 3-5 short items, not one. A chart = the real values plotted. An explanatory card = the actual comparison. If you cannot make a graphic that adds information beyond the spoken words, make NOTHING for that moment — silence beats a useless title.",
	);
	lines.push(
		"- When overlay text needs contrast, place a solid color bar/box BEHIND the text only — never fill the whole frame.",
	);
	lines.push(
		"- Output a valid, lint-clean HyperFrames composition (index.html) with seekable animations.",
	);

	return lines.join("\n");
}
