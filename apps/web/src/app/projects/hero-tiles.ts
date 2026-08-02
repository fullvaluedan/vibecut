/**
 * T18.5: the VibeCut home page's hero row of CapCut-style entry tiles.
 * "New project" always works; the three AI tiles ("AI Cut", "Edit by
 * transcript", "Auto captions") deep-link into the most recently updated
 * project and need at least one saved project to have somewhere to go, so
 * they render disabled with a hint until one exists. Pure state derivation,
 * unit-testable without mounting the page.
 */

export type HeroTileId = "new-project" | "ai-cut" | "transcript" | "captions";

export interface HeroTileState {
	id: HeroTileId;
	disabled: boolean;
	hint: string | null;
}

const NO_PROJECTS_HINT = "Create a project first";

/** "New project" is exempt (index 0); the rest need `hasProjects`. */
export const AI_TOOL_TILE_IDS: readonly HeroTileId[] = [
	"ai-cut",
	"transcript",
	"captions",
];

export function deriveHeroTileStates({
	hasProjects,
}: {
	hasProjects: boolean;
}): HeroTileState[] {
	return [
		{ id: "new-project", disabled: false, hint: null },
		...AI_TOOL_TILE_IDS.map(
			(id): HeroTileState => ({
				id,
				disabled: !hasProjects,
				hint: hasProjects ? null : NO_PROJECTS_HINT,
			}),
		),
	];
}

/** `?open=` query param each AI tile deep-links the most recent project with. */
export const HERO_TILE_OPEN_PARAM: Partial<Record<HeroTileId, string>> = {
	"ai-cut": "director",
	transcript: "transcript",
	captions: "captions",
};

/**
 * The AI tiles open the most recently UPDATED project (not created), since
 * that is the one the user was probably just working on. Pure: takes
 * whatever `updatedAt` field the caller has (Date, so `.getTime()` sorts).
 */
export function getMostRecentProject<T extends { updatedAt: Date }>(
	projects: readonly T[],
): T | null {
	if (projects.length === 0) return null;
	return projects.reduce((mostRecent, project) =>
		project.updatedAt.getTime() > mostRecent.updatedAt.getTime()
			? project
			: mostRecent,
	);
}
