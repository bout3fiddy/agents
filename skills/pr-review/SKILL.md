---
name: pr-review
description: Inspect and address pull-request review comments, unresolved threads, requested changes, and failing checks. Use when the user asks to remediate PR feedback or drain the current review state; do not trigger for a general code review without an existing PR.
---

# PR Review Remediation

Read [remediation.md](references/remediation.md) and follow its evidence-first
loop. Resolve the current PR, head commit, checks, reviews, and unresolved
threads before editing. Keep fixes scoped, verify them, reply with concrete
evidence, and re-read remote state after pushes.

Do not infer that a quiet bot, a skipped review, or a completed workflow means
all reviewers are finished. Do not resolve a human disagreement or dismiss a
correctness concern without explaining the decision.
