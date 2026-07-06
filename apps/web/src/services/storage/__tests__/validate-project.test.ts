import { describe, expect, test } from "bun:test";
import {
	isSanitizeReportClean,
	sanitizeLoadedProject,
} from "../validate-project";
import type { TProject } from "@/project/types";

/**
 * P0.3: corrupt persisted data must be dropped/repaired AT LOAD with a
 * report, never left to crash the renderer later.
 */

function element(overrides: Record<string, unknown> = {}) {
	return {
		id: "el-1",
		type: "video",
		name: "clip.mp4",
		startTime: 0,
		duration: 1000,
		trimStart: 0,
		trimEnd: 0,
		params: {},
		...overrides,
	};
}

function makeProject(overrides: Record<string, unknown> = {}): TProject {
	return {
		metadata: {
			id: "p1",
			name: "Test",
			duration: 1000,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
		scenes: [
			{
				id: "s1",
				name: "Main scene",
				isMain: true,
				bookmarks: [],
				createdAt: new Date(),
				updatedAt: new Date(),
				tracks: {
					main: { id: "t-main", name: "V1", type: "video", elements: [element()] },
					overlay: [],
					audio: [],
				},
			},
		],
		currentSceneId: "s1",
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1920, height: 1080 },
		},
		...overrides,
	} as unknown as TProject;
}

function mainElements(project: TProject): unknown[] {
	return (
		project.scenes[0] as unknown as {
			tracks: { main: { elements: unknown[] } };
		}
	).tracks.main.elements;
}

describe("sanitizeLoadedProject", () => {
	test("a healthy project passes through clean", () => {
		const { project, report } = sanitizeLoadedProject({
			project: makeProject(),
		});
		expect(isSanitizeReportClean(report)).toBe(true);
		expect(mainElements(project)).toHaveLength(1);
	});

	test("drops elements with NaN startTime or non-positive duration", () => {
		const input = makeProject();
		mainElements(input).push(
			element({ id: "bad-1", startTime: Number.NaN }),
			element({ id: "bad-2", duration: 0 }),
			element({ id: "bad-3", duration: "oops" }),
		);
		const { project, report } = sanitizeLoadedProject({ project: input });
		expect(mainElements(project)).toHaveLength(1);
		expect(report.droppedElements).toHaveLength(3);
	});

	test("repairs a negative startTime and broken trims instead of dropping", () => {
		const input = makeProject();
		mainElements(input)[0] = element({
			startTime: -50,
			trimStart: Number.NaN,
			trimEnd: -1,
			params: null,
		});
		const { project, report } = sanitizeLoadedProject({ project: input });
		const el = mainElements(project)[0] as Record<string, unknown>;
		expect(el.startTime).toBe(0);
		expect(el.trimStart).toBe(0);
		expect(el.trimEnd).toBe(0);
		expect(el.params).toEqual({});
		expect(report.droppedElements).toHaveLength(0);
		expect(report.repairedFields).toBe(4);
	});

	test("rebuilds a missing tracks container and repairs currentSceneId", () => {
		const input = makeProject({ currentSceneId: "nope" });
		(input.scenes[0] as unknown as { tracks: unknown }).tracks = "garbage";
		const { project, report } = sanitizeLoadedProject({ project: input });
		const tracks = (
			project.scenes[0] as unknown as {
				tracks: { main: { elements: unknown[] } ; overlay: unknown[]; audio: unknown[] };
			}
		).tracks;
		expect(tracks.main.elements).toEqual([]);
		expect(tracks.overlay).toEqual([]);
		expect(tracks.audio).toEqual([]);
		expect(project.currentSceneId).toBe("s1");
		expect(report.rebuilt.length).toBeGreaterThan(0);
	});

	test("a project with zero usable scenes gets a fresh empty one", () => {
		const input = makeProject({ scenes: ["not-a-scene", null] });
		const { project, report } = sanitizeLoadedProject({ project: input });
		expect(project.scenes).toHaveLength(1);
		expect(project.currentSceneId).toBe(project.scenes[0].id);
		expect(report.rebuilt.length).toBeGreaterThan(0);
	});

	test("repairs unusable fps and canvasSize", () => {
		const input = makeProject({
			// fps as a raw number is the WRONG persisted shape (FrameRate is an
			// object) — the sanitizer must repair it, not accept it.
			settings: { fps: 0, canvasSize: { width: Number.NaN, height: 1080 } },
		});
		const { project, report } = sanitizeLoadedProject({ project: input });
		expect(project.settings.fps.numerator).toBeGreaterThan(0);
		expect(project.settings.fps.denominator).toBeGreaterThan(0);
		expect(project.settings.canvasSize.width).toBeGreaterThan(0);
		expect(report.repairedFields).toBe(2);
	});

	test("a valid non-default frame rate is NOT clobbered", () => {
		const input = makeProject({
			settings: {
				fps: { numerator: 24000, denominator: 1001 },
				canvasSize: { width: 1920, height: 1080 },
			},
		});
		const { project, report } = sanitizeLoadedProject({ project: input });
		expect(project.settings.fps).toEqual({
			numerator: 24000,
			denominator: 1001,
		});
		expect(isSanitizeReportClean(report)).toBe(true);
	});
});
