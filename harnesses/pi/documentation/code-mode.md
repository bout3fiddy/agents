# Pi code mode

`codemode` runs one JavaScript script that calls tools, chains their results and returns only what
the decision needs. A step that would take several model round trips takes one.

## What a script may call

The orchestrator can call every tool of its role from a script except `bash`, `write` and `edit`.
Those three stay direct calls so each use of the shell and each host file write is individually
visible.

| Tools                                                      | Notes                              |
| ---------------------------------------------------------- | ---------------------------------- |
| `job_start`, `job_status`, `job_message`, `job_retry`,     | Results are objects. Give every    |
| `job_cancel`, `job_close`                                  | scripted `job_start` a `key`       |
| `read`, `grep`, `find`, `ls`, `project_read`,              | `project_search` returns hits with |
| `project_search`                                           | path and line for follow-up reads  |
| `inspect_pr`, `inspect_ci_run`, `watch_github_run`         | Batch PRs or runs in one script    |
| `consult_design`, `design_consultation`, `document_check`, | Same authority as a direct call    |
| `whiteboard`                                               |                                    |

Pi workers script only their read-only inspections: `project_read`, `project_search`,
`original_read` and `read_reference`. Claude workers have no code mode.

## Why a script cannot overreach

- A looping script cannot create a job twice: the store keeps one job per `key`. The number of jobs
  is the orchestrator's decision; the store sets no limit.
- Only the owning host session can cancel or retry a job. A pending stop cannot be retried.
- A nested call to a tool outside the allowed set is blocked at execution, whatever the script
  names.
- Host file writes are subject to the same routing hook inside a script as outside it.

## Patterns

Fan out research and return immediately:

```js
const questions = ['How is auth wired?', 'Where are retries configured?']
const started = await Promise.allSettled(
  questions.map((task, index) =>
    tools.job_start({ title: `Research ${index + 1}`, task, mode: 'research', key: `r${index}` }),
  ),
)
text(started.map((item) => (item.status === 'fulfilled' ? item.value.id : String(item.reason))))
```

Search, then read only the hits:

```js
const found = await tools.project_search({ query: 'retryPolicy', pathPrefix: 'src/' })
const reads = await Promise.all(
  found.hits.slice(0, 5).map((hit) => tools.project_read({ path: hit.path, startLine: hit.line })),
)
text(reads.map((file) => file.content.slice(0, 600)))
```

Triage PRs, inspecting each head once:

```js
const reads = await Promise.allSettled(
  numbers.map((number) => tools.inspect_pr({ repository, number })),
)

for (const [index, read] of reads.entries()) {
  if (read.status === 'rejected') {
    text({ number: numbers[index], error: String(read.reason) })
    continue
  }

  const { number, headRefOid, mergeable, reviewDecision, statusCheckRollup } = read.value
  text({ number, headRefOid, mergeable, reviewDecision, checks: statusCheckRollup })
}
```

Use `store(key, value)` and `load(key)` to keep a large result across scripts. Do not poll a job
from a script: its outcome is delivered to the conversation.

In the host terminal a script shows its status, inspected paths and failed calls. Click the row or
use Pi's tool expansion key for the individual calls and the raw script.
