# Primitive Obsession

Category: Bloaters

## Signals
- Domain concepts are represented with raw primitives.
- Validation/parsing rules are duplicated everywhere.
- Type codes drive behavior in many places.

## Common patterns to flag (anonymized)

Note: these snippets are examples. Real code often differs in syntax/structure; match on behavior and intent, not exact text.

### Domain rules repeated around string/int fields

```pseudo
function create_account(email_str, country_code_str, age_int):
    if "@" not in email_str:
        raise ValidationError
    if country_code_str not in ["US", "CA", "IN"]:
        raise ValidationError
    if age_int < 18:
        raise ValidationError
```

Reviewer heuristic: repeated primitive validation across services usually indicates missing value objects (Email, CountryCode, Age).

## Typical refactor directions
- Replace Data Value with Object.
- Introduce Parameter Object.
- Replace Type Code with Subclasses, State, or Strategy.
