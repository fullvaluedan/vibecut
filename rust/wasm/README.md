# opencut-wasm

Shared video editor logic compiled to WebAssembly. Used by the [OpenCut](https://github.com/opencut/opencut) web app.

## Install

```bash
npm install opencut-wasm
```

## Usage

```ts
import { formatTimecode, mediaTimeFromSeconds } from "opencut-wasm";

const ticks = mediaTimeFromSeconds(1.5);
const label = formatTimecode({ ticks });
```

All exports are documented in the [TypeScript definitions](./opencut_wasm.d.ts).

## Source

Functions are implemented in Rust under [`rust/crates/`](../crates/). This package is the compiled WebAssembly output — do not edit it directly.

## Local development

The web app depends on the published `opencut-wasm` package by default. If you are editing the WASM source in this repo and want `apps/web` to use your local build instead:

```bash
# From the repo root
bun run build:wasm
bun run link:wasm
```

`bun run link:wasm` (scripts/link-wasm.mjs) replaces the installed
`opencut-wasm` with a junction/symlink into `rust/wasm/pkg` in BOTH places it
can resolve from — the hoisted root `node_modules/opencut-wasm` AND
`apps/web/node_modules/opencut-wasm`. The second one is the trap: it is a real
directory installed from npm, Node resolution checks it first, and it SHADOWS
the root-level link that `bun link opencut-wasm` creates. Do not use
`bun link` for this repo layout; it only fixes the root copy.

The link survives `bun install`: the root `postinstall` re-runs the script
with `--if-built`, which re-links whenever `rust/wasm/pkg` exists and is a
silent no-op on a fresh checkout (where it does not). The script is idempotent
and never touches an `opencut-wasm.npm-*-backup` directory.

Confirm the link took: `apps/web/node_modules/opencut-wasm/package.json`
should show the version you just built. The app also guards this at runtime:
a stale build shows a banner at the top of the editor naming the missing
shaders and this fix (see `apps/web/src/services/renderer/wasm-capabilities.ts`).

While you work, rebuild on changes from the repo root:

```bash
bun dev:wasm
```

To go back to the published package, run `bun install` from the repo root after
deleting `rust/wasm/pkg` (otherwise the postinstall re-links it).

### Windows notes (2026-08-02, round 19 T19.0; item 2 revised 2026-08-03)

Three deviations found running the documented loop on Dan's Windows box:

1. **`bun run build:wasm` fails with `linker 'link.exe' not found`** under the
   default `stable-x86_64-pc-windows-msvc` toolchain, because no Visual Studio
   C++ build tools are installed. The already-installed
   `stable-x86_64-pc-windows-gnu` toolchain builds it fine (the wasm32 target
   links with the bundled LLD, and the GNU host toolchain builds the proc-macro
   crates). Prefix the command:

   ```powershell
   $env:RUSTUP_TOOLCHAIN = "stable-x86_64-pc-windows-gnu"
   bun run build:wasm
   ```

2. **`bun link opencut-wasm` is not sufficient on this repo layout** — it only
   links the hoisted root `node_modules/opencut-wasm`, while
   `apps/web/node_modules/opencut-wasm` stays a real npm directory and shadows
   it. Use `bun run link:wasm` (above) instead, which replaces both. (It also
   must not be run from `apps/web`: bun treats the package directory as the
   workspace root and fails with `Workspace dependency "@framecut/hf-bridge"
   not found`.)

3. **`cargo test` cannot run at all on this box, for any crate.** The MSVC
   linker is missing, and rustup's bundled MinGW has no GNU assembler, so
   `dlltool` cannot build the Windows import libraries. Run the Rust tests
   through the wasm harness instead, which links with LLD and executes in node:

   ```powershell
   $env:RUSTUP_TOOLCHAIN = "stable-x86_64-pc-windows-gnu"
   wasm-pack test --node rust/crates/effects
   ```

   Crates whose tests should run this way declare `wasm-bindgen-test` under
   `[target.'cfg(target_arch = "wasm32")'.dev-dependencies]` and alias it over
   `#[test]` in their test module (see `rust/crates/effects/src/pipeline.rs`).
   Installing the Visual Studio Build Tools with the "Desktop development with
   C++" workload would restore plain `cargo test`; nothing in the repo needs it
   otherwise.

## Publish checklist

Publishing needs Dan's npm auth, so it is always a manual step. Until it runs,
development rides on the local link above.

1. Land every Rust change and confirm the version bump in `rust/wasm/Cargo.toml`
   is what you mean to publish (the package version is generated from it).
2. From the repo root, with the toolchain override above if on Windows:
   ```bash
   bun run build:wasm
   wasm-pack test --node rust/crates/effects
   ```
3. Verify `rust/wasm/pkg/package.json` shows the new version.
4. Publish:
   ```bash
   npm whoami            # confirm you are logged in
   bun run publish:wasm  # builds again, then npm publish rust/wasm/pkg --access public
   ```
5. Repin the web app: set `opencut-wasm` in BOTH `package.json` (repo root)
   and `apps/web/package.json` to the published version, then from the repo
   root:
   ```bash
   rm -rf rust/wasm/pkg   # otherwise the postinstall re-links the local build
   bun install            # drops the local link, installs from npm
   ```
   The version-guard test
   (`apps/web/src/services/renderer/__tests__/wasm-version.test.ts`) fails
   loudly until this repin lands — that red is the publish reminder, not a
   regression.
6. Re-verify against the published package, not the link:
   ```bash
   cd apps/web && bun test && bunx tsc --noEmit
   cd ../.. && bun run build:web
   ```
7. If the new build changes rendering behaviour behind a flag (as 0.3.0 does for
   mask expansion/opacity via `MASK_EXPANSION_OPACITY_RENDERED`), confirm the
   flag matches the version now pinned.
