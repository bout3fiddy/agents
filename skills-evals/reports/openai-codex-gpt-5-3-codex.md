NOTICE: This is auto-generated on each run of the evals framework. Do not edit this.

# Pi Eval Report

- Model: openai-codex/gpt-5.3-codex
- Commit: 19918de
- Cases path: skills-evals/fixtures/eval-cases.jsonl
- Run: 2026-02-27T16:28:34.600Z
- Run scope: partial (filter=refs-coding, limit=6)
- Cases executed: 6 (6 rows)
- Case rows: 164 (pass 133, fail 31, skip 0)
- Cases in spec: 164
- Duration: 3m 1s
- Token stats (this run): max 38621, median 10472.5, p95 38621

## Case Results
| Case | Mode | Status | Tokens | Notes | Run |
| --- | --- | --- | --- | --- | --- |
| CD-001 | single | PASS | 2815 |  | 2026-02-27 |
| CD-002 | single | PASS | 3659 |  | 2026-02-27 |
| CD-003 | single | PASS | 1239 |  | 2026-02-27 |
| CD-004 | single | PASS | 8444 |  | 2026-02-27 |
| CD-006 | single | FAIL | 1083 | missing skill: coding | 2026-02-27 |
| CD-007 | single | PASS | 3855 |  | 2026-02-27 |
| CD-008 | single | PASS | 17202 |  | 2026-02-27 |
| CD-009 | single | PASS | 9133 |  | 2026-02-27 |
| CD-010 | single | PASS | 12586 |  | 2026-02-27 |
| CD-011 | single | PASS | 22018 |  | 2026-02-27 |
| CD-012 | single | PASS | 12775 |  | 2026-02-27 |
| DS-001 | single | PASS | 3019 |  | 2026-02-27 |
| HK-001 | single | PASS | 5567 |  | 2026-02-27 |
| PL-001 | single | PASS | 2772 |  | 2026-02-27 |
| PL-002 | single | PASS | 3523 |  | 2026-02-27 |
| PL-003 | single | PASS | 14993 |  | 2026-02-27 |
| PL-004 | single | PASS | 10904 |  | 2026-02-27 |
| PL-005 | single | PASS | 10067 |  | 2026-02-27 |
| PL-006 | single | PASS | 4883 |  | 2026-02-27 |
| R-CD-AUTH-001 | single | FAIL | 0 | run error: Case R-CD-AUTH-001 timed out after 180000ms | 2026-02-27 |
| R-CD-BUN-001 | single | PASS | 11353 |  | 2026-02-27 |
| R-CD-INF-001 | single | PASS | 32082 |  | 2026-02-27 |
| R-CD-MAX-101 | single | PASS | 5807 |  | 2026-02-27 |
| R-CD-MAX-102 | single | FAIL | 2828 | missing skill: coding | 2026-02-27 |
| R-CD-MAX-103 | single | PASS | 6288 |  | 2026-02-27 |
| R-CD-MAX-104 | single | PASS | 5671 |  | 2026-02-27 |
| R-CD-MAX-105 | single | FAIL | 2835 | missing skill: coding | 2026-02-27 |
| R-CD-MAX-106 | single | PASS | 5612 |  | 2026-02-27 |
| R-CD-MAX-107 | single | FAIL | 2691 | missing skill: coding | 2026-02-27 |
| R-CD-MAX-108 | single | PASS | 5775 |  | 2026-02-27 |
| R-CD-MAX-109 | single | PASS | 5695 |  | 2026-02-27 |
| R-CD-MAX-110 | single | FAIL | 2716 | missing skill: coding | 2026-02-27 |
| R-CD-MAX-111 | single | PASS | 9379 |  | 2026-02-27 |
| R-CD-MAX-112 | single | FAIL | 2725 | missing skill: coding | 2026-02-27 |
| R-CD-MAX-113 | single | PASS | 5697 |  | 2026-02-27 |
| R-CD-MAX-114 | single | PASS | 5643 |  | 2026-02-27 |
| R-CD-MAX-115 | single | PASS | 5673 |  | 2026-02-27 |
| R-CD-MAX-116 | single | PASS | 5820 |  | 2026-02-27 |
| R-CD-MAX-117 | single | PASS | 5707 |  | 2026-02-27 |
| R-CD-MAX-118 | single | PASS | 9784 |  | 2026-02-27 |
| R-CD-MAX-119 | single | FAIL | 2725 | missing skill: coding | 2026-02-27 |
| R-CD-MAX-120 | single | PASS | 5703 |  | 2026-02-27 |
| R-CD-MAX-121 | single | PASS | 5672 |  | 2026-02-27 |
| R-CD-MAX-122 | single | FAIL | 2736 | missing skill: coding | 2026-02-27 |
| R-CD-MAX-123 | single | FAIL | 2867 | missing skill: coding | 2026-02-27 |
| R-CD-MAX-124 | single | FAIL | 3012 | missing skill: coding | 2026-02-27 |
| R-CD-MAX-125 | single | PASS | 6867 |  | 2026-02-27 |
| R-CD-MAX-126 | single | PASS | 8343 |  | 2026-02-27 |
| R-CD-MAX-127 | single | PASS | 38909 |  | 2026-02-27 |
| R-CD-MAX-128 | single | PASS | 6015 |  | 2026-02-27 |
| R-CD-MAX-129 | single | PASS | 6029 |  | 2026-02-27 |
| R-CD-MAX-130 | single | PASS | 9658 |  | 2026-02-27 |
| R-CD-MAX-131 | single | PASS | 5975 |  | 2026-02-27 |
| R-CD-MAX-132 | single | FAIL | 2893 | missing skill: coding | 2026-02-27 |
| R-CD-MAX-133 | single | PASS | 5622 |  | 2026-02-27 |
| R-CD-MAX-134 | single | PASS | 10109 |  | 2026-02-27 |
| R-CD-MAX-135 | single | FAIL | 3300 | missing skill: coding | 2026-02-27 |
| R-CD-MAX-136 | single | PASS | 5889 |  | 2026-02-27 |
| R-CD-MAX-137 | single | FAIL | 2899 | missing skill: coding | 2026-02-27 |
| R-CD-MAX-138 | single | PASS | 5791 |  | 2026-02-27 |
| R-CD-MAX-139 | single | PASS | 9647 |  | 2026-02-27 |
| R-CD-MAX-140 | single | FAIL | 3177 | missing skill: coding | 2026-02-27 |
| R-CD-MAX-141 | single | PASS | 6139 |  | 2026-02-27 |
| R-CD-MAX-142 | single | PASS | 6042 |  | 2026-02-27 |
| R-CD-MAX-143 | single | PASS | 6011 |  | 2026-02-27 |
| R-CD-MAX-144 | single | PASS | 6974 |  | 2026-02-27 |
| R-CD-MAX-145 | single | FAIL | 3005 | missing skill: coding | 2026-02-27 |
| R-CD-MAX-146 | single | PASS | 6072 |  | 2026-02-27 |
| R-CD-MAX-147 | single | PASS | 5941 |  | 2026-02-27 |
| R-CD-MAX-148 | single | PASS | 6028 |  | 2026-02-27 |
| R-CD-MAX-149 | single | FAIL | 2783 | missing skill: coding | 2026-02-27 |
| R-CD-MAX-150 | single | FAIL | 2836 | missing skill: coding | 2026-02-27 |
| R-CD-MAX-151 | single | PASS | 5929 |  | 2026-02-27 |
| R-CD-MAX-152 | single | PASS | 5811 |  | 2026-02-27 |
| R-CD-MAX-153 | single | PASS | 5816 |  | 2026-02-27 |
| R-CD-MAX-154 | single | FAIL | 3272 | missing skill: coding | 2026-02-27 |
| R-CD-MAX-155 | single | PASS | 5671 |  | 2026-02-27 |
| R-CD-MAX-156 | single | PASS | 6120 |  | 2026-02-27 |
| R-CD-MAX-157 | single | PASS | 5801 |  | 2026-02-27 |
| R-CD-MAX-158 | single | PASS | 5911 |  | 2026-02-27 |
| R-CD-MAX-159 | single | PASS | 6042 |  | 2026-02-27 |
| R-CD-MAX-160 | single | PASS | 5817 |  | 2026-02-27 |
| R-CD-MAX-161 | single | FAIL | 2897 | missing skill: coding | 2026-02-27 |
| R-CD-MAX-162 | single | PASS | 10175 |  | 2026-02-27 |
| R-CD-MAX-163 | single | PASS | 5804 |  | 2026-02-27 |
| R-CD-MAX-164 | single | PASS | 5675 |  | 2026-02-27 |
| R-CD-MAX-165 | single | PASS | 5818 |  | 2026-02-27 |
| R-CD-MAX-166 | single | PASS | 9718 |  | 2026-02-27 |
| R-CD-MAX-167 | single | FAIL | 3291 | missing skill: coding | 2026-02-27 |
| R-CD-MAX-168 | single | FAIL | 3206 | missing skill: coding | 2026-02-27 |
| R-CD-MAX-169 | single | FAIL | 2926 | missing skill: coding | 2026-02-27 |
| R-CD-MAX-170 | single | PASS | 5756 |  | 2026-02-27 |
| R-CD-MAX-171 | single | PASS | 5990 |  | 2026-02-27 |
| R-CD-MAX-172 | single | PASS | 5964 |  | 2026-02-27 |
| R-CD-MAX-173 | single | PASS | 6066 |  | 2026-02-27 |
| R-CD-MAX-174 | single | PASS | 6033 |  | 2026-02-27 |
| R-CD-MAX-175 | single | FAIL | 2904 | missing skill: coding | 2026-02-27 |
| R-CD-MAX-176 | single | PASS | 5844 |  | 2026-02-27 |
| R-CD-MAX-177 | single | PASS | 5940 |  | 2026-02-27 |
| R-CD-MAX-178 | single | PASS | 5800 |  | 2026-02-27 |
| R-CD-MAX-179 | single | PASS | 5726 |  | 2026-02-27 |
| R-CD-MAX-180 | single | PASS | 6011 |  | 2026-02-27 |
| R-CD-MAX-181 | single | PASS | 5876 |  | 2026-02-27 |
| R-CD-MAX-182 | single | PASS | 9677 |  | 2026-02-27 |
| R-CD-MAX-183 | single | FAIL | 2872 | missing skill: coding | 2026-02-27 |
| R-CD-MAX-184 | single | PASS | 9503 |  | 2026-02-27 |
| R-CD-MAX-185 | single | PASS | 5732 |  | 2026-02-27 |
| R-CD-MAX-186 | single | PASS | 5576 |  | 2026-02-27 |
| R-CD-MAX-187 | single | FAIL | 2762 | missing skill: coding | 2026-02-27 |
| R-CD-MAX-188 | single | PASS | 5794 |  | 2026-02-27 |
| R-CD-MAX-189 | single | FAIL | 3301 | missing skill: coding | 2026-02-27 |
| R-CD-MAX-190 | single | PASS | 6452 |  | 2026-02-27 |
| R-CD-MAX-191 | single | PASS | 9473 |  | 2026-02-27 |
| R-CD-MAX-192 | single | PASS | 5866 |  | 2026-02-27 |
| R-CD-MAX-193 | single | PASS | 5752 |  | 2026-02-27 |
| R-CD-MAX-194 | single | PASS | 5737 |  | 2026-02-27 |
| R-CD-MAX-195 | single | PASS | 5762 |  | 2026-02-27 |
| R-CD-MAX-196 | single | PASS | 5777 |  | 2026-02-27 |
| R-CD-MAX-197 | single | PASS | 5732 |  | 2026-02-27 |
| R-CD-MAX-198 | single | PASS | 5731 |  | 2026-02-27 |
| R-CD-MAX-199 | single | PASS | 5716 |  | 2026-02-27 |
| R-CD-MAX-200 | single | PASS | 5742 |  | 2026-02-27 |
| R-CD-MAX-201 | single | PASS | 5994 |  | 2026-02-27 |
| R-CD-MAX-202 | single | PASS | 6138 |  | 2026-02-27 |
| R-CD-MAX-203 | single | PASS | 12327 |  | 2026-02-27 |
| R-CD-PR-001 | single | PASS | 38621 |  | 2026-02-27 |
| R-CD-REACT-001 | single | PASS | 90690 |  | 2026-02-27 |
| R-CD-REFAC-001 | single | PASS | 22123 |  | 2026-02-27 |
| R-CD-REFAC-002 | single | PASS | 14641 |  | 2026-02-27 |
| R-CD-REFAC-003 | single | PASS | 11528 |  | 2026-02-27 |
| R-CD-REFAC-004 | single | PASS | 18901 |  | 2026-02-27 |
| R-CD-REFAC-005 | single | PASS | 33072 |  | 2026-02-27 |
| R-CD-SMELL-001 | single | PASS | 15806 |  | 2026-02-27 |
| R-CD-SMELL-002 | single | PASS | 21863 |  | 2026-02-27 |
| R-CD-SMELL-003 | single | PASS | 16843 |  | 2026-02-27 |
| R-CD-SMELL-004 | single | PASS | 15569 |  | 2026-02-27 |
| R-CD-SOLID-001 | single | PASS | 9592 |  | 2026-02-27 |
| R-CD-TAIL-001 | single | PASS | 14313 |  | 2026-02-27 |
| R-CD-UI-001 | single | FAIL | 9378 | missing reference: skills/design/references/components-and-motion.md | 2026-02-27 |
| R-DS-ANIM-001 | single | PASS | 8677 |  | 2026-02-27 |
| R-DS-CRIT-001 | single | PASS | 42020 |  | 2026-02-27 |
| R-DS-DIAL-001 | single | PASS | 22658 |  | 2026-02-27 |
| R-DS-MAX-101 | single | FAIL | 2902 | missing skill: design | 2026-02-27 |
| R-HK-ARCH-001 | single | PASS | 9303 |  | 2026-02-27 |
| R-HK-MAX-101 | single | PASS | 3811 |  | 2026-02-27 |
| R-HK-MIG-001 | single | PASS | 7437 |  | 2026-02-27 |
| R-PL-ASK-001 | single | PASS | 7507 |  | 2026-02-27 |
| R-PL-LINEAR-001 | single | PASS | 7801 |  | 2026-02-27 |
| R-PL-MAX-101 | single | PASS | 4149 |  | 2026-02-27 |
| R-PL-SPEC-001 | single | PASS | 9406 |  | 2026-02-27 |
| R-SC-CHECK-001 | single | PASS | 13323 |  | 2026-02-27 |
| R-SC-MAX-101 | single | FAIL | 2593 | missing skill: skill-creator | 2026-02-27 |
| R-SC-MAX-102 | single | FAIL | 2634 | missing skill: skill-creator | 2026-02-27 |
| R-SC-RULES-001 | single | PASS | 24406 |  | 2026-02-27 |
| R-SC-SKEL-001 | single | PASS | 13621 |  | 2026-02-27 |
| SC-001 | single | PASS | 43025 |  | 2026-02-27 |
| SC-002 | single | PASS | 8911 |  | 2026-02-27 |
| SC-003 | single | PASS | 4769 |  | 2026-02-27 |
| SC-004 | single | PASS | 4454 |  | 2026-02-27 |
| SC-005 | single | PASS | 14613 |  | 2026-02-27 |
| SC-006 | single | PASS | 24094 |  | 2026-02-27 |
| TE-001 | single | PASS | 11505 |  | 2026-02-27 |
| TE-002 | single | PASS | 3220 |  | 2026-02-27 |
| TE-003 | single | PASS | 3231 |  | 2026-02-27 |

