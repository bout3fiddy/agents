NOTICE: This is auto-generated on each run of the evals framework. Do not edit this.

# Pi Eval Report

- Model: openai-codex/gpt-5.5
- Commit: 6f90efb
- Cases path: skills-evals/fixtures/eval-cases
- Run: 2026-08-02T17:46:00.717Z
- Run scope: partial (filter=ZG-001, limit=1)
- Runs executed: 2 (2 rows)
- Task rows: 11 (pass 10, fail 1, skip 0)
- Runs in spec: 11
- Duration: 7m 2s
- Token stats (this run): cost max 60030, cost median 39391.5, cost p95 60030
- Suite verdict: FAIL
- Judge comparison: clear 0, none 1, worse 0, inconclusive 0

<!-- JUDGE_REPORT_START -->
## Judge Report

- Suite verdict: FAIL
- Judge token cost: 365085

## Executive Summary

Both ZG-001 variants produced working Zig submissions: `zig build test`, `zig build bench -Doptimize=ReleaseFast`, and the verification compiler-command listing all exited 0 for both. The skill run showed better benchmark/test instrumentation and added a caller-owned-output API, but the no-skill run made the same core hot-loop optimization and achieved comparable or slightly better same-boundary benchmark timings. Therefore the suite does not show a clear skill benefit.

## Case Outcomes

| Case | Variant | Task pass | Key evidence |
|---|---:|---:|---|
| ZG-001 | skill | true | tests exit 0; benchmark exit 0; benchmark reports `processBatch` and `processBatchInto` boundaries with checksum `37078917.601` |
| ZG-001 | noskill | true | tests exit 0; benchmark exit 0; checksum `37078917.601` |

## Clear Skill Wins

None at bundle level. The skill variant added useful artifacts (`processBatchInto`, warmup/boundary benchmark output, extra tests), but it did not clearly beat the no-skill variant on the main optimized `processBatch` timing.

## No Clear Win or Regressions

- Verification benchmark: skill `processBatch` was `37179000 ns`; no-skill was `30111000 ns`.
- Verification verbose benchmark: skill `processBatch` was `29036000 ns`; no-skill was `28823000 ns`.
- Judge rerun produced overlapping timings: skill `processBatch` 31.2-32.0 ms, skill `processBatchInto` 29.9-34.6 ms, no-skill 30.7-32.8 ms.
- Code diff shows both variants have the same optimized `scorePacket` shape; skill-only changes are the reusable-output API, benchmark formatting/warmup, and additional tests.

## Skill Feedback

- Keep the Zig benchmarking guidance that led to pre-change timing and explicit benchmark boundaries.
- Add guidance to require repeated same-boundary measurements before claiming an optimization win; one skill-only reusable-output path was not consistently faster in verification or judge reruns.
- Encourage tying added APIs to measured workload wins. `processBatchInto` is plausible for repeated batches, but the submitted evidence did not show a decisive advantage over the no-skill public API path.

## Evidence Notes

- Skill verification: `cases/ZG-001/skill/verification-output.md`.
- No-skill verification: `cases/ZG-001/noskill/verification-output.md`.
- Judge rerun timings saved in `evidence/ZG-001-bench-rerun.txt`.
- Source diff saved in `evidence/ZG-001-src-diff.patch`.

## Routing and Process Issues

- Skill routing was as expected: Zig skill plus `benchmarking.md` and `machine-level-hypotheses.md` were read.
- Skill process trace shows tests and optimized benchmark runs, including a pre-change benchmark of `665335042 ns`.
- The visible sanitized trace does not show agent-run disassembly/symbol inspection; 47 skill steps are omitted, so process evidence is incomplete there.
- No-skill trace shows tests and optimized benchmark after edits, but no skill/reference routing and no pre-change timing.

## Artifact Pointers

- Skill submitted code: `cases/ZG-001/skill/project/src/main.zig`, `build.zig`.
- No-skill submitted code: `cases/ZG-001/noskill/project/src/main.zig`, `build.zig`.
- Routing files: `cases/ZG-001/skill/routing.md`, `cases/ZG-001/noskill/routing.md`.

<!-- JUDGE_REPORT_END -->

## Case Rows
<!-- UNPAIRED_TABLE_START -->
| Case | Mode | Task | Judge | Cost | Cached | Turns | Skills Read | Skill Files Read | Refs Read | Missing Refs | Unexpected Refs | Notes | Run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ZG-001:noskill | single | PASS | BASELINE OK | 18753 | 19968 | 1 | 0 | 0 | 0 | - | - |  | 2026-08-02 |
| ZG-001:skill | single | PASS | NO CLEAR WIN | 60030 | 230400 | 1 | 1 | 1 | 2 | - | - |  | 2026-08-02 |
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
- **ZG-001**: none; bundle fail. skill: task pass (`zig build test` and `zig build bench -Doptimize=ReleaseFast` exited 0, and the submitted code removes hot-loop allocation/repeated work while preserving checksum `37078917.601`.); noskill: task pass (`zig build test` and `zig build bench -Doptimize=ReleaseFast` exited 0, and the submitted code removes hot-loop allocation/repeated work with checksum `37078917.601`.)

## Task Failures
- **ZG-006:noskill** (single): TASK_FAILURE: verification 'harness black-box sample tests' failed: exit 1; TASK_FAILURE: verification 'optimized benchmark' failed: exit 1; TASK_FAILURE: verification 'filtered assembly probe' failed: exit 1
