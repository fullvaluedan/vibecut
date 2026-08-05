"use client";

import { useParams } from "next/navigation";
import {
	ResizablePanelGroup,
	ResizablePanel,
	ResizableHandle,
} from "@/components/ui/resizable";
import { AssetsPanel } from "@/components/editor/panels/assets";
import { DirectorDockShell } from "@/features/ai-generate/director/components/director-dock-shell";
import { Timeline } from "@/timeline/components";
import { PreviewPanel } from "@/preview/components";
import { EditorHeader } from "@/components/editor/editor-header";
import { EditorProvider } from "@/components/providers/editor-provider";
import { MigrationDialog } from "@/project/components/migration-dialog";
import { usePanelStore } from "@/editor/panel-store";
import {
	usePanelMaximizeStore,
	type EditorPanelId,
} from "@/editor/panel-maximize-store";
import { useActionHandler } from "@/actions/use-action-handler";
import { useEffect } from "react";
import { usePasteMedia } from "@/media/use-paste-media";
import { MobileGate } from "@/components/editor/mobile-gate";
import { useMemo, useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@/components/ui/button";
import { ChangelogNotification } from "@/changelog/components/changelog-notification";
import {
	createPreviewOverlayControl,
	isPreviewOverlayVisible,
	mergePreviewOverlaySources,
} from "@/preview/overlays";
import { usePreviewStore } from "@/preview/preview-store";
import { getGuidePreviewOverlaySource } from "@/guides";
import {
	bookmarkNotesPreviewOverlay,
	getBookmarkPreviewOverlaySource,
} from "@/timeline/bookmarks/index";
import { BackgroundTranscriber } from "@/features/transcription/background-transcriber";
import { getWasmCapabilities } from "@/services/renderer/wasm-capabilities";
import { parseOpenParam, resolveOpenParamAction } from "./deep-link-open";
import { useDirectorPlanStore } from "@/features/ai-generate/director/director-plan-store";
import { useAssetsPanelStore } from "@/components/editor/panels/assets/assets-panel-store";

/**
 * T18.5: home-page tiles ("AI Cut", "Edit by transcript", "Auto captions")
 * deep-link here via `?open=director|transcript|captions`. Reads the param
 * once on mount, opens the matching panel, then strips it from the URL via
 * history.replaceState (no navigation/reload). Unknown/missing params are a
 * no-op - see deep-link-open.ts for the pure param -> action mapping.
 *
 * T21.1: also handles `ai-settings` (the get-started page's "Add your key in
 * Settings" button) - opens the Settings tab AND requests its AI sub-tab.
 */
function useDeepLinkOpen() {
	useEffect(() => {
		const url = new URL(window.location.href);
		const param = parseOpenParam(url.searchParams.get("open"));
		if (!param) return;

		const action = resolveOpenParamAction(param);
		if (action.store === "director") {
			useDirectorPlanStore.getState().setDockTab("director");
		} else {
			useAssetsPanelStore.getState().setActiveTab(action.tab);
			if (action.tab === "settings") {
				useAssetsPanelStore.getState().setSettingsSubView(action.settingsSubView);
			}
		}

		url.searchParams.delete("open");
		window.history.replaceState(null, "", url.toString());
	}, []);
}

export default function Editor() {
	const params = useParams();
	const rawProjectId = params.project_id;
	const projectId = typeof rawProjectId === "string" ? rawProjectId : "";
	useDeepLinkOpen();

	return (
		<MobileGate>
			<EditorProvider projectId={projectId}>
				<div className="bg-background flex h-screen w-screen flex-col overflow-hidden">
					<StaleWasmBanner />
					<DegradedRendererBanner />
					<EditorHeader />
					<div className="min-h-0 min-w-0 flex-1">
						<EditorLayout />
					</div>
					<MigrationDialog />
					<ChangelogNotification />
					<BackgroundTranscriber />
				</div>
			</EditorProvider>
		</MobileGate>
	);
}

function DegradedRendererBanner() {
	const isDegraded = useEditor((e) => e.renderer.isDegraded);
	const [dismissed, setDismissed] = useState(false);
	if (!isDegraded || dismissed) return null;

	return (
		<div className="bg-accent border-b h-9 flex items-center justify-center gap-2 text-xs text-muted-foreground">
			<span>For the best experience, open VibeCut in Chrome.</span>
			<Button
				variant="text"
				size="icon"
				className="p-0 w-auto [&_svg]:size-3.5"
				onClick={() => setDismissed(true)}
				aria-label="Dismiss"
			>
				<HugeiconsIcon icon={Cancel01Icon} />
			</Button>
		</div>
	);
}

/**
 * Stale-wasm guard (services/renderer/wasm-capabilities.ts): the loaded
 * `opencut-wasm` predates the shaders the app emits — typically the published
 * package shadowing the local `rust/wasm/pkg` build. Effects degrade to no-op
 * passes instead of blanking the preview; this banner is the ONE place the
 * condition is surfaced, with the fix.
 */
function StaleWasmBanner() {
	const [dismissed, setDismissed] = useState(false);
	const capabilities = getWasmCapabilities();
	if (capabilities.supported || dismissed) return null;

	return (
		<div className="bg-accent border-b min-h-9 flex items-center justify-center gap-2 px-3 py-1 text-xs text-muted-foreground">
			<span>
				VibeCut is running a stale opencut-wasm build
				{capabilities.version ? ` (${capabilities.version})` : ""} — GPU
				effects
				{capabilities.missingShaders.length > 0
					? ` (${capabilities.missingShaders.join(", ")})`
					: ""}{" "}
				are disabled. Fix: run{" "}
				<code>bun run build:wasm && bun run link:wasm</code> from the repo
				root (see rust/wasm/README.md).
			</span>
			<Button
				variant="text"
				size="icon"
				className="p-0 w-auto [&_svg]:size-3.5"
				onClick={() => setDismissed(true)}
				aria-label="Dismiss"
			>
				<HugeiconsIcon icon={Cancel01Icon} />
			</Button>
		</div>
	);
}

function EditorLayout() {
	usePasteMedia();
	const { panels, setPanel } = usePanelStore();
	const activeScene = useEditor((editor) =>
		editor.scenes.getActiveSceneOrNull(),
	);
	const currentTime = useEditor((editor) => editor.playback.getCurrentTime());
	const activeGuide = usePreviewStore((state) => state.activeGuide);
	const overlays = usePreviewStore((state) => state.overlays);
	const setOverlayVisibility = usePreviewStore(
		(state) => state.setOverlayVisibility,
	);
	const showBookmarkNotes = isPreviewOverlayVisible({
		overlay: bookmarkNotesPreviewOverlay,
		overlays,
	});

	const overlaySource = useMemo(
		() =>
			mergePreviewOverlaySources({
				sources: [
					getGuidePreviewOverlaySource({
						guideId: activeGuide,
					}),
					activeScene
						? getBookmarkPreviewOverlaySource({
								bookmarks: activeScene.bookmarks,
								time: currentTime,
								isVisible: showBookmarkNotes,
							})
						: {
								definitions: [bookmarkNotesPreviewOverlay],
								instances: [],
							},
				],
			}),
		[activeGuide, activeScene, currentTime, showBookmarkNotes],
	);

	const overlayControls = useMemo(
		() =>
			overlaySource.definitions.map((overlay) =>
				createPreviewOverlayControl({ overlay, overlays }),
			),
		[overlaySource.definitions, overlays],
	);

	return (
		<ResizablePanelGroup
			direction="vertical"
			className="size-full gap-[0.18rem]"
			onLayout={(sizes) => {
				setPanel({
					panel: "mainContent",
					size: sizes[0] ?? panels.mainContent,
				});
				setPanel({
					panel: "timeline",
					size: sizes[1] ?? panels.timeline,
				});
			}}
		>
			<ResizablePanel
				defaultSize={panels.mainContent}
				minSize={30}
				maxSize={85}
				className="min-h-0"
			>
				<ResizablePanelGroup
					direction="horizontal"
					className="size-full gap-[0.19rem] px-3"
					onLayout={(sizes) => {
						setPanel({ panel: "tools", size: sizes[0] ?? panels.tools });
						setPanel({ panel: "preview", size: sizes[1] ?? panels.preview });
						setPanel({
							panel: "properties",
							size: sizes[2] ?? panels.properties,
						});
					}}
				>
					<ResizablePanel
						defaultSize={panels.tools}
						minSize={15}
						maxSize={40}
						className="min-w-0"
					>
						<MaximizablePanel id="assets">
							<AssetsPanel />
						</MaximizablePanel>
					</ResizablePanel>

					<ResizableHandle withHandle />

					<ResizablePanel
						defaultSize={panels.preview}
						minSize={30}
						className="min-h-0 min-w-0 flex-1"
					>
						<MaximizablePanel id="preview">
							<PreviewPanel
								overlayControls={overlayControls}
								overlayInstances={overlaySource.instances}
								onOverlayVisibilityChange={setOverlayVisibility}
							/>
						</MaximizablePanel>
					</ResizablePanel>

					<ResizableHandle withHandle />

					<ResizablePanel
						defaultSize={panels.properties}
						minSize={15}
						maxSize={40}
						className="min-w-0"
					>
						<MaximizablePanel id="properties">
							<DirectorDockShell />
						</MaximizablePanel>
					</ResizablePanel>
				</ResizablePanelGroup>
			</ResizablePanel>

			<ResizableHandle withHandle />

			<ResizablePanel
				defaultSize={panels.timeline}
				minSize={15}
				maxSize={70}
				className="min-h-0 px-3 pb-3"
			>
				<MaximizablePanel id="timeline">
					<Timeline />
				</MaximizablePanel>
			</ResizablePanel>
		</ResizablePanelGroup>
	);
}

/**
 * Premiere's ` behavior: the panel under the cursor fills the screen when
 * ` is pressed; Esc / ` again restores. Double-click handlers and panel
 * maximize buttons route here too.
 */
function MaximizablePanel({
	id,
	children,
}: {
	id: EditorPanelId;
	children: React.ReactNode;
}) {
	const setHovered = usePanelMaximizeStore((s) => s.setHovered);
	const setActive = usePanelMaximizeStore((s) => s.setActive);
	const active = usePanelMaximizeStore((s) => s.active);
	const maximized = usePanelMaximizeStore((s) => s.maximized);
	const setMaximized = usePanelMaximizeStore((s) => s.setMaximized);
	const isMaximized = maximized === id;
	const isActive = active === id;

	useActionHandler(
		"toggle-panel-maximize",
		() => {
			const state = usePanelMaximizeStore.getState();
			if (state.maximized) {
				if (state.maximized === id) state.setMaximized(null);
				return;
			}
			if ((state.active ?? state.hovered ?? "assets") === id) {
				state.setMaximized(id);
			}
		},
		undefined,
	);
	useEffect(() => {
		if (!isMaximized) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setMaximized(null);
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [isMaximized, setMaximized]);

	return (
		<div
			className={
				(isMaximized
					? "bg-background fixed inset-2 z-50 shadow-2xl"
					: "size-full") +
				(isActive && !isMaximized
					? // Premiere's active-panel highlight, but unmissable: a bright
						// ring with an outer glow around the whole panel.
						" rounded-sm ring-2 ring-primary shadow-[0_0_16px_4px_var(--tw-shadow-color)] shadow-primary/40"
					: "")
			}
			onMouseEnter={() => setHovered(id)}
			onPointerDownCapture={() => setActive(id)}
		>
			{children}
		</div>
	);
}