## Failures
- **CD-006** (single): missing skill: coding
- **R-CD-AUTH-001** (single): run error: Case R-CD-AUTH-001 timed out after 180000ms
- **R-CD-MAX-102** (single): missing skill: coding
- **R-CD-MAX-105** (single): missing skill: coding
- **R-CD-MAX-107** (single): missing skill: coding
- **R-CD-MAX-110** (single): missing skill: coding
- **R-CD-MAX-112** (single): missing skill: coding
- **R-CD-MAX-119** (single): missing skill: coding
- **R-CD-MAX-122** (single): missing skill: coding
- **R-CD-MAX-123** (single): missing skill: coding
- **R-CD-MAX-124** (single): missing skill: coding
- **R-CD-MAX-132** (single): missing skill: coding
- **R-CD-MAX-135** (single): missing skill: coding
- **R-CD-MAX-137** (single): missing skill: coding
- **R-CD-MAX-140** (single): missing skill: coding
- **R-CD-MAX-145** (single): missing skill: coding
- **R-CD-MAX-149** (single): missing skill: coding
- **R-CD-MAX-150** (single): missing skill: coding
- **R-CD-MAX-154** (single): missing skill: coding
- **R-CD-MAX-161** (single): missing skill: coding
- **R-CD-MAX-167** (single): missing skill: coding
- **R-CD-MAX-168** (single): missing skill: coding
- **R-CD-MAX-169** (single): missing skill: coding
- **R-CD-MAX-175** (single): missing skill: coding
- **R-CD-MAX-183** (single): missing skill: coding
- **R-CD-MAX-187** (single): missing skill: coding
- **R-CD-MAX-189** (single): missing skill: coding
- **R-CD-UI-001** (single): missing reference: skills/design/references/components-and-motion.md
- **R-DS-MAX-101** (single): missing skill: design
- **R-SC-MAX-101** (single): missing skill: skill-creator
- **R-SC-MAX-102** (single): missing skill: skill-creator
