---
name: zig
description: "Performance-first Zig guidance for systems code: data-oriented design, hot loops, allocation removal, workspace reuse, comptime specialization, correctness validation, and benchmark evidence."
---

# Zig Performance And Data-Oriented Design

## Goal

Write Zig code where performance follows from the shape of the data.

The default posture is performance-first: identify repeated work, make hot loops consume dense and predictable data, remove avoidable allocation, and keep behavior explicit. A speedup only counts when correctness validation and timing evidence prove the same problem is still being solved.

## First Pass

1. Identify the repeated thing: records, rows, columns, tokens, cells, samples, instructions, items, tasks, buffers, or states.
2. Identify the hot loop and list exactly which fields it reads and writes.
3. Separate setup, preparation, steady-state execution, diagnostics, formatting, and final evaluation.
4. Inspect or measure per-item size, allocation count, cache reuse, branch shape, and repeated conversions.
5. Choose the smallest behavior-preserving layout change that removes repeated work or memory traffic.
6. Validate correctness first, then compare timings on the same boundary.

## Core Priorities And Rationale

- Start with data layout because hot code usually waits on memory before it waits on arithmetic. If the loop reads fewer bytes, reads them contiguously, and avoids cold fields, every operation in that loop gets cheaper.
- Remove allocation from hot paths because allocators add bookkeeping, failure edges, cache churn, and sometimes synchronization. Reusing caller-owned buffers makes runtime and ownership predictable.
- Reuse prepared workspaces because setup costs are often independent of the changing input. A workspace makes that reuse explicit, but its key and invalidation must be visible enough to audit.
- Carry typed active sets because repeating the same "is this enabled?" decision inside every loop burns branches and obscures which work is actually required. Masks, lists, and typed indexes let later stages skip work without losing meaning.
- Keep kernels narrow because mixed compute/report/validation functions are hard to profile and hard to optimize without changing behavior. Small compute kernels make the hot path measurable.
- Define timing boundaries because speedups are meaningless if setup, cache warmup, diagnostics, or output work moved outside the measured block. Compare only like with like.
- Keep correctness gates coupled to speed work because many "optimizations" are actually problem changes. The validation should prove the same observable behavior before the timing is trusted.

## Architecture Rules

- Keep public flow simple: input -> prepare -> compute -> output.
- Keep compute modules free of file I/O, CLI wiring, text parsing, display formatting, and hidden global state.
- Put loaders, parsers, config, and FFI translation at input boundaries.
- Put reports, serialization, diagnostics, and validation artifact construction at output or validation boundaries.
- Consume every parsed control, reject it with a typed error, or document it as inert with focused coverage.
- Do not silently drop enabled features, modes, states, unsupported combinations, or requested output fields.
- Do not add broad compatibility shims, framework scaffolding, or string-keyed mutation APIs to make an optimization easier.
- Root files compose artifacts and modules; they should not become the place where performance logic hides.

## Data-Oriented Rules

- Design hot data from the loop's access pattern, not from the shape of input files or UI/API payloads.
- Keep hot fields dense and contiguous; keep cold fields, diagnostics, provenance, labels, and formatting state out of hot structs.
- Prefer struct-of-arrays when loops consume one or a few fields across many items.
- Prefer array-of-structs when loops consume most fields of each item together.
- Split common and rare payloads instead of forcing every item into a maximal tagged union.
- Store sparse or optional data out of band when most items do not use it.
- Decide whether to store or recompute derived values from the consumer loop's total cost, not from a general preference for memoization or lazy computation.
- Use indexes or typed handles instead of pointers when data lives in stable arrays.
- Use distinct index types or small wrappers when raw integers would erase meaning.
- Turn loop-membership booleans into active lists, masks, bitsets, or partitioned arrays when they dominate the loop.
- Use compact masks for selected output/state work, but keep enum-backed accessors for type clarity.
- Keep row/column order and state dimensions tied to typed enums or explicit types, not comments around raw offsets.

## Memoization Vs Lazy Computation

