---
title: "fix: Editor interaction, cursor-feedback, correctness & a11y sweep"
type: fix
date: 2026-06-18
status: planned
branch_base: feat/director-dupword
origin: multi-agent editor audit (workflow audit-editor-issues, 2026-06-18) — 10 confirmed bugs, 40 improvements, 1 dismissed
---

# fix: Editor interaction, cursor-feedback, correctness & a11y sweep

## Summary

A 6-dimension adversarial audit of the editor (anchored by the reported "text corner-resize shows no diagonal cursor" bug) surfaced **10 verified bugs and 40 concrete improvements**. This plan groups them into prioritized, phased fix units.

The reported cursor bug is **not** a broken cursor pipeline — that works correctly while an element is *selected*. It is the visible tip of two real gaps: (a) placing/editing text drops you into a modal text-edit state where transform handles are intentionally hidden **with no signal** that you must exit to resize, and (b) a **systemic cursor-affordance deficiency** — the canvas, timeline clips, and active tools never change the cursor to advertise that they're grabbable. Both are addressed here, alongside two session-affecting correctness bugs (a preview freeze and a properties-panel data corruption), a cluster of keyboard-shortcut defects, an accessibility pass, and visual/error-edge hardening.

Priority is encoded in the phases: **Phase A (correctness) ships first**, **Phase B (cursor feedback)** directly answers the report, then **C (a11y)** and **D (polish + edge)**.

---

## Problem Frame

The editor's *mechanics* are largely solid (snapping, group-move, trim bounds, keyframes, the render tree). The defects cluster in **feedback, state hygiene, and edge handling**:

- **Two session-level correctness bugs.** An undecodable clip (e.g. HEVC) rejecting a frame render permanently freezes the preview (a missing `.catch` never resets the in-flight guard), and switching the selected element carries the *previous* element's panel form values forward — silently corrupting a template group when you edit it.
- **Cursor/affordance feedback is missing across the board.** This is the user's report generalized: the preview canvas shows no move/text cursor over elements, timeline clips show no grab cursor (idle or mid-drag), the forward-select tool gives no track cursor, and — the literal report — a just-placed/edited text element hides its handles with no hint that you must click away to resize.
- **Global shortcuts over-reach.** Bare keys hijack native Space/Enter activation of focused controls, `Ctrl+C` blocks native copy of page text, `Ctrl+R` eats browser reload, held keys auto-repeat one-shot edits, and the Shortcuts UI mis-renders the zoom-out (`-`) binding as empty chips.
- **Accessibility gaps.** Icon-only controls lack accessible names, toggles lack `aria-pressed`, the ruler advertises `role="slider"` but reports a frozen `aria-valuenow=0`, and clips can't be nudged by keyboard.
- **Visual + error-edge rough edges.** A static theme icon, padding-less dialogs, dead/no-op menu items, an export that prompts for a save location before noticing the project is empty, a non-finite audio-duration path, and the Director mutating the timeline *before* the review modal opens with no one-undo rollback on cancel.

The audit verified each bug against committed code (1 finder claim was dismissed as intended modal UX) and refined the fixes; this plan carries the verified locations forward.

---

## Requirements

- **R1** — A failed/undecodable frame render never permanently freezes the preview, and the asset bin visibly warns on undecodable media.
- **R2** — Switching the selected element never carries the previous element's panel state forward (no silent corruption); a true multi-selection shows its scope.
- **R3** — Global shortcuts never suppress native activation/copy/reload of focused controls or page text selections; one-shot actions fire once per physical press; the Shortcuts UI renders every binding correctly.
- **R4** — Interactive surfaces (canvas elements, timeline clips, active tools) signal their affordance via the cursor, both idle and during a gesture.
- **R5** — Resizing is reachable and signaled for text (including just-placed/edit-mode), and transform handles stay grabbable at the viewport edge and on narrow clips.
- **R6** — Icon-only controls have accessible names; toggles expose pressed state; the ruler reports a real value (or drops the slider role); selected clips are keyboard-nudgeable.
- **R7** — Visible state matches reality (theme icon, state-dependent icons, dialog padding); dead/no-op controls are removed or disabled.
- **R8** — Edge inputs are guarded and clearly surfaced (empty export, non-finite media duration, zero-import), and the Director's pre-review timeline mutation is reversible in one step.

