import { describe, expect, test } from "bun:test";
import {
	HIDDEN_ASSET_TABS,
	HIDE_RUN_HYPERFRAMES_CLUSTER,
	HIDE_RUN_HYPERFRAMES_CONTEXT_MENU_ITEM,
	HIDE_ASSISTANT_PROMPT,
	HIDE_HYPERFRAMES_DRAFTS_PANEL,
	HIDE_AUTO_ASSEMBLE_ACTION,
	HIDE_HIGHLIGHT_ACTION,
} from "@/features/editing/surface-flags";

describe("surface-flags defaults (Dan's 2026-07-19 roadmap decision D4/D6, W2)", () => {
	test("the hidden left-panel tab list is empty (T20.4: hyperframes unhidden with the redesigned start flow)", () => {
		expect(HIDDEN_ASSET_TABS).toEqual([]);
	});

	test("kept-visible tabs are never in the hidden list", () => {
		for (const kept of [
			"media",
			"text",
			"shapes",
			"captions",
			"transcript",
			"settings",
			"sounds",
			"effects",
			"hyperframes",
		] as const) {
			expect(HIDDEN_ASSET_TABS).not.toContain(kept);
		}
	});

	test("every HyperFrames generation surface is shown (T20.4 un-park after profiles + the probe-first flow)", () => {
		expect(HIDE_RUN_HYPERFRAMES_CLUSTER).toBe(false);
		expect(HIDE_RUN_HYPERFRAMES_CONTEXT_MENU_ITEM).toBe(false);
		expect(HIDE_HYPERFRAMES_DRAFTS_PANEL).toBe(false);
	});

	test("the assistant prompt flag is retired (T17.3): the surface is now the Assistant mini-prompt, shown", () => {
		expect(HIDE_ASSISTANT_PROMPT).toBe(false);
	});

	test("AI CUT slims to two options: Auto-assemble and Highlight default hidden (roadmap D2)", () => {
		expect(HIDE_AUTO_ASSEMBLE_ACTION).toBe(true);
		expect(HIDE_HIGHLIGHT_ACTION).toBe(true);
	});
});
