import { describe, expect, test } from "bun:test";
import {
	buildCapabilitiesReport,
	compactEffectPassGroups,
	filterPassesByCapabilities,
	type WasmCapabilitiesReport,
} from "../wasm-capabilities";
import type { EffectPass } from "@/effects/types";

/**
 * Unit tests for the stale-wasm guard's pure halves. The live wiring (the
 * probe injected by `gpu-renderer.ts` reading the real `wasmCapabilities`
 * export) cannot run under bun — bun cannot evaluate the wasm package's
 * module top level — so the report-building and pass-filtering logic is
 * exercised here against raw export shapes.
 */

const ALL_SHADERS = [
	"gaussian-blur",
	"color-adjust",
	"chroma-key",
	"pixelate",
	"vignette",
	"glow",
	"noise",
];

function healthyRaw() {
	return {
		version: "0.3.0",
		shaders: [...ALL_SHADERS],
		maskExpansionOpacity: true,
	};
}

function pass(shader: string): EffectPass {
	return { shader, uniforms: {} };
}

describe("buildCapabilitiesReport", () => {
	test("a healthy 0.3.0 build reports full support", () => {
		const report = buildCapabilitiesReport(healthyRaw());
		expect(report.supported).toBe(true);
		expect(report.version).toBe("0.3.0");
		expect(report.missingShaders).toEqual([]);
		expect(report.maskExpansionOpacity).toBe(true);
	});

	test("a missing export (pre-0.3.0 package) reports nothing supported", () => {
		const report = buildCapabilitiesReport(undefined);
		expect(report.supported).toBe(false);
		expect(report.version).toBeNull();
		expect(report.missingShaders).toEqual(ALL_SHADERS);
		expect(report.supportedShaders.size).toBe(0);
		expect(report.maskExpansionOpacity).toBe(false);
	});

	test("a build missing one shader reports exactly that gap", () => {
		const raw = healthyRaw();
		raw.shaders = raw.shaders.filter((id) => id !== "color-adjust");
		const report = buildCapabilitiesReport(raw);
		expect(report.supported).toBe(false);
		expect(report.missingShaders).toEqual(["color-adjust"]);
		expect(report.supportedShaders.has("gaussian-blur")).toBe(true);
		expect(report.supportedShaders.has("color-adjust")).toBe(false);
	});

	test("garbage shapes degrade instead of throwing", () => {
		expect(buildCapabilitiesReport(null).supported).toBe(false);
		expect(buildCapabilitiesReport("0.3.0").supported).toBe(false);
		expect(buildCapabilitiesReport({ shaders: "noise" }).supported).toBe(
			false,
		);
	});
});

describe("filterPassesByCapabilities", () => {
	test("a healthy report passes everything through untouched", () => {
		const passes = [pass("gaussian-blur"), pass("color-adjust")];
		expect(
			filterPassesByCapabilities({
				passes,
				report: buildCapabilitiesReport(healthyRaw()),
			}),
		).toBe(passes);
	});

	test("a stale report drops every pass (no-op degradation)", () => {
		const passes = [pass("color-adjust"), pass("chroma-key")];
		expect(
			filterPassesByCapabilities({
				passes,
				report: buildCapabilitiesReport(undefined),
			}),
		).toEqual([]);
	});

	test("a partial report keeps only the shaders the wasm has", () => {
		const raw = healthyRaw();
		raw.shaders = ["gaussian-blur", "noise"];
		const report: WasmCapabilitiesReport = buildCapabilitiesReport(raw);
		expect(
			filterPassesByCapabilities({
				passes: [pass("gaussian-blur"), pass("glow"), pass("noise")],
				report,
			}).map((p) => p.shader),
		).toEqual(["gaussian-blur", "noise"]);
	});
});

describe("compactEffectPassGroups (R19-7)", () => {
	test("drops groups the stale-wasm guard emptied", () => {
		// The R19-7 hole: under a stale compositor the guard empties a group,
		// and the STALE compositor throws `At least one effect pass is
		// required` on it — the exact crash the guard exists to prevent. The
		// empty group must never leave resolve.ts.
		const stale = buildCapabilitiesReport(undefined);
		const groups = [
			filterPassesByCapabilities({
				passes: [pass("color-adjust")],
				report: stale,
			}),
			filterPassesByCapabilities({
				passes: [pass("chroma-key")],
				report: stale,
			}),
		];
		expect(compactEffectPassGroups(groups)).toEqual([]);
	});

	test("keeps non-empty groups and preserves their order", () => {
		const groups = [[pass("gaussian-blur")], [], [pass("noise")]];
		expect(compactEffectPassGroups(groups).map((g) => g[0].shader)).toEqual([
			"gaussian-blur",
			"noise",
		]);
	});
});
