NOTICE: This is auto-generated on each run of the evals framework. Do not edit this.

# Pi Eval Report

- Model: openai-codex/gpt-5.5
- Commit: be17526
- Cases path: skills-evals/fixtures/eval-cases
- Run: 2026-05-22T15:10:39.256Z
- Run scope: full
- Runs executed: 11 (11 rows)
- Task rows: 11 (pass 10, fail 1, skip 0)
- Runs in spec: 11
- Duration: 13m 18s
- Token stats (this run): cost max 66394, cost median 30781, cost p95 66394
- Suite verdict: FAIL
- Judge comparison: clear 1, none 4, worse 0, inconclusive 1

<!-- JUDGE_REPORT_START -->
## Judge Report

- Suite verdict: FAIL
- Judge token cost: 1494754

## Executive Summary
- Overall suite verdict: no clear suite-level skill benefit. Only ZG-005 is a clear paired skill win.
- ZG-001, ZG-006, ZG-008, and ZG-009 had passing skill variants, but the no-skill variants also passed and matched or exceeded the decisive behavior/performance evidence.
- ZG-007 passed as a single full-payload run, but without a baseline it is task evidence only, not skill-vs-baseline evidence.

## Case Outcomes
| Case | Bundle pass | Skill benefit | Variant task outcome | Decisive evidence |
| --- | --- | --- | --- | --- |
| ZG-001 | No | none | skill pass; noskill pass | Both tests/bench/listing exited 0. Skill verification: processBatch 32.853 ms and processBatchInto 37.117 ms; noskill one-shot 31.567 ms. |
| ZG-005 | Yes | clear | skill pass; noskill fail | Skill passed shape, black-box tests, unit tests, optimized bench, and assembly probe. Noskill optimized bench and assembly failed on Zig 0.15 `std.io.getStdOut`. |
| ZG-006 | No | none | skill pass; noskill pass | Both variants passed shape, black-box tests, unit tests, optimized bench, and assembly probe; both use enum-indexed threshold tables. |
| ZG-008 | No | none | skill pass; noskill pass | Both variants preserve semantics and add reusable prepared weights. Noskill benchmark exposed a larger repeated-prep gap with 4096 weights; skill benchmark used 4 weights and showed only a small prepared delta. |
| ZG-009 | No | none | skill pass; noskill pass | Both variants preserve ordered semantics and build dense lookup/decision tables; same-boundary benchmark was similar, with noskill slightly faster in verification. |
| ZG-007 | Yes | inconclusive | single pass | Single run passed black-box semantics, tests, optimized bench, and codegen ladder; no baseline exists for skill benefit. |

## Clear Skill Wins
- ZG-005: skill is the only paired variant that satisfied the full executable task. The no-skill source still had `std.io.getStdOut` and failed both optimized `--bench` and assembly build; the skill source used Zig 0.15-compatible stdout handling and passed all checks.

## No Clear Win or Regressions
- ZG-001: both variants passed. The skill added caller-owned `processBatchInto`, but final verification did not show a faster boundary; `processBatchInto` was slower than `processBatch` in the evaluator run.
- ZG-006: both variants implemented the same key source shape, prepared per-kind thresholds, caller-owned stats/alerts, and passed all executable checks. Benchmark workloads differed, so there is no decisive timing win.
- ZG-008: both variants moved stable weights into reusable prepared state while keeping one-shot scoring. The no-skill benchmark was at least as informative for repeated preparation.
- ZG-009: both variants replaced ordered scans with lookup preparation and passed black-box ordered-rule tests; benchmark timings do not show a skill advantage.
- ZG-007: the submitted run passed, but no no-skill baseline was selected.

## Skill Feedback
- Keep the Zig version/build-mode guidance that encourages optimized `--bench` runs; it avoided the ZG-005 stdout API failure seen in no-skill.
- Strengthen same-boundary performance guidance: adding a caller-owned or prepared API should be backed by final evaluator-style timings that show it wins, not just by source shape.
- For repeated-preparation cases, tell agents to make benchmarks stress the stable preparation cost; ZG-008 skill used only 4 weights and therefore under-demonstrated the benefit.
- Keep allocation/codegen evidence guidance for prompts that request it; ZG-007 produced a passing codegen ladder with zero allocator/hash/copy/diagnostic hits in the hot boundary.

## Evidence Notes
- Verdicts use verification outputs first. Raw elapsed values are only compared when the benchmark boundary is comparable.
- Some benchmark outputs are not same-boundary across variants, especially ZG-006 and ZG-008; those are treated as no clear timing win instead of inferred superiority.
- Code facts are from submitted project files, not judge-created instrumentation.

