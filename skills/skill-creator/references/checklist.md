---
metadata:
  id: skill-creator.ref.checklist
  version: "1"
  task_types:
    - skill-creator
    - skills
    - skill-maintenance
    - skill-update
    - skill-creation
  trigger_phrases:
    - skill creation checklist
    - running checklist
    - validate skill file
  priority: 70
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
    - skill_creation_requested
    - skill_update_requested

---

# Skill Creation Checklist

- [ ] `SKILL.md` has required frontmatter (name + description)
- [ ] Name matches directory and uses lowercase hyphen-case
- [ ] `SKILL.md` is concise (<500 lines)
- [ ] Large content moved to `references/`
- [ ] Run: `python3 skills/skill-creator/scripts/build_agents_index.py`
- [ ] Run: `python3 skills/skill-creator/scripts/build_skills_router_artifact.py`
- [ ] Run: `skills-ref validate skills/<name>`
- [ ] Sync if requested (`bin/sync.sh`)
