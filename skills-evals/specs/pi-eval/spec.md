# Pi Eval Extension Spec

## Summary
A Pi extension that audits the current agent configuration and runs repeatable evals
against auto-invoked skills. The extension is installed temporarily, run for audits
and evals, and removed without modifying runtime code in the repo.

## Manual Steps (Operator Checklist)
1) Install Pi locally.
2) Configure Codex OAuth in your environment (no interactive login during evals).
3) Add the pi-eval extension to Pi (symlink or copy into Pi extensions dir).
4) Run `pi eval audit --model codex` to confirm settings and skill inventory.
5) Run `pi eval run --cases <path> --model codex` to generate the report.
6) Commit the report and index updates.
7) Once Pi is installed, enable strict sync gating (no bypass).

## Implementation Choice (Current)
Implement now (recommended):
- Build the pi-eval extension and `bin/pi-eval.sh` wrapper now.
- Keep sync gating disabled until Pi is installed.
- Once Pi is available, run evals and then enable strict gating.

## Goals
- Report the skill inventory for the active Pi agent and selected model.
- Verify required global instructions are present and pinned for the chosen model.
- Run eval cases that validate auto-skill invocation, non-invocation, and
  inter-skill interference.
- Validate reference invocation within skills when trigger conditions match.
- Measure token efficiency per run (prompt + tool calls + output), and flag
  regressions against thresholds.
- Support a dry-run mode that detects skill invocation attempts without loading
  SKILL.md content.
- Produce model-specific, commit-referenced eval reports that are checked into
  the repo and used to gate syncing.

## Non-Goals
- Provide an eval framework for non-Pi runtimes.
- Modify Pi core behavior outside the eval run.
- Guarantee deterministic model outputs beyond skill invocation signals.

