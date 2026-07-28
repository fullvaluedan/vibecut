---
title: "feat: W4-W7 feature specs (research-informed: transcripts, masks, design system, solids)"
type: feat
date: 2026-07-19
depth: standard
---

# feat: W4-W7 feature specs

Companion to docs/plans/2026-07-19-002-feat-ui-overhaul-roadmap.md. Each spec distills the
Premiere Pro research round (5-agent fan-out, 2026-07-19) into build requirements. Premiere is the
guide, not the law: divergences are named and justified.

## W5: Masks deep fix (Opus) - THE RESEARCH CHANGES THE SHAPE OF THIS WORK

**The headline finding:** our Rust mask compositor is ALREADY the OpenCut rewrite's implementation.
`rust/crates/masks/src/sdf.rs` is byte-identical (60+ lines checked) to OpenCut-app/OpenCut tag
v0.3.0 (MIT): a prior session ported their Jump-Flooding-Algorithm SDF feathering wholesale. Our
freeform Pen mask is ORIGINAL work with no OSS counterpart anywhere (Motionity uses fabric
clipPath with no pen UI, omniclip only masks for wipes, react-video-editor has no masks and an
unclear license). So "is there code on GitHub for this" = we already took the best of it; the deep
fix is repair and completion, not a port.

Requirements, in order:
- R1 DIAGNOSE FIRST: make the suite's 3 mask test failures pass (2x "mask snapping", 1x "custom
  mask point insertion") - they are the only red in the whole suite and the likeliest code-level
  face of Dan's "masks is broken". Understand each failure before changing behavior.
