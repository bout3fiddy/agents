# Tiger Style

Adapted from TigerBeetle's [TigerStyle][source]. Reference revision:
`a2a3c7064519e08233abe26c54a43fca2f9ad9bc`. See `TIGER_STYLE_LICENSE` (Apache 2.0).

[source]: https://raw.githubusercontent.com/tigerbeetle/tigerbeetle/main/docs/TIGER_STYLE.md

Choose safety first, then performance, then developer experience. Bound resource growth, make
ownership explicit, and measure improvements at the caller's boundary. Prefer fewer dependencies,
precise domain names and production checks for critical invariants.

## Repository guidance

Customized.

- In `harnesses/pi/src`, keep host publication authority separate from scoped worker edits. Use
  `invariant.ts` for impossible internal states, ordinary errors for invalid external input. Do not
  silently fall back from sandbox execution. Preserve failures and required skips in receipts.
- Model orchestration as explicit steps. Bound queues, subprocess output, command deadlines and
  concurrent jobs rather than imposing model-turn limits. Propagate cancellation to subprocesses.
  `harnesses/pi/package.json` limits the automated test runner to four concurrent files.
- Preserve shell pipeline status (`bin/verify.sh` uses `set -euo pipefail`). Keep Python metadata
  checks deterministic: `python3 bin/build_agents_index.py --no-warnings` checks the skills index.
- Run `node bin/lint-repo.mjs` and `npm --prefix harnesses/pi run verify` for static and behavioral
  checks. Run `bash bin/verify.sh` for integration, including the two Bun suites. Use the scoped Pi
  live commands in `harnesses/pi/AGENTS.md` when changing runtime behavior.
