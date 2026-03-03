---

description: Condensed detection heuristics for all 24 code smells. Read this first for broad pattern matching, then drill into specific smell files for detailed refactor guidance.
metadata:
  id: coding.ref.code-smells.detection-signals
  version: "1"
  task_types:
    - coding
    - code-smell
    - refactor
    - code-review
  trigger_phrases:
    - code smells
    - detection signals
    - smell detection
    - quality review
  priority: 71
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---

# Code Smell Detection Signals (Cheat Sheet)

These signals serve two purposes:
- **When implementing**: do not write code that matches these patterns.
- **When reviewing**: use them to detect and flag existing violations.

When signals match and you need refactor guidance, open the full smell file.

## Bloaters

**Long Method** — `smells/long-method.md`
- Method blends multiple responsibilities (validate, persist, notify in one function)
- Deeply nested control flow or large inline branches
- Hard to name what the method "does" in one phrase

**Large Class** — `smells/large-class.md`
- Class owns fields/methods spanning unrelated domains (auth + billing + notifications)
- Frequent changes touch unrelated regions of the same class
- Would need multiple section headers to describe its purpose

**Primitive Obsession** — `smells/primitive-obsession.md`
- Domain concepts represented as raw strings/ints (email as `str`, money as `float`)
- Same validation rules (e.g., format checks) repeated at multiple call sites
- Type codes (`"admin"`, `"user"`) drive behavior via conditionals

**Long Parameter List** — `smells/long-parameter-list.md`
- Functions take many positional arguments (5+)
- Call sites repeatedly pass the same argument groups together
- Easy to swap argument order without compiler/type error

**Data Clumps** — `smells/data-clumps.md`
- Same small group of fields travels together across multiple signatures
- Multiple APIs share identical argument bundles (to, cc, bcc, subject, body)
- Related data lacks a named abstraction to hold it

## Object-Orientation Abusers

**Switch Statements** — `smells/switch-statements.md`
- Same type-dispatch (if/elif or switch on type code) appears in multiple locations
- Adding a new type requires updating branches in several files
- Behavior is selected by codes/strings instead of polymorphism

**Temporary Field** — `smells/temporary-field.md`
- Fields are only meaningful in rare execution paths or specific modes
- Many methods guard against null/unset state for certain fields
- Class invariants are unclear outside narrow workflow branches

**Refused Bequest** — `smells/refused-bequest.md`
- Subclasses override parent methods mainly to disable or reject them
- Inherited members go unused by the subclass
- Inheritance relationship does not model an "is-a" reality

**Alternative Classes with Different Interfaces** — `smells/alternative-classes-with-different-interfaces.md`
- Classes provide equivalent capability but with incompatible method signatures
- Callers branch on provider/type just to map argument shapes
- Teams duplicate logic per implementation due to naming mismatch

## Change Preventers

**Divergent Change** — `smells/divergent-change.md`
- One class changes for many unrelated reasons (tax rules, rendering, inventory)
- Release work repeatedly touches the same file for different concerns
- Multiple change axes are fused into a single owner

**Shotgun Surgery** — `smells/shotgun-surgery.md`
- A single logical change requires edits scattered across many files
- Renaming one concept touches DB schema, API contracts, UI labels, analytics
- Small related tweaks are spread thin and hard to track together

**Parallel Inheritance Hierarchies** — `smells/parallel-inheritance-hierarchies.md`
- Adding one subtype forces matching subtype additions in another hierarchy
- Two class trees must evolve in lockstep (Report + ReportPresenter)
- Cross-hierarchy coupling multiplies maintenance cost

**AI Code Smell (Fallback-First)** — `smells/ai-code-smell.md` **ALWAYS OPEN this file**
- New logic keeps the old path "just in case" without a removal plan
- Feature flags preserve both old and new behavior without expiry
- Broad catch blocks silently fall back to legacy behavior
- `or`/`||` chains over mixed old/new field names with silent defaults
- *This smell file contains adapter/wrapper guardrails and code-review checks
  that are not fully captured here — always open the full file.*

## Dispensables

**Comments** — `smells/comments.md`
- Comments explain confusing code instead of expressing intent through naming
- Stale comments contradict actual behavior
- Commented-out code accumulates as dead history

**Duplicate Code** — `smells/duplicate-code.md`
- Similar logic is copied across modules with only variable renames
- Bug fixes must be applied in multiple places
- Slightly diverged copies hide originally shared intent

**Lazy Class** — `smells/lazy-class.md`
- Class adds little behavior beyond pass-through indirection
- Type boundary exists without meaningful responsibility or invariants
- Maintenance overhead exceeds the value the class provides

**Data Class** — `smells/data-class.md`
- Class mostly contains fields with trivial getters/setters
- Business logic (validation, state transitions) lives outside the data owner
- Invariants are enforced externally rather than internally

**Dead Code** — `smells/dead-code.md`
- Unreachable branches or unused functions remain in the codebase
- Feature flags are permanently disabled but code paths still exist
- Old paths create noise and mislead reviewers

**Speculative Generality** — `smells/speculative-generality.md`
- Abstractions/interfaces exist for hypothetical future use only
- Extension points and hooks remain unused over time
- Complexity is paid now for uncertain value later

## Couplers

**Feature Envy** — `smells/feature-envy.md`
- A method uses another object's data more than its own
- Frequent getter chains target a foreign type's fields
- Behavior sits far from the data it primarily depends on

**Inappropriate Intimacy** — `smells/inappropriate-intimacy.md`
- Classes access each other's private/internal fields directly
- Underscore-prefixed or internal state is mutated from outside the owner
- Tight coupling blocks independent evolution of either class

**Message Chains** — `smells/message-chains.md`
- Long chained access paths (`a.b().c().d()`) appear at call sites
- Clients traverse deep object graphs directly
- Structural changes in one object ripple across many consumers

**Middle Man** — `smells/middle-man.md`
- A class mostly forwards calls to another class without adding policy
- Nearly every method is a one-line delegation
- Indirection increases call depth without meaningful benefit

**Incomplete Library Class** — `smells/incomplete-library-class.md`
- Same library workaround is copied at multiple call sites
- Post-processing or default-patching around third-party APIs is repeated
- Usage inconsistencies across the codebase increase maintenance risk
