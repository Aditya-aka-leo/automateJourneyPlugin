# Architecture

Autotest follows a **centralized backend + lightweight client** architecture. The Chrome extension is the only thing installed on each user's machine. All heavy lifting — AI generation, headless browser execution, artifact storage — runs on a single shared backend deployed via Docker Compose.

---

## System Diagram

```
  ┌─────────────────────────────────────────────────────────────┐
  │                    User's Chrome Browser                     │
  │                                                             │
  │   ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌────────┐  │
  │   │  Popup /  │  │  Content  │  │  Service  │  │Options │  │
  │   │Side Panel │  │  Scripts  │  │  Worker   │  │  Page  │  │
  │   └─────┬─────┘  └─────┬─────┘  └─────┬─────┘  └───┬────┘  │
  │         └───────────────┼──────────────┼────────────┘       │
  │                         │   chrome.runtime messages          │
  │                         │              │                     │
  └─────────────────────────┼──────────────┼─────────────────────┘
                            │              │
            Lightweight     │         REST │  API calls
            ~200KB          │              │
            No dependencies │              │
                            ▼              ▼
  ┌─────────────────────────────────────────────────────────────┐
  │              Centralized Backend (Docker Compose)            │
  │                                                             │
  │   ┌──────────────────────┐    ┌──────────────────────────┐  │
  │   │    AI Generator      │    │    Playwright Runner      │  │
  │   │    :8002 (FastAPI)   │    │    :8001 (FastAPI)        │  │
  │   │                      │    │                          │  │
  │   │  ┌────────────────┐  │    │  ┌────────────────────┐  │  │
  │   │  │  Claude CLI    │  │    │  │  Headless Browsers  │  │  │
  │   │  │  + Playwright  │  │    │  │  Chromium / Firefox │  │  │
  │   │  │    MCP Server  │  │    │  │  / WebKit           │  │  │
  │   │  └────────────────┘  │    │  └────────────────────┘  │  │
  │   │                      │    │                          │  │
  │   │  ┌────────────────┐  │    │  ┌────────────────────┐  │  │
  │   │  │ Generated Tests│  │    │  │  Artifacts Store    │  │  │
  │   │  │ (.spec.ts)     │◄─┼────┼──│  Traces / Video /  │  │  │
  │   │  └────────────────┘  │    │  │  HAR / Screenshots  │  │  │
  │   │                      │    │  └────────────────────┘  │  │
  │   └──────────────────────┘    └──────────────────────────┘  │
  │                                                             │
  │   Shared Docker Network: autotest-network                   │
  │   Shared Volume: generated-tests                            │
  └─────────────────────────────────────────────────────────────┘
```

---

## Component Responsibilities

### Chrome Extension (`frontend/`)

The extension is a Manifest V3 Chrome extension with four contexts:

| Context | Entry Point | Role |
|---------|-------------|------|
| **Popup / Side Panel** | `popup/popup.js` | Main UI — recording, AI generation, replay, headless runs, reports |
| **Service Worker** | `background/sw.js` | Message hub — routes messages, proxies API calls, manages state |
| **Content Scripts** | `content/content.js` | Injected into pages — captures DOM events, replays actions, renders HUD |
| **Options Page** | `options/options.js` | Settings — environments, Runner URL, Generator URL, replay config |

**Key content script modules:**

| Module | Purpose |
|--------|---------|
| `content.js` | Main recording/replay engine — captures clicks, inputs, navigation; executes steps |
| `hud.js` | On-page HUD overlay — real-time step list, status indicators, pause/edit controls |
| `self-healing.js` | Selector fallback — tries alternative selectors, requests AI refinement |
| `video-recorder.js` | WebM video capture via TabCapture API |

**Shared utilities (`shared/`):**

| Module | Purpose |
|--------|---------|
| `storage.js` | Versioned `chrome.storage.local` wrapper for recordings, settings, environments |
| `page-context.js` | Extracts page DOM, visible elements, attributes for AI context |
| `playwright-converter.js` | Converts recording steps → Playwright .spec.ts code |
| `playwright-export.js` | Exports recordings as standalone Playwright test files |
| `step-converter.js` | Converts between internal step format and other formats |
| `variables.js` | Resolves `${VAR}` / `{{VAR}}` placeholders from environments |

### AI Generator (`backend/generator.py`)

FastAPI server that generates Playwright tests using Claude CLI + Playwright MCP.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/generate-test` | POST | Generate a Playwright .spec.ts from natural language + URL |
| `/cancel-generation` | POST | Cancel an in-flight generation |
| `/fix-step` | POST | AI-assisted step repair using Claude + Playwright MCP |
| `/query` | POST | Run a simple Claude CLI prompt |
| `/tests` | GET | List all generated tests |
| `/tests/{id}` | GET | Get test code and metadata |
| `/tests/{id}` | DELETE | Delete a generated test |
| `/auth/login` | POST | Start Claude CLI OAuth flow |
| `/auth/complete` | POST | Submit OAuth code to complete login |
| `/auth/status` | GET | Check Claude authentication status |
| `/health` | GET | Health check (Claude CLI, MCP, npm) |

**How AI generation works:**
1. User provides natural language prompt + target URL
2. Generator invokes Claude CLI with Playwright MCP server
3. Claude navigates to the URL via MCP, inspects the page
4. Claude generates a complete `.spec.ts` file with real selectors and assertions
5. File saved to shared `generated-tests` volume
6. Extension retrieves the test for execution

### Playwright Runner (`backend/runner/`)

Standalone FastAPI service that executes tests in headless browsers.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/run` | POST | Execute a recording in a headless browser |
| `/run-parallel` | POST | Execute multiple tests concurrently |
| `/run-spec` | POST | Execute a .spec.ts file via Playwright CLI |
| `/api-test` | POST | Execute API tests (no browser) |
| `/progress/{run_id}` | GET | Poll real-time step progress |
| `/live/{run_id}` | GET | SSE stream of CDP screencast frames |
| `/trace/{run_id}` | GET | Download Playwright trace zip |
| `/video/{run_id}` | GET | Download video recording |
| `/har/{run_id}` | GET | Download HAR network log |
| `/screenshot/{run_id}/{file}` | GET | Download step screenshot |
| `/health` | GET | Health check (browser availability) |