- Do not treat memoization or lazy computation as inherently faster. The real question is which version makes the actual hot loop move less expensive data and do less expensive work.
- Memoize when recompute cost multiplied by reuse count is higher than stored-value load cost plus storage/cache pressure.
- Compute lazily when stored-value load cost plus storage/cache pressure is higher than recompute cost multiplied by reuse count.
- Count input bytes, not just output bytes. Removing a stored value is not a win if recomputing it requires scattered source reads, pointer chasing, extra branches, divisions, function calls, or vectorization barriers.
- Check locality. A larger stored value can be faster when it streams with adjacent hot data; a smaller struct can be slower when it forces distant loads or unpredictable control flow.
- Separate hot and cold paths. Memoize expensive, frequently reused, cache-friendly results. Recompute cheap, rarely used, or bloated derived values. Keep diagnostic, optional, and rare payloads out of every hot item.
- Store compact source data when that lets the hot loop stream predictably.
- Do not optimize memory footprint in isolation. Smaller structs are useful only when the hot loop gets faster, or when memory drops materially while runtime stays acceptably close.
- Benchmark both shapes under the same workload, build mode, worker count, warmup, timing boundary, and correctness checks.

## Allocation And Workspace Rules

- Do not allocate inside repeated numeric, parser, search, scheduling, or rendering loops.
- Make allocation visible in signatures with an explicit allocator.
- Keep non-allocating hot helpers free of fake allocator parameters.
- Give owning workspaces `init`/`deinit` and reuse their buffers across calls.
- Grow buffers by capacity, then return sliced views for the current problem size.
- Replace buffers only after replacement allocation succeeds; do not free the old buffer before a fallible allocation.
- Attach `defer`/`errdefer` immediately after acquisition.
- Avoid temporary return-then-copy shapes in repeated matrix/vector work; write into caller-owned outputs.
- Prefer fixed-size arrays for tiny fixed dimensions when that removes heap traffic without obscuring semantics.
- Use arenas only when many allocations truly share one lifetime; do not use arenas to hide unclear ownership.

## Branch And Work-Skipping Rules

- Test cheap no-contribution cases before expensive setup.
- Carry active masks forward so later stages do not rediscover inactive work.
- Specialize loops by mode/state when a branch is repeated and predictable.
- Request and compute only active output/state columns for the current operation.
- Avoid computing diagnostics, final evaluations, display values, or retained artifacts until they are requested.
- Stop converged tails only when the threshold is a real validation contract, not a tuning shortcut.
- Move rare paths out of common loops when it reduces branches or payload size.
- Use comptime specialization for build-time or type-shape choices; use runtime dispatch only when multiple implementations must coexist at runtime.

## Zig Safety And Boundary Rules

- Every owning type has a clear `deinit`; every allocating constructor has a tested cleanup path.
- Partial initialization must roll back immediately and locally.
- Dynamic boundaries get typed wrappers at the edge: env vars, config, JSON, FFI, protocol payloads, and string-keyed controls.
- Protocol states use enums, tagged unions, packed structs, or explicit structs, not loose strings and raw integers.
- Use `packed struct` only when bit/ABI layout matters; use normal structs for ordinary in-memory state.
- Globals are fenced to C/FFI boundaries, process entrypoints, or true singletons; pure Zig APIs receive state explicitly.
- ABI-relevant enums, packed layouts, and C-facing values must be explicit and tested.
- Comments explain performance pressure, invariants, validation contracts, and tradeoffs; they do not narrate syntax.

## Matrix, Vector, And Kernel Rules

- Write repeated products into final destinations.
- Keep state dimensions explicit.
- Do not carry all possible output columns through a kernel if only a subset is active.
- Separate numerical kernels from validation/report construction.
- Keep batch-stable or request-stable setup in reusable workspaces.
- Separate input construction, preparation/loading, cache warmup, steady-state execution, final evaluation, and diagnostics when timing multi-stage work.

## Measurement Discipline

- State exactly what a timing includes: setup, preparation, cache warmup, steady-state execution, final evaluation, diagnostics, formatting, and artifact writing.
- Benchmark the narrow hot path and the end-to-end path separately.
- Keep benchmark artifacts in the project's retained evidence location when the repo has one.
- Do not compare numbers from different timing boundaries.
- Validate expected outputs, invariants, or domain-specific checks before reporting a speedup.
- Treat threshold changes as correctness contract changes, not performance fixes.
- Prefer explicit benchmark scripts and reproducible commands over hand-edited timing notes.

## Instrumentation And Evidence Rules