---

## High-Level Technical Design

The ~50 findings collapse into 8 units across 4 priority phases. This matrix maps clusters → unit, with severity:

| Phase | Unit | Cluster (verified findings) | Top severity |
|---|---|---|---|
| **A — Correctness** | U1 | Preview freeze on rejected render + undecodable-media badge + negative-cache re-probe | **High** |
| | U2 | Properties panel stale local state across selections (template corruption, uniform-scale leak, fx-collapse) + multi-select indicator | **High** |
| | U3 | Shortcut over-reach: copy-selected / native activation / Ctrl+R / ev.repeat / IME guards + zoom-out display fix | Medium |
| **B — Cursor feedback** | U4 | Cursor affordances: canvas hover, clip grab (idle + drag/resize), forward-tool, clip hover | **High** (clip grab) |
| | U5 | Text-edit resize discoverability (the anchor) + rotation-handle viewport clip + narrow-clip handle overlap | Medium |
| **C — Accessibility** | U6 | Icon-button labels, toggle `aria-pressed`, ruler slider, Director modal a11y, keyboard clip-nudge | Medium |
| **D — Polish + edge** | U7 | Visual/dead-code: theme icon, dialog padding, state icons, dead menu items, tailwind typo, tooltip child, font picker | Medium |
| | U8 | Error/edge: empty-export guard, audio finite-duration, zero-import toast, Director pre-review atomicity/rollback | Medium |

Phases are a **priority order**, not a schedule — A is must-fix, D is nice-to-have. Units within a phase are independent and can land in any order.

---

## Key Technical Decisions

- **KTD-1: Reset the render in-flight guard in `.finally`, and negatively cache undecodable media.** The freeze is a missing-`.catch` on the render promise; the fix is `.catch(log).finally(() => renderingRef = false)` plus a `try/catch→return null` in `resolveVideoNode` and a "this mediaId can't decode" set in `VideoCache` so it stops re-probing+re-throwing per frame.
- **KTD-2: Key the properties tab subtree by `element.id`.** The root cause of the template-corruption, uniform-scale-leak, and fx-collapse-leak bugs is local component state seeded once via `useState` while React reuses the instance across selections. One `key={element.id}` on the rendered tab content remounts the subtree and re-seeds all of it — the minimal, broadest fix. (Drop the dead `isTransformScaleLocked` store fields rather than wiring them.)
- **KTD-3: Guard shortcuts on native interactivity, not just typability.** Add an `isInteractiveDOMElement` predicate (button / a[href] / select / [role] / focusable) and, for bare (no-modifier) keys, return *before* `preventDefault` when a native control is focused — so native Space/Enter/type-ahead survive. Mirror the existing `paste-copied` empty-guard for `copy-selected`, and gate `Ctrl+R` / `open-speed-panel`'s `preventDefault` on there being a selection.
- **KTD-4: Drive cursors from the existing hit-test + a global gesture cursor.** Canvas hover reuses the controller's hit-test to set `move`/`text`; timeline clips get a `cursor-grab` class; active drag/resize sets `document.body.style.cursor` (+ `userSelect:none`) for the gesture duration and restores it on finish — which also fixes the mid-drag cursor flicker.
- **KTD-5: The text-resize fix is gated on a live repro.** Static analysis can't reproduce the exact report; the likely cause is auto-entering edit mode on text placement. Resolve the precise repro first (Execution note on U5), then choose between *place→select-not-edit* and *signal edit mode + how to exit*. Do not blindly "show handles during edit" — the audit confirmed handle-hiding during caret edit is the intended modal pattern.
- **KTD-6: Fold low-value nits into the nearest unit; defer the genuinely marginal.** Items with no user-visible payoff today (deprecated `navigator.platform`, Escape double-handling) go to Scope Boundaries, not active units.

---

## Implementation Units

### Phase A — Correctness (ship first)

### U1. Preview never freezes on undecodable / failed frames

