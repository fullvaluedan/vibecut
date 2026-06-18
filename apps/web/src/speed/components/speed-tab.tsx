import { useRef } from "react";
import { useEditor } from "@/editor/use-editor";
import { NumberField } from "@/components/ui/number-field";
import { Switch } from "@/components/ui/switch";
import { HugeiconsIcon } from "@hugeicons/react";
import { DashboardSpeed02Icon, Clock01Icon } from "@hugeicons/core-free-icons";
import { buildConstantRetime, getSourceSpanAtClipTime } from "@/retime";
import {
	DEFAULT_RETIME_RATE,
	MIN_RETIME_RATE,
	MAX_RETIME_RATE,
	clampRetimeRate,
	canMaintainPitch,
} from "@/retime/rate";
import {
	rateForTargetDuration,
	targetDurationForRate,
} from "@/retime/duration";
import { TICKS_PER_SECOND } from "@/wasm";
import type { AudioElement, VideoElement } from "@/timeline";
import {
	FxGroup,
	Row,
} from "@/components/editor/panels/properties/components/fx-group";
import { usePropertyDraft } from "@/components/editor/panels/properties/hooks/use-property-draft";
import {
	formatNumberForDisplay,
	getFractionDigitsForStep,
	snapToStep,
} from "@/utils/math";

const SPEED_STEP = 0.01;
const SPEED_FRACTION_DIGITS = getFractionDigitsForStep({ step: SPEED_STEP });

const DURATION_STEP = 0.01;
const DURATION_FRACTION_DIGITS = getFractionDigitsForStep({
	step: DURATION_STEP,
});

function rateToDisplay({ rate }: { rate: number }): string {
	return formatNumberForDisplay({
		value: rate,
		fractionDigits: SPEED_FRACTION_DIGITS,
	});
}

function parseSpeedInput({ input }: { input: string }): number | null {
	const parsed = parseFloat(input);
	if (Number.isNaN(parsed)) return null;
	return clampRetimeRate({
		rate: snapToStep({ value: parsed, step: SPEED_STEP }),
	});
}

function durationToDisplay({
	sourceWindowTicks,
	rate,
}: {
	sourceWindowTicks: number;
	rate: number;
}): string {
	const seconds =
		targetDurationForRate({ sourceWindowTicks, rate }) / TICKS_PER_SECOND;
	return formatNumberForDisplay({
		value: seconds,
		fractionDigits: DURATION_FRACTION_DIGITS,
	});
}

// Editing the Duration field is an alternate way to set the constant rate:
// parse the entered seconds, convert to ticks, then derive the rate that makes
// the (fixed) source window occupy that long on the timeline. Bounds come from
// `clampRetimeRate` via `rateForTargetDuration`.
function parseDurationInput({
	input,
	sourceWindowTicks,
}: {
	input: string;
	sourceWindowTicks: number;
}): number | null {
	const seconds = parseFloat(input);
	if (Number.isNaN(seconds) || seconds <= 0) return null;
	const targetTicks = seconds * TICKS_PER_SECOND;
	return rateForTargetDuration({ sourceWindowTicks, targetTicks });
}

function buildRetime({
	rate,
	maintainPitch,
}: {
	rate: number;
	maintainPitch: boolean;
}) {
	if (rate === DEFAULT_RETIME_RATE && !maintainPitch) return undefined;
	return buildConstantRetime({ rate, maintainPitch });
}

