# Director eval findings — first full-pipeline measurement (2026-07-11)

**Fixture:** google-omni (14 raw OBS clips, 21 min, 2,506 words → Dan's final 8.5 min, 1,482 words; Dan cut 1,320 words after move/noise exclusions). Ground truth derived from Dan's own finished edit (Groq whisper-large-v3 both sides). Pipeline measured: the app's ACTUAL `buildDirectorProposals` (extracted in U2, byte-faithful) with all three live LLM passes (plan, redundancy, context) via claude-code auth. Single run; responses cached for reproduction (`bun scripts/director-eval.ts --llm`).

## The numbers

| | AUTO (one-click apply) | OFFERED (all review rows) |
|---|---|---|
| cut recall | **19.3%** (255/1320) | **24.2%** (320/1320) |
| cut precision | 66.6% | 64.9% |
| **essential words lost** | **128** | **173** |
| missed cut words | 1,065 | 1,000 |
| mean boundary error | 3.23s | 2.79s |

Detector-only baseline (previous measurement): recall 0.8%, essential lost 12.

## Verdict: hypothesis ranking

1. **LLM judgment — take selection and span granularity — DOMINATES.** The smoking gun is the Disney cluster: Dan KEPT "And I say this as someone who has worked at Walt Disney Studios." (18:34) and cut the flubbed attempts (18:40-18:59). The pipeline proposes cutting BOTH — the keeper and the flubs — a wrong-keeper choice plus block-granular spans. Same pattern at 15:43-16:22: a 39-second proposed cut over a section Dan kept, to remove a mid-take restart ("you can become a VTuber now. and you can become a VTuber") that needed a 3-second surgical trim. The passes think in SEGMENTS; Dan edits in WORDS.
2. **Boundary math — second.** ~3s mean boundary error, and a large share of essential-lost words are heads/tails adjacent to otherwise-correct cuts ("So", "phone.", "because"). Segment-snapped cuts cannot land word-accurate edges by construction.
3. **Transcript quality — EXONERATED as root cause.** This measurement ran on whisper-large-v3, the best transcript we can get, and recall is still under 25%. The in-app tiny-whisper path only makes everything above worse; upgrading it is a multiplier, not the fix.
4. **Chunking blindness — NOT dominant on this fixture.** The redundancy pass ran live (2 windows over 186 lines) and the biggest missed/mangled repeats are LOCAL (within seconds), inside one window. Cross-chunk blindness may matter on longer footage but it is not what is failing here.

## Caveats, honestly

- **Ground-truth granularity noise:** many "missed" spans are 1-3 word fragments ("to make", "a", "get on your") from Dan re-recording lines with slightly different wording — label noise, not surviving mistakes. But the whole-block misses are real (e.g. the 0:55 verification retake: "So to go through the verification process..." twice, only partially engaged).
- **Pacing detector (37 proposals, the largest source) partially reflects a fixture artifact:** concatenated raw clips create inter-clip silences that read as long pauses. Some coincide with Dan's real trims, some threaten content. Eval-side clip-seam handling would sharpen this number.
- **Single run** (no variance band yet). Responses are cached; `--runs 3` is cheap to add on top and should precede any threshold tuning.
- **Infra finding:** concurrent claude-code CLI spawns (redundancy + context in parallel) stalled twice before completing on a clean retry — the plan's KTD6 watchdog earned its keep. An in-app timeout on these passes is still missing (known follow-up from discovery Q8).

## Recommended fix order (the next plan)

1. **Take-surgery pass: keep-best-take with word-level spans.** For every repeat cluster the LLM identifies, a deterministic word-surgeon (transcript already has words) should (a) choose the keeper the way Dan does — cleanest COMPLETE delivery, not merely the last — and (b) cut ONLY the flubbed words, snapping to word boundaries plus breath gaps. Attacks both complaints at once: surviving repeats AND destroyed dialog.
2. **Word-boundary refinement for ALL LLM segment cuts:** LLM output is intent; a refinement layer narrows each cut to word edges before it becomes a row. Target: essential-words-lost to near zero — precision before recall, or one-click apply cannot be trusted.
3. **Then recall expansion** (the ~1,000 missed words): a dedicated retake-hunt pass over word-level candidates, measured against this same fixture before/after.
4. **Transcript upgrade in-app** (Groq path by default when key present) as the across-the-board multiplier.

Reproduce: `cd apps/web && bun scripts/director-eval.ts --llm` (cached, free). Re-measure after any fix; the scorecard is the gate.

---

## ADDENDUM (same day): corrected against Dan's TRUE final

Dan's actual final lives in `Videos/_Finals/0708 Google Omni.mp4`. Checking his correction ("I cut the Disney line entirely") exposed a **ground-truth defect, not a pipeline defect**: the aligner's substitution rule had no length parity, so a long deleted block faced by a short re-recorded replacement was labeled "kept". Fixed (SUBSTITUTION_MAX_RATIO=3, MAX_EXCESS=5, regression-tested), fixture rebuilt from the true final, re-scored with cached LLM responses (zero new tokens):

| | AUTO | OFFERED |
|---|---|---|
| cut recall | 19.7% (289/1466) | 26.4% (387/1466) |
| cut precision | **75.5%** (was 66.6) | **78.5%** (was 64.9) |
| essential words lost | **94** (was 128) | **106** (was 173) |
| mean boundary error | 3.48s | 3.06s |

**Revised verdict.** Dan cuts 58.5% of raw words; the pipeline proposes barely a third of that volume:

1. **UNDER-CUTTING is the dominant gap** — 1,079+ cut words missed. The draft is 3-4x too conservative for Dan's real editing ratio. Nothing in the LLM passes carries a compression contract ("this creator keeps ~42% of raw; drop tangents, restarts, weak takes entirely").
2. **Boundary/word-surgery second** — ~3s edge error and 94-106 destroyed words (bar is 0) still disqualify one-click apply, but the distance shrank by a third once labels were fixed.
3. **Take-selection was partly a label artifact**: the pipeline cutting BOTH Disney takes matched Dan's real decision. Genuine over-cuts of kept content remain (the 15:43 VTuber block) but are no longer the headline.

**Meta-lesson:** the eval corrected itself on first contact with the true reference. Provenance rule: reference finals come from `Videos/_Finals/` only — which also holds finals for 0629, 0701, and 0709, i.e. three more fixtures ready to prepare.

**Revised fix order for "get the draft closer to my final":**
1. **Compression contract in the plan pass**: target keep-ratio learned from Dan's own fixtures (~42% here) plus section-level drop decisions; promptable now, measurable immediately against this scorecard.
2. **Word-level take-surgery + boundary refinement**: drive essential-words-lost from ~100 to ~0 so an aggressive draft stays safe to apply.
3. **Recall-expansion pass** for retakes and false starts at word granularity.
4. **More fixtures from _Finals** so the brief and thresholds tune to Dan's style across videos, not one sample.

## ADDENDUM 2 (2026-07-12): the 2x2 that gates the defaults (plan U5)

Four fixtures now score in one `--llm` run — google-omni (removes 58.5%), hermes-cloud (39.4%), how-to-edit (79.6%), pokemon-tcg (32.5%) — spanning Dan's real editing range. Ran the 2x2 that matters: **keeper policy** (keep-last vs quality-scored, U2) x **compression target** (off vs each fixture's own truth ratio, U3), cached per combination (`--keeper quality`, `--compression`). The keeper A/B is a **noise-free deterministic comparison**: keeper policy only changes the deterministic merge, not the LLM plan, so `last` vs `quality` run against byte-identical cached plan responses.