## Terminology
- Skill invocation: a read tool call of a SKILL.md file.
- Reference invocation: a read tool call of a references/* file within a skill.
- Attempted invocation: a SKILL.md read that is blocked in dry-run mode.
- Dry-run: tool-call interception blocks SKILL.md reads; only attempts are logged.
- Global instructions: required instruction files for a given model.

## Location and Packaging
- Spec location: docs/specs/pi-eval/spec.md
- Extension location (when implemented): extensions/pi-eval/

## Tech Stack
- Language: TypeScript (Node.js runtime).
- Pi integration: Pi extension system with custom CLI command and tool_call
  interception for dry-run.
- CLI: non-React stack using chalk or picocolors, boxen, cli-table3 (or @tbl/table),
  and log-symbols.
- Process isolation: spawn `pi` subprocesses per case (child_process or execa).
- File I/O: fs/promises, path, os; optional fast-glob for skill/ref discovery.
- Config and cases: JSON files on disk.

## CLI Surface
- pi eval
  - Default audit of the current agent dir and model from settings.
- pi eval audit --model <name> [--agent-dir <path>]
  - Audit with explicit model selection.
- pi eval run --cases <path> [--model <name>] [--dry-run] [--matrix <name>]
  [--agent-dir <path>] [--filter <id|suite>] [--limit <n>]
  - Run eval cases; one isolated Pi run per case.
- pi eval smoke [--model <name>] [--dry-run]
  - Run a small built-in dataset.

## Configuration
### Eval Config File
Suggested path: extensions/pi-eval/config/eval.config.json

Schema (proposal):
{
  "requiredModels": ["codex"],
  "models": {
    "model-name": {
      "globalInstructions": ["AGENTS.md", "instructions/global.md"]
    }
  },
  "defaults": {
    "agentDir": ".",
    "skillsPaths": [".pi/skills", "~/.pi/agent/skills"],
    "dryRun": false
  }
}

### Case Schema
Each case is a single-run eval with expected skill behavior.

Schema (proposal):
{
  "id": "skill-basic-001",
  "prompt": "User prompt text",
  "turns": ["optional multi-turn", "script"],
  "expectedSkills": ["skill-a"],
  "disallowedSkills": ["skill-b"],
  "expectedRefs": ["skills/skill-a/references/foo.md"],
  "assertions": ["must_contain:XYZ", "must_not_contain:ABC"],
  "skillSet": ["skill-a", "skill-b"],
  "dryRun": false,
  "tokenBudget": 1200,
  "notes": "optional"
}

## Eval Case Source
- Primary source of truth: skills-evals/specs/pi-eval/evals.md
- docs/specs/pi-eval is a mirror; keep both in sync.
- The eval runner should read the JSONL case registry from that file, or the
  file can be exported to a .jsonl file for execution.
- Use skills-evals/bin/build-cases.sh to generate skills-evals/cases/pi-eval.jsonl.
- Case IDs must remain stable to preserve report history.

## Implementation Checklist
- [ ] Build the pi-eval extension skeleton.
- [ ] Implement `pi eval audit` with model + skills inventory output.
- [ ] Implement `pi eval run` with per-case isolation.
- [ ] Support dry-run blocking of SKILL.md reads.
- [ ] Parse the case registry from skills-evals/specs/pi-eval/evals.md.
- [ ] Generate model-specific reports + index.json.
- [ ] Add strict sync gating (enabled after Pi install).
- [ ] Document manual install/remove steps for the extension.

## Feedback Loops (Sandboxed Iteration)
- Use a temporary agent dir to avoid polluting real settings:
  `pi eval audit --model codex --agent-dir /tmp/pi-eval-agent`
- Run a small subset by suite or ID while developing:
  `pi eval run --cases skills-evals/specs/pi-eval/evals.md --model codex --filter refs-coding --limit 3`
- Use dry-run for side-effecting skills:
  `pi eval run --cases skills-evals/specs/pi-eval/evals.md --model codex --dry-run --filter agent-observability`
- Iterate: change code -> rerun subset -> confirm pass -> expand to full suite.

## Authentication
- When the selected model uses Codex, use existing Codex OAuth credentials.
- Do not prompt for interactive login during evals.
- Prefer standard environment variables first, then Codex config dir
  (e.g., ~/.codex, which may be bind-mounted in devcontainers).
- If OAuth is missing, fail fast with a clear message about how to authenticate.

## Execution Flow
### Audit
- Read active settings and resolve the selected model
  (CLI override > settings default).
- Enumerate discovered skills and their names/descriptions.
- Verify required global instruction files exist for the selected model.
- Print a human-readable summary with warnings and errors.

### Eval Run
- For each case, spawn a fresh Pi process with:
  - explicit agentDir
  - pinned model
  - case-specific skill set (or defaults)
- Log tool calls and read calls for each run.
- Determine invocation by SKILL.md read signal.
- Score case against expected/disallowed skills and output assertions.
- Print per-case status and an overall summary.

## Dry-Run Mode
- Intercept tool_call events for read operations targeting SKILL.md.
- Block the read and record an attempted invocation.
- Use attempted invocations for scoring in dry-run mode.

## Inter-Skill Interference Testing
- Matrix mode runs:
  - Baseline: target skill(s) only.
  - Interference: target skill(s) + distractor skills.
- Compare:
  - invocation rate of target skills
  - false positives from distractor skills
  - output drift (optional assertions)

## Scoring and Reporting
- Per-case: PASS/FAIL with a short reason.
- Summary: totals, pass rate, invocation precision/recall per skill,
  top false positives.
- Reference accuracy: pass/fail per expected reference; include precision/recall
  if reference checks are enabled for a suite.
- Output: human-readable only.
- Optional: store JSONL artifacts in a temp directory for debugging.
- Token efficiency: track tokens in/out and total tokens per case; report
  max, median, and p95; allow per-suite thresholds and flag regressions.

## Reports and Model Coverage
- Reports are model-specific and must be committed to the repo.
- Report path: docs/specs/pi-eval/reports/YYYY-MM-DD/<model>_<shortsha>.md
- Include: model name, commit SHA, run date/time, cases executed, pass/fail
  totals, token stats, and any failed cases.
- Maintain a machine index: docs/specs/pi-eval/reports/index.json mapping
  model -> last evaluated commit SHA + timestamp.
- A model is considered "up to date" if its latest report commit SHA is at or
  after the most recent change to skills/ or instructions/global.md.
- Models without access or subscription should not be listed in requiredModels
  and are not gated until added later.

## Sync Gating
- Sync is blocked unless all required models have up-to-date eval reports.
- Required models are defined in eval.config.json (e.g., models.required list).
- Sync gate checks only these paths for changes:
  - skills/**
  - instructions/global.md
- There is no bypass flag; sync is strictly gated on eval completion.
- Until Pi is installed and the eval runner is available, sync should warn and
  skip gating. Once enabled, gating is strict with no bypass.

## CLI Output Style
- Use color consistently: green for pass, yellow for warn, red for fail,
  cyan for headings, dim for secondary info.
- Use panels to group sections: Audit, Skills, Global Instructions, Runs,
  Summary, Failures.
- Use tables for skill inventory and per-case results.
- Use status badges and short icons where helpful (ASCII only):
  OK, WARN, FAIL, SKIP, DRY.
- Keep line width under 100 columns and avoid noisy wrapping.
- Provide a compact summary at the end with counts and elapsed time.
- Use a non-React render stack: chalk or picocolors for color, boxen for panels,
  cli-table3 (or table from @tbl) for tables, and log-symbols for icons.

## Determinism and Safety
- One case per fresh process to avoid state bleed.
- Model pinned per run from CLI or settings.
- Dry-run blocks SKILL.md reads to prevent side effects.
- No writes outside temp/log directories.

## Acceptance Criteria
- pi eval prints skill inventory and global instruction status for the chosen model.
- pi eval run --cases X runs cases and reports invocation correctness.
- pi eval run --dry-run blocks SKILL.md reads and still reports attempted invocations.
- Matrix mode shows deltas between baseline and interference runs.
- Extension is installable and removable without repo runtime changes.

## Open Questions
- Exact mapping of model name to global instruction file set.
- Default locations for skills and instructions in the target environment.
- Preferred format for optional output assertions.
