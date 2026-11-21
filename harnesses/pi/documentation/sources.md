# Sources and adaptations

Reviewed 16 November 2026. The runtime is generic; no Tempo assignment domain requirements are
embedded in its prompts or fixtures.

- [TigerStyle](https://tigerstyle.dev/): explicit bounds, preparation/allocation, assertions,
  deterministic interfaces, dimensionality, dependencies, resource costs, batching, locality, naming
  and craftsmanship. The shared prompt is a concise paraphrase; it preserves recognizable principles
  rather than copying a complete style guide.
- [NASA/JPL Power of Ten](https://spinroot.com/gerard/pdf/P10.pdf): all ten rules appear in the
  shared prompt. C-specific rules are labeled as such; managed languages use documented
  applicability and review signals.
- Pi 1.5.2 installed SDK and CLI documentation: extension events, explicit resource loaders, session
  context, session switching and role tools.
- [Claude CLI](https://code.claude.com/docs/en/cli-reference): explicit prompts, built-in tool
  selection, strict MCP, settings sources and print-mode limits.
- [Claude settings](https://code.claude.com/docs/en/settings): invocation-scoped overrides and
  managed-policy precedence.

Executable linting was adapted from the user's repositories:

- `tempo-testusd/scripts/linting/readability.mjs`: TypeScript AST-based logical stage and
  standalone-comment spacing.
- `bankeriq-agent-platform/scripts/linting/check_readability.py`: Python AST/token-based spacing;
  version-specific future-annotation policy was omitted.
- Their source exclusions, JSON checks and 100-column conventions informed the runtime's shared
  executable profile. Project semantic tools remain explicit.

Performance guidance comes from canonical `skills/performance-engineering/`, selected
`skills/zig/references/` files, and the boundaries demonstrated in zdisamar's `benchmark/AGENTS.md`
and `src/instrumentation/AGENTS.md`: public-path measurement, full benchmark versus canary, and
instrumentation facades whose disabled behavior preserves production semantics.

## Model selection evidence

The configured split reflects user preference and independent review context. It is not a claim of a
universal benchmark winner.

[Anthropic's Fable 5.2 release](https://www.anthropic.com/claude-fable-and-mythos-5-2) reports
strong coding evaluations, with effort and workload affecting the result. Its published
cybersecurity scores for Mythos should not be attributed to Fable.
[OpenAI's model guidance](https://developers.openai.com/api/docs/models) positions GPT-6.1 Sol as a
balance of capability and cost, with Astra for the most demanding work.

[Cross-model review research](https://arxiv.org/abs/2607.21656) found benefits when Claude reviewed
Codex drafts. It used Opus 4.7 and GPT-5.5 on 116 LiveCodeBench tasks, with reviewers unable to
execute tests. It does not establish the best pairing for Fable 5.2, GPT-6.1 Sol, security review or
a production repository. The harness's own live runs validate integration and gates; they are not a
model leaderboard or proof that every future generated change is correct.

## Claude research tools

- [Claude Code tools reference](https://code.claude.com/docs/en/tools-reference): WebSearch and
  WebFetch capabilities and availability.
- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference): the explicit `--tools`
  selection, print mode and streamed JSON output. Local CLI help and real tool calls verify the
  installed version's behavior.

## Testing evidence

The dimensions and 80/100 target are Pi policy. Unmesh Joshi describes replayable scheduling, fault
injection and checking safety and recovery through observable histories. [Deterministic Simulation
Testing][dst]

[dst]: https://martinfowler.com/articles/deterministic-simulation-testing.html

Joe Hellerstein distinguishes guarantees enforced by construction or proof from bounded exploration
and explains how a separate model can diverge from shipped code.
[No Room for Bugs](https://jhellerstein.github.io/blog/no-room-for-bugs/)

Browser journey coverage reflects the project's engineering policy for user-facing web behavior.
