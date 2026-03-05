# Code Smell Detection

Use for deep smell reviews, code audits, or when the coding skill's baseline signals aren't specific enough. For routine code changes, the smell baseline in `skills/coding/SKILL.md` is sufficient.

## Workflow

1. Match code against the detection signals below.
2. When signals match, open the specific smell file under `references/` for remediation guidance.
3. Classify findings with canonical smell labels, severity, and concrete evidence.
4. Provide refactoring options — do not auto-refactor unless explicitly requested.

## Always-check policy

- `references/ai-code-smell.md` — fallback-first/compatibility-branch guardrail. **Always open this file** for any code review or implementation task.

## Detection Signals

### Bloaters

**Long Method** — `references/long-method.md`
- Method blends multiple responsibilities (validate, persist, notify in one function)
- Deeply nested control flow or large inline branches
- Hard to name what the method "does" in one phrase

**Large Class** — `references/large-class.md`
- Class owns fields/methods spanning unrelated domains (auth + billing + notifications)
- Frequent changes touch unrelated regions of the same class
- Would need multiple section headers to describe its purpose

**Primitive Obsession** — `references/primitive-obsession.md`
- Domain concepts represented as raw strings/ints (email as `str`, money as `float`)
- Same validation rules repeated at multiple call sites
- Type codes drive behavior via conditionals

**Long Parameter List** — `references/long-parameter-list.md`
- Functions take many positional arguments (5+)
- Call sites repeatedly pass the same argument groups together
- Easy to swap argument order without compiler/type error

**Data Clumps** — `references/data-clumps.md`
- Same small group of fields travels together across multiple signatures
- Related data lacks a named abstraction to hold it

### Object-Orientation Abusers

**Switch Statements** — `references/switch-statements.md`
- Same type-dispatch appears in multiple locations
- Adding a new type requires updating branches in several files

**Temporary Field** — `references/temporary-field.md`
- Fields are only meaningful in rare execution paths
- Many methods guard against null/unset state for certain fields

**Refused Bequest** — `references/refused-bequest.md`
- Subclasses override parent methods mainly to disable or reject them
- Inherited members go unused by the subclass

**Alternative Classes with Different Interfaces** — `references/alternative-classes-with-different-interfaces.md`
- Classes provide equivalent capability but with incompatible method signatures

### Change Preventers

**Divergent Change** — `references/divergent-change.md`
- One class changes for many unrelated reasons
- Multiple change axes are fused into a single owner

**Shotgun Surgery** — `references/shotgun-surgery.md`
- A single logical change requires edits scattered across many files

**Parallel Inheritance Hierarchies** — `references/parallel-inheritance-hierarchies.md`
- Adding one subtype forces matching subtype additions in another hierarchy

**AI Code Smell (Fallback-First)** — `references/ai-code-smell.md` **ALWAYS OPEN**
- New logic keeps the old path "just in case" without a removal plan
- Feature flags preserve both old and new behavior without expiry
- Broad catch blocks silently fall back to legacy behavior
- `or`/`||` chains over mixed old/new field names with silent defaults

### Dispensables

**Comments** — `references/comments.md`
- Comments explain confusing code instead of expressing intent through naming

**Duplicate Code** — `references/duplicate-code.md`
- Similar logic is copied across modules with only variable renames

**Lazy Class** — `references/lazy-class.md`
- Class adds little behavior beyond pass-through indirection

**Data Class** — `references/data-class.md`
- Class mostly contains fields with trivial getters/setters

**Dead Code** — `references/dead-code.md`
- Unreachable branches or unused functions remain in the codebase

**Speculative Generality** — `references/speculative-generality.md`
- Abstractions/interfaces exist for hypothetical future use only

### Couplers

**Feature Envy** — `references/feature-envy.md`
- A method uses another object's data more than its own

**Inappropriate Intimacy** — `references/inappropriate-intimacy.md`
- Classes access each other's private/internal fields directly

**Message Chains** — `references/message-chains.md`
- Long chained access paths at call sites

**Middle Man** — `references/middle-man.md`
- A class mostly forwards calls to another class without adding policy

**Incomplete Library Class** — `references/incomplete-library-class.md`
- Same library workaround is copied at multiple call sites
