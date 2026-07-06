import type { TProject } from "@/project/types";
import type {
	AudioTrack,
	OverlayTrack,
	SceneTracks,
	TimelineElement,
	VideoTrack,
} from "@/timeline";
import { buildEmptyTrack } from "@/timeline/placement";
import { buildDefaultScene } from "@/timeline/scenes";
import { DEFAULT_CANVAS_SIZE } from "@/canvas/sizes";
import { DEFAULT_FPS } from "@/fps/defaults";
import { generateUUID } from "@/utils/id";

/**
 * Load-time guard for persisted projects (roadmap P0.3). IndexedDB data has
 * no schema gate, so a corrupt field (a NaN startTime, a string duration, a
 * missing tracks object) used to load "fine" and crash later, deep in the
 * renderer, with no hint of which clip was bad. This sanitizes the loaded
 * project instead: obviously-broken elements are DROPPED (and reported so the
 * UI can warn), repairable fields are repaired, and structural holes are
 * rebuilt empty rather than left to explode.
 *
 * Deliberately hand-rolled and structural (not a full zod mirror of the
 * TimelineElement union): the renderer tolerates unknown params, what kills
 * it is non-finite timing math and missing containers. Validating exactly
 * that keeps this cheap and drift-proof.
 */

export interface SanitizeReport {
	/** Elements removed because they could not be made safe. */
	droppedElements: { name: string; reason: string }[];
	/** Count of fields repaired in place (clamped times, zeroed trims, ...). */
	repairedFields: number;
	/** Structural rebuilds (missing tracks container, empty scenes, ...). */
	rebuilt: string[];
}

export function isSanitizeReportClean(report: SanitizeReport): boolean {
	return (
		report.droppedElements.length === 0 &&
		report.repairedFields === 0 &&
		report.rebuilt.length === 0
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

export function sanitizeLoadedProject({
	project,
}: {
	project: TProject;
}): { project: TProject; report: SanitizeReport } {
	const report: SanitizeReport = {
		droppedElements: [],
		repairedFields: 0,
		rebuilt: [],
	};

	// --- settings the render math divides by ---------------------------------
	const settings = isRecord(project.settings)
		? project.settings
		: ({} as TProject["settings"]);
	// fps is a FrameRate OBJECT ({numerator, denominator}), not a number.
	const fps = isRecord(settings.fps) ? settings.fps : null;
	if (
		!fps ||
		!isFiniteNumber(fps.numerator) ||
		!isFiniteNumber(fps.denominator) ||
		fps.numerator <= 0 ||
		fps.denominator <= 0
	) {
		settings.fps = { ...DEFAULT_FPS };
		report.repairedFields++;
	}
	const canvas = isRecord(settings.canvasSize) ? settings.canvasSize : null;
	if (
		!canvas ||
		!isFiniteNumber(canvas.width) ||
		!isFiniteNumber(canvas.height) ||
		canvas.width <= 0 ||
		canvas.height <= 0
	) {
		settings.canvasSize = { ...DEFAULT_CANVAS_SIZE };
		report.repairedFields++;
	}

	// --- scenes / tracks / elements -------------------------------------------
	let scenes = Array.isArray(project.scenes) ? project.scenes : [];
	scenes = scenes.filter((scene) => {
		if (!isRecord(scene) || typeof scene.id !== "string") {
			report.rebuilt.push("dropped a malformed scene");
			return false;
		}
		return true;
	});

	for (const scene of scenes) {
		scene.tracks = sanitizeTracks({
			tracks: scene.tracks,
			sceneName: typeof scene.name === "string" ? scene.name : scene.id,
			report,
		});
	}

	if (scenes.length === 0) {
		scenes = [buildDefaultScene({ name: "Main scene", isMain: true })];
		report.rebuilt.push("project had no usable scenes; created an empty one");
	}

	let currentSceneId = project.currentSceneId;
	if (!scenes.some((scene) => scene.id === currentSceneId)) {
		currentSceneId = scenes[0].id;
		report.repairedFields++;
	}

	return {
		project: { ...project, scenes, currentSceneId, settings },
		report,
	};
}

function sanitizeTracks({
	tracks,
	sceneName,
	report,
}: {
	tracks: unknown;
	sceneName: string;
	report: SanitizeReport;
}): SceneTracks {
	if (!isRecord(tracks)) {
		report.rebuilt.push(`scene "${sceneName}" had no tracks; rebuilt empty`);
		return {
			main: buildEmptyTrack({ id: generateUUID(), type: "video" }),
			overlay: [],
			audio: [],
		};
	}

	const main = sanitizeTrack({ track: tracks.main, report }) as VideoTrack | null;
	const overlay = (Array.isArray(tracks.overlay) ? tracks.overlay : [])
		.map((track) => sanitizeTrack({ track, report }))
		.filter(Boolean) as OverlayTrack[];
	const audio = (Array.isArray(tracks.audio) ? tracks.audio : [])
		.map((track) => sanitizeTrack({ track, report }))
		.filter(Boolean) as AudioTrack[];

	if (!main) {
		report.rebuilt.push(
			`scene "${sceneName}" had a malformed main track; rebuilt empty`,
		);
	}
	return {
		main: main ?? buildEmptyTrack({ id: generateUUID(), type: "video" }),
		overlay,
		audio,
	};
}

function sanitizeTrack({
	track,
	report,
}: {
	track: unknown;
	report: SanitizeReport;
}): { id: string; elements: unknown[] } | null {
	if (!isRecord(track) || typeof track.id !== "string") {
		return null;
	}
	const rawElements = Array.isArray(track.elements) ? track.elements : [];
	if (!Array.isArray(track.elements)) {
		report.repairedFields++;
	}
	track.elements = rawElements.filter((element) =>
		sanitizeElement({ element, report }),
	);
	return track as { id: string; elements: TimelineElement[] };
}

/** True = keep (possibly repaired in place); false = drop and report. */
function sanitizeElement({
	element,
	report,
}: {
	element: unknown;
	report: SanitizeReport;
}): boolean {
	const drop = (name: string, reason: string) => {
		report.droppedElements.push({ name, reason });
		return false;
	};

	if (!isRecord(element)) return drop("(unknown)", "not an object");
	const name =
		typeof element.name === "string" ? element.name : String(element.id ?? "?");
	if (typeof element.id !== "string" || element.id.length === 0) {
		return drop(name, "missing id");
	}
	if (typeof element.type !== "string" || element.type.length === 0) {
		return drop(name, "missing type");
	}
	// Timing math is where corrupt data kills the renderer.
	if (!isFiniteNumber(element.duration) || element.duration <= 0) {
		return drop(name, `invalid duration (${String(element.duration)})`);
	}
	if (!isFiniteNumber(element.startTime)) {
		return drop(name, `invalid startTime (${String(element.startTime)})`);
	}
	// Repairable: clamp a negative start, zero broken trims, default params.
	if (element.startTime < 0) {
		element.startTime = 0;
		report.repairedFields++;
	}
	for (const key of ["trimStart", "trimEnd"] as const) {
		if (!isFiniteNumber(element[key]) || (element[key] as number) < 0) {
			element[key] = 0;
			report.repairedFields++;
		}
	}
	if (!isRecord(element.params)) {
		element.params = {};
		report.repairedFields++;
	}
	return true;
}
