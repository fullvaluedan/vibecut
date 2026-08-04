"use client";

import { useEffect, useState } from "react";
import {
	Section,
	SectionContent,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from "@/components/ui/accordion";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
	probeServerGroqKey,
	useAiSettingsStore,
	type AiAuthMode,
	type AiProviderSelection,
} from "@/features/ai-generate/store";
import { usePreferenceStore } from "@/features/ai-generate/preference-store";
import { useTranscriptStatusStore } from "@/features/transcription/transcript-cache";
import { Switch } from "@/components/ui/switch";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDownIcon } from "@hugeicons/core-free-icons";
import { cn } from "@/utils/ui";

const AUTH_MODE_LABELS: Record<AiAuthMode, string> = {
	"claude-code": "Claude subscription (Claude Code)",
	"api-key": "Anthropic API key",
	custom: "Custom / local model",
	openai: "OpenAI",
	"xai-grok": "xAI Grok",
	"groq-llm": "Groq (Llama, chat)",
};

/**
 * T21.2: non-Anthropic chat providers are usable everywhere but have not
 * passed the Director quality eval (measured on Anthropic, the reference
 * config), so the UI says so plainly wherever one is picked.
 */
const COMMUNITY_QUALITY_NOTE =
	"Community quality: this provider has not passed VibeCut's editing-quality eval, which runs on Anthropic. Output may differ.";

function isCommunityMode(mode: AiAuthMode): boolean {
	return mode !== "claude-code" && mode !== "api-key";
}

// 4 collapsible groups (menu IA audit): Settings -> AI used to be a dozen
// stacked toggle sections with paragraph copy. "Connections and keys" is the
// only group open by default; the rest collapse until the user needs them.
export function AiSettingsContent() {
	return (
		<div className="flex flex-col">
			<RenderBackendNotice />

			<Accordion type="multiple" defaultValue={["connections"]}>
				<AccordionItem value="connections" className="border-b-0">
					<AccordionTrigger className="px-3.5 py-0 h-11 text-sm no-underline! hover:no-underline!">
						Connections and keys
					</AccordionTrigger>
					<AccordionContent className="pt-0 pb-0">
						<AiConnectionSection />
						<FeatureProviderSection />
						<CloudTranscriptionSection />
						<IntegrationsSection />
					</AccordionContent>
				</AccordionItem>

				<AccordionItem value="director" className="border-b-0">
					<AccordionTrigger className="px-3.5 py-0 h-11 text-sm no-underline! hover:no-underline!">
						Director behavior
					</AccordionTrigger>
					<AccordionContent className="pt-0 pb-0">
						<DirectorVisionSection />
					</AccordionContent>
				</AccordionItem>

				<AccordionItem value="performance" className="border-b-0">
					<AccordionTrigger className="px-3.5 py-0 h-11 text-sm no-underline! hover:no-underline!">
						Performance
					</AccordionTrigger>
					<AccordionContent className="pt-0 pb-0">
						<BackgroundTranscriptionSection />
						<DirectorVadGatedTranscriptionSection />
						<LowPowerSection />
					</AccordionContent>
				</AccordionItem>

				<AccordionItem value="advanced" className="border-b-0">
					<AccordionTrigger className="px-3.5 py-0 h-11 text-sm no-underline! hover:no-underline!">
						Advanced
					</AccordionTrigger>
					<AccordionContent className="pt-0 pb-0">
						<SelfLearningSection />
					</AccordionContent>
				</AccordionItem>
			</Accordion>
		</div>
	);
}

// The render-backend picker is gone (HeyGen was hard-disabled, "local" was the
// only real choice) -- static text instead of a single-option select. The
// store field/setter stay untouched for when cloud rendering ships.
function RenderBackendNotice() {
	return (
		<Section showTopBorder={false}>
			<SectionHeader>
				<SectionTitle>Rendering</SectionTitle>
			</SectionHeader>
			<SectionContent className="px-3 pb-3">
				<p className="text-muted-foreground text-xs">
					Renders locally; needs Node and FFmpeg. Cloud rendering arrives
					later.
				</p>
			</SectionContent>
		</Section>
	);
}

