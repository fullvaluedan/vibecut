---
title: "feat: editor UX round (persistent Director panel, timeline surgery, menu IA)"
type: feat
date: 2026-07-17
depth: deep
---

# feat: editor UX round (persistent Director panel, timeline surgery, menu IA)

## Summary

Three parallel tracks fixing Dan's smoke-pass UX demands (docs/LIVE-TEST-ISSUES.md items 5-8, 10-12), designed against Premiere/CapCut conventions from three research briefs (2026-07-17, in-session). Track A: a persistent "Properties | Director" tab shell so the Director surface is always available (AI CUT actions when idle, live review after). Track B: timeline surgery (linked trim by default, extend-ripple across all tracks, the false frame-out-of-sync badge killed at its confirmed root cause, head pin relaxed to 2s gravity). Track C: menu IA (project info becomes a preview-toolbar chip, AI settings collapse to 4 groups, dead surfaces removed, VAD dead-air toggle deleted with migration). Executed as three worktree-isolated agents merged in dependency order; every track verified in-app by the orchestrator before it counts.

## Dan's fork decisions (2026-07-17, binding)

- Ripple scope: ALL tracks shift on extend and shrink (Premiere).
- Head pin: replaced by 2-SECOND GRAVITY. A main-track placement/move landing with start < 2.0s snaps to 0; at or beyond 2.0s clips move freely (>= 0 clamp only). Applies uniformly to the drag clamp, the update-pipeline pin, and placement enforce.
- Director tab: auto-focus on run COMPLETION (badge while running).
- directorVadDeadAirEnabled: DELETED (field + toggle + Silero pass on the default path), store version bump + migrate, per the KTD5 delete-not-default precedent.

---

## Requirements

- R1. The Director dock is always reachable: idle shows the AI CUT actions inline; running shows live stage + Stop (state survives tab switches); review/applied render the existing panels; highlight gains a docked twin (modal retired).
- R2. Trimming a clip trims its linked partner by default (Alt = solo), with per-member source/neighbor clamps; one undo reverts both.
- R3. With ripple enabled, extending a clip shifts ALL downstream material on ALL tracks right by the delta (one BatchCommand, one undo); shrink-ripple becomes cross-track. Ripple off keeps today's neighbor-blocked behavior.
- R4. The frame-out-of-sync badge fires only on genuinely drifted linked pairs: pairing picks the LARGEST source overlap (tie-break: timeline overlap), changed identically in av-sync.ts and av-sync-map.ts (parity suite). SplitElementsCommand mints fresh linkIds per link group for right-side halves.
- R5. Head gravity: main-track placements under 2.0s snap to 0; otherwise free (>= 0). Keyboard nudges obey the same rule.
- R6. Project info (name, frame rate, aspect + custom size) moves from Settings to a chip popover next to ZoomSelect in the preview toolbar; Settings tab bar shrinks to Background / AI / Hotkeys / Help.
- R7. AI settings render as 4 collapsible groups (Connections and keys open by default; Director behavior; Performance; Advanced). The render-backend select becomes static text. The VAD dead-air section is deleted.
- R8. Dead surfaces removed: transitions/adjustment stub tabs, Freeze frame button, unreachable Rename/DeleteProjectDialog mounts (Delete Project becomes a reachable menu item or is dropped consciously); disabled Replace media / Export clips rows hidden until implemented; Help copy updated to the real AI CUT menu.
- R9. Every upstream-file edit gets a PATCHES.md row in the same commit. No em dashes anywhere. Suites + tsc green per track; in-app verification per the briefs' checklists before merge.

## Key technical decisions

