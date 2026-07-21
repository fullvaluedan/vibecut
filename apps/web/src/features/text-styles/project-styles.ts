import type { ParamValue } from "@/params";
import type { TProject } from "@/project/types";
import { isTextStyleParamKey } from "./style-param-keys";
import type { TextStyle } from "./types";

/**
 * Text styles ride the project record itself (`TProject.textStyles`), so they
 * are saved by the same autosave, loaded by the same `loadProject`, and stay
 * with the project when it is duplicated. The field is optional, so every read
 * goes through `readTextStyles` and every project that predates the feature
 * simply reads as an empty list.
 */
export function readTextStyles({
	project,
}: {
	project: Pick<TProject, "textStyles"> | null | undefined;
}): TextStyle[] {
	return project?.textStyles ?? [];
}

export function findTextStyle({
	project,
	styleId,
}: {
	project: Pick<TProject, "textStyles"> | null | undefined;
	styleId: string;
}): TextStyle | undefined {
	return readTextStyles({ project }).find((style) => style.id === styleId);
}

/**
 * Same name saved twice REPLACES the earlier record rather than stacking a
 * duplicate, so the dropdown never shows two identical-looking entries.
 */
export function addTextStyle<TProjectLike extends Pick<TProject, "textStyles">>({
	project,
	style,
}: {
	project: TProjectLike;
	style: TextStyle;
}): TProjectLike {
	const existing = readTextStyles({ project });
	const withoutSameName = existing.filter(
		(saved) => saved.name.trim().toLowerCase() !== style.name.trim().toLowerCase(),
	);
	return { ...project, textStyles: [...withoutSameName, style] };
}

export function removeTextStyle<
	TProjectLike extends Pick<TProject, "textStyles">,
>({
	project,
	styleId,
}: {
	project: TProjectLike;
	styleId: string;
}): TProjectLike {
	return {
		...project,
		textStyles: readTextStyles({ project }).filter(
			(style) => style.id !== styleId,
		),
	};
}

function isParamValue(value: unknown): value is ParamValue {
	return (
		typeof value === "number" ||
		typeof value === "string" ||
		typeof value === "boolean"
	);
}

/**
 * Defensive read of whatever came back out of storage, mirroring how
 * `normalizeBookmarks` guards the bookmark array in the storage service.
 * Anything that is not a usable style record is dropped rather than crashing
 * the project load, and unknown param keys are stripped so a hand-edited
 * record can never smuggle position or content into an appearance style.
 */
export function normalizeTextStyles({ raw }: { raw: unknown }): TextStyle[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((item): TextStyle | null => {
			if (typeof item !== "object" || item === null) return null;
			const record = item as Record<string, unknown>;
			if (typeof record.id !== "string" || !record.id) return null;
			if (typeof record.name !== "string" || !record.name) return null;

			const params: Record<string, ParamValue> = {};
			if (typeof record.params === "object" && record.params !== null) {
				for (const [key, value] of Object.entries(
					record.params as Record<string, unknown>,
				)) {
					if (!isTextStyleParamKey({ key })) continue;
					if (!isParamValue(value)) continue;
					params[key] = value;
				}
			}

			return {
				id: record.id,
				name: record.name,
				params,
				createdAt:
					typeof record.createdAt === "string"
						? record.createdAt
						: new Date(0).toISOString(),
			};
		})
		.filter((style): style is TextStyle => style !== null);
}
