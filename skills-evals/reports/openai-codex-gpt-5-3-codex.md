NOTICE: This is auto-generated on each run of the evals framework. Do not edit this.

# Pi Eval Report

- Model: openai-codex/gpt-5.3-codex
- Commit: 9992a71
- Cases path: skills-evals/fixtures/eval-cases.jsonl
- Run: 2026-03-03T12:22:11.542Z
- Run scope: partial (filter=CD-015, limit=1)
- Cases executed: 1 (1 rows)
- Case rows: 3 (pass 3, fail 0, skip 0)
- Cases in spec: 3
- Duration: 1m 3s
- Token stats (this run): max 140251, median 140251, p95 140251

## Case Results
| Case | Mode | Status | Tokens | Turns | Skills Read | Skill Files Read | Refs Read | Missing Refs | Unexpected Refs | Notes | Run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CD-015 | single | PASS | 140251 | 1 | 1 | 1 | 4 | - | skills/coding/references/code-smells/detection-signals.md, skills/coding/references/code-smells/index.md, skills/coding/references/code-smells/smells/speculative-generality.md |  | 2026-03-03 |
| CD-015-NS | single | PASS | 24942 | 0 | 0 | 0 | 0 | - | - |  | 2026-03-03 |
| CD-015-NS-PROBE | single | PASS | 1275 | 0 | 1 | 1 | 0 | - | - |  | 2026-03-03 |

## Failures
All cases passed.
