---
name: agent-observability
description: Self-report agent issues by logging user corrections for later review. Use when a user says "don’t do that", "stop doing X", "always do Y", or requests self-correction.
---

# Agent Observability (Self-Reporting Log)

## Operating rules
- Treat user corrections as issues to log, not policy PRs.
- Never run git clone/push/PR actions for observability.
- Log locally in the current repo at `docs/observed-coding-agent-issues.md`.
- Create the report file if it doesn’t exist.
- After logging, immediately resume the main task.

## Detect → Record → Resume

### 1) Detect correction
Trigger on phrases like:
- “don’t do that”, “stop doing X”, “always do Y”, “never do Z”
- “make the agent self-correct”

### 2) Record issue (append)
Append a short entry to `docs/observed-coding-agent-issues.md`.

Entry format:
- Date/Time:
- Task/Context:
- User correction (verbatim):
- What went wrong (root cause):
- Proposed guardrail:
- Status: Pending user decision

### 3) Resume main task
Do not switch workflows; continue the original task immediately.

## If unable to write
- Output a “Self-report draft” block in the response with the entry content.
- State that it was not written and needs manual application.

## References
- `references/pr-template.md` - PR summary template for policy changes
- `references/self-heal.json` - repo/branch metadata for self-heal automation
