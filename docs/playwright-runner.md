# Playwright Runner

The Playwright Runner is a standalone FastAPI service that executes recorded test flows in headless browsers. It provides capabilities beyond what the Chrome extension sandbox allows: multi-browser support, network mocking, device emulation, tracing, video recording, and parallel execution.

## Setup

### Docker (recommended)

```bash
cd backend
docker compose up -d runner
```

### Native (for VPN/IP-restricted sites)

Docker Desktop on macOS runs containers in a Linux VM, so the container cannot use your host's VPN tunnel or IP-restricted network access. Use the native runner instead:

```bash
pip install -r backend/runner/requirements.txt
playwright install chromium
cd backend && ./runner/run-native.sh
```

### Verify

```bash
curl http://localhost:8001/health
```

Returns browser installation status and artifacts directory path.

### Extension Configuration

1. Open Settings > **Runner** tab
2. Check **Enable Playwright Runner**
3. Set Runner URL to `http://localhost:8001`
4. Click **Test Connection**

## Capabilities

| Feature | Description |
|---------|-------------|
| Multi-browser | Chromium, Firefox, WebKit |
| Device emulation | iPhone, Pixel, iPad, and custom viewports |
| Network mocking | Intercept and mock API responses |
| Trace recording | Full Playwright trace with timeline, snapshots, and network |
| Video recording | WebM video of the entire run |
| HAR capture | HTTP Archive of all network requests |
| Screenshots | Per-step screenshots (success and failure) |
| Geolocation | Override browser geolocation |
| Timezone & locale | Override timezone and language |
| Storage state | Inject cookies/localStorage for authenticated sessions |
| Parallel execution | Run multiple tests concurrently |
| API testing | Test REST APIs without a browser |
| Soft assertions | Log failures without stopping the test |
| Control flow | Conditional blocks (`if_exists`/`end_if`) and loops |

## Supported Step Types

### Actions

| Step Type | Description |
|-----------|-------------|
| `navigation` | Navigate to a URL (base URL + relative path + query params) |
| `click` | Click an element |
| `input` / `change` | Fill a text field |
| `submit` | Submit the closest form |
| `hover` | Hover over an element |
| `scroll` | Scroll an element into view |
| `select` | Select an option from a dropdown |
| `key` / `keypress` | Press a keyboard key (supports Ctrl/Shift/Alt/Meta modifiers) |
| `upload` | Upload a file |
| `drag_drop` | Drag an element to a target |

### Assertions

| Step Type | Description |
|-----------|-------------|
| `assert_exists` / `assert_visible` | Element is visible |
| `assert_hidden` | Element is hidden |
| `assert_text_equals` | Element text matches exactly |
| `assert_text_contains` | Element text contains substring |
| `assert_attr_equals` | Element attribute matches |
| `assert_url_contains` | Page URL contains substring |
| `assert_checked` | Checkbox/radio is checked |
| `assert_disabled` / `assert_enabled` | Element disabled/enabled state |
| `assert_has_class` | Element has a CSS class |
| `assert_has_value` | Input has a specific value |
| `assert_has_title` | Page title matches |
| `assert_count` | Number of matching elements |
| `assert_editable` | Element is editable |
| `assert_no_console_errors` | No console errors logged |
| `assert_screenshot` | Visual regression (pixel comparison) |

### Waits

| Step Type | Description |
|-----------|-------------|
| `wait_delay` | Wait for a fixed number of milliseconds |
| `wait_for_url` | Wait until URL matches a pattern |
| `wait_for_text` | Wait until element contains text |
| `waitForElement` | Wait until element is visible |
| `waitForNavigation` | Wait for network idle |

### Control Flow

| Step Type | Description |
|-----------|-------------|
| `if_exists` | Execute following steps only if element exists |
| `if_not_exists` | Execute following steps only if element does not exist |
| `end_if` | End a conditional block |
| `loop_start` | Begin a loop (set count via `value` or `meta.loopCount`) |
| `loop_end` | End a loop block |

## API Endpoints

### POST /run

Execute a single test.

```json
{
  "steps": [
    { "type": "navigation", "relativePath": "/login" },
    { "type": "input", "selector": "#email", "value": "user@test.com" },
    { "type": "input", "selector": "#password", "value": "secret" },
    { "type": "click", "selector": "button[type=submit]" }
  ],
  "config": {
    "browser": "chromium",
    "baseURL": "https://example.com",
    "viewport": { "width": 1280, "height": 720 },
    "screenshots": true,
    "trace": true,
    "video": false,
    "har": false
  }
}
```

