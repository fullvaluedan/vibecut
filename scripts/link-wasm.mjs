/**
 * Links the locally-built `rust/wasm/pkg` into every `node_modules` location
 * where `opencut-wasm` can resolve from, replacing the published npm copy.
 *
 * Why this exists: `apps/web/node_modules/opencut-wasm` is a REAL directory
 * installed from npm, and Node resolution checks it BEFORE the hoisted root
 * `node_modules/opencut-wasm`. So the `bun link opencut-wasm` flow documented
 * upstream links the root copy while `apps/web` keeps loading the stale
 * published build. This script replaces BOTH copies with junctions (Windows)
 * or symlinks (elsewhere) pointing at `rust/wasm/pkg`.
 *
 * Usage:
 *   bun run link:wasm                 # link; fails if rust/wasm/pkg is missing
 *   bun run link:wasm -- --if-built   # no-op (exit 0) when pkg is missing;
 *                                     # wired as the root "postinstall" so the
 *                                     # link survives every `bun install`
 *
 * Idempotent: an existing correct junction is left alone. A stray
 * `opencut-wasm.npm-*-backup` directory next to it is never touched.
 */
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(repoRoot, "rust/wasm/pkg");
const ifBuilt = process.argv.includes("--if-built");

const linkPaths = [
	resolve(repoRoot, "node_modules/opencut-wasm"),
	resolve(repoRoot, "apps/web/node_modules/opencut-wasm"),
];

if (!existsSync(target)) {
	if (ifBuilt) {
		process.exit(0);
	}
	console.error(
		"rust/wasm/pkg does not exist. Build it first (Windows: prefix RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu):\n" +
			"  bun run build:wasm",
	);
	process.exit(1);
}

for (const linkPath of linkPaths) {
	if (existsSync(linkPath) || isSymlink(linkPath)) {
		if (isSymlink(linkPath) && realpathSync(linkPath) === realpathSync(target)) {
			console.log(`ok (already linked): ${linkPath}`);
			continue;
		}
		// Real directory from npm, or a stale/wrong link: remove without
		// following it, then re-create.
		rmSync(linkPath, { recursive: true, force: true });
	}
	mkdirSync(dirname(linkPath), { recursive: true });
	// "junction" needs no admin rights on Windows and is ignored on other
	// platforms, where a plain directory symlink is created.
	symlinkSync(target, linkPath, "junction");
	console.log(`linked: ${linkPath} -> ${target}`);
}

const linkedVersion = JSON.parse(
	readFileSync(resolve(linkPaths[1], "package.json"), "utf8"),
).version;
console.log(`opencut-wasm@${linkedVersion} is now linked into apps/web.`);

function isSymlink(path) {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}
