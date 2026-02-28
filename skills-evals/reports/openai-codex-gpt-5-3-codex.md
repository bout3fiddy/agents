NOTICE: This is auto-generated on each run of the evals framework. Do not edit this.

# Pi Eval Report

- Model: openai-codex/gpt-5.3-codex
- Commit: cb3fa88
- Cases path: ../../../../../tmp/pi-eval-cases.XXXXXX.jsonl
- Run: 2026-02-28T19:01:13.283Z
- Run scope: partial
- Cases executed: 2 (2 rows)
- Case rows: 137 (pass 137, fail 0, skip 0)
- Cases in spec: 137
- Duration: 1m 11s
- Token stats (this run): max 126113, median 75789.5, p95 126113

## Case Results
| Case | Mode | Status | Tokens | Skills Read | Skill Files Read | Refs Read | Missing Refs | Unexpected Refs | Notes | Run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CD-001 | single | PASS | 46435 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| CD-002 | single | PASS | 61669 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| CD-003 | single | PASS | 4160 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| CD-004 | single | PASS | 49878 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| CD-006 | single | PASS | 4017 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| CD-007 | single | PASS | 4086 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| CD-008 | single | PASS | 133654 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| CD-009 | single | PASS | 23326 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| CD-010 | single | PASS | 46243 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| CD-011 | single | PASS | 41791 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| CD-012 | single | PASS | 47657 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| CD-013 | single | PASS | 4033 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| CD-014 | single | PASS | 4111 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| CD-015 | single | PASS | 126113 | 1 | 1 | 4 | - | /private/var/folders/w7/3c51j_5j2gq4n13mljt4rrb80000gn/T/pi-eval-sandbox/CD-015/c383c269-a91a-4ff5-9152-62d341d2bfb0/skills/coding/references/code-smells/index.md, /private/var/folders/w7/3c51j_5j2gq4n13mljt4rrb80000gn/T/pi-eval-sandbox/CD-015/c383c269-a91a-4ff5-9152-62d341d2bfb0/skills/coding/references/code-smells/smells/fallback-first.md, /private/var/folders/w7/3c51j_5j2gq4n13mljt4rrb80000gn/T/pi-eval-sandbox/CD-015/c383c269-a91a-4ff5-9152-62d341d2bfb0/skills/coding/references/code-smells/smells/speculative-generality.md |  | 2026-02-28 |
| CD-015-NS | single | PASS | 25466 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| CD-015-NS-PROBE | single | PASS | 2552 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| DS-001 | single | PASS | 27225 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| HK-001 | single | PASS | 38558 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| PL-001 | single | PASS | 36004 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| PL-002 | single | PASS | 156290 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| PL-003 | single | PASS | 13271 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| PL-004 | single | PASS | 18955 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| PL-005 | single | PASS | 50904 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| PL-006 | single | PASS | 31990 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| PL-007 | single | PASS | 74324 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| PL-008 | single | PASS | 136955 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-AUTH-001 | single | PASS | 32292 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-AUTH-002 | single | PASS | 54666 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-AUTH-003 | single | PASS | 42081 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-BUN-001 | single | PASS | 37227 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-INF-001 | single | PASS | 59954 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-INF-002 | single | PASS | 54462 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-INF-003 | single | PASS | 41058 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-101 | single | PASS | 10773 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-102 | single | PASS | 10036 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-103 | single | PASS | 16922 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-104 | single | PASS | 10408 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-105 | single | PASS | 15458 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-106 | single | PASS | 16022 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-107 | single | PASS | 15578 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-108 | single | PASS | 15656 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-109 | single | PASS | 15835 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-110 | single | PASS | 24955 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-111 | single | PASS | 15956 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-112 | single | PASS | 10152 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-113 | single | PASS | 15534 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-114 | single | PASS | 10181 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-115 | single | PASS | 10237 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-116 | single | PASS | 15451 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-117 | single | PASS | 15431 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-118 | single | PASS | 10383 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-119 | single | PASS | 25492 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-120 | single | PASS | 16232 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-121 | single | PASS | 15917 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-122 | single | PASS | 15829 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-123 | single | PASS | 15850 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-124 | single | PASS | 16184 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-125 | single | PASS | 28757 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-126 | single | PASS | 36042 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-177 | single | PASS | 10414 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-178 | single | PASS | 15190 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-179 | single | PASS | 15542 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-180 | single | PASS | 20709 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-181 | single | PASS | 15884 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-182 | single | PASS | 15464 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-183 | single | PASS | 15584 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-184 | single | PASS | 15456 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-185 | single | PASS | 15445 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-186 | single | PASS | 15493 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-187 | single | PASS | 10066 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-188 | single | PASS | 15892 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-189 | single | PASS | 10445 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-190 | single | PASS | 16016 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-191 | single | PASS | 10061 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-192 | single | PASS | 15935 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-193 | single | PASS | 10103 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-194 | single | PASS | 15480 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-195 | single | PASS | 15790 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-196 | single | PASS | 24465 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-197 | single | PASS | 15466 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-198 | single | PASS | 15487 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-199 | single | PASS | 15572 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-200 | single | PASS | 16071 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-201 | single | PASS | 15855 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-202 | single | PASS | 25751 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-203 | single | PASS | 16689 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-MAX-205 | single | PASS | 20997 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-PR-001 | single | PASS | 99805 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-REFAC-001 | single | PASS | 15437 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-REFAC-002 | single | PASS | 27527 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-REFAC-003 | single | PASS | 45893 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-REFAC-004 | single | PASS | 77703 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-REFAC-005 | single | PASS | 97719 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-SMELL-001 | single | PASS | 73732 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-SMELL-002 | single | PASS | 50597 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-SMELL-003 | single | PASS | 36201 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-SMELL-004 | single | PASS | 53938 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-SMELL-005 | single | PASS | 58096 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-SMELL-006 | single | PASS | 43402 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-SOLID-001 | single | PASS | 52723 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-TAIL-001 | single | PASS | 47934 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-UI-001 | single | PASS | 29211 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-UI-002 | single | PASS | 21333 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-CD-UI-003 | single | PASS | 42751 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-DS-ANIM-001 | single | PASS | 27587 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-DS-CRIT-001 | single | PASS | 37586 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-DS-DIAL-001 | single | PASS | 75756 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-DS-MAX-101 | single | PASS | 15459 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-DS-MAX-102 | single | PASS | 15929 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-DS-MAX-103 | single | PASS | 24537 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-HK-ARCH-001 | single | PASS | 26203 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-HK-MAX-101 | single | PASS | 9721 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-HK-MIG-001 | single | PASS | 25433 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-PL-ASK-001 | single | PASS | 21653 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-PL-ASK-002 | single | PASS | 16445 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-PL-ASK-003 | single | PASS | 25729 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-PL-LINEAR-001 | single | PASS | 210735 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-PL-MAX-101 | single | PASS | 10052 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-PL-SPEC-001 | single | PASS | 120254 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-SC-CHECK-001 | single | PASS | 35450 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-SC-MAX-101 | single | PASS | 15521 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-SC-MAX-102 | single | PASS | 15825 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-SC-MAX-103 | single | PASS | 25409 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-SC-MAX-104 | single | PASS | 20809 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-SC-RULES-001 | single | PASS | 32085 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-SC-SKEL-001 | single | PASS | 35774 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-SC-SKEL-002 | single | PASS | 64730 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| R-SC-SKEL-003 | single | PASS | 64497 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| SC-001 | single | PASS | 46091 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| SC-002 | single | PASS | 32724 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| SC-003 | single | PASS | 4296 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| SC-004 | single | PASS | 11439 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| SC-005 | single | PASS | 51691 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| SC-006 | single | PASS | 27181 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| TE-001 | single | PASS | 27839 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| TE-002 | single | PASS | 26141 | 0 | 0 | 0 | - | - |  | 2026-02-28 |
| TE-003 | single | PASS | 4153 | 0 | 0 | 0 | - | - |  | 2026-02-28 |

## Failures
All cases passed.
