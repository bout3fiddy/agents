# Claude baseline

Claude Code has no globally installed instructions or skills from this repository.
Its login, model preference, permissions and ordinary interactive settings remain user-owned.
`clod` remains the user's alias for `claude --dangerously-skip-permissions`.

Run `python3 harnesses/claude/reset.py` once to remove the old `CLAUDE.md`, skills,
agents, commands and workflows. This leaves credentials and settings untouched.
The user explicitly requested no backup: canonical instructions and skills remain
in this repository and can be copied back when wanted.

Pi invokes Claude Code with the same permission flag as `clod`, an empty working
directory, explicit system prompt, disabled settings sources/hooks/automatic
memory/skills, and an exclusive MCP tool server. The server supplies scoped reads,
sandboxed commands and, for performance work, scoped benchmark writes.

The three Claude role prompts live under [Pi prompts](../pi/prompts/).
They are passed directly as system prompts. Selected canonical references are
available through `read_reference`; no global skill invocation is required.

`bin/sync.sh` installs the existing Codex assets only. It cannot repopulate Claude.
The separate Pi installer does not modify Claude's global configuration.
