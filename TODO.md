# TODO: Eval Harness Integrity Fixes

Date: 2026-02-28
Scope: `skills-evals/pi-eval` with focus on `CD-015` and `CD-015-NS`

## Explicit Problem Statement
The current eval harness does not reliably measure whether skills are invoked via the intended sandboxed skill-routing flow. It also allows no-skill control runs to access the same repository skill corpus, which invalidates apples-to-apples comparison between skill and no-skill cases.

## Consolidated Findings

### 1) Skill invocation is scored incorrectly
- Current scoring marks a skill as "invoked" only when skill/ref files are read through the `read` tool.
- Mounted skills passed via CLI (`--skill`) are not counted unless a read call happens.
- Result: false failures like `missing skill: coding` even when skill paths are mounted.

### 2) No-skill control is not hard-isolated
- `CD-015-NS` runs with `sandbox: false` and `read` allowed.
- Default deny paths block reports/case spec files, but do not block `skills/**`.
- Result: no-skill worker can still read skill files directly from repo and converge toward similar output.

### 3) Routing path mismatch with intended architecture
- Desired model: skill invocation must happen via harness-controlled sandbox routing logic.
- Actual model: worker process still depends on CLI `--skill` mounting behavior.
- Result: evaluation depends on CLI behavior rather than proving router/harness behavior.

### 4) Case design currently cannot prove isolation
- Both `CD-015` and `CD-015-NS` read the same contract file (`placeholder_example.py`) and produce deterministic target helpers.
- Without hard no-skill isolation from `skills/**`, output similarity is expected and not diagnostic.

### 5) Reporting interpretation risk
- "missing skill" in report currently means "no captured skill-file read", not "skill unavailable".
- This can mislead debugging and hide real harness gaps.

## Required Remediation Tasks

- [ ] Replace skill invocation scoring with explicit source-of-truth signals (e.g., mounted skill manifest from worker launch, plus optional read-capture as secondary telemetry).
- [ ] Enforce hard no-skill isolation for control cases:
  - [ ] sandbox on
  - [ ] deny `skills/**` reads and any synced skill dirs for `disableHarness` cases
  - [ ] keep prompt identical between skill/no-skill except skill mounting
- [ ] Remove CLI-mount-only dependency from pass criteria; validate against harness/router contract directly.
- [ ] Add worker-level telemetry fields that distinguish:
  - [ ] skills mounted
  - [ ] skills actually read
  - [ ] refs actually read
- [ ] Update failure messaging so `missing skill` cannot be emitted from read telemetry alone.
- [ ] Add regression cases that assert no-skill cannot read skill files and fails with explicit forbidden-read errors when attempted.

## Verification Criteria After Fix
- `CD-015` passes with explicit proof that skill route was mounted via harness and expected ref was read.
- `CD-015-NS` runs in isolated mode and cannot access `skills/**`.
- Report messages distinguish routing/mount failures from read-behavior failures.
- Skill/no-skill deltas are attributable to harness configuration, not repository leakage.
