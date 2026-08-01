"use client";

/**
 * T21.1: /get-started - the onboarding page. Plain-language explanation of
 * what VibeCut does, a 3-step visual flow, one card per AI tool with a
 * "Try it" deep link into the most recently updated project (reusing
 * `hero-tiles.ts`, same disabled-until-a-project-exists behavior as the home
 * page's hero row), a "Connect your AI" section with provider status cards,
 * and a privacy note. No auto-redirect anywhere - this page is only ever
 * reached by a link (the home page banner, the header link, or a direct
 * visit); see `../projects/first-run-banner.ts` for the home-page banner
 * logic that links here.
 */

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
	ArrowRight01Icon,
	Upload01Icon,
	MagicWand05Icon,
	CheckmarkCircle02Icon,
	Alert02Icon,
	ScissorIcon,
	Note01Icon,
	ClosedCaptionIcon,
	Key01Icon,
	ShieldKeyIcon,
	Download04Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useEditor } from "@/editor/use-editor";
import { DEFAULT_LOGO_URL } from "@/site/brand";
import {
	AI_TOOL_TILE_IDS,
	getMostRecentProject,
	HERO_TILE_OPEN_PARAM,
	type HeroTileId,
} from "@/app/projects/hero-tiles";
import {
	useAiSettingsStore,
	probeServerGroqKey,
} from "@/features/ai-generate/store";
import {
	deriveAnthropicStatus,
	deriveGroqStatus,
	type ProviderStatus,
} from "./provider-status";
import { cn } from "@/utils/ui";

export default function GetStartedPage() {
	const editor = useEditor();
	const savedProjects = useEditor((e) => e.project.getSavedProjects());
	const hasProjects = savedProjects.length > 0;

	useEffect(() => {
		if (!editor.project.getIsInitialized()) {
			editor.project.loadAllProjects();
		}
	}, [editor.project]);

	return (
		<div className="bg-background min-h-screen">
			<GetStartedHeader />
			<main className="mx-auto flex max-w-3xl flex-col gap-16 px-6 py-10 md:px-8 md:py-14">
				<IntroSection />
				<StepsSection />
				<AiToolsSection savedProjects={savedProjects} hasProjects={hasProjects} />
				<ConnectAiSection savedProjects={savedProjects} hasProjects={hasProjects} />
				<PrivacyNote />
			</main>
		</div>
	);
}

function GetStartedHeader() {
	return (
		<header className="border-b px-6 py-4 md:px-8">
			<Link href="/" className="flex w-fit shrink-0 items-center" aria-label="VibeCut home">
				<Image
					src={DEFAULT_LOGO_URL}
					alt="VibeCut"
					width={220}
					height={56}
					className="h-6 w-auto invert dark:invert-0"
				/>
			</Link>
		</header>
	);
}

function IntroSection() {
	return (
		<section className="flex flex-col gap-3 text-center">
			<h1 className="text-2xl font-semibold md:text-3xl">
				How VibeCut works
			</h1>
			<p className="text-muted-foreground mx-auto max-w-xl text-sm md:text-base">
				VibeCut cuts video with you, not instead of you. Import your
				footage, let the AI tools do the first pass, then polish the
				result and export. Everything below takes about two minutes.
			</p>
		</section>
	);
}

const STEPS: {
	step: number;
	title: string;
	description: string;
	icon: IconSvgElement;
}[] = [
	{
		step: 1,
		title: "Import your footage",
		description: "Drag in your clips, audio, and images. VibeCut keeps them on this device.",
		icon: Upload01Icon,
	},
	{
		step: 2,
		title: "Let AI cut it",
		description: "AI Cut drafts a timeline, or edit by transcript, or add captions automatically.",
		icon: MagicWand05Icon,
	},
	{
		step: 3,
		title: "Polish and export",
		description: "Adjust the draft by hand, then export your finished video.",
		icon: Download04Icon,
	},
];

function StepsSection() {
	return (
		<section className="flex flex-col gap-6">
			<h2 className="text-center text-lg font-medium">Three steps</h2>
			<div className="grid grid-cols-1 gap-4 md:grid-cols-3">
				{STEPS.map((item) => (
					<Card key={item.step} className="bg-background">
						<CardContent className="flex flex-col items-center gap-3 p-6 text-center">
							<div className="bg-accent/40 flex size-12 items-center justify-center rounded-full">
								<HugeiconsIcon icon={item.icon} className="text-primary size-6" />
							</div>
							<span className="text-muted-foreground text-xs font-semibold">
								STEP {item.step}
							</span>
							<h3 className="font-medium">{item.title}</h3>
							<p className="text-muted-foreground text-sm">{item.description}</p>
						</CardContent>
					</Card>
				))}
			</div>
		</section>
	);
}