**Goal:** a rejected frame render recovers cleanly, undecodable media stops re-probing, and the bin warns the user.
**Requirements:** R1.
**Files:** `apps/web/src/preview/components/index.tsx` (render useCallback), `apps/web/src/services/renderer/resolve.ts` (resolveVideoNode), `apps/web/src/services/video-cache/service.ts` (ensureSink / negative cache), `apps/web/src/components/editor/panels/assets/views/assets.tsx` (MediaPreview badge); test: `apps/web/src/preview/__tests__/render-guard.test.ts` (new) or the nearest existing renderer test.
**Approach:** add `.catch(log).finally(() => { renderingRef.current = false; })` to the render promise (the essential fix — the guard currently only resets in `.then`); wrap `resolveVideoNode`'s `getFrameAt` in `try/catch → return null`; record undecodable `mediaId`s in a set in `VideoCache` so `ensureSink`/`getFrameAt` short-circuit to `null` instead of re-creating the mediabunny `Input` and re-throwing every frame; move the `canDecode === false` "No preview" badge out of the `thumbnailUrl` branch so it renders over the placeholder tile (undecodable clips have no thumbnail by definition).
**Execution note:** characterization-first for the guard reset — assert the freeze repro before fixing.
**Patterns to follow:** the existing defensive `try/catch → return null` in the cache's seek paths (`seekToTime`/`iterateToTime`).
**Test scenarios:**
- A render whose frame resolve rejects resets `renderingRef` to false (next frame renders) — stub the renderer to reject once.
- A second `getFrameAt` for a known-undecodable mediaId returns null without re-invoking sink init (spy the init).
- `MediaPreview` for `{ type: "video", canDecode: false, thumbnailUrl: null }` renders the "No preview" warning, not a plain "Video" tile.
**Verification:** dragging an HEVC clip onto the timeline no longer bricks the preview; the bin tile shows the warning; deleting the clip recovers playback.

### U2. Properties panel state hygiene across selections

**Goal:** selecting a different element never shows or applies the previous element's form values; multi-selection scope is visible.
**Requirements:** R2.
**Files:** `apps/web/src/components/editor/panels/properties/index.tsx` (key the tab content), `apps/web/src/components/editor/panels/properties/stores/properties-store.ts` (drop dead `isTransformScaleLocked`); behavior spans `template-controls-tab.tsx`, `effect-controls-tab.tsx` (ScaleRows, FxGroup) via the remount.
**Approach:** wrap the rendered tab content (`activeTab.content(...)`) in `<div key={element.id} className="contents">` so React remounts the subtree on selection change, re-running every `useState` initializer (re-seeds Template Controls variables/duration/scale, the Uniform-Scale checkbox, and FxGroup collapse). Add a compact "N elements selected — editing <name>" header when the selection is a genuine multi-select (not a linked V/A pair or single template group). Remove the unused `isTransformScaleLocked`/setter store fields (ScaleRows uses local state; the global lock is dead).
**Execution note:** the corruption path (edit a template after switching groups) is the highest-value live check.
**Patterns to follow:** the existing `key={tab.id}` on the tab buttons; the linked-V/A representative logic already in `PropertiesPanel`.
**Test scenarios:**
- `Test expectation: live-verify` — select template group A, switch to group B (same type), confirm B's fields show B's values and editing B does not corrupt it with A's values.
- Multi-select two unrelated clips → the "N selected" header renders; a single selection / linked pair does not.
- Grep confirms `isTransformScaleLocked` has no remaining references after removal.
**Verification:** every panel field reflects the currently selected element; a template group edited after a switch keeps its own content.

### U3. Keyboard-shortcut correctness & native-affordance guards

