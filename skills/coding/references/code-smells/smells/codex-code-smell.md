---
description: Codex code-smell policy that forbids fallback-first implementations and enforces hard cutovers by default.
---
# Codex Code Smell: Fallback-First Implementations

Category: Change Preventers

## Coding rule (default policy)
- Use hard cutovers by default.
- Do not add runtime fallbacks, compatibility shims, dual-read/dual-write paths, or "temporary legacy" branches unless the user explicitly requires that risk profile.
- If an exception is explicitly approved, record all of:
  - owner
  - removal date
  - tracking issue/link
  - non-destructive validation plan

## Signals
- New logic keeps the old path "just in case."
- Feature flags preserve both old and new behavior without expiry.
- New code introduces duplicated branches for legacy/new behavior.
- Comments such as "temporary fallback" without a concrete removal plan.

## Common patterns to flag (anonymized)

### Schema-aware fallback

```pseudo
try:
    write_new_schema(payload)
except MissingColumnError:
    write_legacy_schema(payload)
```

Reviewer heuristic: look for schema exceptions (`MissingColumn`, `UndefinedColumn`) that route to legacy writes.

### Sequential fetch fallback chain

```pseudo
value = read_new_source()
if not value:
    value = read_legacy_source()
if not value:
    value = read_metadata_backup()
return value
```

Reviewer heuristic: multiple ordered reads where each empty/error case advances to an older path.

### Broad catch-and-continue to legacy

```pseudo
try:
    result = call_new_path()
except Exception:
    log_warning("new path failed")
return call_legacy_path()
```

Reviewer heuristic: broad catch blocks that never re-raise and always continue into legacy behavior.

### Resolver that keeps old/new implementations alive

```pseudo
engine = resolve_engine(options)
if engine == "legacy":
    return legacy_impl(options)
return modern_impl(options)
```

Reviewer heuristic: resolver/switch logic that keeps both implementations active without a removal plan.

### Multi-field compatibility chain

```pseudo
normalized = payload.new_field or payload.legacyField or payload.old_field or ""
```

Reviewer heuristic: long `or`/`||` chains over mixed old/new field names with silent empty defaults.

## Why this is a smell
- Increases maintenance and regression surface.
- Hides correctness gaps that should be fixed directly.
- Slows architecture simplification and future refactors.
- Creates long-lived dead/uncertain paths that become operational risk.

## Preferred refactor directions
- Replace old path with the new path in one coherent change.
- Delete redundant legacy branches in the same PR when safe.
- Prove safety with targeted tests and runtime validation instead of fallback branches.
- If phased rollout is required, use a one-way migration with explicit expiry and cleanup ownership.

## Code review checks
- Does this change introduce any fallback branch or compatibility shim?
- If yes, was it explicitly requested and documented with owner/removal date/issue?
- Is there a clear hard-cutover end state and cleanup step?
