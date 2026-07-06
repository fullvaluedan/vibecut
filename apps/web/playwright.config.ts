import { defineConfig } from "@playwright/test";

/**
 * E2E harness (roadmap P0.6). Runs the REAL editor in a real Chromium against
 * synthetic media, so shipped features get an automated check instead of
 * landing on the TO-VERIFY pile.
 *
 * - Local: `bun run e2e` starts its own dev server on E2E_PORT (default 3277)
 *   or reuses one already there. Point E2E_BASE_URL at a running server to
 *   skip server management entirely.
 * - The synthetic fixture (colour-bars + tone mp4) is generated once by
 *   global-setup via ffmpeg.
 */
const PORT = Number(process.env.E2E_PORT ?? 3277);
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
	testDir: "./e2e",
	globalSetup: "./e2e/global-setup.ts",
	timeout: 120_000,
	// The editor is a singleton-heavy app (EditorCore, OPFS, IndexedDB) — keep
	// runs serial so projects/state can't race across workers.
	workers: 1,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
	use: {
		baseURL,
		trace: "retain-on-failure",
		video: "retain-on-failure",
	},
	webServer: process.env.E2E_BASE_URL
		? undefined
		: {
				command: `bun run dev -- --port ${PORT}`,
				url: baseURL,
				reuseExistingServer: !process.env.CI,
				timeout: 180_000,
			},
});
