# Skill Creation Checklist

- [ ] `SKILL.md` has required frontmatter (name + description)
- [ ] Name matches directory and uses lowercase hyphen-case
- [ ] `SKILL.md` is concise (<500 lines)
- [ ] Large content moved to `references/`
- [ ] Run: `python3 skills/skill-creator/scripts/build_agents_index.py`
- [ ] Run: `skills-ref validate skills/<name>`
- [ ] Sync if requested (`bin/sync.sh`)
