"use client";

import { useState } from "react";
import {
	Section,
	SectionContent,
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
import {
	useAiSettingsStore,
	type AiAuthMode,
	type AiBackend,
} from "@/features/ai-generate/store";
import { usePreferenceStore } from "@/features/ai-generate/preference-store";
import { Switch } from "@/components/ui/switch";

const AUTH_MODE_LABELS: Record<AiAuthMode, string> = {
	"claude-code": "Claude subscription (Claude Code)",
	"api-key": "Anthropic API key",
};

const BACKEND_LABELS: Record<AiBackend, string> = {
	local: "This computer (HyperFrames CLI)",
	heygen: "HeyGen cloud (coming soon)",
};

export function AiSettingsContent() {
	const authMode = useAiSettingsStore((s) => s.authMode);
	const setAuthMode = useAiSettingsStore((s) => s.setAuthMode);
	const anthropicApiKey = useAiSettingsStore((s) => s.anthropicApiKey);
	const setAnthropicApiKey = useAiSettingsStore((s) => s.setAnthropicApiKey);
	const backend = useAiSettingsStore((s) => s.backend);
	const setBackend = useAiSettingsStore((s) => s.setBackend);
	const [isKeyVisible, setIsKeyVisible] = useState(false);

	return (
		<div className="flex flex-col">
			<Section showTopBorder={false}>
				<SectionHeader className="justify-between">
					<SectionTitle className="flex-1">Claude account</SectionTitle>
					<Select
						value={authMode}
						onValueChange={(value) => setAuthMode(value as AiAuthMode)}
					>
						<SelectTrigger className="bg-transparent border-none p-1 h-auto">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{(Object.keys(AUTH_MODE_LABELS) as AiAuthMode[]).map((mode) => (
								<SelectItem key={mode} value={mode}>
									{AUTH_MODE_LABELS[mode]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SectionHeader>
				<SectionContent className="px-3 pb-3 flex flex-col gap-2">
					{authMode === "claude-code" ? (
						<p className="text-muted-foreground text-xs">
							Uses the Claude Code app installed on this computer. Generations
							run on your Claude subscription — no API key needed.
						</p>
					) : (
						<>
							<div className="flex items-center gap-1">
								<Input
									type={isKeyVisible ? "text" : "password"}
									placeholder="sk-ant-..."
									value={anthropicApiKey}
									onChange={(e) => setAnthropicApiKey(e.target.value)}
									autoComplete="off"
									spellCheck={false}
								/>
								<Button
									variant="text"
									size="sm"
									onClick={() => setIsKeyVisible((v) => !v)}
								>
									{isKeyVisible ? "Hide" : "Show"}
								</Button>
							</div>
							<p className="text-muted-foreground text-xs">
								Stored only in this browser on this device — never saved into
								project files or uploads. Get a key at console.anthropic.com.
							</p>
						</>
					)}
				</SectionContent>
			</Section>

			<Section showTopBorder={false}>
				<SectionHeader className="justify-between">
					<SectionTitle className="flex-1">Render videos on</SectionTitle>
					<Select
						value={backend}
						onValueChange={(value) => setBackend(value as AiBackend)}
					>
						<SelectTrigger className="bg-transparent border-none p-1 h-auto">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{(Object.keys(BACKEND_LABELS) as AiBackend[]).map((b) => (
								<SelectItem key={b} value={b} disabled={b === "heygen"}>
									{BACKEND_LABELS[b]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SectionHeader>
				<SectionContent className="px-3 pb-3">
					<p className="text-muted-foreground text-xs">
						Local rendering is free and private; it needs Node and FFmpeg on
						this computer. HeyGen cloud rendering arrives in a later update.
					</p>
				</SectionContent>
			</Section>

			<IntegrationsSection />

			<SelfLearningSection />
		</div>
	);
}

function KeyInput({
	value,
	onChange,
	placeholder,
}: {
	value: string;
	onChange: (value: string) => void;
	placeholder: string;
}) {
	const [isVisible, setIsVisible] = useState(false);
	return (
		<div className="flex items-center gap-1">
			<Input
				type={isVisible ? "text" : "password"}
				placeholder={placeholder}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				autoComplete="off"
				spellCheck={false}
			/>
			<Button variant="text" size="sm" onClick={() => setIsVisible((v) => !v)}>
				{isVisible ? "Hide" : "Show"}
			</Button>
		</div>
	);
}

function IntegrationsSection() {
	const heygenApiKey = useAiSettingsStore((s) => s.heygenApiKey);
	const setHeygenApiKey = useAiSettingsStore((s) => s.setHeygenApiKey);
	const serpApiKey = useAiSettingsStore((s) => s.serpApiKey);
	const setSerpApiKey = useAiSettingsStore((s) => s.setSerpApiKey);

	return (
		<Section showTopBorder={false}>
			<SectionHeader>
				<SectionTitle>Integrations</SectionTitle>
			</SectionHeader>
			<SectionContent className="px-3 pb-3 flex flex-col gap-3">
				<div className="flex flex-col gap-1.5">
					<p className="text-xs font-medium">HeyGen API key</p>
					<KeyInput
						value={heygenApiKey}
						onChange={setHeygenApiKey}
						placeholder="HeyGen API key"
					/>
					<p className="text-muted-foreground text-xs">
						Unlocks Music & SFX search in the Sounds panel and "add music"
						in the AI prompt box. Keys stay on this device.
					</p>
				</div>
				<div className="flex flex-col gap-1.5">
					<p className="text-xs font-medium">SerpAPI key</p>
					<KeyInput
						value={serpApiKey}
						onChange={setSerpApiKey}
						placeholder="SerpAPI key"
					/>
					<p className="text-muted-foreground text-xs">
						Unlocks "find b-roll" in the AI prompt box (image search via
						serpapi.com). Keys stay on this device.
					</p>
				</div>
			</SectionContent>
		</Section>
	);
}

function SelfLearningSection() {
	const enabled = usePreferenceStore((s) => s.selfLearningEnabled);
	const setEnabled = usePreferenceStore((s) => s.setSelfLearningEnabled);
	const templateStats = usePreferenceStore((s) => s.templateStats);
	const cutStats = usePreferenceStore((s) => s.cutStats);
	const clearLearning = usePreferenceStore((s) => s.clearLearning);
	const notes = usePreferenceStore.getState().buildPreferenceNotes();
	const observedCount =
		Object.keys(templateStats).length + Object.keys(cutStats).length;

	return (
		<Section showTopBorder={false}>
			<SectionHeader className="justify-between">
				<SectionTitle className="flex-1">Self-learning</SectionTitle>
				<div className="flex items-center p-1">
					<Switch checked={enabled} onCheckedChange={setEnabled} />
				</div>
			</SectionHeader>
			<SectionContent className="px-3 pb-3 flex flex-col gap-2">
				<p className="text-muted-foreground text-xs">
					VibeCut watches how you react to AI output — effects you delete,
					AI CUT passes you undo — and tells the AI about it on the next run.
					Everything stays on this device.
				</p>
				{enabled && notes.length > 0 && (
					<ul className="text-muted-foreground flex list-disc flex-col gap-1 pl-4 text-xs">
						{notes.map((note) => (
							<li key={note}>{note}</li>
						))}
					</ul>
				)}
				{enabled && notes.length === 0 && (
					<p className="text-muted-foreground text-xs italic">
						{observedCount > 0
							? "Observing your edits — no strong preferences learned yet."
							: "Nothing learned yet — run HyperFrames or AI CUT, then keep or undo the result."}
					</p>
				)}
				{observedCount > 0 && (
					<Button
						variant="outline"
						size="sm"
						className="self-start text-xs"
						onClick={clearLearning}
					>
						Clear learning
					</Button>
				)}
			</SectionContent>
		</Section>
	);
}
