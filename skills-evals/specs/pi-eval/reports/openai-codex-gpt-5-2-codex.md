NOTICE: This is auto-generated on each run of the evals framework. Do not edit this.

# Pi Eval Report

- Model: openai-codex/gpt-5.2-codex
- Commit: 4968d29
- Cases path: skills-evals/specs/pi-eval/evals.md
- Run: 2026-01-30T20:00:36.040Z
- Run scope: full
- Cases executed: 50 (50 rows)
- Case rows: 50 (pass 27, fail 23, skip 0)
- Cases in spec: 50
- Duration: 4m 27s
- Token stats (this run): max 150226, median 30372, p95 79931

## Case Results
| Case | Mode | Status | Tokens | Notes | Run |
| --- | --- | --- | --- | --- | --- |
| AB-001 | single | PASS | 12729 |  | 2026-01-30 |
| AB-002 | single | PASS | 12746 |  | 2026-01-30 |
| AB-003 | single | PASS | 6530 |  | 2026-01-30 |
| AB-004 | single | PASS | 12980 |  | 2026-01-30 |
| AB-005 | single | PASS | 13271 |  | 2026-01-30 |
| AO-001 | single | PASS | 49610 |  | 2026-01-30 |
| AO-002 | single | PASS | 49326 |  | 2026-01-30 |
| AO-003 | single | PASS | 6254 |  | 2026-01-30 |
| AO-004 | single | FAIL | 42385 | missing skill: coding | 2026-01-30 |
| AO-005 | single | FAIL | 28427 | missing skill: planning | 2026-01-30 |
| AO-006 | single | FAIL | 75253 | missing skill: coding | 2026-01-30 |
| CD-001 | single | PASS | 79931 |  | 2026-01-30 |
| CD-002 | single | PASS | 29002 |  | 2026-01-30 |
| CD-003 | single | PASS | 6265 |  | 2026-01-30 |
| CD-004 | single | PASS | 150226 |  | 2026-01-30 |
| CD-005 | single | PASS | 13003 |  | 2026-01-30 |
| CD-006 | single | PASS | 12630 |  | 2026-01-30 |
| CD-007 | single | FAIL | 6235 | missing skill: coding | 2026-01-30 |
| CD-008 | single | FAIL | 0 | run error: Case CD-008 timed out after 180000ms | 2026-01-30 |
| CD-009 | single | PASS | 58141 |  | 2026-01-30 |
| CD-010 | single | FAIL | 18990 | missing skill: coding | 2026-01-30 |
| PL-001 | single | PASS | 29212 |  | 2026-01-30 |
| PL-002 | single | PASS | 42896 |  | 2026-01-30 |
| PL-003 | single | PASS | 29908 |  | 2026-01-30 |
| PL-004 | single | FAIL | 29720 | missing skill: coding | 2026-01-30 |
| PL-005 | single | PASS | 35352 |  | 2026-01-30 |
| PL-006 | single | PASS | 56801 |  | 2026-01-30 |
| R-AO-PR-001 | single | PASS | 36562 |  | 2026-01-30 |
| R-AO-SELF-001 | single | FAIL | 37166 | missing reference: skills/agent-observability/references/self-heal.json | 2026-01-30 |
| R-CD-AUTH-001 | single | PASS | 23869 |  | 2026-01-30 |
| R-CD-BUN-001 | single | FAIL | 75636 | missing reference: skills/coding/references/bun.md | 2026-01-30 |
| R-CD-INF-001 | single | FAIL | 74863 | missing reference: skills/coding/references/platform-engineering/index.md | 2026-01-30 |
| R-CD-PR-001 | single | FAIL | 26209 | missing reference: skills/coding/references/gh-pr-review-fix.md | 2026-01-30 |
| R-CD-REACT-001 | single | FAIL | 65420 | missing reference: skills/coding/references/react/index.md | 2026-01-30 |
| R-CD-SOLID-001 | single | PASS | 52779 |  | 2026-01-30 |
| R-CD-TAIL-001 | single | FAIL | 52316 | missing reference: skills/coding/references/frontend-engineering/tailwindcss-full.md | 2026-01-30 |
| R-CD-UI-001 | single | FAIL | 57950 | missing reference: skills/coding/references/frontend-engineering/index.md | 2026-01-30 |
| R-PL-ASK-001 | single | PASS | 20898 |  | 2026-01-30 |
| R-PL-LINEAR-001 | single | FAIL | 33228 | missing reference: skills/planning/references/linear-mcp-ops.md | 2026-01-30 |
| R-PL-SPEC-001 | single | PASS | 47260 |  | 2026-01-30 |
| R-SC-CHECK-001 | single | FAIL | 21020 | missing reference: skills/skill-creator/references/checklist.md | 2026-01-30 |
| R-SC-RULES-001 | single | FAIL | 0 | run error: Case R-SC-RULES-001 timed out after 180000ms | 2026-01-30 |
| R-SC-SKEL-001 | single | FAIL | 59942 | missing reference: skills/skill-creator/references/templates/skill-skeleton.md | 2026-01-30 |
| SC-001 | single | FAIL | 0 | run error: Case SC-001 timed out after 180000ms | 2026-01-30 |
| SC-002 | single | PASS | 19825 |  | 2026-01-30 |
| SC-003 | single | PASS | 30836 |  | 2026-01-30 |
| SC-004 | single | FAIL | 41918 | unexpected skill: coding | 2026-01-30 |
| SC-005 | single | FAIL | 141334 | missing reference: skills/skill-creator/references/templates/skill-skeleton.md | 2026-01-30 |
| TE-001 | single | FAIL | 65761 | token budget exceeded (65761 > 3400) | 2026-01-30 |
| TE-002 | single | FAIL | 26122 | token budget exceeded (26122 > 3800) | 2026-01-30 |


## Failures
- **AO-004** (single): missing skill: coding
- **AO-005** (single): missing skill: planning
- **AO-006** (single): missing skill: coding
- **CD-007** (single): missing skill: coding
- **CD-008** (single): run error: Case CD-008 timed out after 180000ms
- **CD-010** (single): missing skill: coding
- **PL-004** (single): missing skill: coding
- **R-AO-SELF-001** (single): missing reference: skills/agent-observability/references/self-heal.json
- **R-CD-BUN-001** (single): missing reference: skills/coding/references/bun.md
- **R-CD-INF-001** (single): missing reference: skills/coding/references/platform-engineering/index.md
- **R-CD-PR-001** (single): missing reference: skills/coding/references/gh-pr-review-fix.md
- **R-CD-REACT-001** (single): missing reference: skills/coding/references/react/index.md
- **R-CD-TAIL-001** (single): missing reference: skills/coding/references/frontend-engineering/tailwindcss-full.md
- **R-CD-UI-001** (single): missing reference: skills/coding/references/frontend-engineering/index.md
- **R-PL-LINEAR-001** (single): missing reference: skills/planning/references/linear-mcp-ops.md
- **R-SC-CHECK-001** (single): missing reference: skills/skill-creator/references/checklist.md
- **R-SC-RULES-001** (single): run error: Case R-SC-RULES-001 timed out after 180000ms
- **R-SC-SKEL-001** (single): missing reference: skills/skill-creator/references/templates/skill-skeleton.md
- **SC-001** (single): run error: Case SC-001 timed out after 180000ms
- **SC-004** (single): unexpected skill: coding
- **SC-005** (single): missing reference: skills/skill-creator/references/templates/skill-skeleton.md
- **TE-001** (single): token budget exceeded (65761 > 3400)
- **TE-002** (single): token budget exceeded (26122 > 3800)