const AI_TOOL_CONTENT: Record<
	HeroTileId,
	{ label: string; icon: IconSvgElement; explainer: string }
> = {
	"new-project": { label: "New project", icon: Upload01Icon, explainer: "" },
	"ai-cut": {
		label: "AI Cut",
		icon: ScissorIcon,
		explainer:
			"Point AI Cut at your imported clips and it drafts a full timeline for you. It listens to what is said, finds the strongest moments, and cuts out dead air and filler. You keep every choice: review the draft, undo any cut, or ask for changes in plain language.",
	},
	transcript: {
		label: "Edit by transcript",
		icon: Note01Icon,
		explainer:
			"Edit by transcript turns your footage into text. Delete a sentence in the transcript and the matching video is cut too, no scrubbing the timeline by hand. Great for interviews, podcasts, and talking-head videos where the words are the edit.",
	},
	captions: {
		label: "Auto captions",
		icon: ClosedCaptionIcon,
		explainer:
			"Auto captions transcribes your footage and drops in styled, word-by-word captions automatically. Turn them on, then tweak the look from the Captions panel if you want something different.",
	},
};

function AiToolsSection({
	savedProjects,
	hasProjects,
}: {
	savedProjects: { id: string; updatedAt: Date }[];
	hasProjects: boolean;
}) {
	const router = useRouter();

	const handleTryIt = (tileId: HeroTileId) => {
		const mostRecent = getMostRecentProject(savedProjects);
		if (!mostRecent) return;
		const openParam = HERO_TILE_OPEN_PARAM[tileId];
		const query = openParam ? `?open=${openParam}` : "";
		router.push(`/editor/${mostRecent.id}${query}`);
	};

	return (
		<section className="flex flex-col gap-6">
			<h2 className="text-center text-lg font-medium">The three AI tools</h2>
			<div className="flex flex-col gap-4">
				{AI_TOOL_TILE_IDS.map((tileId) => {
					const content = AI_TOOL_CONTENT[tileId];
					return (
						<Card key={tileId} className="bg-background">
							<CardContent className="flex flex-col gap-3 p-6 sm:flex-row sm:items-start sm:justify-between">
								<div className="flex gap-3">
									<HugeiconsIcon
										icon={content.icon}
										className="text-primary mt-0.5 size-5 shrink-0"
									/>
									<div className="flex flex-col gap-1.5">
										<h3 className="font-medium">{content.label}</h3>
										<p className="text-muted-foreground text-sm">
											{content.explainer}
										</p>
									</div>
								</div>
								<Button
									variant="outline"
									className="shrink-0 self-start sm:self-center"
									disabled={!hasProjects}
									title={hasProjects ? undefined : "Create a project first"}
									onClick={() => handleTryIt(tileId)}
								>
									Try it
									<HugeiconsIcon icon={ArrowRight01Icon} />
								</Button>
							</CardContent>
						</Card>
					);
				})}
			</div>
			{!hasProjects && (
				<p className="text-muted-foreground text-center text-xs">
					Create a project first, then come back here to try each tool.
				</p>
			)}
		</section>
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

function ConnectAiSection({
	savedProjects,
	hasProjects,
}: {
	savedProjects: { id: string; updatedAt: Date }[];
	hasProjects: boolean;
}) {
	const authMode = useAiSettingsStore((s) => s.authMode);
	const anthropicApiKey = useAiSettingsStore((s) => s.anthropicApiKey);
	const groqApiKey = useAiSettingsStore((s) => s.groqApiKey);
	const serverKeyDetected = useServerGroqKeyDetected();
	const router = useRouter();

	const anthropicStatus = deriveAnthropicStatus({ authMode, anthropicApiKey });
	const groqStatus = deriveGroqStatus({ groqApiKey, serverKeyDetected });

	const openAiSettings = () => {
		const mostRecent = getMostRecentProject(savedProjects);
		if (!mostRecent) return;
		router.push(`/editor/${mostRecent.id}?open=ai-settings`);
	};

	return (
		<section id="connect-ai" className="flex flex-col gap-6 scroll-mt-20">
			<div className="text-center">
				<h2 className="text-lg font-medium">Connect your AI</h2>
				<p className="text-muted-foreground mx-auto max-w-xl text-sm">
					VibeCut uses two kinds of AI: one that plans edits (Anthropic),
					and one that turns speech into text (Groq). Add your own keys
					and everything below lights up.
				</p>
			</div>

			<ProviderCard
				title="Anthropic"
				description="Powers AI Cut's Director and the upcoming Assistant. Plans your edits from what is said in your footage."
				status={anthropicStatus}
				connectedCopy={{
					"claude-code":
						"Connected. Using your Claude subscription on this device (the Claude Code app), no key needed.",
					"device-key": "Connected. Using the Anthropic API key saved on this device.",
				}}
				missingCopy="Not connected yet. AI Cut needs an Anthropic key (or a Claude Code login) to plan cuts."
				getKeyUrl="https://console.anthropic.com"
				getKeyLabel="console.anthropic.com"
				hasProjects={hasProjects}
				onOpenSettings={openAiSettings}
			/>

			<ProviderCard
				title="Groq"
				description="Transcribes your footage to text, fast, for AI Cut, Edit by transcript, and Auto captions. Optional but recommended: transcription in your browser always works without it, just slower."
				status={groqStatus}
				connectedCopy={{
					"device-key": "Connected. Using the Groq key saved on this device.",
					"server-key":
						"Connected. This VibeCut deployment already has a shared Groq key, cloud transcription just works, no key needed from you.",
				}}
				missingCopy="No Groq key yet. Transcription still works in your browser, just slower and less accurate. Adding a key speeds it up."
				getKeyUrl="https://console.groq.com"
				getKeyLabel="console.groq.com"
				hasProjects={hasProjects}
				onOpenSettings={openAiSettings}
			/>
		</section>
	);
}

function ProviderCard({
	title,
	description,
	status,
	connectedCopy,
	missingCopy,
	getKeyUrl,
	getKeyLabel,
	hasProjects,
	onOpenSettings,
}: {
	title: string;
	description: string;
	status: ProviderStatus;
	connectedCopy: Partial<Record<ProviderStatus["state"], string>>;
	missingCopy: string;
	getKeyUrl: string;
	getKeyLabel: string;
	hasProjects: boolean;
	onOpenSettings: () => void;
}) {
	const isConnected = status.state !== "missing";
	const copy = isConnected ? connectedCopy[status.state] : missingCopy;

	return (
		<Card className="bg-background">
			<CardContent className="flex flex-col gap-3 p-6">
				<div className="flex items-center justify-between gap-2">
					<div className="flex items-center gap-2">
						<HugeiconsIcon icon={Key01Icon} className="text-muted-foreground size-4" />
						<h3 className="font-medium">{title}</h3>
					</div>
					<span
						className={cn(
							"flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
							isConnected
								? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
								: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
						)}
					>
						<HugeiconsIcon
							icon={isConnected ? CheckmarkCircle02Icon : Alert02Icon}
							className="size-3.5"
						/>
						{isConnected ? "Connected" : "Not connected"}
					</span>
				</div>
				<p className="text-muted-foreground text-sm">{description}</p>
				<p className="text-sm">{copy}</p>
				<div className="flex flex-wrap items-center gap-3 pt-1">
					<Button
						variant="outline"
						size="sm"
						disabled={!hasProjects}
						title={hasProjects ? undefined : "Create a project first"}
						onClick={onOpenSettings}
					>
						Add your key in Settings
					</Button>
					{!isConnected && (
						<a
							href={getKeyUrl}
							target="_blank"
							rel="noreferrer noopener"
							className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
						>
							Get a key at {getKeyLabel}
						</a>
					)}
				</div>
			</CardContent>
		</Card>
	);
}

function PrivacyNote() {
	return (
		<section className="bg-accent/30 flex flex-col items-center gap-2 rounded-lg border p-6 text-center">
			<HugeiconsIcon icon={ShieldKeyIcon} className="text-primary size-6" />
			<h2 className="text-sm font-medium">Bring your own keys, they stay on this device</h2>
			<p className="text-muted-foreground max-w-lg text-sm">
				Your Anthropic and Groq keys are saved in this browser's local
				storage. They are never written into your project files, never
				uploaded anywhere. If you set a key on VibeCut's own server
				instead (a shared deployment key), the same rule applies to
				everyone using it: your keys stay yours.
			</p>
		</section>
	);
}
