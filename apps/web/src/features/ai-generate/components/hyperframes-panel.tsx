"use client";

/**
 * The HyperFrames asset home (left sidebar tab). The start flow (T20.4):
 * pick or create a style profile, describe what you want (or one-click a
 * showcase), then hit RUN HYPERFRAMES in the timeline toolbar. A run renders
 * a short probe of each segment first and the full render waits on your
 * approval in the drafts review - the panel teaches that probe-first model
 * up top. The engine knob, the template/style/block/component palette
 * (collapsible sections, visual previews, grid/list views, persisted
 * checkboxes), and the factory Look stay reachable behind the Advanced
 * disclosure. Template checkboxes gate RUN HYPERFRAMES; blocks have an "Add"
 * action that bakes them to a cached WebM and drops them on the timeline.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { describeTemplateCatalog } from "@framecut/hf-bridge/templates";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import {
	useAiSettingsStore,
	MAX_HF_PRESETS,
	type HfPreset,
} from "@/features/ai-generate/store";
import {
	VIBE_STYLES,
	getStyleById,
} from "@/features/ai-generate/styles";
import {
	HF_DENSITIES,
	HF_MOTION_STYLES,
	PROFILE_FONT_OPTIONS,
	type HfDensity,
	type HfDesignSpec,
	type HfMotionStyle,
} from "@/features/ai-generate/profiles";
import { bakeAndPlaceBlock } from "@/features/ai-generate/bake-block";
import { useEditor } from "@/editor/use-editor";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	ArrowDown01Icon,
	ArrowRight01Icon,
	FullScreenIcon,
	GridViewIcon,
	LeftToRightListDashIcon,
} from "@hugeicons/core-free-icons";
import { usePanelMaximizeStore } from "@/editor/panel-maximize-store";
import { cn } from "@/utils/ui";
import { toast } from "sonner";

interface RegistryAsset {
	name: string;
	type: string;
	title: string;
	description: string;
	previewVideo: string | null;
	previewPoster: string | null;
	durationSec: number | null;
	tags?: string[];
	/** True when the item has a composition file (can bake to a droppable clip). */
	renderable?: boolean;
}

/**
 * Transition/shader blocks (whip-pan, glitch, transitions-*, etc.) bake to a
 * SELF-CONTAINED demo (a built-in "Scene A → Scene B"), so dropping one as an
 * overlay plays that demo over your footage instead of transitioning your
 * clips. They need a real transition slot between two clips — not yet built —
 * so we don't offer "Add" on them (it would promise a broken result).
 */
function isTransitionBlock(a: RegistryAsset): boolean {
	return (a.tags ?? []).includes("transition");
}

interface BrowserItem {
	id: string;
	title: string;
	description: string;
	checked: boolean;
	onToggle: () => void;
	/** Local looping demo (templates). */
	demoSrc?: string;
	previewVideo?: string | null;
	previewPoster?: string | null;
	/** Bake library: when present, an "Add" action drops this onto the timeline. */
	onAdd?: () => void;
	adding?: boolean;
}

/** "Add to timeline" button shown on bakeable items (registry blocks). */
function AddButton({ item }: { item: BrowserItem }) {
	if (!item.onAdd) return null;
	return (
		<Button
			size="sm"
			variant="secondary"
			className="h-6 shrink-0 px-2 text-[0.65rem]"
			disabled={item.adding}
			title="Bake this block and drop it on the timeline at the playhead"
			onClick={(e) => {
				e.preventDefault();
				e.stopPropagation();
				item.onAdd?.();
			}}
		>
			{item.adding ? <Spinner className="size-3" /> : "Add"}
		</Button>
	);
}

function Section({
	title,
	subtitle,
	items,
	view,
	onSetAll,
}: {
	title: string;
	subtitle?: string;
	items: BrowserItem[];
	view: "grid" | "list";
	onSetAll: (enabled: boolean) => void;
}) {
	const [open, setOpen] = useState(true);
	const checkedCount = items.filter((i) => i.checked).length;
	return (
		<div className="border-b pb-2">
			<div className="flex w-full items-center gap-1.5 py-2">
				<button
					type="button"
					className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
					onClick={() => setOpen((o) => !o)}
				>
					<HugeiconsIcon
						icon={open ? ArrowDown01Icon : ArrowRight01Icon}
						size={14}
						className="text-muted-foreground"
					/>
					<span className="text-xs font-semibold">{title}</span>
					<span className="text-muted-foreground text-[0.65rem]">
						{checkedCount}/{items.length}
					</span>
					{subtitle && (
						<span className="text-muted-foreground ml-auto truncate text-[0.6rem]">
							{subtitle}
						</span>
					)}
				</button>
				<button
					type="button"
					className="text-muted-foreground hover:text-foreground shrink-0 text-[0.65rem]"
					title={`Select every ${title.toLowerCase()} item`}
					onClick={() => onSetAll(true)}
				>
					All
				</button>
				<span className="text-muted-foreground text-[0.6rem]">·</span>
				<button
					type="button"
					className="text-muted-foreground hover:text-foreground shrink-0 text-[0.65rem]"
					title={`Deselect every ${title.toLowerCase()} item`}
					onClick={() => onSetAll(false)}
				>
					None
				</button>
			</div>
			{open &&
				(view === "grid" ? (
					<div
						className="grid gap-2"
						style={{
							gridTemplateColumns: "repeat(auto-fill, minmax(132px, 1fr))",
						}}
					>
						{items.map((item) => (
							<GridCard key={item.id} item={item} />
						))}
					</div>
				) : (
					<div className="flex flex-col">
						{items.map((item) => (
							<ListRow key={item.id} item={item} />
						))}
					</div>
				))}
		</div>
	);
}

