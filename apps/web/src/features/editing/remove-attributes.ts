/**
 * Premiere's "Remove Attributes": resets chosen property groups on a clip
 * back to their defaults and deletes their keyframes. One undo step.
 */

import type { EditorCore } from "@/core";
import type { TimelineElement } from "@/timeline";
import type { ElementAnimations } from "@/animation/types";
import { UpdateElementsCommand } from "@/commands/timeline/element/update-elements";
import {
	getElementParams,
	writeElementParamValue,
} from "@/params/registry";

export type AttributeGroup = "motion" | "opacity" | "audio";

const GROUP_PARAM_KEYS: Record<AttributeGroup, string[]> = {
	motion: [
		"transform.positionX",
		"transform.positionY",
		"transform.scaleX",
		"transform.scaleY",
		"transform.rotate",
	],
	opacity: ["opacity"],
	audio: ["volume", "muted"],
};

export function removeAttributes({
	editor,
	trackId,
	element,
	groups,
}: {
	editor: EditorCore;
	trackId: string;
	element: TimelineElement;
	groups: AttributeGroup[];
}): void {
	const keys = new Set(groups.flatMap((g) => GROUP_PARAM_KEYS[g]));
	const params = getElementParams({ element });

	let next: TimelineElement = element;
	for (const param of params) {
		if (!keys.has(param.key)) continue;
		next = writeElementParamValue({ element: next, param, value: param.default });
	}

	// Drop keyframes for the affected property paths.
	if (next.animations) {
		const animations: ElementAnimations = {};
		for (const [path, channel] of Object.entries(next.animations)) {
			if (!keys.has(path)) animations[path] = channel;
		}
		next = { ...next, animations };
	}

	editor.command.execute({
		command: new UpdateElementsCommand({
			updates: [{ trackId, elementId: element.id, patch: next }],
		}),
	});
}

/** Clears every keyframe on the clip but keeps current base values. */
export function removeAllKeyframes({
	editor,
	trackId,
	element,
}: {
	editor: EditorCore;
	trackId: string;
	element: TimelineElement;
}): void {
	editor.command.execute({
		command: new UpdateElementsCommand({
			updates: [
				{ trackId, elementId: element.id, patch: { animations: {} } },
			],
		}),
	});
}