**Goal:** global shortcuts stop hijacking native browser/control behavior; one-shot actions fire once; the Shortcuts UI renders correctly.
**Requirements:** R3.
**Files:** `apps/web/src/actions/use-keybindings.ts`, `apps/web/src/utils/browser.ts` (new `isInteractiveDOMElement`), `apps/web/src/actions/use-keyboard-shortcuts-help.ts` (formatKey), `apps/web/src/actions/components/shortcuts-dialog.tsx` (empty-chip guard), `apps/web/src/actions/definitions.ts` (bare-`enter` review); tests: `apps/web/src/actions/__tests__/keybinding-guards.test.ts` (new), extend the shortcuts-help test if present.
**Approach:** add `isInteractiveDOMElement(el)` (matches `button, a[href], select, [role="button"|"menuitem"|"option"], [contenteditable], [tabindex]:not([tabindex="-1"])`); in the capture-phase handler, for a **no-modifier** binding when a native interactive element is focused, return without `preventDefault` so native Space/Enter/type-ahead runs. Mirror the `paste-copied` guard for `copy-selected`: bail before `preventDefault` when there's no timeline selection (let native copy run). Gate `open-speed-panel` (`ctrl+r`) `preventDefault` on a selection existing. Add `if (ev.isComposing || ev.keyCode === 229) return;` and an `ev.repeat` opt-out for one-shot/toggle actions (keep repeat for seek/frame-step). Fix `formatKey`: drop the bogus `.replace("-", "+")` (combos already use `+` as separator) so zoom-out displays as `-`, and filter empty parts in `ShortcutItem`'s `split("+")`.
**Execution note:** test-first for the pure predicates (`isInteractiveDOMElement`, `formatKey`) and the copy/repeat guard decisions — extract the decision as a pure helper where the handler currently inlines it.
**Patterns to follow:** the existing `isTypableDOMElement` guard and the `paste-copied` empty-bail in the same handler.
**Test scenarios:**
- `formatKey({key:"-"})` returns `"-"` (not `"+"`); `ShortcutItem` renders one chip for zoom-out, none empty.
- `isInteractiveDOMElement` is true for `<button>`, `<a href>`, `<select>`, `[role=button]`; false for a plain `<div>`.
- The copy decision: no timeline selection → "let native copy" (no preventDefault); with selection → editor copy.
- `ev.repeat` true on a one-shot action → skipped; on seek-forward → allowed.
**Verification:** Space/Enter activate a focused toolbar button; Ctrl+C copies selected page text when nothing is selected on the timeline; Ctrl+R reloads when nothing is selected; the Shortcuts dialog shows a single correct zoom-out chip.

---

### Phase B — Cursor & interaction feedback (answers the report)

### U4. Cursor affordances across canvas and timeline

**Goal:** every grabbable surface advertises itself with a cursor, idle and during the gesture.
**Requirements:** R4.
**Files:** `apps/web/src/preview/components/preview-interaction-overlay.tsx` + `apps/web/src/preview/controllers/preview-interaction-controller.ts` (canvas hover cursor), `apps/web/src/timeline/components/timeline-element.tsx` (clip body `cursor-grab` + hover), `apps/web/src/timeline/controllers/element-interaction-controller.ts` + `resize-controller.ts` (global gesture cursor), `apps/web/src/timeline/components/timeline-track.tsx` (forward-tool cursor).
**Approach:** on canvas pointer-move (no active gesture), hit-test the elements and set the overlay cursor to `move` over a selectable element and `text` over a text element (hinting double-click-to-edit), default over empty canvas — reuses the controller's existing hit-test. Add `cursor-grab` to the timeline clip-body button and a faint `hover:` treatment distinct from the selection ring. On drag/resize start set `document.body.style.cursor` (`grabbing` / `ew-resize`) and `userSelect:none`, restoring both on finish (also kills the mid-drag flicker when the pointer leaves the clip). When the forward-select tool is active, give the track surface a distinguishing cursor.
**Execution note:** pure-visual; verify live across canvas + timeline.
**Patterns to follow:** the keyframe/bezier `cursor-grab`/`grabbing` usage; `MaskHandles` passing cursors; the pan cursor already set in the interaction overlay.
**Test scenarios:** `Test expectation: live-verify` — hovering a canvas element shows `move` (text shows `text`); hovering a clip shows `grab`; dragging shows `grabbing` throughout (no flicker); the forward tool changes the track cursor.
**Verification:** the preview and timeline visibly signal grabbability everywhere a gesture is possible.

### U5. Text-resize discoverability + transform-handle geometry