function Preview({
	item,
	className,
}: {
	item: BrowserItem;
	className?: string;
}) {
	const [hovered, setHovered] = useState(false);
	// Some registry posters 404 — fall through to the gradient tile instead
	// of the browser's broken-image icon.
	const [posterFailed, setPosterFailed] = useState(false);
	const base = cn("bg-black/40 overflow-hidden rounded", className);
	if (item.demoSrc) {
		return (
			<video
				src={item.demoSrc}
				className={cn(base, "object-cover")}
				autoPlay
				loop
				muted
				playsInline
			/>
		);
	}
	if (item.previewVideo && hovered) {
		return (
			<video
				src={item.previewVideo}
				poster={
					item.previewPoster && !posterFailed ? item.previewPoster : undefined
				}
				className={cn(base, "object-cover")}
				autoPlay
				loop
				muted
				playsInline
				onMouseLeave={() => setHovered(false)}
			/>
		);
	}
	if (item.previewPoster && !posterFailed) {
		return (
			// eslint-disable-next-line @next/next/no-img-element -- remote registry preview, unknown domains
			<img
				src={item.previewPoster}
				alt={item.title}
				loading="lazy"
				className={cn(base, "object-cover")}
				onError={() => setPosterFailed(true)}
				onMouseEnter={item.previewVideo ? () => setHovered(true) : undefined}
			/>
		);
	}
	if (item.previewVideo) {
		// No (working) poster but a video exists: play it like the demos —
		// an animated preview beats a name tile every time.
		return (
			<video
				src={item.previewVideo}
				className={cn(base, "object-cover")}
				autoPlay
				loop
				muted
				playsInline
			/>
		);
	}
	// No hosted preview (e.g. the example styles): a deterministic gradient
	// tile from the asset name, so nothing reads as broken or missing.
	const hue = [...item.id].reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % 360;
	return (
		<div
			className={cn(base, "flex items-center justify-center")}
			style={{
				background: `linear-gradient(135deg, hsl(${hue} 45% 22%), hsl(${(hue + 50) % 360} 55% 38%))`,
			}}
		>
			<span className="select-none px-1 text-center text-[0.6rem] font-medium text-white/85">
				{item.title}
			</span>
		</div>
	);
}

function GridCard({ item }: { item: BrowserItem }) {
	return (
		<label
			className={cn(
				"flex cursor-pointer flex-col gap-1 rounded-md border p-1.5 transition-colors",
				item.checked ? "border-foreground/20" : "border-transparent opacity-50",
			)}
			title={item.description || item.title}
		>
			<Preview item={item} className="aspect-video w-full" />
			<div className="flex items-center gap-1.5">
				<Checkbox checked={item.checked} onCheckedChange={item.onToggle} />
				<span className="truncate text-xs">{item.title}</span>
				<span className="ml-auto" />
				<AddButton item={item} />
			</div>
		</label>
	);
}

function ListRow({ item }: { item: BrowserItem }) {
	return (
		<label
			className={cn(
				"flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-foreground/5",
				!item.checked && "opacity-50",
			)}
			title={item.description || item.title}
		>
			<Checkbox checked={item.checked} onCheckedChange={item.onToggle} />
			<Preview item={item} className="h-8 w-14 shrink-0" />
			<div className="min-w-0 flex-1">
				<div className="truncate text-xs">{item.title}</div>
				{item.description && (
					<div className="text-muted-foreground truncate text-[0.6rem]">
						{item.description}
					</div>
				)}
			</div>
			<AddButton item={item} />
		</label>
	);
}

/**
 * Showcase presets: one click pins the planner to a specific LOOK — which
 * templates it may use and a direction brief — so "what do I want to
 * showcase?" is a menu, not a blank prompt. A true full-frame layout
 * (Swiss-grid keypoints around the video) needs a new HyperFrames template
 * and is on the roadmap.
 */
