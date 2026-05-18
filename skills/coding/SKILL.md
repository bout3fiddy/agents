---
name: coding
description: Performance-grounded code implementation, bug fixes, refactors, code reviews, and technical guidance. Covers hard cutovers, instrumentation, data layout, simple state objects, structured comments, and anti-pattern detection.
---

# Coding

## Goal

Write code whose shape is justified by the way it runs, the data it moves, and the evidence that proves it still behaves correctly.

Prefer direct, measurable reasoning over abstract architecture taste. When choosing between two designs, ask what changes in runtime, memory traffic, allocation count, branch shape, data locality, generated code, and verification cost.

## Default Workflow

1. Read the local rules. Check repo instructions and the relevant source before editing.
2. Find the real path. Identify the code path the request changes, the data it reads and writes, and the boundary where behavior is verified.
3. Reuse deliberately. Search for existing types, helpers, folders, and validation commands before adding new ones.
4. Choose the simplest performant shape. Prefer functions for logic, simple data objects for state, explicit inputs, explicit outputs, and layouts that keep hot data compact.
5. Build scaffolding. For performance-sensitive or structural work, create or use instrumentation that measures the relevant cost. Working without instrumentation is working blind.
6. Write comments where context would be missing. Explain hot paths, memory layout, instrumentation boundaries, and surprising tradeoffs in plain language.
7. Verify. Run the focused tests, type checks, benchmark, trace, or validation command that proves the change.
8. Summarize evidence. Report the changed behavior, performance boundary if relevant, validation commands, and remaining risk.

## Performance-Grounded Design

- Let performance guide style when performance plausibly matters. Objects, abstractions, folders, and indirection are acceptable only when they improve runtime, memory traffic, locality, verification, or reader understanding enough to justify their cost.
- Do not use arbitrary rules such as function length, number of files, or number of objects as quality proof. Split code when the split improves data flow, ownership, measurement, locality, or verification.
- Before adding an abstraction, name what it saves: repeated work, copied bytes, allocations, branches, scattered reads, compile-time duplication, or test complexity.
- Before removing an abstraction, name what becomes cheaper or clearer: fewer calls, less state, simpler generated code, tighter data, or a smaller verification surface.
- In performance-sensitive code, inspect the actual target when it matters: benchmark output, trace output, allocator counts, memory layout, compiler output, disassembly, or hardware counters.
- Optimize for compute-constrained environments by default: compact data, small memory traffic, predictable loops, minimal allocation, and no unnecessary product-layer dependencies.

## State And Logic

- Prefer functions for logic and simple data objects for state.
- Objects/classes should mostly hold coherent data and simple lifecycle rules. Avoid complex mutation methods that hide control flow, allocation, or performance cost.
- Keep state explicit. Pass stores, workspaces, contexts, and buffers directly rather than hiding them behind global mutable state.
- Use named types for real domain or data-layout concepts. Do not pass raw strings, dictionaries, or integer flags when they spread validation and meaning across call sites.
- If adding an object-heavy design, check whether it improves locality and clarity or adds pointer chasing, hidden mutation, allocation, and harder testing.

## Folder Structure

- Put code that belongs together in the same folder when it shares runtime purpose, data ownership, validation, or change cadence.
- Split folders by real boundaries: input/loading, preparation, compute, output/reporting, validation, benchmarks, and instrumentation.
- Keep compute code free of CLI parsing, file I/O, report assembly, compatibility adapters, and profiler/export logic.
- Keep benchmark, validation, trace, and scratch tooling outside the product path unless the product code exposes a narrow instrumentation facade.
- Prefer a small focused folder over a mixed utility bucket when several files operate on the same data shape.

## Scaffolding And Instrumentation

Scaffolding is temporary or boundary-local code that helps understand performance, correctness, and data shape. Strive to build it for non-trivial implementation work. Working without good instrumentation is working blind.

The boundary matters: mature production code should not be polluted with permanent scaffolding nobody asked for. In those cases, build the benchmark, trace, counter, or harness literally in scratch space first: `/tmp`, an ignored local directory, or another disposable location. It should not be imported, wired into normal builds, exposed to users, or committed. If instrumentation is worth retaining, provide a way to compile it out or keep it behind an explicit opt-in build path. Ask the user before moving instrumentation or retained benchmark assets into the repository.

