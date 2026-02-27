---

description: Signals and refactoring directions for Divergent Change.
metadata:
  id: coding.ref.code-smells.smells.divergent-change
  version: "1"
  task_types:
    - coding
    - code-smell
  trigger_phrases:
    - code smells
    - divergent change
    - references
    - smells
    - references code-smells smells divergent-change
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---

# Divergent Change

Category: Change Preventers

## Signals
- One class changes for many unrelated reasons.
- Release work repeatedly touches the same class for different concerns.
- Responsibility boundaries are blurred.

## Common patterns to flag (anonymized)

Note: these snippets are examples. Real code often differs in syntax/structure; match on behavior and intent, not exact text.

### One class owns multiple change axes

```pseudo
class OrderService:
    function calculate_tax(...)
    function render_receipt_html(...)
    function sync_inventory(...)
    function send_marketing_email(...)
```

Reviewer heuristic: tax policy, rendering, inventory, and marketing usually change for different reasons and should not share one owner.

## Typical refactor directions
- Extract Class.
- Split responsibilities by change axis.
