#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE' >&2
devcontainer helper for this template.

usage:
  devc <repo>            install template, devcontainer up, then tmux
  devc install <repo>    install template only
  devc rebuild <repo>    clear build cache, then up + tmux
  devc exec <repo> -- <cmd>
  devc self-install      install devc + template into ~/.local

notes:
  - install and default run overwrite .devcontainer in the target repo
  - rebuild keeps named volumes (history, auth) intact
  - if devcontainer cli is missing, we suggest how to install it
  - set DEVC_TEMPLATE_DIR to override the template source
  - set DEVC_TMUX_SESSION to override the tmux session name (default: agent)
  - set DEVC_TMUX_SESSION_MODE=reuse to reuse a single session per repo (default: new)
USAGE
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_FILES=(Dockerfile devcontainer.json post_install.py)

die() {
  echo "error: $*" >&2
  exit 1
}

ensure_host_state_dirs() {
  mkdir -p "$HOME/.claude" "$HOME/.codex" "$HOME/.takopi"
}

ensure_repo() {
  local repo_path="$1"
  [[ -d "$repo_path" ]] || die "repo path does not exist or is not a directory: $repo_path"
}

find_template_dir() {
  if [[ -n "${DEVC_TEMPLATE_DIR:-}" && -d "$DEVC_TEMPLATE_DIR" ]]; then
    echo "$DEVC_TEMPLATE_DIR"
    return
  fi

  if [[ -f "$SCRIPT_DIR/Dockerfile" && -f "$SCRIPT_DIR/devcontainer.json" ]]; then
    echo "$SCRIPT_DIR"
    return
  fi

  if [[ -d "$HOME/.local/share/devc/template" ]]; then
    echo "$HOME/.local/share/devc/template"
    return
  fi

  die "template dir not found (set DEVC_TEMPLATE_DIR or run devc self-install)"
}

find_python() {
  if command -v python3 >/dev/null 2>&1; then
    echo "python3"
    return
  fi
  if command -v python >/dev/null 2>&1; then
    echo "python"
    return
  fi
  echo ""
}

path_has_dir() {
  local dir="$1"
  case ":${PATH:-}:" in
    *":$dir:"*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

path_hint() {
  local bin_dir="$1"
  local shell_name
  local rc_file=""
  local line="export PATH=\"$bin_dir:\$PATH\""

  shell_name="$(basename "${SHELL:-}")"
  case "$shell_name" in
    zsh)
      rc_file="$HOME/.zshrc"
      ;;
    bash)
      if [[ -f "$HOME/.bashrc" ]]; then
        rc_file="$HOME/.bashrc"
      else
        rc_file="$HOME/.bash_profile"
      fi
      ;;
    fish)
      rc_file="$HOME/.config/fish/config.fish"
      line="set -gx PATH $bin_dir \$PATH"
      ;;
  esac

  echo "note: $bin_dir is not on your PATH." >&2
  if [[ -n "$rc_file" ]]; then
    echo "      add this line to $rc_file:" >&2
  else
    echo "      add this line to your shell config:" >&2
  fi
  echo "      $line" >&2
}

