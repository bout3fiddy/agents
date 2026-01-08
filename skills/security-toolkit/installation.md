# Security Toolkit Installation Guide

Complete setup instructions for all security tools.

## Prerequisites

- Python 3.10+
- Node.js 18+
- Docker (for container scanning)
- Homebrew (macOS) or apt (Linux)

## Quick Install (All Tools)

### macOS

```bash
# Install Homebrew packages
brew install gitleaks hadolint trivy

# Install Python tools (dev dependencies)
poetry add --group dev pre-commit bandit semgrep pip-audit detect-secrets checkov

# Setup pre-commit hooks
poetry run pre-commit install
```

### Linux (Ubuntu/Debian)

```bash
# Gitleaks
wget https://github.com/gitleaks/gitleaks/releases/download/v8.21.2/gitleaks_8.21.2_linux_x64.tar.gz
tar -xzf gitleaks_8.21.2_linux_x64.tar.gz
sudo mv gitleaks /usr/local/bin/

# Hadolint
wget https://github.com/hadolint/hadolint/releases/download/v2.12.0/hadolint-Linux-x86_64
chmod +x hadolint-Linux-x86_64
sudo mv hadolint-Linux-x86_64 /usr/local/bin/hadolint

# Trivy
wget https://github.com/aquasecurity/trivy/releases/download/v0.56.2/trivy_0.56.2_Linux-64bit.tar.gz
tar -xzf trivy_0.56.2_Linux-64bit.tar.gz
sudo mv trivy /usr/local/bin/

# Python tools (dev dependencies)
poetry add --group dev pre-commit bandit semgrep pip-audit detect-secrets checkov

# Setup pre-commit hooks
poetry run pre-commit install
```

## Individual Tool Setup

### 1. Pre-commit Framework

```bash
# Install
poetry add --group dev pre-commit

# Copy config to project root
cp ~/.codex/skills/security-toolkit/config/.pre-commit-config.yaml .

# Install hooks
poetry run pre-commit install

# Verify
poetry run pre-commit run --all-files
```

### 2. Gitleaks (Secret Detection)

```bash
# macOS
brew install gitleaks

# Linux
curl -sSL https://github.com/gitleaks/gitleaks/releases/download/v8.21.2/gitleaks_8.21.2_linux_x64.tar.gz | tar xz
sudo mv gitleaks /usr/local/bin/

# Copy config
cp ~/.codex/skills/security-toolkit/config/.gitleaks.toml .

# Verify
gitleaks version
gitleaks detect --source . --config .gitleaks.toml --verbose
```

### 3. Bandit (Python SAST)

```bash
# Install
poetry add --group dev bandit

# Add to pyproject.toml (if not already present)
# [tool.bandit]
# exclude_dirs = ["tests", "migrations", ".venv", "node_modules"]
# skips = ["B101"]  # Skip assert_used in tests

# Verify
poetry run bandit -r apps/ -c pyproject.toml
```

### 4. Semgrep (Multi-language SAST)

```bash
# Install
poetry add --group dev semgrep

# Copy BFF security rules
cp -r ~/.codex/skills/security-toolkit/config/.semgrep .

# Verify
poetry run semgrep --validate --config .semgrep/
poetry run semgrep --config .semgrep/ apps/frontend/src/
```

### 5. Trivy (Container Scanning)

```bash
# macOS
brew install trivy

# Linux
curl -sSL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /usr/local/bin

# Verify
trivy version
trivy fs . --scanners vuln,secret
```

### 6. Hadolint (Dockerfile Linting)

```bash
# macOS
brew install hadolint

# Linux
wget https://github.com/hadolint/hadolint/releases/download/v2.12.0/hadolint-Linux-x86_64
chmod +x hadolint-Linux-x86_64
sudo mv hadolint-Linux-x86_64 /usr/local/bin/hadolint

# Copy config
cp ~/.codex/skills/security-toolkit/config/.hadolint.yaml .

# Verify
hadolint deploy/Dockerfile.* --config .hadolint.yaml
```

### 7. Checkov (IaC Security)

```bash
# Install
poetry add --group dev checkov

# Copy config
cp ~/.codex/skills/security-toolkit/config/.checkov.yaml .

# Verify
poetry run checkov -d . --config-file .checkov.yaml --list
poetry run checkov -d . --config-file .checkov.yaml
```

### 8. pip-audit (Python Dependencies)

```bash
# Install
poetry add --group dev pip-audit

# Verify
poetry run pip-audit --desc
```

### 9. detect-secrets (Baseline Secret Management)

```bash
# Install
poetry add --group dev detect-secrets

# Create baseline
poetry run detect-secrets scan > .secrets.baseline

# Audit baseline (mark false positives)
poetry run detect-secrets audit .secrets.baseline
```

## GitHub Actions Setup

```bash
# Copy workflow
mkdir -p .github/workflows
cp ~/.codex/skills/security-toolkit/workflows/security-scan.yml .github/workflows/

# Commit and push
git add .github/workflows/security-scan.yml
git commit -m "Add security scanning workflow"
git push
```

## Verification Checklist

After installation, verify each tool:

```bash
# Pre-commit
pre-commit --version

# Gitleaks
gitleaks version

# Bandit
bandit --version

# Semgrep
semgrep --version

# Trivy
trivy version

# Hadolint
hadolint --version

# Checkov
checkov --version

# pip-audit
pip-audit --version

# detect-secrets
detect-secrets --version
```

## Troubleshooting

### "Command not found"

Ensure tools are in your PATH:

```bash
export PATH="$PATH:/usr/local/bin"
```

### Pre-commit hooks not running

```bash
# Reinstall hooks
poetry run pre-commit uninstall
poetry run pre-commit install

# Clear cache
poetry run pre-commit clean
```

### Semgrep timeout

```bash
# Increase timeout
poetry run semgrep --config .semgrep/ --timeout 300 apps/
```

### Trivy slow on first run

First run downloads vulnerability database (~300MB):

```bash
# Pre-download
trivy image --download-db-only
```

## IDE Integration

### VS Code

Install extensions:
- **Semgrep** - Real-time SAST feedback
- **Hadolint** - Dockerfile linting
- **Python** - Bandit integration via settings

Add to `.vscode/settings.json`:

```json
{
  "python.linting.banditEnabled": true,
  "python.linting.banditArgs": ["-c", "pyproject.toml"]
}
```

### JetBrains (PyCharm, WebStorm)

- **File Watchers** - Run tools on save
- **External Tools** - Add security scan commands