function AiConnectionSection() {
	const authMode = useAiSettingsStore((s) => s.authMode);
	const setAuthMode = useAiSettingsStore((s) => s.setAuthMode);
	const anthropicApiKey = useAiSettingsStore((s) => s.anthropicApiKey);
	const setAnthropicApiKey = useAiSettingsStore((s) => s.setAnthropicApiKey);
	const customBaseUrl = useAiSettingsStore((s) => s.customBaseUrl);
	const setCustomBaseUrl = useAiSettingsStore((s) => s.setCustomBaseUrl);
	const customModel = useAiSettingsStore((s) => s.customModel);
	const setCustomModel = useAiSettingsStore((s) => s.setCustomModel);
	const customApiKey = useAiSettingsStore((s) => s.customApiKey);
	const setCustomApiKey = useAiSettingsStore((s) => s.setCustomApiKey);
	const openaiApiKey = useAiSettingsStore((s) => s.openaiApiKey);
	const setOpenaiApiKey = useAiSettingsStore((s) => s.setOpenaiApiKey);
	const openaiModel = useAiSettingsStore((s) => s.openaiModel);
	const setOpenaiModel = useAiSettingsStore((s) => s.setOpenaiModel);
	const xaiGrokApiKey = useAiSettingsStore((s) => s.xaiGrokApiKey);
	const setXaiGrokApiKey = useAiSettingsStore((s) => s.setXaiGrokApiKey);
	const xaiGrokModel = useAiSettingsStore((s) => s.xaiGrokModel);
	const setXaiGrokModel = useAiSettingsStore((s) => s.setXaiGrokModel);
	const groqLlmApiKey = useAiSettingsStore((s) => s.groqLlmApiKey);
	const setGroqLlmApiKey = useAiSettingsStore((s) => s.setGroqLlmApiKey);
	const groqLlmModel = useAiSettingsStore((s) => s.groqLlmModel);
	const setGroqLlmModel = useAiSettingsStore((s) => s.setGroqLlmModel);
	const [isKeyVisible, setIsKeyVisible] = useState(false);
	const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);

	return (
		<Section showTopBorder={false}>
			<SectionHeader className="justify-between">
				<SectionTitle className="flex-1">AI connection</SectionTitle>
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
				{authMode === "claude-code" && (
					<p className="text-muted-foreground text-xs">
						Uses the Claude Code app installed on this computer. Generations
						run on your Claude subscription, no API key needed.
					</p>
				)}
				{authMode === "api-key" && (
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
							Stored only in this browser on this device, never saved into
							project files or uploads. Get a key at console.anthropic.com.
						</p>
					</>
				)}
				{authMode === "custom" && (
					<Collapsible open={isAdvancedOpen} onOpenChange={setIsAdvancedOpen}>
						<CollapsibleTrigger asChild>
							<button
								type="button"
								className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
							>
								<HugeiconsIcon
									icon={ArrowDownIcon}
									className={cn(
										"size-3.5 shrink-0 transition-transform duration-150",
										isAdvancedOpen ? "rotate-0" : "-rotate-90",
									)}
								/>
								Advanced: custom endpoint settings
							</button>
						</CollapsibleTrigger>
						<CollapsibleContent className="flex flex-col gap-2 pt-2">
							<div className="flex flex-col gap-1">
								<p className="text-xs font-medium">Base URL</p>
								<Input
									placeholder="http://localhost:11434/v1"
									value={customBaseUrl}
									onChange={(e) => setCustomBaseUrl(e.target.value)}
									autoComplete="off"
									spellCheck={false}
								/>
							</div>
							<div className="flex flex-col gap-1">
								<p className="text-xs font-medium">Model</p>
								<Input
									placeholder="e.g. hermes-3-llama-3.1-8b"
									value={customModel}
									onChange={(e) => setCustomModel(e.target.value)}
									autoComplete="off"
									spellCheck={false}
								/>
							</div>
							<div className="flex flex-col gap-1">
								<p className="text-xs font-medium">API key (optional)</p>
								<KeyInput
									value={customApiKey}
									onChange={setCustomApiKey}
									placeholder="Leave blank for local servers"
								/>
							</div>
							<p className="text-muted-foreground text-xs">
								Point VibeCut at any OpenAI-compatible{" "}
								<code>/chat/completions</code> endpoint: Ollama, LM Studio, or
								a self-hosted model. Include <code>/v1</code> in the URL if
								your server needs it. Everything stays on this device.
							</p>
						</CollapsibleContent>
					</Collapsible>
				)}
				<NamedProviderFields
					mode="openai"
					keyValue={openaiApiKey}
					onKeyChange={setOpenaiApiKey}
					keyPlaceholder="sk-..."
					keyHelp="Get a key at platform.openai.com."
					modelValue={openaiModel}
					onModelChange={setOpenaiModel}
				/>
				<NamedProviderFields
					mode="xai-grok"
					keyValue={xaiGrokApiKey}
					onKeyChange={setXaiGrokApiKey}
					keyPlaceholder="xai-..."
					keyHelp="Get a key at console.x.ai."
					modelValue={xaiGrokModel}
					onModelChange={setXaiGrokModel}
				/>
				<NamedProviderFields
					mode="groq-llm"
					keyValue={groqLlmApiKey}
					onKeyChange={setGroqLlmApiKey}
					keyPlaceholder="gsk_..."
					keyHelp="Get a key at console.groq.com. This is Groq's chat API (Llama) - separate from Groq transcription below."
					modelValue={groqLlmModel}
					onModelChange={setGroqLlmModel}
				/>
				{isCommunityMode(authMode) && (
					<p className="text-muted-foreground text-xs">
						{COMMUNITY_QUALITY_NOTE}
					</p>
				)}
			</SectionContent>
		</Section>
	);
}

