import { useRef } from "react";
import { useEditor } from "@/editor/use-editor";
import { NumberField } from "@/components/ui/number-field";
import { Switch } from "@/components/ui/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { HugeiconsIcon } from "@hugeicons/react";
import { DashboardSpeed02Icon } from "@hugeicons/core-free-icons";
import {
	buildConstantRetime,
	buildCurveRetimeFromPoints,
	buildCurveRetimeFromPreset,
} from "@/retime";
import {
	DEFAULT_RETIME_RATE,
	MIN_RETIME_RATE,
	MAX_RETIME_RATE,
	clampRetimeForReverse,
	clampRetimeRate,
	canMaintainPitch,
} from "@/retime/rate";
import type { RetimeCurvePoint } from "@/retime/curve";
import type { AudioElement, VideoElement } from "@/timeline";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { usePropertyDraft } from "@/components/editor/panels/properties/hooks/use-property-draft";
import {
	formatNumberForDisplay,
	getFractionDigitsForStep,
	snapToStep,
} from "@/utils/math";
import { SpeedCurveSection } from "./speed-curve-section";

const SPEED_STEP = 0.01;
const SPEED_FRACTION_DIGITS = getFractionDigitsForStep({ step: SPEED_STEP });

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

/**
 * T18.1 reverse: `rate` stays at 1x while `reversed` is on (see the
 * RetimeConfig.reversed doc comment in timeline/types.ts for why reverse +
 * a non-1 rate is out of scope) - `clampRetimeForReverse` is the single
 * enforcement point both the rate field and this builder go through, so a
 * stale pending rate from before the toggle can never sneak a non-1 rate
 * into a reversed clip.
 */
function buildRetime({
	rate,
	maintainPitch,
	reversed,
}: {
	rate: number;
	maintainPitch: boolean;
	reversed: boolean;
}) {
	const effectiveRate = clampRetimeForReverse({ rate, reversed });
	if (effectiveRate === DEFAULT_RETIME_RATE && !maintainPitch && !reversed) {
		return undefined;
	}
	return { ...buildConstantRetime({ rate: effectiveRate, maintainPitch }), reversed };
}