const SHOWCASE_PRESETS: {
	id: string;
	title: string;
	description: string;
	templateIds: string[];
	direction: string;
}[] = [
	{
		id: "key-points",
		title: "Key points",
		description: "A section break per key point, pills for the details.",
		templateIds: ["section-break", "callout-pill"],
		direction:
			"Identify the 3-6 KEY POINTS of this video. Mark the start of each with a section-break naming the point in 2-4 words, and reinforce at most one important detail per point with a callout pill. Nothing else.",
	},
	{
		id: "numbers",
		title: "Numbers & stats",
		description: "Every number gets the number-pop treatment.",
		templateIds: ["number-pop", "callout-pill"],
		direction:
			"Highlight EVERY spoken number, price, percentage, or statistic with number-pop, copied exactly as spoken. Use a callout pill only when a number needs its context named. No other effects.",
	},
	{
		id: "chapters",
		title: "Title & chapters",
		description: "One opening title, then a break per chapter.",
		templateIds: ["kinetic-title", "section-break"],
		direction:
			"Open with ONE kinetic-title naming the video's topic in the first seconds. Then add a section-break at each clear chapter change. No other effects.",
	},
	{
		id: "speaker",
		title: "Speaker & quotes",
		description: "Lower-third intro, best lines as pills.",
		templateIds: ["lower-third", "callout-pill"],
		direction:
			"Add ONE lower-third introducing the speaker near the start (infer the name/role from the transcript; use a fitting description if unnamed). Then pull the 2-4 most quotable lines as callout pills, verbatim.",
	},
	{
		id: "product-launch",
		title: "Product launch",
		description: "Big title, features as pills, specs pop.",
		templateIds: ["kinetic-title", "callout-pill", "number-pop"],
		direction:
			"This is a PRODUCT LAUNCH video. Open with ONE kinetic-title naming the product the moment it's introduced. Name the 2-4 standout features as callout pills as they're described. Pop every price, spec, or number with number-pop, exactly as spoken. Keep it punchy.",
	},
	{
		id: "feature-announcement",
		title: "Feature announcement",
		description: "Announce it, name it, list the benefits.",
		templateIds: ["kinetic-title", "lower-third", "callout-pill"],
		direction:
			"This is a FEATURE ANNOUNCEMENT. Lead with ONE kinetic-title on the headline feature. Add a lower-third naming the feature when it's first shown. Pull the 2-3 concrete benefits as callout pills, in the speaker's words. Nothing else.",
	},
	{
		id: "hype-teaser",
		title: "Hype teaser",
		description: "High-energy: bold titles, every number pops.",
		templateIds: ["kinetic-title", "number-pop", "section-break"],
		direction:
			"This is a high-energy TEASER. Put a bold kinetic-title on each of the punchiest lines (use sparingly — at most one per ~15s). Pop EVERY number. Mark each beat change with a section-break. Fast and loud.",
	},
	{
		id: "explainer",
		title: "Explainer / demo",
		description: "Chaptered walkthrough with labelled steps.",
		templateIds: ["section-break", "lower-third", "callout-pill"],
		direction:
			"This is an EXPLAINER / product demo. Mark each step or section with a section-break naming it in 2-4 words. Use a lower-third to label the tool or screen being shown. Reinforce one key takeaway per step with a callout pill. Calm and clear.",
	},
];

function ShowcaseSection({
	onApply,
}: {
	onApply: (preset: {
		templateIds: string[];
		direction: string;
		title: string;
	}) => void;
}) {
	return (
		<div className="flex flex-col gap-1.5 px-3 pt-1 pb-2">
			<p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
				Showcase
			</p>
			<div className="grid grid-cols-2 gap-1.5">
				{SHOWCASE_PRESETS.map((preset) => (
					<button
						key={preset.id}
						type="button"
						className="bg-foreground/5 hover:bg-foreground/10 hover:ring-primary/50 flex flex-col items-start gap-0.5 rounded-md p-2 text-left ring-1 ring-transparent transition-colors"
						title={preset.direction}
						onClick={() => onApply(preset)}
					>
						<span className="text-xs font-medium">{preset.title}</span>
						<span className="text-muted-foreground text-[10px] leading-snug">
							{preset.description}
						</span>
					</button>
				))}
			</div>
		</div>
	);
}

/** One-line summary of what a saved preset will re-apply. */
function presetSummary(p: HfPreset): string {
	const templateCount = describeTemplateCatalog().filter(
		(t) => !p.disabledTemplateIds.includes(t.id),
	).length;
	const parts = [`${templateCount} template${templateCount === 1 ? "" : "s"}`];
	if (p.promptHfAssets.length) {
		parts.push(
			`${p.promptHfAssets.length} pick${p.promptHfAssets.length === 1 ? "" : "s"}`,
		);
	}
	parts.push(getStyleById(p.styleId).name);
	if (p.hfDirection.trim()) parts.push("direction");
	return parts.join(" · ");
}

