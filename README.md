# Autotest — AI E2E Test Generator

**Democratizing end-to-end testing.** Anyone can generate, execute, and validate browser tests using plain English — no code, no framework knowledge, no local setup.

A Chrome extension + centralized backend that turns natural language into production-ready Playwright tests with live visual feedback and rich artifacts.

> Built by **Team Auto Mate** for the Adobe AI Labs Hackathon.

---

## Why Autotest?

| Problem Today | With Autotest |
|---------------|---------------|
| Writing one E2E test takes 30–60 min | AI generates tests in 2–5 min (10–15x faster) |
| Requires months learning Playwright/Selenium/Cypress | Plain English or point-and-click — zero expertise needed |
| Every person needs Node.js, Playwright, Docker locally | One centralized backend; users just install a lightweight Chrome extension |
| Only QA engineers can create tests | Anyone — QA, developers, PMs, designers — can create and run tests |
| Developers waste 10–30 min/day repeating multi-step flows | Record once, replay instantly to skip repetitive navigation |

---

## How It Works

```
1. Install the Chrome extension (~200KB, no dependencies)
2. Open any website
3. Either:
   a) Type what to test in plain English  →  AI generates a Playwright .spec.ts
   b) Record clicks and interactions      →  Extension captures replayable steps
4. Run headless on the centralized backend
5. Watch live screencast + real-time step progress
6. Download artifacts: traces, video, HAR, screenshots
```

---

## Components

| Component | Description | Port |
|-----------|-------------|------|
| **Chrome Extension** | MV3 extension for recording, AI generation, replay, and test management | — |
| **AI Generator** | FastAPI + Claude CLI + Playwright MCP — generates .spec.ts from natural language | 8002 |
| **Playwright Runner** | Headless execution across Chromium/Firefox/WebKit with tracing, video, HAR | 8001 |

---

## Features

- **AI Test Generation** — Describe tests in plain English. Claude generates complete Playwright .spec.ts files with assertions, waits, and error handling.
- **Record & Replay** — Capture clicks, inputs, navigation with multi-selector fallbacks. Replay across environments with real-time HUD overlay.
- **Headless Multi-Browser** — Run tests in Chromium, Firefox, or WebKit with device emulation (desktop + mobile viewports).
- **Live Visual Feed** — Real-time CDP screencast streams to the extension during headless execution.
- **Step Progress Tracking** — See passed/failed/pending counts updating live during test runs.
- **Rich Artifacts** — Playwright traces, video recordings, HAR network logs, per-step screenshots.
- **Self-Healing Selectors** — When selectors break, the system tries fallbacks, then uses AI refinement to recover.
- **Centralized Architecture** — One Docker backend serves the entire team. No per-machine setup.
- **Multi-Environment** — Record once, replay on dev/staging/production by switching the base URL.
- **Stop/Cancel Controls** — Cancel AI generation mid-flight or stop headless runs.

---

## Quick Start

### 1. Start the Backend (one-time, centralized)

```bash
cd backend
docker compose up -d --build
```

Verify:
```bash
curl http://localhost:8001/health   # Runner
curl http://localhost:8002/health   # Generator
```

### 2. Install the Chrome Extension (per user)

1. Open `chrome://extensions`
2. Enable **Developer mode** (toggle top-right)
3. Click **Load unpacked** → select the `frontend/` folder
4. Pin the Autotest icon to your toolbar

### 3. Configure

1. Click Autotest icon → **Open Settings**
2. **Runner tab**: Enable Playwright Runner → set URL to `http://localhost:8001` → Test Connection
3. **Generator tab**: Set URL to `http://localhost:8002` → Test Connection → Login to Claude

### 4. Create & Run a Test

1. Navigate to any website
2. Click Autotest icon
3. Type a plain English prompt (e.g., *"Test the login form with invalid credentials"*)
4. Click Send → AI generates a Playwright test
5. Click **Run Headless** → watch live screencast + step progress
6. View results and download artifacts

> See [docs/quickstart.md](./docs/quickstart.md) for the full detailed guide.

---

## Project Structure

