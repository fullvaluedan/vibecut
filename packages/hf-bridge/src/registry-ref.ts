import { readFileSync } from "node:fs";
import path from "node:path";
import { findHyperframesPackageDir } from "./renderer";

/**
 * Fixes the registry-fetch / pinned-engine version-skew bug: registry-fetch.ts
 * and bake.ts used to hardcode the HyperFrames GitHub repo's `main` branch, so
 * registry content was always-latest while the `hyperframes` npm engine we
 * actually render with stays exact-pinned (see packages/hf-bridge/package.json).
 * A registry-only change upstream could then bake fine against `main` but
 * break against our older pinned engine, for reasons that have nothing to do
 * with our own code.
 *
 * The fix: derive the registry ref from the SAME version already pinned in
 * package.json, read at runtime off the installed `hyperframes` package (the
 * single source of truth, no second place to keep in sync), and fetch that
 * exact git tag's registry/ snapshot instead of `main`.
 */

const HYPERFRAMES_REPO_RAW_BASE =
	"https://raw.githubusercontent.com/heygen-com/hyperframes";

// Tag scheme confirmed against the live GitHub tags API (2026-07-22):
//   GET https://api.github.com/repos/heygen-com/hyperframes/tags
//   -> v0.7.68, v0.7.67, v0.7.67-alpha.0, v0.7.66, v0.7.65, ... down through v0.7.10
// Every release is tagged "v" + the exact npm version string, prereleases
// included. No bare (unprefixed) tags exist. Also confirmed the raw-content
// fetch actually resolves at that ref: a GET of
// raw.githubusercontent.com/heygen-com/hyperframes/v0.7.68/registry/registry.json
// returns 200 with the expected registry.json shape; a made-up tag (v9.9.9)
// returns 404.
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/**
 * Pure: maps an installed `hyperframes` version string to the upstream git
 * ref that carries a matching registry/ snapshot ("0.7.68" -> "v0.7.68").
 *
 * Throws on a missing or malformed version instead of guessing. A bad
 * version string means we cannot know which registry snapshot matches the
 * engine, and silently falling back to `main` would resurrect the exact
 * skew bug this function exists to prevent.
 */
export function hyperframesVersionToRegistryTag(
	version: string | null | undefined,
): string {
	if (typeof version !== "string" || !version.trim()) {
		throw new Error(
			"Cannot resolve a HyperFrames registry tag: the installed hyperframes version is missing.",
		);
	}
	const trimmed = version.trim();
	if (!SEMVER_RE.test(trimmed)) {
		throw new Error(
			`Cannot resolve a HyperFrames registry tag: "${trimmed}" is not a valid semver version.`,
		);
	}
	return `v${trimmed}`;
}

/**
 * Reads the version of the `hyperframes` package actually installed in this
 * repo, the single source of truth for "which engine are we rendering with
 * right now." Uses the same package-directory lookup `resolveHyperframesCli`
 * uses for the CLI binary (renderer.ts's `findHyperframesPackageDir`), so the
 * two never disagree about which install is "the" installed one.
 *
 * `options.packageDir` overrides the lookup for tests.
 */
export function resolveInstalledHyperframesVersion(options?: {
	packageDir?: string;
}): string {
	const pkgDir = options?.packageDir ?? findHyperframesPackageDir();
	const raw = readFileSync(path.join(pkgDir, "package.json"), "utf8");
	const pkg = JSON.parse(raw) as { version?: unknown };
	if (typeof pkg.version !== "string" || !pkg.version.trim()) {
		throw new Error(
			`hyperframes package.json at ${pkgDir} has no "version" field`,
		);
	}
	return pkg.version;
}

/**
 * The registry base URL to fetch from: the installed engine's version,
 * mapped to its release tag. Replaces the old hardcoded `.../main/registry`
 * base previously in registry-fetch.ts and bake.ts.
 *
 * No fallback to `main` on any failure path (missing engine, unreadable
 * package.json, malformed version): every failure throws a clear error
 * instead, since a silent fallback here is precisely the version-skew bug
 * this function exists to close.
 */
export function resolveRegistryBase(options?: {
	packageDir?: string;
}): string {
	const version = resolveInstalledHyperframesVersion(options);
	const tag = hyperframesVersionToRegistryTag(version);
	return `${HYPERFRAMES_REPO_RAW_BASE}/${tag}/registry`;
}
