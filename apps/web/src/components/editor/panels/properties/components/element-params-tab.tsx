"use client";

import { resolveAnimationPathValueAtTime } from "@/animation";
import { Section, SectionContent, SectionFields } from "@/components/section";
import { FxGroup } from "@/components/editor/panels/properties/components/fx-group";
import { useElementPlayhead } from "@/components/editor/panels/properties/hooks/use-element-playhead";
import { useKeyframedParamProperty } from "@/components/editor/panels/properties/hooks/use-keyframed-param-property";
import {
	FxParamRow,
	PropertyParamField,
} from "@/components/editor/panels/properties/components/property-param-field";
import type { ParamValue, ParamValues } from "@/params";
import {
	getElementParams,
	readElementParamValue,
	writeElementParamValue,
	type ElementParamDefinition,
} from "@/params/registry";
import type { TimelineElement } from "@/timeline";
import type { MediaTime } from "@/wasm";

/**
 * `"section"` is the classic vertical Section/SectionField layout (Text tab);
 * `"fx"` is the Effect-Controls fx-group look — a titled collapsible group of
 * horizontal rows (Audio/Blending tabs). The controls and keyframe behavior
 * are identical across variants; only the row wrapper differs.
 */
type ParamsLayout = "section" | "fx";

export function ElementParamsTab({
	element,
	trackId,
	paramKeys,
	sectionKey,
	variant = "section",
	title,
}: {
	element: TimelineElement;
	trackId: string;
	paramKeys?: readonly string[];
	sectionKey: string;
	variant?: ParamsLayout;
	title?: string;
}) {
	const { localTime, isPlayheadWithinElementRange } = useElementPlayhead({
		startTime: element.startTime,
		duration: element.duration,
	});
	const params = getElementParams({ element }).filter(
		(param) => !paramKeys || paramKeys.includes(param.key),
	);
	const baseValues = buildValues({ element, params });
	const visibleParams = params.filter((param) =>
		isVisible({ param, values: baseValues }),
	);

	const fields = visibleParams.map((param) => (
		<ElementParamField
			key={param.key}
			element={element}
			trackId={trackId}
			param={param}
			baseValue={baseValues[param.key] ?? param.default}
			localTime={localTime}
			isPlayheadWithinElementRange={isPlayheadWithinElementRange}
			variant={variant}
		/>
	));

	if (variant === "fx") {
		return (
			<div className="flex flex-col px-2 pt-2">
				<FxGroup title={title ?? sectionKey}>{fields}</FxGroup>
			</div>
		);
	}

	return (
		<Section sectionKey={`${element.id}:${sectionKey}`}>
			<SectionContent className="pt-4">
				<SectionFields>{fields}</SectionFields>
			</SectionContent>
		</Section>
	);
}

function ElementParamField({
	element,
	trackId,
	param,
	baseValue,
	localTime,
	isPlayheadWithinElementRange,
	variant,
}: {
	element: TimelineElement;
	trackId: string;
	param: ElementParamDefinition;
	baseValue: ParamValue;
	localTime: MediaTime;
	isPlayheadWithinElementRange: boolean;
	variant: ParamsLayout;
}) {
	const resolvedValue = resolveAnimationPathValueAtTime({
		animations: element.animations,
		propertyPath: param.key,
		localTime,
		fallbackValue: baseValue,
	});
	const animatedParam = useKeyframedParamProperty({
		param,
		trackId,
		elementId: element.id,
		animations: element.animations,
		propertyPath: param.key,
		localTime,
		isPlayheadWithinElementRange,
		resolvedValue,
		buildBaseUpdates: ({ value }) =>
			writeElementParamValue({ element, param, value }),
	});

	const keyframe =
		param.keyframable === false
			? undefined
			: {
					isActive: animatedParam.isKeyframedAtTime,
					isDisabled: !isPlayheadWithinElementRange,
					onToggle: animatedParam.toggleKeyframe,
				};

	if (variant === "fx") {
		return (
			<FxParamRow
				param={param}
				value={resolvedValue}
				onPreview={animatedParam.onPreview}
				onCommit={animatedParam.onCommit}
				keyframe={keyframe}
			/>
		);
	}

	return (
		<PropertyParamField
			param={param}
			value={resolvedValue}
			onPreview={animatedParam.onPreview}
			onCommit={animatedParam.onCommit}
			keyframe={keyframe}
		/>
	);
}

function buildValues({
	element,
	params,
}: {
	element: TimelineElement;
	params: readonly ElementParamDefinition[];
}): ParamValues {
	const values: ParamValues = {};
	for (const param of params) {
		const value = readElementParamValue({ element, param });
		if (value !== null) {
			values[param.key] = value;
		}
	}
	return values;
}

function isVisible({
	param,
	values,
}: {
	param: ElementParamDefinition;
	values: ParamValues;
}): boolean {
	return (param.dependencies ?? []).every((dependency) =>
		areParamValuesEqual({
			left: values[dependency.param],
			right: dependency.equals,
		}),
	);
}

function areParamValuesEqual({
	left,
	right,
}: {
	left: ParamValue | undefined;
	right: ParamValue;
}): boolean {
	return left === right;
}
