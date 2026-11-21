# Pi code mode

The orchestrator and Pi-backed coordinators, implementers and task workers can call `codemode`. Each
script sees the permitted inspection tools registered for its own role. Independent reads can run
together. A script can also search once and use the returned paths and line numbers for bounded
follow-up reads in the same model step. Keep a single lookup direct when there is nothing to
combine. Workers can save a large inspected value with `store(key, value)` and use `load(key)` in
later scripts in the session. Return the needed excerpts. When the SDK truncates a result, workers
can reread the relevant project range. The tool reports the count and first six nested failures even
when a script catches an error or prints only part of a result.

- `read`, `grep`, `find`, `ls`. Host SDK inspections. Native read returns its SDK shape. The three
  listing/search tools return text.

- `project_search`, `project_read`. Host and Pi worker inspections. Literal search exposes hits with
  path, line and text, and hasMore. Listings expose matches and an optional nextAfterPath. Reads
  include content, folder rules, the full-file hash and any continuation coordinates. For explicit
  worker reads of .pi/project-state.md, the source is the shared brief in the primary checkout,
  captured on first read for consistent paging. It is outside the candidate snapshot. For literal
  searches, use pathPrefix to restrict the files scanned. Return hits and hasMore when you need
  locations. Each entry in matches repeats the same path, line and text. An explicitly excluded
  prefix returns an error, or scopeNote when the same prefix matches visible sibling names. Report
  the excluded contents as unknown. If they affect a decision, hand that check to the host.

- `original_read`, `read_reference`. Worker inspections where the role supplies them. Original reads
  use the same paging as project_read. For the exact JS/TS formatting rule, read_reference({name:
  "readability-spacing"}) returns the same source used by project_format and harness lint.

- `task_status`, `harness_status`, `harness_capabilities`. Host inspections. Task status returns one
  object for an ID or an array without an ID. Read status, hostActions and checks from the task.
  Both task_status and review_receipts expose the same task lifecycle as status and state. Receipt
  verdicts and individual check statuses apply to their recorded snapshots. Harness status includes
  runtime, workflow and delegations.

- `project_memory_history`. Host inspection of sourced revisions for a specific fact.

- `inspect_ci_run`. Batch run IDs for the baseline and candidate. Compare wallMs, lastFinishingJob,
  longestJobs and sameHeadRuns. Check jobsObserved against jobsTotal before generalizing.

- `compare_candidates`. Inspect a local batch and its candidate evidence.

- `inspect_pr`, `review_receipts`. Host inspections. Read baseRefName, baseRefOid and headRefOid in
  the same query as mergeability, reviews and checks. Read required findings and check snapshots
  from receipts. Missing receipts are null. Final runner checks supersede provisional coordinator
  checks for the same attempt. Required findings and non-passing check receipts survive a narrow
  script projection.

- `host_work`. Direct host tool for the state of an authorized, host-owned operation.
- `watch_github_run`. Direct host tool. Registers or cancels a local CI follow-up.

- `codemode`. Top-level script runner. Model helpers are disabled.

- `bash`, `run_command`, `write`, `edit`, `project_write`, `project_edit`, `project_delete`,
  `project_format`. Direct calls under the role's normal authority.

- `document_check`, `design_consultation`, `recurring_task`. Direct. These tools can also format,
  consume/cancel consultation results or change schedules.

- `delegate_local`, `integrate_candidate`. Direct local dispatch and integration.

- `workflow`, `consult_design`, `delegate_task`, `delegate_branches`, `delegate_worker`. Direct.
  These calls launch work.

- `update_project_memory`, `task_control`, `revise_tasks`, `resume_task`, `merge_branches`. Direct
  changes to project state, running work or Git.

- `run_checks`, `verify_loop`, `submit_result`, `report_progress`, `report_milestone`. Direct
  coordinator or worker actions that execute checks or record evidence.

- `WebFetch`, `WebSearch`. Claude-native tools where enabled. Claude CLI roles use their existing
  tools and can issue independent reads together.

Implementers and performance workers call `verify_loop` directly for repeated commands. For example,
mode `seeded`, argv `["node", "tests/recovery.js", "{seed}"]`, firstSeed 100 and count 40 run cases
100–139 until the first failure. Use the returned replay arguments on the recorded snapshot.
Differential mode compares matching text from original and candidate; benchmark mode pairs their
samples in alternating order and reports medians in the supplied metric and unit. Benchmark commands
must print a single finite number. Both sides use the candidate’s installed dependencies and their
own source snapshots. Raw samples live in the private receipt alongside the worker result. Each
sample runs in a fresh sandbox copy. A call accepts up to 128 cases and five minutes; continue a
longer campaign in ranges. Project acceptance checks still run on the final snapshot.

For one large read that only needs a count or a few matches, filter it in code mode. Use a direct
call for one small read. Save expensive results before printing when a later slice is likely. Scope
saved keys to the observed head or snapshot and refresh mutable status when acting on it.

For PR triage, inspect each head once. Check runs expose detailsUrl and commit statuses expose
targetUrl. Either may be null. Use the failing check's link and collect its log once for all needed
filters.

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

Measure uptake on turns with eligible reads. Use parent tool IDs to distinguish a batch from its
nested calls. Compare similar requests' model steps and wall time. A higher call count by itself
does not establish a speedup.
