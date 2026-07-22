import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	hyperframesVersionToRegistryTag,
	resolveInstalledHyperframesVersion,
	resolveRegistryBase,
} from "./registry-ref";

function withTempPackageDir(
	pkg: Record<string, unknown>,
	fn: (dir: string) => void,
): void {
	const dir = mkdtempSync(path.join(os.tmpdir(), "hf-registry-ref-"));
	try {
		writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("hyperframesVersionToRegistryTag", () => {
	it("maps a plain semver version to a v-prefixed tag", () => {
		expect(hyperframesVersionToRegistryTag("0.7.68")).toBe("v0.7.68");
		expect(hyperframesVersionToRegistryTag("1.2.3")).toBe("v1.2.3");
	});

	it("maps a prerelease version to a v-prefixed tag", () => {
		expect(hyperframesVersionToRegistryTag("0.7.67-alpha.0")).toBe(
			"v0.7.67-alpha.0",
		);
	});

	it("maps a version with build metadata to a v-prefixed tag", () => {
		expect(hyperframesVersionToRegistryTag("0.7.68+build.5")).toBe(
			"v0.7.68+build.5",
		);
	});

	it("trims surrounding whitespace", () => {
		expect(hyperframesVersionToRegistryTag("  0.7.68  ")).toBe("v0.7.68");
	});

	it("throws a clear error on a missing version", () => {
		expect(() => hyperframesVersionToRegistryTag(undefined)).toThrow(
			/missing/i,
		);
		expect(() => hyperframesVersionToRegistryTag(null)).toThrow(/missing/i);
		expect(() => hyperframesVersionToRegistryTag("")).toThrow(/missing/i);
		expect(() => hyperframesVersionToRegistryTag("   ")).toThrow(/missing/i);
	});

	it("throws a clear error on a malformed version, never falling back to main", () => {
		expect(() => hyperframesVersionToRegistryTag("main")).toThrow(
			/not a valid semver/i,
		);
		expect(() => hyperframesVersionToRegistryTag("v0.7.68")).toThrow(
			/not a valid semver/i,
		);
		expect(() => hyperframesVersionToRegistryTag("0.7")).toThrow(
			/not a valid semver/i,
		);
		expect(() => hyperframesVersionToRegistryTag("latest")).toThrow(
			/not a valid semver/i,
		);
	});
});

describe("resolveInstalledHyperframesVersion", () => {
	it("reads the version off a package.json in the given dir", () => {
		withTempPackageDir({ name: "hyperframes", version: "9.9.9" }, (dir) => {
			expect(resolveInstalledHyperframesVersion({ packageDir: dir })).toBe(
				"9.9.9",
			);
		});
	});

	it("throws a clear error when package.json has no version field", () => {
		withTempPackageDir({ name: "hyperframes" }, (dir) => {
			expect(() =>
				resolveInstalledHyperframesVersion({ packageDir: dir }),
			).toThrow(/no "version" field/);
		});
	});

	it("resolves the real installed hyperframes package's version by default", () => {
		// No packageDir override: exercises the real findHyperframesPackageDir()
		// walk against this repo's actual node_modules/hyperframes install.
		const version = resolveInstalledHyperframesVersion();
		expect(version).toMatch(/^\d+\.\d+\.\d+/);
	});
});

describe("resolveRegistryBase", () => {
	it("builds the raw.githubusercontent URL from the resolved tag", () => {
		withTempPackageDir({ name: "hyperframes", version: "0.7.68" }, (dir) => {
			expect(resolveRegistryBase({ packageDir: dir })).toBe(
				"https://raw.githubusercontent.com/heygen-com/hyperframes/v0.7.68/registry",
			);
		});
	});

	it("never falls back to main: throws when the installed version is malformed", () => {
		withTempPackageDir(
			{ name: "hyperframes", version: "not-a-version" },
			(dir) => {
				expect(() => resolveRegistryBase({ packageDir: dir })).toThrow(
					/not a valid semver/i,
				);
			},
		);
	});

	it("resolves against the real installed engine, matching the repo's pinned version", () => {
		// packages/hf-bridge/package.json pins an exact hyperframes version; the
		// resolved base must point at that exact version's tag.
		const pinned = JSON.parse(
			readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf8"),
		).dependencies.hyperframes;
		expect(resolveRegistryBase()).toBe(
			`https://raw.githubusercontent.com/heygen-com/hyperframes/v${pinned}/registry`,
		);
	});
});
