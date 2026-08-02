# Work Package Execution

Execute an existing package dependency-by-dependency, using its completion
criteria as the definition of done.

## Initial read

1. Read the package `README.md`, critical path, shared rules, and package links.
2. Read each package's title, dependencies, and status without loading every
   detail up front.
3. Select the first non-done package whose dependencies are complete.
4. Read that package fully plus the source and references it names.

If the package is stale or contradicts current code, update the plan when that
artifact is in scope; otherwise report the discrepancy before implementing a
materially different design.

## Per-package loop

### 1. Implement

- Preserve the package's goals, non-goals, and shared invariants.
- Search current source before adding types, helpers, files, or configuration.
- Keep the change within the active package unless a dependency correction is
  required for correctness.
- Run focused checks as the implementation develops.

### 2. Verify completion

Check every completion item against code and executable evidence. Use an
independent verifier for substantial, high-risk, unfamiliar, or cross-module
packages; routine packages may rely on deterministic tests and direct diff
review. Independent verification should read the actual diff and return
specific pass/fail evidence rather than trusting status text.

Fix gaps and repeat verification before marking the package done.

### 3. Record evidence

When package documents are intended deliverables:

- check completed items individually;
- update `Implementation Status`, `Proof / Validation`, and `How to Test`;
- mark the package `Done` only when every completion item passes;
- update overview sequencing only when status changes affect the critical path.

Do not commit execution-status churn when package documents are ignored,
scratch-only, or outside the requested deliverable.

### 4. Commit coherently

- Build an explicit list of shipping files.
- Inspect ignored state and stage exact paths.
- Review the staged diff and validation evidence.
- Prefer one focused commit per package or coherent package sub-step.
- Push or open a PR only when the requested workflow includes publication.

Then select the next runnable package and repeat.

## Final validation

After all packages are complete:

1. Run the package-level and repository-level validation commands.
2. Compare generated or behavioral output with the named baseline when one
   exists.
3. Investigate discrepancies from evidence and source paths; do not cycle
   through speculative fixes.
4. Re-run the affected gates after every correction.

If a PR is part of the requested workflow, use the `pr-review` skill after the
implementation and required checks are ready.

## Stop conditions

Continue while a safe runnable package remains. Stop and report when:

- every package is complete and final validation passes;
- a user decision is required to choose among materially different contracts;
- required authority or credentials are missing;
- an external failure prevents meaningful progress across all remaining work.

A commit, push, partial test pass, or single verifier result is progress, not
proof that the active package is complete.
