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
| `apps/web/src/timeline/components/timeline-toolbar.tsx` | Toolbar toggle button for video-clip waveforms (next to snapping/ripple); RUN HYPERFRAMES button; Close Gaps button | 2026-06-11 | Trivial |
| `apps/web/src/actions/use-editor-actions.ts` | Delete with empty selection now closes the main-track gap under the playhead (CloseGapsCommand at-time) | 2026-06-11 | Generic timeline UX — candidate for upstreaming to the rewrite |
| `apps/web/src/components/editor/panels/properties/registry.tsx` | Registered "HyperFrames" properties tab (template swap/content edit) for AI-generated video elements; default tab when `framecutAi` present | 2026-06-11 | Tab content lives in `features/ai-generate/` |
| `apps/web/src/components/editor/panels/assets/views/assets.tsx` | Bin upgrades: Delete-key removes selected assets; Assemble button; "Convert for editing" context item (local ffmpeg transcode); "No preview" badge for undecodable videos; plus-button insert now routes via `features/editing/insert-media` (auto audio separation) | 2026-06-11 | Several small hooks; feature logic lives in `features/editing/` |
| `apps/web/src/media/processing.ts`, `services/storage/{types.ts,service.ts}` | Persist `canDecode`/`codec` on media assets; FIX upstream bug: `hasAudio`/`fps` were never saved in metadata (lost on reload); request `navigator.storage.persist()` so OPFS media can't be evicted | 2026-06-11 | The hasAudio/fps fix is upstream-worthy |
| `apps/web/src/core/managers/renderer-manager.ts` | `exportProject` accepts optional `sceneTracks` (renders a non-active scene — powers nested sequences) | 2026-06-11 | Small parametrization, upstream-worthy |
| `apps/web/src/components/editor/scenes-view.tsx` | "Nest" button per scene row (renders scene → clip at playhead via `features/editing/nest-scene`); "Add scene" button | 2026-06-11 | UI hook only |
| `apps/web/src/services/renderer/scene-builder.ts` | Exclude `framecutAi` video elements from the render tree (WebCodecs can't decode their VP9 alpha → they composited as opaque black). Preview shows them via DOM `<video>` layer; exports burn them in with local ffmpeg | 2026-06-11 | CRITICAL: any future base must handle alpha overlays |
| `apps/web/src/preview/components/index.tsx` | Mounted `AiOverlayPreviewLayer` (DOM video layer, playhead-synced) over the preview canvas | 2026-06-11 | One sibling div |
| `apps/web/src/components/editor/export-button.tsx` | Export now composites AI overlays via `/api/media/composite` before download (forces mp4 when burned) | 2026-06-11 | Wiring only; logic in `features/ai-generate/composite-export.ts` |
| `apps/web/src/actions/{definitions.ts,keybinding.ts}` | New actions `timeline-zoom-in`/`-out` with default keys `=`/`+`/`-` (added `- = +` to the key set); handled in timeline-toolbar | 2026-06-11 | Upstream-worthy |
| `apps/web/src/actions/{definitions.ts,keybinding.ts}` + timeline-toolbar | New action `timeline-zoom-fit` bound to `\` (zoom out to fit the whole timeline = minZoom) | 2026-06-11 | Upstream-worthy |
| `apps/web/src/timeline/{zoom-utils.ts,components/index.tsx,components/timeline-toolbar.tsx}` | `\` fit now uses new `getTimelineZoomFit` (content fills 95% of viewport) instead of minZoom (which keeps 75% padding) | 2026-06-12 | Small util + prop |
| `apps/web/src/timeline/{controllers/drag-drop-controller.ts,hooks/use-timeline-drag-drop.ts}` | Drag-drop video inserts now separate source audio onto an audio track (insertAtTarget returns ids; new optional `separateSourceAudio` config hook) | 2026-06-12 | Mirrors features/editing/insert-media behavior |
| `apps/web/src/timeline/components/timeline-element.tsx` | Clip context menu gains "Nest selection..." and "Remove attributes" submenu (Motion/Opacity/Audio/All keyframes/Everything → `features/editing/remove-attributes.ts`) | 2026-06-12 | Two menu blocks |
| `apps/web/src/preview/components/{index.tsx,toolbar.tsx}` | Text/Shape place tools: T button in preview toolbar + click-capture overlay (`place-tool-overlay.tsx`, ours) that drops text/shapes at the clicked canvas position | 2026-06-12 | One mount + one button |
| `apps/web/src/components/editor/panels/assets/{assets-panel-store.tsx,index.tsx}` | Stickers tab replaced by Shapes tab (graphics rectangle/ellipse/polygon/star; view in `graphics/components/assets-view.tsx`, ours). Stickers code remains, just unrouted | 2026-06-12 | Tab swap only — revert = swap back |
| `apps/web/src/effects/components/assets-view.tsx` | (2026-06-12 PM: reverted — browser moved to the HyperFrames tab; Effects shows effects only) | 2026-06-12 | — |
| `apps/web/src/components/editor/panels/assets/{index.tsx,assets-panel-store.tsx,views/base-panel.tsx}` | Panel maximize: ` action + double-click panel header → assets panel fills the screen (fixed inset-2 z-50), Esc restores | 2026-06-12 | Premiere parity |
| `apps/web/src/actions/{definitions.ts,keybinding.ts}` | New action `toggle-panel-maximize` bound to `` ` `` (added to key set) | 2026-06-12 | Upstream-worthy |
| `apps/web/src/components/editor/panels/properties/components/property-param-field.tsx` | Number params without a shortLabel now get a default "↔" scrub handle — font size & every panel number becomes click-drag adjustable | 2026-06-12 | One-line default |
| `apps/web/src/preview/components/toolbar.tsx` + `graphics/definitions/index.ts` | Pen/shape tool button next to the Text tool (click = pen, hold = shape flyout); registers new `custom-path` graphic definition (`definitions/path.ts`, ours: pen-drawn polygon with Feather + Expand) | 2026-06-12 | One button + one registration |
| `apps/web/src/components/editor/panels/properties/components/property-param-field.tsx` | Premiere-style controls: selects with ≤4 options render as segmented buttons (textAlign etc.); font param renders a common-system-fonts dropdown; fontSize gets ▲/▼ steppers | 2026-06-11 | Pure control-rendering changes |
| `apps/web/src/components/editor/panels/properties/registry.tsx` | Transform tab now renders the Premiere-style `EffectControlsTab` (fx Motion/Opacity groups, paired Position, Uniform Scale, blue scrub values) instead of the flat param list | 2026-06-11 | New tab component is ours (`effect-controls-tab.tsx`); revert = point back to ElementParamsTab |
| `apps/web/src/commands/timeline/track/remove-ranges.ts` (new, ours) + timeline-toolbar hooks | RemoveRangesCommand: cut time ranges across all tracks (split straddlers, ripple left) — powers Remove Silences/Repeats/Autocut (`features/editing/`); toolbar gains AI CUT menu + Nest-selection button | 2026-06-11 | Command is upstream-worthy |
| `apps/web/src/timeline/types.ts` | Added optional `framecutAi` metadata to `VideoElement` (compId/templateId/variables/groupId) — links AI clips to their comp source for re-render and template swap | 2026-06-11 | Core data-model addition; must be carried to any future base |
| `apps/web/src/app/layout.tsx` | React Scan dev overlay now opt-in via `NEXT_PUBLIC_REACT_SCAN=1` (was always-on in dev; confused non-dev use of the dev server) | 2026-06-11 | Trivial |
| `site/brand.ts`, `app/metadata.ts`, `components/header.tsx`, `components/landing/hero.tsx`, `components/editor/{mobile-gate,onboarding}.tsx`, `services/storage/components/storage-persistence-dialog.tsx`, `auth/server.ts` | VibeCut rebrand: visible "OpenCut" strings → "VibeCut" (upstream-history pages like changelog/contributors left untouched) | 2026-06-11 | String-only |
| `apps/web/src/components/editor/panels/assets/views/settings/index.tsx` | Registered "AI" tab in the settings panel; content lives in `features/ai-generate/` | 2026-06-11 | 4-line hook-in; re-register against whatever settings UI the rewrite ships |
| `apps/web/src/components/editor/panels/assets/{assets-panel-store.tsx,index.tsx}` | Registered "HyperFrames" left-panel tab (template browser with demo previews + checkboxes that constrain the planner); content in `features/ai-generate/components/hyperframes-panel.tsx` | 2026-06-11 | Two small hook-ins |
| `apps/web/next.config.ts` | Added `transpilePackages: ["@framecut/hf-bridge"]` + `serverExternalPackages: ["hyperframes"]` (CLI is resolved at runtime, must not be bundled) | 2026-06-11 | Two lines |
| `apps/web/package.json` | Added `@framecut/hf-bridge: workspace:*` dependency | 2026-06-11 | One line |
