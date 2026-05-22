NOTICE: This is auto-generated on each run of the evals framework. Do not edit this.

# Pi Eval Report

- Model: openai-codex/gpt-5.5
- Commit: 7cf46eb
- Cases path: skills-evals/fixtures/eval-cases
- Run: 2026-05-22T10:37:31.738Z
- Run scope: full
- Runs executed: 11 (11 rows)
- Task rows: 11 (pass 10, fail 1, skip 0)
- Runs in spec: 11
- Duration: 19m 28s
- Token stats (this run): cost max 106903, cost median 24076, cost p95 106903
- Suite verdict: PASS
- Judge comparison: clear 3, none 1, worse 1, inconclusive 1

<!-- JUDGE_REPORT_START -->
## Judge Report

- Suite verdict: PASS
- Judge token cost: 1963119

# Executive Summary

Skill benefit is clear overall but mixed. The skill variants clearly won ZG-006, ZG-008, and ZG-009; ZG-007 passed as a single-variant run with no baseline comparison. ZG-001 regressed versus the no-skill benchmark, and ZG-005 had no clear skill win under a judge same-boundary harness.

# Case Outcomes

| Case | Bundle | Skill benefit | Variant task outcomes | Key evidence |
|---|---:|---|---|---|
| ZG-001 | fail | worse | skill pass; noskill pass | no-skill benchmark elapsed_ns=31647000 vs skill processBatch=35401000 and processBatchInto=42142000 |
| ZG-005 | fail | none | skill pass; noskill pass | both black-box tests pass; judge same-boundary run had noskill 22422625 ns vs skill 23189291 ns |
| ZG-006 | pass | clear | skill pass; noskill fail | noskill black-box sample test exit 1; skill exit 0 |
| ZG-008 | pass | clear | skill pass; noskill pass | judge same-boundary prepared scoring: skill 3319917 ns vs noskill 5234833 ns, same checksum |
| ZG-009 | pass | clear | skill pass; noskill pass | public benchmark: skill 9346000 ns vs noskill 12037000 ns, same checksum |
| ZG-007 | pass | inconclusive | single pass | caller-owned black-box tests pass; no baseline exists |

# Clear Skill Wins

- ZG-006: skill passed the black-box caller-owned stats semantics; no-skill failed with an uninitialized/accumulated stats count.
- ZG-008: skill preserved route semantics and was faster than no-skill under the same judge-created repeated-batch boundary.
- ZG-009: skill preserved ordered first-match semantics and beat no-skill on the same public evaluateAccess benchmark boundary.

# No Clear Win or Regressions

- ZG-001: both variants passed tests, but the skill variant was slower than no-skill on the optimized benchmark outputs.
- ZG-005: both variants passed the task, but a same-boundary judge harness did not show a skill speed win.
- ZG-007: the submitted run passed, but there is no baseline, so skill-vs-baseline benefit is inconclusive.

# Skill Feedback

- Keep the Zig routing to benchmarking and machine-level references: all skill variants read the expected skill and refs, and the strongest wins used dense preparation, caller-owned buffers, and targeted timing.
- Add stronger guidance to verify exact same-boundary performance before claiming speedups; ZG-001 and ZG-005 show benchmark/process improvements without a clear submitted performance win.
- Keep caller-owned output initialization guidance: ZG-006 skill cleared output stats and passed; no-skill updated undefined caller storage and failed black-box checks.
- Keep hot-boundary inspection patterns like ZG-007 codegen ladder; prefer symbol-focused allocation/call checks over only verbose compiler command listings.

# Evidence Notes

- Verification outputs are primary evidence. Judge-created focused timing scripts are under evidence/ and were used only to compare submitted code on identical boundaries.
- Timing claims cite internal elapsed_ns with matching checksums where available; command wall durations were not used as decisive speed evidence.

# Routing and Process Issues

- No routing gaps were found for skill variants: each read the Zig skill plus benchmarking.md and machine-level-hypotheses.md.
- ZG-001 had a stronger skill process trace than no-skill, but the final optimized benchmark still favored no-skill.
- ZG-005 skill produced a better-shaped benchmark, but the core evaluator did not beat no-skill in the judge same-boundary harness.

# Artifact Pointers

