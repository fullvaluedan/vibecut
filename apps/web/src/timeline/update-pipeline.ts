import { clampAnimationsToDuration } from "@/animation";
import { retimeTemplateAnimations } from "@/animation/template-retime";
import {
	clampRetimeRate,
	getSourceSpanAtClipTime,
	getTimelineDurationForSourceSpan,
} from "@/retime";
import type { RetimeConfig, SceneTracks, TimelineElement } from "@/timeline";
import { isRetimableElement } from "@/timeline";
import { isUnderHeadGravity } from "@/timeline/head-gravity";
import { ZERO_MEDIA_TIME, roundMediaTime } from "@/wasm";

type ElementUpdateField = keyof TimelineElement | string;

export interface ElementUpdateContext {
	tracks: SceneTracks;
	trackId: string;
}

interface ElementUpdateRuleResult {
	element: TimelineElement;
	changedFields?: ElementUpdateField[];
}

interface ElementUpdateRuleParams {
	element: TimelineElement;
	originalElement: TimelineElement;
	patch: Partial<TimelineElement>;
	context: ElementUpdateContext;
}

interface ElementUpdateRule {
	triggers: ElementUpdateField[];
	apply: (params: ElementUpdateRuleParams) => ElementUpdateRuleResult;
}

const deriveRules: ElementUpdateRule[] = [
	{
		triggers: ["retime"],
		apply: ({ element, originalElement, patch }) => {
			if (!("retime" in patch) || !isRetimableElement(element)) {
				return { element };
			}

			const nextRetime = patch.retime
				? {
						...patch.retime,
						rate: clampRetimeRate({ rate: patch.retime.rate }),
					}
				: undefined;

			const sourceDuration = getSourceDuration({
				trimStart: originalElement.trimStart,
				trimEnd: originalElement.trimEnd,
				duration: originalElement.duration,
				sourceDuration: isRetimableElement(originalElement)
					? originalElement.sourceDuration
					: undefined,
				retime: isRetimableElement(originalElement)
					? originalElement.retime
					: undefined,
			});
			const visibleSourceSpan = Math.max(
				0,
				sourceDuration - element.trimStart - element.trimEnd,
			);
			const nextDuration = roundMediaTime({
				time: getTimelineDurationForSourceSpan({
					sourceSpan: visibleSourceSpan,
					retime: nextRetime,
				}),
			});

			return {
				element: {
					...element,
					retime: nextRetime,
					duration: nextDuration,
				},
				changedFields: ["retime", "duration"],
			};
		},
	},
];

const enforceRules: ElementUpdateRule[] = [
	{
		// Motion templates: resizing keeps entrances pinned to the start and
		// slides exit keyframes to the NEW end before the clamp runs.
		triggers: ["duration"],
		apply: ({ element, originalElement, patch }) => {
			if (
				element.type !== "text" ||
				!element.motionTemplate ||
				element.duration === originalElement.duration ||
				// Template Controls supplies coherent, end-pinned animations in
				// the same patch — don't double-shift them.
				patch.animations !== undefined
			) {
				return { element };
			}
			return {
				element: {
					...element,
					animations: retimeTemplateAnimations({
						animations: element.animations,
						oldDuration: originalElement.duration as number,
						newDuration: element.duration as number,
					}),
				},
			};
		},
	},
	{
		triggers: ["duration"],
		apply: ({ element }) => ({
			element: {
				...element,
				animations: clampAnimationsToDuration({
					animations: element.animations,
					duration: element.duration,
				}),
			},
		}),
	},
	{
		triggers: ["startTime"],
		apply: ({ element, patch, context }) => {
			const requestedStartTime =
				element.startTime < ZERO_MEDIA_TIME
					? ZERO_MEDIA_TIME
					: element.startTime;
			if (context.trackId !== context.tracks.main.id) {
				return {
					element: {
						...element,
						startTime: requestedStartTime,
					},
				};
			}

			// Only a PURE MOVE is subject to head gravity (the 2s snap-to-0 zone
			// below). A trim/resize also changes the in-point or length, and
			// head-trimming the first clip legitimately shifts its start, leaving a
			// leading gap — a tolerated state (findTimelineGaps models "leading
			// space"; delete leaves one; nothing assumes the first element is at 0).
			// Pinning a resize would keep the shrunk duration while forcing start to
			// 0, jumping the right edge left and corrupting the layout.
			const isResize =
				"duration" in patch || "trimStart" in patch || "trimEnd" in patch;
			if (isResize) {
				return {
					element: {
						...element,
						startTime: requestedStartTime,
					},
				};
			}

			const earliestElement = context.tracks.main.elements
				.filter((candidate) => candidate.id !== element.id)
				.reduce<TimelineElement | null>((earliest, candidate) => {
					if (!earliest || candidate.startTime < earliest.startTime) {
						return candidate;
					}
					return earliest;
				}, null);

			// HEAD GRAVITY (Dan's fork, 2026-07-17): the pin above used to fire for
			// EVERY head-bound pure move, so the earliest main clip snapped back to
			// 0 no matter where it was dropped. It now fires only inside the shared
			// HEAD_GRAVITY_SEC zone: a head-bound move under 2s snaps to 0, anything
			// at/beyond 2s keeps its requested start. A sub-2s move that would NOT
			// become the earliest clip also keeps its spot, so a programmatic ripple
			// shift can never pile a downstream clip onto an occupied head.
			const isHeadBound =
				!earliestElement || requestedStartTime <= earliestElement.startTime;
			return {
				element: {
					...element,
					startTime:
						isHeadBound && isUnderHeadGravity({ startTime: requestedStartTime })
							? ZERO_MEDIA_TIME
							: requestedStartTime,
				},
			};
		},
	},
];

export function applyElementUpdate({
	element,
	patch,
	context,
}: {
	element: TimelineElement;
	patch: Partial<TimelineElement>;
	context: ElementUpdateContext;
}): TimelineElement {
	let nextElement = {
		...element,
		...patch,
		params: {
			...element.params,
			...(patch.params ?? {}),
		},
	} as TimelineElement;
	const changedFields = new Set(
		Object.keys(patch) as ElementUpdateField[],
	);

	for (const rule of deriveRules) {
		if (!shouldApplyRule({ rule, changedFields })) {
			continue;
		}

		const result = rule.apply({
			element: nextElement,
			originalElement: element,
			patch,
			context,
		});
		nextElement = result.element;
		for (const field of result.changedFields ?? []) {
			changedFields.add(field);
		}
	}

	for (const rule of enforceRules) {
		if (!shouldApplyRule({ rule, changedFields })) {
			continue;
		}

		nextElement = rule.apply({
			element: nextElement,
			originalElement: element,
			patch,
			context,
		}).element;
	}

	return nextElement;
}

function shouldApplyRule({
	rule,
	changedFields,
}: {
	rule: ElementUpdateRule;
	changedFields: Set<ElementUpdateField>;
}): boolean {
	return rule.triggers.some((trigger) => changedFields.has(trigger));
}

function getSourceDuration({
	trimStart,
	trimEnd,
	duration,
	sourceDuration,
	retime,
}: {
	trimStart: number;
	trimEnd: number;
	duration: number;
	sourceDuration?: number;
	retime?: RetimeConfig;
}): number {
	if (typeof sourceDuration === "number") {
		return sourceDuration;
	}

	return (
		trimStart +
		getSourceSpanAtClipTime({
			clipTime: duration,
			retime,
		}) +
		trimEnd
	);
}