function PresetAction({
	label,
	title,
	onClick,
}: {
	label: string;
	title: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			title={title}
			onClick={onClick}
			className="text-muted-foreground hover:text-foreground rounded px-1 text-[10px]"
		>
			{label}
		</button>
	);
}

/**
 * Accent dot + display-type glyph: the at-a-glance form of a design spec,
 * same visual language as the factory Look swatches below.
 */
function ProfileSwatch({
	design,
	className,
}: {
	design: HfDesignSpec;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"flex size-5 shrink-0 items-center justify-center rounded-full",
				className,
			)}
			style={{
				backgroundColor: design.palette.accent,
				fontFamily: design.fonts.display,
			}}
		>
			<span className="text-[0.6rem] font-bold text-black/70">Aa</span>
		</span>
	);
}

/** Small segmented control (the EngineSection pattern, generalized). */
function Segmented<T extends string>({
	value,
	options,
	onChange,
}: {
	value: T;
	options: readonly T[];
	onChange: (value: T) => void;
}) {
	return (
		<div className="bg-foreground/5 flex rounded-md p-0.5">
			{options.map((option) => (
				<button
					key={option}
					type="button"
					className={cn(
						"flex-1 rounded px-2 py-1 text-[0.65rem] capitalize transition-colors",
						value === option
							? "bg-background font-medium shadow-sm"
							: "text-muted-foreground hover:text-foreground",
					)}
					onClick={() => onChange(option)}
				>
					{option}
				</button>
			))}
		</div>
	);
}

function FontSelect({
	label,
	value,
	onChange,
}: {
	label: string;
	value: string;
	onChange: (family: string) => void;
}) {
	return (
		<label className="flex flex-col gap-0.5">
			<span className="text-muted-foreground text-[0.6rem]">{label}</span>
			<select
				value={value}
				onChange={(e) => onChange(e.target.value)}
				className="border-input bg-background rounded border px-1 py-1 text-xs outline-none"
				style={{ fontFamily: value }}
			>
				{PROFILE_FONT_OPTIONS.map((family) => (
					<option key={family} value={family} style={{ fontFamily: family }}>
						{family}
					</option>
				))}
			</select>
		</label>
	);
}

/** At most this many supporting colors per profile (keeps the editor compact). */
const MAX_SUPPORTING_COLORS = 3;

/**
 * The style-profile editor: live swatch + type preview up top, then the
 * design spec fields (palette, fonts, motion, density). Every change commits
 * straight to the preset via updateHfPresetDesign, so the preview and any
 * ACTIVE profile's next generation track the edits as they happen.
 */
function ProfileDesignEditor({ preset }: { preset: HfPreset }) {
	const updateDesign = useAiSettingsStore((s) => s.updateHfPresetDesign);
	const design = preset.design;
	const patch = (partial: Partial<HfDesignSpec>) =>
		updateDesign(preset.id, { ...design, ...partial });
	const patchPalette = (partial: Partial<HfDesignSpec["palette"]>) =>
		patch({ palette: { ...design.palette, ...partial } });
	const patchFonts = (partial: Partial<HfDesignSpec["fonts"]>) =>
		patch({ fonts: { ...design.fonts, ...partial } });

	return (
		<div className="border-foreground/10 mt-1 flex flex-col gap-2 rounded-md border p-2">
			{/* Live preview: accent bar + display headline + body line. */}
			<div className="bg-black/40 overflow-hidden rounded">
				<div
					className="h-1.5"
					style={{ backgroundColor: design.palette.accent }}
				/>
				<div className="flex flex-col gap-0.5 p-2">
					<span
						className="text-sm font-bold text-white"
						style={{ fontFamily: design.fonts.display }}
					>
						{preset.name}
					</span>
					<span
						className="text-[0.65rem] text-white/70"
						style={{ fontFamily: design.fonts.body }}
					>
						Body text previews in {design.fonts.body}.
					</span>
					<div className="mt-1 flex items-center gap-1">
						{[design.palette.accent, ...design.palette.supporting].map(
							(color, i) => (
								<span
									key={`${color}-${i}`}
									className="size-3 rounded-full"
									style={{ backgroundColor: color }}
								/>
							),
						)}
					</div>
				</div>
			</div>

			<div className="flex items-end gap-2">
				<label className="flex flex-col gap-0.5">
					<span className="text-muted-foreground text-[0.6rem]">Accent</span>
					<input
						type="color"
						value={design.palette.accent}
						onChange={(e) => patchPalette({ accent: e.target.value })}
						className="border-input bg-background h-7 w-10 cursor-pointer rounded border p-0.5"
					/>
				</label>
				<div className="flex flex-col gap-0.5">
					<span className="text-muted-foreground text-[0.6rem]">
						Supporting
					</span>
					<div className="flex items-center gap-1">
						{design.palette.supporting.map((color, i) => (
							<input
								key={i}
								type="color"
								value={color}
								title="Click to change, double-click to remove"
								onChange={(e) =>
									patchPalette({
										supporting: design.palette.supporting.map((c, j) =>
											j === i ? e.target.value : c,
										),
									})
								}
								onDoubleClick={() =>
									patchPalette({
										supporting: design.palette.supporting.filter(
											(_, j) => j !== i,
										),
									})
								}
								className="border-input bg-background h-7 w-10 cursor-pointer rounded border p-0.5"
							/>
						))}
						{design.palette.supporting.length < MAX_SUPPORTING_COLORS && (
							<button
								type="button"
								title="Add a supporting color"
								className="text-muted-foreground hover:text-foreground border-input h-7 w-10 rounded border border-dashed text-xs"
								onClick={() =>
									patchPalette({
										supporting: [...design.palette.supporting, "#888888"],
									})
								}
							>
								+
							</button>
						)}
					</div>
				</div>
			</div>

			<div className="grid grid-cols-2 gap-2">
				<FontSelect
					label="Display font"
					value={design.fonts.display}
					onChange={(family) => patchFonts({ display: family })}
				/>
				<FontSelect
					label="Body font"
					value={design.fonts.body}
					onChange={(family) => patchFonts({ body: family })}
				/>
			</div>

			<label className="flex flex-col gap-0.5">
				<span className="text-muted-foreground text-[0.6rem]">
					Motion style
				</span>
				<Segmented<HfMotionStyle>
					value={design.motion}
					options={HF_MOTION_STYLES}
					onChange={(motion) => patch({ motion })}
				/>
			</label>
			<label className="flex flex-col gap-0.5">
				<span className="text-muted-foreground text-[0.6rem]">Density</span>
				<Segmented<HfDensity>
					value={design.density}
					options={HF_DENSITIES}
					onChange={(density) => patch({ density })}
				/>
			</label>
		</div>
	);
}

