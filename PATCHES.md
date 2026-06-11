# PATCHES.md — modified upstream files

Every change to a file that originally came from `OpenCut-app/opencut-classic` is logged here, in the same commit that makes the change (Hard rule 1 in `docs/BRIEF.md`).

**Upstream status:** `opencut-classic` was archived (read-only) on GitHub on 2026-05-17. No upstream merges will ever arrive, so these entries carry no live merge risk. The log is kept anyway: it is the map of what would need re-checking if FrameCut features are ever ported onto the OpenCut rewrite (`OpenCut-app/OpenCut`).

| File | Reason | Date | Notes for a future port |
|---|---|---|---|
| `apps/web/src/actions/keybinding.ts` | Archived main didn't build: added missing `isShortcutKey` guard + `MODIFIERS` set (incomplete upstream refactor) | 2026-06-11 | Rewrite likely restructures actions entirely; re-derive, don't copy |
| `apps/web/src/actions/definitions.ts` | Added missing `isAction` / `isActionWithOptionalArgs` guards (same incomplete refactor) | 2026-06-11 | Same as above |
| `apps/web/src/services/storage/migrations/runner.ts` | Fixed `IndexedDBAdapter` constructor calls to object-param form `{dbName, storeName, version}` | 2026-06-11 | Storage layer may be Rust-side in rewrite |
| `apps/web/src/services/storage/migrations/v1-to-v2.ts` | Fixed `.set()` calls to object-param form `{key, value}` | 2026-06-11 | Same as above |
| `apps/web/src/stickers/providers/index.ts` | Fixed `stickersRegistry.register({key, definition})` call shape | 2026-06-11 | — |
| `apps/web/tsconfig.json` | Excluded test files from build typecheck (upstream tests didn't compile) | 2026-06-11 | Revisit if we start running their tests |
| `.dockerignore` | Added nested `**/node_modules`, `**/.next` so local build artifacts don't contaminate the Docker image | 2026-06-11 | Safe to keep anywhere |
| `docker-compose.yml` | Fixed `web` healthcheck: `curl` doesn't exist in `oven/bun:alpine` and `localhost` resolved to IPv6; now `wget` against `http://127.0.0.1:3000/api/health` | 2026-06-11 | Cosmetic — app worked, `docker ps` just showed unhealthy |

All eight patches were authored and build-validated (`bun run build:web` exit 0) during the 2026-06-07 local bring-up of opencut-classic, and committed to this fork on 2026-06-11.

## Feature patches (FrameCut functionality on upstream files)

| File | Reason | Date | Notes for a future port |
|---|---|---|---|
| `apps/web/src/timeline/timeline-store.ts` | Added `videoWaveformsEnabled` flag (default true) + toggle, persisted | 2026-06-11 | Plain zustand UI flag; trivial to re-add |
| `apps/web/src/timeline/components/timeline-element.tsx` | `TiledMediaContent` renders an `AudioWaveform` strip on the bottom 40% of video clips with source audio (reuses audio-clip waveform infra + cache) | 2026-06-11 | Core feature; reimplement against whatever clip renderer the rewrite ships |
| `apps/web/src/timeline/components/timeline-toolbar.tsx` | Toolbar toggle button for video-clip waveforms (next to snapping/ripple) | 2026-06-11 | Trivial |
| `apps/web/src/components/editor/panels/assets/views/settings/index.tsx` | Registered "AI" tab in the settings panel; content lives in `features/ai-generate/` | 2026-06-11 | 4-line hook-in; re-register against whatever settings UI the rewrite ships |
| `apps/web/next.config.ts` | Added `transpilePackages: ["@framecut/hf-bridge"]` + `serverExternalPackages: ["hyperframes"]` (CLI is resolved at runtime, must not be bundled) | 2026-06-11 | Two lines |
| `apps/web/package.json` | Added `@framecut/hf-bridge: workspace:*` dependency | 2026-06-11 | One line |
