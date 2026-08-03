import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Version guard for the opencut-wasm shadow defect: `apps/web` loads whatever
 * `opencut-wasm` resolves to in node_modules, and the pinned published
 * package shadows the local `rust/wasm` build. Three live invariants, loudest
 * last:
 *
 * 1. the INSTALLED copy (link or npm shadow) matches the Rust source version;
 * 2. a built `rust/wasm/pkg` matches the Rust source version;
 * 3. the PINNED npm spec matches the Rust source version — SKIPPED while the
 *    0.3.0 bump awaits the Dan-gated npm publish (a fresh `bun install` must
 *    keep resolving to something, and 0.3.0 is not on the registry yet).
 *    UN-SKIP it as the last step of the publish checklist in
 *    rust/wasm/README.md, right after repinning both package.json files.
 *
 * The path math anchors on this file so the tests pass from any cwd
 * (`bun test` at the repo root or under apps/web).
 */

const WEB_ROOT = resolve(import.meta.dir, "../../../..");
const REPO_ROOT = resolve(WEB_ROOT, "../..");

/** "^0.2.10" / "~0.2.10" / ">=0.2.10" / "0.2.10" all normalize to "0.2.10". */
export function normalizePinVersion(spec: string): string {
	const match = spec.trim().match(/(\d+\.\d+\.\d+)/);
	if (!match) {
		throw new Error(`cannot parse an exact version out of "${spec}"`);
	}
	return match[1];
}

/** The `version` of the crate's own `[package]` section (not a dependency's). */
export function readCargoPackageVersion(cargoToml: string): string {
	const section = cargoToml.match(/\[package\]([\s\S]*?)(\r?\n\[|$)/);
	const match = section?.[1].match(/^version\s*=\s*"([^"]+)"/m);
	if (!match) {
		throw new Error("no [package] version found in Cargo.toml");
	}
	return match[1];
}

function readPackageJsonVersion(path: string): string {
	return JSON.parse(readFileSync(path, "utf8")).version;
}

function readPinnedSpec(path: string): string {
	const spec = JSON.parse(readFileSync(path, "utf8")).dependencies?.[
		"opencut-wasm"
	];
	if (typeof spec !== "string") {
		throw new Error(`${path} does not pin opencut-wasm in dependencies`);
	}
	return spec;
}

const cargoVersion = readCargoPackageVersion(
	readFileSync(resolve(REPO_ROOT, "rust/wasm/Cargo.toml"), "utf8"),
);

describe("version parsers", () => {
	test("normalizePinVersion strips range prefixes", () => {
		expect(normalizePinVersion("^0.2.10")).toBe("0.2.10");
		expect(normalizePinVersion("~0.3.0")).toBe("0.3.0");
		expect(normalizePinVersion("0.3.0")).toBe("0.3.0");
		expect(normalizePinVersion(">=1.2.3")).toBe("1.2.3");
	});

	test("readCargoPackageVersion reads [package], not dependencies", () => {
		const toml = [
			'[package]',
			'name = "opencut-wasm"',
			'version = "0.3.0"',
			'',
			'[dependencies]',
			'effects = { version = "0.1.0", path = "../crates/effects" }',
		].join("\n");
		expect(readCargoPackageVersion(toml)).toBe("0.3.0");
	});
});

describe("opencut-wasm version guard", () => {
	test("both package.json files pin the same spec", () => {
		const rootSpec = readPinnedSpec(resolve(REPO_ROOT, "package.json"));
		const webSpec = readPinnedSpec(
			resolve(WEB_ROOT, "package.json"),
		);
		expect({ rootSpec, webSpec }).toEqual({
			rootSpec: webSpec,
			webSpec,
		});
	});

	test("the installed opencut-wasm matches the Rust source version", () => {
		const installedPath = resolve(
			WEB_ROOT,
			"node_modules/opencut-wasm/package.json",
		);
		if (!existsSync(installedPath)) {
			throw new Error(
				"opencut-wasm is not installed for apps/web — run `bun install` from the repo root",
			);
		}
		const installed = readPackageJsonVersion(installedPath);
		if (installed !== cargoVersion) {
			throw new Error(
				`apps/web loads opencut-wasm@${installed} but rust/wasm declares ${cargoVersion}. ` +
					`The app is running a STALE build (the published package shadows the local one). ` +
					`Fix: run \`bun run build:wasm && bun run link:wasm\` from the repo root ` +
					`(see rust/wasm/README.md, "Local development").`,
			);
		}
	});

	test("a built rust/wasm/pkg matches the Rust source version", () => {
		const pkgPath = resolve(REPO_ROOT, "rust/wasm/pkg/package.json");
		if (!existsSync(pkgPath)) {
			// No local build on this machine (fresh checkout); nothing to drift.
			return;
		}
		const built = readPackageJsonVersion(pkgPath);
		if (built !== cargoVersion) {
			throw new Error(
				`rust/wasm/pkg is opencut-wasm@${built} but rust/wasm/Cargo.toml declares ${cargoVersion}. ` +
					`The local build is stale — rebuild with \`bun run build:wasm\`.`,
			);
		}
	});

	// Un-skip after publishing opencut-wasm 0.3.0 and repinning both
	// package.json files (rust/wasm/README.md, "Publish checklist").
	test.skip("the pinned npm spec matches the Rust source version", () => {
		for (const path of [
			resolve(REPO_ROOT, "package.json"),
			resolve(WEB_ROOT, "package.json"),
		]) {
			const pinned = normalizePinVersion(readPinnedSpec(path));
			if (pinned !== cargoVersion) {
				throw new Error(
					`${path} pins opencut-wasm@${pinned} but rust/wasm/Cargo.toml declares ${cargoVersion}. ` +
						`Any fresh \`bun install\` restores the published ${pinned} build, which predates the ` +
						`current shaders — the stale-shadow defect. If ${cargoVersion} is already published, ` +
						`repin both package.json files to it; if not, this failure is the publish reminder ` +
						`(rust/wasm/README.md, "Publish checklist").`,
				);
			}
		}
	});
});
