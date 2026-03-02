NOTICE: This is auto-generated on each run of the evals framework. Do not edit this.

# Pi Eval Report

- Model: openai-codex/gpt-5.3-codex
- Commit: 2192d1e
- Cases path: skills-evals/fixtures/eval-cases.jsonl
- Run: 2026-03-02T02:33:16.026Z
- Run scope: partial (filter=CD-015, limit=1)
- Cases executed: 1 (1 rows)
- Case rows: 137 (pass 8, fail 7, skip 122)
- Cases in spec: 137
- Duration: 1m 32s
- Token stats (this run): max 0, median 0, p95 0

## Case Results
| Case | Mode | Status | Tokens | Skills Read | Skill Files Read | Refs Read | Missing Refs | Unexpected Refs | Notes | Run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CD-001 | single | PASS | 0 | 0 | 0 | 0 | - | - |  | 2026-03-01 |
| CD-002 | single | PASS | 0 | 0 | 0 | 0 | - | - |  | 2026-03-01 |
| CD-003 | single | FAIL | 0 | 0 | 0 | 0 | - | - | TASK_FAILURE: assertion failed: must_contain:mutex | 2026-03-01 |
| CD-004 | single | PASS | 0 | 0 | 0 | 0 | - | - |  | 2026-03-01 |
| CD-006 | single | PASS | 0 | 0 | 0 | 0 | - | - |  | 2026-03-01 |
| CD-007 | single | FAIL | 0 | 0 | 0 | 0 | - | - | TASK_FAILURE: assertion failed: must_contain:uv | 2026-03-01 |
| CD-008 | single | FAIL | 0 | 0 | 0 | 0 | - | - | TASK_FAILURE: file assertion failed: skills-evals/fixtures/auth/middleware.py missing return False; TASK_FAILURE: file assertion failed: skills-evals/fixtures/auth/middleware.py contains return True; TASK_FAILURE: file assertion failed: skills-evals/fixtures/auth/test_middleware.py missing None; TASK_FAILURE: file assertion failed: skills-evals/fixtures/auth/test_middleware.py missing is False | 2026-03-01 |
| CD-009 | single | FAIL | 0 | 0 | 0 | 0 | - | - | TASK_FAILURE: missing file: skills-evals/fixtures/docs/FIXTURE_DOC.md | 2026-03-01 |
| CD-010 | single | FAIL | 0 | 0 | 0 | 0 | - | - | TASK_FAILURE: file assertion failed: skills-evals/fixtures/sql/query.sql missing ORDER BY created_at DESC; TASK_FAILURE: file assertion failed: skills-evals/fixtures/sql/query.sql missing LIMIT 50 | 2026-03-01 |
| CD-011 | single | PASS | 0 | 0 | 0 | 0 | - | - |  | 2026-03-01 |
| CD-012 | single | PASS | 0 | 0 | 0 | 0 | - | - |  | 2026-03-01 |
| CD-013 | single | PASS | 0 | 0 | 0 | 0 | - | - |  | 2026-03-01 |
| CD-014 | single | PASS | 0 | 0 | 0 | 0 | - | - |  | 2026-03-01 |
| CD-015 | single | FAIL | 0 | 0 | 0 | 0 | - | - | TASK_FAILURE: run error: Case CD-015 timed out after 90000ms rpc diagnostics: raw=38 parsed=38 parse_errors=0 last_stop=error last_error=502 Bad Gateway
 events=[message_update:14, message_start:5, message_end:5, turn_start:3] | 2026-03-02 |
| CD-015-NS | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| CD-015-NS-PROBE | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| DS-001 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| HK-001 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| PL-001 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| PL-002 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| PL-003 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| PL-004 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| PL-005 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| PL-006 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| PL-007 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| PL-008 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-AUTH-001 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-AUTH-002 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-AUTH-003 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-BUN-001 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-INF-001 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-INF-002 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-INF-003 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-101 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-102 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-103 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-104 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-105 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-106 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-107 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-108 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-109 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-110 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-111 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-112 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-113 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-114 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-115 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-116 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-117 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-118 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-119 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-120 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-121 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-122 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-123 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-124 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-125 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-126 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-177 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-178 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-179 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-180 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-181 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-182 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-183 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-184 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-185 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-186 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-187 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-188 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-189 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-190 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-191 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-192 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-193 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-194 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-195 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-196 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-197 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-198 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-199 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-200 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-201 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-202 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-203 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-MAX-205 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-PR-001 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-REFAC-001 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-REFAC-002 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-REFAC-003 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-REFAC-004 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-REFAC-005 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-SMELL-001 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-SMELL-002 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-SMELL-003 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-SMELL-004 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-SMELL-005 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-SMELL-006 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-SOLID-001 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-TAIL-001 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-UI-001 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-UI-002 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-CD-UI-003 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-DS-ANIM-001 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-DS-CRIT-001 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-DS-DIAL-001 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-DS-MAX-101 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-DS-MAX-102 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-DS-MAX-103 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-HK-ARCH-001 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-HK-MAX-101 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-HK-MIG-001 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-PL-ASK-001 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-PL-ASK-002 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-PL-ASK-003 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-PL-LINEAR-001 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-PL-MAX-101 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-PL-SPEC-001 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-SC-CHECK-001 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-SC-MAX-101 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-SC-MAX-102 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-SC-MAX-103 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-SC-MAX-104 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-SC-RULES-001 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-SC-SKEL-001 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-SC-SKEL-002 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| R-SC-SKEL-003 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| SC-001 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| SC-002 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| SC-003 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| SC-004 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| SC-005 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| SC-006 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| TE-001 | single | FAIL | 0 | 0 | 0 | 0 | skills/skill-creator/references/templates/rules-template.md, skills/skill-creator/references/templates/skill-skeleton.md | - | ROUTING_FAILURE: missing refs: [skills/skill-creator/references/templates/rules-template.md, skills/skill-creator/references/templates/skill-skeleton.md]; read refs: [] | 2026-03-02 |
| TE-002 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |
| TE-003 | single | SKIP | 0 | 0 | 0 | 0 | - | - | not run | - |

## Failures
- **CD-003** (single): TASK_FAILURE: assertion failed: must_contain:mutex
- **CD-007** (single): TASK_FAILURE: assertion failed: must_contain:uv
- **CD-008** (single): TASK_FAILURE: file assertion failed: skills-evals/fixtures/auth/middleware.py missing return False; TASK_FAILURE: file assertion failed: skills-evals/fixtures/auth/middleware.py contains return True; TASK_FAILURE: file assertion failed: skills-evals/fixtures/auth/test_middleware.py missing None; TASK_FAILURE: file assertion failed: skills-evals/fixtures/auth/test_middleware.py missing is False
- **CD-009** (single): TASK_FAILURE: missing file: skills-evals/fixtures/docs/FIXTURE_DOC.md
- **CD-010** (single): TASK_FAILURE: file assertion failed: skills-evals/fixtures/sql/query.sql missing ORDER BY created_at DESC; TASK_FAILURE: file assertion failed: skills-evals/fixtures/sql/query.sql missing LIMIT 50
- **CD-015** (single): TASK_FAILURE: run error: Case CD-015 timed out after 90000ms rpc diagnostics: raw=38 parsed=38 parse_errors=0 last_stop=error last_error=502 Bad Gateway
 events=[message_update:14, message_start:5, message_end:5, turn_start:3]
- **TE-001** (single): ROUTING_FAILURE: missing refs: [skills/skill-creator/references/templates/rules-template.md, skills/skill-creator/references/templates/skill-skeleton.md]; read refs: []