Response includes a `report` (per-step status, timing, errors) and `artifacts` (URLs to download trace, video, HAR, screenshots).

### POST /run-parallel

Execute multiple tests concurrently.

```json
{
  "tests": [
    { "steps": [...], "config": { "browser": "chromium", ... } },
    { "steps": [...], "config": { "browser": "firefox", ... } }
  ],
  "max_workers": 4
}
```

### POST /api-test

Execute API tests without a browser.

```json
{
  "baseURL": "https://api.example.com",
  "requests": [
    {
      "method": "GET",
      "url": "/users",
      "expect": { "status": 200 }
    },
    {
      "method": "POST",
      "url": "/users",
      "body": { "name": "Test" },
      "headers": { "Content-Type": "application/json" },
      "expect": { "status": 201, "bodyContains": "Test" }
    }
  ]
}
```

### Artifact Download Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /trace/{run_id}` | Download Playwright trace zip |
| `GET /video/{run_id}` | Download recorded video (WebM) |
| `GET /har/{run_id}` | Download HAR network log |
| `GET /screenshot/{run_id}/{filename}` | Download a step screenshot |

## Network Mocking

Mock API responses during test execution:

```json
{
  "steps": [...],
  "config": { ... },
  "networkMocks": [
    {
      "url": "**/api/users",
      "method": "GET",
      "response": {
        "status": 200,
        "body": [{ "id": 1, "name": "Mock User" }],
        "headers": { "Content-Type": "application/json" }
      }
    }
  ]
}
```

URL patterns use glob syntax (e.g. `**/api/**`). If `method` is omitted, all HTTP methods are intercepted.

## Device Emulation

Pass a Playwright device name to emulate mobile devices:

```json
{
  "config": {
    "device": "iPhone 14",
    "browser": "webkit"
  }
}
```

Common device names: `iPhone 14`, `iPhone 14 Pro Max`, `Pixel 7`, `iPad Pro 11`, `Galaxy S9+`. The full list is available in [Playwright's device descriptors](https://playwright.dev/docs/emulation#devices).

## Viewing Traces

Download the trace zip from `/trace/{run_id}` and open it in Playwright's trace viewer:

```bash
npx playwright show-trace trace-<run_id>.zip
```

Or upload to [trace.playwright.dev](https://trace.playwright.dev).

## Selector Resolution

The runner uses the same selector format as the extension recordings. Each step's `selector` can be:

- A plain CSS string: `"#login-btn"`
- A structured object with primary + fallbacks:

```json
{
  "primary": { "type": "css", "value": "#login-btn", "matchIndex": 0 },
  "fallbacks": [
    { "type": "css", "value": "[aria-label='Login']" },
    { "type": "xpath", "value": "//button[text()='Login']" },
    { "type": "text", "value": "Login" }
  ]
}
```

Supported selector types: `css`, `xpath`, `text`, `role`, `label`, `placeholder`.

The runner tries each candidate in order until one resolves to a visible element.

## Report Format

Each run returns a `TestReport`:

```json
{
  "run_id": "a1b2c3d4e5f6",
  "status": "passed",
  "duration_ms": 12345,
  "passed": 8,
  "failed": 0,
  "skipped": 0,
  "soft_fails": 0,
  "steps": [
    {
      "index": 0,
      "type": "navigation",
      "status": "passed",
      "duration_ms": 2100,
      "screenshot": "step-0.png"
    },
    {
      "index": 1,
      "type": "click",
      "status": "failed",
      "duration_ms": 4000,
      "error": "Element not found: #missing-btn",
      "screenshot": "step-1-fail.png"
    }
  ],
  "console_errors": ["[error] Uncaught TypeError: ..."]
}
```

Status values: `passed`, `failed`, `soft_failed`. Step statuses: `passed`, `failed`, `skipped`, `soft_fail`.

## Artifacts Directory

Artifacts are stored under `/tmp/autotest-artifacts/{run_id}/` (configurable via `ARTIFACTS_DIR` env var):

```
artifacts/{run_id}/
├── step-0.png           # Step screenshots
├── step-1.png
├── step-2-fail.png      # Failure screenshots
├── trace.zip            # Playwright trace
├── network.har          # HAR log
└── video/
    └── *.webm           # Video recording
```