/**
 * User-saved HyperFrames presets, doubling as STYLE PROFILES: each snapshots
 * the current templates + pinned picks + look + direction AND carries a
 * design spec (palette, fonts, motion, density) edited inline. The active
 * preset is highlighted and clears the moment a selection diverges; picking
 * a factory Look below also deactivates it.
 */
function CustomPresetsSection() {
	const presets = useAiSettingsStore((s) => s.hfPresets);
	const activeId = useAiSettingsStore((s) => s.activeHfPresetId);
	const savePreset = useAiSettingsStore((s) => s.saveHfPreset);
	const loadPreset = useAiSettingsStore((s) => s.loadHfPreset);
	const renamePreset = useAiSettingsStore((s) => s.renameHfPreset);
	const deletePreset = useAiSettingsStore((s) => s.deleteHfPreset);
	const duplicatePreset = useAiSettingsStore((s) => s.duplicateHfPreset);

	const [editingId, setEditingId] = useState<string | null>(null);
	const [draftName, setDraftName] = useState("");
	const renameInputRef = useRef<HTMLInputElement>(null);
	// Which preset's profile editor is open (at most one at a time).
	const [designEditingId, setDesignEditingId] = useState<string | null>(null);

	// Focus the rename field when it opens (avoids the autoFocus prop, which
	// the a11y lint forbids, and the re-focus-every-keystroke of a callback ref).
	useEffect(() => {
		if (editingId) renameInputRef.current?.focus();
	}, [editingId]);

	const startRename = (p: HfPreset) => {
		setEditingId(p.id);
		setDraftName(p.name);
	};
	const commitRename = () => {
		if (editingId) renamePreset(editingId, draftName);
		setEditingId(null);
	};

	const atCap = presets.length >= MAX_HF_PRESETS;

	return (
		<div className="flex flex-col gap-1.5 px-3 pt-1 pb-2">
			<div className="flex items-center justify-between">
				<p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
					Style profiles
				</p>
				<span className="text-muted-foreground text-[10px]">
					{presets.length}/{MAX_HF_PRESETS}
				</span>
			</div>
			{presets.length === 0 ? (
				<p className="text-muted-foreground text-[10px] leading-snug">
					Save the current templates, pinned picks, look, and direction as a
					reusable profile, then edit its design (palette, fonts, motion,
					density). The ACTIVE profile&apos;s design colors every generation;
					picking a factory Look below deactivates it.
				</p>
			) : (
				<div className="flex flex-col gap-1">
					{presets.map((p) => {
						const active = p.id === activeId;
						return (
							<div key={p.id}>
								<div
									className={cn(
										"flex items-center gap-1.5 rounded-md px-2 py-1.5 ring-1 transition-colors",
										active
											? "bg-primary/10 ring-primary/50"
											: "bg-foreground/5 hover:bg-foreground/10 ring-transparent",
									)}
								>
									<ProfileSwatch design={p.design} />
									{editingId === p.id ? (
										<input
											ref={renameInputRef}
											value={draftName}
											onChange={(e) => setDraftName(e.target.value)}
											onBlur={commitRename}
											onKeyDown={(e) => {
												if (e.key === "Enter") commitRename();
												if (e.key === "Escape") setEditingId(null);
											}}
											className="border-input bg-background min-w-0 flex-1 rounded border px-1 py-0.5 text-xs outline-none"
										/>
									) : (
										<button
											type="button"
											className="min-w-0 flex-1 text-left"
											title="Load this profile's selections"
											onClick={() => loadPreset(p.id)}
										>
											<span className="flex items-center gap-1.5">
												<span className="truncate text-xs font-medium">
													{p.name}
												</span>
												{active && (
													<span className="text-primary text-[9px] tracking-wide uppercase">
														active
													</span>
												)}
											</span>
											<span className="text-muted-foreground block truncate text-[10px]">
												{presetSummary(p)}
											</span>
										</button>
									)}
									{editingId !== p.id && (
										<div className="flex shrink-0 flex-wrap items-center justify-end gap-0.5">
											<PresetAction
												label={designEditingId === p.id ? "Close" : "Design"}
												title="Edit this profile's palette, fonts, motion, and density"
												onClick={() =>
													setDesignEditingId((cur) =>
														cur === p.id ? null : p.id,
													)
												}
											/>
											<PresetAction
												label="Duplicate"
												title="Copy this profile into a new slot"
												onClick={() => duplicatePreset(p.id)}
											/>
											<PresetAction
												label="Update"
												title="Overwrite this preset with the current selection"
												onClick={() => savePreset(p.id)}
											/>
											<PresetAction
												label="Rename"
												title="Rename this preset"
												onClick={() => startRename(p)}
											/>
											<PresetAction
												label="Delete"
												title="Delete this preset"
												onClick={() => deletePreset(p.id)}
											/>
										</div>
									)}
								</div>
								{designEditingId === p.id && <ProfileDesignEditor preset={p} />}
							</div>
						);
					})}
				</div>
			)}
			<Button
				size="sm"
				variant="secondary"
				className="h-7 self-start text-xs"
				disabled={atCap}
				title={
					atCap
						? `You can save up to ${MAX_HF_PRESETS} profiles - delete one first.`
						: "Save the current templates, picks, look, and direction as a new profile"
				}
				onClick={() => savePreset()}
			>
				+ Save current selection
			</Button>
		</div>
	);
}