/** Key + optional-model fields for one named OpenAI-compatible provider. */
function NamedProviderFields({
	mode,
	keyValue,
	onKeyChange,
	keyPlaceholder,
	keyHelp,
	modelValue,
	onModelChange,
}: {
	mode: "openai" | "xai-grok" | "groq-llm";
	keyValue: string;
	onKeyChange: (key: string) => void;
	keyPlaceholder: string;
	keyHelp: string;
	modelValue: string;
	onModelChange: (model: string) => void;
}) {
	const authMode = useAiSettingsStore((s) => s.authMode);
	if (authMode !== mode) return null;
	return (
		<>
			<div className="flex flex-col gap-1">
				<p className="text-xs font-medium">{AUTH_MODE_LABELS[mode]} API key</p>
				<KeyInput
					value={keyValue}
					onChange={onKeyChange}
					placeholder={keyPlaceholder}
				/>
			</div>
			<div className="flex flex-col gap-1">
				<p className="text-xs font-medium">Model (optional)</p>
				<Input
					placeholder="Leave blank for the provider default"
					value={modelValue}
					onChange={(e) => onModelChange(e.target.value)}
					autoComplete="off"
					spellCheck={false}
				/>
			</div>
			<p className="text-muted-foreground text-xs">
				Stored only in this browser on this device. {keyHelp}
			</p>
		</>
	);
}

/**
 * T21.2 per-feature provider picks. Each feature follows the global AI
 * connection unless pinned here; pinning a community provider labels it.
 */
