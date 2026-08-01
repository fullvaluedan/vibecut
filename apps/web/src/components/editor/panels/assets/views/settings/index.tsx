"use client";

import { useEffect, useState } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import {
	Section,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { BackgroundContent } from "./background";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { NumberField } from "@/components/ui/number-field";
import { AiSettingsContent } from "@/features/ai-generate/components/ai-settings";
import { ShortcutsEditor } from "@/actions/components/shortcuts-dialog";
import { useKeybindingsStore } from "@/actions/keybindings-store";
import { useTimelineStore } from "@/timeline/timeline-store";
import { HelpContent } from "./help";
import {
	SETTINGS_SUB_VIEWS,
	useAssetsPanelStore,
	type SettingsSubView,
} from "@/components/editor/panels/assets/assets-panel-store";

// "Project info" moved to a chip popover next to ZoomSelect in the preview
// toolbar (menu IA audit: project name/frame-rate/aspect belong near the
// canvas they describe, not buried in Settings). See
// apps/web/src/preview/components/project-info-chip.tsx.
type SettingsView = SettingsSubView;

function isSettingsView(value: string): value is SettingsView {
	return (SETTINGS_SUB_VIEWS as readonly string[]).includes(value);
}

export function SettingsView() {
	// T21.1: the get-started page's "Add your key in Settings" deep link asks
	// for the AI sub-tab specifically (`?open=ai-settings` -> assets-panel-store
	// `settingsSubView`). Read it once for the initial tab so a fresh mount
	// (switching to Settings for the first time after the deep link fires)
	// lands directly on AI; the effect below also covers the case where this
	// component is already mounted when the request arrives, and consumes the
	// request afterward so a later manual visit to Settings is unaffected.
	const requestedSubView = useAssetsPanelStore((s) => s.settingsSubView);
	const setSettingsSubView = useAssetsPanelStore((s) => s.setSettingsSubView);
	const [view, setView] = useState<SettingsView>(requestedSubView ?? "background");

	useEffect(() => {
		if (!requestedSubView) return;
		setView(requestedSubView);
		setSettingsSubView(null);
	}, [requestedSubView, setSettingsSubView]);

	return (
		<PanelView
			contentClassName="px-0"
			scrollClassName="pt-0"
			actions={
				<Tabs
					value={view}
					onValueChange={(value) => {
						if (isSettingsView(value)) {
							setView(value);
						}
					}}
				>
					<TabsList>
						<TabsTrigger value="background">Background</TabsTrigger>
						<TabsTrigger value="ai">AI</TabsTrigger>
						<TabsTrigger value="hotkeys">Hotkeys</TabsTrigger>
						<TabsTrigger value="help">Help</TabsTrigger>
					</TabsList>
				</Tabs>
			}
		>
			{view === "background" && <BackgroundContent />}
			{view === "ai" && <AiSettingsContent />}
			{view === "hotkeys" && <HotkeysContent />}
			{view === "help" && <HelpContent />}
		</PanelView>
	);
}

function NudgeFramesField({
	value,
	onCommit,
}: {
	value: number;
	onCommit: (frames: number) => void;
}) {
	// Local draft so the user can type freely; commit on blur. Keyed by `value`
	// in the parent, so a committed (clamped) value remounts this with the
	// canonical string — no syncing effect needed.
	const [draft, setDraft] = useState(String(value));

	const commit = () => {
		const parsed = Number(draft.trim());
		if (Number.isFinite(parsed)) {
			onCommit(parsed);
		} else {
			setDraft(String(value));
		}
	};

	// C3 fix: a proper cancel path (revert the draft to the committed value)
	// instead of relying on NumberField's legacy commit-on-blur fallback, so
	// Escape here reverts like every other NumberField consumer.
	const cancel = () => {
		setDraft(String(value));
	};

	return (
		<NumberField
			value={draft}
			suffix="frames"
			className="w-28"
			aria-label="Timeline nudge in frames"
			allowExpressions={false}
			onChange={(event) => setDraft(event.target.value)}
			onBlur={commit}
			onCancel={cancel}
		/>
	);
}

function HotkeysContent() {
	const resetToDefaults = useKeybindingsStore((s) => s.resetToDefaults);
	const nudgeFrames = useTimelineStore((s) => s.timelineNudgeFrames);
	const setNudgeFrames = useTimelineStore((s) => s.setTimelineNudgeFrames);

	return (
		<div className="flex flex-col gap-4 p-3">
			<Section showTopBorder={false} className="px-0">
				<SectionHeader className="justify-between">
					<SectionTitle className="flex-1">Shift + ← / → nudge</SectionTitle>
					<NudgeFramesField
						key={nudgeFrames}
						value={nudgeFrames}
						onCommit={setNudgeFrames}
					/>
				</SectionHeader>
			</Section>
			<p className="text-muted-foreground text-xs">
				Click any key to record a new binding — press the combination you
				want. Conflicting keys are rejected with a warning.
			</p>
			<ShortcutsEditor />
			<Button
				variant="outline"
				size="sm"
				className="self-start"
				onClick={resetToDefaults}
			>
				Reset all to defaults
			</Button>
		</div>
	);
}
