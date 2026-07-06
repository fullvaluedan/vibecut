import { test, expect, type Page } from "@playwright/test";
import { FIXTURE_MP4 } from "./global-setup";

/**
 * The core-loop smoke (roadmap P0.6): boot -> new project -> import real media
 * -> add to timeline -> split -> undo. If any of this breaks, nothing else in
 * the product matters, so it runs on every PR.
 *
 * State assertions go through window.__vibeEditor (the dev-mode EditorCore
 * handle, core/index.ts) — the DOM shows the result, the editor state proves
 * it. Interactions stay on the real UI paths (buttons, hidden file input,
 * keyboard shortcuts), NOT programmatic commands.
 */

/** Editor state probes, kept in one place so specs read as user actions. */
async function mainTrackClipCount(page: Page): Promise<number> {
	return page.evaluate(() => {
		type EditorHandle = {
			scenes: {
				getActiveSceneOrNull: () =>
					| { tracks: { main: { elements: unknown[] } } }
					| null;
			};
		};
		const editor = (window as unknown as { __vibeEditor?: EditorHandle })
			.__vibeEditor;
		return editor?.scenes.getActiveSceneOrNull()?.tracks.main.elements.length ?? -1;
	});
}

async function createFreshProject(page: Page): Promise<void> {
	// A fresh profile gets the onboarding dialog, whose backdrop intercepts
	// every pointer event — mark it seen before the app boots.
	await page.addInitScript(() => {
		localStorage.setItem("hasSeenOnboarding", "true");
	});
	await page.goto("/projects");
	await page.getByRole("button", { name: "New project" }).first().click();
	await page.waitForURL(/\/editor\//);
	// The editor is ready once the dev handle exists and a scene is loaded.
	await page.waitForFunction(
		() =>
			Boolean(
				(window as unknown as { __vibeEditor?: unknown }).__vibeEditor,
			),
		undefined,
		{ timeout: 60_000 },
	);
}

test("editor boots into a fresh project", async ({ page }) => {
	await createFreshProject(page);
	// The timeline toolbar is the editor's spine — its presence means the
	// layout, stores, and wasm boundary all came up.
	await expect(page.getByRole("button", { name: "RUN HYPERFRAMES" })).toBeVisible();
	await expect(page.getByRole("button", { name: "AI CUT" })).toBeVisible();
});

test("import -> add to timeline -> split -> undo", async ({ page }) => {
	await createFreshProject(page);

	// Import through the assets panel's real (hidden) file input.
	await page.setInputFiles('input[type="file"]', FIXTURE_MP4);
	const assetName = page.getByTitle("e2e-sample.mp4").first();
	await expect(assetName).toBeVisible({ timeout: 60_000 });

	// Add to timeline via the bin item's hover Plus button (the click path a
	// user takes; drag-drop is a separate, gesture-level concern).
	const binItem = page.locator('[draggable="true"]').first();
	await binItem.hover();
	await binItem.locator("button").first().click();
	await expect
		.poll(() => mainTrackClipCount(page), { timeout: 30_000 })
		.toBe(1);

	// Park the playhead mid-clip, select the clip under it (D), split (S).
	await page.evaluate(() => {
		type EditorHandle = {
			timeline: { getTotalDuration: () => number };
			playback: { seek: (args: { time: number }) => void };
		};
		const editor = (window as unknown as { __vibeEditor?: EditorHandle })
			.__vibeEditor!;
		editor.playback.seek({ time: editor.timeline.getTotalDuration() / 2 });
	});
	await page.keyboard.press("d");
	await page.keyboard.press("s");
	await expect
		.poll(() => mainTrackClipCount(page), { timeout: 15_000 })
		.toBe(2);

	// One undo restores the un-split clip.
	await page.keyboard.press("Control+z");
	await expect
		.poll(() => mainTrackClipCount(page), { timeout: 15_000 })
		.toBe(1);
});
