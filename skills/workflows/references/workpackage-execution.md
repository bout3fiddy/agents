# Work Package Execution

Continuous, subagent-verified execution of work packages. Load this when the user wants autonomous end-to-end WP execution with independent verification, progressive PRs, and validation gates.

Assumes familiarity with `work-packages.md` — this workflow governs *how* to execute, not how to structure WPs.

## Prerequisites

Before starting, resolve all placeholders:

- `<WORK_PACKAGE_PATH>` — path to the WP directory
- `<DOMAIN_SKILLS>` — skills the verification subagent must load (e.g. `zig`, `coding`)
- `<VALIDATION_COMMAND>` — command or procedure to produce a validation artifact after all WPs (optional, omit if not applicable)
- `<VALIDATION_REFERENCE>` — path to a known-good reference for comparison (optional)
- `<REMOTE_BRANCH>` — branch to push to

## Execution loop

Do not stop until all work packages are complete. This prompt is idempotent — repeated invocations resume from the first non-done WP.

### For each WP item:

#### 1. Implement

Read `overview.md`, the WP item's demands, and any audit/context docs. Implement the fix. Use subagents for research, vendored code inspection, or parallel investigation when the WP touches multiple concerns.

#### 2. Verify with an independent subagent

After implementation, spawn one or more verification subagents. Verifiers are independent auditors — they must NOT trust self-reported status.

Use multiple verifiers when the WP spans different concerns. Examples:

- **Correctness verifier** — loads domain skills (`<DOMAIN_SKILLS>`), reads WP demands, reviews code changes, confirms the implementation actually does what the WP requires.
- **Context verifier** — reads vendored/reference code, upstream docs, or adjacent modules to confirm the changes are consistent with the broader codebase.
- **Test/build verifier** — runs tests, checks compilation, confirms nothing regressed.

At minimum, always spawn a correctness verifier. Add context and test verifiers when the WP touches unfamiliar code, vendored dependencies, or cross-module boundaries. Use your judgment — 1 verifier for a trivial change, 2–3 for anything substantial.

Each verification subagent must:

1. Load the relevant domain skills.
2. Read `overview.md`, the WP item's requirements, and any audit docs.
3. Read the actual code changes (`git diff` of the WP's commits).
4. Confirm each Completion Checklist item against the code, not just the checkbox state.
5. Return a verdict: **pass** (work matches demands) or **fail** (with specific gaps).

Run verifiers in parallel when they are independent of each other.

If **any** verifier returns **fail**: fix the gaps and re-verify with the failing verifier. Do not advance.

If **all** verifiers return **pass**: check off all Completion Checklist boxes, mark `[Status: Done]`, update `overview.md`.

#### 3. Commit, push, and open PR early

```bash
git add <changed-files>
git commit -m "<WP-XX summary>"
git push origin <REMOTE_BRANCH>
```

After the first WP is pushed, open a draft PR if none exists:

```bash
gh pr create --draft --title "<WP title>" --body "Work in progress — WPs being executed sequentially."
```

This triggers code review bots early so feedback accumulates in parallel with remaining WPs.

#### 4. Advance to next WP

Move to the next non-done item. Repeat from step 1.

## Validation gate (after all WPs complete)

Skip this section if no `<VALIDATION_COMMAND>` was provided.

1. Run `<VALIDATION_COMMAND>` to produce a validation artifact.
2. Compare the output against `<VALIDATION_REFERENCE>` — visually, numerically, or structurally as appropriate.
3. Make a qualitative judgment: does the output match expectations?

If validation **passes**: proceed to PR review.

If validation **fails**:

1. Do not guess at fixes or take shortcuts. This is the systematic failure analysis phase.
2. Identify the specific discrepancy between output and reference.
3. Trace the discrepancy back to a code path — use subagents to investigate individual modules if needed.
4. Fix the root cause, re-run validation, and repeat until it passes.
5. Commit and push each fix.

## PR review chain

Once all WPs are verified and validation passes (if applicable):

1. Mark the PR as ready for review (remove draft status).
2. Load and follow `references/pr-review.md` — the full remediation loop with action-aware polling.
3. Do not stop until all review comments are addressed and CI is green.

## Hard rules

- **Do not stop mid-execution.** If you hit a blocker on one WP, note it and attempt the next. Return to blocked items after.
- **Verification is mandatory and independent.** Never self-certify a WP as done. Always use verification subagents.
- **Scale verification to complexity.** 1 verifier for trivial changes, 2–3 for substantial WPs spanning multiple concerns. Run them in parallel.
- **Subagents must load domain skills.** A verifier without the right skill context will miss domain-specific issues.
- **No shortcuts in failure analysis.** When validation fails, systematic root-cause investigation only. No "try this and see" loops.
- **Early PR, always.** Open the PR after the first push. The earlier review bots start, the less rework at the end.
- **Commit per WP.** Each WP gets its own commit (or small commit group). Do not batch all WPs into one commit.