function EngineSection() {
	const engine = useAiSettingsStore((s) => s.hfEngine);
	const setEngine = useAiSettingsStore((s) => s.setHfEngine);
	return (
		<div className="flex flex-col gap-1.5 px-3 pt-1 pb-2">
			<p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
				Effect engine
			</p>
			<div className="bg-foreground/5 flex rounded-md p-0.5">
				{(
					[
						["authored", "Authored"],
						["native", "Instant"],
						["cinematic", "Cinematic"],
					] as const
				).map(([value, label]) => (
					<button
						key={value}
						type="button"
						className={cn(
							"flex-1 rounded px-2 py-1 text-xs transition-colors",
							engine === value
								? "bg-background font-medium shadow-sm"
								: "text-muted-foreground hover:text-foreground",
						)}
						onClick={() => setEngine(value)}
					>
						{label}
					</button>
				))}
			</div>
			<p className="text-muted-foreground text-[10px] leading-snug">
				{engine === "authored"
					? "Default. Claude authors a custom composition from your checked assets, direction, and transcript, overlaid on your footage. Runs the HyperFrames skill; slower in-browser render."
					: engine === "native"
						? "Fast: places editable motion-template elements instantly. Ignores your style and asset picks."
						: "Renders the built-in templates with HyperFrames and burns them in at export. Ignores your style and asset picks."}
			</p>
		</div>
	);
}

/**
 * Step 2 of the start flow: the free-text direction. A showcase below fills
 * this in for you; either way the run's brief carries it.
 */
function DirectionSection() {
	const hfDirection = useAiSettingsStore((s) => s.hfDirection);
	const setHfDirection = useAiSettingsStore((s) => s.setHfDirection);
	return (
		<div className="px-3 pt-1 pb-2">
			<h3 className="text-xs font-semibold">Describe what you want</h3>
			<textarea
				value={hfDirection}
				onChange={(e) => setHfDirection(e.target.value)}
				placeholder="Tell HyperFrames how to edit..."
				rows={3}
				className="border-input bg-background mt-2 w-full resize-y rounded-md border p-2 text-xs outline-none focus:ring-1"
			/>
		</div>
	);
}

/**
 * The flow's last step: what RUN actually does now (T20.2's probe gate), so
 * the panel teaches the probe-first model instead of the old direct-run one.
 */
function RunFlowNote() {
	return (
		<p className="text-muted-foreground bg-foreground/5 mx-3 mt-1 rounded-md p-2 text-[0.65rem] leading-snug">
			Hit <span className="text-foreground">RUN HYPERFRAMES</span> in the
			timeline toolbar. A run renders a short probe of each segment first -
			approve the probes in the drafts review to start the full render, and
			retry any failed segment there. Nothing renders in full before you
			approve.
		</p>
	);
}

