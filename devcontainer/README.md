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
- tools: git, jq, ripgrep, fd, zoxide, tmux, fish, zsh, vim + CLIs (gh, docker cli, bun, lsof, psql, gcloud)
- agents: claude-code + codex cli (latest), agent-browser
- python: uv + a managed python (currently 3.14); ruff/pytest/mypy/prek/takopi installed on first container start
- networking: no firewall / restrictions (internet enabled)
- permissions: passwordless sudo for the `node` user

## container behavior

- default user is `node`; default shell is fish (zsh/bash available)
- tmux config is installed on first run; tmux session name is `agent`
- command history persists via a docker volume for bash/zsh/fish
- claude/codex/takopi state is bind-mounted from your host `~/.claude`, `~/.codex`, and `~/.takopi`
- `codex` / `claude` aliases are installed (`codexxx`, `clod`)
- `postCreateCommand` runs `uv` to apply defaults and ensure ownerships
- MCP startup can be suppressed per session with `DEVC_DISABLE_MCP_SERVERS` in container env (comma/space/semi-colon separated, values like `sentry` and `linear`) to avoid browser-auth-dependent startup in headless containers.

## mounts and ports

- `/workspace` binds your repo (delegated)
- `/commandhistory` is a named docker volume
- `~/.claude`, `~/.codex`, and `~/.takopi` are bind-mounted from the host
- gh config stored in a docker volume
- host services are reachable at `http://host.docker.internal:<port>`
- common local ports forwarded: 3000, 3100, 8000, 8001, 8002, 8082, 54321, 54322

## native deps and shared node_modules

Because `/workspace` is a bind mount from your host, any existing `node_modules` are shared across macOS and Linux.
Native deps are OS/arch-specific (darwin vs linux), so installs on the host can break inside the container and vice
versa. This template isolates `node_modules` inside the container using Docker volumes by default.

When you run `devc install`, we auto-detect workspace packages from your root `package.json` (`workspaces`) and/or
`pnpm-workspace.yaml` and inject matching `node_modules` volume mounts into `.devcontainer/devcontainer.json`.
This keeps monorepo installs isolated without hardcoding app names. To opt out: `DEVC_SKIP_WORKSPACE_MOUNTS=1 devc install <repo>`
(or the legacy `DEVC_SKIP_APP_MOUNTS=1`).

Optional (recommended) for Python: keep the container venv isolated too (included by default) and outside the repo.

```json
"mounts": [
  "... existing mounts ...",
  "source=${localWorkspaceFolderBasename}-venv,target=/home/node/.venv,type=volume"
]
```

After first enablement (volumes are empty), rebuild the container and reinstall deps inside it (`bun install` per package).

## accessing host services (important)

- inside the container, `localhost`/`127.0.0.1` refers to the container, not your host
- use `http://host.docker.internal:<port>` for host dev servers and APIs
- if a dev server blocks that hostname (e.g., Vite), allow it:

```ts
// vite.config.ts
export default defineConfig({
  server: {
    allowedHosts: ["host.docker.internal"],
  },
});
```

## devcontainer json highlights

- adds `host.docker.internal` via `--add-host=host-gateway`
- uses `remoteUser: node`
- vscode extensions: `anthropic.claude-code`, `openai.chatgpt`
- terminal profile defaults to fish

## notes

- **overwrites `.devcontainer/`** on every run
- `devc rebuild` clears build cache but keeps named volumes (history/auth)
