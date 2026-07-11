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
