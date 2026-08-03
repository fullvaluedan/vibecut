/**
 * T19.3: turns the stored transition specs on a main track into the RENDER
 * PLAN the scene builder needs - per-element opacity ramps (plus how far each
 * clip may sample outside its own trimmed span), the dip colour layers, and
 * which clips must decode through a secondary video-cache sink.
 *
 * Pure and tick-based, so preview and export get identical numbers from the
 * same call (`buildScene` is the only consumer, and it serves both).
 */

import type { TimelineElement } from "@/timeline/types";
import { TICKS_PER_SECOND } from "@/wasm";
import {
	collectTransitionBoundaries,
	isTransitionCapableElement,
	type TransitionBoundary,
} from "./model";
import { DIP_COLOR_BY_KIND } from "./types";

/**
 * One opacity ramp on one clip.
 *
 * `direction` is what the clip's own alpha does across `[startTicks, endTicks]`:
 * "in" ramps 0 -> 1, "out" ramps 1 -> 0, "dip" ramps 0 -> 1 -> 0 (the colour
 * layer of a dip-to-black/white), "hold" stays at 1. Linear in v1.
 *
 * Why a crossDissolve's OUTGOING side is "hold", not "out": the renderer
 * composites the incoming clip LAST (source-over), so the frame is
 * `U*aU + (L*aL)*(1-aU)`. The flat blend `U*t + L*(1-t)` falls out only when
 * the lower (outgoing) layer holds aL = 1 and the upper (incoming) layer
 * ramps aU = t. Ramping BOTH gives `U*t + L*(1-t)^2` - a 25% luminance dip
 * at the midpoint.
 */
export interface TransitionRamp {
	startTicks: number;
	endTicks: number;
	direction: "in" | "out" | "dip" | "hold";
	/**
	 * Ticks of timeline the clip is allowed to render OUTSIDE its own span,
	 * sampling into trimmed-away source. Non-zero only for a crossDissolve.
	 */
	extendTicks: number;
}

export interface TransitionRoles {
	head?: TransitionRamp;
	tail?: TransitionRamp;
}

export interface TransitionDipLayer {
	key: string;
	color: string;
	startTicks: number;
	durationTicks: number;
	ramp: TransitionRamp;
}

export interface TransitionRenderPlan {
	rolesByElementId: Map<string, TransitionRoles>;
	dipLayers: TransitionDipLayer[];
	/**
	 * Clips that must NOT share the default per-mediaId decode sink, because
	 * the other side of their crossDissolve decodes the same file at a
	 * different time on the same frame (the split-then-crossfade case). See
	 * `services/video-cache/service.ts`.
	 */
	secondarySinkElementIds: Set<string>;
}

export const EMPTY_TRANSITION_PLAN: TransitionRenderPlan = {
	rolesByElementId: new Map(),
	dipLayers: [],
	secondarySinkElementIds: new Set(),
};

function toTicks({ seconds }: { seconds: number }): number {
	return Math.round(seconds * TICKS_PER_SECOND);
}

function setRole({
	plan,
	elementId,
	side,
	ramp,
}: {
	plan: TransitionRenderPlan;
	elementId: string;
	side: "head" | "tail";
	ramp: TransitionRamp;
}): void {
	const roles = plan.rolesByElementId.get(elementId) ?? {};
	roles[side] = ramp;
	plan.rolesByElementId.set(elementId, roles);
}

function planJoin({
	plan,
	boundary,
	byId,
}: {
	plan: TransitionRenderPlan;
	boundary: TransitionBoundary;
	byId: Map<string, TimelineElement>;
}): void {
	const spec = boundary.spec;
	if (!spec) return;
	const totalTicks = toTicks({ seconds: spec.durationSec });
	if (totalTicks <= 0) return;
	const halfTicks = Math.round(totalTicks / 2);
	const startTicks = boundary.timeTicks - halfTicks;
	const endTicks = boundary.timeTicks + halfTicks;

	if (spec.kind === "dipToBlack" || spec.kind === "dipToWhite") {
		const color = DIP_COLOR_BY_KIND[spec.kind];
		if (!color) return;
		plan.dipLayers.push({
			key: `${boundary.key}:${spec.id}`,
			color,
			startTicks,
			durationTicks: endTicks - startTicks,
			ramp: {
				startTicks,
				endTicks,
				direction: "dip",
				extendTicks: 0,
			},
		});
		return;
	}

	if (spec.kind !== "crossDissolve") return;
	if (!boundary.leftElementId || !boundary.rightElementId) return;

	setRole({
		plan,
		elementId: boundary.leftElementId,
		side: "tail",
		ramp: { startTicks, endTicks, direction: "hold", extendTicks: halfTicks },
	});
	setRole({
		plan,
		elementId: boundary.rightElementId,
		side: "head",
		ramp: { startTicks, endTicks, direction: "in", extendTicks: halfTicks },
	});

	// Split-then-crossfade: both sides decode the SAME file at two different
	// times on every frame of the window. One sink per mediaId would thrash
	// (each seek supersedes the other's). Give the right side its own sink.
	const left = byId.get(boundary.leftElementId);
	const right = byId.get(boundary.rightElementId);
	if (
		left?.type === "video" &&
		right?.type === "video" &&
		left.mediaId === right.mediaId
	) {
		plan.secondarySinkElementIds.add(right.id);
	}
}

function planOpenBoundary({
	plan,
	boundary,
	byId,
}: {
	plan: TransitionRenderPlan;
	boundary: TransitionBoundary;
	byId: Map<string, TimelineElement>;
}): void {
	const spec = boundary.spec;
	if (!spec || spec.kind !== "fade") return;
	const element = byId.get(boundary.ownerElementId);
	if (!element) return;

	const totalTicks = toTicks({ seconds: spec.durationSec });
	if (totalTicks <= 0) return;

	if (boundary.kind === "openHead") {
		setRole({
			plan,
			elementId: element.id,
			side: "head",
			ramp: {
				startTicks: element.startTime,
				endTicks: element.startTime + totalTicks,
				direction: "in",
				extendTicks: 0,
			},
		});
		return;
	}

	const endTicks = element.startTime + element.duration;
	setRole({
		plan,
		elementId: element.id,
		side: "tail",
		ramp: {
			startTicks: endTicks - totalTicks,
			endTicks,
			direction: "out",
			extendTicks: 0,
		},
	});
}

export function buildTransitionRenderPlan({
	elements,
}: {
	elements: readonly TimelineElement[];
}): TransitionRenderPlan {
	const plan: TransitionRenderPlan = {
		rolesByElementId: new Map(),
		dipLayers: [],
		secondarySinkElementIds: new Set(),
	};

	const byId = new Map<string, TimelineElement>();
	for (const element of elements) {
		if (isTransitionCapableElement(element)) {
			byId.set(element.id, element);
		}
	}

	for (const boundary of collectTransitionBoundaries({ elements })) {
		if (!boundary.spec) continue;
		if (boundary.kind === "join") {
			planJoin({ plan, boundary, byId });
		} else {
			planOpenBoundary({ plan, boundary, byId });
		}
	}

	return plan;
}
