---
title: "feat: text round (styles, stroke + shadow, control-language gaps, dead font tabs)"
type: feat
date: 2026-07-20
depth: standard
---

# feat: text round

Dan named three things as important on 2026-07-19: create/export transcripts (shipped, W4), add
solids (shipped, W7), and ADD TEXT. Text never got its own round. This is it, scoped to his actual
footprint: talking-head tutorials, so lower thirds, title cards, callouts, end cards.

Premiere is the guide per the standing directive. Research round 2026-07-20 (Premiere v25+, where
the Essential Graphics panel was retired into the Properties panel + a Graphics Templates panel)
plus a full audit of our own text stack.

## What we already have (do not rebuild)

Our text surface is stronger than expected and matches Premiere on most day-to-day controls: two
creation entry points (Text tool click-to-place, Text tab drag), font family/size via a richer
picker than Premiere's (system + Google Fonts, searchable, sprite previews), tracking, leading,
alignment as a button row, weight/style/decoration, fill color, and a backer box that is MORE
granular than Premiere's (independent X/Y padding and offset). Transform is the shared tab every
element uses. Our 13 motion templates already cover Premiere's starter .mogrt patterns (lower-third,
title-subtitle, section-break, callout-pill, stat-bar, location-tag, end-card) and render natively,
which is a genuine advantage over .mogrt round-trips.

## The measured gaps

Two verified by direct code inspection this session, not taken on the researcher's word:

1. **The Font Picker's "My fonts" and "Favorites" tabs are dead UI.** `filteredFonts`
   (components/ui/font-picker.tsx:52-56) depends only on `[fontNames, search]`; `activeTab` is
   never consulted by any filter. Clicking either tab changes the highlight and the search
   placeholder and shows the identical full list. For a novice this reads as a broken feature.
2. **Template Controls missed the W6 unification.** template-controls-tab.tsx:324 defines its OWN
   local `NumberField` built on `Input`, and uses raw `Input` for text fields, instead of the shared
   `components/ui/number-field` + `SliderNumberPair` every other panel adopted last round. This is
   the tab Dan touches most (every motion-template insert lands there), so it is the most visible
   remaining inconsistency in the app.

Three more from the audit:

3. **No reusable text style.** Premiere's Linked Style (formerly Master Text Style) lets a creator
   style a lower third once and apply it to every later title. We have nothing: every text element's
   params are independent, so Dan re-sets every field by hand on every video. This is the single
   biggest workflow gap for someone shipping a series with a consistent look.
4. **No stroke on plain text.** The canvas primitive EXISTS (`strokeMeasuredTextLayout`,
   text/primitives.ts:215-241) but is wired only to the mask system, not to text elements.
5. **No drop shadow at all.** No param, no render code. Stroke and shadow are how Premiere users
   keep text legible over busy footage without a solid backer box, which is the only look our
   templates currently offer.

## Units

- U1. **Template Controls adopts the shared control language.** Replace the local `NumberField`
  (template-controls-tab.tsx:324-353) and raw text `Input`s with the shared `NumberField` /
  `SliderNumberPair` / Section groups. Pure consistency work, no new behavior. Do this FIRST: U2
  builds on this tab and should build on the unified version.
- U2. **Reusable text styles (the multiplier).** A named, project-scoped style capturing appearance
  only (font, size, weight, color, background, and U3's stroke/shadow) and explicitly NOT content,
  position, or duration. "Save as style" on the text properties tab; a dropdown to apply a saved
  style to the selected text element. Apply is a deliberate action, not a live binding (see
  descoped). Reuse the existing batch-patch command path that template-controls-tab's `apply()`
  already uses; reuse Section/SectionHeader for the UI. Persist per project alongside existing
  project state.
- U3. **Stroke and shadow on text.** Add `strokeColor`/`strokeWidth` and shadow
  (`shadowColor`/`shadowBlur`/`shadowOffsetX`/`shadowOffsetY`) to the text params, the param
  registry field defs, and the text render path. Stroke reuses the existing
  `strokeMeasuredTextLayout` primitive. Shadow is a small canvas addition before the fill draw.
  One new Section under the Text tab, built from the shared SliderNumberPair + ColorPicker.
- U4. **Font Picker: kill or wire the dead tabs.** Preferred: implement Favorites for real (star a
  font, persists locally, the tab filters to starred) since the list/virtualization machinery is
  already there, and DELETE "My fonts" (custom font upload is descoped). Acceptable fallback if
  Favorites proves fiddly: remove both tabs. Never leave a tab that does nothing.

## Descoped, with reasons

- Multi-scope style libraries (project vs local vs shared). Premiere's answer to studio teams;
  Dan is solo on one project.
- Custom font upload. Drags in font licensing and hosting for a need Dan has not expressed.
- A live style BINDING (edit the style, every instance re-renders instantly). Much larger state
  lift; "apply style" as a fast deliberate action covers the workflow.
- A text Effects tab (blur/glow). `TextElement.effects` exists on the type but is unwired; blur on
  a lower third is a rare need.
- Vertical/paragraph alignment, justify, text-on-a-path, OpenType features. Print typography and
  After Effects territory, not lower thirds.
- Any new .mogrt-style import pipeline. Our native motion templates already fill that role, and
  the HyperFrames/Remotion generation layer is PARKED per Dan's 2026-07-19 decision.

## Not a build item

The ANCHOR bug (place text, then resize from a corner) is Dan's own report and is CODE-FIXED but
never confirmed live: placement auto-selects with handles visible and does not enter edit mode, and
double-click edit mode now shows a dashed ring plus an "Esc or click away to resize" hint. It is
item 11 on docs/SMOKE-20MIN.md. If Dan's smoke pass shows it still broken, that jumps ahead of
every unit here.

## Process

Standing contract from docs/plans/2026-07-19-002: per-feature worktrees, Premiere as the guide,
implementation delegated (Opus/Sonnet/Haiku), Fable plans only. Gates per worktree: apps/web suite
(1550 pass, 0 fail at tip aac5f20c), hf-bridge 188, tsc clean. Edit tool only, no em dashes,
PATCHES.md rows in the same commit for upstream files.
