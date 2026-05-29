# Frontend -- Chrome Extension

A Manifest V3 Chrome extension for recording, replaying, and managing browser test flows with AI-powered natural language authoring.

## Installation

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select this `frontend/` folder
4. Pin the Autotest icon to your toolbar

### Rebuild the AI Agent Bundle (optional)

Only needed if you modify `shared/ai-agent.js`:

```bash
npm install
npm run build
```

## Features

### Recording
- Captures clicks, text input, form changes, navigation, and submissions
- Smart input merging -- continuous typing is debounced into a single step
- Stores relative paths so recordings work across environments
- Captures element names from aria-label, placeholder, name, id for readable step descriptions

### Replay
- Executes recordings step-by-step with real-time progress
- Auto-opens the correct URL in a new tab
- Multi-selector fallback strategy (id, data-testid, aria-label, role, XPath)
- Self-healing: tries fallback selectors, then requests AI refinement from the backend
- Pause/resume/stop controls
- Retry and soft-assertion modes

### On-Page HUD
- Full scrollable step list with live status indicators
- Page-grouped steps with color coding
- Pause before a specific step, or edit/re-record any step inline
- Persists across page navigations

### Natural Language Testing
- Write tests in plain English (e.g. "Click the Sign In button")
- Supports OpenAI and Anthropic Claude
- The backend parses NL into structured steps with real DOM selectors
- Enhanced multi-step parsing with ReAct reasoning

### Playwright Execution
- Send recordings to the Playwright Runner for headless execution
- Choose Chromium, Firefox, or WebKit
- View detailed reports with per-step status, screenshots, traces, video, and HAR logs

### Screenshot & Video Capture
- Capture a screenshot after each replay step
- Record full replay sessions as WebM video
- Option to only capture on failure

### Environments
- Configure multiple environments (dev, staging, production) with base URLs
- Environment variables with `${VAR}` / `{{VAR}}` placeholder syntax
- Record once, replay anywhere by switching the environment

## Feature Comparison Matrix

Use this itemized matrix to compare the plugin against similar tools and define the final merged feature set:

- [Plugin Feature Comparison Matrix](../docs/plugin-feature-comparison.md)

## Configuration

Open the extension popup and click **Open Settings**. The settings are organized into 5 tabs: Basic, Capture, Recordings, Runner, and Generator.

### Basic Tab
Core features that work out of the box with no external dependencies:
- **Environments** -- Add/edit environments with name, base URL, and variables
- **Replay Settings** -- Default retry count, soft assertions, viewport override
- **Screenshot & Video Capture** -- Capture mode (None, Screenshots, Video, Both), failure-only option
- **Recordings** -- Browse, search, filter, edit, and delete saved recordings

### Runner Tab (Advanced)
Disabled by default. Enables headless multi-browser execution:
- **Playwright Runner** -- Enable and configure the runner URL (default: `http://localhost:8001`)
- Capabilities overview: multi-browser, device emulation, traces, video, network mocking, HAR, parallel execution, API testing

### Generator Tab (Advanced)
Disabled by default. Enables AI-powered test generation:
- **Generator URL** -- Configure the generator service URL (default: `http://localhost:8002`)
- **Claude Authentication** -- Login to Claude directly from the settings page
- AI test generation via Claude CLI + Playwright MCP

## File Structure

```
frontend/
├── manifest.json              # Extension manifest (MV3)
├── package.json               # Node dependencies (LangChain, esbuild)
├── build.js                   # esbuild script for ai-agent bundle
├── background/
│   └── sw.js                  # Service worker -- message hub, API proxy
├── content/
│   ├── content.js             # Main content script -- recording & replay
│   ├── hud.js                 # On-page HUD overlay
│   ├── nlp-element-finder.js  # AI-powered element finding
│   ├── nlp-replay.js          # NLP recording replay
│   ├── self-healing.js        # Selector self-healing
│   └── video-recorder.js      # Video capture
├── popup/
│   ├── popup.html             # Popup UI
│   ├── popup.css              # Popup styles
│   └── popup.js               # Popup logic (also used by side panel)
├── sidepanel/
│   ├── sidepanel.html         # Side panel UI
│   └── sidepanel.css          # Side panel overrides
├── options/
│   ├── options.html           # Settings page
│   ├── options.css
│   └── options.js
├── shared/
│   ├── storage.js             # Versioned chrome.storage.local wrapper
│   ├── ai-provider.js         # AI provider abstraction (OpenAI, Claude)
│   ├── ai-agent.js            # LangChain agent (bundled via esbuild)
│   ├── nlp-parser.js          # NLP text-to-steps parsing
│   ├── nlp-parser-enhanced.js # Enhanced multi-step parsing with ReAct
│   ├── page-context.js        # Page context extraction for AI
│   ├── playwright-export.js   # Export recordings to Playwright test code
│   ├── step-converter.js      # Step format conversion utilities
│   ├── flows.js               # Flow metadata and versioning
│   ├── variables.js           # Environment variable resolution
│   ├── media-capture.js       # Screenshot/video capture helpers
│   ├── docx-generator.js      # DOCX report generation
│   └── cache.js               # In-memory cache utility
└── icons/
    └── icon-*.png             # Extension icons (16, 48, 128, 512)
```

## Selector Strategy

The extension generates multiple selectors per element and tries them in order:

1. `#element-id` -- CSS ID
2. `[data-testid="..."]` -- Test ID attribute
3. `[aria-label="..."]` -- Accessibility label
4. `[role="..."]` with text content -- Semantic role
5. XPath -- Full path fallback

When all selectors fail during replay, the self-healing module requests AI-powered refinement from the backend.

## Badge Indicators

| Badge | Meaning |
|-------|---------|
| Animated "REC" | Recording in progress |
| "3/10" | Replaying step 3 of 10 |
| Green checkmark | Replay succeeded |
| Red X | Replay failed |

## Tips

- **Enable the HUD** during replay for best visibility into step execution
- **Use environment variables** for credentials and dynamic data
- **Pause and inspect** to debug at any point during replay
- **Edit steps inline** via the HUD pencil icon without re-recording
- **Use specific NL descriptions** for better AI element matching (e.g. "Click the blue Submit button" instead of "Click button")
