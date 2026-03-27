# Work Package Execution

Continuous, subagent-verified execution of work packages. Load this when the user wants autonomous end-to-end WP execution with independent verification, progressive PRs, and validation gates.

Assumes familiarity with `work-packages.md` — this workflow governs *how* to execute, not how to structure WPs.

The canonical package layout is:

- `docs/workpackages/<slug>/README.md`
- `docs/workpackages/<slug>/wp-XX-<slug>.md`

Do not assume `overview.md` exists.

## Prerequisites

Before starting, resolve all placeholders:

- `<WORK_PACKAGE_PATH>` — path to the WP directory
- `<DOMAIN_SKILLS>` — skills the verification subagent must load (e.g. `zig`, `coding`)
- `<VALIDATION_COMMAND>` — command or procedure to produce a validation artifact after all WPs (optional, omit if not applicable)
- `<VALIDATION_REFERENCE>` — path to a known-good reference for comparison (optional)
- `<REMOTE_BRANCH>` — branch to push to

## Execution loop

Do not stop until all work packages are complete. This prompt is idempotent — repeated invocations resume from the first non-done WP.

### Initial read order

1. Read `README.md` first.
2. Parse `## Critical Path` and the `## Packages` links.
3. Read the `# WP-XX ...` title, `Dependencies`, and status line from each
   `wp-XX-*.md`.
4. Select the first non-done runnable WP:
   - follow `## Critical Path` when present
   - otherwise use explicit `Dependencies`
   - otherwise fall back to numeric `WP-XX` order

Treat `README.md` as shared context and each `wp-XX-*.md` as the source of
truth for execution status.

### Momentum rule

A work package is not finished until its Completion Checklist is fully verified by an independent subagent and its status reads `[Status: Done]`. Everything before that point is **mid-flight** — you must keep going.

**None of these are reasons to stop:**

- You just pushed a commit or opened a PR
- A subagent returned a pass verdict on one part of the WP
- Compilation or tests succeeded on a partial implementation
- You produced a meaningful intermediate result
- The response is getting long
- You feel like a "natural checkpoint" has been reached

**The only valid reasons to stop are:**

- Every WP is `[Status: Done]` and the PR review chain is complete (you're finished)
- You need information or a decision only the user can provide (ask, then resume)
- An unrecoverable external failure blocks all remaining WPs (report it)

If you catch yourself about to yield and the current WP is not done, that is the signal to keep working — not to stop.

### For each WP item:

#### 1. Implement

Read `README.md`, the active WP file, any dependency WP files that constrain it,
and any audit/context docs. Implement the fix. Use subagents for research,
vendored code inspection, or parallel investigation when the WP touches
multiple concerns.

#### 2. Verify with an independent subagent

After implementation, spawn one or more verification subagents. Verifiers are independent auditors — they must NOT trust self-reported status.

Use multiple verifiers when the WP spans different concerns. Examples:

- **Correctness verifier** — loads domain skills (`<DOMAIN_SKILLS>`), reads WP demands, reviews code changes, confirms the implementation actually does what the WP requires.
- **Context verifier** — reads vendored/reference code, upstream docs, or adjacent modules to confirm the changes are consistent with the broader codebase.
- **Test/build verifier** — runs tests, checks compilation, confirms nothing regressed.

At minimum, always spawn a correctness verifier. Add context and test verifiers when the WP touches unfamiliar code, vendored dependencies, or cross-module boundaries. Use your judgment — 1 verifier for a trivial change, 2–3 for anything substantial.

Each verification subagent must:

1. Load the relevant domain skills.
2. Read `README.md`, the active WP file, and any audit docs.
3. Read the actual code changes (`git diff` of the WP's commits).
4. Confirm each Completion Checklist item against the code, not just the checkbox state.
5. Return a verdict: **pass** (work matches demands) or **fail** (with specific gaps).

Run verifiers in parallel when they are independent of each other.

If **any** verifier returns **fail**: fix the gaps and re-verify with the failing verifier. Do not advance.

If **all** verifiers return **pass**:

1. Check off the active WP file's Completion Checklist boxes individually.
2. Update:
   - status line
   - `## Implementation Status`
   - `## Why This Works`
   - `## Proof / Validation`
   - `## How To Test`
3. Mark the package `[Status: Done]` only after every checklist item is `[x]`.
4. Update `README.md` only if it contains progress text or sequencing context
   that would otherwise become stale.

#### 3. Selectively stage, then commit/push early

Treat work-package docs carefully:

- If the task is authoring or revising the work package plan, the docs are
  versioned deliverables and should ship.
- If the task is implementing code from an existing plan, keep the active WP doc
  current for resume state, but only stage those status/doc updates when the
  user asks for them, repo instructions require them, or the docs are themselves
  part of the deliverable.

Before every commit:

1. Build an explicit list of shipping files for this WP.
2. Check that list against ignored state with `git status --short --ignored` and `git check-ignore <path>` when unsure.
3. Stage only those exact paths. Never use `git add .`, `git add -A`, or `git add -f`.
4. Review `git diff --cached --name-only` and confirm no out-of-scope files
   slipped in.

```bash
git status --short --ignored
git add <intentional-shipping-files>
git diff --cached --name-only
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

- **Do not stop mid-execution — especially not mid-WP.** A commit, a push, a passing build, or a subagent verdict on one aspect of a WP are progress markers, not turn boundaries. The only exit from the loop is: all WPs done, user input required, or an unrecoverable external failure. If you hit a blocker on one WP, note it and attempt the next. Return to blocked items after.
- **Verification is mandatory and independent.** Never self-certify a WP as done. Always use verification subagents.
- **Scale verification to complexity.** 1 verifier for trivial changes, 2–3 for substantial WPs spanning multiple concerns. Run them in parallel.
- **Subagents must load domain skills.** A verifier without the right skill context will miss domain-specific issues.
- **Ignored files stay ignored.** Never force-add ignored files. `.gitignore` and repo-local ignore rules win unless the user explicitly overrides them.
- **Use the package docs that exist.** Read `README.md` first; do not invent or require `overview.md`.
- **A WP file is the completion record.** Status, proof, and test instructions live in the active `wp-XX-*.md` file.
- **WP docs do not all auto-ship.** Planning docs usually ship when you are authoring or revising the plan. Execution-status churn only ships when the user asks for it, repo instructions require it, or the docs are part of the deliverable.
- **No shortcuts in failure analysis.** When validation fails, systematic root-cause investigation only. No "try this and see" loops.
- **Early PR, always.** Open the PR after the first push. The earlier review bots start, the less rework at the end.
- **Commit per WP.** Each WP gets its own shipping commit (or small commit group). Do not batch all WPs into one commit, and do not let tracker-file churn hitch a ride.
