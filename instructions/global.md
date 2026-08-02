# Global Instructions

- Use a task-specific skill only when the request matches its description. Read
  supporting references only when they are relevant; proceed without a skill
  when none applies.
- Follow the repository's lockfiles and documented commands. When the choice is
  otherwise ambiguous, prefer `uv` for Python and `bun` for JavaScript or
  TypeScript.
- Verify changes at the narrowest meaningful boundary. For a reproducible bug,
  add or update focused regression coverage when the repository supports it.
- Stage exact paths only. Do not use `git add .`, `git add -A`, or `git add -f`.
  Inspect ignored state when unsure and review the staged file list before a
  commit. Treat scratch notes, generated output, and execution-status churn as
  non-shipping unless the user or repository explicitly requires them.
- Prefer direct cutovers. Add compatibility paths or fallbacks only when a
  current contract requires them and make their removal conditions explicit.
- Do not introduce leading-underscore names unless an external interface,
  generated code, or the touched area's established convention requires them.
  Preserve user-authored `Feedback:` comments unless asked to remove them.
