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
}

function secs(n: number): string {
	return (Math.round(n * 10) / 10).toFixed(1);
}

function groupHeading(kind: HfSelectionAsset["kind"]): string {
	switch (kind) {
		case "template":
			return "Motion templates (transparent text/graphic overlays)";
		case "block":
			return "Blocks (self-contained graphics)";
		case "component":
			return "Components (effect snippets to layer in)";
		case "example":
			return "Whole-video templates (they REFRAME the footage into a designed layout)";
	}
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
	const { selections, look, direction, scope, transcript, canvas } = input;
	const durationSec = Math.max(0, scope.endSec - scope.startSec);

	const lines: string[] = [];

	lines.push(
		`Author a HyperFrames overlay composition for a video editor (VibeCut).`,
	);
	lines.push("");
	lines.push(
		`GOAL: graphics that sit OVER existing footage as a NEW overlay track. The composition's background MUST be fully transparent (no opaque full-frame fill) so the footage shows through — EXCEPT where a selected full-frame asset is deliberately used to reframe the shot.`,
	);
	lines.push(
		`RENDER TARGET: ${canvas.width}x${canvas.height} @ ${canvas.fps}fps, total duration ${secs(durationSec)}s. Author every animation seekable and within [0, ${secs(durationSec)}]s — the editor places this composition at ${secs(scope.startSec)}s on ${scope.label}.`,
	);

	// Selections — grouped by kind, framed as preferences.
	lines.push("");
	if (selections.length) {
		lines.push(
			`SELECTED ASSETS (the user checked these in the HyperFrames panel). Treat them as PREFERENCES, not a checklist: use your best judgment, fit them to the spoken moments below, and SKIP any that don't suit the content. You do not have to use all of them.`,
		);
		const order: HfSelectionAsset["kind"][] = [
			"template",
			"block",
			"component",
			"example",
		];
		for (const kind of order) {
			const group = selections.filter((s) => s.kind === kind);
			if (!group.length) continue;
			lines.push("");
			lines.push(`${groupHeading(kind)}:`);
			lines.push(renderSelectionGroup(group));
		}
	} else {
		lines.push(
			`No specific assets were selected — use your own judgment to add tasteful overlays (lower-thirds, kinetic titles, callouts) where the transcript warrants them.`,
		);
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
		"- Time each graphic to the spoken moment it supports. Keep on-screen text short (titles ≤ 5 words). Copy any numbers EXACTLY as spoken.",
	);
	lines.push(
		"- When overlay text needs contrast, place a solid color bar/box BEHIND the text only — never fill the whole frame.",
	);
	lines.push(
		"- Output a valid, lint-clean HyperFrames composition (index.html) with seekable animations.",
	);

	return lines.join("\n");
}
