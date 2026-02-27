---

description: Index of reference files for skills/coding/references.
metadata:
  id: coding.ref.index
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - index
    - references
    - references index
    - reference index
  priority: 30
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: true

---


# References Index

## References
- `skills/coding/references/bun.md` - Bun is the preferred JavaScript/TypeScript toolkit when the repo supports it. If a repo is locked to npm/yarn/pnpm, follow its established toolchain and lockfile.
- `skills/coding/references/code-smells/index.md` - Operational smell entrypoint with triage workflow and full catalog links.
- `skills/coding/references/code-smells/smells/ai-code-smell.md` - AI coding rule: no fallback-first implementations; default to hard cutovers.
- `skills/coding/references/gh-pr-review-fix.md` - Follow this workflow to find the latest PR, gather reviewer feedback + CI failures, organize them, and fix them one by one.
- `skills/coding/references/platform-engineering/index.md` - Platform and infra operations playbooks.
- `skills/coding/references/refactoring/index.md` - Refactoring work-package standards, directive command template, and accountability protocol.
- `skills/coding/references/solidjs/index.md` - SolidJS performance guidance and full rule index.
- `skills/coding/references/secrets-and-auth-guardrails.md` - 1) Confirm scope: setup, remediation, or incident response. 2) Warn about side effects: call out any command that may persist credentials locally. 3) If a tool config path is involved (e.g., `CLOUDSDK_CONFIG`), ensure...
