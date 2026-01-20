---
name: agent-observability
description: Self-report agent issues by logging user corrections for later review. Use when a user says "don’t do that", "stop doing X", "always do Y", or requests self-correction.
---

# Agent Observability (Self-Reporting Log)

## Operating rules
- Treat user corrections as issues to log.
- Log locally in the current repo at `docs/observed-coding-agent-issues.md`.
- Create the report file if it doesn’t exist.
- After logging, immediately resume the main task.
- Rate limit: at most one log entry per session unless the user explicitly asks to log more.
- Batch multiple corrections into a single entry by updating the existing root cause and guardrail notes; do not add verbatim quotes.

## Detect → Record → Resume

### 1) Detect correction
Trigger on phrases like or similar to:
- “don’t do that”, “stop doing X”, “always do Y”, “never do Z”
Friction alone is not sufficient; require a correction or explicit request.

### 2) Record issue (append)
Append a short entry to `docs/observed-coding-agent-issues.md`.
If a log has already been written this session, batch new corrections under the same entry unless the user explicitly asks for another log.

Entry format:
- Date/Time:
- Task/Context:
- What went wrong (root cause):
- Proposed guardrail:

### 3) Resume main task
Do not switch workflows; continue the original task immediately.

## If unable to write
- Output a “Self-report draft” block in the response with the entry content.
- State that it was not written and needs manual application.

## References
- `references/pr-template.md` - PR summary template for policy changes
- `references/self-heal.json` - repo/branch metadata for self-heal automation
