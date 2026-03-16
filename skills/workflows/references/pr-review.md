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

Code review agents typically take ~13 minutes but may finish sooner or later. Do NOT blindly sleep — poll GitHub Actions to know when they're actually done.

#### Polling procedure

1. **Initial wait** — sleep 60 seconds after pushing to let workflows trigger.

2. **Check action status** — query pending/in-progress runs on the PR's head branch:

```bash
gh run list --branch <HEAD_BRANCH> --limit 10 --json status,name,conclusion,createdAt
```

3. **Assess state**:
   - If any run has `status: "in_progress"` or `status: "queued"` — code review agents are still working. Sleep 60 seconds and check again.
   - If all runs have `status: "completed"` — agents are done. Proceed immediately to step **(g)**.
   - If no runs appear after 2 minutes — the push may not have triggered workflows. Fall back to `gh pr checks <PR>` to verify, then sleep 60 seconds and retry once. If still nothing after 4 minutes total, proceed to **(g)** and rely on comment-based detection.

4. **Repeat polling** at 60-second intervals until all runs complete or a 15-minute ceiling is hit. If the ceiling is reached with runs still in progress, proceed anyway and note the incomplete runs.

#### Why not blind sleep

A 13-minute sleep misses two cases: (a) agents finish in 5 minutes and you waste 8 minutes waiting, (b) agents take 18 minutes and you proceed too early, missing their findings. Action-aware polling handles both.

### g) Fetch new comments and repeat

Go back to step **(a)**. Fetch comments again and check for new findings from reviewers or code review bots. If there are new actionable comments, fix them and repeat the loop. If there are no new actionable comments, the loop is done.

## Exit condition

The loop ends when:

- All GitHub Actions runs on the head branch have completed
- No new actionable review comments after agents finish
- CI checks are passing

Summarize the final state to the user: what was fixed, what was deferred (if any), and current CI status.

## Guardrails

- Do not push unvalidated changes.
- Do not defer failing CI without explanation.
- Treat fallback-first implementations as actionable defects by default.
- If the PR lacks permissions or is in a fork, report it and ask for access.
