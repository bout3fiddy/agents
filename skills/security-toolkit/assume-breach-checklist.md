# Assume Breach Checklist

Mapping threats to tools and responses for the "Assume Breach" containment strategy.

## Core Principle

**Assume RCE will occur.** Plan for containment, not just prevention.

When a frontend is compromised:
1. Attacker gets code execution in container
2. They attempt lateral movement, persistence, data exfiltration
3. Our containment measures neutralize each attempt

---

## Threat → Tool → Response Matrix

### 1. Initial Compromise Prevention

| Threat | Prevention Tool | Detection Tool | Response |
|--------|-----------------|----------------|----------|
| Hardcoded secrets committed | Gitleaks (pre-commit) | Gitleaks (CI) | Block commit, rotate secret |
| SQL injection | Semgrep (parameterized queries) | Bandit | Fix code pattern |
| XSS/Code injection | Semgrep (eval detection) | ESLint Security | Fix code pattern |
| Vulnerable dependency | pip-audit, npm audit | Trivy | Update dependency |
| Container vulnerability | Trivy | Trivy (CI) | Update base image |

### 2. Credential Theft (If RCE Occurs)

| Attack Vector | Containment Measure | Verification Tool |
|---------------|---------------------|-------------------|
| Read DATABASE_URL from env | Credentials NOT in frontend container | Semgrep rule `bff-no-frontend-service-keys` |
| Read service account key | Service keys NOT in frontend container | Gitleaks custom rules |
| Access GCP metadata | Network policy blocks 169.254.169.254 | Checkov network policy |
| Memory dump for secrets | Secrets never loaded in frontend process | Architecture review |

### 3. Lateral Movement (If RCE Occurs)

| Attack Vector | Containment Measure | Verification Tool |
|---------------|---------------------|-------------------|
| Connect to database | Frontend has NO database credentials | Semgrep BFF rules |
| Call internal APIs | Network policy: only BFF API allowed | Checkov K8s policy |
| Access other containers | Container network isolation | Checkov K8s policy |
| Escalate to host | Non-root user, read-only FS | Hadolint, Checkov |

### 4. Persistence (If RCE Occurs)

| Attack Vector | Containment Measure | Verification Tool |
|---------------|---------------------|-------------------|
| Write malicious file | Read-only root filesystem | Checkov `CKV_K8S_1` |
| Install package | Distroless (no package manager) | Hadolint, Trivy |
| Add cron job | No cron in container | Distroless base |
| Modify container | Immutable container | Cloud Run default |

### 5. Data Exfiltration (If RCE Occurs)

| Attack Vector | Containment Measure | Verification Tool |
|---------------|---------------------|-------------------|
| Exfil to external server | Network policy: egress blocked | Checkov network policy |
| DNS tunneling | DNS only to internal resolver | Network policy |
| Read sensitive data | No database access from frontend | Semgrep BFF rules |
| Access cloud storage | No storage credentials in frontend | Semgrep, Gitleaks |

---

## Pre-Deployment Checklist

### Code Review (Every PR)

- [ ] **Semgrep scan passes** - No BFF boundary violations
- [ ] **Gitleaks scan passes** - No secrets in code
- [ ] **Bandit scan passes** - No Python security issues
- [ ] **No new dependencies** without security review
- [ ] **No env vars** accessing secrets in frontend

### Container Build (Every Deploy)

- [ ] **Trivy scan passes** - No CRITICAL/HIGH vulnerabilities
- [ ] **Hadolint passes** - Dockerfile follows security best practices
- [ ] **Base image is distroless** - No shell, no package manager
- [ ] **USER is non-root** - Container runs as unprivileged user
- [ ] **No secrets baked in** - All secrets via Secret Manager

### Infrastructure (Every Deploy)

- [ ] **Checkov scan passes** - IaC security policies met
- [ ] **Network policy enforced** - Default deny egress
- [ ] **Read-only filesystem** - Container is immutable
- [ ] **Secret Manager only** - No env var secrets
- [ ] **Service account minimal** - Least privilege IAM

---

## Incident Response Triggers

### Immediate Response Required

| Alert | Action |
|-------|--------|
| Secret detected in commit | Rotate secret immediately, block PR |
| CRITICAL vulnerability in prod image | Patch and redeploy within 24h |
| Unusual outbound network traffic | Investigate, consider container restart |
| Unexpected process in container | Terminate container, investigate |

### Investigation Required

| Alert | Action |
|-------|--------|
| HIGH vulnerability in prod image | Assess exploitability, plan patch |
| Semgrep rule violation in PR | Review change, require fix |
| Failed auth attempts spike | Review logs, check for brute force |

---

## Verification Commands

### Quick Security Check

```bash
# Run all pre-commit hooks
poetry run pre-commit run --all-files

# Scan for secrets
gitleaks detect --source . --verbose

# Python SAST
poetry run bandit -r apps/ -c pyproject.toml

# BFF boundary check
poetry run semgrep --config .semgrep/bff-security.yaml apps/frontend/src/
```

### Container Security Check

```bash
# Build and scan
docker build -t myapp:latest -f deploy/Dockerfile.frontend .
trivy image myapp:latest --severity CRITICAL,HIGH

# Dockerfile lint
hadolint deploy/Dockerfile.* --config .hadolint.yaml
```

### Full Security Audit

```bash
# All scans
poetry run pre-commit run --all-files
poetry run pip-audit
npm audit --prefix apps/frontend
trivy fs . --scanners vuln,secret,misconfig
poetry run checkov -d . --config-file .checkov.yaml
```

---

## Monthly Security Review

1. **Dependency updates** - Run `pip-audit` and `npm audit`, update packages
2. **Base image updates** - Check for new distroless versions
3. **Rule updates** - Update Semgrep, Gitleaks, Trivy databases
4. **Access review** - Audit IAM permissions, rotate keys if needed
5. **Incident review** - Review any security events from past month

---

## Architecture Validation

```
Correct Architecture (Assume Breach Ready):

[Internet] → [Frontend Container] → [BFF API] → [Backend] → [Database]
                    │                              │
                    ├─ No DB credentials           ├─ Has DB credentials
                    ├─ No secrets                  ├─ Has secrets
                    ├─ Distroless                  ├─ Can be full image
                    ├─ Read-only FS                ├─ Can write logs
                    ├─ Non-root user               └─ Service account
                    ├─ Egress blocked
                    └─ API calls only

Wrong Architecture (Breach = Game Over):

[Internet] → [Frontend Container] → [Database]
                    │
                    ├─ Has DB credentials ❌
                    ├─ Has secrets ❌
                    └─ Full access ❌
```

---

## Key Metrics

| Metric | Target | Current |
|--------|--------|---------|
| Secrets in frontend code | 0 | Check with Gitleaks |
| CRITICAL vulns in prod | 0 | Check with Trivy |
| HIGH vulns in prod | <5 | Check with Trivy |
| Pre-commit pass rate | 100% | Check CI stats |
| Mean time to patch CRITICAL | <24h | Track incidents |