Aggregate across the four fixtures (`essLost` = total essential kept-words destroyed; bar is 0):

| combo | AUTO recall | AUTO essLost | OFFERED recall | OFFERED prec | OFFERED essLost |
|---|---|---|---|---|---|
| last / off (today's default) | 34.5% | 774 | 41.0% | 72.7% | 1005 |
| quality / off | 34.1% | **723** | 40.5% | 73.0% | **974** |
| last / on | 37.4% | 918 | **44.6%** | 72.0% | 1148 |
| quality / on | 37.5% | 890 | 44.6% | 72.1% | 1140 |

google-omni alone (the origin fixture), OFFERED: recall 26.3% (off) -> **36.6%** (on); essLost 106 -> 155.

**Adopted defaults (the measurement decides):**

1. **Keeper policy stays `last` in-app.** Quality-scored is *weakly, consistently* better on the bar-zero metric (AUTO essLost 723 vs 774, -6.6%; never worse on any fixture — the gain lives entirely in hermes-cloud, 349 vs 383) but pays a <1.5pp recall dip and moves only ~8 offered words/video. Per KTD3 the scorecard must *clearly* overturn a live-tested default; a marginal, mixed result does not. `quality` stays available behind the option and the eval `--keeper` flag for stronger future evidence. **No in-app default change.**

2. **Compression stays absent (off) in-app.** The contract does what it was built to do — OFFERED recall +3.6pp aggregate, **+10.3pp on google-omni** — but at the full truth ratio it also *raises* essential-words-lost (+143 offered, +144 AUTO), and the AUTO set (applied without review) is already far over bar at baseline. Unsafe to auto-apply at the measured ratio. Per R4 "conservative default in-app" = off; the contract is measured, promptable, and eval-wired, but a nonzero in-app default waits on the recall pass below. **No in-app default change.**

3. **No row class promoted to auto-accept.** Essential-words-lost is 106-558 per fixture OFFERED across *every* combo (bar 20). The AUTO tier is already too aggressive to loosen; redundancy/context sub-0.7 gating stays opt-in. **No `defaultAccept` constant change.**

Net: **U5 changes no in-app constant.** The gate's verdict is "keep today's conservative defaults" — the aggressive knobs (quality keeper, compression) are now *measured and available*, not *default*.

**Success bars (R6): NOT met — stated plainly.**
- `essential-words-lost < 20 / fixture OFFERED`: missed everywhere (106-558). 
- `google-omni OFFERED recall >= 40% with precision >= 70%`: precision met (~77-78%); recall peaks at **36.6%** (last/on), short of 40%.

**Next levers (why the bars miss, and what moves them):**
1. **Essential-words-lost is span-EXTENT, not edge, dominated.** Mean boundary error is 3-9s, not sub-second — the LLM chooses cut *spans* much larger/different than Dan's, so U1's word-refinement (a sub-frame correction, active in every combo here and correct by construction) cannot move this aggregate. The lever is span granularity: word-level cut spans from the plan pass, or clamping cut extents to Dan-sized removals.
2. **Recall needs a dedicated retake-hunt pass** (deferred follow-up #3). Compression trades essLost for recall; it cannot lift recall *without* the essLost cost. A word-granularity recall pass that surfaces retakes/false-starts as OFFERED (not AUTO) rows is the safe way to close the under-cutting gap.
3. **how-to-edit is the outlier**: at an 79.6% truth removal ratio, compression *lowered* recall (28.0% -> 25.6%) — told to cut 80%, the LLM cut different spans than Dan. Extreme-compression footage needs the take/recall structure, not a bigger prompt number.

## ROUND-3 GATE (2026-07-16): kept-output match rate baseline, decision GO

Round 3 (plan docs/plans/2026-07-16-001) measures what Dan actually asked for: "the draft should match ~90% of my final edit." New metric: kept-output match rate (F1 over per-word kept masks, raw + noise-adjusted), with counterfactual ceilings (FP zeroed = span-discipline lever alone; FN zeroed = recall lever alone). Baseline from cached responses, OFFERED, noise-adjusted:

| fixture | match (adj) | span-discipline ceiling | recall ceiling | essLost | missed words | noise share |
|---|---|---|---|---|---|---|
| google-omni | 61.6% | 64.2% | 97.0% | 106 | 1081 | 2.8% |
| hermes-cloud | 75.3% | 84.9% | 90.0% | 457 | 875 | 1.8% |
| how-to-edit | 36.2% | 41.6% | 91.4% | 172 | 3002 | 0.1% |
| pokemon-tcg | 81.5% | 91.6% | 89.8% | 270 | 265 | 1.4% |

**Decision: GO (R4).** The gap is missed-cuts dominated on every fixture (FN 265-3002 vs FP 106-457), exactly the retake/repeat material the round's recall lever targets, and the recall ceilings (89.8-97.0%) show 0.90 reachable on 3 of 4 fixtures with both levers. Stated risks: how-to-edit (79.6% removal footage) sits at 36.2% and likely misses the 0.90 bar even with both levers (R8 needs 3 of 4); google-omni needs the retake hunt to catch most of its 1081 missed words. Label noise is small (raw within ~0.5pp of adjusted everywhere), so the adjusted gate number is honest.

## ADDENDUM 3 (2026-07-16): round-3 verdict — span discipline shipped, retake hunt measured out, compression rehabilitated by the clamp

Round 3 (plan docs/plans/2026-07-16-001) shipped U1 (kept-output match rate + ceilings, the gate above), U2 (clamp-cut-extent span discipline, default ON), U3 (retake-hunt LLM pass v1+v2), U4 (in-app wiring, default OFF). All numbers OFFERED, noise-adjusted match / recall / essLost / missed unless stated. Raw match stayed within 0.5pp of adjusted on every fixture and combo, so no fixture triggers the raw-gap guard.

### The four-combo table

| fixture | baseline | +U2 clamp (now default) | +U2+U3 retake v2 | +U2+compression (opt-in) |
|---|---|---|---|---|
| google-omni | 61.6 / 26.3 / 106 / 1081 | 61.6 / 26.3 / 106 / 1081 | 61.0 / 26.3 / 120 / 1081 | **63.0 / 35.7 / 142 / 942** |
| hermes-cloud | 75.3 / 46.9 / 457 / 875 | 75.5 / 46.2 / 441 / 887 | 75.2 / 48.4 / 474 / 851 | 74.9 / 51.5 / 520 / 800 |
| how-to-edit | 36.2 / 28.0 / 172 / 3002 | 36.4 / 28.2 / 167 / 2995 | not measured (see below) | 35.2 / 25.7 / 183 / 3098 |
| pokemon-tcg | 81.5 / 62.7 / 270 / 265 | 82.2 / 62.5 / 252 / 266 | 82.2 / 63.5 / 257 / 259 | **82.8 / 64.5 / 247 / 252** |

AUTO essential-words-lost (bar 20): baseline 94/383/116/181 -> +U2 71/344/111/136 -> +U2+compression 64/374/126/131. The clamp cut AUTO essLost 24-45% and made compression AUTO-SAFER than baseline on google (64 vs 71) and pokemon (131 vs 136). With retake on, AUTO is byte-identical to retake-off by construction (OFFERED-only rows folded after the second pass).

### What the retake hunt taught us (U3, two live iterations)

v1 was precise but under-fetched: on google-omni its 26 usable candidates hit 89.7% word precision, but every truth-cut word it found was already flagged by the plan/redundancy passes. New recall: zero. v2 added a handled-region mask ([HANDLED] lines), an exhaustive line-by-line sweep demand, and 6k chunking. Result: still zero new recall on google (26.3%, 1081 missed, identical), +1pp on pokemon, +2.2pp on hermes, with essLost up 5-33 words and match down 0.0-0.6 everywhere. how-to-edit's retake cell was deliberately not measured: three fixtures establish the pattern, it is the structural outlier where this lever class provably fails, and a mid-run timeout loses all chunk progress (cache writes only on completion).

**Conclusion: the remaining missed words are NOT word-level retake material.** The existing plan+redundancy+repeat machinery already catches the findable flubs. What survives is Dan's editorial ruthlessness: whole-section drops, weak-take elimination, and re-records with different wording. A defect-hunting pass cannot find cuts that are not defects.

### Adopted defaults (R10, the measurement decides)

1. **U2 clamp: default ON** (shipped unconditional). Improves or holds every OFFERED metric, cuts AUTO essLost materially, never costs recall more than 1pp.
2. **Retake pass: default OFF.** In-app behind the `directorRetake` flag (off), eval behind `--retake`. Match-neutral-at-best on 3 measured fixtures; it does surface genuine review rows with reasons, so it stays available, but R10 does not permit a default for a lever the scorecard cannot justify.
3. **Compression: stays opt-in, recommendation upgraded.** With the clamp demoting its oversized spans, compression now RAISES match on google (+1.4) and pokemon (+0.6) while lifting recall +9.4pp/+2.0pp, and its old AUTO essLost cost is gone on those fixtures. It still hurts hermes match (-0.6) and how-to-edit (-1.2, recall down too, the round-2 finding again). Per-fixture, not universal: an in-app default stays off until the structural lever exists.
4. Keeper stays `last`; no accept-gate constants moved.

### Success bars (R8): NOT met — stated plainly

- OFFERED adjusted match >= 0.90 on 3 of 4 fixtures: **MISSED everywhere.** Best cell is pokemon at 82.8 (compression), 7.2 points short; google 63.0; how-to-edit 36.4. 
- AUTO essential-words-lost < 20 per fixture: **MISSED** (best 64-131 band), though improved 24-45% by the clamp. The remaining AUTO essLost floor is detector-sourced (pacing/repeat), not LLM spans: a different follow-up than span discipline.
- OFFERED essLost and missed both materially down: essLost down on 3 of 4 (default config); missed down only marginally without compression.

### Review-effort gap (what OFFERED-vs-AUTO means for Dan, default config)

To move from the one-click AUTO draft to the OFFERED number, Dan accepts roughly this many additional true-cut words (and rejects this many wrongly-flagged kept words) per video: google 113 accept / 35 reject; hermes 213 / 97; how-to-edit 451 / 56; pokemon 128 / 116. The OFFERED match rate is a review-assisted ceiling, not the draft he opens.

### The next lever (named, per R8)

A **structural-drop pass**: section/line-granularity, OFFERED-only review rows proposing whole-tangent and weak-take drops (the compression contract's judgment, emitted through the OFFERED machinery instead of inflating plan-pass spans). Evidence: compression's +9.4pp recall on google shows the LLM CAN identify this material when licensed; the clamp + defaultAccept:false machinery shipped this round is exactly the safety envelope it needed. Secondary: attack the detector-sourced AUTO essLost floor (pacing spans overlapping kept words), and more fixtures from _Finals when a Groq key exists.

## ADDENDUM 4 (2026-07-16): round-4 verdict — the structural-drop pass, floor-tuned, split verdict

Round 4 (plan docs/plans/2026-07-16-002) shipped the structural-drop pass: full-catalog single-call throughline judgment emitting line-range section drops as OFFERED-only rows (category `structural`, defaultAccept false, runaway guard MAX_STRUCTURAL_DROP_FRACTION 0.35, floor STRUCTURAL_CONFIDENCE_FLOOR 0.6). AUTO is byte-identical with the pass on or off by construction. All numbers OFFERED adjusted match / recall / essLost / missed vs the round-3 default config.

### The floor tuning that made it work

At the sibling passes' 0.5 floor, how-to-edit gained +657 recall words but +253 kept-word collateral (2.6:1, R8 fail, match -4.3). A per-band probe of the cached response showed the model's confidence is well calibrated for section drops: EVERY wrongly-flagged kept word lived in the [0.5, 0.6) band; drops at 0.6+ hit 322 truth-cut words with zero collateral. Floor 0.6 flipped the fixture to match +1.7 with zero added essLost. google showed the same shape but weaker (0.6+ = 2.8:1 pre-trim, nothing above 0.7), hermes weaker still.

### Results (structural on vs off)

| fixture | match adj | recall | essLost | missed | R8 ratio (gained:lost) |
|---|---|---|---|---|---|
| google-omni | 61.6 -> 61.6 | 26.3 -> 32.9 | 106 -> 151 | 1081 -> 983 | 2.2:1 MISS |
| hermes-cloud | 75.5 -> 74.9 | 46.2 -> 53.3 | 441 -> 536 | 887 -> 770 | 1.2:1 MISS |
| how-to-edit | 36.4 -> 38.1 | 28.2 -> 33.5 | 167 -> 167 | 2995 -> 2775 | no words lost, PASS |
| pokemon-tcg | 82.2 -> 82.9 | 62.5 -> 65.1 | 252 -> 249 | 266 -> 248 | no words lost, PASS |

Max-assist sanity point (structural + retake, pokemon): 81.0, WORSE than structural alone (82.9); the retake pass's collateral drags the combo, consistent with the round-3 verdict. Remaining combos skipped with this evidence (each costs live calls; retake stays off).

### Verdict

1. **R8 precision gate: split.** Passed with zero collateral on how-to-edit and pokemon-tcg; missed on google (2.2:1) and hermes (1.2:1). The misses are boundary bleed: the model's section ranges include adjacent kept context on fixtures where Dan's structural cuts interleave with re-records.
2. **R9 match bar (0.90 on 3 of 4): NOT met.** Best cell 82.9 (pokemon, structural on). Raw within 0.5pp of adjusted everywhere, no raw-gap flags. Stated plainly: two rounds of safe levers moved the per-fixture match by +1.7 to +2.4 total; the bar needs precision work on the two interleaved fixtures, not more recall classes.
3. **Default: `directorStructural` stays OFF** (R10 discipline: the scorecard does not clearly justify a default that is negative on one fixture). **Recommendation to Dan: turn it on for your own runs.** It is the first pass whose rows directly mirror your structural editing (match up or flat on 3 of 4, +2.6 to +7.1pp recall everywhere, every row OFFERED with a throughline reason). Review load: +1 to +13 structural rows per video.
4. Eval flags now: `--structural` (recommended), `--retake` (off), `--compression` (opt-in), `--keeper`.

### Next lever (named)

Boundary precision on interleaved footage (google/hermes): the structural pass finds the right sections but bleeds into adjacent kept lines. Candidate devices: a per-drop verify sub-pass (judge each proposed range against the throughline reason it claims), or line-level confidence from the model (score each line inside the range, trim tail lines below the floor). Secondary: the round-3 residuals (detector-sourced AUTO essLost floor; more fixtures when a Groq key exists).

## ADDENDUM 5 (2026-07-16): round-5 verdict — the verify sub-pass ships, the consolidation does not (yet)

Round 5 (plan docs/plans/2026-07-16-003) shipped the verify sub-pass end to end: one batched damage-review call over all recall-pass candidates (C-indexed keep/reject/tighten verdicts, tightens resolved per candidate through the reference contract, inside-only, fail-open at every layer, no LLM call when no candidates exist). It is wired into the eval and the app (active whenever a recall pass is on). The consolidation (both passes default-on, toggles deleted) was CONDITIONAL on measurement gates and they did not pass. Defaults stay off.

### What the verifier proved it can do

google-omni, isolated structural arm: the verifier read 7 candidates and rejected exactly ONE, a drop carrying ~46 wrongly-flagged kept words. Result: match 61.6 to 63.8 (google's best number in any round, beating even compression+clamp), essential-words-lost BELOW the no-pass baseline (105 vs 106), recall untouched. R6 ratio effectively infinite. Verify's worst case is keep-everything, a no-op by construction: it never regressed any number in any run.

### Why the gates still failed

1. **hermes: judgment saturation, not mechanics.** Two prompt generations (v2 added per-line interior rendering and an explicit edge-bleed tighten bias after v1 rubber-stamped) both returned keep-14 on hermes' structural candidates. A probe showed 73 of the 103 bleeding kept words are WHOLE kept lines inside the drops, perfectly expressible as line tightens; the model simply judges them as part of the droppable sections. Same wall the retake pass hit on hermes in round 3: Dan's hermes keeps are editorially idiosyncratic relative to the transcript, and transcript-only judgment saturates there.
2. **Sampling variance confounds single-run gates.** The full-combo arms re-rolled the structural pass (retake rows change its handled-mask, busting its cache) and the fresh samples swung wildly: google's structural response went from 5 good drops (63.8 match) to 2 poor ones (58.8) across two draws of the same config family; hermes drew 31 rows instead of 13. At gate granularity (3:1 ratios, 0.6-point regressions) single-run measurement is noise-dominated. The round-2 caveat ("--runs 3 should precede any threshold tuning") is now the binding constraint.
3. Also caught and fixed in passing: the eval cache keyed only on pass INPUT, so a prompt wording change silently replayed stale verdicts; VERIFY_PROMPT_VERSION now rides the payload.

### Adopted state

1. **Verify ships as built, active whenever a recall pass is enabled** (it can only remove or shrink review rows; measured strictly non-harmful).
2. **directorRetake / directorStructural stay opt-in** (Settings toggles remain). The consolidation waits.
3. Eval flags: --retake, --structural, --no-verify, --compression, --keeper.

### The next lever (named)

Variance-aware gating: aggregate the gate metrics over --runs 3 (the runner already supports per-run cache indexing) so pass/fail reflects the distribution, not one draw. Secondary: hermes-class footage (interleaved editorial keeps) is beyond transcript-only judgment; the honest levers there are Dan's own review (the rows exist, with reasons) or vision/audio signals. The 0.90 bar stands; best measured cells today: google 63.8, hermes 75.5, how-to-edit 38.1, pokemon 82.9.

## ADDENDUM 6 (2026-07-17): round-6 verdict, the waveform becomes a first-class cutting signal

Round 6 (plan docs/plans/2026-07-17-001, prompted by Dan's live test in docs/LIVE-TEST-ISSUES.md) shipped six deterministic units, zero LLM prompt changes: U1 hallucination guard (silence-bleed transcript spans quarantined from every catalog and detector), U2 envelope dead-air (AUTO cuts for 2.5s+ pure-silence runs, no VAD model, Dan-approved), U3 pause-swallowing boundary placement (removal edges widen through silence to word +/- 0.15s handles, replacing the residual-leaving trough snap on both the pipeline and keeper-swap paths), U4 phrase-repeat similarity gate (cross-sentence n-gram matches demote; true retakes at segment similarity >= 0.8 keep AUTO; the gate rides the second pass too), U5 gap-derived word-guard (a pacing or second-pass gap span can never contain a word), U6 clamp evidence learns silence (dead-air runs + hallucinated spans count as evidence, ending the demoted-dead-outro inversion).

### The live-test clip, replayed with assertions (gate a)

The diag replay (apps/web/scripts/diag-join-the-group.ts, now an assertion harness) passes R1a/R1b/R2/R3 and the sanity band. Concretely against the 2026-07-17 live-test failures: head silence cut flush (0-0.80), the "We are going to" and "You do not have to" n-gram amputations demoted to unchecked rows, the second-pass "to link to your" match demoted through the same gate, the 3.4s pause cut with word-adjacent joins, the 24s hallucination-masked dead-air tail cut AUTO (57.85-81.95 plus a flush tail cut), zero removal boundaries inside clean words, 5 substantial keep fragments (the smooth 1-29s stretch is one unbroken keep). Merged AUTO removal: 33.1s of 83.9s.

### Fixture guard hits (U1, the cache-reprime prediction)

google 5 segments / 51 words, hermes 40 / 212, how-to-edit 21 / 129, pokemon 12 / 69. All four caches re-primed as KTD7 predicted. The hermes and how-to-edit numbers name a suspect for their historically poor cells: their catalogs carried hundreds of hallucinated words.

### Gate (b): four-fixture eval, default config, single draw (baselines = Addendum 3 clamp-default column)

A first measurement ran with U1's original whole-segment energy criterion; the round-6 code review then proved that criterion quarantined sparse REAL quiet speech (a 7s trailing-pause segment holding one soft word), and the corrected criterion (word-SPAN energy) cut fixture flags from 5/40/21/12 segments to 0/17/6/6, keeping only true hallucination cores. The table below is the CORRECTED measurement; the interim numbers (hermes 77.3 etc.) are superseded.

| fixture | OFFERED match adj | OFFERED recall | OFFERED essLost | AUTO match adj | AUTO essLost |
|---|---|---|---|---|---|
| google-omni | 61.6 -> 61.6 | 26.3 -> 25.6 | 106 -> 103 | 58.6 | 59 |
| hermes-cloud | 75.5 -> 78.4 | 46.2 -> 39.8 | 441 -> 246 | 77.0 | 93 |
| how-to-edit | 36.4 -> 37.4 | 28.2 -> 20.4 | 167 -> 61 | 34.8 | 26 |
| pokemon-tcg | 82.2 -> 81.6 | 62.5 -> 41.5 | 252 -> 163 | 82.0 | 27 |

Verdict: PASS. OFFERED match regresses nowhere beyond noise (pokemon -0.6 against a documented +/-5pp single-draw variance; hermes 78.4 is its best cell in any round, +2.9 over the prior best). Essential-words-lost collapses: OFFERED down 3/195/106/89 words, and the AUTO tier starts its recorded series at 59/93/26/27 (the corrected guard roughly halved AUTO damage versus the interim run). Recall falls while match holds or rises: the rows no longer offered were the collateral-heavy ones (hallucination-driven spans and false-positive repeats), the exact trade this round exists to make. Caveat: single draw per cell; the round-5 variance lesson stands and a --runs 3 pass remains the right next measurement.

### The round-6 code review (before ship)

Five parallel finder agents (line-scan, removed-behavior, cross-file, cleanup, altitude/conventions) swept the diff and confirmed 8 fixes, applied and re-gated: the zero-median threshold collapse, the guard's whole-segment energy criterion (above), a start-edge window off-by-one in the swallow walk, flush-edge snap-back, keeper-span bleed-through, pacing deferring to opt-in edead rows, clamp evidence laundering demoted spans, and em dashes in reason strings. Accepted-by-design residuals: boundary-spanning retake demotion (review row remains), sub-0.2s second-pass fragment drops, gap-derived category predicates scattered across call sites, a duplicated test envelope helper.

### Gate (e): hands-on smoke pass (Dan, 2026-07-17)

Dan ran AI CUT and accepted only the recommended rows. Verdict: the round-5-class complaints (hard cuts, head/tail silences, fragmentation, the dead-air tail) did NOT recur; the remaining cut-quality complaint is ONE class: the LLM redundancy pass auto-cut his deliberate instructional restatements inside the flowing 0-45s conversation (the "leave a link in the description" line at ~29.5s and "You have to join the group" at ~34.3s). His editorial read: setup then payoff, context still flowing, not redundancy. This is the round-7 cut lever: redundancy groups that are PARAPHRASE-level (not near-verbatim) should not auto-accept; mirror the U4 philosophy at mapRedundancyGroups. The rest of his smoke-pass feedback is editor UX (persistent Director panel, clip-stretch ripple and linked A/V moves, a spurious frame-out-of-sync notice, menu information architecture) and lives in docs/LIVE-TEST-ISSUES.md items 5-12.

### Defaults and residuals

1. Envelope dead-air ships AUTO (Dan decree 2026-07-17, cut-storm-proof by construction: a run holding a clean word is ineligible).
2. Sub-2.5s silence runs stay pacing's job this round (the diag joins came out clean without a new opt-in class).
3. Residuals for a future round: the 1.05s non-speech blip (81.95-83.0) survives as a keep fragment (below no detector's floor, above noise-fragment's 0.5s cap); the LLM redundancy pass can still start a cut one word early ("too." at 29.46, one essLost word on the diag clip); directorVadDeadAirEnabled defaults ON while EDA now covers the same ground with no model download, a default-flip decision for Dan; the inverseRemapTime asymmetry root cause remains (U5 guards the symptom completely).

## ADDENDUM 7 (2026-07-17): the redundancy near-verbatim gate (Dan's smoke-pass fix)

Dan's post-round-6 smoke pass left one cut-quality complaint: with only recommended rows accepted, the LLM redundancy pass auto-cut his deliberate instructional restatements inside the flowing 0-45s conversation. Round 7 gates the auto-accept: a group's cuts default-accept only when NEAR-VERBATIM (every non-keeper take at similarity >= 0.8 to the keeper); paraphrase-level groups surface as opt-in rows labeled "Possible repeat (paraphrased, may be a deliberate restatement)" regardless of model confidence. Also fixed en route: envelope dead-air ops fold in AFTER the verify pass (a plan cut verify rejects can no longer displace a deterministic silence cut, the draw-dependent hole the assertion harness caught over the 3.4s pause), and only ACCEPTED redundancy cuts may subsume contained cleanup.

Measured on the SAME cached draws (clean A/B against the Addendum 6 corrected table): AUTO essential-words-lost google 59 -> 8, hermes 93 -> 66, pokemon 27 -> 15, how-to-edit flat at 26; OFFERED match within noise (google -0.6, hermes -0.2, how-to-edit +0.1, pokemon flat), because demoted groups remain offered. Diag replay: assertions pass, zero AUTO cuts inside the flowing conversation, head + both silences + dead-air tail cut AUTO. The one-click apply is now near-harmless on every fixture; the recall levers (retake/structural/verify, variance-aware gating) remain the path toward the 0.90 OFFERED bar.
