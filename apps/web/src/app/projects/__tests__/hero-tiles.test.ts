import { describe, expect, test } from "bun:test";
import {
	AI_TOOL_TILE_IDS,
	deriveHeroTileStates,
	getMostRecentProject,
	HERO_TILE_OPEN_PARAM,
} from "../hero-tiles";

describe("deriveHeroTileStates", () => {
	test("no projects: New project enabled, AI tiles disabled with a hint", () => {
		const states = deriveHeroTileStates({ hasProjects: false });
		const byId = Object.fromEntries(states.map((s) => [s.id, s]));

		expect(byId["new-project"].disabled).toBe(false);
		expect(byId["new-project"].hint).toBeNull();

		for (const id of AI_TOOL_TILE_IDS) {
			expect(byId[id].disabled).toBe(true);
			expect(byId[id].hint).toBe("Create a project first");
		}
	});

	test("has projects: every tile enabled, no hints", () => {
		const states = deriveHeroTileStates({ hasProjects: true });
		for (const state of states) {
			expect(state.disabled).toBe(false);
			expect(state.hint).toBeNull();
		}
	});

	test("returns exactly the four tiles, New project first", () => {
		const states = deriveHeroTileStates({ hasProjects: true });
		expect(states.map((s) => s.id)).toEqual([
			"new-project",
			"ai-cut",
			"transcript",
			"captions",
		]);
	});
});

describe("HERO_TILE_OPEN_PARAM", () => {
	test("maps each AI tile to its editor deep-link param", () => {
		expect(HERO_TILE_OPEN_PARAM["ai-cut"]).toBe("director");
		expect(HERO_TILE_OPEN_PARAM.transcript).toBe("transcript");
		expect(HERO_TILE_OPEN_PARAM.captions).toBe("captions");
	});

	test("New project has no open param (it does not deep-link)", () => {
		expect(HERO_TILE_OPEN_PARAM["new-project"]).toBeUndefined();
	});
});

describe("getMostRecentProject", () => {
	test("returns null for an empty list", () => {
		expect(getMostRecentProject([])).toBeNull();
	});

	test("picks the project with the latest updatedAt, not creation order", () => {
		const older = { id: "a", updatedAt: new Date("2026-01-01") };
		const newest = { id: "b", updatedAt: new Date("2026-06-01") };
		const middle = { id: "c", updatedAt: new Date("2026-03-01") };
		expect(getMostRecentProject([older, newest, middle])).toBe(newest);
	});

	test("a single project is returned as-is", () => {
		const only = { id: "solo", updatedAt: new Date("2026-01-01") };
		expect(getMostRecentProject([only])).toBe(only);
	});
});
