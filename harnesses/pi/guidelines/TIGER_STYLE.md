# Tiger Style

Adapted from TigerBeetle's [TigerStyle][source] for use across repository languages. Upstream
revision for reference: `a2a3c7064519e08233abe26c54a43fca2f9ad9bc`. Distributed under the Apache
License 2.0; see `TIGER_STYLE_LICENSE`.

[source]: https://raw.githubusercontent.com/tigerbeetle/tigerbeetle/main/docs/TIGER_STYLE.md

Choose safety first, then performance, then developer experience.

- Make control flow and ownership explicit. Bound queues, allocations, concurrency and retries;
  decide what happens at capacity. Keep state close to its use.
- Handle external failures as ordinary outcomes. Assert internal invariants at both ends of a
  transition, with critical checks active in production. Test either side of every boundary and
  exercise recovery, not just success.
- Estimate latency and bandwidth across network, disk, memory and CPU before optimizing. Separate
  setup from repeated work; batch accesses, reuse storage and avoid unnecessary copies. Measure the
  result where callers experience it.
- Choose domain names with units. Distinguish indexes from counts, and document rounding. Explain
  why a limit or design choice matters. Prefer interfaces with few possible states.
- Use the project's formatter, strict compiler checks and naming conventions. In managed code,
  translate Zig's static allocation discipline into bounded growth and predictable resource use.
  Scrutinize new dependencies and fix known defects while the reasoning is fresh.

## Repository guidance

Customization pending. The host owns this section; replace this paragraph with verified repository
rules and executable checks before implementation, then mark the section customized.