**Goal:** resizing is reachable and signaled for text (the anchor report), and handles stay grabbable at the viewport edge and on narrow clips.
**Requirements:** R5.
**Files:** `apps/web/src/preview/components/preview-interaction-overlay.tsx` + `text-edit-overlay.tsx` + `preview/controllers/preview-interaction-controller.ts` (edit-mode entry/signal), `apps/web/src/preview/components/index.tsx` + `transform-handles.tsx` + `mask-handles.tsx` (un-clip handle layer), `apps/web/src/timeline/components/timeline-element.tsx` (ResizeHandle narrow-clip guard).
**Approach (anchor — gated, KTD-5):** first reproduce the report live to confirm whether text-tool placement auto-enters edit mode (handles hidden). Then either (a) place text into the *selected* (handles-visible) state with double-click to edit, or (b) add a clear edit-mode affordance — a visible editing ring + a "Esc / click away to resize" hint — and a `text` cursor already covered by U4. Do **not** force handles to render during caret edit (intended modal pattern per the audit). **Handle clipping:** the rotation handle sits 24px above the element and is clipped because the `viewportRef` container (preview/components/index.tsx) and the handle roots are `overflow-hidden`; lift the handle/interaction overlay out of that clip (sibling layer, or give it ≥34px headroom) so a full-canvas element's rotation + top corner handles stay grabbable — note the inner `overflow-hidden` on `transform-handles`/`mask-handles` roots must also be relaxed. **Narrow clips:** below ~16px clip width, render one resize handle or none so the two 8px handles don't consume the whole body and block move.
**Execution note:** **live-repro the anchor first** (KTD-5) before choosing the text fix; the handle-clip + narrow-clip fixes are independent and can proceed immediately.
**Patterns to follow:** `getEdgeHandlePosition` (arbitrary edges), the existing edit-mode exits (Esc/blur/playback) in `text-edit-overlay.tsx`.
**Test scenarios:** `Test expectation: live-verify` — after placing text, the user can discover how to resize (handles visible, or a clear hint + exit); a full-canvas element's rotation handle is grabbable; a 1–2-frame clip still has a central move zone.
**Verification:** the reported "can't resize text / no diagonal cursor" flow is resolved end-to-end; edge-positioned and narrow elements remain manipulable.

---

### Phase C — Accessibility

### U6. Accessibility: labels, pressed-state, ruler, keyboard nudge

**Goal:** icon controls are named, toggles expose state, the ruler is honest, and clips are keyboard-movable.
**Requirements:** R6.
**Files:** `apps/web/src/preview/components/toolbar.tsx` (Play/Pause, Fullscreen), `apps/web/src/timeline/components/timeline-toolbar.tsx` (toggle buttons + zoom), `apps/web/src/components/editor/panels/assets/views/assets.tsx` (MediaActions), `apps/web/src/timeline/components/timeline-ruler.tsx` (slider), `apps/web/src/features/ai-generate/director/components/director-review-dialog.tsx` (Checkbox + DialogDescription), `apps/web/src/actions/definitions.ts` + `use-editor-actions.ts` (nudge action); test: `apps/web/src/actions/__tests__/nudge-selected.test.ts` (new).
**Approach:** thread `aria-label` (reuse the tooltip string) onto every icon-only `Button` and `aria-pressed={isActive}` onto the toolbar toggles via the `ToolbarButton` wrapper; add `aria-label` to Play/Pause (state-dependent), Fullscreen, zoom, and MediaActions. Ruler: either drop `role="slider"`/`tabIndex` (the playhead is the real slider) or wire `aria-valuenow` to live `currentTime` and implement arrow-key seek — do not ship a frozen-at-0 slider. Director modal: swap the native checkbox for the app `Checkbox` primitive and add a `DialogDescription`. Add `nudge-selected-left/right` actions (Alt+Arrow) that build a `MoveGroup` from the selection and commit a one-frame offset via `editor.timeline.moveElements`, reusing `resolveGroupMove`. Also surface the currently-unreachable `stop-playback` / `toggle-ripple-editing` actions in the Hotkeys editor (build its list from `ACTIONS`, not only bound keys).
**Execution note:** test-first for the nudge action (pure move-group math is testable); the rest is live/a11y verification.
**Patterns to follow:** `KeyframeToggle` (`aria-pressed`/`aria-label` done right), the existing playhead slider ARIA, the group-move pipeline used by drag.
**Test scenarios:**
- `nudge-selected-right` shifts the selected element(s) by exactly one frame via the same `resolveGroupMove` path as a mouse drag; collision/track rules match.
- `Test expectation: live-verify` — screen reader announces named buttons + toggle pressed-state; the ruler reports the live position or is no longer a slider.
**Verification:** icon controls are labeled, toggles announce on/off, the ruler is honest, and Alt+Arrow nudges a selected clip.

