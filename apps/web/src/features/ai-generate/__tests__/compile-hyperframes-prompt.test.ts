import { describe, expect, test } from "bun:test";
import {
	compileHyperframesPrompt,
	type CompileHyperframesPromptInput,
} from "../compile-hyperframes-prompt";

function baseInput(
	over: Partial<CompileHyperframesPromptInput> = {},
): CompileHyperframesPromptInput {
	return {
		selections: [],
		scope: { kind: "clip", label: 'clip "Intro"', startSec: 2, endSec: 7 },
		transcript: "[0.0–2.0] Hello there",
		canvas: { width: 1920, height: 1080, fps: 30 },
		...over,
	};
}

describe("compileHyperframesPrompt — reference compositions", () => {
	test("embeds picked assets' HTML under a REFERENCE COMPOSITIONS heading", () => {
		const out = compileHyperframesPrompt(
			baseInput({
				referenceCompositions: [
					{
						name: "swiss-grid",
						title: "Swiss Grid",
						html: "<html>GRID-LAYOUT</html>",
					},
				],
			}),
		);
		expect(out).toContain("REFERENCE COMPOSITIONS");
		expect(out).toContain("Swiss Grid (swiss-grid)");
		expect(out).toContain("GRID-LAYOUT");
	});

	test("omits the section when none are picked", () => {
		expect(compileHyperframesPrompt(baseInput())).not.toContain(
			"REFERENCE COMPOSITIONS",
		);
		expect(
			compileHyperframesPrompt(baseInput({ referenceCompositions: [] })),
		).not.toContain("REFERENCE COMPOSITIONS");
	});

	test("truncates very long composition HTML", () => {
		const huge = "x".repeat(20000);
		const out = compileHyperframesPrompt(
			baseInput({
				referenceCompositions: [{ name: "big", title: "Big", html: huge }],
			}),
		);
		expect(out).toContain("truncated");
		expect(out).not.toContain("x".repeat(20000));
	});

	test("embeds multiple reference compositions in order", () => {
		const out = compileHyperframesPrompt(
			baseInput({
				referenceCompositions: [
					{ name: "a", title: "Alpha", html: "AAA" },
					{ name: "b", title: "Beta", html: "BBB" },
				],
			}),
		);
		expect(out).toContain("--- Alpha (a) ---");
		expect(out).toContain("--- Beta (b) ---");
		expect(out.indexOf("Alpha")).toBeLessThan(out.indexOf("Beta"));
		expect(out).toContain("AAA");
		expect(out).toContain("BBB");
	});
});

describe("compileHyperframesPrompt — learned preferences", () => {
	test("renders a LEARNED PREFERENCES section with each note", () => {
		const out = compileHyperframesPrompt(
			baseInput({
				preferenceNotes: [
					"The user removed 3 of the last 4 authored graphics — be more selective.",
					'Avoid "kinetic-type" unless it is clearly the best fit.',
				],
			}),
		);
		expect(out).toContain("LEARNED PREFERENCES");
		expect(out).toContain("be more selective");
		expect(out).toContain('Avoid "kinetic-type"');
	});

	test("omits the section entirely when there are no notes", () => {
		expect(compileHyperframesPrompt(baseInput())).not.toContain(
			"LEARNED PREFERENCES",
		);
		expect(
			compileHyperframesPrompt(baseInput({ preferenceNotes: [] })),
		).not.toContain("LEARNED PREFERENCES");
	});

	test("drops blank/whitespace-only notes", () => {
		const out = compileHyperframesPrompt(
			baseInput({ preferenceNotes: ["  ", "", "real note"] }),
		);
		expect(out).toContain("LEARNED PREFERENCES");
		expect(out).toContain("real note");
		// Only the one real note is bulleted under the heading.
		expect(out.match(/\n {2}- /g)?.length).toBe(1);
	});

	test("preferences are framed as subordinate to the user direction", () => {
		const out = compileHyperframesPrompt(
			baseInput({
				direction: "Bold red titles only",
				preferenceNotes: ["keep it minimal"],
			}),
		);
		// Direction still present, and prefs explicitly defer to it.
		expect(out).toContain("USER DIRECTION");
		expect(out).toContain("let the USER DIRECTION above win any conflict");
	});
});

describe("compileHyperframesPrompt — density hint", () => {
	test("emits a DENSITY line when a hint is given", () => {
		const out = compileHyperframesPrompt(
			baseInput({
				densityHint: "Aim for ~6 timed graphics across this 80s segment.",
			}),
		);
		expect(out).toContain(
			"DENSITY: Aim for ~6 timed graphics across this 80s segment.",
		);
	});

	test("omits the DENSITY line when no hint is given", () => {
		expect(compileHyperframesPrompt(baseInput())).not.toContain("DENSITY:");
	});
});
