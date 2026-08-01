export const SITE_URL = "https://opencut.app";

export const SITE_INFO = {
	title: "VibeCut",
	description:
		"The AI-native video editor: edit, generate, and vibe. In your browser.",
	url: SITE_URL,
	openGraphImage: "/open-graph/default.jpg",
	twitterImage: "/open-graph/default.jpg",
	favicon: "/favicon.ico",
};

// T18.5: designed-by-us bold wordmark reading "VibeCut" (CapCut-inspired
// spirit, zero imitation of their actual mark). Used wherever there is room
// for the full lockup (marketing header, home page). The old OpenCut SVGs
// under /logos/opencut/ stay untouched (MIT attribution + /brand page).
export const DEFAULT_LOGO_URL = "/logos/vibecut/wordmark.svg";

// Compact square "V" mark for tight UI slots (editor toolbar button, footer
// icon, favicon source) where the full wordmark would be squeezed illegible.
export const DEFAULT_MARK_URL = "/logos/vibecut/mark.svg";
