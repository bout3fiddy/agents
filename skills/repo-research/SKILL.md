---
name: repo-research
description: Clone and inspect a specific external repository or subdirectory (e.g., GitHub skill directories) to extract patterns, rules, or architecture. Use when asked to “investigate” an external repo, compare skills, or extract best practices.
---

# Repo Research (Clone → Read → Remove)

## Goal
Quickly extract information from a specific repo or subdirectory without leaving artifacts behind.

## Workflow
1) **Create a temp workspace** (use `.tmp/` under the current repo or `/tmp/`).
2) **Shallow clone** the repo (and branch if provided).
3) **Scope to the target folder**:
   - If only a subdirectory is needed, use sparse checkout.
4) **Read only what’s required** (docs, rules, SKILL.md, references).
5) **Summarize findings** and map them to local skills or patterns.
6) **Delete the temp clone** when done.

## Suggested commands (safe defaults)

```bash
# 1) Clone shallow
git clone --depth 1 --branch <branch> <repo-url> .tmp/<repo>

# 2) Sparse checkout only a subdir (optional)
cd .tmp/<repo>
git sparse-checkout init --cone
git sparse-checkout set <path/to/subdir>

# 3) Read files
ls <path>
sed -n '1,160p' <path>/SKILL.md
rg -n "<keyword>" <path>

# 4) Cleanup
cd -
rm -rf .tmp/<repo>
```

## Output expectations
- Provide a concise summary of structure and key rules.
- Identify how to map/translate patterns to the local stack.
- Call out any missing pieces or mismatches with local skills.

## Guardrails
- Do not keep temp clones after the task.
- Do not modify the external repo.
- Avoid reading secrets or credentials.