- R2 DIFF UPSTREAM: diff rust/crates/masks/{sdf.rs,feather.rs,shaders/*} against OpenCut v0.3.0
  (commit f4bd689f51cf12a4dd0a32f602f761be314d9686) and any newer tag; adopt bug fixes that
  diverged after our port.
- R3 ATTRIBUTION (compliance, not optional): OpenCut is MIT; PATCHES.md only covers the
  opencut-classic fork base, NOT this ported Rust code. Add THIRD_PARTY_NOTICES.md (or header
  comments in sdf.rs/feather.rs) crediting OpenCut-app/OpenCut, MIT license text carried.
- R4 TABLE-STAKES PARITY: add the two missing Premiere-standard params to BaseMaskParams:
  `expansion` (grow/shrink boundary independent of feather) and mask `opacity` (0-100 strength).
  Wire through builtin definitions, renderer path (frame-descriptor/compositor), and masks-tab UI
  as numeric rows beside Feather. NO on-canvas handle for expansion (Premiere exposes it as a
  slider only; our feather icon-handle stays the only exotic handle).
- R5 PEN-TOOL HARDENING: hand-verify the freeform create/edit loop (click = anchor, click-drag =
  bezier handles, click-first-point closes). This is the highest-risk table-stakes interaction.
  Reference Bezier.js (Pomax, MIT) formulas if curve math needs hardening; do not add it as a
  dependency.
- R6 KEEP our deliberate divergences: per-element masks (NOT Premiere's per-effect model; even
  Adobe's 2026 "unassigned mask" redesign drew user backlash), one-mask-per-element cap (Premiere
  has the same constraint per-effect; tighten the duplicate-the-clip tooltip), and the renderable
  stroke (our superset feature; strokeWidth 0 default keeps it invisible).
- R7 DESCOPE, stated in code comments where relevant: no mask tracking (computer-vision
  auto-follow), no multi-mask combine modes. Roadmap items, not this fix.

Gate: full suites with THE MASK NUMBER MOVING (1465+3 becomes 1468+0 if all three fixed - report
exactly), hf-bridge 188, tsc, and an in-app smoke of create/adjust/drag/invert for ellipse,
rectangle, and pen via the browser recipe.

## W4: Transcript create + export (Sonnet, after W2 merges) - Dan's "very important"

Research: Premiere's Text panel Transcript tab is the model; its export lives in a kebab menu
(.prtranscript native, .txt with timecodes/speakers + "pauses as [...]" toggle, .csv columned),
and SRT confusingly lives in the separate Captions tab. We already have the hard parts: word-level
Whisper transcription (apps/web/src/transcription/) and SRT/ASS writers (apps/web/src/subtitles/).
The existing Transcript bin tab renders transcript text with ripple-delete selection.

Requirements:
- R1 The Transcript tab gains a kebab Export menu with all three formats IN ONE PLACE (fixing
  Premiere's split-brain): .txt (toggles: include timecodes, include speakers, both default on),
  .srt (REUSE subtitles/srt.ts, one writer two call sites), .csv (speaker,start,end,text columns).
  Skip a native round-trip format entirely.
- R2 Click-a-word seeks the playhead; playback highlights the current word (verify what exists in
  the current tab, complete what is missing).
- R3 Search box filtering/highlighting across the transcript.
- R4 Keep the existing ripple-delete selection flow working untouched (it is our equivalent of
  Premiere's flashiest feature and already exists; do not regress it).
- R5 Everything renders from the one TranscriptionResult source of truth the Director already
  consumes; no second transcription path.

## W6: Design-system unification (spec here by Fable, applied by Sonnet, after W2)

Research nailed the exact divergences. The canonical control is `components/ui/number-field.tsx`
(scrub-from-label hot text, matching Premiere; already used by Transform/masks/speed/templates).

Requirements:
- R1 Retire the bespoke scrubbable number inside effect-controls-tab.tsx (~lines 340-435): render
  NumberField instead. This kills the text-sky-400 vs --primary split and the divergent
  reset-button convention in one pass.
- R2 Fix the Escape bug in number-field.tsx: today Escape === Enter (both commit via blur).
  Premiere/universal convention: Escape REVERTS the typed draft, Enter commits. Needs a cancel
  path in use-property-draft.ts distinct from onBlur-commits.
- R3 Reset convention standardized: button hidden entirely at default value (NumberField's
  existing behavior). Add optional group-level reset in SectionHeader (Premiere's "Reset Effect"),
  rendered only when something in the group is non-default.
- R4 New SliderNumberPair shared component (Radix slider + NumberField, one onPreview/onCommit
  contract); auto-wired for any ParamDefinition with both min and max.
- R5 Live scrub precision modifiers in NumberField: Ctrl = fine, Shift = x10 coarse, read per
  pointer-move (today sensitivity is a static prop).
- R6 Migrate the two stray raw number inputs (ai-cut-menu.tsx, bookmarks.tsx) onto NumberField.
- R7 The blue: keep --primary hsl(200,90%,52%) as FrameCut's brand blue (Dan LIKES our blue; do
  not chase Adobe's indigo). Delete the hardcoded text-sky-400; --primary is the single token.
- R8 Section/SectionHeader/SectionContent becomes the mandatory PropertyGroup wrapper in every
  properties tab (effect-controls and masks currently hand-roll rows).

## W7: Solids (Sonnet, after W2) - small

Research: Premiere's Color Matte is a synthetic bin clip; its shared-master-asset color ("change
one, every instance repaints") is Adobe's most-complained-about gotcha. We diverge there on
purpose.

Requirements:
- R1 "Solid" = a synthetic color media entry flowing through the EXISTING ImageElement/mediaId
  pipeline (no TimelineElement union change, no new renderer switch arms).
- R2 Entry point: a "Solid color" add action in the Media bin (Premiere puts Color Matte in the
  Project panel); insertable at playhead or draggable like any still.
- R3 Defaults: canvas-size fill, still-image default duration, DEFAULT_BACKGROUND_COLOR (or first
  preset in data/colors/solid.ts). No creation dialog at all - one click, then edit.
- R4 PER-INSTANCE color (deliberate anti-Premiere): each placed solid owns its color; editing one
  never repaints others. Color edits live inline in the Properties panel reusing ColorPickerContent
  (the background.tsx pattern), never a modal.
- R5 Descope: no matte library, no letterbox presets, no size prompts.

## Sequencing reminder

W5 launches NOW (independent of W2's surfaces). W4/W6/W7 branch from the post-W2 tip. W6 lands
after W4/W7 in its phase (it repaints what they build). Every workstream carries the roadmap's
process contract (worktree preamble, gates, PATCHES rows, Edit-only, no em dashes, no push).