- Treat instrumentation as a boundary around the product path, not as a second implementation mode. The measured code should keep the same input -> prepare -> compute -> output shape; trace and benchmark harnesses should drive that path from the outside.
- Compile heavy tracing/profiling dependencies only into explicit trace or benchmark artifacts. Normal library and test builds should use no-op stubs or compile-time-disabled facades so production code does not inherit profiler dependencies.
- Keep one tiny instrumentation facade in hot code. Kernels may emit zones, counters, labels, or thread names, but they should not know about capture files, export formats, profiler options, shell scripts, or report generation.
- Keep instrumentation consumers outside kernels. Capture, export, summaries, hardware-counter wrappers, and report assembly belong in benchmark scripts or tooling, not in compute modules.
- Keep trace labels stable and hierarchical because labels become the shared vocabulary for comparing runs. Renaming labels casually breaks historical comparisons even when the code still works.
- Keep timeline profiling separate from low-overhead elapsed timing. Instrumented profilers explain what time is made of; uninstrumented or low-overhead runs establish how fast the code is.
- Never report profiler-instrumented wall time as product runtime unless instrumentation overhead is explicitly the thing being measured.
- Keep retained validation/benchmark evidence separate from scratch traces and exploratory captures. The former supports claims; the latter supports investigation.
- Delete scaffolding once it stops paying rent. Custom trace tables, counters, diff harnesses, and profile CLIs are useful while they drive decisions; they become architecture debt when optimized code keeps depending on them.
- Do not let instrumentation facades grow into general runtime configuration modules. Scheduling, worker limits, cache policy, and feature behavior belong with the subsystem that owns them.

## Anti-Patterns

- Allocating in hot loops.
- Computing inactive states, output columns, diagnostics, or final evaluations by default.
- Dragging cold fields through hot loops because input structs were reused as compute structs.
- Storing all optional payloads inline when most items do not use them.
- Repeated string-key lookup, parsing, unit conversion, or dynamic dispatch inside steady-state loops.
- Workspace caches with vague keys, hidden invalidation, or cross-request mutation.
- Memoizing rare, diagnostic, or optional data inside every hot item.
- Removing stored derived values while adding scattered source loads, branches, divisions, or function calls.
- Optimizing memory footprint without proving the hot loop is faster or acceptably close.
- Runtime vtables for build-time choices.
- Raw integer state masks without enum-backed accessors.
- Silent truncation or threshold relaxation to get a faster result.
- Performance claims without correctness evidence.
- Benchmark comparisons across different timing boundaries.
- Trace/profiling dependencies imported by normal library builds.
- Instrumented timeline numbers presented as uninstrumented runtime.
- Instrumentation facades that become dumping grounds for scheduler or runtime policy.
- Broad compatibility shims that preserve old structure instead of making the hot path direct.

## Review Checklist

- [ ] Is the repeated thing identified?
- [ ] Is the hot loop identified, including exact fields read and written?
- [ ] Are setup, preparation, steady-state execution, diagnostics, formatting, and final evaluation separated?
- [ ] Are hot fields dense and cold fields out of the loop?
- [ ] Is the layout SoA, AoS, sparse side storage, or partitioned storage for a concrete reason?
- [ ] Is the memoized/lazy choice based on the consumer loop, reuse count, input bytes, and locality?
- [ ] Does a smaller layout avoid adding scattered reads, branches, divisions, or recomputation?
- [ ] Are active states represented as typed enums, masks, bitsets, or lists?
- [ ] Are allocations outside hot loops?
- [ ] Is workspace reuse explicit and invalidated by typed keys?
- [ ] Are matrix/vector helpers writing into caller-owned outputs where repeated?
- [ ] Are mode branches moved out of inner loops where practical?
- [ ] Are all parsed controls consumed, rejected, or covered as inert?
- [ ] Is file I/O outside compute code?
- [ ] Are ABI and boundary layouts explicit where relevant?
- [ ] Are correctness validation and timing evidence both present?
- [ ] Does normal code compile without heavy tracing/profiling dependencies?
- [ ] Is instrumentation behind one narrow facade?
- [ ] Are timeline profiling numbers kept separate from low-overhead runtime numbers?
- [ ] Are trace labels stable enough to compare across runs?
- [ ] Has obsolete scaffolding been removed after the finding was converted into code, tests, or retained evidence?
- [ ] Does the optimization preserve observable behavior rather than changing the problem?

## Bottom Line

Before editing Zig performance code, make these questions cheap to answer:

- What data repeats?
- Which fields does the hot loop actually touch?
- What allocation, branch, conversion, or cache miss is being removed?
- Which side of the memoization/lazy-computation tradeoff moves less expensive data and does less expensive work?
- What workspace or prepared representation is reused?
- What correctness gate proves the same behavior is preserved?
- What timing boundary proves the speedup?
- What instrumentation boundary prevents the profiler from becoming the architecture?