function FeatureProviderSection() {
	const directorProvider = useAiSettingsStore((s) => s.directorProvider);
	const setDirectorProvider = useAiSettingsStore((s) => s.setDirectorProvider);
	const assistantProvider = useAiSettingsStore((s) => s.assistantProvider);
	const setAssistantProvider = useAiSettingsStore((s) => s.setAssistantProvider);
	const hyperframesProvider = useAiSettingsStore((s) => s.hyperframesProvider);
	const setHyperframesProvider = useAiSettingsStore(
		(s) => s.setHyperframesProvider,
	);

	const rows: Array<{
		label: string;
		value: AiProviderSelection;
		onChange: (pick: AiProviderSelection) => void;
	}> = [
		{ label: "AI Cut Director", value: directorProvider, onChange: setDirectorProvider },
		{ label: "Prompt-to-edit assistant", value: assistantProvider, onChange: setAssistantProvider },
		{ label: "HyperFrames graphics", value: hyperframesProvider, onChange: setHyperframesProvider },
	];

	return (
		<Section showTopBorder={false}>
			<SectionHeader>
				<SectionTitle>Provider per feature</SectionTitle>
			</SectionHeader>
			<SectionContent className="px-3 pb-3 flex flex-col gap-2">
				{rows.map((row) => (
					<div key={row.label} className="flex items-center justify-between gap-2">
						<p className="text-xs">{row.label}</p>
						<Select
							value={row.value}
							onValueChange={(value) =>
								row.onChange(value as AiProviderSelection)
							}
						>
							<SelectTrigger className="bg-transparent border-none p-1 h-auto">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="default">Default (AI connection)</SelectItem>
								{(Object.keys(AUTH_MODE_LABELS) as AiAuthMode[]).map((mode) => (
									<SelectItem key={mode} value={mode}>
										{AUTH_MODE_LABELS[mode]}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				))}
				<p className="text-muted-foreground text-xs">
					Each feature follows the global AI connection unless pinned here.
					Anthropic is the quality reference; other providers work but are
					community quality until they pass the editing-quality eval.
				</p>
			</SectionContent>
		</Section>
	);
}

function DirectorVisionSection() {
	const enabled = useAiSettingsStore((s) => s.directorVisionEnabled);
	const setEnabled = useAiSettingsStore((s) => s.setDirectorVisionEnabled);
	return (
		<Section showTopBorder={false}>
			<SectionHeader className="justify-between">
				<SectionTitle className="flex-1">Director vision</SectionTitle>
				<div className="flex items-center p-1">
					<Switch checked={enabled} onCheckedChange={setEnabled} />
				</div>
			</SectionHeader>
			<SectionContent className="px-3 pb-3">
				<p className="text-muted-foreground text-xs">
					Lets AI CUT&apos;s Director SEE your footage: it samples a frame per
					spoken segment so it can cut off-screen, frozen, or visually dead
					moments, not just what the audio says. Costs more (frames use extra
					tokens) and needs an API key or a vision-capable custom model; the
					claude-code CLI falls back to text. Off by default.
				</p>
			</SectionContent>
		</Section>
	);
}

function DirectorVadGatedTranscriptionSection() {
	const enabled = useAiSettingsStore((s) => s.directorVadGatedTranscriptionEnabled);
	const setEnabled = useAiSettingsStore(
		(s) => s.setDirectorVadGatedTranscriptionEnabled,
	);
	return (
		<Section showTopBorder={false}>
			<SectionHeader className="justify-between">
				<SectionTitle className="flex-1">Speech-only transcription (VAD)</SectionTitle>
				<div className="flex items-center p-1">
					<Switch checked={enabled} onCheckedChange={setEnabled} />
				</div>
			</SectionHeader>
			<SectionContent className="px-3 pb-3">
				<p className="text-muted-foreground text-xs">
					Runs voice-activity detection first and transcribes only the spoken
					parts (skipping silence) on the analysis path, faster on long, gappy
					recordings, and avoids hallucinated text over silence. Falls back to
					full-audio transcription if VAD is off or fails. Off by default;
					captions are unaffected.
				</p>
			</SectionContent>
		</Section>
	);
}

/** True once the (cached, session-long) probe reports a server Groq key. */
function useServerGroqKeyDetected(): boolean {
	const [detected, setDetected] = useState(false);
	useEffect(() => {
		let cancelled = false;
		probeServerGroqKey().then((hasKey) => {
			if (!cancelled) setDetected(hasKey);
		});
		return () => {
			cancelled = true;
		};
	}, []);
	return detected;
}

function CloudTranscriptionSection() {
	const backend = useAiSettingsStore((s) => s.transcriptionBackend);
	const setBackend = useAiSettingsStore((s) => s.setTranscriptionBackend);
	const groqApiKey = useAiSettingsStore((s) => s.groqApiKey);
	const setGroqApiKey = useAiSettingsStore((s) => s.setGroqApiKey);
	const serverKeyDetected = useServerGroqKeyDetected();
	const isCloud = backend === "cloud";
	return (
		<Section showTopBorder={false}>
			<SectionHeader className="justify-between">
				<SectionTitle className="flex-1">Transcribe on</SectionTitle>
				<Select
					value={backend}
					onValueChange={(value) =>
						setBackend(value === "cloud" ? "cloud" : "in-browser")
					}
				>
					<SelectTrigger className="bg-transparent border-none p-1 h-auto">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="in-browser">In browser</SelectItem>
						<SelectItem value="cloud">Groq (cloud)</SelectItem>
					</SelectContent>
				</Select>
			</SectionHeader>
			<SectionContent className="px-3 pb-3 flex flex-col gap-2">
				<p className="text-muted-foreground text-xs">
					In browser: transcribe locally (slower, segment-level only). Groq:
					upload the timeline audio to whisper-large-v3-turbo, seconds instead
					of minutes, word-level cuts for the Director, and no out-of-memory on
					long videos. Audio is compressed before upload. More cloud providers
					can slot in here later.
				</p>
				{serverKeyDetected && (
					<p className="text-muted-foreground text-xs">
						Server key detected, cloud transcription available without a key.
					</p>
				)}
				{isCloud && (
					<>
						<div className="flex flex-col gap-1">
							<p className="text-xs font-medium">Groq API key</p>
							<KeyInput
								value={groqApiKey}
								onChange={setGroqApiKey}
								placeholder="gsk_..."
							/>
						</div>
						<p className="text-muted-foreground text-xs">
							Stored only in this browser on this device, sent only to
							VibeCut&apos;s own <code>/api/transcribe</code> proxy, never to
							the browser STT call. Get a key at console.groq.com. Without a
							key, transcription stays in-browser.
						</p>
					</>
				)}
			</SectionContent>
		</Section>
	);
}

function LowPowerSection() {
	const enabled = useAiSettingsStore((s) => s.lowPowerMode);
	const setEnabled = useAiSettingsStore((s) => s.setLowPowerMode);
	return (
		<Section showTopBorder={false}>
			<SectionHeader className="justify-between">
				<SectionTitle className="flex-1">Low-power mode</SectionTitle>
				<div className="flex items-center p-1">
					<Switch checked={enabled} onCheckedChange={setEnabled} />
				</div>
			</SectionHeader>
			<SectionContent className="px-3 pb-3">
				<p className="text-muted-foreground text-xs">
					For lighter machines: pauses the in-browser speech model so it never
					runs while you edit. Heavy HyperFrames renders already run one at a
					time. Turn this on if the app feels sluggish.
				</p>
			</SectionContent>
		</Section>
	);
}

function BackgroundTranscriptionSection() {
	const enabled = useAiSettingsStore((s) => s.backgroundTranscriptionEnabled);
	const setEnabled = useAiSettingsStore(
		(s) => s.setBackgroundTranscriptionEnabled,
	);
	const status = useTranscriptStatusStore((s) => s.status);

	return (
		<Section showTopBorder={false}>
			<SectionHeader className="justify-between">
				<SectionTitle className="flex-1">Background transcription</SectionTitle>
				<div className="flex items-center p-1">
					<Switch checked={enabled} onCheckedChange={setEnabled} />
				</div>
			</SectionHeader>
			<SectionContent className="px-3 pb-3 flex flex-col gap-1.5">
				<p className="text-muted-foreground text-xs">
					Transcribes the timeline a few seconds after it changes, so AI CUT
					and RUN HYPERFRAMES start instantly from a cached transcript
					instead of re-listening to your video. Cached on this device.
				</p>
				{enabled && (
					<p className="text-muted-foreground text-xs">
						Status:{" "}
						{status === "ready"
							? "transcript ready for the current timeline."
							: status === "transcribing"
								? "transcribing in the background..."
								: "waiting for timeline audio."}
					</p>
				)}
			</SectionContent>
		</Section>
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
	const graphicsStats = usePreferenceStore((s) => s.graphicsStats);
	const clearLearning = usePreferenceStore((s) => s.clearLearning);
	const notes = usePreferenceStore.getState().buildPreferenceNotes();
	const observedCount =
		Object.keys(templateStats).length +
		Object.keys(cutStats).length +
		(graphicsStats.placed + graphicsStats.deleted > 0 ? 1 : 0);

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
					VibeCut watches how you react to AI output, effects you delete,
					AI CUT passes you undo, and tells the AI about it on the next run.
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
							? "Observing your edits, no strong preferences learned yet."
							: "Nothing learned yet, run HyperFrames or AI CUT, then keep or undo the result."}
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
