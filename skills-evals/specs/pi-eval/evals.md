# Pi Eval Cases (Skills)

This file is the source of truth for eval cases. The eval runner should parse
and execute the JSONL case registry below.

## Case Format
Each line in the registry is a standalone JSON object with these fields:
- id: stable case ID
- suite: grouping label (used for filtering)
- prompt: user prompt string
- expectedSkills: skills that must be invoked
- disallowedSkills: skills that must not be invoked
- expectedRefs: reference files that must be read
- skillSet: installed skills for the case (subset of all skills)
- dryRun: when true, block SKILL.md reads and log attempted invocations
- tokenBudget: integer token budget or null

## Case Registry (JSONL)
{"id":"AB-001","suite":"agent-browser","prompt":"Open https://example.com and take a screenshot of the hero section.","expectedSkills":["agent-browser"],"disallowedSkills":["coding","planning","skill-creator","agent-observability"],"expectedRefs":[],"skillSet":["agent-browser"],"dryRun":true,"tokenBudget":null}
{"id":"AB-002","suite":"agent-browser","prompt":"Navigate to https://example.com, fill the login form with test data, and capture the confirmation message.","expectedSkills":["agent-browser"],"disallowedSkills":["coding","planning","skill-creator","agent-observability"],"expectedRefs":[],"skillSet":["agent-browser"],"dryRun":true,"tokenBudget":null}
{"id":"AB-003","suite":"agent-browser","prompt":"Summarize the differences between Playwright and Selenium.","expectedSkills":[],"disallowedSkills":["agent-browser"],"expectedRefs":[],"skillSet":["agent-browser"],"dryRun":true,"tokenBudget":null}
{"id":"AB-004","suite":"cross-agent-browser-coding","prompt":"Open https://example.com and click the signup button.","expectedSkills":["agent-browser"],"disallowedSkills":["coding"],"expectedRefs":[],"skillSet":["agent-browser","coding"],"dryRun":true,"tokenBudget":null}
{"id":"AB-005","suite":"cross-agent-browser-planning","prompt":"Plan a browser automation workflow for QA without visiting any sites.","expectedSkills":["planning"],"disallowedSkills":["agent-browser"],"expectedRefs":[],"skillSet":["agent-browser","planning"],"dryRun":true,"tokenBudget":null}

{"id":"AO-001","suite":"agent-observability","prompt":"Don't do that again - always ask before editing config files.","expectedSkills":["agent-observability"],"disallowedSkills":[],"expectedRefs":[],"skillSet":["agent-observability"],"dryRun":true,"tokenBudget":null}
{"id":"AO-002","suite":"agent-observability","prompt":"Stop running tests automatically; only run when I ask.","expectedSkills":["agent-observability"],"disallowedSkills":[],"expectedRefs":[],"skillSet":["agent-observability"],"dryRun":true,"tokenBudget":null}
{"id":"AO-003","suite":"agent-observability","prompt":"That's confusing.","expectedSkills":[],"disallowedSkills":["agent-observability"],"expectedRefs":[],"skillSet":["agent-observability"],"dryRun":true,"tokenBudget":null}
{"id":"AO-004","suite":"cross-observability-coding","prompt":"Don't do that again - always ask before editing config files. Now update the README.","expectedSkills":["agent-observability","coding"],"disallowedSkills":[],"expectedRefs":[],"skillSet":["agent-observability","coding"],"dryRun":true,"tokenBudget":null}
{"id":"AO-005","suite":"cross-observability-planning","prompt":"Stop running tests automatically; draft a plan instead.","expectedSkills":["agent-observability","planning"],"disallowedSkills":[],"expectedRefs":[],"skillSet":["agent-observability","planning"],"dryRun":true,"tokenBudget":null}

{"id":"CD-001","suite":"coding","prompt":"Fix the failing test in auth middleware and add a regression test.","expectedSkills":["coding"],"disallowedSkills":[],"expectedRefs":[],"skillSet":["coding"],"dryRun":true,"tokenBudget":null}
{"id":"CD-002","suite":"coding","prompt":"Refactor this module to remove duplication and add validation at the API boundary.","expectedSkills":["coding"],"disallowedSkills":[],"expectedRefs":[],"skillSet":["coding"],"dryRun":true,"tokenBudget":null}
{"id":"CD-003","suite":"coding","prompt":"Explain what a mutex is.","expectedSkills":[],"disallowedSkills":["coding"],"expectedRefs":[],"skillSet":["coding"],"dryRun":true,"tokenBudget":null}
{"id":"CD-004","suite":"cross-planning-coding","prompt":"Add validation to the API handler and a unit test.","expectedSkills":["coding"],"disallowedSkills":["planning"],"expectedRefs":[],"skillSet":["coding","planning"],"dryRun":true,"tokenBudget":null}
{"id":"CD-005","suite":"cross-agent-browser-coding","prompt":"Open https://example.com and take a screenshot.","expectedSkills":["agent-browser"],"disallowedSkills":["coding"],"expectedRefs":[],"skillSet":["coding","agent-browser"],"dryRun":true,"tokenBudget":null}

