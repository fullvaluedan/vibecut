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
	test("a single picked style + matching reference embeds the HTML as STYLE SOURCE", () => {
		const out = compileHyperframesPrompt(
			baseInput({
				selections: [
					{ name: "swiss-grid", kind: "example", title: "Swiss Grid" },
				],
				referenceCompositions: [
					{ name: "swiss-grid", title: "Swiss Grid", html: "<html>GRID-LAYOUT</html>" },
				],
			}),
		);
		expect(out).toContain("STYLE SOURCE");
		expect(out).toContain("Swiss Grid (swiss-grid)");
		expect(out).toContain("GRID-LAYOUT");
	});

	test("a reference is NOT embedded without a single-example selection (palette names assets instead)", () => {
		const out = compileHyperframesPrompt(
			baseInput({
				referenceCompositions: [
					{ name: "swiss-grid", title: "Swiss Grid", html: "<html>GRID-LAYOUT</html>" },
				],
			}),
		);
		expect(out).not.toContain("STYLE SOURCE");
		expect(out).not.toContain("GRID-LAYOUT");
	});

	test("omits embedding when none are picked", () => {
		expect(compileHyperframesPrompt(baseInput())).not.toContain("STYLE SOURCE");
		expect(
			compileHyperframesPrompt(baseInput({ referenceCompositions: [] })),
		).not.toContain("STYLE SOURCE");
	});

	test("truncates very long STYLE SOURCE HTML", () => {
		const huge = "x".repeat(20000);
		const out = compileHyperframesPrompt(
			baseInput({
				selections: [{ name: "big", kind: "example", title: "Big" }],
				referenceCompositions: [{ name: "big", title: "Big", html: huge }],
			}),
		);
		expect(out).toContain("truncated");
		expect(out).not.toContain("x".repeat(20000));
	});

	test("STYLE SOURCE first, then loose-inspiration references, in order", () => {
		const out = compileHyperframesPrompt(
			baseInput({
				selections: [{ name: "a", kind: "example", title: "Alpha" }],
				referenceCompositions: [
					{ name: "a", title: "Alpha", html: "AAA" },
					{ name: "b", title: "Beta", html: "BBB" },
				],
			}),
		);
		expect(out).toContain("Alpha (a)");
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
		// Only the one real note is bulleted under the LEARNED PREFERENCES heading
		// (slice past the GOAL's WHAT-TO-BUILD bullets, which also use "  - ").
		const prefSection = out.slice(out.indexOf("LEARNED PREFERENCES"));
		expect(prefSection.match(/\n {2}- /g)?.length).toBe(1);
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

describe("compileHyperframesPrompt — single pick honored, many = palette (no hardcoded style)", () => {
	const swiss = {
		name: "swiss-grid",
		kind: "example" as const,
		title: "Swiss Grid",
		fullFrame: true,
	};
	const dataChart = {
		name: "data-chart",
		kind: "block" as const,
		title: "Data Chart",
	};
	const codeSnippet = {
		name: "code-snippet",
		kind: "block" as const,
		title: "Code Snippet",
	};

	test("a SINGLE picked asset is honored — used, never skipped", () => {
		const out = compileHyperframesPrompt(baseInput({ selections: [swiss] }));
		expect(out).toContain("SELECTED ASSET");
		expect(out).toContain('"Swiss Grid"');
		expect(out).toContain("USE it");
		expect(out).not.toContain("ASSET PALETTE");
	});

	test("a single picked BLOCK is also honored (not demoted to a helper)", () => {
		const out = compileHyperframesPrompt(baseInput({ selections: [dataChart] }));
		expect(out).toContain("SELECTED ASSET");
		expect(out).toContain('"Data Chart"');
		expect(out).not.toContain("ASSET PALETTE");
	});

	test("MANY picks form a PALETTE the skill chooses from per moment — no forced style", () => {
		const out = compileHyperframesPrompt(
			baseInput({ selections: [swiss, dataChart, codeSnippet] }),
		);
		expect(out).toContain("ASSET PALETTE");
		expect(out).toContain("STYLES / LOOKS");
		expect(out).toContain("GRAPHIC FORMS");
		expect(out).toContain("MATCH BY CONTENT");
		expect(out).toContain("Swiss Grid (swiss-grid)");
		expect(out).toContain("Data Chart (data-chart)");
		expect(out).toContain("Code Snippet (code-snippet)");
		// No single style forced — the old swiss-grid-hardcode framing is gone.
		expect(out).not.toContain("PRIMARY STYLE");
	});

	test("the palette must not be forced onto every moment", () => {
		const out = compileHyperframesPrompt(
			baseInput({ selections: [swiss, dataChart] }),
		);
		expect(out).toContain("do NOT force one asset");
		expect(out).toContain("A moment with no strong fit gets NOTHING");
	});
});

describe("compileHyperframesPrompt — picked style is the STYLE SOURCE (design copied, structure free)", () => {
	const swissSel = {
		name: "swiss-grid",
		kind: "example" as const,
		title: "Swiss Grid",
		fullFrame: true,
	};
	const swissRef = {
		name: "swiss-grid",
		title: "Swiss Grid",
		html: "<style>.x{font-family:Helvetica}</style><div>GRID-CONTENT</div>",
	};

	test("a picked style with a matching reference becomes the STYLE SOURCE (copy the design system, build the right structure)", () => {
		const out = compileHyperframesPrompt(
			baseInput({ selections: [swissSel], referenceCompositions: [swissRef] }),
		);
		expect(out).toContain("STYLE SOURCE");
		expect(out).toContain("COPY its DESIGN SYSTEM exactly");
		expect(out).toContain("BUILD the structure THIS content needs");
		expect(out).toContain("font-family:Helvetica"); // the base HTML is embedded
		// Must NOT carry the old "informed by, do not place verbatim" license.
		expect(out).not.toContain("do NOT place them verbatim");
	});

	test("a reference WITHOUT a single-example selection is not embedded at all", () => {
		const out = compileHyperframesPrompt(
			baseInput({ referenceCompositions: [swissRef] }),
		);
		expect(out).not.toContain("STYLE SOURCE");
		expect(out).not.toContain("font-family:Helvetica"); // html not embedded
	});

	test("non-primary references stay inspiration alongside the STYLE SOURCE", () => {
		const out = compileHyperframesPrompt(
			baseInput({
				selections: [swissSel],
				referenceCompositions: [
					swissRef,
					{ name: "nyt-graph", title: "NYT Graph", html: "<div>NYT</div>" },
				],
			}),
		);
		expect(out).toContain("STYLE SOURCE");
		expect(out).toContain("REFERENCE COMPOSITIONS (loose inspiration");
		expect(out).toContain("NYT Graph (nyt-graph)");
	});
});

describe("compileHyperframesPrompt — informative substance, not title pills", () => {
	test("GOAL demands information beyond the audio + lists the substantive forms", () => {
		const out = compileHyperframesPrompt(baseInput());
		expect(out).toContain("HELP THE VIEWER FOLLOW AND RECAP");
		expect(out).toContain("WHAT TO BUILD");
		expect(out).toContain("RECAP / KEY-POINTS LIST");
		expect(out).toContain("DATA CHART");
		expect(out).toContain("EXPLANATORY CARD");
	});

	test("the GOAL hard-bans segment titles, pills, and numbered section breaks", () => {
		const out = compileHyperframesPrompt(baseInput());
		expect(out).toContain("NEVER author");
		expect(out).toContain("single-label");
		expect(out).toContain('"01 / 02 / 03"');
		expect(out).toContain('"KEY POINT"');
	});

	test("requirements demand real data + bar a graphic that just restates the line", () => {
		const out = compileHyperframesPrompt(baseInput());
		expect(out).toContain("never invent data");
		expect(out).toContain("silence beats a useless title");
	});
});
