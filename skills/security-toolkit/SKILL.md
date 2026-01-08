---
name: security-toolkit
description: Security scanning toolkit for BFF boundaries and CI/CD. Use when setting up or running gitleaks, semgrep, bandit, trivy, checkov, or hadolint.
metadata:
  version: "1.0.0"
---

# Security Toolkit Skill

**"Assume Breach" security tooling for Python/TypeScript on GCP Cloud Run.**

This skill provides ready-to-use configurations for enforcing BFF security boundaries in CI/CD and local scans.

## Philosophy: Assume Breach Containment

Vulnerabilities happen. The goal is **blast radius reduction**, not just prevention.

When RCE occurs in the frontend:
1. **No database credentials to steal** - credentials only in backend
2. **No lateral movement** - network policies block everything except BFF API
3. **No persistence** - read-only filesystem, distroless images
4. **Immediate detection** - runtime monitoring catches anomalies

## Quick Start

### 1. Copy Configs to Project Root

```bash
# From project root
cp ~/.codex/skills/security-toolkit/config/.gitleaks.toml .
cp ~/.codex/skills/security-toolkit/config/.pre-commit-config.yaml .
cp -r ~/.codex/skills/security-toolkit/config/.semgrep .
cp ~/.codex/skills/security-toolkit/config/.checkov.yaml .
cp ~/.codex/skills/security-toolkit/config/.hadolint.yaml .
cp ~/.codex/skills/security-toolkit/workflows/security-scan.yml .github/workflows/
```

### 2. Install Pre-commit Hooks

```bash
poetry add --group dev pre-commit
poetry run pre-commit install
```

### 3. Run Initial Scan

```bash
# Run all security checks
poetry run pre-commit run --all-files

# Or run specific tools
gitleaks detect --source . --verbose
poetry run semgrep --config .semgrep/ .
poetry run bandit -r apps/ -c pyproject.toml
trivy fs . --scanners vuln,secret,misconfig
```

## What's Included

| File | Purpose |
|------|---------|
| `.gitleaks.toml` | Secret detection with GCP/Supabase custom rules |
| `.pre-commit-config.yaml` | Multi-tool security hooks (gitleaks + bandit + semgrep + hadolint + checkov) |
| `.semgrep/bff-security.yaml` | BFF boundary enforcement rules |
| `.checkov.yaml` | IaC security policies for Terraform/Docker/K8s |
| `.hadolint.yaml` | Dockerfile security linting |
| `security-scan.yml` | GitHub Actions workflow with SARIF integration |

## Tool Stack (100% Free & Open Source)

| Category | Tool | License |
|----------|------|---------|
| Secret Detection | Gitleaks | MIT |
| Python SAST | Bandit | Apache 2.0 |
| Multi-lang SAST | Semgrep | LGPL 2.1 |
| Container Scanning | Trivy | Apache 2.0 |
| IaC Security | Checkov | Apache 2.0 |
| Dockerfile Linting | Hadolint | GPL 3.0 |
| Dependency Scanning | pip-audit, npm audit | Apache 2.0, Built-in |

## Rule ↔ Tool Mapping

| Security Requirement | Enforcing Tool |
|---------------------|----------------|
| No direct DB access in frontend | Semgrep `bff-no-frontend-database` |
| No service credentials in frontend | Semgrep + Gitleaks |
| No child_process in frontend | Semgrep `bff-no-frontend-child-process` |
| No eval/Function in frontend | Semgrep `bff-no-frontend-eval` |
| Distroless base images | Hadolint + Trivy |
| Read-only filesystem | Checkov |
| Non-root container user | Hadolint `DL3002` |
| Network policy default-deny | Checkov |

## Files in This Skill

- `README.md` - This file
- `installation.md` - Detailed setup instructions
- `commands.md` - Quick reference for all tools
- `assume-breach-checklist.md` - Threat → Tool → Response mapping
- `incident-response.md` - Runbook template
- `config/` - Ready-to-use configuration files
- `workflows/` - GitHub Actions workflows

## When to Use This Skill

- Setting up security scanning for a new project
- Adding security checks to CI/CD pipeline
- Enforcing BFF security boundaries
- Responding to security incidents
- Auditing existing security posture

## Related

- **GCP Operations**: `~/.codex/skills/gcp-operations/` - Deployment and secrets management
