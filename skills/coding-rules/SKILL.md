---
name: coding-rules
description: Core coding rules for implementation, refactors, and bug fixes. Covers testing, safety, and maintainability guardrails.
---

# Coding Rules (Compressed, Practical)

## 1) Testing and bug fixes

- Every bug fix must include a test that fails before the fix and passes after.
- If a test is genuinely not feasible (rare), state why and how you verified the fix.
- Prefer minimal tests that reproduce the bug and lock in the expected behavior.

## 2) Async consistency

- If a function is async, all I/O inside it must be async.
- Avoid blocking calls in async code (`requests`, `open`, `psycopg2`, `time.sleep`).
- Sync is acceptable for CPU-bound or purely in-memory work.
- Use async equivalents: `httpx.AsyncClient`, `aiofiles`, `asyncpg`, `asyncio.sleep`.

## 3) Input validation at boundaries

- Validate all external input: request bodies, query params, path params, file uploads, webhooks, and external API responses.
- Prefer schema-based validation (Pydantic/Zod); keep validation at boundaries.

## 4) No code injection

- Never execute user-provided code or paths.
- No `eval`, `exec`, `new Function`, dynamic imports, or `shell=True` with user input.
- Sanitize paths; verify ownership before serving resources.

## 5) No secrets access

- Never read or print secrets in conversation context.
- Do not cat/grep `.env` files or secret stores.
- Refer to secret names only; check presence without echoing values.

## 6) Toolchain selection (must follow)

- If `uv.lock` or `pyproject.toml` exists, use `uv` for Python deps and tests (`uv sync`, `uv run pytest`).  
- Never use `pip install` or ad‑hoc venvs unless explicitly asked.  
- For JS/TS, prefer `bun` over npm/yarn/pnpm when possible.  

## 7) SQL safety and query limits

- Always use parameterized queries (no string concatenation or formatting).
- Every SELECT must be bounded (LIMIT, pagination, or a single-row predicate).
- Exceptions: `COUNT(*)`, aggregation with bounded cardinality, or `WHERE id = ?`.

## 8) Avoid race conditions

- Avoid check-then-act and read-modify-write without atomic guards.
- Use transactions, `ON CONFLICT`, `SELECT FOR UPDATE`, and constraints.

## 9) Error handling

- Never swallow exceptions. If you catch, log and re-raise or explain why continuing is safe.
- No empty or silent `except` blocks.

## 10) Configuration and constants

- Do not hardcode magic numbers, URLs, or config values.
- Centralize settings and use named constants.
- Avoid scattered `os.getenv()` calls outside the settings module.

## 11) Architecture and design

- Prefer composition over inheritance; inheritance only for true IS-A or framework requirements.
- Avoid circular imports; keep dependency direction one-way.
- Apply DRY and SOLID: small, focused functions and interfaces.

### DRY and SOLID quick reference

- **DRY**: Extract repeated logic into reusable functions
- **SRP**: One reason to change per function/class
- **OCP**: Extend via abstraction, don't modify existing code
- **LSP**: Subtypes must be substitutable for base types
- **ISP**: Small, focused interfaces - don't force unused methods
- **DIP**: Depend on abstractions, inject dependencies

Checklist:
1. Is this logic duplicated? → Extract it
2. Does this do one thing? → Split if not
3. Am I modifying existing code to extend? → Use abstraction
4. Could I use Protocol instead of ABC? → Prefer Protocol

### Composition over inheritance

Prefer composition (HAS-A) over inheritance (IS-A). Inject dependencies instead of extending classes.

Acceptable inheritance:
- ABCs for interface definition only
- Framework requirements (Django models, Exception subclasses)
- True IS-A relationships (rare)

Red flags:
- Hierarchy > 2 levels deep
- Overriding methods with different behavior
- Mixin classes
- `isinstance()` checks to determine behavior

## 11) Frontend safety

- No client-side console logging in production code.
- Frontend must not access databases or secrets; route privileged ops through a backend API.
- Do not use filesystem, process spawning, or dynamic code execution on the client.

## 12) Database changes

- Schema changes must update both schema and documentation.
- Avoid destructive migrations without explicit confirmation.
- Prefer reversible, incremental changes (add → migrate → remove).

## 13) Supabase local safety (if applicable)

- Never rename, delete, or edit applied migrations.
- Destructive commands (`db reset`, `db push --force`) require explicit confirmation.
- Create new migration files for changes instead of editing applied ones.

## 14) Type hints (Python)

- All Python functions require parameter and return type hints.
- Use modern syntax (`list[str]`, `dict[str, int]`, `X | None`).

## 15) Documentation hygiene

- Do not create unnecessary docs files.
- Necessary docs include user-requested docs, compliance/safety docs, spec-driven required specs for multi-step/exploratory work, and self-reporting logs when triggered.
- If spec-driven is active, the spec is required and does not violate this rule.
