# GH PR Review + CI Fix Workflow (Reference)

Follow this workflow to find the latest PR, gather reviewer feedback + CI failures, organize them, and fix them one by one.

## If no repo/PR context is provided
- Ask for the PR link or repo/branch details.
- Provide a checklist of steps without running commands.
- If file reads or commands fail due to missing context, stop and ask for repo/PR details (do not keep scanning).
- Do not run gh commands without a specific repo/PR.

## 1) Identify the target PR

- Prefer the latest **updated** open PR unless the user specifies another PR.
- If multiple repos are present, ask which repo.
- Use gh to list recent PRs:

```bash
gh pr list --state open --limit 10 --sort updated
```

- If the user wants "latest created" instead of updated, sort by created.
- Capture PR number, title, head branch, base branch, and author.

## 2) Fetch feedback and CI signal

Gather two kinds of feedback:

1) **Review comments** (inline) and review summaries
2) **Issue comments** on the PR

Suggested commands (adjust if fields differ):

```bash
gh pr view <PR> --comments
```

For review threads, use JSON and jq:

```bash
gh pr view <PR> --json reviewThreads,reviews,comments --jq '.'
```

If review threads are missing, fall back to API:

```bash
gh api repos/:owner/:repo/pulls/<PR>/comments
```

For CI:

```bash
gh pr checks <PR>
```

If there are failing checks, open the latest run:

```bash
gh run list --branch <head-branch> --limit 5
# then

gh run view <RUN_ID> --log
```

## 3) Organize feedback into a fix plan

Create a checklist grouped by:

- File / component (prefer)
- Or by reviewer if file grouping is unclear
- Mark CI failures separately at the top

Classify each item:

- **Must fix**: Required by reviewer or CI failure
- **Should fix**: Strong suggestion or quality issue
- **Consider**: Optional / stylistic

Summarize each item in one line with a pointer (file, line, test name, or log excerpt).

## 4) Fix loop (one by one)

For each item:

1) Make the smallest safe change
2) Update or add tests if behavior changes
3) Run targeted tests first, then broader tests if needed

Keep a running checklist and mark items done as you go.

## 5) CI failure loop

For CI failures:

1) Reproduce locally if possible
2) Fix the root cause (not just the symptom)
3) Re-run the specific failing tests locally
4) Re-run the overall test suite if the change is risky

If the failure depends on environment, call that out and suggest a mitigation (e.g. pinning versions, mocking, or configuring CI-only steps).

## 6) Update PR & respond

- Push changes to the PR branch
- Summarize fixes in a review reply with checklist status
- If anything is deferred, state why and ask for confirmation

## Notes & guardrails

- If the PR is in a fork or lacks permissions, report it and ask for access or an alternative.
- If the PR has no comments and CI is green, confirm with the user before doing extra refactors.
- If tests are expensive, ask which subset to run.
