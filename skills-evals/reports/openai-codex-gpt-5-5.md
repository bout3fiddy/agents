NOTICE: This is auto-generated on each run of the evals framework. Do not edit this.

# Pi Eval Report

- Model: openai-codex/gpt-5.5
- Commit: 37cc1b0
- Cases path: skills-evals/fixtures/eval-cases
- Run: 2026-05-22T10:07:07.162Z
- Run scope: full
- Runs executed: 11 (11 rows)
- Task rows: 11 (pass 7, fail 4, skip 0)
- Runs in spec: 11
- Duration: 11m 25s
- Token stats (this run): cost max 65206, cost median 34122, cost p95 65206
- Suite verdict: FAIL
- Judge comparison: clear 2, none 1, worse 2, inconclusive 1

<!-- JUDGE_REPORT_START -->
## Judge Report

- Suite verdict: FAIL
- Judge token cost: 1470033

## Executive Summary

The suite does not show reliable overall skill benefit. The Zig skill clearly helped the two scratch single-file tasks ZG-005 and ZG-006, where skill variants passed black-box harnesses and no-skill variants failed. However, the skill variant regressed correctness in ZG-008, the single skill run in ZG-007 failed its black-box caller-owned API semantics, ZG-001 did not beat the no-skill baseline on the submitted benchmark evidence, and ZG-009 had no clear win because both variants made the same core decision-table optimization.

## Case Outcomes

| Case | Bundle | Skill benefit | Variant outcomes | Decisive evidence |
|---|---:|---|---|---|
| ZG-001 | fail | worse | skill pass; noskill pass | Both tests passed, but skill benchmark raw elapsed was 32.2ms vs no-skill 7.7ms on the same processBatch fixture; skill also left `allocPrint` in the debug scoring path. |
| ZG-005 | pass | clear | skill pass; noskill fail | Skill black-box rule tests exit 0; no-skill black-box failed expected checksum 5, found 1315423915. |
| ZG-006 | pass | clear | skill pass; noskill fail | Skill black-box sample tests exit 0; no-skill black-box failed stats count and its optimized bench did not compile. |
| ZG-008 | fail | worse | skill fail; noskill pass | Skill black-box route command exit 1 via imported route test expected 705, found 710; no-skill passed all route semantics checks. |
| ZG-009 | fail | none | skill pass; noskill pass | Both variants passed ordered-rule black-box tests and used compact decision tables; primary benchmark difference was small, 9.960ms vs 10.118ms. |
| ZG-007 | fail | inconclusive | single fail | No baseline; submitted skill run failed black-box caller-owned semantics expected alert count 3, found 6. |

## Clear Skill Wins

- ZG-005: Skill produced the requested single-file shape, correct additive `id_checksum`, caller-owned output handling, ReleaseFast benchmark, and passing black-box harness. The no-skill variant used a hashed checksum and failed the harness.
- ZG-006: Skill produced reset per-kind stats, later-threshold-wins preparation, caller-owned stats and alert buffers, and a compiling benchmark. The no-skill variant left caller stats uninitialized/accumulating for the black-box case and used an incompatible stdout API in the benchmark path.

## No Clear Win or Regressions

- ZG-001: Both variants passed tests, but the skill variant did not clearly improve over no-skill. Its benchmark changed units to ns per scored sample, while no-skill reported ns per score; raw elapsed evidence favors no-skill. Skill also retained heap formatting in `scorePacket`.
- ZG-008: Correctness failure overrides benchmark evidence. The skill route changes passed `zig build test` but failed the evaluator import test because route module tests exposed a total mismatch.
- ZG-009: Both variants implemented table-based ordered policy evaluation and passed black-box semantics. Skill added a reusable `PreparedAccessPolicy`, but the submitted benchmark still timed `evaluateAccess` including preparation, and no same-boundary evidence showed a decisive advantage.
- ZG-007: The run had useful timing and codegen evidence, but failed the public caller-owned semantics harness. Generated-code checks cannot compensate for an API/semantic failure.

## Skill Feedback

- Keep the Zig benchmarking and machine-level references for scratch tasks: in ZG-005 and ZG-006 the skill variants ran ReleaseFast tests/benchmarks and passed black-box harnesses where no-skill variants did not.
- Strengthen guidance to run public import-style harnesses or module tests, not only `zig build test`. ZG-008 passed its build test but failed when the evaluator imported `src/main.zig` and included `src/route.zig` tests.
- Add a warning that benchmark metric changes must preserve comparable boundaries and units. ZG-001 changed the displayed unit and obscured that the no-skill raw elapsed was faster.
- For caller-owned APIs, return an explicit stats/result shape or otherwise make output counts observable. ZG-007 returned a bare alert slice, which the black-box harness could not interpret as an alert count and reported 6 instead of 3.
- For repeated-rule/weight tasks, benchmark the prepared reusable boundary separately and keep the one-shot boundary honest. ZG-009 added preparation but did not show a decisive prepared-boundary comparison.

## Evidence Notes

- Verification outputs were treated as primary evidence. Failing black-box or harness commands marked the individual variant task as failed even when local unit tests passed.
- Timing claims use the benchmark output inside verification files, not compile-duration summaries.
- Code facts are cited only where they explain a verification result or comparison.

## Routing and Process Issues

