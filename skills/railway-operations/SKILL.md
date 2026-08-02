---
name: railway-operations
description: Operate or troubleshoot Railway projects, services, databases, deployments, environments, variables, domains, metrics, or Railway API requests. Use when Railway is explicit or the repository is already linked to Railway; do not trigger for generic deployment, service, environment, or build-failure requests.
---

# Railway Operations

Use Railway's current CLI and documentation to act on a resolved project,
environment, and service.

## Preflight

Before mutation, run the applicable read-only checks:

```bash
railway --version
railway whoami --json
railway status --json
```

Inspect `railway <command> --help` when a documented command is rejected; CLI
surfaces change and local versions can lag current documentation. If the CLI is
missing, unauthenticated, or unlinked, report that boundary before attempting
operations that depend on it.

## Reference routing

Load only the reference needed for the request:

| Intent | Reference |
|---|---|
| Create or connect projects, services, databases, or workspaces | [setup.md](references/setup.md) |
| Deploy, redeploy, restart, or configure build sources | [deploy.md](references/deploy.md) |
| Change environments, variables, domains, or networking | [configure.md](references/configure.md) |
| Inspect status, logs, metrics, failures, or recovery | [operate.md](references/operate.md) |
| Use Railway's API or current official documentation | [request.md](references/request.md) |

Use two references only when the workflow genuinely spans both areas.

## Execution rules

1. Prefer the Railway CLI; use `scripts/railway-api.sh` only for operations the
   installed CLI does not expose.
2. Resolve the exact project, environment, and service before mutation. Do not
   infer that an application name is a project name.
3. Prefer structured output such as `--json` when supported.
4. Confirm destructive operations and their state impact before execution.
5. Read back state after every mutation and report the resulting identifiers or
   status.
6. Never expose variable values, tokens, or credentials in summaries.

When the installed Railway CLI provides its maintained agent skill or MCP setup,
prefer that maintained integration and keep this local skill only for missing
repository-specific behavior.
