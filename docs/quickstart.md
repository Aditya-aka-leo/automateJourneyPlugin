# Quick Start Guide

Get Autotest running in under 10 minutes. The backend is set up once on a shared server; each team member only needs to install the Chrome extension.

---

## Prerequisites

| Requirement | Version | Who Needs It |
|-------------|---------|--------------|
| Google Chrome | 116+ | Everyone |
| Docker + Docker Compose | Engine 20.10+ / Compose v2+ | Backend admin (one-time) |
| Claude CLI authentication | Latest | Backend admin (one-time) |

> **Team members do NOT need:** Python, Node.js, Playwright, Docker, or any test framework on their machines.

---

## Part 1: Backend Setup (One-Time, Centralized)

This is done once by the team admin. The backend serves the entire team.

### Step 1: Clone & Start Docker

```bash
git clone <repo-url>
cd autotest/backend

# Start both services (Generator + Runner)
docker compose up -d --build
```

This starts:
- **Generator** on port `8002` — AI test generation via Claude CLI
- **Runner** on port `8001` — Headless Playwright execution

### Step 2: Verify Services

```bash
# Check the Runner
curl http://localhost:8001/health
# Expected: {"status":"healthy","browsers_installed":true,...}

# Check the Generator
curl http://localhost:8002/health
# Expected: {"ok":true,"claude_available":true,...}
```

### Step 3: Authenticate Claude

**Option A — Mount host credentials (recommended for local/Mac):**

The `docker-compose.yml` mounts `~/.claude` by default. Authenticate on the host:

```bash
# On your host machine (not inside Docker)
npm install -g @anthropic-ai/claude-code
claude login    # Opens browser for SSO/OAuth
```

Then restart the generator:
```bash
docker compose restart generator
```

**Option B — Authenticate inside Docker:**

```bash
docker exec -it autotest-generator claude login
# Follow the prompts to authenticate
```

### Step 4: Verify Claude Authentication

```bash
curl http://localhost:8002/auth/status
# Expected: {"ok":true,"authenticated":true}
```

### Step 5: (Optional) Make Backend Accessible to Team

If the backend runs on a shared server, ensure ports 8001 and 8002 are accessible to team members:

```bash
# Example: if backend is on server 10.0.1.50
# Team members will configure their extension to point to:
#   Runner:    http://10.0.1.50:8001
#   Generator: http://10.0.1.50:8002
```

---

## Part 2: Chrome Extension Setup (Per User — Under 1 Minute)

### Step 1: Install the Extension

1. Open Chrome → navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in top-right corner)
3. Click **Load unpacked** → select the `frontend/` folder
4. Pin the **Autotest** icon to your toolbar for easy access

### Step 2: Configure Backend URLs

1. Click the Autotest icon → **Open Settings** (gear icon)
2. Go to the **Runner** tab:
   - Check **Enable Playwright Runner**
   - Set URL to `http://localhost:8001` (or the shared server URL)
   - Click **Test Connection** → should show green checkmark
3. Go to the **Generator** tab:
   - Set URL to `http://localhost:8002` (or the shared server URL)
   - Click **Test Connection** → should show green checkmark
   - If Claude isn't authenticated, click **Login to Claude** and follow prompts
4. Click **Save**

That's it — you're ready to go.

---

## Part 3: Using Autotest

### Generate a Test with AI

1. Navigate to any web application in Chrome
2. Click the Autotest icon
3. In the AI prompt area, type what you want to test in plain English:
   ```
   Test the login form with invalid email and verify error message appears
   ```
4. Click the **Send** button (arrow icon)
5. Wait ~60 seconds — Claude navigates the page via MCP and generates a Playwright test
6. The generated `.spec.ts` file appears in the extension

### Record a Test

1. Navigate to the page you want to test
2. Click Autotest icon → **Start Recording** (badge shows "REC")
3. Interact with the page — clicks, typing, navigation are captured
4. Click **Stop Recording** → enter a name → Save

### Replay in Browser (Extension-Native)

1. Select a recording from the dropdown
2. Select an environment (or use default)
3. Enable **Show HUD** for real-time progress overlay
4. Click **Replay All**
5. The HUD shows each step with green/red status indicators

### Run Headless (Playwright Runner)

1. Select a recording with steps
2. Click the **Run Headless** button
3. Choose browser (Chromium/Firefox/WebKit) and viewport
4. Click **Run**
5. Watch the **live screencast** from the headless browser
6. Monitor **step progress** (passed/failed/pending counts)
7. On completion, view the report and download artifacts:
   - Playwright trace (open in [trace.playwright.dev](https://trace.playwright.dev))
   - Video recording
   - HAR network log
   - Per-step screenshots

---

## Docker Commands Reference

```bash
# Start all services
cd backend
docker compose up -d --build

# View logs
docker compose logs -f              # All services
docker compose logs -f runner       # Runner only
docker compose logs -f generator    # Generator only

# Restart services
docker compose restart

# Stop services
docker compose down

# Rebuild after code changes
docker compose up -d --build

# Check service status
docker compose ps
```

---

## Troubleshooting

### Backend won't start

```bash
# Check if ports are in use
lsof -i :8001
lsof -i :8002

# Check Docker logs
docker compose logs generator
docker compose logs runner
```

### Extension not connecting to backend

1. Verify `curl http://localhost:8001/health` returns OK
2. Check Settings → Runner tab → Test Connection
3. Open DevTools on the popup (right-click Autotest icon → Inspect) for console errors
4. Ensure the URL has no trailing slash

### Claude authentication issues

```bash
# Check auth status
curl http://localhost:8002/auth/status

# Re-authenticate
claude login

# Restart generator to pick up new credentials
docker compose restart generator
```

### Runner can't launch browsers

```bash
# Check browser installation inside Docker
docker exec -it autotest-runner python -c "from playwright.sync_api import sync_playwright; p = sync_playwright().start(); b = p.chromium.launch(); b.close(); p.stop(); print('OK')"
```

### VPN/IP-restricted sites

Docker runs in an isolated network. For sites only accessible via VPN, use the native runner:

```bash
pip install -r backend/runner/requirements.txt
playwright install chromium
cd backend && ./runner/run-native.sh
```

---

## Environment Variables

### Generator (`docker-compose.yml`)

| Variable | Default | Purpose |
|----------|---------|---------|
| `MCP_TIMEOUT` | `300s` | Max time for MCP browser interactions |
| `QUERY_TIMEOUT` | `120s` | Max time for simple Claude queries |
| `GENERATED_TESTS_DIR` | `/app/generated-tests` | Where to save .spec.ts files |

### Runner (`docker-compose.yml`)

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8001` | Runner HTTP port |
| `LOG_LEVEL` | `INFO` | Logging verbosity (DEBUG for detailed output) |
| `ARTIFACTS_DIR` | `/app/artifacts` | Where to store test artifacts |
