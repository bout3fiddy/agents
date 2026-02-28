# TODO: Eval Harness Integrity Fixes

Date: 2026-02-28
Scope: `skills-evals/pi-eval` with focus on `CD-015` and `CD-015-NS`

## Non-Negotiable Policy
- Skill mounting is forbidden. Any runtime use of `--skill` is bad code.
- Eval workers must run only inside an isolated temporary sandbox (temporary workspace + temporary HOME).
- The harness may provide skills/global directives only via sandbox bootstrap/sync into the temporary HOME (all-or-none profile).
- Eval code must never write to user home (`~/...`) and must never depend on host-global paths such as `~/.agents/...`.

## Explicit Problem Statement
The current harness mixes telemetry-based inference, runtime mounting behavior, and non-isolated no-skill execution. This breaks the required comparison model:
- `CD-015`: isolated sandbox with full bootstrap payload (global directives + skills/router artifacts) in temp HOME.
- `CD-015-NS`: isolated sandbox with no bootstrap payload.

## Consolidated Findings

### 1) Skill invocation is scored from the wrong source
- Current scoring treats skill usage as read-capture only.
- Runtime `--skill` behavior still exists in the execution path, which violates policy.
- Result: false/ambiguous failures (`missing skill`) and no authoritative proof of harness-provided skill availability.
- Proposed solution:
  - Delete all runtime `--skill` injection paths in eval execution.
  - Add a bootstrap manifest written by the harness in the sandbox that declares available skills/refs for the case.
  - Score `expectedSkills` against bootstrap manifest truth, not read telemetry.
  - Keep read-capture as a secondary signal only.

### 2) No-skill control is not hard-isolated
- `CD-015-NS` can still converge with skill behavior when repo paths remain readable.
- Deny lists are incomplete for no-skill profile.
- Result: contaminated no-skill baseline.
- Proposed solution:
  - Force per-case isolated sandboxes for both cases.
  - No-skill profile must skip bootstrap sync entirely.
  - Add hard deny for no-skill profile: `skills/**`, `instructions/**`, synced artifacts, and any host-home skill paths.
  - Fail fast if no-skill run attempts to read forbidden skill/global paths.

### 3) Runtime model violates architecture intent
- Desired model: a PI agent runs inside sandbox and uses only what sandbox bootstrap provides.
- Actual model still contains runtime mechanisms that bypass this contract.
- Result: harness validity depends on prohibited behavior.
- Proposed solution:
  - Reduce runtime to: create sandbox -> configure temp HOME -> install/run PI agent -> run case prompts.
  - Remove code branches that pass skill-specific runtime args.
  - Enforce a single bootstrap switch: full payload or no payload.

### 4) Case design cannot prove isolation with current harness behavior
- `CD-015` and `CD-015-NS` are intentionally similar; that is fine.
- The issue is harness contamination, not prompt shape.
- Proposed solution:
  - Keep prompts equivalent except output file path.
  - Require evidence assertions:
    - skill mode: bootstrap manifest present and expected refs read.
    - no-skill mode: bootstrap manifest absent and zero reads under skill/global trees.
  - Add a regression case that intentionally tries to read `skills/coding/SKILL.md` in no-skill mode and must fail.

### 5) Reporting labels are misleading
- `missing skill` currently conflates availability vs read behavior.
- Proposed solution:
  - Split reporting categories:
    - `bootstrap_failures`
    - `routing_failures`
    - `telemetry_warnings`
    - `assertion_failures`
  - Replace ambiguous messages with explicit ones:
    - `missing bootstrap skill: <name>`
    - `missing routed reference: <path>`
    - `reference not read (telemetry): <path>`
  - Include per-case diagnostics: sandbox profile, bootstrap manifest hash, denied-read hits.

## Required Remediation Tasks
- [ ] Remove all runtime skill mounting code (`--skill`) from eval worker launch.
- [ ] Enforce per-case isolated sandboxes for `CD-015` and `CD-015-NS`.
- [ ] Implement two explicit bootstrap profiles:
  - [ ] `full_payload` (skill case)
  - [ ] `no_payload` (no-skill case)
- [ ] Add bootstrap manifest output and use it as skill-availability source-of-truth.
- [ ] Expand no-skill deny rules to block all skill/global directive paths, including host-home paths.
- [ ] Add guards/tests that fail if eval process writes outside sandbox temp dirs (including `~/`).
- [ ] Update scoring/reporting taxonomy to remove ambiguous `missing skill` semantics.
- [ ] Add regression tests for forbidden reads and profile correctness.

## Verification Criteria After Fix
- `CD-015` passes only when bootstrap profile is `full_payload` and expected skill/reference evidence is present.
- `CD-015-NS` passes only when bootstrap profile is `no_payload` and skill/global reads are zero/forbidden.
- No eval run writes to host `~/` paths.
- Reports clearly separate bootstrap availability failures from read telemetry behavior.
