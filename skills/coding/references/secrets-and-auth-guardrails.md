# Secrets and Auth Guardrails (Reference)

## Absolute rules
- Never print or request secrets; redact if shown.
- Never read `.env`, `.gcloud`, `.boto`, `~/.aws`, `~/.kube`, `credentials.json`, or private key files.
- Never log or paste tokens, passwords, or keys.
- Use placeholders in any examples.

## Before any auth/secret work
1) Confirm scope: setup, remediation, or incident response.
2) Warn about side effects: call out any command that may persist credentials locally.
3) If a tool config path is involved (e.g., `CLOUDSDK_CONFIG`), ensure it is outside repos.
4) Ensure `.gitignore` contains common secret paths:
   - `.env*`, `.gcloud/`, `.boto`, `*.pem`, `*.p12`, `credentials.json`, `.aws/`, `.kube/`.

## When a secret leak is suspected (do not delay)
1) Revoke/rotate credentials at the provider.
2) Remove local copies from repo (working tree + index).
3) Rewrite git history to purge secrets.
4) Force-push rewritten history (all branches + tags).
5) Notify collaborators to re-clone / reset.

## Remediation checklist (generic)
- Revoke access tokens/refresh tokens.
- Rotate client secrets/keys.
- Invalidate sessions if applicable.
- Remove leaked files from repo (and history).
- Add `.gitignore` rules.
- Ensure secrets are stored via a secret manager, not the repo.

## Safe repo inspection (no secret exposure)
- Use `git ls-files` to find tracked secret paths.
- Use `git log --name-status -- <path>` to confirm history.
- Never `cat`, `sed`, `grep`, or `rg` inside secret files.

## If user wants auth setup
- Provide steps without secrets and require user to paste outputs excluding sensitive content.
- If auth tooling writes credentials locally, warn and direct to safe config paths.

## If auth tooling needs config path
- Default to a safe, non-repo location: `$HOME/.config/<tool>` or `/tmp/<tool>`.
- Never set tool config inside a repo unless user explicitly approves.

## Incident response output (always include)
- What leaked.
- Where it leaked (files/paths).
- Immediate actions taken.
- What must be rotated/revoked.
- How to prevent recurrence.

## Escalation behavior
- If a command could reveal or persist secrets, ask for explicit confirmation.
- If a user asks to paste secrets, refuse and provide secure alternatives.
