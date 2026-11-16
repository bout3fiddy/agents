# Pi coding harness

A design partner delegates product work to isolated workers. Accepted designs, executable checks and
independent reviews determine completion.

| Role                     | Runtime/model              | Authority                                |
| ------------------------ | -------------------------- | ---------------------------------------- |
| Orchestrator             | Pi / OpenAI Codex          | Discuss, read, propose, delegate         |
| Implementer              | Pi / inherited Codex model | Assigned product and test paths          |
| Engineering reviewer     | Claude Code / Fable 5.2    | Read, run isolated probes, report        |
| Database reviewer        | Claude Code / Fable 5.2    | Read, run recovery probes, report        |
| Performance investigator | Claude Code / Fable 5.2    | Benchmark/instrumentation paths, reports |

The default Pi model is `openai-codex/gpt-6.1-sol`. Reviewers use high effort; performance uses
medium. Change `roles/*.json` to select models, effort, tools, skills, scopes and budgets. The main
agent never receives shell or product-write tools.

## Install and run

Requires macOS, `sandbox-exec`, Node 22.19+, Python 3.10+, and Claude Code with `--setting-sources`,
`--tools`, `--strict-mcp-config` and `--system-prompt-file`. Development was verified with Pi 1.5.2
and Claude Code 2.1.326.

```sh
cd harnesses/pi
npm ci --ignore-scripts
npm run verify
npm run install:local
npm run doctor
```

From a project directory:

```sh
~/.pi/agent/bin/pi-harness
```

The launcher uses the pinned Pi dependency and disables ambient extensions, skills, prompt
templates, context discovery and MCP. Ordinary `pi` also loads the installed role extension; the
dedicated launcher supplies the full isolation flags even if other global Pi packages are installed
later.

Authenticate independently when needed:

```sh
pi auth login openai-codex
claude auth login
```

Claude workers use `claude --dangerously-skip-permissions`, exactly the user's `clod` alias. A shell
alias is not executable by subprocesses, so the adapter passes its flag explicitly. No permission
dialog is expected inside workers. Their only execution tools are the harness's scoped MCP tools.

## Design and implementation

1. Discuss the problem. The orchestrator uses `propose_design` to write a complete proposal with
   invariants, acceptance criteria, scope and DB/performance flags.
2. Review it and enter `/accept-design HASH`. The command persists the accepted design, starts a
   fresh session and carries forward current work state. It refuses a session switch while user
   input is queued.
3. Ask for implementation. The orchestrator invokes `workflow`.
4. Implementation, applicable performance work, executable checks, engineering review and
   conditional database review run in that order. Findings go back to the implementer. At most three
   rounds run per workflow invocation.
5. Only a fully verified candidate is applied. Concurrent project edits block integration. Required
   checks run again against the integrated project.

An interrupted workflow retains its candidate. Run `workflow` again to resume it: the original
project baseline must still match. An unchanged candidate awaiting review goes through fresh checks
and reviews. Accepting a new design version starts from the current project instead.

Reviewers receive the accepted contract, changed files, original file snapshots and command
receipts. They start with fresh context. The performance investigator can measure, instrument and
report; optimization belongs to the implementer. There is no automatic commit, push, publication or
deployment.

Use `harness_status` in Pi to inspect progress. For explicit headless control:

```sh
node --import /absolute/agents/harnesses/pi/node_modules/tsx/dist/loader.mjs \
  /absolute/agents/harnesses/pi/src/cli.ts status
```

The same CLI supports `draft DESIGN.json`, `accept HASH`, and `run openai-codex/gpt-6.1-sol`. Run
these from the target project's root.

## Project checks

Add `.pi/harness.json` to the target project before implementation. The harness reads and freezes it
outside worker control. Without an adapter, npm `verify` and `test` scripts are inferred when
present. Missing required evidence blocks completion. Database work requires an explicit
recovery/integration check; performance work requires an explicit benchmark check.

