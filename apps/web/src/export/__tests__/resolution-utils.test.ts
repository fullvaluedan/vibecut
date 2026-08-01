import { describe, expect, it } from "bun:test";
import {
	deriveOutputSize,
	computeEffectiveBitrate,
	formatBitrate,
} from "@/export/resolution-utils";

describe("deriveOutputSize", () => {
	const projectWidth = 1920;
	const projectHeight = 1080;

	it("returns project dimensions for project preset", () => {
		const result = deriveOutputSize({
			preset: "project",
			projectWidth,
			projectHeight,
		});
		expect(result.width).toBe(1920);
		expect(result.height).toBe(1080);
	});

	it("scales to 2160p with aspect ratio preserved", () => {
		const result = deriveOutputSize({
			preset: "2160",
			projectWidth,
			projectHeight,
		});
		expect(result.height).toBe(2160);
		expect(result.width).toBe(3840);
		expect(result.width % 2).toBe(0);
		expect(result.height % 2).toBe(0);
	});

	it("scales to 1080p with aspect ratio preserved", () => {
		const result = deriveOutputSize({
			preset: "1080",
			projectWidth,
			projectHeight,
		});
		expect(result.height).toBe(1080);
		expect(result.width).toBe(1920);
		expect(result.width % 2).toBe(0);
		expect(result.height % 2).toBe(0);
	});

	it("scales to 720p with aspect ratio preserved", () => {
		const result = deriveOutputSize({
			preset: "720",
			projectWidth,
			projectHeight,
		});
		expect(result.height).toBe(720);
		expect(result.width).toBe(1280);
		expect(result.width % 2).toBe(0);
		expect(result.height % 2).toBe(0);
	});

	it("rounds to even numbers for codec compatibility", () => {
		const result = deriveOutputSize({
			preset: "720",
			projectWidth: 1079,
			projectHeight: 607,
		});
		expect(result.width % 2).toBe(0);
		expect(result.height % 2).toBe(0);
	});
});

describe("computeEffectiveBitrate", () => {
	const projectPixels = 1920 * 1080;

	it("returns same bitrate for same resolution", () => {
		const result = computeEffectiveBitrate({
			quality: "high",
			projectPixels,
			outputPixels: projectPixels,
		});
		expect(result).toBe(12);
	});

	it("scales bitrate up for 2x resolution", () => {
		const outputPixels = projectPixels * 4;
		const result = computeEffectiveBitrate({
			quality: "high",
			projectPixels,
			outputPixels,
		});
		expect(result).toBe(48);
	});

	it("scales bitrate down for 0.5x resolution", () => {
		const outputPixels = projectPixels / 4;
		const result = computeEffectiveBitrate({
			quality: "high",
			projectPixels,
			outputPixels,
		});
		expect(result).toBe(3);
	});

	it("respects quality levels at project resolution", () => {
		expect(
			computeEffectiveBitrate({
				quality: "low",
				projectPixels,
				outputPixels: projectPixels,
			}),
		).toBe(2);
		expect(
			computeEffectiveBitrate({
				quality: "medium",
				projectPixels,
				outputPixels: projectPixels,
			}),
		).toBe(6);
		expect(
			computeEffectiveBitrate({
				quality: "high",
				projectPixels,
				outputPixels: projectPixels,
			}),
		).toBe(12);
		expect(
			computeEffectiveBitrate({
				quality: "very_high",
				projectPixels,
				outputPixels: projectPixels,
			}),
		).toBe(24);
	});
});

describe("formatBitrate", () => {
	it("formats bitrate with Mbps unit", () => {
		expect(formatBitrate(12)).toBe("12 Mbps");
	});

	it("formats various bitrates correctly", () => {
		expect(formatBitrate(2)).toBe("2 Mbps");
		expect(formatBitrate(48)).toBe("48 Mbps");
	});
});
