"use client";

import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { ColorPicker } from "@/components/ui/color-picker";
import { useEditor } from "@/editor/use-editor";
import { resolveSolidElementColor } from "@/media/solid-color";
import type { MediaAsset } from "@/media/types";
import type { ImageElement } from "@/timeline";

/**
 * W7: inline color editing for a selected "Solid" element. Mirrors
 * background.tsx's CustomColorPreview usage of ColorPickerContent -
 * `onChange` previews continuously during a drag (no history entry),
 * `onChangeEnd` commits once on release (one undo step). Preview goes
 * through the timeline's overlay system (previewElements/updateElements),
 * the same pattern SpeedTab uses for a live-dragged, non-keyframed value.
 */
export function SolidColorTab({
	element,
	trackId,
	mediaAsset,
}: {
	element: ImageElement;
	trackId: string;
	mediaAsset: MediaAsset | undefined;
}) {
	const editor = useEditor();
	const color = resolveSolidElementColor({ element, mediaAsset });

	const previewColor = (nextColor: string) => {
		editor.timeline.previewElements({
			updates: [
				{ trackId, elementId: element.id, updates: { solidColor: nextColor } },
			],
		});
	};

	const commitColor = (nextColor: string) => {
		editor.timeline.updateElements({
			updates: [
				{ trackId, elementId: element.id, patch: { solidColor: nextColor } },
			],
		});
	};

	return (
		<Section sectionKey={`${element.id}:solid-color`}>
			<SectionHeader>
				<SectionTitle>Color</SectionTitle>
			</SectionHeader>
			<SectionContent>
				<SectionFields>
					<SectionField label="Fill">
						<ColorPicker
							value={color.replace(/^#/, "").toUpperCase()}
							onChange={(next) => previewColor(`#${next}`)}
							onChangeEnd={(next) => commitColor(`#${next}`)}
						/>
					</SectionField>
				</SectionFields>
			</SectionContent>
		</Section>
	);
}
