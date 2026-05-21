---
name: zig
description: "Performance-first Zig guidance for systems code. For substantial Zig coding, module-readiness, batch API, speed, benchmark, allocation, and hot-loop work, read the machine-level and benchmarking references first, use compiler/allocation references when the evidence gap needs them, edit the Zig files, then finish with correctness, timing, and one targeted low-level check."
---

# Zig Performance And Data-Oriented Design

## Goal

Write Zig code where performance follows from the shape of the data.

The default posture is performance-first: identify repeated work, make hot loops consume dense and predictable data, remove avoidable allocation, and keep behavior explicit. A speedup only counts when correctness validation and timing evidence prove the same problem is still being solved.

## Start Here For Zig Code Work

For substantial Zig coding, module-readiness, batch API, performance, benchmark, optimization, "too slow", allocation, or hot-loop prompts, begin by reading these references before source edits:

- `references/machine-level-hypotheses.md`
- `references/benchmarking.md`

Use the file-reading tool and resolve each path from the directory containing this `SKILL.md`. For example, after reading `/home/sandbox/.agents/skills/zig/SKILL.md`, read `/home/sandbox/.agents/skills/zig/references/compiler-evidence.md`.

They contain the core evidence workflow for this skill: source-shape hypotheses, optimized benchmark boundaries, and convergence rules. For narrow follow-ups, use the specific reference that matches the missing evidence:

- `references/compiler-evidence.md` for build truth, symbols, assembly, IR, source mapping, CPU tools, and the JSON codegen ladder.
- `references/allocation-evidence.md` for counting allocators, no-allocation tests, and allocator-symbol checks.

For create, complete, improve, optimize, or "too slow" prompts, move from the reference pass directly to the required `write` or `edit` call. Use the final response as the evidence report after files exist and gates have run.

## Operating Loop

1. Identify the repeated thing: records, rows, columns, tokens, cells, samples, instructions, items, tasks, buffers, or states.
2. Identify the hot loop and list exactly which fields it reads and writes.
3. Separate setup, preparation, steady-state execution, diagnostics, formatting, and final evaluation.
4. Define the correctness gate and measured boundary before optimizing.
5. Write the simple correct version with explicit inputs, outputs, ownership, and caller-owned buffers where repeated.
6. Sketch the plausible source shapes for the contract: direct table, prepared indexes, active list, fused pass, workspace, or narrow hot struct.
7. Form a machine-level hypothesis: what allocation, call, lookup, branch, copy, conversion, or scattered load should disappear?
8. Build the optimized artifact and record the exact command.
9. Inspect allocation or compiler output when the claim depends on allocation removal, call removal, inlining, vectorization, branch removal, layout, or skipped work.
10. Benchmark the same boundary with the same workload, worker count, warmup, build mode, and correctness checks.
11. Change one thing at a time, then re-check correctness before reporting speed.

## Completion Gate

Before final response on substantial Zig code work, complete the implementation and record the evidence:

- replace stubs, placeholders, and `NotImplemented` paths with executable code;
- for stub-completion work, make the `write` or `edit` tool call that touches the required file before final response;
- run the correctness gate that covers the public entrypoint;
- run the optimized demo or benchmark when the prompt includes `--bench`, timing, throughput, allocation, or hot-loop work;
- compile or run `main`/demo paths separately when they contain required behavior; `zig test` can miss lazy-analyzed executable code;
- run one targeted machine-level check tied to the hypothesis: optimized compiler command listing, emitted assembly, `nm`, `objdump`, allocation counters, or a no-allocation test;
- report the exact commands, measured boundary, and any remaining unmeasured risk.

Continue the edit-test loop until required gates pass or a concrete blocker is identified.

For performance and allocation prompts, make the machine-level check drive the final source shape. If focused evidence still shows allocator, formatting, hash-map, copy, diagnostic, or unexpected call paths inside the measured boundary, revise the source or explain why that path is outside the exercised workload before final response. Process evidence is useful only when the submitted code improves or preserves same-boundary runtime and correctness.

When no narrower check is obvious, use a small default probe: build optimized with `--verbose`, then filter emitted assembly, symbols, or verbose output to the hot function and check for calls such as `alloc`, `HashMap`, `memcpy`, `@panic`, `call`, or `bl`. Function-scoped output beats whole-binary greps that mix benchmark setup with the measured boundary.