---

### Phase D — Visual polish, dead code & error-edge hardening

### U7. Visual polish & dead-code sweep

**Goal:** visible state matches reality and no control silently no-ops.
**Requirements:** R7.
**Files:** `apps/web/src/components/theme-toggle.tsx`, `apps/web/src/features/ai-generate/director/components/director-review-dialog.tsx` + `apps/web/src/features/ai-generate/components/variant-picker-dialog.tsx` (padding), `apps/web/src/timeline/components/timeline-element.tsx` (source-audio icon ternary), `apps/web/src/components/editor/panels/assets/views/assets.tsx` ("Export clips" dead item), `apps/web/src/components/ui/tooltip.tsx` (typo), `apps/web/src/features/ai-generate/components/run-hyperframes-button.tsx` (stray Stop button), `apps/web/src/components/editor/panels/properties/components/property-param-field.tsx` (font picker).
**Approach:** theme toggle renders a moon icon in light mode / sun in dark (keep the sr-only label); add `p-6` (or `DialogBody`/`DialogFooter` wrappers) to the two flush dialogs; fix the source-audio context-menu icon ternary to swap `Link02Icon`/`Unlink02Icon` (import them; keep the `HugeiconsIcon` wrapper — the audit flagged the naive fix would not compile); disable the dead "Export clips" item (matches the existing "Replace media — not yet implemented" convention); fix `text-redb-900` → `text-red-900`; move the Director "Stop" `<Button>` out of the Radix `<Tooltip>` to a sibling (mirror the AiCutMenu pattern); render the existing full `FontPicker` for `param.type === "font"` instead of the hardcoded 12-font `Select`. Fold in the low nits: playback-speed reset on single-click, ColorPicker swatch sizing, AvSync badge vs resize-handle overlap.
**Execution note:** mostly mechanical; the font-picker swap and dialog padding want a live glance.
**Patterns to follow:** `KeyframeToggle`/`ColorPicker` usage; the disabled "Replace media" item; the AiCutMenu Stop-button placement.
**Test scenarios:** `Test expectation: live-verify` — theme icon reflects mode; dialogs have padding; the source-audio icon reflects linked/separated; "Export clips" is disabled; the font picker offers the full list. The tailwind typo and tooltip-child fixes are compile/visual-trivial.
**Verification:** no control shows misleading or frozen state; no enabled control silently does nothing.

### U8. Error & edge hardening

