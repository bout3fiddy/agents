NOTICE: This is auto-generated on each run of the evals framework. Do not edit this.

# Pi Eval Report

- Model: openai-codex/gpt-5.3-codex
- Commit: e765c67
- Cases path: skills-evals/specs/pi-eval/evals.md
- Run: 2026-02-23T12:47:05.116Z
- Run scope: full
- Cases executed: 48 (48 rows)
- Case rows: 48 (pass 31, fail 17, skip 0)
- Cases in spec: 48
- Duration: 17m 33s
- Token stats (this run): max 194519, median 9146.5, p95 104753

## Case Results
| Case | Mode | Status | Tokens | Notes | Run |
| --- | --- | --- | --- | --- | --- |
| AO-001 | single | FAIL | 0 | missing skills: agent-observability | 2026-02-23 |
| AO-002 | single | FAIL | 0 | missing skills: agent-observability | 2026-02-23 |
| AO-003 | single | FAIL | 0 | missing skills: agent-observability | 2026-02-23 |
| AO-004 | single | FAIL | 0 | missing skills: agent-observability | 2026-02-23 |
| AO-005 | single | FAIL | 0 | missing skills: agent-observability | 2026-02-23 |
| AO-006 | single | FAIL | 0 | missing skills: agent-observability | 2026-02-23 |
| CD-001 | single | PASS | 60575 |  | 2026-02-23 |
| CD-002 | single | PASS | 4038 |  | 2026-02-23 |
| CD-003 | single | FAIL | 2634 | unexpected skill: coding | 2026-02-23 |
| CD-004 | single | PASS | 23163 |  | 2026-02-23 |
| CD-006 | single | PASS | 2492 |  | 2026-02-23 |
| CD-007 | single | PASS | 11602 |  | 2026-02-23 |
| CD-008 | single | PASS | 12650 |  | 2026-02-23 |
| CD-009 | single | FAIL | 13663 | missing file: skills-evals/fixtures/docs/README.md | 2026-02-23 |
| CD-010 | single | PASS | 8646 |  | 2026-02-23 |
| CD-011 | single | PASS | 194519 |  | 2026-02-23 |
| PL-001 | single | PASS | 2923 |  | 2026-02-23 |
| PL-002 | single | PASS | 3549 |  | 2026-02-23 |
| PL-003 | single | PASS | 8460 |  | 2026-02-23 |
| PL-004 | single | PASS | 9235 |  | 2026-02-23 |
| PL-005 | single | FAIL | 11183 | unexpected skill: planning | 2026-02-23 |
| PL-006 | single | PASS | 11720 |  | 2026-02-23 |
| R-AO-PR-001 | single | FAIL | 0 | missing skills: agent-observability | 2026-02-23 |
| R-CD-AUTH-001 | single | PASS | 9058 |  | 2026-02-23 |
| R-CD-BUN-001 | single | PASS | 10552 |  | 2026-02-23 |
| R-CD-INF-001 | single | PASS | 30498 |  | 2026-02-23 |
| R-CD-PR-001 | single | PASS | 20312 |  | 2026-02-23 |
| R-CD-REACT-001 | single | PASS | 104753 |  | 2026-02-23 |
| R-CD-REFAC-001 | single | PASS | 42520 |  | 2026-02-23 |
| R-CD-REFAC-002 | single | FAIL | 10388 | missing reference: skills/coding/references/refactoring/index.md | 2026-02-23 |
| R-CD-SMELL-001 | single | PASS | 37025 |  | 2026-02-23 |
| R-CD-SMELL-002 | single | FAIL | 4994 | missing reference: skills/coding/references/code-smells/smells/index.md | 2026-02-23 |
| R-CD-SOLID-001 | single | PASS | 18995 |  | 2026-02-23 |
| R-CD-TAIL-001 | single | PASS | 16473 |  | 2026-02-23 |
| R-CD-UI-001 | single | PASS | 18637 |  | 2026-02-23 |
| R-PL-ASK-001 | single | PASS | 5949 |  | 2026-02-23 |
| R-PL-LINEAR-001 | single | PASS | 6428 |  | 2026-02-23 |
| R-PL-SPEC-001 | single | PASS | 6805 |  | 2026-02-23 |
| R-SC-CHECK-001 | single | PASS | 19296 |  | 2026-02-23 |
| R-SC-RULES-001 | single | PASS | 10438 |  | 2026-02-23 |
| R-SC-SKEL-001 | single | PASS | 109730 |  | 2026-02-23 |
| SC-001 | single | PASS | 7414 |  | 2026-02-23 |
| SC-002 | single | PASS | 58313 |  | 2026-02-23 |
| SC-003 | single | FAIL | 7408 | unexpected skill: skill-creator | 2026-02-23 |
| SC-004 | single | FAIL | 3320 | unexpected skill: coding | 2026-02-23 |
| SC-005 | single | FAIL | 21882 | missing reference: skills/skill-creator/references/templates/skill-skeleton.md | 2026-02-23 |
| TE-001 | single | FAIL | 0 | missing skills: agent-observability | 2026-02-23 |
| TE-002 | single | FAIL | 0 | missing skills: agent-observability | 2026-02-23 |


## Failures
- **AO-001** (single): missing skills: agent-observability
- **AO-002** (single): missing skills: agent-observability
- **AO-003** (single): missing skills: agent-observability
- **AO-004** (single): missing skills: agent-observability
- **AO-005** (single): missing skills: agent-observability
- **AO-006** (single): missing skills: agent-observability
- **CD-003** (single): unexpected skill: coding
- **CD-009** (single): missing file: skills-evals/fixtures/docs/README.md
- **PL-005** (single): unexpected skill: planning
- **R-AO-PR-001** (single): missing skills: agent-observability
- **R-CD-REFAC-002** (single): missing reference: skills/coding/references/refactoring/index.md
- **R-CD-SMELL-002** (single): missing reference: skills/coding/references/code-smells/smells/index.md
- **SC-003** (single): unexpected skill: skill-creator
- **SC-004** (single): unexpected skill: coding
- **SC-005** (single): missing reference: skills/skill-creator/references/templates/skill-skeleton.md
- **TE-001** (single): missing skills: agent-observability
- **TE-002** (single): missing skills: agent-observability