For a reusable version of that probe, run `scripts/codegen-ladder.sh` from this skill directory with `--source`, `--symbol`, and optional repeated `--run-arg` values. Treat it as a CLI: inspect `.decision_card` first with `jq`, then follow the artifact paths and high or medium `next_checks` suggestions that apply to the measured boundary. Its Python package is tool-maintenance detail; normal skill use should stay at the JSON CLI layer. The CLI emits JSON plus scratch files for symbols, focused assembly, optional IR, source mapping, allocation reports, profiler output, parsed benchmark fields, report diffs, auditable `next_checks` suggestions, and a decision card that classifies whether to edit source, rerun matched benchmarks, move to source-level comparison, or report a practical ceiling.

When the focused compiler output is already clean, shift from grep-style inspection to a stronger source-level comparison: same-workload before/after timing, direct decision table versus candidate scan, dynamic versus prepared controls, fused versus repeated passes, and whether a simpler implementation has already reached the practical ceiling for the contract. Compiler output validates or refutes one source shape; same-boundary timing chooses between source shapes.

## Convergence

A strong performance edit is a verified improvement, not an exhaustive search.

- If tests pass, the measured public boundary improves, and one targeted low-level check supports the hypothesis, keep that source shape and report remaining alternatives as next checks.
- When the benchmark names a public entrypoint, keep the final public entrypoint on the improved path. Add prepared APIs or reused-boundary benchmarks when repeated use is central, while still reporting the public-boundary result.
- When the prompt says the same controls, rules, weights, plan, or model apply to many batches, benchmark that shape directly: prepare once, run many batches, report batch count and batch size, and keep the one-shot boundary as a separate compatibility number.
- Explore another source shape when the current shape fails correctness, regresses same-boundary timing, introduces a private cap or fallback cliff, or contradicts the machine-level hypothesis.
- Prefer one focused rival comparison over a broad search. Useful rivals are direct table versus candidate scan, prepared plan versus one-shot setup, fused pass versus repeated pass, or workspace reuse versus fresh allocation.
- For small projects and eval-sized tasks, a good loop is: baseline test/bench, one source edit, fmt/test/bench, one quick machine-level check, final report.
- If symbol extraction is unclear after a verified speedup, use the optimized compiler command listing as the machine-level check and report focused disassembly as a follow-up.

## Machine-Level Hypothesis

Source quality should make a simpler machine problem. Before changing a hot path, predict the compiled symptom:

- dynamic lookup becomes direct indexing, active-list walking, or dense prepared storage;
- repeated mode checks move outside the loop, split into specialized loops, or are already hoisted by the compiler;
- caller-owned output or workspace storage removes allocator calls, cleanup edges, and capacity growth from the hot symbol;
- a layout change reduces copied bytes, scattered loads, pointer chasing, or cold-field traffic;
- diagnostics, formatting, tracing, and final-evaluation work stay outside the hot boundary.

Treat source shape as a hypothesis and check the machine shape. Optimizers can inline helpers, unroll dense loops, remove dead diagnostics, fold symbols away, or hoist invariant branches. They can also leave allocator, hash-map, division, bounds, memcpy, or formatting paths alive when the source looked harmless.

If the task is tiny and a benchmark is unavailable, still run optimized correctness and state that runtime is unmeasured. Fast wrong code is a different program.

## Reference Router

Use this map to choose the reference that matches the evidence gap:

- Source-shape intuition and expected compiler symptoms: `references/machine-level-hypotheses.md`.
- Build truth, compiler IR, symbols, assembly, address-to-source mapping, CPU hotspot tools, and code-size attribution: `references/compiler-evidence.md`.
- Same-boundary benchmark design, optimized build modes, warmup, checksums, and final timing reports: `references/benchmarking.md`.
- Counting allocators, no-allocation tests, and allocator-symbol checks: `references/allocation-evidence.md`.

## Data And Layout Rules

- Design hot data from the consumer loop rather than input files or API payloads.
- Keep hot fields dense and contiguous; keep cold fields, diagnostics, provenance, labels, and formatting state out of hot structs.
- Iterate large hot records by pointer when the loop reads only a few fields or the struct carries cold labels/provenance. Copy small controls freely; make large per-item copies earn their place with timing or clearer ownership.
- Prefer struct-of-arrays when loops consume one or a few fields across many items.
- Prefer array-of-structs when loops consume most fields of each item together.
- Split common and rare payloads instead of forcing every item into a maximal tagged union.
- Store sparse or optional data out of band when most items leave it inactive.
- Use indexes, typed handles, distinct index types, or small wrappers when raw integers or pointers would erase meaning.
- Keep row/column order and state dimensions tied to typed enums or explicit types instead of comments around raw offsets.

## Memoization And Reuse