```json
{
  "checks": [
    {
      "id": "contract",
      "argv": ["npm", "test"],
      "kind": "test",
      "required": true,
      "timeoutMs": 120000
    },
    {
      "id": "types-and-lint",
      "argv": ["npm", "run", "verify"],
      "kind": "static",
      "required": true,
      "timeoutMs": 120000
    }
  ],
  "databasePaths": ["db/**", "migrations/**", "storage/**"],
  "instrumentationPaths": ["src/instrumentation/**"]
}
```

Allowed check kinds: `test`, `static`, `database`, `benchmark`. Commands are argv arrays; shell
expansion requires an explicit shell. They run with no network, private home access or credential
environment. Install dependencies beforehand. Node dependencies are mounted read-only; services and
virtual environments need an explicit future adapter. Network-backed database checks currently fail
closed.

Write scopes support exact paths, `directory/**`, and `**`. Performance writes must match both the
accepted scope and its role scope or the adapter's explicit instrumentation paths. Worker changes to
`.pi/` are forbidden. Root and nearest folder `AGENTS.md` instructions are supplied when reading
files and assignments.

`project_write` and `project_delete` share the same assignment and role scope. Deletion is limited
to individual files. Private paths are checked using Unicode folding and actual filesystem spelling.
New paths ignored by the project's Git policy are rejected before integration; update that policy
before accepting a design that requires such files. Required checks with truncated output fail; use
concise machine-readable summaries when a test suite is verbose.

## Where the rules live

- `prompts/shared.md`: TigerStyle, all ten NASA rules and language adaptations.
- `prompts/{orchestrator,implementer,reviewer,database-reviewer,performance}.md`: each role's task
  and evidence requirements.
- `roles/*.json`: executable role configuration, including backend and model.
- `scripts/linting/`: actual JS/TS AST and Python token/AST readability checks, JSON validity,
  Unicode-aware 100-column checks and exclusions.
- `.oxlintrc.json`: strict semantic checks for this runtime; `tsconfig.json`: strict TypeScript
  checks. Project-specific semantic lint stays in the project's check adapter.
- `../../skills/`: canonical skills. Role prompts selectively include housekeeping or performance
  engineering. `read_reference` exposes selected benchmark, allocation and compiler references
  without global skill loading.

`project_format` applies the same executable formatting and logical-spacing rules within a worker's
scope. All project checks run again under host control. This does not claim to mechanically prove
TigerStyle, security or test quality; those remain explicit review responsibilities.

## Verification and recovery

```sh
npm run verify
npm run test:live
npm run test:live:basic
```

The live test uses real model calls and a disposable SQLite ledger. It exercises seeded
replay/conflict properties, invalid inputs, SIGKILL recovery, file-backed benchmarks and all five
roles. Reports are written to ignored `reports/`. Set `PI_HARNESS_LIVE_MODEL` to choose another
Codex model for a live run.

The basic live case exercises a seeded parser contract and confirms that database and performance
roles stay inactive when the accepted design does not need them.

Host state lives under `~/.pi/harness-state/<canonical-project-hash>/`: accepted designs, attempts,
command receipts, original snapshots, task state and integration journal. Failed candidates are
retained in the task's `candidate` directory. A cancelled or crashed worker cannot report success. A
subsequent run recovers a pending integration only if every file still matches its recorded before
or after value. Unexpected user edits stop recovery.

Old exploration remains in the Pi session archive but is excluded from model requests after
acceptance, including resume and tree navigation. See [architecture](documentation/architecture.md),
[sources](documentation/sources.md) and [validation](documentation/validation.md) for details and
limitations.

## Separation from other harnesses

Pi installation writes only `~/.pi/`. `bin/sync.sh` preserves the existing Codex instruction/skill
installation. Claude global cleanup is a separate, explicit operation under `../claude/`; Pi
supplies its Claude workers' prompts at launch. Canonical `SKILL.md` content and
`instructions/global.md` are unchanged. Repository-wide lint also covers the executable skill
scripts; formatting changes to those scripts preserve their behavior.
