NOTICE: This is auto-generated on each run of the evals framework. Do not edit this.

# Pi Eval Report

- Model: openai-codex/gpt-5.5
- Commit: 8640dd5
- Cases path: skills-evals/fixtures/eval-cases
- Run: 2026-05-22T14:56:21.563Z
- Run scope: full
- Runs executed: 11 (11 rows)
- Task rows: 11 (pass 10, fail 1, skip 0)
- Runs in spec: 11
- Duration: 13m 13s
- Token stats (this run): cost max 73619, cost median 27437, cost p95 73619
- Suite verdict: FAIL
- Judge comparison: clear 1, none 3, worse 1, inconclusive 1

<!-- JUDGE_REPORT_START -->
## Judge Report

- Suite verdict: FAIL
- Judge token cost: 1137547

## Executive Summary

The suite does not show reliable overall skill benefit. All skill-routed comparative variants passed their own task verification, and the single ZG-007 run passed, but only ZG-006 is a clear skill win over its no-skill baseline. ZG-001, ZG-005, and ZG-008 were broadly equivalent to the baseline, while ZG-009 favored the no-skill implementation on the reported benchmark boundary.

## Case Outcomes

| Case | Outcome | Skill Benefit | Key Evidence |
|---|---|---:|---|
| ZG-001 | both variants passed | none | both tests/bench passed; benchmark evidence did not show a clear skill lead |
| ZG-005 | both variants passed | none | both produced exactly `src/main.zig` and passed black-box tests |
| ZG-006 | skill passed, no-skill failed | clear | no-skill black-box sample test crashed; skill passed same tests |
| ZG-008 | both variants passed | none | both implemented reusable dense weight preparation and passed semantics tests |
| ZG-009 | both variants passed | worse | no-skill reported faster same-sized access benchmark and used direct level lookup |
| ZG-007 | single variant passed | inconclusive | no baseline; codegen ladder and caller-owned semantics passed |

## Clear Skill Wins

- **ZG-006**: skill variant passed single-file shape, black-box sample semantics, unit tests, and benchmark. The no-skill variant failed the required black-box sample test with exit 1. Source inspection matches the failure: skill resets caller stats and prepares thresholds by enum; no-skill accumulates into caller stats and the harness passed undefined stats storage.

## No Clear Win or Regressions

- **ZG-001**: both variants preserved tests and benchmark. The skill added `processBatchInto`, but reported `processBatch` elapsed was not clearly better than no-skill.
- **ZG-005**: both variants met the single-file API and black-box behavior. Benchmark workloads differed, so no clear skill edge.
- **ZG-008**: both variants moved route weights into reusable dense state and kept the one-shot API. Skill had cleaner named benchmark boundaries, but the submitted source improvement was essentially matched by no-skill.
- **ZG-009**: regression/no win for skill. Both passed ordered-rule tests, but no-skill used a role/action/level lookup and reported `elapsed_ns=8916000`, while skill used a candidate table and reported `elapsed_ns=13799000` for 35 iterations of 160k events.
- **ZG-007**: pass as a single run only; no skill-vs-baseline claim is available.

## Skill Feedback

- Keep the guidance that pushes caller-owned outputs and reset-before-write semantics; it directly aligns with the ZG-006 and ZG-007 passes.
- Strengthen guidance on comparing identical benchmark boundaries. ZG-005 and ZG-008 had useful benchmarks but not enough same-boundary separation to prove a skill win.
- Add a source-level lookup-pattern hint for ordered rule evaluators: when rule keys and levels are bounded, pre-expanding first-match decisions can beat scanning per-key candidates, as shown by ZG-009 no-skill.
- Generated-code/assembly checks should isolate the hot symbol. Several probes included allocator or formatting calls from demo/bench setup, which weakened the evidence.

## Evidence Notes

- Verification output was the primary correctness source.
- Benchmark elapsed values were used only when the boundary was comparable enough to support a claim.
- Code facts were used to explain observed verification differences, not as standalone proof of task success.

## Routing and Process Issues

- All full-payload runs read the Zig skill and both expected references: `benchmarking.md` and `machine-level-hypotheses.md`.
- The skill runs generally executed tests and ReleaseFast benchmarks.
- ZG-007 had the strongest process evidence: the codegen ladder found `evaluateBatchInto` and reported zero allocator/hash/cache, copy-helper, diagnostic, and division checks.
- ZG-009 shows that reading the machine-level references did not guarantee the best source-level optimization.