{"id":"PL-001","suite":"planning","prompt":"I want an eval framework, but I'm not sure how it should work.","expectedSkills":["planning"],"disallowedSkills":[],"expectedRefs":[],"skillSet":["planning"],"dryRun":true,"tokenBudget":null}
{"id":"PL-002","suite":"planning","prompt":"Draft a spec and plan for adding a new eval runner.","expectedSkills":["planning"],"disallowedSkills":[],"expectedRefs":[],"skillSet":["planning"],"dryRun":true,"tokenBudget":null}
{"id":"PL-003","suite":"planning","prompt":"Add a simple README section describing this command.","expectedSkills":[],"disallowedSkills":["planning"],"expectedRefs":[],"skillSet":["planning"],"dryRun":true,"tokenBudget":null}
{"id":"PL-004","suite":"cross-planning-coding","prompt":"Implement the spec you just wrote.","expectedSkills":["coding"],"disallowedSkills":["planning"],"expectedRefs":[],"skillSet":["planning","coding"],"dryRun":true,"tokenBudget":null}
{"id":"PL-005","suite":"cross-skill-creator-planning","prompt":"Create a new skill for database migrations.","expectedSkills":["skill-creator"],"disallowedSkills":["planning"],"expectedRefs":[],"skillSet":["planning","skill-creator"],"dryRun":true,"tokenBudget":null}

{"id":"SC-001","suite":"skill-creator","prompt":"Create a new skill for database migrations and add references.","expectedSkills":["skill-creator"],"disallowedSkills":[],"expectedRefs":[],"skillSet":["skill-creator"],"dryRun":true,"tokenBudget":null}
{"id":"SC-002","suite":"skill-creator","prompt":"Update the existing coding skill to include async guidance.","expectedSkills":["skill-creator"],"disallowedSkills":[],"expectedRefs":[],"skillSet":["skill-creator"],"dryRun":true,"tokenBudget":null}
{"id":"SC-003","suite":"skill-creator","prompt":"Explain what a skill is in this repo.","expectedSkills":[],"disallowedSkills":["skill-creator"],"expectedRefs":[],"skillSet":["skill-creator"],"dryRun":true,"tokenBudget":null}
{"id":"SC-004","suite":"cross-skill-creator-coding","prompt":"Modify skills/coding/SKILL.md to add async guidance.","expectedSkills":["skill-creator"],"disallowedSkills":["coding"],"expectedRefs":[],"skillSet":["skill-creator","coding"],"dryRun":true,"tokenBudget":null}

{"id":"R-CD-UI-001","suite":"refs-coding","prompt":"Design a UI layout with motion for a landing page.","expectedSkills":["coding"],"disallowedSkills":[],"expectedRefs":["skills/coding/references/frontend-engineering/index.md"],"skillSet":["coding"],"dryRun":false,"tokenBudget":null}
{"id":"R-CD-INF-001","suite":"refs-coding","prompt":"Deploy this service to Cloud Run and handle secrets safely.","expectedSkills":["coding"],"disallowedSkills":[],"expectedRefs":["skills/coding/references/platform-engineering/index.md"],"skillSet":["coding"],"dryRun":false,"tokenBudget":null}
{"id":"R-CD-PR-001","suite":"refs-coding","prompt":"Review this PR and fix the CI failure in GitHub Actions.","expectedSkills":["coding"],"disallowedSkills":[],"expectedRefs":["skills/coding/references/gh-pr-review-fix.md"],"skillSet":["coding"],"dryRun":false,"tokenBudget":null}
{"id":"R-CD-BUN-001","suite":"refs-coding","prompt":"Switch this repo to bun and update the JS toolchain config.","expectedSkills":["coding"],"disallowedSkills":[],"expectedRefs":["skills/coding/references/bun.md"],"skillSet":["coding"],"dryRun":false,"tokenBudget":null}
{"id":"R-CD-AUTH-001","suite":"refs-coding","prompt":"Where should we store credentials and how should we access them?","expectedSkills":["coding"],"disallowedSkills":[],"expectedRefs":["skills/coding/references/secrets-and-auth-guardrails.md"],"skillSet":["coding"],"dryRun":false,"tokenBudget":null}
{"id":"R-CD-SOLID-001","suite":"refs-coding","prompt":"Implement this component in SolidJS.","expectedSkills":["coding"],"disallowedSkills":[],"expectedRefs":["skills/coding/references/solidjs/index.md"],"skillSet":["coding"],"dryRun":false,"tokenBudget":null}
{"id":"R-CD-REACT-001","suite":"refs-coding","prompt":"Build this feature in React/Next.js.","expectedSkills":["coding"],"disallowedSkills":[],"expectedRefs":["skills/coding/references/react/index.md"],"skillSet":["coding"],"dryRun":false,"tokenBudget":null}
{"id":"R-CD-TAIL-001","suite":"refs-coding","prompt":"Style this component using Tailwind utilities.","expectedSkills":["coding"],"disallowedSkills":[],"expectedRefs":["skills/coding/references/frontend-engineering/tailwindcss-full.md"],"skillSet":["coding"],"dryRun":false,"tokenBudget":null}

