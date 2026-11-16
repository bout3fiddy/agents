# Harness integrations

Harness-specific behavior belongs in its own directory. Shared skills and personal defaults remain
in `skills/` and `instructions/`.

- [Pi](pi/README.md) owns its orchestration, prompts, roles, checks and installation.
- `bin/sync.sh` retains the existing Codex installation behavior. It does not install Pi or Claude.
- [Claude](claude/README.md) stays free of globally installed repository instructions and skills.
- `bin/sync-pi.sh` installs only Pi. It must not write to `.agents`, `.codex` or `.claude`.

Do not add Pi orchestration instructions to the shared global prompt or shared skills.
