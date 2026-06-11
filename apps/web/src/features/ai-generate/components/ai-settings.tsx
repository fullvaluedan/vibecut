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
		</div>
	);
}
