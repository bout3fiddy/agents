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

For each comment, classify by **severity** and **type**:

- **P0 / P1 (high severity)** — bugs, security issues, correctness problems, data loss risks, CI failures. **Always fix these.**
- **P2 (low severity)** — style nits, naming preferences, minor refactors, "consider doing X", optional improvements. **Use judgement** (see below).
- **False positive** — reviewer or bot is wrong. Reply with rationale, no code change.

#### Handling low-severity (P2) findings

Low-severity findings from code review bots can trigger endless remediation loops: you fix a nit, push, the bot finds another nit, you fix that, push again, and so on. This is counterproductive.

**On the first pass**, fix P2 findings if they are quick and clearly beneficial. **On subsequent passes** (second loop iteration or later), apply this rule:

- If the new P2 finding was **introduced by your own fix** in this loop — fix it (you caused it).
- If the new P2 finding is a **pre-existing nit** the bot only now flagged, or a **subjective style preference** — acknowledge it in a reply, explain it's low severity and not blocking, then resolve the thread. Do not change code.
- If the **same bot keeps raising new P2s on each push** — stop the loop. Reply to the remaining findings with a brief rationale, resolve the threads, and proceed to the exit condition. Note in the summary that remaining low-severity items were intentionally deferred.

The goal is convergence, not perfection. A PR that fixes all P0/P1 issues and ships is better than one stuck in an infinite P2 nit cycle.

### c) Fix actionable findings

For each finding you've decided to fix:

1. Make the smallest safe change.
2. Update or add tests if behavior changes.
3. Run targeted tests locally.

### d) Commit and push

```bash
git add <changed-files>
git commit -m "<summary of fixes>"
git push
```

### e) Respond to and resolve ALL review threads

**Every review comment must get a reply and be resolved.** Some repos block merging until all conversation threads are marked resolved — leaving even one unresolved blocks the entire PR.

For each review thread:

1. **True positive (fixed)** — reply confirming the fix with a brief description of the change, then resolve the thread.
2. **False positive / stylistic** — reply with a clear rationale explaining why no change is needed, then resolve the thread.
3. **Deferred** — reply explaining why it's deferred and what the follow-up plan is, then resolve the thread.
4. **Informational / praise** — reply with a brief acknowledgement (e.g. "Thanks!" or "Noted"), then resolve the thread.

```bash
# Reply to a review comment
gh api repos/:owner/:repo/pulls/<PR>/comments/<COMMENT_ID>/replies -f body="<response>"

# Resolve a review thread (requires the thread's graphql node ID)
gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "<THREAD_NODE_ID>"}) { thread { isResolved } } }'
```

**Zero unresolved threads is the exit target.** After responding, verify with:

```bash
gh pr view <PR> --json reviewThreads --jq '[.reviewThreads[] | select(.isResolved == false)] | length'
```

If this returns anything other than `0`, find and resolve the remaining threads before proceeding.

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

#### Codex review agents (no GitHub Action)

Some review agents (e.g. Codex) respond directly as PR comments on each push but have **no associated GitHub Actions run**. You cannot detect their activity via `gh run list`. Instead:

1. **Infer expected wait time from prior comments.** After pushing, fetch all review comments on the PR and look at timestamps from the Codex review agent's previous responses. Calculate the typical delay between a push and the agent's comment (e.g. if the last three Codex comments arrived 4m, 5m, and 6m after their triggering pushes, expect ~5–6 minutes).

2. **Wait based on inferred timing.** Sleep for the inferred duration (or a minimum of 3 minutes if no prior data exists), then fetch comments to check whether the agent has responded to the latest push.

3. **Identify the agent's comments.** Match by author (bot account or consistent username) and timestamp (must be after your most recent push). If a new comment from the agent exists, process it. If not, wait another 60 seconds and retry, up to a ceiling of the inferred time + 3 minutes buffer.

4. **First push on a PR (no prior data).** If there are no previous Codex review comments to calibrate from, fall back to a 5-minute initial wait, then poll at 60-second intervals for up to 10 minutes total.

#### Why not blind sleep

A 13-minute sleep misses two cases: (a) agents finish in 5 minutes and you waste 8 minutes waiting, (b) agents take 18 minutes and you proceed too early, missing their findings. Action-aware polling handles both.

#### Codex grace window after Cursor BugBot skips

Codex is unpredictable: it will sometimes finish well after the other reviewers, and Cursor BugBot frequently posts a "skipping review" comment that *looks* like the loop is done while Codex is still thinking. Do not exit immediately when BugBot skips — its silence is not a signal that Codex is also done.

After Cursor BugBot has posted its skip comment (or otherwise concluded with no findings), keep polling for new review comments for **at least 5 additional minutes** before treating the loop as drained. Fetch comments at 60-second intervals during this grace window and, if a Codex comment lands, process it through the normal classify/fix/respond loop and reset the window. This prevents missing valuable late Codex feedback.

### g) Fetch new comments and repeat

Go back to step **(a)**. Fetch comments again and check for new findings from reviewers or code review bots. If there are new actionable comments, fix them and repeat the loop. If there are no new actionable comments, the loop is done.

## Exit condition

The loop ends when:

- All GitHub Actions runs on the head branch have completed
- No new actionable review comments after agents finish, including a 5-minute Codex grace window past any Cursor BugBot skip
- CI checks are passing
- **All review threads are resolved** (zero unresolved threads)

Summarize the final state to the user: what was fixed, what was deferred (if any), and current CI status.

## Guardrails

- Do not push unvalidated changes.
- Do not defer failing CI without explanation.
- Treat fallback-first implementations as actionable defects by default.
- If the PR lacks permissions or is in a fork, report it and ask for access.
