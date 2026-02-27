---
metadata:
  id: coding.ref.react.web-interface-guidelines
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - ui review
    - design review
    - web interface
    - react review
    - references
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---

# Web Interface Guidelines (UI Review Reference)

Use this when reviewing React/Next.js UI for design/accessibility/UX quality.

## Source of Truth
Fetch the latest guidelines before each review:

```
https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md
```

## Workflow
1) Fetch the guidelines from the source URL above.
2) Read the target files (or ask the user for a file/pattern).
3) Check all rules from the fetched guidelines.
4) Output findings in the terse `file:line` format required by the guidelines.

If no files are specified, ask which files to review.
