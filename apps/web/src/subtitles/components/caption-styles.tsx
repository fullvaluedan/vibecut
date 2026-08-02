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
import type { ParamValues } from "@/params";

const CAPTION_STYLES: {
	id: string;
	name: string;
	params: Partial<ParamValues>;
}[] = [
	{ id: "plain", name: "Plain", params: { color: "#ffffff", fontWeight: "normal", fontStyle: "normal", "background.enabled": false } },
	{
		id: "neon-accent",
		name: "Neon Accent",
		params: { color: "#EAFF00", fontWeight: "bold", "background.enabled": false },
	},
	{
		id: "pill-karaoke",
		name: "Pill Karaoke",
		params: {
			color: "#111111",
			fontWeight: "bold",
			"background.enabled": true,
			"background.color": "#FF6E20",
			"background.cornerRadius": 24,
		},
	},
	{
		id: "weight-shift",
		name: "Weight Shift",
		params: { fontWeight: "bold", letterSpacing: 1.5, "background.enabled": false },
	},
	{
		id: "editorial",
		name: "Editorial",
		params: {
			fontStyle: "italic",
			color: "#ffffff",
			"background.enabled": true,
			"background.color": "#000000",
			"background.cornerRadius": 4,
		},
	},
	{
		id: "highlight",
		name: "Highlight",
		params: {
			color: "#111111",
			fontWeight: "bold",
			"background.enabled": true,
			"background.color": "#A3E635",
			"background.cornerRadius": 6,
		},
	},
	{
		id: "outline-pop",
		name: "Outline Pop",
		params: {
			color: "#ffffff",
			fontWeight: "bold",
			fontStyle: "normal",
			"background.enabled": false,
			strokeColor: "#000000",
			strokeWidth: 6,
			shadowColor: "#000000",
			shadowBlur: 0,
			shadowOffsetX: 0,
			shadowOffsetY: 0,
		},
	},
	{
		id: "drop-shadow",
		name: "Drop Shadow",
		params: {
			color: "#ffffff",
			fontWeight: "normal",
			fontStyle: "normal",
			"background.enabled": false,
			strokeColor: "#000000",
			strokeWidth: 0,
			shadowColor: "#000000",
			shadowBlur: 18,
			shadowOffsetX: 0,
			shadowOffsetY: 4,
		},
	},
	{
		id: "broadcast",
		name: "Broadcast",
		params: {
			color: "#ffffff",
			fontWeight: "bold",
			fontStyle: "normal",
			letterSpacing: 2,
			"background.enabled": true,
			"background.color": "#1a1a1a",
			"background.cornerRadius": 2,
			"background.paddingX": 12,
			"background.paddingY": 6,
			"background.offsetX": 0,
			"background.offsetY": 0,
			strokeColor: "#000000",
			strokeWidth: 0,
			shadowColor: "#000000",
			shadowBlur: 8,
			shadowOffsetX: 0,
			shadowOffsetY: 2,
		},
	},
	{
		id: "minimal-mono",
		name: "Minimal Mono",
		params: {
			color: "#888888",
			fontWeight: "normal",
			fontStyle: "normal",
			letterSpacing: -0.5,
			"background.enabled": false,
			strokeColor: "#000000",
			strokeWidth: 0,
			shadowColor: "#000000",
			shadowBlur: 0,
			shadowOffsetX: 0,
			shadowOffsetY: 0,
		},
	},
	{
		id: "highlighter-variant",
		name: "Highlighter",
		params: {
			color: "#000000",
			fontWeight: "normal",
			fontStyle: "normal",
			"background.enabled": true,
			"background.color": "#FFFF00",
			"background.cornerRadius": 20,
			"background.paddingX": 8,
			"background.paddingY": 4,
			"background.offsetX": 0,
			"background.offsetY": 0,
			strokeColor: "#000000",
			strokeWidth: 0,
			shadowColor: "#000000",
			shadowBlur: 0,
			shadowOffsetX: 0,
			shadowOffsetY: 0,
		},
	},
	{
		id: "cinema-bar",
		name: "Cinema Bar",
		params: {
			color: "#ffffff",
			fontWeight: "normal",
			fontStyle: "normal",
			"background.enabled": true,
			"background.color": "#000000",
			"background.cornerRadius": 0,
			"background.paddingX": 16,
			"background.paddingY": 8,
			"background.offsetX": 0,
			"background.offsetY": -2,
			strokeColor: "#000000",
			strokeWidth: 0,
			shadowColor: "#000000",
			shadowBlur: 12,
			shadowOffsetX: 0,
			shadowOffsetY: 3,
		},
	},
];

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
