NOTICE: This is auto-generated on each run of the evals framework. Do not edit this.

# Pi Eval Report

- Model: openai-codex/gpt-5.5
- Commit: 0881e44
- Cases path: skills-evals/fixtures/eval-cases
- Run: 2026-05-22T15:24:44.890Z
- Run scope: full
- Runs executed: 11 (11 rows)
- Task rows: 11 (pass 10, fail 1, skip 0)
- Runs in spec: 11
- Duration: 13m 1s
- Token stats (this run): cost max 80486, cost median 23995, cost p95 80486
- Suite verdict: PASS
- Judge comparison: clear 4, none 1, worse 0, inconclusive 1

<!-- JUDGE_REPORT_START -->
## Judge Report

- Suite verdict: PASS
- Judge token cost: 1767641

## Executive Summary

Overall, the selected suite shows clear skill benefit. The skill-routed Zig runs read the expected Zig skill plus benchmarking and machine-level references, and they produced clear wins in ZG-001, ZG-006, ZG-008, and ZG-009. ZG-005 is not a clear win because both variants passed and their self-authored benchmarks are not the same boundary. ZG-007 is a single skill-routed variant, so it passes the task evidence but cannot prove skill-vs-baseline benefit.

## Case Outcomes

| Case | Bundle | Skill benefit | Task evidence summary |
|---|---:|---|---|
| ZG-001 | PASS | clear | Skill tests passed and ReleaseFast benchmark reported `processBatchInto` 11,585,000 ns vs no-skill `processBatch` 34,496,000 ns with same checksum. |
| ZG-005 | FAIL | none | Both variants passed shape, black-box tests, Zig tests, optimized benchmark, and assembly probe; no same-boundary performance proof. |
| ZG-006 | PASS | clear | Skill passed all checks; no-skill `--bench` and assembly compile failed with Zig compile errors. |
| ZG-008 | PASS | clear | Skill preserved route semantics and produced matching one-shot/prepared checksums; no-skill benchmark checksum was cumulative/mismatched. |
| ZG-009 | PASS | clear | Both passed correctness, but skill same-boundary benchmark was faster: 9,338,000 ns vs 11,842,000 ns, same checksum. |
| ZG-007 | PASS | inconclusive | Single variant passed caller-owned semantics, tests, benchmark, and codegen ladder; no baseline exists. |

## Clear Skill Wins

- **ZG-001:** Skill added caller-owned `processBatchInto`, removed hot debug allocation via stack formatting, and reported same-checksum benchmark boundaries. Evidence: `cases/ZG-001/skill/verification-output.md`, `cases/ZG-001/skill/project/src/main.zig:75`, `:105`.
- **ZG-006:** Skill delivered a compiling `--bench` path and enum-indexed threshold preparation; no-skill missed ReleaseFast/demo compilation. Evidence: `cases/ZG-006/skill/verification-output.md`, `cases/ZG-006/noskill/verification-output.md`.
- **ZG-008:** Skill kept the one-shot API and moved stable weight preparation to a dense `PreparedWeights`; its benchmark kept separate checksums. Evidence: `cases/ZG-008/skill/project/src/route.zig:56`, `cases/ZG-008/skill/project/src/main.zig:31`, `:60`.
- **ZG-009:** Skill used a prepared dense decision table and kept ordered-rule semantics; evaluator benchmark was consistently faster than no-skill on the same public boundary. Evidence: `cases/ZG-009/skill/verification-output.md`.

## No Clear Win or Regressions

- **ZG-005:** Both variants are correct single-file implementations. Skill process was better documented with ReleaseFast validation and warmup/iterations, but the benchmark workloads differ (`1,000,000 x 25` vs `500,000 x 1`), so this is not a clear skill win.
- **ZG-007:** Passed strongly, but it has no baseline comparison; skill benefit remains inconclusive by rule.
- **ZG-006 no-skill regression:** The analyzer API passed imported tests, but `zig run src/main.zig -OReleaseFast -- --bench` failed because the benchmark/main code did not compile.

## Skill Feedback

- Keep the Zig guidance that pushes ReleaseFast tests/benchmarks and concrete hot-boundary hypotheses; it correlated with clear wins in ZG-001, ZG-006, ZG-008, ZG-009, and the single ZG-007 run.
- Strengthen scratch-task benchmark guidance: require comparable workloads, warmup/iteration counts, and per-item metrics. ZG-005 skill was better than no-skill, but the benchmark was still not a same-boundary cross-variant proof.
- Keep guidance to move stable preparation out of repeated hot loops: dense tables/enum-indexed preparation were decisive in ZG-006, ZG-008, ZG-009, and ZG-007.
- Add an explicit reminder to compile and run `--bench` in optimized mode before final. ZG-006 no-skill passed `zig test` but failed the optimized benchmark compile.
- Improve generated-code probe guidance to isolate the target symbol. ZG-007's codegen ladder gave strong symbol-level evidence; generic assembly greps in scratch cases included whole-binary allocator/memcpy noise.

## Evidence Notes

- Primary evidence is evaluator verification output, not agent prose.
- Timings are recorded verification timings; I did not infer speed from code shape alone.
- ZG-005 performance is treated as inconclusive because the variants chose different benchmark workloads.
- ZG-008 no-skill core prepared scoring appears functionally correct by unit tests, but its benchmark checksum accumulation weakens the repeated-boundary evidence.

