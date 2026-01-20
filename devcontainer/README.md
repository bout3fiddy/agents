# autonomous coding sandbox

a devcontainer for running claude code and codex in yolo mode.

based on: https://github.com/banteg/agents/tree/master/devcontainer
devcontainer scripts are adapted from banteg's agents template.

## requirements

- docker (or [orbstack](https://orbstack.dev/))
- devcontainer cli (`npm install -g @devcontainers/cli`)

## quickstart

install `./devcontainer/install.sh self-install`

run `devc <repo>` or `devc .` inside project folder.

you're now in tmux with claude and codex ready to go, with permissions preconfigured.
agent-browser is installed globally and ships with a managed chromium download.

to use with vscode, run `devc install <repo>` and choose "reopen in container" in the editor.
the built in terminal would login inside the container.

## what's inside

- base image: ubuntu 25.10 + node from `node:22-bookworm-slim`
- tools: git, gh, jq, ripgrep, fd, zoxide, tmux, fish, zsh, vim
- agents: claude-code + codex cli (latest), agent-browser
- python: uv + a managed python (currently 3.14) preinstalled
- networking: no firewall / restrictions (internet enabled)
- permissions: passwordless sudo for the `node` user

## container behavior

- default user is `node`; default shell is fish (zsh/bash available)
- tmux config is installed on first run; tmux session name is `agent`
- command history persists via a docker volume for bash/zsh/fish
- claude/codex state is bind-mounted from your host `~/.claude` and `~/.codex`
- `codex` / `claude` aliases are installed (`codexxx`, `clod`)
- `postCreateCommand` runs `uv` to apply defaults and ensure ownerships

## mounts and ports

- `/workspace` binds your repo (delegated)
- `/commandhistory` is a named docker volume
- `~/.claude` and `~/.codex` are bind-mounted from the host
- gh config stored in a docker volume
- host services are reachable at `http://host.docker.internal:<port>`

## devcontainer json highlights

- adds `host.docker.internal` via `--add-host=host-gateway`
- uses `remoteUser: node`
- vscode extensions: `anthropic.claude-code`, `openai.chatgpt`
- terminal profile defaults to fish

## notes

- **overwrites `.devcontainer/`** on every run
- `devc rebuild` clears build cache but keeps named volumes (history/auth)