- Treat memoization, lazy computation, and caching as cost models to prove at the consumer loop.
- Memoize when recompute cost multiplied by reuse count beats stored-value load cost plus storage/cache pressure.
- Compute lazily when stored-value load cost plus storage/cache pressure beats recompute cost multiplied by reuse count.
- Count both input bytes and output bytes. Removing a stored value wins only when recomputing it avoids scattered reads, pointer chasing, branches, divisions, calls, and vectorization barriers.
- Check locality. A larger stored value can be faster when it streams with adjacent hot data.
- Keep workspace keys and invalidation visible enough to audit.

## Allocation And Workspace Rules

- Keep allocation outside repeated numeric, parser, search, scheduling, rendering, matrix, and vector loops.
- Make allocation visible in signatures with an explicit allocator.
- Keep non-allocating hot helpers free of fake allocator parameters.
- Give owning workspaces `init`/`deinit` and reuse buffers across calls.
- Grow buffers by capacity, then return sliced views for the current problem size.
- Replace buffers only after replacement allocation succeeds; keep old storage live until the fallible allocation has succeeded.
- Attach `defer`/`errdefer` immediately after acquisition.
- Prefer direct writes into caller-owned outputs over temporary return-then-copy shapes in repeated work.
- Use arenas only when many allocations truly share one lifetime.

## Branch And Work-Skipping Rules

- Test cheap no-contribution cases before expensive setup.
- Hoist invariant arithmetic, means, lookup results, divisions, and combined scale factors before inner loops.
- Carry active masks, lists, bitsets, or typed indexes forward so later stages consume known activity directly.
- For analyzers that update stats and write alerts or classifications, prepare compact per-kind/per-mode controls once, then fuse stats, output writes, and checks into one sample/record pass.
- For ordered rule or policy evaluators, first consider a prepared table keyed by the consumed fields that points to the first matching rule or control. Candidate bitsets and active lists are good fits when candidate counts stay small across the full public domain; measure the bound and the bound-plus-one case when the fast path has a cap.
- For stable weights, thresholds, rules, or plans reused across batches, keep preparation outside the repeated boundary and benchmark the prepared path over many realistic batches, not only one full slice repeated in a loop.
- For dense raster, grid, and stencil loops, consider a separate interior loop plus small edge handling when per-cell boundary checks dominate; keep the direct single-loop version when the benchmark shows the split does not pay.
- Keep hot-loop integer widths as narrow as the proven value range allows, with tests for overflow or boundary limits. Wider temporaries earn their place through real overflow risk, focused timing, or clearer contracts.
- Prefer simple slice indexing in ReleaseFast until compiler evidence shows bounds or aliasing overhead that raw pointers would remove. Raw pointer conversion should earn its place with focused assembly or timing evidence.
- Specialize loops by mode/state when a branch is repeated and predictable.
- Request and compute only active output/state columns for the current operation.
- Compute diagnostics, final evaluations, display values, and retained artifacts on request, outside steady-state hot loops.
- Stop converged tails only when the threshold is a real validation contract.
- Use comptime specialization for build-time or type-shape choices; use runtime dispatch only when multiple implementations must coexist at runtime.

## Architecture And Boundary Rules

- Keep public flow simple: input -> prepare -> compute -> output.
- When repeated use is central, expose a small prepared-state type as the preferred boundary and keep compact encodings, bit-packed tables, and generated lookup storage internal or behind named accessors.
- Keep compute modules free of file I/O, CLI wiring, text parsing, display formatting, report construction, and hidden global state.
- Put loaders, parsers, config, FFI translation, reports, serialization, diagnostics, and validation artifacts at boundaries.
- Consume every parsed control, reject it with a typed error, or document it as inert with focused coverage.
- Handle every enabled feature, mode, state, unsupported combination, and requested output field explicitly.
- For rule, threshold, mode, or control tables, define and test missing-entry semantics before optimizing; for analyzers, treat samples without an explicit matching control as rejected unless the prompt gives a default.
- For runtime rule/control evaluators, benchmark the same public API with both literal and runtime-built controls when the source shape depends on compiler specialization; add a prepared plan or workspace only when it improves that measured contract.
- Keep prepared fast paths aligned with the public input domain. If a bounded optimized path falls back above a private limit, benchmark both sides of the limit and prefer a uniform fast shape when the prompt does not define that bound.
- Preserve threshold words from the prompt, tests, and starter benchmark: `above` maps to a strict comparison, while `at least`, `inclusive`, or `minimum` maps to an inclusive comparison. Add an equal-to-threshold test when that boundary affects the active set or timing.
- For decoders, summaries, and ranking pipelines, cover invalid length, invalid enum/control value, empty input, capacity limits, and tie-break semantics when those states can occur. For fields named `latest`, `max`, or `last`, add an out-of-order input test so arrival order and value order stay distinct.
- For caller-owned APIs, return an explicit result shape with counts, stats, or sliced views that matches the requested public contract; raw output slices are best when the prompt asks only for a slice.
- Treat caller-owned output and stats slices as storage, not preinitialized state, unless the prompt asks for accumulation. Public batch APIs should validate slice lengths with typed errors, initialize the stats they return, and use a separate `accumulate`/`append` API when preserving prior contents is intended.
- For variable-length caller-owned outputs such as alerts or matches, define short-buffer behavior before the hot loop. Either preflight the worst-case capacity, pre-count required output, or document partial writes with focused tests.
- Keep useful explicit error sets, API comments, and edge-case tests when they clarify behavior without entering the hot loop.
- Use inspection-only wrappers, exported scratch functions, or retained benchmark symbols for disassembly; keep final public hot APIs shaped for production behavior rather than for symbol visibility.
- Prefer direct hot-path changes over broad compatibility shims, framework scaffolding, or string-keyed mutation APIs.
- Keep performance logic in modules; root files compose artifacts and modules.

