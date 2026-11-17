# Pi coding harness

Codex workshops designs with the user and parallel Fable advice. It has shell and file tools for
investigation, setup, documents and routine edits. Substantial implementation uses isolated Astra
workers, executable checks and independent Fable reviews.

| Role                     | Model / effort     |
| ------------------------ | ------------------ |
| Orchestrator             | Codex / medium     |
| Design advisor           | Fable 5.2 / medium |
| Implementer              | GPT 6 Astra / high |
| Engineering reviewer     | Fable 5.2 / high   |
| Database reviewer        | Fable 5.2 / high   |
| Performance investigator | Fable 5.2 / medium |

The default orchestrator is `openai-codex/gpt-6.1-sol` at medium effort. Pi's current model and
thinking selection take precedence for the orchestrator; the harness never silently changes them.
Timing traces record the actual selection. Implementation is pinned to `openai-codex/gpt-6-astra` at
high effort. Change `roles/*.json` to select models, effort, tools, skills, scopes and budgets. The
orchestrator has normal host shell/file access; the isolated worker boundaries apply to delegated
execution.

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
dialog is expected inside workers. WebSearch and WebFetch provide public research; command/file
tools use the scoped MCP bridge.

## Design workshop and routine work

Consult Fable for new substantive architecture/security decisions, conflicting constraints,
uncertain platform feasibility or an explicit second opinion. Routine choices, quiz presentation and
mechanical document edits reuse existing advice. Codex quotes the user's wording separately from its
own proposal and develops its own answer while Fable runs. These routing rules are prompt policy,
exercised by the live workshop scenarios; they are not a semantic authorization gate.

Fable receives up to twelve recent user messages, selected documents, folder instructions and
confirmed context. `historyMessages` can select 0–12; omitted history is counted explicitly. Supply
necessary older constraints in `context`. Whole files are limited to 16 KB each; use `excerpts` with
`path`, `startLine` and `lines` (up to 160) for larger documents. Total input is bounded at 48 KB;
oversized inputs fail explicitly. Advice targets 350 words, or 700 with `depth: "deep"`. Output
budgets are instructions, with the existing 32 KB hard response limit retained. Each consultation
uses a fresh Claude instance with WebSearch/WebFetch and explicit prompts. It has no local
execution/file tools, ambient global instructions, skills or memory.

Ready advice is consumed at the next completed model/tool boundary, or triggers a response when Pi
is idle. Codex presents each view, agreements, disagreements, constraints and choices for the user.
`design_consultation` can inspect metadata, await or cancel a job. Automatic delivery and explicit
waits share a persisted consumption record, including waits made after Fable finishes. Advice from
an earlier user request is saved as superseded and does not automatically interrupt the newer
discussion. Waiting consumes the result once; interrupting a wait keeps the background consultation
running. Use explicit cancellation to stop it. There are at most two active consultations; each has
a four-minute budget. Session shutdown, replacement, reload and tree changes cancel pending advice.
Results and inputs live in the project's private harness state under `consultations/`. Resuming can
inspect a saved result; an abandoned running job must be restarted.

When you settle a choice and ask to update the document, Codex saves it directly using ordinary file
tools. Open questions can remain in the document. Saving a design needs no checkpoint,
implementation worker or application test adapter, and does not reset the conversation. A request to
commit an update to a document means save it; Git commits require a specific request.

The orchestrator can use `bash`, `read`, `write`, `edit`, `grep`, `find` and `ls` for its work. Its
delegation rule is behavioral: substantial implementation goes to Astra; ordinary work stays with
the orchestrator. It applies repository lint and appropriate verification to its own changes.
`document_check` checks or formats selected Markdown files with the pinned formatter and 100-column
policy. It reports its scope explicitly; content correctness and links still need review. Prefer one
coherent edit and check over generated checking scripts and repeated document rewrites.

Older bulky file/search tool results and write/edit/shell arguments are excerpted after four newer
model steps. Current-request reads remain intact until a successful write/edit supersedes them;
current shell output also stays. User messages, assistant prose, advice and tool failures remain
intact. Full raw payloads stay in the session trace; persisted context edits survive resume and
compaction. Read current file sections when exact text is needed for editing.

Fable can research current platform details and engineering practices during design advice and
specialist reviews. Its shared `prompts/web-research.md` prefers primary sources, requires source
links and version/context qualifications, and keeps private data out of search queries. Web calls
and their results are recorded in the Claude JSONL trace. Research supplements project tests.

## Substantial implementation

1. Once you request implementation of a settled scope, Codex uses `propose_design` to record its
   invariants, acceptance criteria, permitted paths and DB/performance flags.
2. `/accept-design HASH` is an explicit implementation handoff and context checkpoint. It persists
   that scope and starts a fresh session, preserving current work state. Queued input prevents the
   switch. This command is optional during ordinary workshop work and never required for documents.
3. Ask for implementation. The orchestrator invokes `workflow`.
4. Astra implementation, applicable Fable performance work, executable checks, Fable engineering
   review and conditional Fable database review run in order. Findings return to Astra, with at most
   three repair rounds per invocation.
5. A verified candidate is applied and checked again. Concurrent project edits block integration.
   Avoid editing the candidate's files from the orchestrator while this workflow runs.

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
- `prompts/{orchestrator,design-advisor,implementer,reviewer,database-reviewer,performance}.md`:
  each role's task and evidence requirements.
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
npm run test:live:workshop
npm run test:live:web
```

The live test uses real model calls and a disposable SQLite ledger. It exercises seeded
replay/conflict properties, invalid inputs, SIGKILL recovery, file-backed benchmarks and all five
roles. Reports are written to ignored `reports/`. Set `PI_HARNESS_LIVE_MODEL` to choose another
Codex model for a live run.

The workshop live case uses real Codex and Fable calls to check parallel guidance, automatic reply
delivery, shell access and direct document updates despite unresolved workshop questions. It spawns
no implementation workers.

The web live case verifies successful WebSearch and WebFetch calls in both the design advisor and an
engineering reviewer, including source citations and the scoped MCP result handoff.

The basic live case exercises a seeded parser contract and confirms that database and performance
roles stay inactive when the accepted design does not need them.

Project-local traces live in `.pi/traces/` under the directory where Pi starts:

- `sessions/`: orchestrator JSONL sessions, readable with Pi or a text editor. The `pih` launcher
  stores sessions here directly. Ordinary `pi` sessions are mirrored here at lifecycle boundaries.
- `harness/consultations/`: Fable workshop inputs, status and advice.
- `harness/timing/`: request/model selection, model-step start/end, first visible text, tool
  duration and settled events. These contain timing/usage metadata, without prompt or tool-argument
  bodies. Model intervals include client/provider overhead; they do not isolate server queueing or
  compute.
- `harness/attempts/`: worker assignments, Codex session JSONL directories, Claude event JSONL,
  scoped tool evidence and results.
- `harness/`: implementation checkpoints, receipts, task state, snapshots and integration journal.

The harness adds `/traces/` to `.pi/.gitignore`, preserving existing entries. This also works for a
project folder before Git initialization. Traces are excluded from worker file tools and snapshots.
Start Pi from the project root to keep its traces together. Older sessions and state under `~/.pi/`
remain historical files; new runs use local state and do not automatically import old checkpoints.
`pih --continue` resumes the most recent local session.

Failed candidates remain at the path recorded in task state. A cancelled or crashed worker cannot
report success. A subsequent run recovers a pending integration only if every file still matches its
recorded before or after value. Unexpected user edits stop recovery.

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
