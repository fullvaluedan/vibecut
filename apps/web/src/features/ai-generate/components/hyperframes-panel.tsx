"use client";

/**
 * The HyperFrames asset home (left sidebar tab): every template, style,
 * block, and component in one place — collapsible sections, visual
 * previews, grid/list views, and persisted checkboxes that pick your
 * palette. Template checkboxes gate RUN HYPERFRAMES; blocks have an "Add"
 * action that bakes them to a cached WebM and drops them on the timeline;
 * styles/components are saved for releases that render them directly.
 */

import { useEffect, useState } from "react";
import { describeTemplateCatalog } from "@framecut/hf-bridge/templates";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { useAiSettingsStore } from "@/features/ai-generate/store";
import { VIBE_STYLES, getStyleById } from "@/features/ai-generate/styles";
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
	/** Allow-list pick: when present, a star toggles this into the author brief. */
	pinned?: boolean;
	onPin?: () => void;
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

/** Star toggle: pick this registry asset into the RUN HYPERFRAMES brief. */
function PinButton({ item }: { item: BrowserItem }) {
	if (!item.onPin) return null;
	return (
		<button
			type="button"
			className={cn(
				"shrink-0 rounded px-1 text-sm leading-none",
				item.pinned
					? "text-yellow-400"
					: "text-muted-foreground hover:text-foreground",
			)}
			title={
				item.pinned
					? "Picked for the RUN HYPERFRAMES brief — click to remove"
					: "Use this asset in the RUN HYPERFRAMES brief"
			}
			onClick={(e) => {
				e.preventDefault();
				e.stopPropagation();
				item.onPin?.();
			}}
		>
			{item.pinned ? "★" : "☆"}
		</button>
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
					item.previewPoster && !posterFailed
						? item.previewPoster
						: undefined
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
	const hue =
		[...item.id].reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % 360;
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
				<PinButton item={item} />
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
			<PinButton item={item} />
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
						["native", "Instant"],
						["cinematic", "Cinematic"],
						["authored", "Authored"],
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
				{engine === "native"
					? "Places editable motion-template elements instantly — exports at full speed."
					: engine === "cinematic"
						? "Renders each effect with HyperFrames (~real time per effect) and burns them in at export."
						: "Claude AUTHORS one custom composition for the whole video from your selections + picks + transcript, on a new track. Slower, fully bespoke."}
			</p>
		</div>
	);
}

export function HyperframesPanel() {
	const disabledTemplateIds = useAiSettingsStore((s) => s.disabledTemplateIds);
	const toggleTemplate = useAiSettingsStore((s) => s.toggleTemplate);
	const disabledHfAssets = useAiSettingsStore((s) => s.disabledHfAssets);
	const toggleHfAsset = useAiSettingsStore((s) => s.toggleHfAsset);
	const promptHfAssets = useAiSettingsStore((s) => s.promptHfAssets);
	const togglePromptHfAsset = useAiSettingsStore((s) => s.togglePromptHfAsset);
	const styleId = useAiSettingsStore((s) => s.styleId);
	const setStyleId = useAiSettingsStore((s) => s.setStyleId);
	const hfDirection = useAiSettingsStore((s) => s.hfDirection);
	const setHfDirection = useAiSettingsStore((s) => s.setHfDirection);
	const tokensUsedTotal = useAiSettingsStore((s) => s.tokensUsedTotal);
	const view = useAiSettingsStore((s) => s.hfBrowserView);
	const setView = useAiSettingsStore((s) => s.setHfBrowserView);
	const setTemplatesEnabled = useAiSettingsStore((s) => s.setTemplatesEnabled);
	const setHfAssetsEnabled = useAiSettingsStore((s) => s.setHfAssetsEnabled);

	const editor = useEditor();
	const [bakingName, setBakingName] = useState<string | null>(null);
	const addBlock = async (name: string, title: string) => {
		setBakingName(name);
		const toastId = toast.loading(`Baking ${title}...`, {
			description:
				"First bake renders once on your computer (~10-30s), then it's instant.",
		});
		try {
			const result = await bakeAndPlaceBlock({ editor, name });
			toast.success(`Added ${result.title}`, {
				id: toastId,
				description: result.cached
					? "Reused the cached bake — instant."
					: "Baked once and cached — next time is instant.",
			});
		} catch (e) {
			toast.error("Could not add block", {
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
				checked: !disabledHfAssets.includes(a.name),
				onToggle: () => toggleHfAsset(a.name),
				pinned: promptHfAssets.includes(a.name),
				onPin: () => togglePromptHfAsset(a.name),
				// Example styles publish no preview media — we bake posters and
				// short hover clips locally from real renders (hf-demos/styles/).
				previewVideo:
					a.previewVideo ??
					(kind === "example" ? `/hf-demos/styles/${a.name}.mp4` : null),
				previewPoster:
					a.previewPoster ??
					(kind === "example" ? `/hf-demos/styles/${a.name}.png` : null),
				// Only OVERLAY-SAFE blocks (graphics/cards, not transitions) get an
				// Add — transitions bake to a self-demo, not a usable overlay.
				...(kind === "block" && !isTransitionBlock(a)
					? {
							onAdd: () => void addBlock(a.name, a.title),
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
				<EngineSection />
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
					subtitle="looks — apply to your whole edit (coming soon)"
					items={registryItems("example")}
					view={view}
					onSetAll={(enabled) =>
						setHfAssetsEnabled(
							registryItems("example").map((i) => i.id),
							enabled,
						)
					}
				/>
				<Section
					title="Blocks"
					subtitle="graphics & cards — Add drops on the timeline"
					items={registryItems("block", (a) => !isTransitionBlock(a))}
					view={view}
					onSetAll={(enabled) =>
						setHfAssetsEnabled(
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
						setHfAssetsEnabled(
							registryItems("block", isTransitionBlock).map((i) => i.id),
							enabled,
						)
					}
				/>
				<Section
					title="Components"
					subtitle="captions & effects — not droppable yet"
					items={registryItems("component")}
					view={view}
					onSetAll={(enabled) =>
						setHfAssetsEnabled(
							registryItems("component").map((i) => i.id),
							enabled,
						)
					}
				/>
				{registryError && (
					<p className="text-muted-foreground text-[0.65rem]">{registryError}</p>
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
						<span className="text-foreground">{getStyleById(styleId).name}</span>
						{" — "}
						{getStyleById(styleId).fontFamily} type + accent.
						Sets every template&apos;s font + color and biases RUN HYPERFRAMES.
					</p>
				</div>

				<div className="pt-2">
					<h3 className="text-xs font-semibold">Direction</h3>
					<textarea
						value={hfDirection}
						onChange={(e) => setHfDirection(e.target.value)}
						placeholder="Tell HyperFrames how to edit..."
						rows={3}
						className="border-input bg-background mt-2 w-full resize-y rounded-md border p-2 text-xs outline-none focus:ring-1"
					/>
				</div>

				<p className="text-muted-foreground pt-1 text-[0.65rem]">
					Checked templates are the palette RUN HYPERFRAMES picks from today.
					<span className="text-foreground"> Blocks</span> (graphics & cards) bake
					once on your computer and drop straight onto the timeline (cached after
					the first render). Transitions, styles, and components can&apos;t be
					dropped yet — transitions need a between-clips slot, styles apply as a
					whole look, and components are caption/effect layers. Claude usage on
					this device: ~{tokensUsedTotal.toLocaleString()} tokens.
				</p>
			</div>
		</PanelView>
	);
}
