---
name: ios-debugger-agent
description: Use XcodeBuildMCP to build, run, launch, and debug the current iOS project on a booted simulator. Trigger when asked to run an iOS app, interact with the simulator UI, inspect on-screen state, capture logs/console output, or diagnose runtime behavior using XcodeBuildMCP tools.
metadata:
  version: "1.0.0"
---

# iOS Debugger Agent

## Overview

Use XcodeBuildMCP to build and run the current project scheme on a booted iOS simulator, interact with the UI, and capture logs. Prefer the MCP tools for simulator control, logs, and view inspection.

---

## Core Workflow

Follow this sequence unless the user asks for a narrower action.

### 1) Discover the booted simulator

- Call `mcp__XcodeBuildMCP__list_sims` and select the simulator with state `Booted`.
- If none are booted, ask the user to boot one (do not boot automatically unless asked).

### 2) Set session defaults

- Call `mcp__XcodeBuildMCP__session-set-defaults` with:
  - `projectPath` or `workspacePath` (whichever the repo uses)
  - `scheme` for the current app
  - `simulatorId` from the booted device
  - Optional: `configuration: "Debug"`, `useLatestOS: true`

### 3) Build + run (when requested)

- Call `mcp__XcodeBuildMCP__build_run_sim`.
- If the app is already built and only launch is requested, use `mcp__XcodeBuildMCP__launch_app_sim`.
- If bundle id is unknown:
  1. `mcp__XcodeBuildMCP__get_sim_app_path`
  2. `mcp__XcodeBuildMCP__get_app_bundle_id`

---

## UI Interaction & Debugging

Use these when asked to inspect or interact with the running app.

| Action | MCP Tool | Notes |
|--------|----------|-------|
| Describe UI | `mcp__XcodeBuildMCP__describe_ui` | Run before tapping or swiping |
| Tap | `mcp__XcodeBuildMCP__tap` | Prefer `id` or `label`; use coordinates only if needed |
| Type | `mcp__XcodeBuildMCP__type_text` | After focusing a field |
| Gestures | `mcp__XcodeBuildMCP__gesture` | For common scrolls and edge swipes |
| Screenshot | `mcp__XcodeBuildMCP__screenshot` | For visual confirmation |

### Interaction Flow

```
1. describe_ui → Understand current screen
2. tap/type/gesture → Perform interaction
3. describe_ui → Verify result
4. screenshot → Visual confirmation (optional)
```

---

## Logs & Console Output

### Start capturing logs

```
mcp__XcodeBuildMCP__start_sim_log_cap
```

Parameters:
- `bundleId`: The app's bundle identifier

### Stop and retrieve logs

```
mcp__XcodeBuildMCP__stop_sim_log_cap
```

Summarize important lines from the captured output.

### Console output

For console output, set `captureConsole: true` and relaunch if required.

---

## Common Scenarios

### Build and Run Fresh

1. `list_sims` → Get booted simulator
2. `session-set-defaults` → Configure project/scheme/simulator
3. `build_run_sim` → Build and launch

### Debug a Crash

1. `start_sim_log_cap` → Begin capturing
2. Reproduce the crash
3. `stop_sim_log_cap` → Get logs
4. Analyze crash logs for stack trace

### UI Testing Flow

1. `describe_ui` → Get current state
2. `tap` on element → Interact
3. `describe_ui` → Verify change
4. `screenshot` → Document state

### Check Network Requests

1. `start_sim_log_cap` with network subsystem filter
2. Trigger network action in app
3. `stop_sim_log_cap` → Analyze requests

---

## Troubleshooting

### Build fails

- Verify scheme name matches exactly
- Check if workspace vs project path is correct
- Try with `preferXcodebuild: true` for complex setups

### Wrong app launches

- Confirm scheme name
- Get bundle ID with `get_app_bundle_id`
- Verify simulator ID is correct

### UI elements not hittable

- Re-run `describe_ui` after layout changes
- Check if element is off-screen
- Verify accessibility is enabled

### No logs captured

- Ensure bundle ID is correct
- Check if app is actually running
- Try with broader subsystem filter

---

## Quick Reference

### Essential Commands

```
# List simulators
mcp__XcodeBuildMCP__list_sims

# Set defaults
mcp__XcodeBuildMCP__session-set-defaults
  projectPath: /path/to/Project.xcodeproj
  scheme: MyApp
  simulatorId: <UUID>

# Build and run
mcp__XcodeBuildMCP__build_run_sim

# Just launch (already built)
mcp__XcodeBuildMCP__launch_app_sim
  bundleId: com.example.MyApp

# UI inspection
mcp__XcodeBuildMCP__describe_ui

# Tap element
mcp__XcodeBuildMCP__tap
  element: "Button Title" | id: "accessibilityId" | x: 100, y: 200

# Type text
mcp__XcodeBuildMCP__type_text
  text: "Hello World"

# Screenshot
mcp__XcodeBuildMCP__screenshot

# Start logs
mcp__XcodeBuildMCP__start_sim_log_cap
  bundleId: com.example.MyApp

# Stop logs
mcp__XcodeBuildMCP__stop_sim_log_cap
```

### Gesture Types

- `scroll_up` / `scroll_down`
- `scroll_left` / `scroll_right`
- `swipe_from_edge_left` / `swipe_from_edge_right`
- `pinch_in` / `pinch_out`
- `long_press`

---

## Notes

- Always run `describe_ui` before interacting to understand current state
- Use accessibility labels/identifiers over coordinates when possible
- Logs are most useful in Debug configuration
- Screenshots help document test scenarios
