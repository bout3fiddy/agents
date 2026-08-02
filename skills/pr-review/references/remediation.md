# PR Review Remediation

Use current remote state and executable evidence to drain actionable feedback on
an existing pull request.

## 1. Resolve the target

- Identify the repository, PR number, branch, and current head commit.
- Confirm the local checkout corresponds to the PR head before editing.
- Read the PR description, requested reviewers, reviews, inline comments,
  unresolved review threads, and required checks.
- Use thread-aware GraphQL or an equivalent API when flat comment endpoints do
  not expose resolution state or inline context.

If the request is inspection-only, stop after reporting findings. Do not infer
authorization to edit, push, resolve threads, or merge.

## 2. Classify findings

Classify each current finding against the code and repository contract:

- **Actionable:** correctness, security, data loss, API-contract, test, or CI
  problem; or a requested change that clearly improves the submitted patch.
- **Optional:** subjective style, unrelated cleanup, or a low-value suggestion
  outside the patch's purpose.
- **Invalid or stale:** contradicted by source/tests, already fixed at the current
  head, or attached to superseded code.
- **Needs a decision:** multiple valid behaviors or a product/API choice the
  user must make.

Prioritize impact over reviewer severity labels. Do not change unrelated code to
silence a suggestion.

## 3. Fix and verify

For each actionable finding:

1. Make the smallest coherent fix.
2. Add or update focused coverage when behavior is reproducible.
3. Run the narrow relevant checks, then any repository-required gate.
4. Re-read the diff for regressions or accidental scope growth.

Address CI failures from the current head even when no reviewer mentioned them.
Do not claim a remote check is fixed solely because a different local command
passes.

## 4. Publish intentionally

When the user requested remediation through the PR:

- Stage exact shipping paths and inspect the staged set.
- Commit with a message tied to the remediation.
- Push the intended branch and record the new head commit.
- Never force-push, merge, or alter unrelated commits without explicit scope.

## 5. Respond to threads

- For a fixed finding, reply with the change and validation evidence, then
  resolve the thread when repository practice permits it.
- For an invalid or stale finding, reply with concrete source or test evidence.
  Resolve it only when the disagreement is actually settled.
- For an optional or deferred finding, explain the scope decision. Do not mark a
  disputed human thread resolved merely to satisfy a zero-thread gate.
- Do not post acknowledgements to praise or purely informational comments unless
  a response is useful.

## 6. Re-read remote state

After every push, monitor current checks and review activity using the available
GitHub state or wait mechanism. Poll based on actual pending state with a bounded
interval; do not use fixed multi-minute sleeps or bot-specific timing guesses.

Before concluding, fetch fresh state and confirm:

- the head commit is still the commit you reviewed;
- required checks for that head completed successfully;
- no unresolved actionable thread remains;
- no new requested change or inline finding arrived after the last push.

If reviews or checks remain pending, report that live state instead of claiming
the loop is drained. Merge only when the user requested it and all repository
merge conditions are satisfied.
