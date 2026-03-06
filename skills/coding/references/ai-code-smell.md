# AI Code Smell: Fallback-First Implementations

**When**: Any code change — this is an always-check guardrail.
**Key rules**: Hard cutovers by default. No fallback shims without explicit approval + owner + removal date + tracking issue.

---

## Coding rule (default policy)
- Use hard cutovers by default.
- Do not add runtime fallbacks, compatibility shims, dual-read/dual-write paths, or "temporary legacy" branches unless the user explicitly requires that risk profile.
- If an exception is explicitly approved, record all of:
  - owner
  - removal date
  - tracking issue/link
  - non-destructive validation plan

### Adapter/minimal-wrapper guardrail
When implementing small adapter or wrapper functions, do not recreate defensive compatibility scaffolding from source modules.

- Do not copy `Protocol`/typing scaffolding unless the user explicitly asks for types.
- Do not add `callable(...)` guards or broad `try/except` around normal-path calls.
- Do not wrap already-boolean return values in `bool(...)`.
- Prefer direct, explicit returns over kwargs accumulation and fallback variants.
- If only 2-3 functions are requested, implement only those functions unless additional structure is explicitly required.

## Signals
- New logic keeps the old path "just in case."
- Feature flags preserve both old and new behavior without expiry.
- New code introduces duplicated branches for legacy/new behavior.
- Comments such as "temporary fallback" without a concrete removal plan.

## Common patterns to flag

### Schema-aware fallback

```pseudo
try:
    write_new_schema(payload)
except MissingColumnError:
    write_legacy_schema(payload)
```

### Sequential fetch fallback chain

```pseudo
value = read_new_source()
if not value:
    value = read_legacy_source()
if not value:
    value = read_metadata_backup()
return value
```

### Broad catch-and-continue to legacy

```pseudo
try:
    result = call_new_path()
except Exception:
    log_warning("new path failed")
return call_legacy_path()
```

### Resolver that keeps old/new implementations alive

```pseudo
engine = resolve_engine(options)
if engine == "legacy":
    return legacy_impl(options)
return modern_impl(options)
```

### Multi-field compatibility chain

```pseudo
normalized = payload.new_field or payload.legacyField or payload.old_field or ""
```

## Why this is a smell
- Increases maintenance and regression surface.
- Hides correctness gaps that should be fixed directly.
- Creates long-lived dead paths that become operational risk.

## Preferred refactor directions
- Replace old path with the new path in one coherent change.
- Delete redundant legacy branches in the same PR when safe.
- Prove safety with targeted tests instead of fallback branches.
- If phased rollout is required, use a one-way migration with explicit expiry and cleanup ownership.