/**
 * The tuning knobs, collapsed by default (T20.4): the start flow is
 * profile -> describe -> RUN, and everything that shapes the run's palette
 * (engine, templates, registry styles/blocks/components, factory Look)
 * stays one disclosure away. Nothing was removed, only re-flowed.
 */
function AdvancedSection({ children }: { children: ReactNode }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="border-b px-3 pb-1">
			<button
				type="button"
				className="flex w-full items-center gap-1.5 py-2 text-left"
				onClick={() => setOpen((o) => !o)}
				aria-expanded={open}
			>
				<HugeiconsIcon
					icon={open ? ArrowDown01Icon : ArrowRight01Icon}
					size={14}
					className="text-muted-foreground"
				/>
				<span className="text-xs font-semibold">Advanced</span>
				<span className="text-muted-foreground text-[0.65rem]">
					engine, template palette, registry assets, factory look
				</span>
			</button>
			{open && children}
		</div>
	);
}

export function HyperframesPanel() {
	const disabledTemplateIds = useAiSettingsStore((s) => s.disabledTemplateIds);
	const toggleTemplate = useAiSettingsStore((s) => s.toggleTemplate);
	const promptHfAssets = useAiSettingsStore((s) => s.promptHfAssets);
	const togglePromptHfAsset = useAiSettingsStore((s) => s.togglePromptHfAsset);
	const styleId = useAiSettingsStore((s) => s.styleId);
	const setStyleId = useAiSettingsStore((s) => s.setStyleId);
	const setHfDirection = useAiSettingsStore((s) => s.setHfDirection);
	const tokensUsedTotal = useAiSettingsStore((s) => s.tokensUsedTotal);
	const view = useAiSettingsStore((s) => s.hfBrowserView);
	const setView = useAiSettingsStore((s) => s.setHfBrowserView);
	const setTemplatesEnabled = useAiSettingsStore((s) => s.setTemplatesEnabled);
	const setPromptHfAssetsEnabled = useAiSettingsStore(
		(s) => s.setPromptHfAssetsEnabled,
	);

	const editor = useEditor();
	const [bakingName, setBakingName] = useState<string | null>(null);
	const addBlock = async ({
		name,
		title,
		type,
	}: {
		name: string;
		title: string;
		type: string;
	}) => {
		setBakingName(name);
		const toastId = toast.loading(`Baking ${title}...`, {
			description:
				"First bake renders once on your computer (~10-30s), then it's instant.",
		});
		try {
			const result = await bakeAndPlaceBlock({ editor, name, type });
			toast.success(`Added ${result.title}`, {
				id: toastId,
				description: result.cached
					? "Reused the cached bake — instant."
					: "Baked once and cached — next time is instant.",
			});
		} catch (e) {
			toast.error("Could not add asset", {
				id: toastId,
				description: e instanceof Error ? e.message : String(e),
			});
		} finally {
			setBakingName(null);
		}
	};

	const [registry, setRegistry] = useState<RegistryAsset[]>([]);
	const [registryError, setRegistryError] = useState<string | null>(null);
	useEffect(() => {
		let cancelled = false;
		fetch("/api/hyperframes/registry")
			.then((res) => res.json())
			.then((data: { items: RegistryAsset[]; error?: string }) => {
				if (cancelled) return;
				setRegistry(data.items ?? []);
				if (data.error) setRegistryError(data.error);
			})
			.catch(() => {
				if (!cancelled) setRegistryError("Could not load the registry.");
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const templateItems: BrowserItem[] = describeTemplateCatalog().map((t) => ({
		id: t.id,
		title: t.name,
		description: t.description,
		checked: !disabledTemplateIds.includes(t.id),
		onToggle: () => toggleTemplate(t.id),
		demoSrc: `/hf-demos/${t.id}.webm`,
	}));
	const registryItems = (
		kind: string,
		predicate?: (a: RegistryAsset) => boolean,
	): BrowserItem[] =>
		registry
			.filter((a) => a.type === `hyperframes:${kind}`)
			.filter((a) => (predicate ? predicate(a) : true))
			.map((a) => ({
				id: a.name,
				title: a.title,
				description: a.description,
				checked: promptHfAssets.includes(a.name),
				onToggle: () => togglePromptHfAsset(a.name),
				// Example styles publish no preview media — we bake posters and
				// short hover clips locally from real renders (hf-demos/styles/).
				previewVideo:
					a.previewVideo ??
					(kind === "example" ? `/hf-demos/styles/${a.name}.mp4` : null),
				previewPoster:
					a.previewPoster ??
					(kind === "example" ? `/hf-demos/styles/${a.name}.png` : null),
				// Any renderable, non-transition item (block, full-frame example, or
				// composition-bearing component) gets an Add — it bakes to a droppable
				// clip. Transitions still need a between-clips slot, so they get none.
				...(a.renderable && !isTransitionBlock(a)
					? {
							onAdd: () =>
								void addBlock({ name: a.name, title: a.title, type: a.type }),
							adding: bakingName === a.name,
						}
					: {}),
			}));

	return (
		<PanelView
			title="HyperFrames"
			actions={
				<div className="flex items-center">
					<Button
						size="icon"
						variant="ghost"
						title={
							view === "grid" ? "Switch to list view" : "Switch to grid view"
						}
						onClick={() => setView(view === "grid" ? "list" : "grid")}
					>
						<HugeiconsIcon
							icon={view === "grid" ? LeftToRightListDashIcon : GridViewIcon}
						/>
					</Button>
					<Button
						size="icon"
						variant="ghost"
						title="Maximize this panel (` or double-click the header)"
						onClick={() =>
							usePanelMaximizeStore.getState().toggleMaximized("assets")
						}
					>
						<HugeiconsIcon icon={FullScreenIcon} />
					</Button>
				</div>
			}
		>
			<div className="flex flex-col gap-1 pb-4">
				<CustomPresetsSection />
				<DirectionSection />
				<ShowcaseSection
					onApply={({ templateIds, direction, title }) => {
						const allIds = describeTemplateCatalog().map((t) => t.id);
						setTemplatesEnabled(allIds, false);
						setTemplatesEnabled(templateIds, true);
						setHfDirection(direction);
						toast.success(`Showcase applied: ${title}`, {
							description:
								"Templates and direction are set — hit RUN HYPERFRAMES.",
						});
					}}
				/>
				<RunFlowNote />
				<AdvancedSection>
					<EngineSection />
					<Section
						title="Templates"
						subtitle="used by RUN HYPERFRAMES"
						items={templateItems}
						view={view}
						onSetAll={(enabled) =>
							setTemplatesEnabled(
								templateItems.map((t) => t.id),
								enabled,
							)
						}
					/>
					<Section
						title="Styles"
						subtitle="whole-video looks; check to use, RUN authors it over your footage"
						items={registryItems("example")}
						view={view}
						onSetAll={(enabled) =>
							setPromptHfAssetsEnabled(
								registryItems("example").map((i) => i.id),
								enabled,
							)
						}
					/>
					<Section
						title="Blocks"
						subtitle="graphics & cards; Add drops one, or check to use in RUN"
						items={registryItems("block", (a) => !isTransitionBlock(a))}
						view={view}
						onSetAll={(enabled) =>
							setPromptHfAssetsEnabled(
								registryItems("block", (a) => !isTransitionBlock(a)).map(
									(i) => i.id,
								),
								enabled,
							)
						}
					/>
					<Section
						title="Transitions & effects"
						subtitle="need a transition slot — not droppable yet"
						items={registryItems("block", isTransitionBlock)}
						view={view}
						onSetAll={(enabled) =>
							setPromptHfAssetsEnabled(
								registryItems("block", isTransitionBlock).map((i) => i.id),
								enabled,
							)
						}
					/>
					<Section
						title="Components"
						subtitle="caption & effect snippets; check to use in the RUN prompt"
						items={registryItems("component")}
						view={view}
						onSetAll={(enabled) =>
							setPromptHfAssetsEnabled(
								registryItems("component").map((i) => i.id),
								enabled,
							)
						}
					/>
					{registryError && (
						<p className="text-muted-foreground text-[0.65rem]">
							{registryError}
						</p>
					)}

					<div className="pt-2">
						<h3 className="text-xs font-semibold">Look</h3>
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
									style={{
										backgroundColor: style.accent,
										fontFamily: style.fontFamily,
									}}
								>
									<span className="text-[0.7rem] font-bold text-black/70">
										Aa
									</span>
								</button>
							))}
						</div>
						<p className="text-muted-foreground mt-1.5 text-[0.65rem]">
							<span className="text-foreground">
								{getStyleById(styleId).name}
							</span>
							{" — "}
							{getStyleById(styleId).fontFamily} type + accent. The factory
							profile set: sets every template&apos;s font + color and biases
							RUN HYPERFRAMES while no style profile is active.
						</p>
					</div>
				</AdvancedSection>

				<p className="text-muted-foreground pt-1 text-[0.65rem]">
					Checked templates are the palette RUN HYPERFRAMES picks from today
					(under Advanced).
					<span className="text-foreground">Check</span> any style, block, or
					component to add it to the RUN HYPERFRAMES prompt; the Authored engine
					(default) authors them over your footage. Instant and Cinematic are
					fast modes that ignore picks. Blocks can also be dropped with Add.
					Claude usage on this device: ~{tokensUsedTotal.toLocaleString()}{" "}
					tokens.
				</p>
			</div>
		</PanelView>
	);
}
