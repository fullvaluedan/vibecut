"use client";

/**
 * Text styles: save the look of one piece of text, then drop that same look
 * onto the next one. Premiere calls this a Linked Style; ours is a deliberate
 * one-shot apply, so editing a style later never reaches back and changes text
 * you already made.
 *
 * Lives inside the Text tab (not its own tab) because a style is exactly the
 * bundle of fields shown directly below it. It is mounted the same way the
 * Audio tab mounts AudioSyncSection next to ElementParamsTab.
 */

import { useState } from "react";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon } from "@hugeicons/core-free-icons";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { UpdateElementsCommand } from "@/commands/timeline/element/update-elements";
import { useEditor } from "@/editor/use-editor";
import { loadFonts } from "@/fonts/google-fonts";
import type { TextElement } from "@/timeline";
import { generateUUID } from "@/utils/id";
import {
	addTextStyle,
	findTextStyle,
	removeTextStyle,
} from "../project-styles";
import { buildTextStylePatch, captureTextStyleParams } from "../style-params";
import type { TextStyle } from "../types";

export function TextStylesSection({
	element,
	trackId,
}: {
	element: TextElement;
	trackId: string;
}) {
	const editor = useEditor();
	const styles = useEditor(
		(instance) => instance.project.getActiveOrNull()?.textStyles ?? [],
	);
	const [selectedStyleId, setSelectedStyleId] = useState("");
	const [isNaming, setIsNaming] = useState(false);
	const [draftName, setDraftName] = useState("");

	// A template element is rebuilt from its recipe every time Template
	// Controls commits, which would silently wipe an applied style. Rather
	// than let Dan apply a style that quietly vanishes, say so plainly.
	const isTemplate = !!element.motionTemplate;

	const persistStyles = (nextStyles: TextStyle[]) => {
		const project = editor.project.getActive();
		editor.project.setActiveProject({
			project: {
				...project,
				textStyles: nextStyles,
				metadata: { ...project.metadata, updatedAt: new Date() },
			},
		});
		editor.save.markDirty();
	};

	const saveStyle = () => {
		const name = draftName.trim();
		if (!name) {
			toast.error("Give the style a name first");
			return;
		}
		const style: TextStyle = {
			id: generateUUID(),
			name,
			params: captureTextStyleParams({ element }),
			createdAt: new Date().toISOString(),
		};
		const project = editor.project.getActive();
		persistStyles(addTextStyle({ project, style }).textStyles ?? []);
		setSelectedStyleId(style.id);
		setIsNaming(false);
		setDraftName("");
		toast.success(`Saved the style "${name}"`, {
			description:
				"Font, size, color, background, stroke and shadow. Nothing moved.",
		});
	};

	const applyStyle = (styleId: string) => {
		setSelectedStyleId(styleId);
		const project = editor.project.getActiveOrNull();
		const style = findTextStyle({ project, styleId });
		if (!style) return;

		// A Google font has to be fetched before the preview can draw it.
		const fontFamily = style.params.fontFamily;
		if (typeof fontFamily === "string" && fontFamily) {
			void loadFonts({ families: [fontFamily] });
		}

		editor.command.execute({
			command: new UpdateElementsCommand({
				updates: [
					{
						trackId,
						elementId: element.id,
						patch: buildTextStylePatch({ element, style }),
					},
				],
			}),
		});
		toast.success(`Applied "${style.name}"`);
	};

	const deleteSelectedStyle = () => {
		const project = editor.project.getActive();
		const style = findTextStyle({ project, styleId: selectedStyleId });
		if (!style) return;
		persistStyles(
			removeTextStyle({ project, styleId: selectedStyleId }).textStyles ?? [],
		);
		setSelectedStyleId("");
		toast.success(`Deleted the style "${style.name}"`);
	};

	return (
		<Section sectionKey={`${element.id}:text-styles`}>
			<SectionHeader>
				<SectionTitle className="flex-1">Style</SectionTitle>
			</SectionHeader>
			<SectionContent>
				<SectionFields>
					{isTemplate ? (
						<p className="text-muted-foreground text-xs">
							This text comes from a template, so its look is rebuilt from the
							template every time you change a Template Controls field. Use
							"Detach template" on the Template tab first if you want to save or
							apply a style here.
						</p>
					) : (
						<>
							<SectionField label="Apply a saved style">
								<div className="flex w-full items-center gap-2">
									<Select
										value={selectedStyleId}
										disabled={styles.length === 0}
										onValueChange={applyStyle}
									>
										<SelectTrigger className="w-full">
											<SelectValue
												placeholder={
													styles.length === 0
														? "No saved styles yet"
														: "Pick a style"
												}
											/>
										</SelectTrigger>
										<SelectContent>
											{styles.map((style) => (
												<SelectItem key={style.id} value={style.id}>
													{style.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<Button
										variant="ghost"
										size="icon"
										aria-label="Delete the selected style"
										title="Delete the selected style"
										disabled={!selectedStyleId}
										onClick={deleteSelectedStyle}
									>
										<HugeiconsIcon icon={Delete02Icon} />
									</Button>
								</div>
							</SectionField>

							{isNaming ? (
								<SectionField label="Name this style">
									<div className="flex w-full items-center gap-2">
										<Input
											autoFocus
											value={draftName}
											placeholder="Lower third"
											onChange={(event) => setDraftName(event.target.value)}
											onKeyDown={(event) => {
												if (event.key === "Enter") saveStyle();
												else if (event.key === "Escape") {
													setIsNaming(false);
													setDraftName("");
												}
											}}
										/>
										<Button variant="secondary" size="sm" onClick={saveStyle}>
											Save
										</Button>
										<Button
											variant="ghost"
											size="sm"
											onClick={() => {
												setIsNaming(false);
												setDraftName("");
											}}
										>
											Cancel
										</Button>
									</div>
								</SectionField>
							) : (
								<Button
									variant="outline"
									size="sm"
									className="w-full"
									onClick={() => {
										setDraftName("");
										setIsNaming(true);
									}}
								>
									Save as style
								</Button>
							)}

							<p className="text-muted-foreground text-[0.65rem]">
								A style remembers font, size, weight, color, spacing, alignment,
								the background box, and the stroke and shadow. It never changes
								your words, where the text sits, or how long it lasts.
							</p>
						</>
					)}
				</SectionFields>
			</SectionContent>
		</Section>
	);
}
