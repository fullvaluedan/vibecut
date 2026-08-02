"use client";

/**
 * T19.2 "Cutout" affordance (CapCut parity naming).
 *
 * WHERE IT LIVES: at the top of the per-clip Effects tab, directly under the
 * "Effects" header, above the effect list. Reasons: (1) chroma key IS an
 * effect instance on the clip, so the one place a user already looks for
 * "what is stacked on this clip" is where enabling it belongs, and its params
 * then appear in the very list below with zero duplicate UI; (2) it keeps
 * `properties/registry.tsx` untouched, so no new tab and no upstream tab-config
 * change; (3) it is visible in the EMPTY state too, which is the case that
 * matters - a clip with no effects yet is exactly when someone goes looking
 * for green-screen removal.
 *
 * THIN WRAPPER, NO PARALLEL STATE: enable/remove go straight through the
 * existing `addClipEffect` / `removeClipEffect` commands, so undo, the effect
 * list, keyframes and export all behave identically to adding the effect any
 * other way. The only local state is which param is armed for the eyedropper.
 */

import { HugeiconsIcon } from "@hugeicons/react";
import { ColorPickerIcon, MagicWand05Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
	Section,
	SectionContent,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { useEditor } from "@/editor/use-editor";
import { CHROMA_KEY_EFFECT_TYPE } from "@/effects/definitions/chroma-key";
import {
	isSameEyedropperRequest,
	useEyedropperStore,
} from "@/effects/eyedropper/eyedropper-store";
import type { Effect } from "@/effects/types";
import type { VisualElement } from "@/timeline";

const KEY_COLOR_PARAM = "keyColor";

/**
 * Cutout is offered on the clip types that have a decodable picture behind
 * them, which is also exactly where the eyedropper can read source pixels.
 * The effect itself stays addable to any visual layer through the normal
 * effects route.
 */
const CUTOUT_ELEMENT_TYPES = ["video", "image"];

export function CutoutSection({
	element,
	trackId,
}: {
	element: VisualElement;
	trackId: string;
}) {
	const editor = useEditor();
	const request = useEyedropperStore((s) => s.request);
	const begin = useEyedropperStore((s) => s.begin);
	const cancel = useEyedropperStore((s) => s.cancel);

	if (!CUTOUT_ELEMENT_TYPES.includes(element.type)) {
		return null;
	}

	const effects: Effect[] = element.effects ?? [];
	const chromaKey = effects.find(
		(effect) => effect.type === CHROMA_KEY_EFFECT_TYPE,
	);

	const pickRequest = chromaKey
		? {
				trackId,
				elementId: element.id,
				effectId: chromaKey.id,
				paramKey: KEY_COLOR_PARAM,
			}
		: null;
	const isPicking =
		pickRequest !== null &&
		isSameEyedropperRequest({ left: request, right: pickRequest });

	return (
		<Section sectionKey={`cutout:${element.id}`} showTopBorder={false}>
			<SectionHeader>
				<SectionTitle>Cutout</SectionTitle>
			</SectionHeader>
			<SectionContent className="flex flex-col gap-2 px-4 pb-3">
				{!chromaKey ? (
					<>
						<Button
							variant="secondary"
							size="sm"
							onClick={() =>
								editor.timeline.addClipEffect({
									trackId,
									elementId: element.id,
									effectType: CHROMA_KEY_EFFECT_TYPE,
								})
							}
						>
							<HugeiconsIcon icon={MagicWand05Icon} />
							Enable chroma key
						</Button>
						<p className="text-muted-foreground text-xs">
							Removes a single colour (green screen by default). Its controls
							appear in the effect list below.
						</p>
					</>
				) : (
					<>
						<div className="flex gap-2">
							<Button
								variant={isPicking ? "default" : "secondary"}
								size="sm"
								className="flex-1"
								onClick={() =>
									isPicking
										? cancel()
										: begin({ request: pickRequest as NonNullable<typeof pickRequest> })
								}
							>
								<HugeiconsIcon icon={ColorPickerIcon} />
								{isPicking ? "Picking... (Esc)" : "Pick color"}
							</Button>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => {
									if (isPicking) cancel();
									editor.timeline.removeClipEffect({
										trackId,
										elementId: element.id,
										effectId: chromaKey.id,
									});
								}}
							>
								Remove
							</Button>
						</div>
						<p className="text-muted-foreground text-xs">
							{isPicking
								? "Click the colour to remove in the preview. Esc cancels."
								: "Pick reads the clip's own frame, so the colour is what the key actually sees."}
						</p>
					</>
				)}
			</SectionContent>
		</Section>
	);
}
