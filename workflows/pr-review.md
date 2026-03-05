# PR Review Remediation Loop

Load this workflow when the task is iterative PR-review remediation (fix reviewer/bot feedback, iterate until clean).

## Workflow

1. Triage new findings from reviewers and CI.
2. Fix true positives with relevant tests.
3. Respond on each review thread (fix applied or rationale for deferral).
4. Keep CI green.
5. Iterate until no actionable findings remain.

## Guardrails

- Do not push unvalidated changes.
- Do not defer failing CI without explanation.
- Treat fallback-first implementations as actionable defects by default.

## 1) Identify the target PR

- Prefer the latest **updated** open PR unless the user specifies another PR.
- If multiple repos are present, ask which repo.

```bash
gh pr list --state open --limit 10 --sort updated
```

- Capture PR number, title, head branch, base branch, and author.

## 2) Fetch feedback and CI signal

Gather two kinds of feedback:

1) **Review comments** (inline) and review summaries
2) **Issue comments** on the PR

```bash
gh pr view <PR> --comments
gh pr view <PR> --json reviewThreads,reviews,comments --jq '.'
```

If review threads are missing, fall back to API:

```bash
gh api repos/:owner/:repo/pulls/<PR>/comments
```

For CI:

```bash
gh pr checks <PR>
gh run list --branch <head-branch> --limit 5
gh run view <RUN_ID> --log
```

## 3) Organize feedback into a fix plan

Create a checklist grouped by file/component (or by reviewer if unclear). Mark CI failures separately at the top.

Classify each item:

- **Must fix**: Required by reviewer or CI failure
- **Should fix**: Strong suggestion or quality issue
- **Consider**: Optional / stylistic
- **Must fix (code-smell)**: Newly introduced fallback/compatibility branches unless explicitly requested and time-bounded

## 4) Fix loop (one by one)

For each item:

1) Make the smallest safe change
2) Update or add tests if behavior changes
3) Run targeted tests first, then broader tests if needed

Keep a running checklist and mark items done as you go.

## 5) CI failure loop

1) Reproduce locally if possible
2) Fix the root cause (not just the symptom)
3) Re-run the specific failing tests locally
4) Re-run the overall test suite if the change is risky

If the failure depends on environment, call that out and suggest a mitigation.

## 6) Update PR & respond

- Push changes to the PR branch
- Summarize fixes in a review reply with checklist status
- If anything is deferred, state why and ask for confirmation

## Notes

- If the PR is in a fork or lacks permissions, report it and ask for access.
- If the PR has no comments and CI is green, confirm with the user before doing extra refactors.
- If tests are expensive, ask which subset to run.
