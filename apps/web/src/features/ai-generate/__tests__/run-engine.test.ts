import { describe, expect, it } from "bun:test";
import { resolveHfRunEngine } from "../run-engine";

describe("resolveHfRunEngine", () => {
	it("keeps the authored engine as-is", () => {
		expect(
			resolveHfRunEngine({
				engine: "authored",
				allowedTemplateCount: 0,
				hasDirection: false,
				pickedAssetCount: 0,
			}),
		).toEqual({ engine: "authored", fellBackToAuthored: false });
	});

	it("keeps native when a template is checked", () => {
		expect(
			resolveHfRunEngine({
				engine: "native",
				allowedTemplateCount: 2,
				hasDirection: false,
				pickedAssetCount: 0,
			}),
		).toEqual({ engine: "native", fellBackToAuthored: false });
	});

	it("keeps cinematic when a template is checked", () => {
		expect(
			resolveHfRunEngine({
				engine: "cinematic",
				allowedTemplateCount: 1,
				hasDirection: false,
				pickedAssetCount: 0,
			}),
		).toEqual({ engine: "cinematic", fellBackToAuthored: false });
	});

	it("falls back to authored when no template but a style/asset is picked", () => {
		expect(
			resolveHfRunEngine({
				engine: "native",
				allowedTemplateCount: 0,
				hasDirection: false,
				pickedAssetCount: 1,
			}),
		).toEqual({ engine: "authored", fellBackToAuthored: true });
	});

	it("falls back to authored when no template but a direction is written", () => {
		expect(
			resolveHfRunEngine({
				engine: "cinematic",
				allowedTemplateCount: 0,
				hasDirection: true,
				pickedAssetCount: 0,
			}),
		).toEqual({ engine: "authored", fellBackToAuthored: true });
	});

	it("errors when there is no template, no pick, and no direction", () => {
		const d = resolveHfRunEngine({
			engine: "native",
			allowedTemplateCount: 0,
			hasDirection: false,
			pickedAssetCount: 0,
		});
		expect("error" in d).toBe(true);
	});
});