export function SpeedTab({
	element,
	trackId,
}: {
	element: AudioElement | VideoElement;
	trackId: string;
}) {
	const editor = useEditor();
	const reversed = element.retime?.reversed ?? false;
	const curve = element.retime?.curve;
	const hasCurve = curve !== undefined;
	const rate = clampRetimeRate({
		rate: element.retime?.rate ?? DEFAULT_RETIME_RATE,
	});
	// T18.2: Curve and Reverse are mutually exclusive (see the
	// RetimeConfig.curve doc comment in timeline/types.ts) - a curve always
	// plays forward, and pitch preservation isn't implemented for a variable
	// rate (see shouldUsePitchPreservedRetimeBuffer in retime/rate.ts), so
	// both the constant Speed field and pitch preservation are unavailable
	// while a curve is active, same as while reversed.
	const isPitchPreserveAvailable = canMaintainPitch({ rate }) && !reversed && !hasCurve;
	const maintainPitch = element.retime?.maintainPitch ?? false;
	const pendingRateRef = useRef(rate);

	const commitRetime = ({
		rate: nextRate,
		maintainPitch: nextMaintainPitch,
		reversed: nextReversed,
	}: {
		rate: number;
		maintainPitch: boolean;
		reversed: boolean;
	}) => {
		editor.timeline.updateElementRetime({
			trackId,
			elementId: element.id,
			retime: buildRetime({
				rate: nextRate,
				maintainPitch: nextMaintainPitch,
				reversed: nextReversed,
			}),
		});
	};

	// T18.2: selecting a preset or committing a hand-edited curve always
	// clears `reversed` (a curve always plays forward) and replaces the
	// retime object wholesale, so swapping from one preset to another - or
	// from Custom to a fixed shape - never leaves stale points behind. Each
	// is a single `updateElementRetime` call, so it's one undo step.
	const commitCurvePreset = (presetId: string) => {
		editor.timeline.updateElementRetime({
			trackId,
			elementId: element.id,
			retime: buildCurveRetimeFromPreset({ presetId, maintainPitch }),
		});
	};

	const commitCurvePoints = (points: RetimeCurvePoint[]) => {
		editor.timeline.updateElementRetime({
			trackId,
			elementId: element.id,
			retime: buildCurveRetimeFromPoints({ points, maintainPitch }),
		});
	};

	const previewCurvePoints = (points: RetimeCurvePoint[]) => {
		editor.timeline.previewElementRetime({
			trackId,
			elementId: element.id,
			retime: buildCurveRetimeFromPoints({ points, maintainPitch }),
		});
	};

	const removeCurve = () => {
		commitRetime({ rate: DEFAULT_RETIME_RATE, maintainPitch, reversed: false });
	};

	const speedDraft = usePropertyDraft({
		displayValue: rateToDisplay({ rate }),
		parse: (input) => parseSpeedInput({ input }),
		onPreview: (nextRate) => {
			pendingRateRef.current = nextRate;
			editor.timeline.previewElementRetime({
				trackId,
				elementId: element.id,
				retime: buildRetime({ rate: nextRate, maintainPitch, reversed }),
			});
		},
		onCommit: () => {
			commitRetime({ rate: pendingRateRef.current, maintainPitch, reversed });
		},
	});

	return (
		<Section collapsible sectionKey={`${element.id}:speed`}>
			<SectionHeader>
				<SectionTitle>Speed</SectionTitle>
			</SectionHeader>
			<SectionContent>
				<SectionFields>
					<SectionField label="Speed">
						<NumberField
							icon={<HugeiconsIcon icon={DashboardSpeed02Icon} />}
							value={
								reversed || hasCurve
									? rateToDisplay({ rate: DEFAULT_RETIME_RATE })
									: speedDraft.displayValue
							}
							suffix="x"
							disabled={reversed || hasCurve}
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
							onCancel={speedDraft.onCancel}
							onScrub={speedDraft.scrubTo}
							onScrubEnd={speedDraft.commitScrub}
							onReset={() =>
								commitRetime({ rate: DEFAULT_RETIME_RATE, maintainPitch, reversed })
							}
							isDefault={rate === DEFAULT_RETIME_RATE}
						/>
					</SectionField>
					<TooltipProvider delayDuration={300}>
						<Tooltip>
							<TooltipTrigger asChild>
								<div className="flex items-center justify-between">
									<span className="text-sm">Reverse</span>
									<Switch
										checked={reversed}
										onCheckedChange={(checked) =>
											commitRetime({
												rate,
												maintainPitch,
												reversed: checked,
											})
										}
									/>
								</div>
							</TooltipTrigger>
							<TooltipContent>Audio is muted while reversed</TooltipContent>
						</Tooltip>
					</TooltipProvider>
					<TooltipProvider delayDuration={300}>
						<Tooltip>
							<TooltipTrigger asChild>
								<div className="flex items-center justify-between">
									<span className="text-sm">Change pitch</span>
									<Switch
										checked={!maintainPitch}
										disabled={!isPitchPreserveAvailable}
										onCheckedChange={(checked) =>
											commitRetime({ rate, maintainPitch: !checked, reversed })
										}
									/>
								</div>
							</TooltipTrigger>
							<TooltipContent>
								{hasCurve
									? "Pitch isn't preserved while a curve is active"
									: reversed
										? "Pitch isn't preserved while reversed"
										: "Preserve pitch while the speed changes"}
							</TooltipContent>
						</Tooltip>
					</TooltipProvider>
				</SectionFields>
				<div className="border-t pt-3">
					<SpeedCurveSection
						curve={curve}
						onPreviewCurve={previewCurvePoints}
						onCommitCurve={commitCurvePoints}
						onSelectPreset={commitCurvePreset}
						onRemoveCurve={removeCurve}
					/>
				</div>
			</SectionContent>
		</Section>
	);
}
