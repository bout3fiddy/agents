---
name: coding
description: Use for code implementation, bug fixes, refactors, code reviews, and technical guidance. Covers smell detection — no separate smell skill needed.
---

# Coding

## Principles

Write code that is:
- **Legible** — small modules, explicit names, no magic. Another agent should understand any file without reading the whole codebase.
- **Replaceable** — clear interfaces and contracts. Any module should be deletable and rewritable from its signature alone, without touching neighbors.
- **Verifiable** — types, tests, and mechanical checks. If you can't prove it works without reading every line, it's not done.

## Workflow

1. **Reuse first.** Before writing anything, scan for existing modules, types, or utilities you can import. Never write a redundant copy.
2. **Scope.** Confirm scope, constraints, and acceptance criteria.
3. **Read.** Read only necessary code paths.
4. **Write modular code.** Small functions, typed interfaces, explicit state. No god files, no global mutable state, no stringly-typed returns.
5. **Self-review.** Check your output against the hard rules and smell signals below. Fix violations before presenting.
6. **Verify.** Add or update tests when behavior changes. Types should catch contract violations at boundaries.
7. **Summarize.** Changes, validations, remaining risks.

## Hard rules

- No fallback-first implementations — hard cutovers by default. See `references/ai-code-smell.md`.
- No compatibility shims or dual paths without explicit user approval + documented owner, removal date, tracking issue.
- No broad catch blocks that silently fall back to legacy behavior.
- No `or`/`||` chains over mixed old/new field names with silent defaults.

## Smell signals (avoid these)

- **Speculative Generality** — abstractions, params, or config for hypothetical future use with no current caller.
- **Duplicate Code** — copy-paste of similar logic instead of extracting a shared function or module.
- **Long Method** — function blending multiple responsibilities or >40 lines. If you can't name what it does in one phrase, split it.
- **Large Class** — class spanning unrelated domains. If it needs multiple section headers, it's too big.
- **Feature Envy** — method uses another object's data more than its own.
- **Dead Code** — unreachable branches, unused functions, permanently disabled flags. Delete them.
- **Primitive Obsession** — domain concepts as raw strings/ints with validation scattered across call sites.
- **Shotgun Surgery** — a single logical change requires edits scattered across many files.
- **Middle Man** — class mostly forwards calls without adding policy. Remove the indirection.
- **Data Clumps** — same group of fields travels together across signatures without a named type.
- **Inappropriate Intimacy** — classes reaching into each other's private/internal state.

## Quality rules

- Preserve existing architecture unless the task explicitly asks for structural change.
- Keep edits small, cohesive, and traceable to the request.
- Do not auto-refactor unless the user explicitly asks for code changes.
