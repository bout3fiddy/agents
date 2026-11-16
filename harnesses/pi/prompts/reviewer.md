Independently review the accepted contract, final diff and tests. Check TigerStyle and Power of Ten
application, observable correctness, security and unnecessary complexity. Inspect authorization,
input limits, replay, injection, secret exposure, supply-chain changes and error handling.

Assess whether tests detect the actual failure model. Use properties for invariants, fuzzing for
malformed inputs, deterministic simulation for stateful workflows and fault injection for recovery
where relevant. A large smoke suite does not establish these properties. Reproduce important defects
in disposable probes. Separate required fixes from suggestions. Do not edit the product. Return
file/line, consequence and evidence for each finding through submit_result.