## Routing and Process Issues

- All skill variants routed to `zig` and read `skills/zig/references/benchmarking.md` plus `skills/zig/references/machine-level-hypotheses.md`.
- No-skill variants had no skill/reference reads, as expected.
- ZG-006 no-skill process stopped after `zig test src/main.zig`; the missing optimized bench check is directly tied to the later verification failure.
- ZG-008 no-skill process reported `zig build bench` without optimized mode in agent output; evaluator still ran optimized verification and exposed the checksum issue.

## Artifact Pointers

- Verification: `cases/*/*/verification-output.md`
- Routing: `cases/*/*/routing.md`
- Process traces: `cases/*/*/sanitized-steps.md`
- Submitted Zig sources: `cases/*/*/project/src/*.zig`
- Key source examples: `cases/ZG-001/skill/project/src/main.zig`, `cases/ZG-006/skill/project/src/main.zig`, `cases/ZG-008/skill/project/src/route.zig`, `cases/ZG-009/skill/project/src/main.zig`, `cases/ZG-007/single/project/src/main.zig`

<!-- JUDGE_REPORT_END -->

## Case Rows
<!-- UNPAIRED_TABLE_START -->
| Case | Mode | Task | Judge | Cost | Cached | Turns | Skills Read | Skill Files Read | Refs Read | Missing Refs | Unexpected Refs | Notes | Run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ZG-001:noskill | single | PASS | BASELINE OK | 15965 | 4096 | 1 | 0 | 0 | 0 | - | - |  | 2026-05-22 |
| ZG-001:skill | single | PASS | SKILL WIN | 80486 | 493056 | 1 | 1 | 1 | 2 | - | - |  | 2026-05-22 |
| ZG-005:noskill | single | PASS | BASELINE OK | 11645 | 27648 | 1 | 0 | 0 | 0 | - | - |  | 2026-05-22 |
| ZG-005:skill | single | PASS | NO CLEAR WIN | 23950 | 44032 | 1 | 1 | 1 | 2 | - | - |  | 2026-05-22 |
| ZG-006:noskill | single | FAIL | BASELINE FAIL | 19794 | 15360 | 1 | 0 | 0 | 0 | - | - | TASK_FAILURE: verification 'optimized benchmark' failed: exit 1; TASK_FAILURE: verification 'filtered assembly probe' failed: exit 1 | 2026-05-22 |
| ZG-006:skill | single | PASS | SKILL WIN | 23995 | 98816 | 1 | 1 | 1 | 2 | - | - |  | 2026-05-22 |
| ZG-007 | single | PASS | STANDALONE OK | 69367 | 426496 | 1 | 1 | 1 | 2 | - | - |  | 2026-05-22 |
| ZG-008:noskill | single | PASS | BASELINE OK | 24490 | 122368 | 1 | 0 | 0 | 0 | - | - |  | 2026-05-22 |
| ZG-008:skill | single | PASS | SKILL WIN | 25804 | 165888 | 1 | 1 | 1 | 2 | - | - |  | 2026-05-22 |
| ZG-009:noskill | single | PASS | BASELINE OK | 16468 | 20480 | 1 | 0 | 0 | 0 | - | - |  | 2026-05-22 |
| ZG-009:skill | single | PASS | SKILL WIN | 55261 | 206336 | 1 | 1 | 1 | 2 | - | - |  | 2026-05-22 |

## Comparison Outcomes
- **ZG-001**: clear; bundle pass. skill: task pass (Passed `zig build test` and ReleaseFast benchmark; verification reported `processBatch` and `processBatchInto` with the same checksum.); noskill: task pass (Passed tests and benchmark, but only reported the allocated `processBatch` boundary and kept a heap-formatting debug path.)
- **ZG-005**: none; bundle fail. skill: task pass (Passed single-file shape, black-box rule tests, Zig tests, optimized benchmark, and filtered assembly probe.); noskill: task pass (Passed single-file shape, black-box rule tests, Zig tests, optimized benchmark, and filtered assembly probe.)
- **ZG-006**: clear; bundle pass. skill: task pass (Passed single-file shape, black-box sample tests, Zig tests, optimized benchmark, and filtered assembly probe.); noskill: task fail (Imported API tests passed, but required optimized `--bench` and assembly probe failed to compile with Zig errors.)
- **ZG-008**: clear; bundle pass. skill: task pass (Passed black-box route semantics, Zig tests, optimized benchmark, and compiler command listing with matching prepared/one-shot checksums.); noskill: task pass (Passed black-box route semantics and Zig tests; its benchmark ran but printed a cumulative/mismatched prepared checksum.)
- **ZG-009**: clear; bundle pass. skill: task pass (Passed black-box ordered-rule semantics, Zig tests, optimized benchmark, and compiler command listing.); noskill: task pass (Passed black-box ordered-rule semantics, Zig tests, optimized benchmark, and compiler command listing.)
- **ZG-007**: inconclusive; bundle pass. single: task pass (Passed black-box caller-owned semantics, Zig tests, optimized benchmark, and JSON codegen ladder checks.)

## Task Failures
- **ZG-006:noskill** (single): TASK_FAILURE: verification 'optimized benchmark' failed: exit 1; TASK_FAILURE: verification 'filtered assembly probe' failed: exit 1
