"use client";

/**
 * Settings → Help: a plain-language guide to everything in VibeCut.
 */

import {
	Section,
	SectionContent,
	SectionHeader,
	SectionTitle,
} from "@/components/section";

function HelpSection({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<Section collapsible defaultOpen={false} showTopBorder={false}>
			<SectionHeader>
				<SectionTitle>{title}</SectionTitle>
			</SectionHeader>
			<SectionContent className="px-3 pb-3">
				<div className="text-muted-foreground flex flex-col gap-1.5 text-xs leading-relaxed">
					{children}
				</div>
			</SectionContent>
		</Section>
	);
}

export function HelpContent() {
	return (
		<div className="flex flex-col">
			<HelpSection title="Getting started">
				<p>
					Import footage in the <b>Media</b> tab (or drag files anywhere),
					drop clips on the timeline, and press <b>Space</b> to play. Video
					clips bring their audio onto a separate audio track automatically,
					like Premiere Pro.
				</p>
				<p>
					The fastest path to a finished video: import everything, then run{" "}
					<b>AI CUT → AI Cut</b> (assembles and edits it like a YouTube
					video), add effects with <b>RUN HYPERFRAMES</b>, and hit{" "}
					<b>Export</b>.
				</p>
			</HelpSection>

			<HelpSection title="The AI prompt box (under the preview)">
				<p>
					Type what you want in plain language: <i>"edit this like a YouTube
					video"</i>, <i>"find b-roll of a city at night"</i>, <i>"add tense
					background music"</i>, <i>"put the title Big News on screen"</i>,{" "}
					<i>"add captions"</i>.
				</p>
				<p>
					It only does video work — cuts, b-roll, music/SFX, HyperFrames
					effects, text, captions. B-roll needs a SerpAPI key and music
					needs a HeyGen key (Settings → AI → Integrations).
				</p>
			</HelpSection>

			<HelpSection title="Hotkeys (Premiere-style)">
				<p>
					<b>Space</b> play/pause · <b>J/L</b> step back/forward ·{" "}
					<b>Up/Down</b> jump between edit points · <b>\</b> toggle
					timeline fit · <b>+/-</b> zoom.
				</p>
				<p>
					<b>Ctrl+K</b> cut at playhead · <b>Q/W</b> ripple trim
					previous/next edit to playhead · <b>D</b> select clip at playhead ·{" "}
					<b>A</b> Track Select Forward tool · <b>Shift+Delete</b> ripple
					delete · <b>Ctrl+L</b> link/unlink audio · <b>Ctrl+R</b> speed
					panel · <b>M</b> marker · <b>`</b> maximize the active panel.
				</p>
				<p>
					Every binding can be changed in <b>Settings → Hotkeys</b> — click
					a key and press the new combination.
				</p>
			</HelpSection>

			<HelpSection title="Timeline tools (left rail)">
				<p>
					<b>Selection</b> — click and drag clips. <b>Track Select Forward
					(A)</b> — click to select everything to the right; Shift+click for
					one track. <b>Razor</b> — split at the playhead. <b>Pen</b> — with
					a clip selected, draw a freeform mask on it (close the shape on its
					first point; feather/invert live in the Masks tab); with nothing
					selected it draws a custom shape. <b>Text</b> — click the preview
					to place text. <b>Marker</b> — bookmark the playhead.
				</p>
				<p>
					Click the empty space between two clips to select the <b>gap</b>,
					then press Delete to ripple it closed across all tracks. Premiere
					rule: blocked if a clip on another track overlaps the gap.
				</p>
			</HelpSection>

			<HelpSection title="AI CUT — automatic editing">
				<p>
					<b>AI Cut</b> (top item): assembles every bin asset onto the
					timeline, removes silences, then Claude reads the whole transcript
					and edits it like a YouTube video — retakes, stutters, tangents,
					pacing. <b>Remove silences</b>: audio-only dead-air removal.{" "}
					<b>Remove repeats</b>: retakes only (keeps your last take).{" "}
					<b>Full cleanup</b>: stutters + repeats + tangents without
					assembling. One Ctrl+Z always restores everything; Stop aborts
					mid-run.
				</p>
			</HelpSection>

			<HelpSection title="RUN HYPERFRAMES — motion graphics">
				<p>
					Transcribes your timeline, has Claude pick the moments that
					deserve a motion-graphic overlay, renders them locally, and places
					them on AI tracks. The <b>HyperFrames</b> tab controls which
					templates it may use (checkboxes), the style theme/accent color,
					and a Direction box for your own instructions. Generated clips can
					be re-edited: select one and use its HyperFrames properties tab,
					or "Edit in Studio" for full control.
				</p>
			</HelpSection>

			<HelpSection title="Sounds, captions, export">
				<p>
					<b>Sounds</b>: free sound effects search, plus Music & SFX
					(HeyGen key) — describe what you need, preview, and add at the
					playhead. <b>Captions</b>: generate from speech, then one-click
					styles (Neon Accent, Pill Karaoke, Weight Shift...). <b>Export</b>:
					pick format/quality, choose where to save — Chrome remembers your
					folder for next time.
				</p>
			</HelpSection>

			<HelpSection title="Self-learning">
				<p>
					VibeCut learns from what you keep: AI effects you delete, AI Cut
					passes you undo, and whether you restore or trim more between an
					AI Cut and your export. Strong patterns become instructions for
					the next AI run. Review or clear everything in Settings → AI →
					Self-learning. It all stays on this device.
				</p>
			</HelpSection>

			<HelpSection title="Keys & privacy">
				<p>
					All API keys (Anthropic, HeyGen, SerpAPI) live only in this
					browser on this device — never in project files or exports. The
					default Claude auth uses your Claude Code subscription, no key
					needed. Rendering happens locally (needs Node + FFmpeg).
				</p>
			</HelpSection>
		</div>
	);
}
