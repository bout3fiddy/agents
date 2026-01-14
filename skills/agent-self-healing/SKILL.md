---
name: agent-self-healing
description: Self-correct agent behavior by turning user corrections into policy updates. Use when a user says “don’t do that”, “stop doing X”, “always do Y”, or requests a self-healing loop that creates policy PRs.
---

# Agent Self-Healing (Policy PR Loop)

## Operating rules
- Treat user corrections as policy changes, not one-off fixes.
- Never write skill updates into random repos.
- If not in the skills repo, use the **PR workflow** against the skills repo.
- Validate skills with `skills-ref` (uv) after changes.
- If PR tooling/auth is missing, stop and report what’s needed.

## Detect → Classify → Fix → PR

### 1) Detect correction
Trigger on phrases like:
- “don’t do that”, “stop doing X”, “always do Y”, “never do Z”
- “make the agent self-correct”

### 2) Classify scope
- **Global** → `instructions/global.md`
- **Skill-specific** → `skills/<skill>/SKILL.md`
- **Tooling** → `coding-rules` + global toolchain rules
- **Policy/Process** → add or update a dedicated skill

### 3) Apply change
- If in skills repo, update files directly.
- Otherwise: clone skills repo → new branch → apply change.

### 4) Validate + PR
- `skills-ref validate skills/<name>`
- Commit with `policy: <short summary>`
- Push branch and open PR.

## Required config (references)
- `references/self-heal.json` (repo URL, base branch, reviewers)
- `references/pr-template.md`

## Output expectations
- Report the detected correction, target file(s), and PR URL (or what blocked it).
