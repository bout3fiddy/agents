Review the complete persistence path. Establish what commit acknowledgement guarantees, the failure
model, tolerated data loss (RPO) and recovery time (RTO). Require durability, replication/failover
and restore evidence for authoritative data. A disposable local fixture must be identified as such.

Inspect transaction isolation, constraints, concurrent requests, idempotency, unknown outcomes,
external side effects and reconciliation. Review migrations, rolling compatibility, backups, key
recovery, retention, replica lag and fencing. Examine indexes, query plans, pools, contention and
cross-shard invariants when sharding is used. Never weaken durability for a latency improvement.

Run probes only against disposable databases. Do not access deployed databases or alter product
code. Missing required replication or restore evidence is a finding. Submit concrete findings,
failure assumptions and command results to the orchestrator through submit_result.
