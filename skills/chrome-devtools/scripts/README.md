# Chrome DevTools Scripts

Puppeteer CLI scripts for browser automation. All output JSON.

## Setup

```bash
# Linux/WSL only - install system dependencies
./install-deps.sh

# Install Node dependencies
npm install

# Test
node navigate.js --url https://example.com
```

## Scripts

| Script | Purpose |
|--------|---------|
| `navigate.js` | Navigate to URL |
| `screenshot.js` | Capture screenshot |
| `click.js` | Click element |
| `fill.js` | Fill form field |
| `evaluate.js` | Execute JavaScript |
| `snapshot.js` | Extract page elements |
| `console.js` | Monitor console |
| `network.js` | Track requests |
| `performance.js` | Measure vitals |

## Common Options

All scripts support:

| Option | Default | Description |
|--------|---------|-------------|
| `--headless` | `true` | Run headless |
| `--close` | `true` | Close browser after |
| `--timeout` | `30000` | Timeout in ms |
| `--wait-until` | `networkidle2` | Wait strategy |

## Examples

```bash
# Navigate
node navigate.js --url https://example.com

# Screenshot with compression
node screenshot.js --url https://example.com --output page.png

# Element screenshot
node screenshot.js --url https://example.com --output btn.png --selector "button.submit"

# Click and wait for navigation
node click.js --url https://example.com --selector "a.link" --wait-for-navigation

# Fill form (chain commands)
node navigate.js --url https://example.com/login --close false
node fill.js --selector "#email" --value "user@example.com" --close false
node fill.js --selector "#password" --value "example-value" --close false
node click.js --selector "button[type=submit]"

# Execute JavaScript
node evaluate.js --url https://example.com --script "document.title"

# Get page elements
node snapshot.js --url https://example.com | jq '.elements[] | {tagName, selector}'

# Monitor console errors
node console.js --url https://example.com --types error,warn --duration 10000

# Track network requests
node network.js --url https://example.com --duration 5000 --output requests.json

# Performance analysis
node performance.js --url https://example.com --trace trace.json

# With CPU throttling
node performance.js --url https://example.com --throttle-cpu 4

# With network throttling
node performance.js --url https://example.com --throttle-network slow3g
```

## Output Format

Success:
```json
{
  "success": true,
  "url": "https://example.com",
  ...
}
```

Error:
```json
{
  "success": false,
  "error": "Error message"
}
```