sync_workspace_mounts() {
  local repo_path="$1"
  local devcontainer_json="$2"
  local skip_app_mounts="false"
  local python_bin

  if [[ "${DEVC_SKIP_WORKSPACE_MOUNTS:-}" =~ ^(1|true|yes)$ || "${DEVC_SKIP_APP_MOUNTS:-}" =~ ^(1|true|yes)$ ]]; then
    skip_app_mounts="true"
  fi

  python_bin="$(find_python)"
  if [[ -z "$python_bin" ]]; then
    echo "warning: python not found; skipping devcontainer mount sync" >&2
    return
  fi

  "$python_bin" - "$repo_path" "$devcontainer_json" "$skip_app_mounts" <<'PY'
import json
import os
import re
import sys
from pathlib import Path
import ast

repo_path = Path(sys.argv[1])
json_path = Path(sys.argv[2])
skip_app_mounts = sys.argv[3].lower() == "true"

if skip_app_mounts:
    sys.exit(0)

try:
    with json_path.open(encoding="utf-8") as handle:
        data = json.load(handle)
except (OSError, json.JSONDecodeError):
    sys.exit(0)

mounts = data.get("mounts")
if not isinstance(mounts, list):
    sys.exit(0)

def parse_mount(entry):
    parts = entry.split(",")
    values = {}
    for part in parts:
        if "=" not in part:
            continue
        key, value = part.split("=", 1)
        values[key] = value
    return values

def is_managed_mount(entry):
    if not isinstance(entry, str):
        return False
    values = parse_mount(entry)
    source = values.get("source", "")
    target = values.get("target", "")
    if not target.startswith("/workspace/"):
        return False
    if target == "/workspace/node_modules":
        return False
    if not target.endswith("/node_modules"):
        return False
    if not source.startswith("${localWorkspaceFolderBasename}-"):
        return False
    if not source.endswith("-node_modules"):
        return False
    return True

def slugify(value):
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-")

def read_package_json_workspaces(path):
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    workspaces = data.get("workspaces")
    if isinstance(workspaces, list):
        return [item for item in workspaces if isinstance(item, str)]
    if isinstance(workspaces, dict):
        packages = workspaces.get("packages")
        if isinstance(packages, list):
            return [item for item in packages if isinstance(item, str)]
    return []

def read_pnpm_workspaces(path):
    if not path.exists():
        return []
    patterns = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    in_packages = False
    base_indent = 0
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if not in_packages:
            if stripped.startswith("packages:"):
                in_packages = True
                base_indent = len(line) - len(line.lstrip())
                inline = stripped[len("packages:"):].strip()
                if inline:
                    if inline.startswith("[") and inline.endswith("]"):
                        try:
                            value = ast.literal_eval(inline)
                        except Exception:
                            value = None
                        if isinstance(value, list):
                            for item in value:
                                if isinstance(item, str):
                                    patterns.append(item)
                    else:
                        if (inline.startswith("'") and inline.endswith("'")) or (inline.startswith('"') and inline.endswith('"')):
                            inline = inline[1:-1]
                        if inline:
                            patterns.append(inline)
                continue
        else:
            indent = len(line) - len(line.lstrip())
            if indent <= base_indent:
                in_packages = False
                continue
            if stripped.startswith("-"):
                item = stripped[1:].strip()
                if (item.startswith("'") and item.endswith("'")) or (item.startswith('"') and item.endswith('"')):
                    item = item[1:-1]
                if item:
                    patterns.append(item)
    return patterns

def normalize_pattern(pattern):
    normalized = pattern.strip()
    if normalized.startswith("./"):
        normalized = normalized[2:]
    return normalized

def collect_workspace_targets(root, patterns):
    includes = []
    excludes = []
    for raw in patterns:
        normalized = normalize_pattern(raw)
        if not normalized:
            continue
        if normalized.startswith("!"):
            exclude = normalized[1:].strip()
            if exclude:
                excludes.append(exclude)
        else:
            includes.append(normalized)

    if not includes:
        return []

    candidates = set()
    for pattern in includes:
        for match in root.glob(pattern):
            if match.is_file() and match.name == "package.json":
                match = match.parent
            if match.is_dir():
                candidates.add(match)

    if excludes:
        excluded = set()
        for pattern in excludes:
            for match in root.glob(pattern):
                if match.is_file() and match.name == "package.json":
                    match = match.parent
                if match.is_dir():
                    excluded.add(match)
        candidates -= excluded

    results = []
    for path in candidates:
        if "node_modules" in path.parts:
            continue
        if not (path / "package.json").exists():
            continue
        try:
            rel = path.relative_to(root).as_posix()
        except ValueError:
            continue
        if not rel or rel == ".":
            continue
        results.append(rel)
    return sorted(set(results))

patterns = []
if not skip_app_mounts:
    patterns.extend(read_package_json_workspaces(repo_path / "package.json"))
    patterns.extend(read_pnpm_workspaces(repo_path / "pnpm-workspace.yaml"))
    patterns.extend(read_pnpm_workspaces(repo_path / "pnpm-workspace.yml"))

targets = collect_workspace_targets(repo_path, patterns) if patterns else []

targets = sorted(set(targets))

base_mounts = [entry for entry in mounts if not is_managed_mount(entry)]
app_mounts = []
for rel in targets:
    slug = slugify(rel)
    if not slug:
        continue
    source = f"${{localWorkspaceFolderBasename}}-{slug}-node_modules"
    target = f"/workspace/{rel}/node_modules"
    entry = f"source={source},target={target},type=volume"
    if entry not in base_mounts:
        app_mounts.append(entry)

updated = base_mounts + app_mounts
if updated == mounts:
    sys.exit(0)

data["mounts"] = updated
with json_path.open("w", encoding="utf-8") as handle:
    json.dump(data, handle, indent=2)
    handle.write("\n")
PY
}