- KTD1. Director dock = second tab inside the existing properties dock slot (no 5th panel, no panel-store changes); dock visibility no longer keyed on the transient `surface` flag; run progress lifts from ai-cut-menu local state into ai-activity-store (label/stage/cancel).
- KTD2. Linked trim reuses findLinkedPartners + a new computeLinkedResize (min-clamp across members, per-member source deltas); the U2/OQ2 no-group-resize decision stands for arbitrary multi-select.
- KTD3. Extend-ripple lives in the resize commit as an explicit BatchCommand (resize + downstream shift), not inside applyRippleIfEnabled's diff heuristic; shrink-ripple crosses tracks.
- KTD4. Sync-badge fix is the pairing rule change (confirmed root cause); fresh-linkId-on-split is the hardening; consolidate-adjacent-clips linked-lockstep must be re-verified after it.
- KTD5. Head gravity threshold HEAD_GRAVITY_SEC = 2.0 in one shared constant consumed by resolve-move clamp, update-pipeline rule, and placement enforce.
- KTD6. VAD deletion follows the delete-the-field precedent: remove from store (version bump + migrate dropping the key), settings UI, run-director's Silero invocation, and the eval config plumbing; vad-dead-air.ts stays (gaps input becomes always empty in-app; eval stub unchanged).
- KTD7. Execution: three worktree-isolated background agents (A panel: mid-tier; B timeline: top-tier; C menus: mid-tier), merged B -> C -> A; predicted conflicts: timeline-toolbar.tsx (B tooltip vs C freeze-frame) and PATCHES.md appends, resolved at merge by the orchestrator, who then runs full gates + in-app verification.

## Implementation units

### U1 (Track A). Persistent Director dock
Per the panel brief: dock shell tab header; DirectorDock state router (idle CTA / running / review cut+assemble+highlight / applied); director-highlight-panel (new, docked twin of the dialog's highlight branch, stay-open-after-apply like cut); store dockTab + auto-focus on completion; retire `surface` as gate; ai-activity-store gains label/stage/cancel; ai-cut-menu writes through it; properties/index.tsx loses the takeover early-returns (PATCHES row); page.tsx mounts the shell (PATCHES row). Verification: the brief's 13-point checklist.

### U2 (Track B). Timeline surgery
Per the timeline brief: linked trim default-on (resize-controller expansion + computeLinkedResize); extend-ripple + cross-track shrink-ripple behind the existing toggle; av-sync pairing rule + parity tests + regression for the extended-clip mispair; SplitElementsCommand fresh linkIds (new PATCHES row); head gravity 2.0s across resolve-move/update-pipeline/placement (PATCHES rows); stale tooltip made true; run-director's conservative linked-reorder skip lifted once linked moves are safe. Tests per the brief's suite list. Verification: the brief's 5-step click script.

### U3 (Track C). Menu IA
Per the audit: project-info chip in preview toolbar (PATCHES row) + Settings tab removal (PATCHES row); AI settings 4-group accordion; render-backend select -> static text; VAD section deleted + store migration; transitions/adjustment tabs removed (PATCHES rows); Freeze frame removed (PATCHES row); Rename dialog dead code removed + Delete Project made reachable in the project dropdown (or dropped, agent judgment with note); disabled context rows hidden; Help AI CUT section rewritten to the real menu. Verification: the audit's 11-point checklist.

### U4. Merge, gates, in-app verification, ship
Orchestrator: merge B -> C -> A resolving predicted conflicts; full suites + tsc; diag replay assertions still pass (U2/U3 touch no director pipeline, U1 touches run-progress wiring only); drive all three tracks in the browser per their checklists; PATCHES.md rows verified present for every upstream edit; commit narrative per track; push.

## Risks

- The applied-locked reactor and tab-shell mount lifecycle (panel brief risk 1); highlight docked twin is new work (risk 2).
- Linked-trim clamps with retimed partners (timeline brief risk 1); cross-track ripple touching overlays is accepted per Dan's fork.
- Fresh-linkId-on-split vs consolidate-adjacent-clips lockstep (timeline brief risk 4).
- VAD deletion: any stray read is a compile error by design; eval config keeps vadEnabled:false stub so fixtures are unaffected.
- Three-way PATCHES.md merge conflicts are expected and trivial (append rows).

## Sources

The three 2026-07-17 research briefs (persistent panel; timeline stretch/linked/sync; menu IA audit) produced in-session by parallel research agents; docs/LIVE-TEST-ISSUES.md items 5-12; PATCHES.md; docs/BRIEF.md section 3.
