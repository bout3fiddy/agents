NOTICE: This is auto-generated on each run of the evals framework. Do not edit this.

# Pi Eval Report

- Model: openai-codex/gpt-5.5
- Commit: 1c5eace
- Cases path: skills-evals/fixtures/eval-cases
- Run: 2026-05-22T15:46:19.052Z
- Run scope: full
- Runs executed: 11 (11 rows)
- Task rows: 11 (pass 10, fail 1, skip 0)
- Runs in spec: 11
- Duration: 20m 47s
- Token stats (this run): cost max 79798, cost median 29557, cost p95 79798
- Suite verdict: PASS
- Judge comparison: clear 3, none 2, worse 0, inconclusive 1

<!-- JUDGE_REPORT_START -->
## Judge Report

- Suite verdict: PASS
- Judge token cost: 3028521

## Executive Summary
- Overall verdict: clear but uneven skill benefit. The skill variants produced clear wins in ZG-001, ZG-006, and ZG-008; ZG-005 and ZG-009 did not show a clear skill-over-baseline advantage; ZG-007 has only a single skill-routed run, so benefit is inconclusive.
- All skill-routed variants passed their required verification. The only individual task failure was ZG-006/noskill, where the black-box harness crashed and the bench/assembly commands failed to compile.
- The useful skill pattern was concrete Zig performance work: caller-owned buffers, enum-indexed prepared state, ReleaseFast benchmarks, and focused generated-code or allocation checks.
- The weak pattern was benchmark comparability: some skill outputs added useful benchmark labels, but ZG-005 workloads were not comparable and ZG-009's new prepared API did not clearly beat the no-skill optimized public boundary.

## Case Outcomes
| Case | Skill result | Baseline result | Bundle verdict | Main evidence |
|---|---:|---:|---:|---|
| ZG-001 | pass | pass | clear skill win | Skill ReleaseFast `processBatch`/`processBatchInto` timings were below no-skill's single `processBatch` timing; skill added caller-owned `processBatchInto`. |
| ZG-005 | pass | pass | no clear win | Both single-file implementations passed shape, black-box, unit, bench, and assembly checks; benchmark workloads differed. |
| ZG-006 | pass | fail | clear skill win | Skill passed black-box sample tests and bench; no-skill black-box crashed and `--bench` failed on `std.io.getStdOut`. |
| ZG-008 | pass | pass | clear skill win | Skill removed `AutoHashMap` from the current one-shot API and kept a prepared API; no-skill retained `AutoHashMap` in `scoreSegments`. |
| ZG-009 | pass | pass | no clear win | No-skill optimized existing `evaluateAccess` with a dense lookup; judge same-boundary spot check showed no stable prepared-policy advantage. |
| ZG-007 | pass | n/a | task pass only | Single variant passed caller-owned semantics, tests, benchmark, and codegen ladder; no baseline comparison. |

## Clear Skill Wins
- ZG-001: `cases/ZG-001/skill/verification-output.md` reports `processBatch` 8.340 ms and `processBatchInto` 15.952 ms in the optimized benchmark, while `cases/ZG-001/noskill/verification-output.md` reports 30.267 ms for the no-skill optimized benchmark. The skill code adds `processBatchInto` at `cases/ZG-001/skill/project/src/main.zig:89`.
- ZG-006: `cases/ZG-006/skill/verification-output.md` has all checks exit 0; `cases/ZG-006/noskill/verification-output.md` has black-box sample tests exit 1 and compile failures for bench/assembly.
- ZG-008: `cases/ZG-008/skill/project/src/route.zig:102` routes one-shot `scoreSegments` through fixed prepared weights, while `cases/ZG-008/noskill/project/src/route.zig:107` still constructs an `AutoHashMap`. Official verification and the judge spot check both show the skill one-shot boundary faster.

## No Clear Win or Regressions
- ZG-005: both variants satisfied the task. The skill benchmark used 1,000,000 records across 20 iterations, while no-skill used 500,000 records in one timed call, so elapsed times are not a clean skill comparison.
- ZG-009: the skill prepared API is useful, but no-skill's `RuleLookup` in `cases/ZG-009/noskill/project/src/main.zig:63` optimizes the existing public `evaluateAccess` boundary. Judge spot check in `evidence/judge-bench-summary.md` measured skill prepared 8.474 ms vs no-skill evaluateAccess 8.303 ms on the same generated workload.
- ZG-007: task evidence is strong, but with only a single variant there is no skill-vs-baseline benefit claim.
- No skill variant had failing required verification, but ZG-001's allocation claim is overstated: `std.fmt.allocPrint` remains reachable when `debug_flags` is set in `cases/ZG-001/skill/project/src/main.zig:72`.

## Skill Feedback
- Keep the guidance that led agents to caller-owned output and reusable prepared state; it was decisive in ZG-001, ZG-006, ZG-008, and the single ZG-007 run.
- Keep the emphasis on running ReleaseFast benchmarks and focused generated-code/allocation probes; ZG-007's codegen ladder gave concrete hot-boundary evidence.
- Strengthen the guidance to require same-boundary benchmark comparisons. ZG-005 and parts of ZG-008 used different record counts, batch sizes, or iteration structures, making cross-variant performance claims harder to judge.
- Add guidance to optimize or measure the existing public API when a new prepared API is introduced. ZG-009's no-skill variant optimized `evaluateAccess` itself to about the same speed as the skill prepared API.
- Require allocation claims to cover the real benchmark path, not only a sanitized test path. ZG-001's failing-allocator test used `debug_flags = 0`, while the benchmark fixture still sets debug flags periodically.

