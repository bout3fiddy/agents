NOTICE: This is auto-generated on each run of the evals framework. Do not edit this.

# Pi Eval Report

- Model: openai-codex/gpt-5.3-codex
- Commit: 3cf8f48
- Cases path: skills-evals/fixtures/eval-cases.jsonl
- Run: 2026-02-26T12:47:56.051Z
- Run scope: partial (filter=CD-006)
- Cases executed: 1 (1 rows)
- Case rows: 56 (pass 55, fail 1, skip 0)
- Cases in spec: 56
- Duration: 4.6s
- Token stats (this run): max 1117, median 1117, p95 1117

## Case Results
| Case | Mode | Status | Tokens | Notes | Run |
| --- | --- | --- | --- | --- | --- |
| CD-001 | single | PASS | 2918 |  | 2026-02-26 |
| CD-002 | single | PASS | 4801 |  | 2026-02-26 |
| CD-003 | single | PASS | 1261 |  | 2026-02-26 |
| CD-004 | single | PASS | 8411 |  | 2026-02-26 |
| CD-006 | single | FAIL | 1117 | missing skill: coding | 2026-02-26 |
| CD-007 | single | PASS | 4022 |  | 2026-02-26 |
| CD-008 | single | PASS | 9131 |  | 2026-02-26 |
| CD-009 | single | PASS | 8539 |  | 2026-02-26 |
| CD-010 | single | PASS | 12041 |  | 2026-02-26 |
| CD-011 | single | PASS | 5628 |  | 2026-02-26 |
| CD-012 | single | PASS | 10942 |  | 2026-02-26 |
| DS-001 | single | PASS | 2889 |  | 2026-02-26 |
| HK-001 | single | PASS | 5137 |  | 2026-02-26 |
| PL-001 | single | PASS | 2709 |  | 2026-02-26 |
| PL-002 | single | PASS | 3449 |  | 2026-02-26 |
| PL-003 | single | PASS | 7190 |  | 2026-02-26 |
| PL-004 | single | PASS | 11846 |  | 2026-02-26 |
| PL-005 | single | PASS | 10434 |  | 2026-02-26 |
| PL-006 | single | PASS | 5577 |  | 2026-02-26 |
| R-CD-AUTH-001 | single | PASS | 9013 |  | 2026-02-26 |
| R-CD-BUN-001 | single | PASS | 10629 |  | 2026-02-26 |
| R-CD-INF-001 | single | PASS | 15104 |  | 2026-02-26 |
| R-CD-PR-001 | single | PASS | 21033 |  | 2026-02-26 |
| R-CD-REACT-001 | single | PASS | 50798 |  | 2026-02-26 |
| R-CD-REFAC-001 | single | PASS | 14810 |  | 2026-02-26 |
| R-CD-REFAC-002 | single | PASS | 12824 |  | 2026-02-26 |
| R-CD-REFAC-003 | single | PASS | 13107 |  | 2026-02-26 |
| R-CD-REFAC-004 | single | PASS | 22396 |  | 2026-02-26 |
| R-CD-REFAC-005 | single | PASS | 28588 |  | 2026-02-26 |
| R-CD-SMELL-001 | single | PASS | 10554 |  | 2026-02-26 |
| R-CD-SMELL-002 | single | PASS | 14736 |  | 2026-02-26 |
| R-CD-SMELL-003 | single | PASS | 11697 |  | 2026-02-26 |
| R-CD-SMELL-004 | single | PASS | 10563 |  | 2026-02-26 |
| R-CD-SOLID-001 | single | PASS | 20116 |  | 2026-02-26 |
| R-CD-TAIL-001 | single | PASS | 16522 |  | 2026-02-26 |
| R-CD-UI-001 | single | PASS | 10071 |  | 2026-02-26 |
| R-DS-ANIM-001 | single | PASS | 7073 |  | 2026-02-26 |
| R-DS-CRIT-001 | single | PASS | 7410 |  | 2026-02-26 |
| R-DS-DIAL-001 | single | PASS | 10961 |  | 2026-02-26 |
| R-HK-ARCH-001 | single | PASS | 5892 |  | 2026-02-26 |
| R-HK-MIG-001 | single | PASS | 6628 |  | 2026-02-26 |
| R-PL-ASK-001 | single | PASS | 5831 |  | 2026-02-26 |
| R-PL-LINEAR-001 | single | PASS | 6576 |  | 2026-02-26 |
| R-PL-SPEC-001 | single | PASS | 6258 |  | 2026-02-26 |
| R-SC-CHECK-001 | single | PASS | 6542 |  | 2026-02-26 |
| R-SC-RULES-001 | single | PASS | 20666 |  | 2026-02-26 |
| R-SC-SKEL-001 | single | PASS | 35830 |  | 2026-02-26 |
| SC-001 | single | PASS | 45984 |  | 2026-02-26 |
| SC-002 | single | PASS | 8496 |  | 2026-02-26 |
| SC-003 | single | PASS | 4896 |  | 2026-02-26 |
| SC-004 | single | PASS | 4782 |  | 2026-02-26 |
| SC-005 | single | PASS | 8862 |  | 2026-02-26 |
| SC-006 | single | PASS | 43588 |  | 2026-02-26 |
| TE-001 | single | PASS | 6622 |  | 2026-02-26 |
| TE-002 | single | PASS | 3200 |  | 2026-02-26 |
| TE-003 | single | PASS | 3176 |  | 2026-02-26 |

## Failures
- **CD-006** (single): missing skill: coding
