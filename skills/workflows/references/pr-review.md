# PR Review Remediation Loop

Load this workflow when the task is iterative PR-review remediation (fix reviewer/bot feedback, iterate until clean).

## 1) Identify the target PR

Prefer the latest **updated** open PR unless the user specifies another.

```bash
gh pr list --state open --limit 10 --sort updated
```

Capture PR number, head branch, and base branch.

## 2) Remediation loop

Repeat this loop until no actionable review comments remain.

### a) Fetch review comments

```bash
gh pr view <PR> --json reviewThreads,reviews,comments --jq '.'
```

If review threads are missing, fall back to:

```bash
gh api repos/:owner/:repo/pulls/<PR>/comments
```

Also check CI:

```bash
gh pr checks <PR>
```

### b) Classify findings

For each comment, classify:

- **True positive** — fix it
- **False positive / stylistic** — reply with rationale, no code change
- **CI failure** — fix root cause, not symptoms

### c) Fix true positives

For each true positive:

1. Make the smallest safe change.
2. Update or add tests if behavior changes.
3. Run targeted tests locally.

### d) Commit and push

```bash
git add <changed-files>
git commit -m "<summary of fixes>"
git push
```

### e) Respond on review threads

Reply to each addressed comment confirming the fix. For false positives or deferrals, state the rationale.

### f) Wait for code review agents

Code review agents take approximately 13 minutes to analyze the push and post new findings.

```bash
sleep 780
```

### g) Fetch new comments and repeat

Go back to step **(a)**. Fetch comments again and check for new findings from reviewers or code review bots. If there are new actionable comments, fix them and repeat the loop. If there are no new actionable comments, the loop is done.

## Exit condition

The loop ends when:

- No new actionable review comments after the wait
- CI checks are passing

Summarize the final state to the user: what was fixed, what was deferred (if any), and current CI status.

## Guardrails

- Do not push unvalidated changes.
- Do not defer failing CI without explanation.
- Treat fallback-first implementations as actionable defects by default.
- If the PR lacks permissions or is in a fork, report it and ask for access.
