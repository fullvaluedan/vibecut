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

cd rust/wasm/pkg
bun link

# Back at the repo root, NOT in apps/web (see "Windows notes" below)
cd ../../..
bun link opencut-wasm
```

Confirm the link took: `node_modules/opencut-wasm` should be a symlink into
`rust/wasm/pkg`, and its `package.json` should show the version you just built.

While you work, rebuild on changes from the repo root:

```bash
bun dev:wasm
```

To go back to the published package, run `bun install` from the repo root.

### Windows notes (2026-08-02, round 19 T19.0)

Three things in the loop above do not work as written on Dan's Windows box:

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

2. **`bun link opencut-wasm` must be run from the repo root, not `apps/web`.**
   From `apps/web` it fails with `Workspace dependency "@framecut/hf-bridge" not
   found`: bun treats the package directory as the workspace root and cannot
   resolve the sibling workspace packages. From the repo root it links into the
   hoisted `node_modules/opencut-wasm`, which is where `apps/web` resolves it.

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
5. Repin the web app: set `opencut-wasm` in `apps/web/package.json` to the
   published version, then from the repo root:
   ```bash
   bun install           # drops the local link, installs from npm
   ```
6. Re-verify against the published package, not the link:
   ```bash
   cd apps/web && bun test && bunx tsc --noEmit
   cd ../.. && bun run build:web
   ```
7. If the new build changes rendering behaviour behind a flag (as 0.3.0 does for
   mask expansion/opacity via `MASK_EXPANSION_OPACITY_RENDERED`), confirm the
   flag matches the version now pinned.
