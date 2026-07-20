import type { ElementType } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
	ClosedCaptionIcon,
	Folder03Icon,
	Note01Icon,
	HeadphonesIcon,
	MagicWand05Icon,
	TextIcon,
	Settings01Icon,
	ColorsIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { OcShapesIcon } from "@/components/icons";
import { HIDDEN_ASSET_TABS } from "@/features/editing/surface-flags";

// Dead surfaces removed (menu IA audit): "transitions" and "adjustment" were
// permanent "coming soon" placeholder views with no functionality behind
// them and no code path that ever selected them.
export const TAB_KEYS = [
	"media",
	"hyperframes",
	"sounds",
	"text",
	"shapes",
	"effects",
	"captions",
	"transcript",
	"settings",
] as const;

export type Tab = (typeof TAB_KEYS)[number];

/**
 * Tabs actually shown in the tab rail (hidden-list panels excluded per
 * `surface-flags.ts`). Everything else in this file - `tabs`, the store's
 * `activeTab` - still covers the full `TAB_KEYS` set; only rendering and the
 * fallback below are aware of the hidden list.
 */
export const VISIBLE_TAB_KEYS = TAB_KEYS.filter(
	(key) => !HIDDEN_ASSET_TABS.includes(key),
);

export const DEFAULT_TAB: Tab = "media";

/**
 * A hidden tab is never a valid active tab; fall back to Media instead. Used
 * both by `setActiveTab` and by the persist `merge` below, so a hidden tab
 * can never become active whether it is set at runtime or restored from a
 * previous session's storage.
 */
export function resolveActiveTab(tab: Tab): Tab {
	return HIDDEN_ASSET_TABS.includes(tab) ? DEFAULT_TAB : tab;
}

const createHugeiconsIcon =
	({ icon }: { icon: IconSvgElement }) =>
	({ className }: { className?: string }) => (
		<HugeiconsIcon icon={icon} className={className} />
	);

export const tabs = {
	media: {
		icon: createHugeiconsIcon({ icon: Folder03Icon }),
		label: "Media",
	},
	hyperframes: {
		icon: createHugeiconsIcon({ icon: ColorsIcon }),
		label: "HyperFrames",
	},
	sounds: {
		icon: createHugeiconsIcon({ icon: HeadphonesIcon }),
		label: "Sounds",
	},
	text: {
		icon: createHugeiconsIcon({ icon: TextIcon }),
		label: "Text",
	},
	shapes: {
		icon: ({ className }: { className?: string }) => (
			<OcShapesIcon className={className} />
		),
		label: "Shapes",
	},
	effects: {
		icon: createHugeiconsIcon({ icon: MagicWand05Icon }),
		label: "Effects",
	},
	captions: {
		icon: createHugeiconsIcon({ icon: ClosedCaptionIcon }),
		label: "Captions",
	},
	transcript: {
		icon: createHugeiconsIcon({ icon: Note01Icon }),
		label: "Transcript",
	},
	settings: {
		icon: createHugeiconsIcon({ icon: Settings01Icon }),
		label: "Settings",
	},
} satisfies Record<
	Tab,
	{ icon: ElementType<{ className?: string }>; label: string }
>;

export type MediaViewMode = "grid" | "list";
export type MediaSortKey = "name" | "type" | "duration" | "size";
export type MediaSortOrder = "asc" | "desc";

interface AssetsPanelStore {
	activeTab: Tab;
	setActiveTab: (tab: Tab) => void;
	highlightMediaId: string | null;
	requestRevealMedia: (mediaId: string) => void;
	clearHighlight: () => void;

	/* Media */
	mediaViewMode: MediaViewMode;
	setMediaViewMode: (mode: MediaViewMode) => void;
	mediaSortBy: MediaSortKey;
	mediaSortOrder: MediaSortOrder;
	setMediaSort: (args: { key: MediaSortKey; order: MediaSortOrder }) => void;
}

/**
 * A hidden tab (from a stale session, or a version of the app where it was
 * still visible) is never restored as-is - every persisted value is run
 * through the same `resolveActiveTab` fallback used at runtime, so a reload
 * never lands on a blank hidden panel. Named + exported (rather than inlined
 * in the `persist` config below) so it is directly unit-testable.
 */
export function mergeAssetsPanelState(
	persistedState: unknown,
	currentState: AssetsPanelStore,
): AssetsPanelStore {
	const persisted = persistedState as Partial<AssetsPanelStore> | undefined;
	const merged = { ...currentState, ...persisted };
	return { ...merged, activeTab: resolveActiveTab(merged.activeTab) };
}

export const useAssetsPanelStore = create<AssetsPanelStore>()(
	persist(
		(set) => ({
			activeTab: DEFAULT_TAB,
			setActiveTab: (tab) => set({ activeTab: resolveActiveTab(tab) }),
			highlightMediaId: null,
			requestRevealMedia: (mediaId) =>
				set({ activeTab: DEFAULT_TAB, highlightMediaId: mediaId }),
			clearHighlight: () => set({ highlightMediaId: null }),
			mediaViewMode: "grid",
			setMediaViewMode: (mode) => set({ mediaViewMode: mode }),
			mediaSortBy: "name",
			mediaSortOrder: "asc",
			setMediaSort: ({ key, order }) =>
				set({ mediaSortBy: key, mediaSortOrder: order }),
		}),
		{
			name: "assets-panel",
			merge: mergeAssetsPanelState,
			partialize: (state) => ({
				activeTab: state.activeTab,
				mediaViewMode: state.mediaViewMode,
				mediaSortBy: state.mediaSortBy,
				mediaSortOrder: state.mediaSortOrder,
			}),
		},
	),
);