## Zig Safety Rules

- Every owning type has a clear `deinit`; every allocating constructor has a tested cleanup path.
- Roll back partial initialization immediately and locally.
- Dynamic boundaries get typed wrappers: env vars, config, JSON, FFI, protocol payloads, and string-keyed controls.
- For simple single-file demo or benchmark output on Zig 0.15, use `std.debug.print` or the current `std.fs.File.stdout()` writer APIs; validate the `main`/`--bench` path with the same optimized command the harness will run.
- When formatting or diagnostics are required for active records, prefer bounded stack or caller-owned buffers over heap formatting in the repeated boundary, then verify the active formatting case and any allocator-failure behavior that is part of the public contract.
- Protocol states use enums, tagged unions, packed structs, or explicit structs instead of loose strings and raw integers.
- Use `packed struct` only when bit/ABI layout matters; use normal structs for ordinary in-memory state.
- Keep ABI-relevant enums, packed layouts, and C-facing values explicit and tested.
- Comments explain performance pressure, invariants, validation contracts, and tradeoffs.

## Measurement And Instrumentation

- State exactly what timing includes: setup, preparation, cache warmup, steady-state execution, final evaluation, diagnostics, formatting, and artifact writing.
- Benchmark narrow hot paths and end-to-end paths separately.
- Keep retained validation/benchmark evidence separate from exploratory traces and captures.
- Compile heavy tracing/profiling dependencies only into explicit trace or benchmark artifacts.
- Keep one tiny instrumentation facade in hot code; capture, export, summaries, hardware counters, and report assembly belong outside kernels.
- Keep timeline profiling separate from low-overhead elapsed timing. Report profiler-instrumented wall time as product runtime only when instrumentation overhead is the thing being measured.
- Delete scaffolding once it stops paying rent.

## Preferred Shapes

- Allocation lives in setup, workspaces, or explicit boundary code.
- Steady-state loops use typed indexes, dense storage, prepared state, and direct dispatch.
- Active states, output columns, diagnostics, final evaluations, and retained artifacts are requested explicitly.
- Hot compute structs contain hot fields; cold input, diagnostic, provenance, and formatting fields stay at the boundary.
- Workspace caches have typed keys, visible invalidation, and clear request or batch ownership.
- Memoized values earn their space through reuse count, locality, and measured boundary behavior.
- Stored derived values are removed only when the replacement avoids scattered reads, branches, divisions, and calls.
- Memory-footprint wins come with same-boundary timing or an explicit acceptable-runtime tradeoff.
- Build-time choices use comptime specialization.
- State masks keep enum-backed accessors.
- Thresholds and truncation rules remain correctness contracts.
- Performance claims include correctness evidence, same-boundary timing, and the relevant allocation/compiler check.
- Performance compiler evidence comes from optimized artifacts.
- Assembly is read with a specific question.
- Normal library builds stay free of trace/profiling dependencies.

## Review Check

- Is the repeated thing, hot loop, measured boundary, and correctness gate named?
- Are setup, preparation, steady-state execution, diagnostics, formatting, and final evaluation separated?
- Are hot fields dense, cold fields out of the loop, and active states typed?
- Are allocations outside hot loops, with workspace reuse explicit?
- Does the machine-level hypothesis say what gets simpler in the optimized artifact?
- Was compiler or allocation evidence checked when the claim depends on it?
- Do timings compare the same boundary before and after?
- Does the optimization preserve observable behavior rather than changing the problem?