export function SpeedTab({
	element,
	trackId,
}: {
	element: AudioElement | VideoElement;
	trackId: string;
}) {
	const editor = useEditor();
	const rate = clampRetimeRate({
		rate: element.retime?.rate ?? DEFAULT_RETIME_RATE,
	});
	const isPitchPreserveAvailable = canMaintainPitch({ rate });
	const maintainPitch = element.retime?.maintainPitch ?? false;
	const pendingRateRef = useRef(rate);

	// The source-window length is invariant under rate changes: the clip always
	// covers the same span of source media; only its on-timeline duration moves.
	// Derive it from the current on-timeline duration and current rate so the
	// Duration field is the exact inverse of the Speed field.
	const sourceWindowTicks = getSourceSpanAtClipTime({
		clipTime: element.duration,
		retime: element.retime,
	});

	const commitRetime = ({
		rate: nextRate,
		maintainPitch: nextMaintainPitch,
	}: {
		rate: number;
		maintainPitch: boolean;
	}) => {
		editor.timeline.updateElementRetime({
			trackId,
			elementId: element.id,
			retime: buildRetime({ rate: nextRate, maintainPitch: nextMaintainPitch }),
		});
	};

	const speedDraft = usePropertyDraft({
		displayValue: rateToDisplay({ rate }),
		parse: (input) => parseSpeedInput({ input }),
		onPreview: (nextRate) => {
			pendingRateRef.current = nextRate;
			editor.timeline.previewElements({
				updates: [
					{
						trackId,
						elementId: element.id,
						updates: {
							retime: buildRetime({ rate: nextRate, maintainPitch }),
						},
					},
				],
			});
		},
		onCommit: () => {
			commitRetime({ rate: pendingRateRef.current, maintainPitch });
		},
	});

	const durationDraft = usePropertyDraft({
		displayValue: durationToDisplay({ sourceWindowTicks, rate }),
		parse: (input) => parseDurationInput({ input, sourceWindowTicks }),
		onPreview: (nextRate) => {
			pendingRateRef.current = nextRate;
			editor.timeline.previewElements({
				updates: [
					{
						trackId,
						elementId: element.id,
						updates: {
							retime: buildRetime({ rate: nextRate, maintainPitch }),
						},
					},
				],
			});
		},
		onCommit: () => {
			commitRetime({ rate: pendingRateRef.current, maintainPitch });
		},
	});

	return (
		<div className="flex flex-col px-2 pt-2">
			<FxGroup title="Speed">
				<Row label="Speed">
					<div className="w-[130px]">
						<NumberField
							icon={<HugeiconsIcon icon={DashboardSpeed02Icon} />}
							value={speedDraft.displayValue}
							suffix="x"
							scrubRanges={[
								{ from: 0.01, to: 1, pixelsPerUnit: 160 },
								{ from: 1, to: 5, pixelsPerUnit: 48 },
							]}
							scrubClamp={{ min: MIN_RETIME_RATE, max: MAX_RETIME_RATE }}
							onFocus={() => {
								pendingRateRef.current = rate;
								speedDraft.onFocus();
							}}
							onChange={speedDraft.onChange}
							onBlur={speedDraft.onBlur}
							onScrub={speedDraft.scrubTo}
							onScrubEnd={speedDraft.commitScrub}
							onReset={() =>
								commitRetime({ rate: DEFAULT_RETIME_RATE, maintainPitch })
							}
							isDefault={rate === DEFAULT_RETIME_RATE}
						/>
					</div>
				</Row>
				<Row label="Duration">
					<div className="w-[130px]">
						<NumberField
							icon={<HugeiconsIcon icon={Clock01Icon} />}
							value={durationDraft.displayValue}
							suffix="s"
							scrubRanges={[{ from: 0, to: 60, pixelsPerUnit: 8 }]}
							scrubClamp={{
								min:
									targetDurationForRate({
										sourceWindowTicks,
										rate: MAX_RETIME_RATE,
									}) / TICKS_PER_SECOND,
								max:
									targetDurationForRate({
										sourceWindowTicks,
										rate: MIN_RETIME_RATE,
									}) / TICKS_PER_SECOND,
							}}
							onFocus={() => {
								pendingRateRef.current = rate;
								durationDraft.onFocus();
							}}
							onChange={durationDraft.onChange}
							onBlur={durationDraft.onBlur}
							onScrub={durationDraft.scrubTo}
							onScrubEnd={durationDraft.commitScrub}
							onReset={() =>
								commitRetime({ rate: DEFAULT_RETIME_RATE, maintainPitch })
							}
							isDefault={rate === DEFAULT_RETIME_RATE}
						/>
					</div>
				</Row>
				<Row label="Change pitch">
					<Switch
						checked={!maintainPitch}
						disabled={!isPitchPreserveAvailable}
						onCheckedChange={(checked) =>
							commitRetime({ rate, maintainPitch: !checked })
						}
					/>
				</Row>
			</FxGroup>
		</div>
	);
}