{"id":"R-PL-ASK-001","suite":"refs-planning","prompt":"I need an eval runner but I'm not sure how it should work.","expectedSkills":["planning"],"disallowedSkills":[],"expectedRefs":["skills/planning/references/ask-questions-if-underspecified.md"],"skillSet":["planning"],"dryRun":false,"tokenBudget":null}
{"id":"R-PL-SPEC-001","suite":"refs-planning","prompt":"Draft a spec and iterative plan for the eval framework.","expectedSkills":["planning"],"disallowedSkills":[],"expectedRefs":["skills/planning/references/spec-driven-iterative-builder.md"],"skillSet":["planning"],"dryRun":false,"tokenBudget":null}
{"id":"R-PL-LINEAR-001","suite":"refs-planning","prompt":"Create Linear tickets for the eval framework work.","expectedSkills":["planning"],"disallowedSkills":[],"expectedRefs":["skills/planning/references/linear-mcp-ops.md"],"skillSet":["planning"],"dryRun":false,"tokenBudget":null}

{"id":"R-SC-SKEL-001","suite":"refs-skill-creator","prompt":"Create a new skill using the standard skeleton template.","expectedSkills":["skill-creator"],"disallowedSkills":[],"expectedRefs":["skills/skill-creator/references/templates/skill-skeleton.md"],"skillSet":["skill-creator"],"dryRun":false,"tokenBudget":null}
{"id":"R-SC-RULES-001","suite":"refs-skill-creator","prompt":"Add a rules section to this skill using the rules template.","expectedSkills":["skill-creator"],"disallowedSkills":[],"expectedRefs":["skills/skill-creator/references/templates/rules-template.md"],"skillSet":["skill-creator"],"dryRun":false,"tokenBudget":null}
{"id":"R-SC-CHECK-001","suite":"refs-skill-creator","prompt":"Run the skill-creator checklist for this new skill.","expectedSkills":["skill-creator"],"disallowedSkills":[],"expectedRefs":["skills/skill-creator/references/checklist.md"],"skillSet":["skill-creator"],"dryRun":false,"tokenBudget":null}

{"id":"R-AO-PR-001","suite":"refs-agent-observability","prompt":"Log this correction and draft a policy change PR summary.","expectedSkills":["agent-observability"],"disallowedSkills":[],"expectedRefs":["skills/agent-observability/references/pr-template.md"],"skillSet":["agent-observability"],"dryRun":false,"tokenBudget":null}
{"id":"R-AO-SELF-001","suite":"refs-agent-observability","prompt":"Log this correction and record the self-heal metadata.","expectedSkills":["agent-observability"],"disallowedSkills":[],"expectedRefs":["skills/agent-observability/references/self-heal.json"],"skillSet":["agent-observability"],"dryRun":false,"tokenBudget":null}

{"id":"TE-001","suite":"token-efficiency","prompt":"Create a new skill for database migrations and add references.","expectedSkills":["skill-creator"],"disallowedSkills":[],"expectedRefs":[],"skillSet":["agent-browser","agent-observability","coding","planning","skill-creator"],"dryRun":true,"tokenBudget":1200}
{"id":"TE-002","suite":"token-efficiency","prompt":"Draft a spec and plan for adding a new eval runner.","expectedSkills":["planning"],"disallowedSkills":[],"expectedRefs":[],"skillSet":["agent-browser","agent-observability","coding","planning","skill-creator"],"dryRun":true,"tokenBudget":1200}