## Evidence Notes
- Required verification outputs were treated as primary evidence. Judge-created spot checks in `evidence/bench_zg008_mod.zig`, `evidence/bench_zg009_mod.zig`, and `evidence/judge-bench-summary.md` were used only to clarify same-boundary comparisons for ZG-008 and ZG-009.
- Wall-clock benchmark timings are noisy; conclusions rely on same-boundary comparisons, matching checksums, verification exit status, and concrete source facts.

## Routing and Process Issues
- Every skill-routed variant read the expected Zig skill plus `benchmarking.md` and `machine-level-hypotheses.md`; no skill routing gaps were observed in the routing files.
- No-skill variants correctly had no skill or reference reads.
- Process quality was strongest in ZG-007, where the run used the provided codegen ladder and reported zero allocator/hash/diagnostic calls in the extracted hot boundary.
- Process quality was weaker where benchmark boundaries differed or where source claims exceeded code facts, especially ZG-001 and ZG-005.

## Artifact Pointers
- Manifest: `suite-manifest.json`
- Verification outputs: `cases/<case>/<variant>/verification-output.md`
- Routing traces: `cases/<case>/<variant>/routing.md`
- Process traces: `cases/<case>/<variant>/sanitized-steps.md`
- Submitted Zig sources: `cases/<case>/<variant>/project/src/*.zig`
- Judge spot-check harnesses and notes: `evidence/bench_zg008_mod.zig`, `evidence/bench_zg009_mod.zig`, `evidence/judge-bench-summary.md`

<!-- JUDGE_REPORT_END -->

## Case Rows
<!-- UNPAIRED_TABLE_START -->
| Case | Mode | Task | Judge | Cost | Cached | Turns | Skills Read | Skill Files Read | Refs Read | Missing Refs | Unexpected Refs | Notes | Run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ZG-001:noskill | single | PASS | BASELINE OK | 27248 | 40448 | 1 | 0 | 0 | 0 | - | - |  | 2026-05-22 |
| ZG-001:skill | single | PASS | SKILL WIN | 51188 | 244736 | 1 | 1 | 1 | 2 | - | - |  | 2026-05-22 |
| ZG-005:noskill | single | PASS | BASELINE OK | 10368 | 13824 | 1 | 0 | 0 | 0 | - | - |  | 2026-05-22 |
| ZG-005:skill | single | PASS | NO CLEAR WIN | 29617 | 102400 | 1 | 1 | 1 | 2 | - | - |  | 2026-05-22 |
| ZG-006:noskill | single | FAIL | BASELINE FAIL | 19858 | 15360 | 1 | 0 | 0 | 0 | - | - | TASK_FAILURE: verification 'harness black-box sample tests' failed: exit 1; TASK_FAILURE: verification 'optimized benchmark' failed: exit 1; TASK_FAILURE: verification 'filtered assembly probe' failed: exit 1 | 2026-05-22 |
| ZG-006:skill | single | PASS | SKILL WIN | 29557 | 208896 | 1 | 1 | 1 | 2 | - | - |  | 2026-05-22 |
| ZG-007 | single | PASS | STANDALONE OK | 59197 | 400384 | 1 | 1 | 1 | 2 | - | - |  | 2026-05-22 |
| ZG-008:noskill | single | PASS | BASELINE OK | 26997 | 91648 | 1 | 0 | 0 | 0 | - | - |  | 2026-05-22 |
| ZG-008:skill | single | PASS | SKILL WIN | 30722 | 177664 | 1 | 1 | 1 | 2 | - | - |  | 2026-05-22 |
| ZG-009:noskill | single | PASS | BASELINE OK | 16401 | 19968 | 1 | 0 | 0 | 0 | - | - |  | 2026-05-22 |
| ZG-009:skill | single | PASS | NO CLEAR WIN | 79798 | 548352 | 1 | 1 | 1 | 2 | - | - |  | 2026-05-22 |

## Comparison Outcomes
- **ZG-001**: clear; bundle pass. skill: task pass (Required tests, optimized benchmark, and compiler command listing all exited 0, with matching checksum 37078917.601 in the benchmark output.); noskill: task pass (Required tests, optimized benchmark, and compiler command listing all exited 0, though the submitted API kept only the allocating batch path.)
- **ZG-005**: none; bundle fail. skill: task pass (Single-file shape, black-box rule tests, Zig tests, optimized benchmark, and filtered assembly probe all exited 0.); noskill: task pass (Single-file shape, black-box rule tests, Zig tests, optimized benchmark, and filtered assembly probe all exited 0.)
- **ZG-006**: clear; bundle pass. skill: task pass (Shape check, black-box sample tests, Zig tests, optimized benchmark, and assembly probe all exited 0.); noskill: task fail (The black-box sample test crashed and the optimized benchmark plus assembly probe failed to compile because `std.io.getStdOut` is unavailable in Zig 0.15.2.)
- **ZG-008**: clear; bundle pass. skill: task pass (Black-box semantics, Zig tests, optimized benchmark, and compiler command listing all exited 0.); noskill: task pass (Black-box semantics, Zig tests, optimized benchmark, and compiler command listing all exited 0.)
- **ZG-009**: none; bundle fail. skill: task pass (Black-box ordered-rule semantics, Zig tests, optimized benchmark, and compiler command listing all exited 0.); noskill: task pass (Black-box ordered-rule semantics, Zig tests, optimized benchmark, and compiler command listing all exited 0.)
- **ZG-007**: inconclusive; bundle pass. single: task pass (Black-box caller-owned semantics, Zig tests, optimized benchmark, and json codegen ladder all exited 0.)

## Task Failures
- **ZG-006:noskill** (single): TASK_FAILURE: verification 'harness black-box sample tests' failed: exit 1; TASK_FAILURE: verification 'optimized benchmark' failed: exit 1; TASK_FAILURE: verification 'filtered assembly probe' failed: exit 1