## Routing and Process Issues
- All full-payload skill variants routed to the Zig skill and expected benchmarking/machine-level references; ZG-007 additionally read allocation/compiler evidence references.
- No-payload variants read no skills, as expected.
- Process evidence was strongest in ZG-007 because verification included the codegen ladder. In ZG-001, ZG-008, and ZG-009, some low-level checks appear in sanitized traces or agent output, but paired verification mostly records tests, benchmarks, and compiler command listings.
- ZG-005 no-skill process stopped after unit tests in the trace and missed the optimized `--bench` compile failure.

## Artifact Pointers
- Manifest: `suite-manifest.json`
- Verification outputs: `cases/*/*/verification-output.md`
- Routing traces: `cases/*/*/routing.md`
- Process traces: `cases/*/*/sanitized-steps.md`
- Submitted sources: `cases/*/*/project/src/*.zig`

<!-- JUDGE_REPORT_END -->

## Case Rows
<!-- UNPAIRED_TABLE_START -->
| Case | Mode | Task | Judge | Cost | Cached | Turns | Skills Read | Skill Files Read | Refs Read | Missing Refs | Unexpected Refs | Notes | Run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ZG-001:noskill | single | PASS | BASELINE OK | 20753 | 43520 | 1 | 0 | 0 | 0 | - | - |  | 2026-05-22 |
| ZG-001:skill | single | PASS | NO CLEAR WIN | 47333 | 254464 | 1 | 1 | 1 | 2 | - | - |  | 2026-05-22 |
| ZG-005:noskill | single | FAIL | BASELINE FAIL | 12620 | 31232 | 1 | 0 | 0 | 0 | - | - | TASK_FAILURE: verification 'optimized benchmark' failed: exit 1; TASK_FAILURE: verification 'filtered assembly probe' failed: exit 1 | 2026-05-22 |
| ZG-005:skill | single | PASS | SKILL WIN | 15812 | 58368 | 1 | 1 | 1 | 2 | - | - |  | 2026-05-22 |
| ZG-006:noskill | single | PASS | BASELINE OK | 14310 | 11776 | 1 | 0 | 0 | 0 | - | - |  | 2026-05-22 |
| ZG-006:skill | single | PASS | NO CLEAR WIN | 38611 | 216064 | 1 | 1 | 1 | 2 | - | - |  | 2026-05-22 |
| ZG-007 | single | PASS | STANDALONE OK | 66394 | 468480 | 1 | 1 | 1 | 4 | - | skills/zig/references/allocation-evidence.md, skills/zig/references/compiler-evidence.md |  | 2026-05-22 |
| ZG-008:noskill | single | PASS | BASELINE OK | 42328 | 151040 | 1 | 0 | 0 | 0 | - | - |  | 2026-05-22 |
| ZG-008:skill | single | PASS | NO CLEAR WIN | 30781 | 205312 | 1 | 1 | 1 | 2 | - | - |  | 2026-05-22 |
| ZG-009:noskill | single | PASS | BASELINE OK | 19641 | 14336 | 1 | 0 | 0 | 0 | - | - |  | 2026-05-22 |
| ZG-009:skill | single | PASS | NO CLEAR WIN | 32052 | 209920 | 1 | 1 | 1 | 2 | - | - |  | 2026-05-22 |

## Comparison Outcomes
- **ZG-001**: none; bundle fail. skill: task pass (`zig build test`, optimized bench, and compiler command listing all exited 0 in `cases/ZG-001/skill/verification-output.md`.); noskill: task pass (`zig build test`, optimized bench, and compiler command listing all exited 0 in `cases/ZG-001/noskill/verification-output.md`.)
- **ZG-005**: clear; bundle pass. skill: task pass (Shape check, black-box rule tests, unit tests, optimized benchmark, and assembly probe all exited 0.); noskill: task fail (Although shape and tests passed, the required optimized benchmark and assembly probe exited 1 because main used the removed `std.io.getStdOut` API.)
- **ZG-006**: none; bundle fail. skill: task pass (Single-file shape, black-box sample tests, unit tests, optimized benchmark, and assembly probe all exited 0.); noskill: task pass (Single-file shape, black-box sample tests, unit tests, optimized benchmark, and assembly probe all exited 0.)
- **ZG-008**: none; bundle fail. skill: task pass (Black-box route semantics, Zig tests, optimized benchmark, and compiler listing all exited 0.); noskill: task pass (Black-box route semantics, Zig tests, optimized benchmark, and compiler listing all exited 0.)
- **ZG-009**: none; bundle fail. skill: task pass (Black-box ordered-rule semantics, Zig tests, optimized benchmark, and compiler listing all exited 0.); noskill: task pass (Black-box ordered-rule semantics, Zig tests, optimized benchmark, and compiler listing all exited 0.)
- **ZG-007**: inconclusive; bundle pass. single: task pass (Black-box caller-owned semantics, Zig tests, optimized benchmark, and json codegen ladder all exited 0.)

## Task Failures
- **ZG-005:noskill** (single): TASK_FAILURE: verification 'optimized benchmark' failed: exit 1; TASK_FAILURE: verification 'filtered assembly probe' failed: exit 1