- All skill variants routed to the Zig skill and read `benchmarking.md` plus `machine-level-hypotheses.md` according to their routing files.
- No-skill variants had no skill payload, as expected.
- Process quality was mixed: ZG-005/ZG-006 used focused ReleaseFast and assembly probes; ZG-008 and ZG-007 show that generated-code or benchmark checks were allowed to coexist with missed semantic failures.

## Artifact Pointers

- Verification: `cases/*/*/verification-output.md`
- Routing: `cases/*/*/routing.md`
- Process traces: `cases/*/*/sanitized-steps.md`
- Submitted sources: `cases/*/*/project/src/main.zig`, plus `cases/ZG-008/*/project/src/route.zig`

<!-- JUDGE_REPORT_END -->

## Case Rows
<!-- UNPAIRED_TABLE_START -->
| Case | Mode | Task | Judge | Cost | Cached | Turns | Skills Read | Skill Files Read | Refs Read | Missing Refs | Unexpected Refs | Notes | Run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ZG-001:noskill | single | PASS | BASELINE OK | 27670 | 85504 | 1 | 0 | 0 | 0 | - | - |  | 2026-05-22 |
| ZG-001:skill | single | PASS | SKILL WORSE | 50797 | 270336 | 1 | 1 | 1 | 2 | - | - |  | 2026-05-22 |
| ZG-005:noskill | single | FAIL | BASELINE FAIL | 27201 | 32768 | 1 | 0 | 0 | 0 | - | - | TASK_FAILURE: verification 'harness black-box rule tests' failed: exit 1 | 2026-05-22 |
| ZG-005:skill | single | PASS | SKILL WIN | 32690 | 115200 | 1 | 1 | 1 | 2 | - | - |  | 2026-05-22 |
| ZG-006:noskill | single | FAIL | BASELINE FAIL | 12416 | 15872 | 1 | 0 | 0 | 0 | - | - | TASK_FAILURE: verification 'harness black-box sample tests' failed: exit 1; TASK_FAILURE: verification 'optimized benchmark' failed: exit 1; TASK_FAILURE: verification 'filtered assembly probe' failed: exit 1 | 2026-05-22 |
| ZG-006:skill | single | PASS | SKILL WIN | 22120 | 102912 | 1 | 1 | 1 | 2 | - | - |  | 2026-05-22 |
| ZG-007 | single | FAIL | STANDALONE FAIL | 65206 | 305664 | 1 | 1 | 1 | 2 | - | - | TASK_FAILURE: verification 'black-box caller-owned semantics' failed: exit 1 | 2026-05-22 |
| ZG-008:noskill | single | PASS | BASELINE OK | 39297 | 53760 | 1 | 0 | 0 | 0 | - | - |  | 2026-05-22 |
| ZG-008:skill | single | FAIL | SKILL WORSE | 58419 | 155648 | 1 | 1 | 1 | 2 | - | - | TASK_FAILURE: verification 'black-box route scoring semantics' failed: exit 1 | 2026-05-22 |
| ZG-009:noskill | single | PASS | BASELINE OK | 34122 | 52224 | 1 | 0 | 0 | 0 | - | - |  | 2026-05-22 |
| ZG-009:skill | single | PASS | NO CLEAR WIN | 53953 | 169984 | 1 | 1 | 1 | 2 | - | - |  | 2026-05-22 |

## Comparison Outcomes
- **ZG-001**: worse; bundle fail. skill: task pass (Its `zig build test` and optimized benchmark both exited 0, with checksum-preserving benchmark output.); noskill: task pass (Its `zig build test` and optimized benchmark both exited 0, with the same checksum.)
- **ZG-005**: clear; bundle pass. skill: task pass (Single-file shape, black-box rule tests, unit tests, optimized benchmark, and assembly probe all exited 0.); noskill: task fail (The black-box rule harness failed because `id_checksum` semantics were wrong.)
- **ZG-006**: clear; bundle pass. skill: task pass (Single-file shape, black-box sample tests, unit tests, optimized benchmark, and assembly probe all exited 0.); noskill: task fail (Black-box sample tests failed and the optimized benchmark/assembly probe did not compile due to `std.io.getStdOut`.)
- **ZG-008**: worse; bundle fail. skill: task fail (The black-box route scoring semantics command exited 1 due to an imported route test failure.); noskill: task pass (Black-box route scoring semantics, `zig build test`, optimized benchmark, and compiler command listing all exited 0.)
- **ZG-009**: none; bundle fail. skill: task pass (Black-box ordered-rule semantics, unit tests, optimized benchmark, and compiler listing all exited 0.); noskill: task pass (Black-box ordered-rule semantics, unit tests, optimized benchmark, and compiler listing all exited 0.)
- **ZG-007**: inconclusive; bundle fail. single: task fail (The black-box caller-owned semantics harness exited 1, expecting alert count 3 but finding 6.)

## Task Failures
- **ZG-005:noskill** (single): TASK_FAILURE: verification 'harness black-box rule tests' failed: exit 1
- **ZG-006:noskill** (single): TASK_FAILURE: verification 'harness black-box sample tests' failed: exit 1; TASK_FAILURE: verification 'optimized benchmark' failed: exit 1; TASK_FAILURE: verification 'filtered assembly probe' failed: exit 1
- **ZG-007** (single): TASK_FAILURE: verification 'black-box caller-owned semantics' failed: exit 1
- **ZG-008:skill** (single): TASK_FAILURE: verification 'black-box route scoring semantics' failed: exit 1