**Goal:** edge inputs are guarded and surfaced, and the Director's pre-review mutation is reversible in one step.
**Requirements:** R8.
**Files:** `apps/web/src/components/editor/export-button.tsx` (empty guard), `apps/web/src/media/processing.ts` (getMediaDuration finite guard), `apps/web/src/media/upload-toast.ts` (zero-import toast), `apps/web/src/features/ai-generate/director/run-director.ts` + `components/director-review-dialog.tsx` + `apps/web/src/features/editing/assemble.ts` (pre-review atomicity); tests: extend `apps/web/src/media/__tests__/` for the duration guard.
**Approach:** in `ExportButton`/`ExportPopover`, read `editor.timeline.getTotalDuration()` and disable Export (or short-circuit with a toast "Add footage to the timeline first") when duration is 0 — *before* `pickSaveLocation`, so the save dialog isn't shown for an empty project. In `getMediaDuration`, return `Number.isFinite(d) && d > 0 ? d : undefined` so `DEFAULT_NEW_ELEMENT_DURATION` takes over (and/or harden `toElementDurationTicks` callers against non-finite). When `uploadedCount === 0`, surface an error/info toast instead of the green success state. **Director pre-review (the meatier item):** batch `assembleBinToTimeline`'s inserts + the `runRemoveSilences` `RemoveRangesCommand` into one `BatchCommand` executed once, and on Cancel/dismiss undo it (true rollback) — or, minimally, emit a toast on cancel ("Footage was assembled and silences removed — Ctrl+Z to undo") with the steps collapsed into one undo entry so a single Ctrl+Z works.
**Execution note:** the export + duration guards are unit-testable; the Director batch is live-verified.
**Patterns to follow:** the existing "Project is empty" guard in `renderer-manager`, the `Number.isFinite(videoData.fps)` guard in the video branch, the atomic `BatchCommand` in `apply-plan.ts`.
**Test scenarios:**
- `getMediaDuration` returns `undefined` for `Infinity`/`NaN`/`0`, a finite value otherwise.
- Export on a zero-duration timeline short-circuits before `pickSaveLocation` (no save dialog) — assert via the duration read.
- A 0-asset import surfaces a non-success toast.
- `Test expectation: live-verify` — cancelling the Director review restores the pre-Director timeline in one Ctrl+Z (or a clear toast says how).
**Verification:** empty export gives immediate feedback (no wasted dialog); a malformed audio file imports with a sane default; cancelling the Director leaves a recoverable, signposted state.

---

## Scope Boundaries

**Deferred to follow-up (low value today):**
- `navigator.platform` deprecation in Cmd/Ctrl detection (`utils/platform.ts`) — works in practice; revisit if a misdetection is reported.
- Escape-in-text-input double-handling (global blur vs overlay handler) — currently consistent; only matters if commit-vs-cancel semantics diverge.
- `EditableTimecode` staying in edit mode on an invalid entry — minor; fold into U7 only if cheap.
- Negative-cache perf of undecodable re-probe is handled in U1; broader VideoCache eviction is out of scope (tracked separately for the #6 stutter work).

**Explicitly not in this plan:** the dismissed finding ("show transform handles during text caret edit") — the audit confirmed handle-hiding during edit is the intended modal pattern; U5 addresses *discoverability*, not forcing handles into edit mode.

---

## Risks & Mitigations

- **Keying the properties panel by `element.id` (U2) drops in-progress field edits on selection change.** → That is the correct behavior (a selection change should not keep a stale draft); commit-on-blur already runs before the selection changes in the normal flow. Verify the common edit→click-away path still commits.
- **The shortcut native-affordance guard (U3) could re-enable a key we intend to capture.** → Scope the bail to **no-modifier** bindings with a focused interactive element only; modifier combos and the canvas/timeline (non-interactive focus) keep firing. Cover with the predicate tests.
- **Lifting the handle layer out of `overflow-hidden` (U5) could let handles paint over adjacent panels.** → Constrain to a bounded headroom margin (≥34px) rather than fully unclipped, or clip at the panel boundary instead of the viewport.
- **The Director pre-review rollback (U8) is the riskiest change** (touches assemble + the command stack). → Ship the minimal "batch + cancel toast" first; full undo-on-cancel is a clean follow-up if the batch alone isn't enough.
- **Volume.** → Phases are a priority order; Phase A is the must-fix floor. It is fine for execution to stop after any phase boundary.

---

## Sources & Research

- Origin: the `audit-editor-issues` multi-agent workflow (2026-06-18) — 6 finder dimensions (preview-cursor, timeline, panels-toolbar, shortcuts-focus, visual-a11y, error-edge) + a skeptical verifier per claimed bug. 10 bugs confirmed against committed code, 1 dismissed as intended modal UX, 40 improvements catalogued. Every unit's file locations and refined fixes carry the verifier's corrections (e.g. the handle-clip fix must relax the `viewportRef` clip, not only the inner root; the source-audio icon fix must import the icons + keep the `HugeiconsIcon` wrapper).
- Code grounding: `preview/components/transform-handles.tsx` + `handle-primitives.tsx` (cursor pipeline correct in isolation), `preview/components/index.tsx` (render guard), `properties/index.tsx` (un-keyed tab content), `actions/use-keybindings.ts` (capture-phase guards), `services/video-cache/service.ts` (sink init throw path).