## Artifact Pointers

- Manifest: `suite-manifest.json`
- Verification files: `cases/*/*/verification-output.md`
- Routing files: `cases/*/*/routing.md`
- Process traces: `cases/*/*/sanitized-steps.md`
- Submitted Zig sources: `cases/*/*/project/src/main.zig`, `cases/ZG-008/*/project/src/route.zig`

<!-- JUDGE_REPORT_END -->

## Case Rows
<!-- UNPAIRED_TABLE_START -->
| Case | Mode | Task | Judge | Cost | Cached | Turns | Skills Read | Skill Files Read | Refs Read | Missing Refs | Unexpected Refs | Notes | Run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ZG-001:noskill | single | PASS | BASELINE OK | 29161 | 50176 | 1 | 0 | 0 | 0 | - | - |  | 2026-05-22 |
| ZG-001:skill | single | PASS | NO CLEAR WIN | 47563 | 293888 | 1 | 1 | 1 | 2 | - | - |  | 2026-05-22 |
| ZG-005:noskill | single | PASS | BASELINE OK | 10597 | 11264 | 1 | 0 | 0 | 0 | - | - |  | 2026-05-22 |
| ZG-005:skill | single | PASS | NO CLEAR WIN | 27437 | 69632 | 1 | 1 | 1 | 2 | - | - |  | 2026-05-22 |
| ZG-006:noskill | single | FAIL | BASELINE FAIL | 22129 | 24064 | 1 | 0 | 0 | 0 | - | - | TASK_FAILURE: verification 'harness black-box sample tests' failed: exit 1 | 2026-05-22 |
| ZG-006:skill | single | PASS | SKILL WIN | 21811 | 80896 | 1 | 1 | 1 | 2 | - | - |  | 2026-05-22 |
| ZG-007 | single | PASS | STANDALONE OK | 34676 | 317440 | 1 | 1 | 1 | 2 | - | - |  | 2026-05-22 |
| ZG-008:noskill | single | PASS | BASELINE OK | 27154 | 57344 | 1 | 0 | 0 | 0 | - | - |  | 2026-05-22 |
| ZG-008:skill | single | PASS | NO CLEAR WIN | 72364 | 466944 | 1 | 1 | 1 | 2 | - | - |  | 2026-05-22 |
| ZG-009:noskill | single | PASS | BASELINE OK | 11218 | 30208 | 1 | 0 | 0 | 0 | - | - |  | 2026-05-22 |
| ZG-009:skill | single | PASS | SKILL WORSE | 73619 | 275968 | 1 | 1 | 1 | 2 | - | - |  | 2026-05-22 |

## Comparison Outcomes
- **ZG-001**: none; bundle fail. skill: task pass (The skill run passed `zig build test` and ReleaseFast benchmark verification with preserved checksum output.); noskill: task pass (The no-skill run also passed `zig build test` and ReleaseFast benchmark verification with the same checksum.)
- **ZG-005**: none; bundle fail. skill: task pass (The skill run passed the single-file shape check, harness black-box rule tests, unit tests, benchmark, and assembly probe.); noskill: task pass (The no-skill run passed the same shape check, black-box rule tests, unit tests, benchmark, and assembly probe.)
- **ZG-006**: clear; bundle pass. skill: task pass (The skill run passed the single-file shape check, black-box sample tests, unit tests, ReleaseFast benchmark, and assembly probe.); noskill: task fail (The no-skill run failed the required harness black-box sample tests with exit 1 despite passing its own unit tests.)
- **ZG-008**: none; bundle fail. skill: task pass (The skill run passed black-box route scoring semantics, project tests, optimized benchmark, and compiler command listing.); noskill: task pass (The no-skill run also passed black-box route semantics, project tests, optimized benchmark, and compiler command listing.)
- **ZG-009**: worse; bundle fail. skill: task pass (The skill run passed black-box ordered-rule semantics, project tests, benchmark, and compiler command listing.); noskill: task pass (The no-skill run passed black-box ordered-rule semantics, project tests, benchmark, and compiler command listing.)
- **ZG-007**: inconclusive; bundle pass. single: task pass (The run passed black-box caller-owned semantics, project tests, optimized benchmark, and JSON codegen ladder checks.)

## Task Failures
- **ZG-006:noskill** (single): TASK_FAILURE: verification 'harness black-box sample tests' failed: exit 1
