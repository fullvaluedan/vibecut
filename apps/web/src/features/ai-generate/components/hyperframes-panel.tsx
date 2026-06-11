"use client";

import { describeTemplateCatalog } from "@framecut/hf-bridge/templates";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAiSettingsStore } from "@/features/ai-generate/store";
import { VIBE_STYLES } from "@/features/ai-generate/styles";
import { cn } from "@/utils/ui";

/**
 * HyperFrames browse panel (left sidebar tab): every available template with
 * a live looping demo and a checkbox. Checked templates form the palette
 * RUN HYPERFRAMES lets Claude pick from; unchecked ones are never used.
 */
export function HyperframesPanel() {
	const disabledTemplateIds = useAiSettingsStore((s) => s.disabledTemplateIds);
	const toggleTemplate = useAiSettingsStore((s) => s.toggleTemplate);
	const styleId = useAiSettingsStore((s) => s.styleId);
	const setStyleId = useAiSettingsStore((s) => s.setStyleId);
	const templates = describeTemplateCatalog();
	const enabledCount = templates.filter(
		(t) => !disabledTemplateIds.includes(t.id),
	).length;

	return (
		<ScrollArea className="h-full">
			<div className="flex flex-col gap-4 p-3">
				<div>
					<h3 className="text-sm font-semibold">HyperFrames templates</h3>
					<p className="text-muted-foreground mt-1 text-xs">
						Checked templates are the palette RUN HYPERFRAMES picks from when
						it plans effects for your transcript. {enabledCount} of{" "}
						{templates.length} enabled.
					</p>
				</div>

				<div className="flex flex-col gap-2">
					{templates.map((t) => {
						const enabled = !disabledTemplateIds.includes(t.id);
						return (
							<label
								key={t.id}
								className={cn(
									"flex cursor-pointer flex-col gap-2 rounded-md border p-2 transition-colors",
									enabled
										? "border-foreground/20"
										: "border-transparent opacity-50",
								)}
							>
								<video
									src={`/hf-demos/${t.id}.webm`}
									className="aspect-video w-full rounded-sm bg-black/40 object-cover"
									autoPlay
									loop
									muted
									playsInline
								/>
								<div className="flex items-start gap-2">
									<Checkbox
										checked={enabled}
										onCheckedChange={() => toggleTemplate(t.id)}
										className="mt-0.5"
									/>
									<div className="min-w-0">
										<div className="text-xs font-medium">{t.name}</div>
										<div
											className="text-muted-foreground line-clamp-2 text-[0.65rem]"
											title={t.whenToUse}
										>
											{t.description}
										</div>
									</div>
								</div>
							</label>
						);
					})}
				</div>

				<div>
					<h3 className="text-sm font-semibold">Style theme</h3>
					<p className="text-muted-foreground mt-1 text-xs">
						Colors every new generation. Change it any time — existing clips
						keep their look until you re-run or restyle them.
					</p>
					<div className="mt-2 flex flex-wrap gap-1.5">
						{VIBE_STYLES.map((style) => (
							<button
								key={style.id}
								type="button"
								title={`${style.name} — ${style.description}`}
								onClick={() => setStyleId(style.id)}
								className={cn(
									"size-7 rounded-full border-2 transition-transform",
									styleId === style.id
										? "scale-110 border-foreground"
										: "border-transparent hover:scale-105",
								)}
								style={{ backgroundColor: style.accent }}
							/>
						))}
					</div>
				</div>

				<p className="text-muted-foreground text-[0.65rem]">
					More templates and components are added with each HyperFrames
					update — new ones start enabled automatically.
				</p>
			</div>
		</ScrollArea>
	);
}
