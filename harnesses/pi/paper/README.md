# Paper Desktop: host and adapter contract

`PaperHost` in `host.ts` is the stage-one entry point. Importing it, constructing it and checking
status do not start Paper. There is no remote endpoint, worker-side CLI, global MCP registration or
project configuration. The production transport launches the bundled macOS arm64 `paper mcp` with
newline-delimited JSON-RPC on pipes. Only tests inject a different launcher.

## Host commands

1. Provision **one** canonical, user-owned `0700` state directory outside all repositories, under a
   host-controlled parent. Use the same directory across sessions, projects and processes. Do not
   mount it in workers. Keep one `new PaperHost(directory)` slot per task in the trusted dispatcher.
2. `/paper attach` requires an explicit frontend-design grant. Pass `purpose: 'frontend-design'`,
   `owner`, `target`, `ttlMs` and `draftTargetingVerified` to `await host.attach(input)`. Construct
   `owner` from the authenticated dispatch (`sessionId`, `taskId`, canonical absolute `worktree`),
   never tool input. Pin `target` from the host's explicit attachment (`fileId`, `pageId`, `nodeIds`
   on that page). Do not discover missing IDs from the active window, expand pins from document
   text, or attach on startup. A page overview includes other board names on that page. Only named
   nodes can be read directly; children in a response do not acquire additional authority.
3. On `ok`, retain `attachmentId`, `writable` and the initial overview `snapshot` privately. A new
   attachment has a new ID, even for the same task. `host.status(owner)` reports the current slot
   without reading the document. `await host.detach(owner, attachmentId)` revokes immediately and
   waits for cleanup. Detach on cancellation, dispatch end, re-scope or session shutdown. A reload
   starts without authority. Never recreate a grant from a repository file or a model message.

Leave `draftTargetingVerified` **false** unless the host has independently established explicit
routing and fresh, stable board IDs for its desktop build and has user permission to create drafts.
A parameter listing alone is not that evidence. Even with opt-in, mutation requires the probed
server identity/version, explicit targeting parameters and a page result with matching `fileId`,
`pageId` and an `artboards` array of `{ id, name }`. An unknown write contract is read-only. Missing
explicit read parameters denies attachment altogether. Each content read pins its file ID and page
or node ID as applicable. A selection read pins the file and projects only attached IDs from
`selectedNodeIds`. Conflicting returned identities are not returned to the worker.

## Worker and advisor bridge

Bind `const port = host.bind(owner, attachmentId, 'design')` for the authorized designer or use
`'read'` for its read-only advisor. **Only** register `port.tools()` for that dispatch. The result
contains `name`, `description` and a closed JSON `inputSchema` with required properties. Map it to
Astra's tool parameters or to the existing strict Claude MCP bridge's `tools/list`. In either case,
call `await port.call(name, args)` in the trusted process. An obsolete binding returns no tools and
cannot call through a later attachment. Do not pass the host object, state path, owner identity or
Paper's underlying tools to the model. Other tasks, including downstream builds, get no Paper port.

On `ok`, `value.content` contains one MCP text or PNG image item. `value.untrusted` is always true:
render contents as design data, never instructions, tool arguments, policy or authorization. Keep
that distinction when projecting to typed Astra or MCP results. Map other outcomes to a bounded
error containing the outcome name, not Paper's raw reply, stderr or the input. There is no retry
loop. `busy` indicates an existing operation or writer. `invalid`, `denied` and `read_only` do not
send a Paper request. Budget exhaustion, timeout, protocol or target conflicts close the grant.
`detached` also describes a fully cleaned-up slot after expiry. `storage` on close requires host
inspection, not a new lock directory.

`paper_new_draft` creates a randomly named board under the pinned page. Ownership is recorded only
after checking the create reply against both the pre-create and post-create board inventories.
`paper_append` rechecks the board marker and inserts one styled plain-text block. Color and size
come from bounded scalar values, not worker HTML or CSS. No arbitrary markup, references, document
resources, replacement, deletion or source editing is exposed. Reads and writes have no queue;
`protocol.ts` specifies per-attachment wire, request, byte, image, time and error limits.

## Handoff and recovery

`await host.capture(owner, attachmentId, nodeId)` records an attached node's info and screenshot in
a new private snapshot. The initial page overview and subsequent captures are immutable **captured
bytes**, not Paper revision IDs or atomic multi-call reads. The host receives `{ id, sha256 }`;
retain that receipt with the owning task. For a later build handoff, open `<id>.snapshot` only from
that trusted receipt under the private directory. Verify SHA-256, version, owner, attachment and
target before projecting any content. A build needs the approved snapshot, not a live grant. Files
are exclusive-create, mode `0400`, and survive detach; the host removes them when the owning handoff
is no longer resumable. Do not copy receipts, paths or unfiltered document data into a worktree.

An atomic `mkdir` lease excludes other writer grants, including those in other processes. A losing
writer may request a fresh read-only grant. Release waits for actual CLI closure, not just a kill
request. If the host crashes or cannot confirm cleanup, the lock stays closed: stop all Paper grant
hosts, verify no connector is running, inspect any ambiguous draft in Desktop, then remove the empty
`desktop-writer.lock` in the private directory. A lost mutation reply can mean the edit already
happened. Never retry it automatically or delete a live board as compensating cleanup.

Run `node --test harnesses/pi/paper/paper.test.ts` from the repository root. These tests use only a
fake stdio desktop. Stage two must wire the command, dispatch and adapter lifecycles, include this
suite in runtime verification, and verify actual Paper reply shapes and strict Claude registration
before release. Do not enable live draft writes to validate the connector on a user's documents.