```
autotest/
├── README.md                        # This file
├── docs/
│   ├── architecture.md              # System design, data flows, tech stack
│   ├── quickstart.md                # Detailed setup guide
│   ├── recording-and-replay.md      # Recording mechanics and replay controls
│   ├── nlp-testing.md               # Natural language test authoring
│   └── playwright-runner.md         # Headless execution capabilities
├── sample-inputs/                   # Sample test prompts and recordings
│   ├── prompts.md                   # Example natural language prompts
│   ├── sample-recording.json        # Example recorded test flow
│   └── sample-spec.ts               # Example generated Playwright test
├── frontend/                        # Chrome Extension (MV3)
│   ├── manifest.json                # Extension configuration
│   ├── background/sw.js             # Service worker — message hub, API proxy
│   ├── content/                     # Content scripts (recording, replay, HUD)
│   │   ├── content.js               # Main recording/replay engine
│   │   ├── hud.js                   # On-page HUD overlay
│   │   ├── self-healing.js          # Selector self-healing via AI
│   │   └── video-recorder.js        # WebM video capture
│   ├── popup/                       # Popup UI
│   │   ├── popup.html
│   │   ├── popup.css
│   │   └── popup.js                 # Main popup logic
│   ├── sidepanel/                   # Side panel UI
│   ├── options/                     # Settings page
│   ├── shared/                      # Shared utilities
│   │   ├── storage.js               # chrome.storage.local wrapper
│   │   ├── page-context.js          # Page context extraction for AI
│   │   ├── playwright-converter.js  # Recording → Playwright conversion
│   │   ├── playwright-export.js     # Export to Playwright code
│   │   └── step-converter.js        # Step format conversion
│   └── icons/
└── backend/                         # Centralized backend services
    ├── docker-compose.yml           # Docker Compose orchestration
    ├── generator.py                 # AI test generation (Claude + MCP)
    ├── Dockerfile.generator         # Generator Docker image
    ├── requirements-proxy.txt       # Generator Python dependencies
    ├── .claude/mcp.json             # Playwright MCP configuration
    ├── generated-tests/             # Generated .spec.ts files
    └── runner/                      # Playwright runner service
        ├── main.py                  # FastAPI app — endpoints + artifact serving
        ├── executor.py              # Step executor — browser control + artifacts
        ├── models.py                # Pydantic request/response schemas
        ├── Dockerfile               # Runner Docker image
        ├── requirements.txt         # Runner Python dependencies
        └── run-native.sh            # Native runner (bypasses Docker)
```

---

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| **Frontend** | JavaScript ES6+, Chrome Extensions Manifest V3 |
| **Backend** | Python 3.11+, FastAPI, Pydantic, Uvicorn, Loguru |
| **AI** | Claude CLI, Playwright MCP, Anthropic Claude API |
| **Browser Automation** | Playwright 1.58.0 (Chromium, Firefox, WebKit) |
| **Infrastructure** | Docker, Docker Compose |
| **Streaming** | CDP (Chrome DevTools Protocol), SSE (Server-Sent Events) |

---

## Documentation

| Document | Description |
|----------|-------------|
| [Quick Start](./docs/quickstart.md) | End-to-end setup guide |
| [Architecture](./docs/architecture.md) | System diagram, components, data flows |
| [Recording & Replay](./docs/recording-and-replay.md) | Recording mechanics, selector strategy, HUD |
| [NLP Testing](./docs/nlp-testing.md) | Natural language test authoring |
| [Playwright Runner](./docs/playwright-runner.md) | Headless execution, artifacts, device emulation |
| [Sample Inputs](./sample-inputs/) | Example prompts, recordings, and generated tests |

---

## Impact

| Metric | Value |
|--------|-------|
| Test creation speed | **10–15x faster** (30–60 min → 2–5 min) |
| Team time saved | **~2,500+ hours/year** (QA + Developers combined) |
| Onboarding time | **< 1 minute** (install extension, point to backend) |
| Framework learning curve | **Eliminated** (plain English, no code) |
| Per-machine setup | **Zero** (centralized backend handles everything) |

---

## License

MIT
