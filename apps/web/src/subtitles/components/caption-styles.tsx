"use client";

/**
 * HyperFrames-inspired caption styles: one click restyles every generated
 * caption on the timeline (elements named "Caption N"). Looks are modeled
 * on the registry's caption components — Neon Accent, Pill Karaoke,
 * Weight Shift, Editorial Emphasis, Highlight — mapped onto the editor's
 * native text params so they render and export like any text.
 */

import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/editor/use-editor";
import { BatchCommand } from "@/commands";
import { UpdateElementsCommand } from "@/commands/timeline/element/update-elements";
import { CAPTION_STYLES } from "./caption-styles-data";

export function CaptionStyles() {
	const editor = useEditor();

	const applyStyle = (style: (typeof CAPTION_STYLES)[number]) => {
		const tracks = editor.scenes.getActiveScene().tracks;
		const updates = tracks.overlay.flatMap((track) =>
			track.type !== "text"
				? []
				: track.elements
						.filter(
							(el) => el.type === "text" && /^Caption \d+$/.test(el.name ?? ""),
						)
						.map((el) => ({
							trackId: track.id,
							elementId: el.id,
							patch: {
								params: { ...el.params, ...style.params },
							} as Partial<import("@/timeline").TimelineElement>,
						})),
		);
		if (!updates.length) {
			toast.info("No generated captions on the timeline yet", {
				description: "Generate captions above, then pick a style.",
			});
			return;
		}
		editor.command.execute({
			command: new BatchCommand(
				updates.map((update) => new UpdateElementsCommand({ updates: [update] })),
			),
		});
		toast.success(`Styled ${updates.length} captions as ${style.name}`, {
			description: "Ctrl+Z restores the previous look.",
		});
	};

	return (
		<div className="mt-4 border-t pt-3">
			<h3 className="text-xs font-semibold">Caption style</h3>
			<p className="text-muted-foreground mt-1 text-[0.65rem]">
				HyperFrames-inspired looks applied to every generated caption.
			</p>
			<div className="mt-2 grid grid-cols-2 gap-1.5">
				{CAPTION_STYLES.map((style) => (
					<Button
						key={style.id}
						variant="outline"
						size="sm"
						className="h-7 text-[0.7rem]"
						onClick={() => applyStyle(style)}
					>
						{style.name}
					</Button>
				))}
			</div>
		</div>
	);
}
