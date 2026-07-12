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
