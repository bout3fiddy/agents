---

description: Signals and refactoring directions for Primitive Obsession.
metadata:
  id: coding.ref.code-smells.smells.primitive-obsession
  version: "1"
  task_types:
    - coding
    - code-smell
  trigger_phrases:
    - code smells
    - primitive obsession
    - references
    - smells
    - references code-smells smells primitive-obsession
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---

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