- Verification: cases/*/*/verification-output.md
- Routing: cases/*/*/routing.md
- Submitted code: cases/*/*/project/src/main.zig and cases/ZG-008/*/project/src/route.zig
- Judge focused scripts/output: evidence/zg005_same_boundary_reversed.zig, evidence/zg008_same_boundary.zig, evidence/judge-focused-runs.txt

## Skill Feedback

- Keep the Zig benchmarking and machine-level references in the routing payload; clear wins in ZG-006, ZG-008, and ZG-009 align with caller-owned output, dense enum-indexed preparation, and focused timing evidence.
- Strengthen guidance to require same-boundary before/after checks on the exact hot API before claiming optimization; ZG-001 skill was slower than no-skill, and ZG-005 did not beat no-skill in a controlled judge harness.
- Emphasize initialization semantics for caller-owned output buffers; ZG-006 skill passed because stats storage was reset, while no-skill failed black-box tests on undefined stats.
- Encourage symbol-focused generated-code/allocation checks like ZG-007 instead of relying only on verbose compiler command listings.
- The skill guidance led to extra benchmark/API work, but the submitted optimized public and caller-owned boundaries were slower than the no-skill optimized benchmark; require same-boundary validation before final claims.
- The skill variant produced a better-shaped benchmark with iterations and warmup, but it did not demonstrate a core evaluator speed win over no-skill on an identical judge boundary.
- Keep guidance around caller-owned output buffers and enum-indexed preparation; the skill variant initialized stats storage and passed the black-box semantics that no-skill failed.
- The skill guidance should keep emphasizing prepared repeated-batch state and avoiding wide hot-loop copies; this was measurable on a same-boundary judge harness.
- Keep the ordered-semantics regression test plus dense lookup preparation guidance; the skill variant improved the public benchmark boundary while preserving first-match behavior.
- The single submitted run passed and showed strong hot-boundary evidence, but there is no no-skill baseline in this case, so do not count it as comparative skill benefit.

<!-- JUDGE_REPORT_END -->

## Case Rows
<!-- UNPAIRED_TABLE_START -->
| Case | Mode | Task | Judge | Cost | Cached | Turns | Skills Read | Skill Files Read | Refs Read | Missing Refs | Unexpected Refs | Notes | Run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ZG-001:noskill | single | PASS | BASELINE OK | 26699 | 57856 | 1 | 0 | 0 | 0 | - | - |  | 2026-05-22 |
| ZG-001:skill | single | PASS | SKILL WORSE | 106903 | 197632 | 1 | 1 | 1 | 2 | - | - |  | 2026-05-22 |
| ZG-005:noskill | single | PASS | BASELINE OK | 10562 | 19968 | 1 | 0 | 0 | 0 | - | - |  | 2026-05-22 |
| ZG-005:skill | single | PASS | NO CLEAR WIN | 24076 | 64512 | 1 | 1 | 1 | 2 | - | - |  | 2026-05-22 |
| ZG-006:noskill | single | FAIL | BASELINE FAIL | 12233 | 14848 | 1 | 0 | 0 | 0 | - | - | TASK_FAILURE: verification 'harness black-box sample tests' failed: exit 1 | 2026-05-22 |
| ZG-006:skill | single | PASS | SKILL WIN | 22805 | 89088 | 1 | 1 | 1 | 2 | - | - |  | 2026-05-22 |
| ZG-007 | single | PASS | STANDALONE OK | 75487 | 375808 | 1 | 1 | 1 | 2 | - | - |  | 2026-05-22 |
| ZG-008:noskill | single | PASS | BASELINE OK | 20730 | 85504 | 1 | 0 | 0 | 0 | - | - |  | 2026-05-22 |
| ZG-008:skill | single | PASS | SKILL WIN | 43756 | 286720 | 1 | 1 | 1 | 2 | - | - |  | 2026-05-22 |
| ZG-009:noskill | single | PASS | BASELINE OK | 23237 | 46080 | 1 | 0 | 0 | 0 | - | - |  | 2026-05-22 |
| ZG-009:skill | single | PASS | SKILL WIN | 43431 | 227328 | 1 | 1 | 1 | 2 | - | - |  | 2026-05-22 |

## Comparison Outcomes
- **ZG-001**: worse; bundle fail. skill: task pass (zig tests, optimized benchmark, and optimized compiler command listing all exited 0.); noskill: task pass (zig tests, optimized benchmark, and optimized compiler command listing all exited 0.)
- **ZG-005**: none; bundle fail. skill: task pass (Single-file shape, black-box rule tests, Zig tests, benchmark, and assembly probe all exited 0.); noskill: task pass (Single-file shape, black-box rule tests, Zig tests, benchmark, and assembly probe all exited 0.)
- **ZG-006**: clear; bundle pass. skill: task pass (Single-file shape, black-box sample tests, Zig tests, benchmark, and assembly probe all exited 0.); noskill: task fail (The harness black-box sample tests failed with exit 1 despite local Zig tests passing.)
- **ZG-008**: clear; bundle pass. skill: task pass (Black-box route semantics, Zig tests, optimized benchmark, and compiler command listing all exited 0.); noskill: task pass (Black-box route semantics, Zig tests, optimized benchmark, and compiler command listing all exited 0.)
- **ZG-009**: clear; bundle pass. skill: task pass (Black-box ordered-rule semantics, Zig tests, optimized benchmark, and compiler command listing all exited 0.); noskill: task pass (Black-box ordered-rule semantics, Zig tests, optimized benchmark, and compiler command listing all exited 0.)
- **ZG-007**: inconclusive; bundle pass. single: task pass (Black-box caller-owned semantics, Zig tests, optimized benchmark, and json codegen ladder all exited 0.)

## Task Failures
- **ZG-006:noskill** (single): TASK_FAILURE: verification 'harness black-box sample tests' failed: exit 1