copy_template() {
  local repo_path="$1"
  local src_dir="$2"
  local dest_dir="$repo_path/.devcontainer"

  ensure_host_state_dirs
  mkdir -p "$dest_dir"

  for f in "${TEMPLATE_FILES[@]}"; do
    [[ -f "$src_dir/$f" ]] || die "missing template file: $src_dir/$f"
    cp -f "$src_dir/$f" "$dest_dir/$f"
  done

  local global_ignore=""
  if command -v git >/dev/null 2>&1; then
    global_ignore="$(git config --global --path core.excludesfile 2>/dev/null || true)"
  fi

  if [[ -z "$global_ignore" ]]; then
    if [[ -n "${XDG_CONFIG_HOME:-}" && -f "$XDG_CONFIG_HOME/git/ignore" ]]; then
      global_ignore="$XDG_CONFIG_HOME/git/ignore"
    elif [[ -f "$HOME/.config/git/ignore" ]]; then
      global_ignore="$HOME/.config/git/ignore"
    elif [[ -f "$HOME/.gitignore_global" ]]; then
      global_ignore="$HOME/.gitignore_global"
    fi
  fi

  if [[ -n "$global_ignore" && -f "$global_ignore" ]]; then
    cp -f "$global_ignore" "$dest_dir/.gitignore_global"
    echo "  copied global gitignore from $global_ignore" >&2
  fi

  sync_workspace_mounts "$repo_path" "$dest_dir/devcontainer.json"

  echo "✓ devcontainer installed to: $dest_dir" >&2
}

require_devcontainer_cli() {
  if ! command -v devcontainer >/dev/null 2>&1; then
    echo "error: devcontainer cli not found" >&2
    echo "hint: npm install -g @devcontainers/cli" >&2
    exit 1
  fi
}

tmux_session_name() {
  if [[ -n "${DEVC_TMUX_SESSION:-}" ]]; then
    echo "$DEVC_TMUX_SESSION"
    return
  fi

  if [[ "${DEVC_TMUX_SESSION_MODE:-new}" == "reuse" ]]; then
    echo "agent"
    return
  fi

  echo "agent-$(date +%s)-$$"
}

tmux_attach() {
  local repo_path="$1"
  local session

  session="$(tmux_session_name)"
  devcontainer exec --workspace-folder "$repo_path" tmux new -As "$session"
}

self_install() {
  local bin_dir="$HOME/.local/bin"
  local share_dir="$HOME/.local/share/devc/template"
  local template_src

  template_src="$(find_template_dir)"

  mkdir -p "$bin_dir" "$share_dir"

  cp -f "$SCRIPT_DIR/$(basename -- "$0")" "$bin_dir/devc"
  chmod +x "$bin_dir/devc"

  rm -rf "$share_dir"
  mkdir -p "$share_dir"
  for f in "${TEMPLATE_FILES[@]}"; do
    [[ -f "$template_src/$f" ]] || die "missing template file: $template_src/$f"
    cp -f "$template_src/$f" "$share_dir/$f"
  done

  echo "✓ installed devc to $bin_dir/devc" >&2
  echo "✓ installed template to $share_dir" >&2
  if ! path_has_dir "$bin_dir"; then
    path_hint "$bin_dir"
  fi
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

cmd="$1"
shift

case "$cmd" in
  help|-h|--help)
    usage
    exit 0
    ;;
  self-install)
    self_install
    exit 0
    ;;
  install|rebuild|exec)
    ;;
  *)
    set -- "$cmd" "$@"
    cmd="up"
    ;;
esac

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

REPO_PATH="$1"
shift

ensure_repo "$REPO_PATH"
TEMPLATE_DIR="$(find_template_dir)"

case "$cmd" in
  install)
    copy_template "$REPO_PATH" "$TEMPLATE_DIR"
    exit 0
    ;;
  rebuild)
    copy_template "$REPO_PATH" "$TEMPLATE_DIR"
    require_devcontainer_cli
    devcontainer up --workspace-folder "$REPO_PATH" --remove-existing-container
    tmux_attach "$REPO_PATH"
    ;;
  up)
    copy_template "$REPO_PATH" "$TEMPLATE_DIR"
    require_devcontainer_cli
    devcontainer up --workspace-folder "$REPO_PATH"
    tmux_attach "$REPO_PATH"
    ;;
  exec)
    copy_template "$REPO_PATH" "$TEMPLATE_DIR"
    require_devcontainer_cli
    if [[ $# -gt 0 && "$1" == "--" ]]; then
      shift
    fi
    [[ $# -gt 0 ]] || die "exec requires a command"
    devcontainer exec --workspace-folder "$REPO_PATH" "$@"
    ;;
esac
