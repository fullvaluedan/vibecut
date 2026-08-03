import type { EffectPass } from "@/effects/types";

/**
 * Runtime guard against a stale `opencut-wasm` build.
 *
 * The defect this guards: `apps/web` resolves `opencut-wasm` from
 * `apps/web/node_modules`, where `bun install` materializes the PINNED
 * published package (0.2.10) as a real directory that shadows the local
 * `rust/wasm/pkg` build (0.3.0). Every shader added after blur then errors
 * inside the compositor (`Missing uniform 'u_sigma' for shader
 * 'color-adjust'`, etc.) and the preview blanks.
 *
 * Detection: 0.3.0 exports `wasmCapabilities()` (rust/wasm/src/effects.rs)
 * reporting its version, its registered shader ids, and whether the
 * compositor reads the mask `expansion`/`opacity` descriptor fields. A stale
 * package has no such export, which reads as "supports nothing". The guard
 * then:
 *
 * - drops passes for unsupported shaders, so the clip renders WITHOUT that
 *   effect instead of throwing inside `renderFrame` (no-op degradation);
 * - degrades mask `expansion`/`opacity` to their no-op values at the
 *   descriptor edge (`frame-descriptor.ts`);
 * - drives ONE banner in the editor (`StaleWasmBanner` in
 *   `app/editor/[project_id]/page.tsx`) telling the developer to run
 *   `bun run build:wasm && bun run link:wasm`.
 *
 * This module deliberately does NOT import `opencut-wasm`: bun cannot
 * evaluate the wasm package's module top level, so any module importing it
 * directly is poison to `bun test`. The probe is injected at module scope by
 * `gpu-renderer.ts`, which already owns the static wasm import.
 */

/**
 * Every shader id the definitions in `@/effects/definitions` can emit. Kept
 * as an explicit list (not derived from the registry) because some
 * definitions resolve to zero passes at neutral params, so derivation cannot
 * see them.
 */
const EXPECTED_WASM_SHADERS = [
	"gaussian-blur",
	"color-adjust",
	"chroma-key",
	"pixelate",
	"vignette",
	"glow",
	"noise",
] as const;

export type WasmCapabilitiesReport = {
	/** True when every expected shader is present (the healthy case). */
	supported: boolean;
	/** Version the wasm reports; null when the export is missing (pre-0.3.0). */
	version: string | null;
	/** Shader ids the loaded wasm actually registered. */
	supportedShaders: ReadonlySet<string>;
	/** Expected shaders the loaded wasm does NOT have. */
	missingShaders: string[];
	/** Whether the compositor reads the mask expansion/opacity descriptor fields (0.3.0+). */
	maskExpansionOpacity: boolean;
};

/**
 * No probe registered means we are not running against the real wasm module
 * at all (unit tests, non-app contexts): preserve the pre-guard behavior
 * exactly rather than degrading anything.
 */
const UNPROBED_REPORT: WasmCapabilitiesReport = {
	supported: true,
	version: null,
	supportedShaders: new Set(EXPECTED_WASM_SHADERS),
	missingShaders: [],
	maskExpansionOpacity: true,
};

/** Pure: turns the raw `wasmCapabilities()` return value into a report. */
export function buildCapabilitiesReport(raw: unknown): WasmCapabilitiesReport {
	const record = (raw ?? {}) as Record<string, unknown>;
	const version = typeof record.version === "string" ? record.version : null;
	const supportedShaders = new Set(
		Array.isArray(record.shaders)
			? record.shaders.filter((id): id is string => typeof id === "string")
			: [],
	);
	const missingShaders = EXPECTED_WASM_SHADERS.filter(
		(id) => !supportedShaders.has(id),
	);
	return {
		supported: version !== null && missingShaders.length === 0,
		version,
		supportedShaders,
		missingShaders: [...missingShaders],
		maskExpansionOpacity: record.maskExpansionOpacity === true,
	};
}

let capabilitiesProbe: (() => unknown) | null = null;
let cachedReport: WasmCapabilitiesReport | null = null;

/**
 * Called once at module scope by `gpu-renderer.ts` (the module that owns the
 * static `opencut-wasm` import) with a thunk reading the namespace export.
 */
export function registerWasmCapabilitiesProbe(probe: () => unknown): void {
	capabilitiesProbe = probe;
	cachedReport = null;
}

export function getWasmCapabilities(): WasmCapabilitiesReport {
	if (!cachedReport) {
		if (!capabilitiesProbe) {
			return UNPROBED_REPORT;
		}
		let raw: unknown;
		try {
			raw = capabilitiesProbe();
		} catch {
			// A probe that throws means the module is half-initialized; treat it
			// as stale rather than crash the render path.
			raw = undefined;
		}
		cachedReport = buildCapabilitiesReport(raw);
	}
	return cachedReport;
}

/**
 * Pure: the no-op degradation. Passes whose shader the loaded wasm cannot run
 * are dropped, so the clip renders without that effect; a group that loses
 * every pass comes back empty, which the compositor already skips without a
 * blit (T19.0 `apply_effect_groups` hygiene).
 */
export function filterPassesByCapabilities({
	passes,
	report,
}: {
	passes: EffectPass[];
	report: WasmCapabilitiesReport;
}): EffectPass[] {
	if (report.supported) {
		return passes;
	}
	return passes.filter((pass) => report.supportedShaders.has(pass.shader));
}

export function filterSupportedEffectPasses(passes: EffectPass[]): EffectPass[] {
	return filterPassesByCapabilities({
		passes,
		report: getWasmCapabilities(),
	});
}
