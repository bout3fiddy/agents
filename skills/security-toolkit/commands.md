# Security Toolkit Commands

Quick reference for all security tools in this skill.

## Secret Detection

### Gitleaks

```bash
# Scan current directory
gitleaks detect --source . --verbose

# Scan with custom config
gitleaks detect --source . --config .gitleaks.toml

# Scan specific commit range
gitleaks detect --source . --log-opts="HEAD~10..HEAD"

# Protect staged changes (pre-commit)
gitleaks protect --staged

# Generate report
gitleaks detect --source . --report-format json --report-path gitleaks-report.json
```

### detect-secrets

```bash
# Create baseline
detect-secrets scan > .secrets.baseline

# Audit baseline (interactive)
detect-secrets audit .secrets.baseline

# Scan against baseline
detect-secrets scan --baseline .secrets.baseline

# Update baseline with new files
detect-secrets scan --baseline .secrets.baseline --update .secrets.baseline
```

## Python SAST

### Bandit

```bash
# Scan apps directory
poetry run bandit -r apps/ -c pyproject.toml

# Scan with specific severity
poetry run bandit -r apps/ -ll  # High severity only

# Generate SARIF report
poetry run bandit -r apps/ -f sarif -o bandit-results.sarif

# Exclude directories
poetry run bandit -r apps/ --exclude ./tests,./migrations

# List all plugins
poetry run bandit --list
```

### Semgrep

```bash
# Run with auto config (uses Semgrep registry)
poetry run semgrep --config=auto apps/

# Run with local rules
poetry run semgrep --config .semgrep/ apps/

# Run specific rule
poetry run semgrep --config .semgrep/bff-security.yaml apps/frontend/src/

# Generate SARIF
poetry run semgrep --config .semgrep/ --sarif --output semgrep.sarif apps/

# Verbose output with timing
poetry run semgrep --config .semgrep/ --verbose --time apps/

# Test rules against a file
poetry run semgrep --config .semgrep/ --test apps/frontend/src/example.ts
```

## Dependency Scanning

### pip-audit

```bash
# Audit installed packages
poetry run pip-audit

# Audit from poetry.lock
poetry run pip-audit

# JSON output
poetry run pip-audit --format json --output pip-audit.json

# Strict mode (fail on any vulnerability)
poetry run pip-audit --strict

# Ignore specific vulnerabilities
poetry run pip-audit --ignore-vuln PYSEC-2023-XXX
```

### npm audit

```bash
# Audit dependencies
npm audit

# JSON output
npm audit --json > npm-audit.json

# Audit only production dependencies
npm audit --omit=dev

# Fix vulnerabilities automatically
npm audit fix

# Force fix (may break things)
npm audit fix --force
```

## Container Security

### Trivy

```bash
# Scan Docker image
trivy image myapp:latest

# Scan filesystem
trivy fs .

# Scan with specific scanners
trivy fs . --scanners vuln,secret,misconfig

# Generate SARIF
trivy image myapp:latest --format sarif --output trivy.sarif

# Fail on specific severity
trivy image myapp:latest --exit-code 1 --severity CRITICAL,HIGH

# Ignore unfixed vulnerabilities
trivy image myapp:latest --ignore-unfixed

# Scan Dockerfile
trivy config Dockerfile
```

### Hadolint

```bash
# Lint Dockerfile
hadolint Dockerfile

# Lint with config
hadolint Dockerfile --config .hadolint.yaml

# JSON output
hadolint Dockerfile --format json

# Ignore specific rules
hadolint Dockerfile --ignore DL3008 --ignore DL3013

# Lint multiple Dockerfiles
hadolint deploy/Dockerfile.*
```

## IaC Security

### Checkov

```bash
# Scan current directory
poetry run checkov -d .

# Scan with config
poetry run checkov -d . --config-file .checkov.yaml

# Scan specific framework
poetry run checkov -d . --framework terraform,dockerfile

# Generate SARIF
poetry run checkov -d . -o sarif > checkov.sarif

# Skip specific checks
poetry run checkov -d . --skip-check CKV_DOCKER_2,CKV_DOCKER_3

# List all checks
poetry run checkov --list
```

## Pre-commit

```bash
# Install hooks
poetry run pre-commit install

# Run on all files
poetry run pre-commit run --all-files

# Run specific hook
poetry run pre-commit run gitleaks --all-files
poetry run pre-commit run bandit --all-files
poetry run pre-commit run semgrep --all-files

# Update hook versions
poetry run pre-commit autoupdate

# Clean cache
poetry run pre-commit clean

# Skip hooks (emergency only!)
git commit --no-verify
```

## GitHub Actions (Local Testing)

### act (local GitHub Actions runner)

```bash
# Install act
brew install act

# Run security workflow
act -W .github/workflows/security-scan.yml

# Run with secrets
act -W .github/workflows/security-scan.yml --secret-file .secrets

# List available jobs
act -l
```

## Combined Scans

### Full Security Scan (Local)

```bash
#!/bin/bash
# full-security-scan.sh

echo "=== Secret Detection ==="
gitleaks detect --source . --config .gitleaks.toml

echo "=== Python SAST ==="
poetry run bandit -r apps/ -c pyproject.toml
poetry run semgrep --config .semgrep/ apps/

echo "=== Dependency Scan ==="
poetry run pip-audit
cd apps/frontend && npm audit && cd ../..

echo "=== Dockerfile Lint ==="
hadolint deploy/Dockerfile.* --config .hadolint.yaml

echo "=== IaC Scan ==="
poetry run checkov -d . --config-file .checkov.yaml --quiet

echo "=== Done ==="
```

### Quick Pre-Push Check

```bash
#!/bin/bash
# pre-push-check.sh

# Fast checks only
gitleaks protect --staged
poetry run bandit -r apps/ -ll --quiet
poetry run semgrep --config .semgrep/ --quiet apps/frontend/src/
```

## Troubleshooting

### Semgrep Issues

```bash
# Clear cache
poetry run semgrep --clear-cache

# Debug mode
poetry run semgrep --debug --config .semgrep/ apps/

# Validate rules
poetry run semgrep --validate --config .semgrep/
```

### Gitleaks Issues

```bash
# Verbose mode
gitleaks detect --source . --verbose --log-level debug

# Create allowlist from report
gitleaks detect --source . --report-format json | jq '.[] | .Secret' > allowlist.txt
```

### Trivy Issues

```bash
# Update vulnerability database
trivy image --download-db-only

# Clear cache
trivy --clear-cache

# Debug mode
trivy image myapp:latest --debug
```
