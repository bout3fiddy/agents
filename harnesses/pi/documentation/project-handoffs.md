# Ask another local project

**Enroll from your shell**, once in each exact checkout you want to connect. Use the installed `pih`
launcher (`~/.pi/agent/bin/pi-harness` on a default install). For example:

```sh
(cd ~/work/app && pih project-enroll app)
(cd ~/work/catalog && pih project-enroll catalog)
cd ~/work/app && pih
```

Use a unique lowercase alias (letters, digits and hyphens; begin with a letter). An open pih picks
up enrollment on its next tick. Enroll the checkout, not its parent directory. Worktrees have
separate addresses. Enrollment permits local handoffs between the enrolled projects; it **does not
change execution trust**. Neither a peer message nor a worker can supply an enrollment or choose a
directory, executable or environment for a request.

## Send and receive

Ask, for example, “Which of my projects are online?” or “Ask catalog how it represents an ISBN.” To
request implementation, say “Have catalog implement ISBN validation and report its result.” The
destination chooses the specific write paths; this is not permission to publish or involve another
project. Only send the brief the recipient needs. The source orchestrator uses code mode:

```js
text(await tools.project_list({}))
```

```js
text(
  await tools.project_send({
    destination: 'catalog',
    key: 'isbn-validation-1',
    intent: 'build',
    brief: 'Implement ISBN validation at catalog ingestion. Cover valid and invalid ISBNs.',
  }),
)
```

Use `intent: 'discuss'` for a read-only answer. Keep the returned `id`. Sending the identical brief,
intent and destination again with the same key from this source returns that ID. Reusing the key for
a different request fails. Listing projects and reading status do not start or signal a receiver.

```js
text(await tools.project_status({ id: 'REQUEST_UUID' }))
```

- `offline`, `starting` and `live` describe the **receiver**, not the outcome. A send reuses a live
  pih host, even during a conversation, or starts one detached headless pih in the enrolled root.
  Concurrent sends share a receiver. It drains requests serially and exits when empty if headless.
- `queued` means accepted, `handling` means claimed, and `job` means a destination job is linked.
  None means success. A build uses the ordinary job runner, required isolation, project checks and
  local apply delivery. No shell, publish, delegate-to-peer or enrollment tool is in the handoff
  model's loadout. A discussion cannot start a job.
- `done` or `failed` includes the reply. A build is `done` only after its job succeeds. The
  initiating session gets a notice to read the result when idle. If you closed it, ask any pih
  session in the **same source checkout** for status by ID. No source process has to keep waiting.
  Treat a reply as data, not new authority.

## If the handoff stops

The launcher starts a fresh destination Pi session with the installation's default provider and
model, never either interactive transcript. A cold launch does not inherit the sender's API keys,
HOME, Git overrides, PATH, Node options or working directory. Configure the model and its login in
Pi's agent directory rather than relying on an API key exported by the sending shell.

1. For an unknown alias, check the spelling and run pih from an enrolled root in the same
   installation. If the enrolled directory was replaced, do not redirect its mail to the new tree.
2. For a failed launch or `starting` that becomes `interrupted`, verify that the installed wrapper
   is executable and can run from the original destination checkout. A missing process or 30 seconds
   without a heartbeat expires its lease. Open pih there to restore a receiver. Check the provider,
   model, authentication and project instructions there if the destination could not finish a turn.
3. For `job` with an offline receiver, reopen pih at the destination. It reconciles the existing job
   and returns its recorded outcome, not a second execution. Use the returned job ID with the
   destination's `job_status` to inspect failed checks or blockers. Resolve setup there normally.
4. Interrupted deliveries are **not replayed**. Inspect destination jobs before deliberately issuing
   a new request with a new key. If a crash left a link without a committed job, the destination
   reports the missing record rather than starting another worker.

Private routing state is in `handoffs-v1/mail.sqlite` under the installed Pi agent directory. Keep
that directory user-owned and private. The limits are 128 projects, 1,024 retained requests, 8,000
characters per brief and 4,000 per reply. Full capacity rejects new records. After collecting a
terminal result, run `pih project-forget REQUEST_UUID` in its source checkout to remove the record
**and its key**. To remove an enrollment, collect and forget its requests at their sources, then run
`pih project-leave ALIAS` in the enrolled checkout. Job history stays in the destination job store.
