---

name: design
description: Frontend design curation skill for UI critique, motion storyboarding, and DialKit tuning. Use when the user asks for interface feedback, animation sequencing, or interactive design-control setup.
metadata:
  id: design.core
  version: "1"
  task_types:
    - design
    - ui-review
    - animation
    - dialkit
  trigger_phrases:
    - UI review
    - interface feedback
    - visual critique
    - motion
    - storyboard
    - animation
    - timing
    - DialKit
  priority: 70
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
    - design_request_detected
    - ui_critique_requested
    - animation_request_detected
    - dialkit_request_detected
  operation_contracts:
    critique:
      required_steps:
        - Parse request intent, scope, and context.
        - Select the critique reference module and validate available inputs.
        - Produce structured findings ranked by structural/behavioral/visual impact.
      required_output_fields:
        - lane
        - context
        - first_impressions
        - top_opportunities
        - evidence
      forbidden_actions:
        - apply_patch
        - run tests
        - edit repository files
    storyboard_spec:
      required_steps:
        - Parse animation intent and map each requested stage.
        - Convert timing and values into named constants for deterministic control.
        - Return storyboard artifact first, then implementation snippet guidance.
      required_output_fields:
        - lane
        - timing_ms
        - stages
        - elements
        - springs
        - replay_trigger
      forbidden_actions:
        - run tests
        - edit repository files
    dialkit_config:
      required_steps:
        - Confirm dial context (panel name, properties, action keys).
        - Generate control config using canonical defaults source.
        - Return usage examples and integration notes.
      required_output_fields:
        - lane
        - panel_name
        - dial_config
        - defaults_source
        - usage_targets
      forbidden_actions:
        - apply_patch
        - edit repository files

---



# Design (Curated Frontend Design Skill)

Use this skill for design-focused frontend tasks without routing into `coding`.

## Operating rules
- Keep responses design-first: clarity, hierarchy, interaction quality, and user context.
- Use progressive disclosure: open only the reference module needed for the active request.
- If a task mixes critique and implementation, start with critique, then provide concrete implementation guidance.
- Prefer actionable outputs: prioritized issues, concrete edits, and copy-paste-ready snippets when requested.
- If implementation intent is present (implement, fix, refactor, patch, edit, run tests), hand off to coding.
- If the request is ambiguous across modules, ask one brief clarifying question.

## Workflow
1) Detect the lane: critique, animation storyboarding, or DialKit tuning.
2) Open the matching reference file and follow that workflow.
3) Produce structured output with concrete observations and next actions.
4) For follow-up requests, switch modules only if user intent changes.

## Reference triggers (open when clearly relevant)
- UI/layout/styling and component patterns -> `skills/design/references/design-guidelines.md`
- UI components, motion, and animation sequencing -> `skills/design/references/components-and-motion.md`
- Utility-class styling (Tailwind) -> `skills/design/references/tailwindcss-full.md`
- UI critique/review/feedback/audit/polish/refine/redesign -> `skills/design/references/design-critique.md`
- Animation/storyboard/motion/transition/entrance/timing/stagger/spring -> `skills/design/references/storyboard-animation.md`
- DialKit/sliders/controls/tuning panel/live params -> `skills/design/references/dialkit.md`

## References
- `skills/design/references/index.md` - References index for this skill
- `skills/design/references/design-critique.md` - Structured UI critique workflow and output format
- `skills/design/references/storyboard-animation.md` - Stage-driven animation authoring/refactor pattern
- `skills/design/references/dialkit.md` - DialKit control-generation workflow and defaults
