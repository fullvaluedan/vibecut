"use client";

/**
 * Music & SFX tab: semantic search over HeyGen's audio library
 * (https://developers.heygen.com/reference/search-audio-music-or-sound-effects).
 * Needs the HeyGen API key from Settings → AI → Integrations; audio bytes
 * come through /api/heygen/audio-proxy so the browser can decode them.
 */

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useEditor } from "@/editor/use-editor";
import { useAiSettingsStore } from "@/features/ai-generate/store";
import {
	buildLibraryAudioElement,
} from "@/timeline/element-utils";
import { mediaTimeFromSeconds } from "@/wasm";
import type { HeygenSound } from "@/app/api/heygen/audio-search/route";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	PauseIcon,
	PlayIcon,
	PlusSignIcon,
} from "@hugeicons/core-free-icons";

const proxied = (audioUrl: string) =>
	`/api/heygen/audio-proxy?url=${encodeURIComponent(audioUrl)}`;

export function HeygenSoundsView() {
	const editor = useEditor();
	const heygenApiKey = useAiSettingsStore((s) => s.heygenApiKey);
	const [query, setQuery] = useState("");
	const [type, setType] = useState<"music" | "sound_effects">("music");
	const [results, setResults] = useState<HeygenSound[]>([]);
	const [isSearching, setIsSearching] = useState(false);
	const [playingId, setPlayingId] = useState<string | null>(null);
	const [addingId, setAddingId] = useState<string | null>(null);
	const audioRef = useRef<HTMLAudioElement | null>(null);

	useEffect(() => {
		return () => {
			audioRef.current?.pause();
		};
	}, []);

	const search = async (searchType = type) => {
		const trimmed = query.trim();
		if (!trimmed || !heygenApiKey) return;
		setIsSearching(true);
		try {
			const res = await fetch("/api/heygen/audio-search", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-framecut-heygen-key": heygenApiKey,
				},
				body: JSON.stringify({ query: trimmed, type: searchType, limit: 20 }),
			});
			const data = (await res.json()) as {
				sounds?: HeygenSound[];
				error?: string;
			};
			if (!res.ok) throw new Error(data.error ?? `Search failed (${res.status})`);
			setResults(data.sounds ?? []);
			if (!data.sounds?.length) {
				toast.info(`Nothing found for "${trimmed}"`);
			}
		} catch (e) {
			toast.error("HeyGen search failed", {
				description: e instanceof Error ? e.message : String(e),
			});
		} finally {
			setIsSearching(false);
		}
	};

	const togglePlay = (sound: HeygenSound) => {
		if (playingId === sound.id) {
			audioRef.current?.pause();
			setPlayingId(null);
			return;
		}
		audioRef.current?.pause();
		const audio = new Audio(proxied(sound.audioUrl));
		audio.onended = () => setPlayingId(null);
		void audio.play().catch(() => setPlayingId(null));
		audioRef.current = audio;
		setPlayingId(sound.id);
	};

	const addToTimeline = async (sound: HeygenSound) => {
		setAddingId(sound.id);
		try {
			const url = proxied(sound.audioUrl);
			const response = await fetch(url);
			if (!response.ok) throw new Error(`Download failed (${response.status})`);
			const arrayBuffer = await response.arrayBuffer();
			const audioContext = new AudioContext();
			const buffer = await audioContext.decodeAudioData(arrayBuffer);
			const element = buildLibraryAudioElement({
				sourceUrl: url,
				name: sound.name,
				duration: mediaTimeFromSeconds({
					seconds: sound.duration ?? buffer.duration,
				}),
				startTime: editor.playback.getCurrentTime(),
				buffer,
			});
			editor.timeline.insertElement({
				placement: { mode: "auto", trackType: "audio" },
				element,
			});
			toast.success(`Added "${sound.name}" at the playhead`);
		} catch (e) {
			toast.error("Couldn't add sound", {
				description: e instanceof Error ? e.message : String(e),
			});
		} finally {
			setAddingId(null);
		}
	};

	if (!heygenApiKey) {
		return (
			<p className="text-muted-foreground p-2 text-xs">
				Music & SFX search uses HeyGen's audio library. Add your HeyGen API
				key in Settings → AI → Integrations to enable it.
			</p>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3">
			<div className="flex items-center gap-2">
				<Input
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") void search();
					}}
					placeholder='Describe it: "uplifting corporate intro", "whoosh"...'
					className="h-8 text-xs"
					spellCheck={false}
				/>
				<Button size="sm" onClick={() => void search()} disabled={isSearching}>
					{isSearching ? <Spinner className="size-3.5" /> : "Search"}
				</Button>
			</div>
			<Tabs
				value={type}
				onValueChange={(value) => {
					const next = value === "sound_effects" ? "sound_effects" : "music";
					setType(next);
					if (query.trim()) void search(next);
				}}
			>
				<TabsList>
					<TabsTrigger value="music">Music</TabsTrigger>
					<TabsTrigger value="sound_effects">Sound effects</TabsTrigger>
				</TabsList>
			</Tabs>
			<div className="scrollbar-thin flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
				{results.map((sound) => (
					<div
						key={sound.id}
						className="hover:bg-accent/50 flex items-center gap-2 rounded-sm p-1.5"
					>
						<Button
							variant="ghost"
							size="icon"
							className="size-7 shrink-0"
							onClick={() => togglePlay(sound)}
							title={playingId === sound.id ? "Pause" : "Preview"}
						>
							<HugeiconsIcon
								icon={playingId === sound.id ? PauseIcon : PlayIcon}
								size={14}
							/>
						</Button>
						<div className="min-w-0 flex-1">
							<p className="truncate text-xs">{sound.name}</p>
							<p className="text-muted-foreground truncate text-[10px]">
								{sound.duration != null ? `${Math.round(sound.duration)}s · ` : ""}
								{sound.description || (sound.type === "music" ? "Music" : "Sound effect")}
							</p>
						</div>
						<Button
							variant="ghost"
							size="icon"
							className="size-7 shrink-0"
							onClick={() => void addToTimeline(sound)}
							disabled={addingId === sound.id}
							title="Add at the playhead"
						>
							{addingId === sound.id ? (
								<Spinner className="size-3.5" />
							) : (
								<HugeiconsIcon icon={PlusSignIcon} size={14} />
							)}
						</Button>
					</div>
				))}
				{!results.length && !isSearching && (
					<p className="text-muted-foreground p-2 text-xs">
						Describe the music or sound you need and hit Search — results
						come from HeyGen's library and drop in at the playhead.
					</p>
				)}
			</div>
		</div>
	);
}