**Step types supported:**

| Category | Types |
|----------|-------|
| **Actions** | `click`, `input`, `change`, `submit`, `hover`, `scroll`, `select`, `key`, `upload`, `drag_drop`, `navigation` |
| **Assertions** | `assert_exists`, `assert_visible`, `assert_hidden`, `assert_text_*`, `assert_attr_*`, `assert_url_*`, `assert_checked`, `assert_disabled`, `assert_enabled` |
| **Waits** | `wait_delay`, `wait_for_url`, `wait_for_selector` |
| **Control Flow** | `if_exists`, `end_if` (conditional blocks) |

**Browser support:** Chromium, Firefox, WebKit
**Device emulation:** Desktop, mobile viewports, geolocation, timezone, locale

---

## Data Flows

### AI Test Generation

```
User types plain English prompt in extension
  → popup.js sends prompt + active tab URL to service worker
  → Service worker POSTs to Generator at :8002/generate-test
  → Generator invokes Claude CLI with Playwright MCP
  → Claude navigates to URL, inspects page, generates .spec.ts
  → .spec.ts saved to generated-tests volume
  → Extension displays generated test code
```

### Recording

```
User clicks "Start Recording"
  → content.js captures DOM events (click, input, navigation, scroll)
  → Events sent to popup.js via chrome.runtime messages
  → Steps stored in chrome.storage.local via storage.js
  → User clicks "Stop Recording" → recording saved with metadata
```

### Headless Execution (Playwright Runner)

```
User clicks "Run Headless"
  → popup.js generates a unique runId, sends recording + config to service worker
  → Service worker POSTs to Runner at :8001/run
  → Runner launches headless browser, starts CDP screencast
  → SSE stream sends live frames → displayed in extension popup
  → Progress polling every 800ms → step counts update in real-time
  → On completion: report + artifacts returned
  → Extension renders results with pass/fail, screenshots, trace/video links
```

### Extension-Native Replay

```
User clicks "Replay All"
  → popup.js sends steps to service worker
  → Service worker forwards to content script on target tab
  → content.js executes each step (find element → act → report)
  → HUD overlay shows real-time progress
  → On failure: self-healing tries fallback selectors
  → On failure after fallbacks: AI refinement via backend
```

---

## Docker Infrastructure

### Services

| Service | Container | Port | Image Base |
|---------|-----------|------|------------|
| **Generator** | `autotest-generator` | 8002 | `python:3.11-slim` + Node.js 20 + Claude CLI + Playwright MCP |
| **Runner** | `autotest-runner` | 8001 | `mcr.microsoft.com/playwright/python:v1.58.0` + Node.js 20 |

### Volumes

| Volume | Shared Between | Purpose |
|--------|----------------|---------|
| `generated-tests` | Generator ↔ Runner | Generated .spec.ts files |
| `runner-artifacts` | Runner only | Traces, video, HAR, screenshots |
| `claude-credentials` | Generator only | (Optional) Claude CLI auth tokens |

### Network

All services share `autotest-network` (bridge driver), enabling container-to-container communication.

### Health Checks

- **Generator**: `curl http://localhost:8002/health` every 30s — checks Claude CLI, MCP config, npm
- **Runner**: Python urllib check of `http://localhost:8001/health` every 30s — validates Playwright browsers

---

## Storage

| Data | Location | Persistence |
|------|----------|-------------|
| Recordings, settings, environments | `chrome.storage.local` (extension) | Per-browser profile |
| Generated .spec.ts files | `generated-tests` Docker volume | Persistent |
| Test artifacts (traces, video, HAR, screenshots) | `runner-artifacts` Docker volume | Persistent |
| Claude authentication | `~/.claude` mount or `claude-credentials` volume | Persistent |

---

## Network Ports

| Service | Default Port | Protocol | Purpose |
|---------|-------------|----------|---------|
| Generator | 8002 | HTTP | AI test generation |
| Runner | 8001 | HTTP + SSE | Headless execution + live stream |

---

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| **Frontend** | JavaScript ES6+, Chrome Extensions MV3, CSS |
| **Backend** | Python 3.11+, FastAPI, Pydantic, Uvicorn, Loguru |
| **AI** | Claude CLI, Playwright MCP, Anthropic Claude API |
| **Browser Automation** | Playwright 1.58.0 (Chromium, Firefox, WebKit) |
| **Infrastructure** | Docker, Docker Compose, Node.js 20.x |
| **Streaming** | CDP (Chrome DevTools Protocol), SSE (Server-Sent Events) |

---

## Security

- **No sensitive data sent to AI** — only page structure and user prompts
- **No authentication tokens captured** — cookies and credentials are not transmitted
- **CORS** — configured for extension and localhost access
- **Path traversal protection** — artifact filenames are sanitized
- **Human oversight** — all generated tests require user review before execution