- Microbenchmarks measure one function, loop, parser path, allocator pattern, or layout choice.
- End-to-end benchmarks measure the real user or production boundary, including setup and output work.
- Trace zones and timeline profiling show phase shape, nesting, overlap, stalls, and where time goes. They explain cost; they are not uninstrumented runtime.
- Low-overhead timing measures elapsed runtime with minimal observer cost. Use it for before/after speed claims.
- Hardware counters measure cycles, instructions, cache misses, branch misses, and memory stalls when layout or branch behavior is the question.
- Allocation counters or allocator wrappers measure allocation count, allocation size, peak live bytes, churn, and accidental hot-loop allocation.
- Memory layout reports measure struct size, padding, cache-line span, retained heap size, stack footprint, and copied bytes.
- Compiler output or disassembly inspection shows whether the compiler emitted the expected loads, stores, calls, branches, divisions, vectorization, or inlining.
- Golden-output validation proves the optimized code still produces the same observable behavior.
- Scratch harnesses isolate a question quickly without changing mature product code. Keep them disposable unless the user wants the instrumentation retained.

Instrumentation rules:

- Product code may emit narrow signals through a tiny facade.
- Product code must not know about trace files, report formats, profiler configuration, shell scripts, or dashboards.
- Instrumentation must not become a config module, scheduler, state manager, or alternate implementation path.
- Retained instrumentation should be compiled out, no-op by default, or enabled only through an explicit benchmark/trace build.
- In mature codebases, prefer scratch-space instrumentation first. Commit instrumentation only when it is requested or when the user agrees it should become retained evidence.
- Retained evidence belongs in the repo's validation or benchmark area; scratch traces and exploration output stay disposable.
- Delete scaffolding when the finding has been converted into code, tests, comments, or retained evidence.

## Comments

- Add comments when they preserve context the reader cannot recover from the code alone.
- Prefer concise structured comments for hot paths, memory layout, instrumentation boundaries, and non-obvious tradeoffs.
- Think about the next reader's context. Do not assume they know the performance investigation, failed alternatives, or benchmark history.
- Use simple language. Avoid jargon unless the codebase already uses the term, and tie technical terms to concrete effects such as "loads fewer bytes", "avoids per-item allocation", or "keeps rare data out of the loop".
- Good structured comments usually answer one or more of: `Why:`, `Tradeoff:`, `Evidence:`, `Boundary:`.
- Do not narrate syntax or restate names. One useful comment is better than several clever but vague comments.
- Preserve user-authored notes such as `Feedback:` unless the user explicitly asks to remove them.

## Hard Cutover Rules

- No fallback-first implementations. Use hard cutovers by default.
- No compatibility shims, dual paths, dual reads/writes, or legacy fallbacks without explicit user approval plus owner, removal date, tracking issue, and validation plan.
- No broad catch blocks that silently fall back to old behavior.
- No `or`/`||` chains over mixed old/new field names with silent defaults.
- If old behavior is being replaced, delete the old route in the same coherent change when safe.

## Anti-Patterns

- Performance-sensitive choices justified only by taste, pattern names, or generic "clean code" claims.
- Object-oriented designs where objects hide logic, mutation, allocation, or slow paths.
- Folder splits that scatter a single runtime concept across abstract layers.
- Instrumentation that leaks into product behavior or becomes a second architecture.
- Avoiding instrumentation for non-trivial performance or structural work and then guessing from code shape alone.
- Committing scaffolding into a mature codebase without asking whether it should be retained.
- Benchmarks that compare different boundaries, warmup states, worker counts, or validation conditions.
- Memory-footprint reductions that add more scattered reads, branches, or recomputation in the hot path.
- Compatibility wrappers that mostly forward calls while preserving old names or routes.
- Speculative parameters, hooks, config, or abstractions with no current measured need.
- Global mutable state outside process boundaries, FFI boundaries, or true singletons.
- Comments that use jargon to hide an unclear decision.

## Review Checklist

- [ ] What path changed, and where is behavior verified?
- [ ] What data does the important loop or workflow read and write?
- [ ] Does the chosen shape reduce runtime, memory traffic, allocation, branch cost, or verification cost?
- [ ] If objects/classes were added, are they simple state holders rather than hidden logic containers?
- [ ] Does the folder structure group code by real data/runtime ownership?
- [ ] Was relevant scaffolding or instrumentation used instead of guessing?
- [ ] Is instrumentation outside the product layer or behind one narrow facade?
- [ ] If the codebase is mature, was scratch instrumentation used before committing retained scaffolding?
- [ ] Are benchmark and validation boundaries named and comparable?
- [ ] Are comments concise, structured, plain-language, and useful to a reader without your context?
- [ ] Did the change avoid fallback-first compatibility scaffolding?
- [ ] Are obsolete scaffolding, dead paths, and speculative hooks removed?
