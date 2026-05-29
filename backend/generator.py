"""
Generator
=========
HTTP server that provides Claude CLI + Playwright MCP access for test generation.

Runs as a Docker service (autotest-generator) or standalone on the host.

Endpoints:
  POST /query          — Run a simple Claude CLI prompt
  POST /generate-test  — Generate a Playwright .spec.ts via Claude + MCP
  POST /fix-step       — AI-assisted step repair using Claude + Playwright MCP
  GET  /tests          — List generated tests
  GET  /tests/{id}     — Get a specific test
  DELETE /tests/{id}   — Delete a test

Authentication (Docker):
  Option A: Mount host ~/.claude/ into the container (default in docker-compose)
  Option B: docker exec -it autotest-generator claude login
"""
import asyncio
import logging
import os
import re
import json
import shutil
import subprocess
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import httpx

# ── Logging ──────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s | %(levelname)-7s | %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("generator")


class _HealthFilter(logging.Filter):
    """Drop noisy /health poll lines from uvicorn access log."""
    def filter(self, record: logging.LogRecord) -> bool:
        return "/health" not in record.getMessage()


app = FastAPI(title="Autotest Generator", version="2.0.0")


@app.on_event("startup")
async def _configure_access_log():
    logging.getLogger("uvicorn.access").addFilter(_HealthFilter())

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET", "DELETE"],
    allow_headers=["*"],
)

# ── Paths ─────────────────────────────────────────────────────────
BACKEND_DIR = Path(__file__).resolve().parent
MCP_CONFIG_PATH = Path(os.getenv("MCP_CONFIG_PATH", str(BACKEND_DIR / ".claude" / "mcp.json")))
GENERATED_TESTS_DIR = Path(os.getenv("GENERATED_TESTS_DIR", str(BACKEND_DIR / "generated-tests")))
GENERATED_TESTS_DIR.mkdir(parents=True, exist_ok=True)
TESTS_STORE_ROOT = Path(os.getenv("TESTS_STORE_ROOT", "/app/tests-store"))
REGISTRY_URL = os.getenv("REGISTRY_URL", "http://registry:8003")
RUNNER_URL = os.getenv("RUNNER_URL", "http://runner:8001")

# ── Timeout for MCP-based generation (browser interactions take longer)
MCP_TIMEOUT = int(os.getenv("MCP_TIMEOUT", "300"))
QUERY_TIMEOUT = int(os.getenv("QUERY_TIMEOUT", "120"))


# ── Models ────────────────────────────────────────────────────────

class QueryRequest(BaseModel):
    prompt: str
    model: Optional[str] = None


class QueryResponse(BaseModel):
    ok: bool
    text: str = ""
    error: str = ""


class GenerateTestRequest(BaseModel):
    prompt: str
    target_url: str
    test_name: str = ""
    model: Optional[str] = None
    validate: bool = False  # False = fast mode (skip validation); True = reasoning mode (validate + auto-fix)
    # Multi-tenant fields (optional for backward compat)
    account_slug: Optional[str] = None
    project_slug: Optional[str] = None
    session_token: Optional[str] = None
    access_key: Optional[str] = None  # deprecated, use session_token


class GenerateTestResponse(BaseModel):
    ok: bool
    test_id: str = ""
    test_name: str = ""
    spec_code: str = ""
    file_path: str = ""
    execution_log: str = ""
    error: str = ""


class TestInfo(BaseModel):
    test_id: str
    test_name: str
    file_path: str
    created_at: str
    target_url: str = ""
    prompt: str = ""


class FixStepRequest(BaseModel):
    prompt: str
    failed_step: dict
    page_url: str = ""
    model: Optional[str] = None


class FixStepResponse(BaseModel):
    ok: bool
    fixed_step: Optional[dict] = None
    explanation: str = ""
    error: str = ""


class ValidateAndFixRequest(BaseModel):
    spec_path: str
    runner_url: str = ""
    max_attempts: int = 2


class ValidateAndFixResponse(BaseModel):
    ok: bool
    status: str = ""
    spec_code: str = ""
    fixed: bool = False
    attempts: int = 0
    report: dict = {}
    artifacts: dict = {}
    error: str = ""


# ── Helpers ───────────────────────────────────────────────────────

def _get_claude_path() -> str:
    claude_path = shutil.which("claude")
    if not claude_path:
        raise HTTPException(
            status_code=503,
            detail="claude CLI not found on PATH. Run: npm install -g @anthropic-ai/claude-code",
        )
    return claude_path


def _clean_env() -> dict:
    """Remove CLAUDECODE so the CLI doesn't refuse to run when the proxy
    itself is started from within a Claude Code session (e.g. Cursor)."""
    return {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}


def _extract_spec_code(text: str) -> str:
    """Extract TypeScript/JavaScript code block from Claude's response."""
    # Try to find ```typescript or ```ts or ```javascript or ```js code blocks
    patterns = [
        r"```(?:typescript|ts)\s*\n(.*?)```",
        r"```(?:javascript|js)\s*\n(.*?)```",
        r"```\s*\n(.*?)```",
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.DOTALL)
        if match:
            return match.group(1).strip()
    # If no code block found, return the full text (Claude might have output just code)
    return text.strip()


def _sanitize_name(name: str) -> str:
    """Sanitize a test name for use as a filename."""
    # Replace non-alphanumeric characters with hyphens
    sanitized = re.sub(r"[^a-zA-Z0-9]+", "-", name.strip().lower())
    # Remove leading/trailing hyphens
    sanitized = sanitized.strip("-")
    return sanitized[:80] if sanitized else "test"


def _build_mcp_prompt(prompt: str, target_url: str) -> str:
    """Build the prompt for Claude CLI with Playwright MCP (Reasoning mode — uses live browser)."""
    return f"""You are a Playwright test automation expert. Your task is to create a comprehensive Playwright test.

## Instructions

1. Use the Playwright MCP browser tools to navigate to: {target_url}
2. Perform the following test scenario by interacting with the live page:

{prompt}

3. As you interact with the page, carefully observe:
   - Element locators (prefer getByRole, getByText, getByLabel, getByPlaceholder)
   - Page URLs and navigation
   - Text content for assertions
   - Visual state changes

4. After completing the scenario, generate a complete Playwright test file.

## Output Requirements

Output ONLY a single TypeScript code block containing a complete .spec.ts file:
- Use `import {{ test, expect }} from '@playwright/test';`
- Use descriptive test names
- Use recommended locators (getByRole, getByText, getByLabel preferred over CSS selectors)
- Include meaningful assertions after key actions
- Add appropriate waits (waitForLoadState, waitForURL) where needed
- Handle any dialogs or popups encountered
- Take screenshots at important checkpoints using `await page.screenshot({{ path: 'screenshot-<step>.png' }})`

```typescript
// Your complete test code here
```"""


def _build_fast_prompt(prompt: str, target_url: str) -> str:
    """Build the prompt for fast generation — no MCP browser, purely from description."""
    return f"""You are a Playwright test automation expert. Generate a Playwright test based on the description below.

## Target URL
{target_url}

## Test Scenario
{prompt}

## Output Requirements

Output ONLY a single TypeScript code block containing a complete .spec.ts file:
- Use `import {{ test, expect }} from '@playwright/test';`
- Start with `await page.goto('{target_url}');`
- Use recommended locators (getByRole, getByText, getByLabel, getByPlaceholder preferred over CSS)
- Include meaningful assertions after key actions
- Add appropriate waits (waitForLoadState, waitForURL) where needed

```typescript
// Your complete test code here
```"""


# ── Health ────────────────────────────────────────────────────────

async def _check_claude_authenticated(claude_path: str) -> bool:
    """Run `claude auth status` and parse the JSON to check login state."""
    try:
        proc = await asyncio.create_subprocess_exec(
            claude_path, "auth", "status",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=_clean_env(),
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=10)
        output = stdout.decode().strip() or stderr.decode().strip()
        log.debug("[HEALTH] claude auth status output: %s", output[:300])
        try:
            status = json.loads(output)
            logged_in = status.get("loggedIn", False)
            log.debug("[HEALTH] Claude auth: loggedIn=%s", logged_in)
            return logged_in
        except json.JSONDecodeError:
            # If not JSON, check exit code — 0 means logged in
            return proc.returncode == 0
    except asyncio.TimeoutError:
        log.warning("[HEALTH] Claude auth status timed out")
        return False
    except Exception as e:
        log.warning("[HEALTH] Claude auth check error: %s", e)
        return False


# ── In-flight login state (PTY-based) ────────────────────────────
_login_pid: Optional[int] = None       # PID of claude auth login child
_login_pty_fd: Optional[int] = None    # Master PTY fd for reading/writing
_login_url: Optional[str] = None       # Cached OAuth URL


class AuthCompleteRequest(BaseModel):
    code: str


def _get_outbound_ips() -> list[str]:
    """Detect public outbound IP for bot-prevention whitelisting."""
    try:
        result = subprocess.run(
            ["curl", "-s", "--max-time", "3", "https://api.ipify.org"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            return [result.stdout.strip()]
    except Exception:
        pass
    return []


@app.get("/health")
async def health():
    claude_path = shutil.which("claude")
    mcp_config_exists = MCP_CONFIG_PATH.exists()
    npx_path = shutil.which("npx")
    claude_authenticated = await _check_claude_authenticated(claude_path) if claude_path else False
    outbound_ips = _get_outbound_ips()
    return {
        "ok": True,
        "claude_available": claude_path is not None,
        "claude_authenticated": claude_authenticated,
        "claude_path": claude_path,
        "mcp_config_exists": mcp_config_exists,
        "mcp_config_path": str(MCP_CONFIG_PATH),
        "npx_available": npx_path is not None,
        "generated_tests_dir": str(GENERATED_TESTS_DIR),
        "outbound_ips": outbound_ips,
    }


@app.get("/generator/health")
async def health_prefixed():
    """Backward-compatible alias when hitting generator directly with /generator/* paths."""
    return await health()


# ── Auth: PTY-based login + code submission ──────────────────────

import pty
import select
import signal


def _cleanup_login():
    """Kill the login child process and close the PTY master fd."""
    global _login_pid, _login_pty_fd, _login_url
    if _login_pid:
        try:
            os.kill(_login_pid, signal.SIGKILL)
            os.waitpid(_login_pid, os.WNOHANG)
        except (ProcessLookupError, ChildProcessError, OSError):
            pass
    _login_pid = None
    if _login_pty_fd is not None:
        try:
            os.close(_login_pty_fd)
        except OSError:
            pass
    _login_pty_fd = None
    _login_url = None


def _login_child_alive() -> bool:
    """Check if the login child process is still running."""
    if not _login_pid:
        return False
    try:
        pid, status = os.waitpid(_login_pid, os.WNOHANG)
        return pid == 0  # pid==0 means still running
    except ChildProcessError:
        return False


def _read_pty_output(fd: int, timeout: float = 0.5) -> str:
    """Read all available output from the PTY master fd."""
    output = b""
    while True:
        ready, _, _ = select.select([fd], [], [], timeout)
        if not ready:
            break
        try:
            chunk = os.read(fd, 4096)
            if not chunk:
                break
            output += chunk
            timeout = 0.1  # shorter timeout for subsequent reads
        except OSError:
            break
    return output.decode("utf-8", errors="replace")


@app.post("/auth/login")
async def auth_login():
    """Spawn `claude auth login` in a PTY, capture the OAuth URL."""
    global _login_pid, _login_pty_fd, _login_url

    claude_path = shutil.which("claude")
    if not claude_path:
        return {"ok": False, "error": "claude CLI not found on PATH"}

    # If already authenticated, skip
    if await _check_claude_authenticated(claude_path):
        _cleanup_login()
        return {"ok": True, "already_authenticated": True}

    # If a login process is already running, return the cached URL
    if _login_pid and _login_child_alive() and _login_url:
        log.info("[AUTH] Returning cached login URL (process still active)")
        return {"ok": True, "login_url": _login_url}

    log.info("[AUTH] Starting claude auth login in PTY...")
    _cleanup_login()

    try:
        # Fork a child process with a PTY
        env = _clean_env()
        env["TERM"] = "dumb"  # simple terminal to avoid escape sequences

        pid, master_fd = pty.openpty()
        # pty.openpty gives us the master/slave pair; we use pty.fork for the child
        os.close(pid)
        os.close(master_fd)

        child_pid, master_fd = pty.fork()

        if child_pid == 0:
            # ── Child process ──
            # Replace environment and exec claude auth login
            for k, v in env.items():
                os.environ[k] = v
            os.execvp(claude_path, [claude_path, "auth", "login"])
            # If exec fails, exit
            os._exit(1)

        # ── Parent process ──
        _login_pid = child_pid
        _login_pty_fd = master_fd
        log.info("[AUTH] Spawned claude auth login (PID %d, PTY fd %d)", child_pid, master_fd)

        # Read output until we find the OAuth URL (with timeout)
        loop = asyncio.get_event_loop()

        def _read_for_url():
            collected = ""
            end_time = time.time() + 20
            while time.time() < end_time:
                text = _read_pty_output(master_fd, timeout=1.0)
                if text:
                    collected += text
                    log.debug("[AUTH][PTY] %s", text.replace("\n", " | ")[:200])
                    url_match = re.search(r'https?://\S+', collected)
                    if url_match:
                        return url_match.group(0), collected
                # Check if child exited
                try:
                    wpid, status = os.waitpid(child_pid, os.WNOHANG)
                    if wpid != 0:
                        log.info("[AUTH] Child exited with status %d before URL found", status)
                        break
                except ChildProcessError:
                    break
            return None, collected

        login_url, collected = await loop.run_in_executor(None, _read_for_url)

        if login_url:
            _login_url = login_url
            log.info("[AUTH] Got login URL: %s", login_url[:120])
            return {"ok": True, "login_url": login_url}
        else:
            _cleanup_login()
            return {
                "ok": False,
                "error": "Could not capture login URL from claude auth login",
                "output": collected[:500],
            }

    except Exception as e:
        log.error("[AUTH] Login error: %s", e, exc_info=True)
        _cleanup_login()
        return {"ok": False, "error": str(e)}


@app.post("/auth/complete")
async def auth_complete(request: AuthCompleteRequest):
    """Write the OAuth code to the PTY so `claude auth login` receives it as keyboard input."""
    global _login_pid, _login_pty_fd, _login_url

    code = request.code.strip()
    log.info("[AUTH] Submitting code via PTY: %s...", code[:10])

    claude_path = shutil.which("claude")
    if not claude_path:
        return {"ok": False, "error": "claude CLI not found"}

    if not _login_pid or not _login_child_alive():
        return {"ok": False, "error": "No active login session. Click 'Login to Claude' first."}

    if _login_pty_fd is None:
        return {"ok": False, "error": "PTY not available. Click 'Login to Claude' to restart."}

    try:
        loop = asyncio.get_event_loop()

        def _write_and_wait():
            # Write the code + Enter to the PTY master fd
            os.write(_login_pty_fd, (code + "\n").encode())
            log.info("[AUTH] Code written to PTY")

            # Read any output from claude after submitting
            output = ""
            end_time = time.time() + 30
            while time.time() < end_time:
                text = _read_pty_output(_login_pty_fd, timeout=2.0)
                if text:
                    output += text
                    log.debug("[AUTH][PTY response] %s", text.replace("\n", " | ")[:200])
                # Check if process exited
                try:
                    wpid, status = os.waitpid(_login_pid, os.WNOHANG)
                    if wpid != 0:
                        log.info("[AUTH] Process exited with status %d", status)
                        return output, status
                except ChildProcessError:
                    return output, -1
            return output, None  # Still running after timeout

        output, exit_status = await asyncio.wait_for(
            loop.run_in_executor(None, _write_and_wait),
            timeout=40
        )
        log.info("[AUTH] PTY write result: exit_status=%s, output_len=%d", exit_status, len(output))

        # Check if we're authenticated now
        authenticated = await _check_claude_authenticated(claude_path)
        _cleanup_login()

        if authenticated:
            log.info("[AUTH] Authentication successful!")
            return {"ok": True}
        else:
            return {
                "ok": False,
                "error": f"Login did not succeed (exit: {exit_status}). The code may be expired — try again.",
                "output": output[:500],
            }

    except Exception as e:
        log.error("[AUTH] Complete error: %s", e, exc_info=True)
        _cleanup_login()
        return {"ok": False, "error": str(e)}


@app.get("/auth/status")
async def auth_status():
    """Check whether authentication has completed."""
    claude_path = shutil.which("claude")
    if not claude_path:
        return {"ok": False, "error": "claude CLI not found"}

    authenticated = await _check_claude_authenticated(claude_path)
    if authenticated:
        _cleanup_login()
        return {"ok": True, "authenticated": True}

    login_active = _login_pid is not None and _login_child_alive()
    return {"ok": True, "authenticated": False, "login_active": login_active}


# ── Query (legacy) ───────────────────────────────────────────────

@app.post("/query", response_model=QueryResponse)
async def query_claude(request: QueryRequest):
    """Run `claude -p <prompt>` on the host and return the text output."""
    claude_path = _get_claude_path()

    cmd = [claude_path, "-p", request.prompt, "--output-format", "text"]
    if request.model:
        cmd += ["--model", request.model]

    log.info("=" * 70)
    log.info("[QUERY] Model: %s", request.model or "default")
    log.info("[QUERY] Prompt: %s", request.prompt[:200])
    log.info("[QUERY] Command: %s", " ".join(cmd[:4]) + " ...")

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=_clean_env(),
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=QUERY_TIMEOUT)

        stderr_text = stderr.decode().strip()
        if stderr_text:
            log.debug("[QUERY] stderr: %s", stderr_text[:500])

        if proc.returncode != 0:
            log.error("[QUERY] claude exited %d: %s", proc.returncode, stderr_text[:300])
            return QueryResponse(ok=False, error=f"claude exited {proc.returncode}: {stderr_text}")

        result = stdout.decode().strip()
        log.info("[QUERY] Response (%d chars): %s", len(result), result[:300])
        return QueryResponse(ok=True, text=result)

    except asyncio.TimeoutError:
        log.error("[QUERY] Timed out after %ds", QUERY_TIMEOUT)
        return QueryResponse(ok=False, error=f"claude CLI timed out after {QUERY_TIMEOUT} s")
    except Exception as e:
        log.error("[QUERY] Error: %s", e)
        return QueryResponse(ok=False, error=str(e))


# ── Generate Test (MCP) ──────────────────────────────────────────

# Track the active generation subprocess so it can be cancelled
_active_generation_proc: Optional[asyncio.subprocess.Process] = None
_active_generation_id: Optional[str] = None


@app.post("/cancel-generation")
async def cancel_generation():
    """Cancel the currently running test generation."""
    global _active_generation_proc, _active_generation_id
    if _active_generation_proc and _active_generation_proc.returncode is None:
        log.info("[GENERATE] Cancelling generation %s (pid=%d)", _active_generation_id, _active_generation_proc.pid)
        try:
            _active_generation_proc.terminate()
            await asyncio.sleep(0.5)
            if _active_generation_proc.returncode is None:
                _active_generation_proc.kill()
        except ProcessLookupError:
            pass
        _active_generation_proc = None
        _active_generation_id = None
        return {"ok": True, "message": "Generation cancelled"}
    return {"ok": True, "message": "No active generation to cancel"}


@app.post("/generator/cancel-generation")
async def cancel_generation_prefixed():
    """Backward-compatible alias when hitting generator directly with /generator/* paths."""
    return await cancel_generation()


@app.post("/generate-test", response_model=GenerateTestResponse)
async def generate_test(request: GenerateTestRequest):
    """Use Claude CLI + Playwright MCP to navigate a page and generate a .spec.ts test."""
    claude_path = _get_claude_path()

    if not MCP_CONFIG_PATH.exists():
        log.error("[GENERATE] MCP config not found at %s", MCP_CONFIG_PATH)
        return GenerateTestResponse(
            ok=False,
            error=f"MCP config not found at {MCP_CONFIG_PATH}. Create it with Playwright MCP server configuration.",
        )

    # Build test name and ID
    test_id = str(uuid.uuid4())[:8]
    raw_name = request.test_name or request.prompt[:60]
    test_name = _sanitize_name(raw_name)
    filename = f"{test_name}-{test_id}.spec.ts"

    log.info("=" * 70)
    log.info("[GENERATE] New test generation request")
    log.info("[GENERATE] Model: %s", request.model or "default")
    log.info("[GENERATE] Test ID: %s | Name: %s", test_id, test_name)
    log.info("[GENERATE] Target URL: %s", request.target_url)
    log.info("[GENERATE] Prompt: %s", request.prompt[:300])
    log.info("[GENERATE] MCP config: %s", MCP_CONFIG_PATH)

    # Build prompt and command — fast mode skips MCP browser tools
    if request.validate:
        full_prompt = _build_mcp_prompt(request.prompt, request.target_url)
        cmd = [claude_path, "-p", full_prompt, "--output-format", "text", "--mcp-config", str(MCP_CONFIG_PATH)]
    else:
        full_prompt = _build_fast_prompt(request.prompt, request.target_url)
        cmd = [claude_path, "-p", full_prompt, "--output-format", "text"]

    if request.model:
        cmd += ["--model", request.model]

    log.info("[GENERATE] Running Claude CLI (timeout=%ds)...", MCP_TIMEOUT)
    log.debug("[GENERATE] Full command: %s", " ".join(cmd[:6]) + " ...")

    try:
        global _active_generation_proc, _active_generation_id
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=_clean_env(),
            cwd=str(BACKEND_DIR),
        )
        _active_generation_proc = proc
        _active_generation_id = test_id

        # Stream stderr in real-time for progress visibility
        async def _log_stderr():
            while True:
                line = await proc.stderr.readline()
                if not line:
                    break
                text = line.decode().rstrip()
                if text:
                    log.info("[GENERATE][claude] %s", text)

        stderr_task = asyncio.create_task(_log_stderr())
        stdout_bytes = await asyncio.wait_for(proc.stdout.read(), timeout=MCP_TIMEOUT)
        await proc.wait()
        await stderr_task
        _active_generation_proc = None
        _active_generation_id = None

        if proc.returncode != 0:
            log.error("[GENERATE] Claude exited with code %d", proc.returncode)
            return GenerateTestResponse(
                ok=False,
                test_id=test_id,
                error=f"claude exited {proc.returncode}",
            )

        raw_output = stdout_bytes.decode().strip()
        log.info("[GENERATE] Claude returned %d chars of output", len(raw_output))
        log.debug("[GENERATE] Raw output (first 500): %s", raw_output[:500])
        spec_code = _extract_spec_code(raw_output)

        if not spec_code:
            log.warning("[GENERATE] No TypeScript code block found in output")
            log.warning("[GENERATE] Full output:\n%s", raw_output[:2000])
            return GenerateTestResponse(
                ok=False,
                test_id=test_id,
                error="No TypeScript code block found in Claude's output",
                execution_log=raw_output[:2000],
            )

        log.info("[GENERATE] Extracted spec code: %d chars", len(spec_code))
        log.info("[GENERATE] First 300 chars of spec:\n%s", spec_code[:300])

        # Determine save location: scoped (account/project) or legacy
        if request.account_slug and request.project_slug:
            save_dir = (TESTS_STORE_ROOT / "accounts" / request.account_slug
                        / "projects" / request.project_slug / "tests" / "pending")
            save_dir.mkdir(parents=True, exist_ok=True)
        else:
            save_dir = GENERATED_TESTS_DIR

        # Save the generated test file
        spec_path = save_dir / filename
        spec_path.write_text(spec_code, encoding="utf-8")
        log.info("[GENERATE] Saved test file: %s", spec_path)

        if request.validate:
            # Reasoning mode: validate + auto-fix loop
            validation_passed = False
            log.info("[GENERATE] Reasoning mode: validating generated test on runner...")
            try:
                validation = await _validate_spec_on_runner(str(spec_path))
            except Exception as ve:
                log.warning("[GENERATE] Validation call failed: %s — saving as-is", ve)
                validation = None

            if validation and validation.get("ok") and validation.get("report", {}).get("status") == "passed":
                validation_passed = True
                log.info("[GENERATE] Validation passed on first attempt.")
            elif validation:
                report = validation.get("report", {})
                failed_tests = [t for t in report.get("tests", []) if t.get("status") in ("failed", "timedOut")]
                report_error = report.get("error") or ""
                test_errors = "; ".join(t.get("error", "unknown error") for t in failed_tests) if failed_tests else ""
                error_summary = "; ".join(filter(None, [test_errors, report_error])) or "Unknown failure"
                log.warning("[GENERATE] Validation failed: %s", error_summary[:300])

                for attempt in range(1, MAX_FIX_ATTEMPTS + 1):
                    log.info("[GENERATE] Auto-fix attempt %d/%d...", attempt, MAX_FIX_ATTEMPTS)
                    fixed_code = await _regenerate_with_fix(
                        claude_path, request.prompt, request.target_url,
                        spec_code, error_summary, request.model,
                    )
                    if not fixed_code:
                        log.warning("[GENERATE] Fix attempt %d produced no code.", attempt)
                        continue
                    spec_code = fixed_code
                    spec_path.write_text(spec_code, encoding="utf-8")
                    try:
                        validation = await _validate_spec_on_runner(str(spec_path))
                    except Exception:
                        validation = None
                    if validation and validation.get("ok") and validation.get("report", {}).get("status") == "passed":
                        validation_passed = True
                        log.info("[GENERATE] Fix attempt %d succeeded.", attempt)
                        break
                    new_report = validation.get("report", {}) if validation else {}
                    new_failed = [t for t in new_report.get("tests", []) if t.get("status") in ("failed", "timedOut")]
                    new_report_error = new_report.get("error") or ""
                    new_test_errors = "; ".join(t.get("error", "unknown") for t in new_failed) if new_failed else ""
                    error_summary = "; ".join(filter(None, [new_test_errors, new_report_error])) or "Still failing"
                    log.warning("[GENERATE] Re-validation failed after fix %d: %s", attempt, error_summary[:300])
                else:
                    log.warning("[GENERATE] All %d fix attempts exhausted. Saving best version.", MAX_FIX_ATTEMPTS)
        else:
            # Fast mode: skip validation entirely
            validation_passed = True
            log.info("[GENERATE] Fast mode: skipping validation.")

        # Save final spec (may be the fixed version in reasoning mode)
        spec_path.write_text(spec_code, encoding="utf-8")

        # Save metadata alongside the test
        meta = {
            "test_id": test_id,
            "test_name": test_name,
            "filename": filename,
            "target_url": request.target_url,
            "prompt": request.prompt,
            "created_at": datetime.utcnow().isoformat(),
            "validation_status": "passed" if validation_passed else "failed",
            "generation_mode": "reasoning" if request.validate else "fast",
        }
        if request.account_slug and request.project_slug:
            meta["status"] = "pending"
            meta["account_slug"] = request.account_slug
            meta["project_slug"] = request.project_slug

        meta_path = save_dir / f"{test_name}-{test_id}.meta.json"
        meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
        log.info("[GENERATE] Saved metadata: %s", meta_path)

        # Register with registry if scoped
        auth_token = request.session_token or request.access_key
        if request.account_slug and request.project_slug and auth_token:
            try:
                headers = {}
                if request.session_token:
                    headers["Authorization"] = f"Bearer {request.session_token}"
                else:
                    headers["X-Access-Key"] = request.access_key
                async with httpx.AsyncClient() as client:
                    await client.post(
                        f"{REGISTRY_URL}/tests",
                        json={
                            "test_name": test_name,
                            "spec_code": spec_code,
                            "target_url": request.target_url,
                            "prompt": request.prompt,
                        },
                        headers=headers,
                        timeout=10,
                    )
            except Exception as e:
                log.warning("[GENERATE] Failed to register with registry: %s", e)

        log.info("=" * 70)
        log.info("[GENERATE] %s — test_id=%s, file=%s",
                 "SUCCESS" if validation_passed else "SAVED (validation failed)",
                 test_id, filename)
        log.info("=" * 70)

        return GenerateTestResponse(
            ok=validation_passed,
            test_id=test_id,
            test_name=test_name,
            spec_code=spec_code,
            file_path=str(spec_path),
            execution_log=raw_output if raw_output != spec_code else "",
            error="" if validation_passed else f"Test could not be validated after {MAX_FIX_ATTEMPTS} fix attempts",
        )

    except asyncio.TimeoutError:
        _active_generation_proc = None
        _active_generation_id = None
        return GenerateTestResponse(
            ok=False,
            test_id=test_id,
            error=f"claude CLI timed out after {MCP_TIMEOUT} s (MCP browser interaction may be slow)",
        )
    except asyncio.CancelledError:
        _active_generation_proc = None
        _active_generation_id = None
        return GenerateTestResponse(ok=False, test_id=test_id, error="Generation was cancelled")
    except Exception as e:
        _active_generation_proc = None
        _active_generation_id = None
        log.error("[GENERATE] Unexpected error: %s", e, exc_info=True)
        return GenerateTestResponse(ok=False, test_id=test_id, error=str(e))


@app.post("/generator/generate-test", response_model=GenerateTestResponse)
async def generate_test_prefixed(request: GenerateTestRequest):
    """Backward-compatible alias when hitting generator directly with /generator/* paths."""
    return await generate_test(request)


# ── Streaming Generate + Validate + Fix ───────────────────────────

MAX_FIX_ATTEMPTS = 3  # How many times to retry fixing a failing test


def _sse(event: str, data: dict) -> str:
    """Format a Server-Sent Event."""
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


async def _validate_spec_on_runner(spec_path: str) -> dict:
    """Run a generated spec file on the Runner service and return the report."""
    async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=10.0)) as client:
        resp = await client.post(
            f"{RUNNER_URL}/run-spec",
            json={"spec_path": spec_path, "browsers": ["chromium"], "trace": False, "video": False, "screenshots": True},
        )
        return resp.json()


async def _regenerate_with_fix(claude_path: str, original_prompt: str, target_url: str,
                                spec_code: str, error_info: str, model: str | None) -> str | None:
    """Ask Claude to fix a failing spec using code-only analysis (no MCP/browser, fast)."""
    fix_prompt = f"""Fix this Playwright TypeScript test that failed. Return ONLY the fixed TypeScript code block, nothing else.

ERRORS:
{error_info[:2000]}

CURRENT TEST CODE:
```typescript
{spec_code}
```

Common fixes:
- Prefer getByRole(), getByText(), getByLabel(), getByPlaceholder() over CSS selectors
- Add missing await keywords
- Add waitForLoadState('networkidle') after page.goto()
- Fix URL paths (relative vs absolute)
- Use page.locator() with a more stable selector if element not found"""

    # No --mcp-config: fix via code analysis only — much faster than MCP browsing
    cmd = [claude_path, "-p", fix_prompt, "--output-format", "text"]
    if model:
        cmd += ["--model", model]

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env=_clean_env(), cwd=str(BACKEND_DIR),
        )
        stdout_bytes = await asyncio.wait_for(proc.stdout.read(), timeout=QUERY_TIMEOUT)
        await proc.wait()
        if proc.returncode != 0:
            return None
        raw = stdout_bytes.decode().strip()
        return _extract_spec_code(raw)
    except Exception as e:
        log.error("[GENERATE-FIX] Fix attempt failed: %s", e)
        return None


@app.post("/generate-test-stream")
async def generate_test_stream(request: GenerateTestRequest):
    """
    SSE endpoint: generate → validate → fix (if needed) → done.
    Streams progress events so the UI can show live phase updates.
    """
    claude_path = _get_claude_path()

    if not MCP_CONFIG_PATH.exists():
        async def err_stream():
            yield _sse("error", {"error": f"MCP config not found at {MCP_CONFIG_PATH}"})
        return StreamingResponse(err_stream(), media_type="text/event-stream")

    test_id = str(uuid.uuid4())[:8]
    raw_name = request.test_name or request.prompt[:60]
    test_name = _sanitize_name(raw_name)
    filename = f"{test_name}-{test_id}.spec.ts"

    async def event_stream():
        # Phase 1: Generating
        if request.validate:
            gen_msg = "Generating test with Claude + Playwright MCP (Reasoning mode)..."
        else:
            gen_msg = "Generating test with Claude (Fast mode)..."
        yield _sse("phase", {"phase": "generating", "message": gen_msg,
                              "test_id": test_id, "test_name": test_name, "target_url": request.target_url})

        validation_passed = False
        log.info("[GENERATE-STREAM] Starting generation (%s): %s → %s",
                 "reasoning" if request.validate else "fast", test_id, request.target_url)

        model_label = re.sub(r"-\d{8}$", "", request.model or "default")
        if request.validate:
            full_prompt = _build_mcp_prompt(request.prompt, request.target_url)
            cmd = [claude_path, "-p", full_prompt, "--output-format", "stream-json", "--verbose",
                   "--mcp-config", str(MCP_CONFIG_PATH)]
            mode_label = f"🤔 Reasoning mode — {model_label} | MCP browser enabled"
        else:
            full_prompt = _build_fast_prompt(request.prompt, request.target_url)
            cmd = [claude_path, "-p", full_prompt, "--output-format", "stream-json", "--verbose"]
            mode_label = f"⚡ Fast mode — {model_label}"

        if request.model:
            cmd += ["--model", request.model]

        try:
            global _active_generation_proc, _active_generation_id
            proc = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                env=_clean_env(), cwd=str(BACKEND_DIR),
            )
            _active_generation_proc = proc
            _active_generation_id = test_id

            # Emit mode banner as the first log line
            yield _sse("log", {"text": mode_label, "phase": "generating"})

            # Stream stderr (MCP tool calls) and stdout (text/thinking chunks) concurrently.
            # Both tasks feed a shared log_queue; main loop drains it every 2s as SSE log events.
            _STDERR_PATTERNS = (
                "browser_", "navigate", "snapshot", "click", "fill",
                "select", "scroll", "hover", "press", "type", "wait",
                "Tool", "Using", "▶", "✓", "✗", "Error", "Warning", "tool",
                "Analyzing", "Reading", "Found", "Selector",
            )
            log_queue: asyncio.Queue = asyncio.Queue()
            _stdout_result: list[str] = []  # final text from result event

            async def _collect_stderr():
                while True:
                    line = await proc.stderr.readline()
                    if not line:
                        break
                    text = line.decode().rstrip()
                    if text:
                        log.info("[GENERATE-STREAM][claude] %s", text)
                        if any(p in text for p in _STDERR_PATTERNS):
                            await log_queue.put(text)

            async def _collect_stdout():
                """Parse stream-json lines; emit text/thinking previews and capture final result."""
                while True:
                    line = await proc.stdout.readline()
                    if not line:
                        break
                    raw = line.decode().rstrip()
                    if not raw:
                        continue
                    try:
                        event = json.loads(raw)
                        evt_type = event.get("type", "")
                        if evt_type == "assistant":
                            for block in event.get("message", {}).get("content", []):
                                btype = block.get("type", "")
                                if btype == "thinking":
                                    t = (block.get("thinking") or "").replace("\n", " ").strip()
                                    if t:
                                        await log_queue.put(f"💭 {t[:120]}")
                                elif btype == "text":
                                    t = (block.get("text") or "").replace("\n", " ").strip()
                                    if t and not t.startswith("```"):
                                        await log_queue.put(t[:120])
                        elif evt_type == "result":
                            result_text = event.get("result", "")
                            if result_text:
                                _stdout_result.append(result_text)
                    except (json.JSONDecodeError, KeyError):
                        # Fallback: plain text line
                        if raw.strip():
                            _stdout_result.append(raw)

            stderr_task = asyncio.create_task(_collect_stderr())
            stdout_task = asyncio.create_task(_collect_stdout())

            deadline = asyncio.get_event_loop().time() + MCP_TIMEOUT
            while not (stderr_task.done() and stdout_task.done()):
                remaining = deadline - asyncio.get_event_loop().time()
                if remaining <= 0:
                    stderr_task.cancel()
                    stdout_task.cancel()
                    raise asyncio.TimeoutError()
                pending = {t for t in (stderr_task, stdout_task) if not t.done()}
                await asyncio.wait(pending, timeout=2.0)
                while not log_queue.empty():
                    txt = log_queue.get_nowait()
                    yield _sse("log", {"text": txt, "phase": "generating"})

            await proc.wait()
            _active_generation_proc = None
            _active_generation_id = None
            # Drain any lines that arrived after tasks finished
            while not log_queue.empty():
                txt = log_queue.get_nowait()
                yield _sse("log", {"text": txt, "phase": "generating"})

            if proc.returncode != 0:
                yield _sse("error", {"error": f"Claude exited with code {proc.returncode}", "phase": "generating"})
                return

            raw_output = ("".join(_stdout_result)).strip()
            spec_code = _extract_spec_code(raw_output)
            if not spec_code:
                yield _sse("error", {"error": "No TypeScript code block found in Claude's output", "phase": "generating"})
                return

            yield _sse("phase", {"phase": "generated", "message": f"Test generated ({len(spec_code)} chars). Validating...",
                                  "spec_lines": len(spec_code.splitlines())})

            # Save spec to disk for validation
            if request.account_slug and request.project_slug:
                save_dir = (TESTS_STORE_ROOT / "accounts" / request.account_slug
                            / "projects" / request.project_slug / "tests" / "pending")
                save_dir.mkdir(parents=True, exist_ok=True)
            else:
                save_dir = GENERATED_TESTS_DIR

            spec_path = save_dir / filename
            spec_path.write_text(spec_code, encoding="utf-8")

            validation = None

            if request.validate:
                # Phase 2 (Reasoning mode): Validate → auto-fix loop
                yield _sse("phase", {"phase": "validating", "message": "Running headless validation on Chromium..."})

                try:
                    # Wrap in asyncio.wait so we can emit heartbeat log lines while runner is blocking
                    _val_start = asyncio.get_event_loop().time()
                    _validate_task = asyncio.ensure_future(_validate_spec_on_runner(str(spec_path)))
                    while not _validate_task.done():
                        await asyncio.wait({_validate_task}, timeout=5.0)
                        if not _validate_task.done():
                            _elapsed_val = int(asyncio.get_event_loop().time() - _val_start)
                            yield _sse("log", {"text": f"Playwright running... ({_elapsed_val}s)", "phase": "validating"})
                    validation = await _validate_task
                except Exception as ve:
                    log.warning("[GENERATE-STREAM] Validation call failed: %s", ve)
                    yield _sse("phase", {"phase": "validation_skipped",
                                          "message": f"Could not reach runner for validation: {ve}. Saving as-is."})

                if validation and validation.get("ok") and validation.get("report", {}).get("status") == "passed":
                    validation_passed = True
                    yield _sse("phase", {"phase": "validated", "message": "Validation passed! All tests green.",
                                          "report": validation.get("report", {})})
                elif validation:
                    # Validation failed — try to fix
                    report = validation.get("report", {})
                    failed_tests = [t for t in report.get("tests", []) if t.get("status") in ("failed", "timedOut")]
                    report_error = report.get("error") or ""
                    test_errors = "; ".join(t.get("error", "unknown error") for t in failed_tests) if failed_tests else ""
                    error_summary = "; ".join(filter(None, [test_errors, report_error])) or "Unknown failure"

                    for attempt in range(1, MAX_FIX_ATTEMPTS + 1):
                        yield _sse("phase", {
                            "phase": "fixing", "attempt": attempt, "max_attempts": MAX_FIX_ATTEMPTS,
                            "message": f"Validation failed. Auto-fixing (attempt {attempt}/{MAX_FIX_ATTEMPTS})...",
                            "error": error_summary,  # full text, no truncation
                            "failed_tests": [{"title": t.get("title", "?"), "error": t.get("error", "")}
                                             for t in failed_tests],
                        })

                        fixed_code = await _regenerate_with_fix(
                            claude_path, request.prompt, request.target_url,
                            spec_code, error_summary, request.model,
                        )

                        if not fixed_code:
                            yield _sse("phase", {"phase": "fix_failed", "attempt": attempt,
                                                  "message": f"Fix attempt {attempt} did not produce valid code."})
                            continue

                        spec_code = fixed_code
                        spec_path.write_text(spec_code, encoding="utf-8")
                        yield _sse("phase", {"phase": "revalidating", "attempt": attempt,
                                              "message": f"Re-validating fixed test (attempt {attempt})..."})

                        try:
                            _val_start2 = asyncio.get_event_loop().time()
                            _revalidate_task = asyncio.ensure_future(_validate_spec_on_runner(str(spec_path)))
                            while not _revalidate_task.done():
                                await asyncio.wait({_revalidate_task}, timeout=5.0)
                                if not _revalidate_task.done():
                                    _elapsed_rv = int(asyncio.get_event_loop().time() - _val_start2)
                                    yield _sse("log", {"text": f"Playwright running... ({_elapsed_rv}s)", "phase": "validating"})
                            validation = await _revalidate_task
                        except Exception:
                            validation = None

                        if validation and validation.get("ok") and validation.get("report", {}).get("status") == "passed":
                            validation_passed = True
                            yield _sse("phase", {"phase": "validated", "attempt": attempt,
                                                  "message": f"Fix successful! Test passes after attempt {attempt}.",
                                                  "report": validation.get("report", {})})
                            break
                        else:
                            new_report = validation.get("report", {}) if validation else {}
                            new_failed = [t for t in new_report.get("tests", []) if t.get("status") in ("failed", "timedOut")]
                            new_report_error = new_report.get("error") or ""
                            new_test_errors = "; ".join(t.get("error", "unknown") for t in new_failed) if new_failed else ""
                            error_summary = "; ".join(filter(None, [new_test_errors, new_report_error])) or "Still failing"
                            # Update failed_tests for the next fixing iteration
                            failed_tests = new_failed
                    else:
                        yield _sse("phase", {"phase": "fix_exhausted",
                                              "message": f"Could not auto-fix after {MAX_FIX_ATTEMPTS} attempts. Saving best version.",
                                              "error": error_summary,  # full text, no truncation
                                              "failed_tests": [{"title": t.get("title", "?"), "error": t.get("error", "")}
                                                               for t in failed_tests]})
            else:
                # Fast mode: skip validation
                validation_passed = True
                yield _sse("phase", {"phase": "validation_skipped",
                                      "message": "Fast mode: skipping validation. Test saved as generated."})

            # Phase 3: Save final result
            spec_path.write_text(spec_code, encoding="utf-8")

            # Save metadata
            meta = {
                "test_id": test_id, "test_name": test_name, "filename": filename,
                "target_url": request.target_url, "prompt": request.prompt,
                "created_at": datetime.utcnow().isoformat(),
                "validation_status": "passed" if validation_passed else "failed",
                "generation_mode": "reasoning" if request.validate else "fast",
            }
            if request.account_slug and request.project_slug:
                meta["status"] = "pending"
                meta["account_slug"] = request.account_slug
                meta["project_slug"] = request.project_slug

            meta_path = save_dir / f"{test_name}-{test_id}.meta.json"
            meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

            # Register with registry if scoped
            auth_token = request.session_token or request.access_key
            if request.account_slug and request.project_slug and auth_token:
                try:
                    headers = {}
                    if request.session_token:
                        headers["Authorization"] = f"Bearer {request.session_token}"
                    else:
                        headers["X-Access-Key"] = request.access_key
                    async with httpx.AsyncClient() as client:
                        await client.post(
                            f"{REGISTRY_URL}/tests",
                            json={"test_name": test_name, "spec_code": spec_code,
                                  "target_url": request.target_url, "prompt": request.prompt},
                            headers=headers, timeout=10,
                        )
                except Exception as e:
                    log.warning("[GENERATE-STREAM] Registry register failed: %s", e)

            # Final done event with all data
            yield _sse("done", {
                "ok": validation_passed,
                "test_id": test_id,
                "test_name": test_name,
                "spec_code": spec_code,
                "file_path": str(spec_path),
                "validation": validation.get("report", {}) if validation else None,
            })

        except asyncio.TimeoutError:
            _active_generation_proc = None
            _active_generation_id = None
            yield _sse("error", {"error": f"Claude CLI timed out after {MCP_TIMEOUT}s", "phase": "generating"})
        except asyncio.CancelledError:
            _active_generation_proc = None
            _active_generation_id = None
            yield _sse("error", {"error": "Generation was cancelled", "phase": "generating"})
        except Exception as e:
            _active_generation_proc = None
            _active_generation_id = None
            log.error("[GENERATE-STREAM] Error: %s", e, exc_info=True)
            yield _sse("error", {"error": str(e), "phase": "unknown"})

    return StreamingResponse(event_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/generator/generate-test-stream")
async def generate_test_stream_prefixed(request: GenerateTestRequest):
    """Backward-compatible alias when hitting generator directly with /generator/* paths."""
    return await generate_test_stream(request)


# ── Fix Step (AI-assisted step repair) ────────────────────────────

@app.post("/fix-step", response_model=FixStepResponse)
async def fix_step(request: FixStepRequest):
    """Use Claude CLI + Playwright MCP to inspect the live page and fix a failed step."""
    claude_path = _get_claude_path()

    log.info("=" * 70)
    log.info("[FIX-STEP] Model: %s", request.model or "default")
    log.info("[FIX-STEP] Analyzing failed step via Playwright MCP")
    log.info("[FIX-STEP] Step type: %s", request.failed_step.get("type", "unknown"))
    log.info("[FIX-STEP] Page URL: %s", request.page_url)
    log.info("[FIX-STEP] Prompt length: %d chars", len(request.prompt))

    use_mcp = MCP_CONFIG_PATH.exists()
    if not use_mcp:
        log.warning("[FIX-STEP] MCP config not found at %s — falling back to prompt-only mode", MCP_CONFIG_PATH)

    # Build the prompt — includes the analysis context from the SW
    # plus instructions for MCP browser interaction
    step_type = request.failed_step.get("type", "unknown")
    selector_primary = request.failed_step.get("selector", {}).get("primary", {})
    selector_val = selector_primary.get("value", "none")
    step_value = request.failed_step.get("value", "")
    element_name = request.failed_step.get("elementName", request.failed_step.get("customName", ""))

    mcp_instructions = ""
    if use_mcp:
        mcp_instructions = f"""
## IMPORTANT: Use the Playwright MCP browser tools to heal this step

1. First, use the browser_navigate tool to go to: {request.page_url}
2. Use the browser_snapshot tool to capture the current page state
3. Analyze the page snapshot to find the element that matches the intent of the failed step:
   - Step type: {step_type}
   - Element: {element_name}
   - Original selector: {selector_val}
   - Value: {step_value if step_value else 'N/A'}
4. Identify the correct selector for the element on the CURRENT page
5. Prefer stable selectors: data-testid > aria-label > role+name > id > CSS class path
"""

    full_prompt = f"""{request.prompt}
{mcp_instructions}
IMPORTANT: Your response must be ONLY a single valid JSON object (no markdown, no explanation outside JSON).
The JSON must have these fields:
{{
  "type": "{step_type}",
  "selector": {{
    "primary": {{ "type": "css|text|xpath", "value": "the correct selector" }},
    "fallbacks": [ {{ "type": "css|text|xpath", "value": "alternative selector" }} ]
  }},
  "value": {f'"{step_value}"' if step_value else 'null'},
  "elementName": "human-readable description of the element"
}}

Return ONLY the JSON object, nothing else."""

    # Build command — use MCP config if available (enables live browser inspection)
    cmd = [claude_path, "-p", full_prompt, "--output-format", "text"]
    if use_mcp:
        cmd += ["--mcp-config", str(MCP_CONFIG_PATH)]
    if request.model:
        cmd += ["--model", request.model]

    timeout = MCP_TIMEOUT if use_mcp else QUERY_TIMEOUT
    log.info("[FIX-STEP] Running Claude CLI (MCP=%s, timeout=%ds)...", use_mcp, timeout)

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=_clean_env(),
            cwd=str(BACKEND_DIR),
        )

        # Stream stderr for visibility
        async def _log_stderr():
            while True:
                line = await proc.stderr.readline()
                if not line:
                    break
                text = line.decode().rstrip()
                if text:
                    log.info("[FIX-STEP][claude] %s", text)

        stderr_task = asyncio.create_task(_log_stderr())
        stdout_bytes = await asyncio.wait_for(proc.stdout.read(), timeout=timeout)
        await proc.wait()
        await stderr_task

        if proc.returncode != 0:
            log.error("[FIX-STEP] claude exited %d", proc.returncode)
            return FixStepResponse(ok=False, error=f"claude exited {proc.returncode}")

        raw_output = stdout_bytes.decode().strip()
        log.info("[FIX-STEP] Claude returned %d chars", len(raw_output))
        log.debug("[FIX-STEP] Raw output: %s", raw_output[:500])

        # Parse the JSON response
        fixed_step = _extract_json(raw_output)
        if not fixed_step:
            log.warning("[FIX-STEP] Could not parse JSON from output")
            return FixStepResponse(ok=False, error="Could not parse AI response as JSON", explanation=raw_output[:500])

        # Validate required fields
        if "type" not in fixed_step or "selector" not in fixed_step:
            log.warning("[FIX-STEP] Missing required fields in response")
            return FixStepResponse(ok=False, error="AI response missing 'type' or 'selector'", explanation=raw_output[:500])

        log.info("[FIX-STEP] SUCCESS — type=%s, selector=%s",
                 fixed_step.get("type"), fixed_step.get("selector", {}).get("primary", {}).get("value", "?"))

        return FixStepResponse(
            ok=True,
            fixed_step=fixed_step,
            explanation=fixed_step.get("explanation", ""),
        )

    except asyncio.TimeoutError:
        log.error("[FIX-STEP] Timed out after %ds", timeout)
        return FixStepResponse(ok=False, error=f"claude CLI timed out after {timeout}s")
    except Exception as e:
        log.error("[FIX-STEP] Error: %s", e, exc_info=True)
        return FixStepResponse(ok=False, error=str(e))


def _extract_json(text: str) -> Optional[dict]:
    """Extract a JSON object from Claude's response text."""

    # Try direct parse first
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Try to find JSON in code block
    json_block = re.search(r"```(?:json)?\s*\n(.*?)```", text, re.DOTALL)
    if json_block:
        try:
            return json.loads(json_block.group(1).strip())
        except json.JSONDecodeError:
            pass

    # Try to find first { ... } block
    brace_match = re.search(r"\{.*\}", text, re.DOTALL)
    if brace_match:
        try:
            return json.loads(brace_match.group(0))
        except json.JSONDecodeError:
            pass

    return None


# ── Validate and Auto-Fix generated spec ─────────────────────────

@app.post("/validate-and-fix", response_model=ValidateAndFixResponse)
async def validate_and_fix(request: ValidateAndFixRequest):
    """Run a generated .spec.ts through the Playwright runner, auto-fix on failure, re-run.

    1. Run spec on runner → if passes, return immediately (no LLM needed)
    2. If fails → Claude code-only fix (no MCP, fast) → re-run on runner
    """
    spec_path = Path(request.spec_path)
    if not spec_path.exists():
        return ValidateAndFixResponse(ok=False, error=f"Spec not found: {request.spec_path}")

    runner_url = (request.runner_url or RUNNER_URL).rstrip("/")
    last_report: dict = {}
    last_artifacts: dict = {}

    for attempt in range(1, request.max_attempts + 1):
        log.info("[VALIDATE] Attempt %d/%d — running %s", attempt, request.max_attempts, spec_path.name)

        try:
            validation = await _validate_spec_on_runner(str(spec_path))
            last_report = validation.get("report", {})
            last_artifacts = validation.get("artifacts", {})
        except Exception as e:
            log.error("[VALIDATE] Runner error on attempt %d: %s", attempt, e)
            return ValidateAndFixResponse(ok=False, error=f"Runner error: {e}", attempts=attempt)

        if last_report.get("status") == "passed":
            log.info("[VALIDATE] PASSED on attempt %d", attempt)
            return ValidateAndFixResponse(
                ok=True, status="passed",
                spec_code=spec_path.read_text(encoding="utf-8"),
                fixed=(attempt > 1), attempts=attempt,
                report=last_report, artifacts=last_artifacts,
            )

        log.info("[VALIDATE] FAILED on attempt %d", attempt)
        if attempt >= request.max_attempts:
            break

        # Fast code-only fix (no MCP)
        tests = last_report.get("tests", [])
        errors = [t.get("error", "") for t in tests if t.get("error")]
        stderr_err = last_report.get("error", "")
        error_summary = "\n".join(filter(None, errors[:5])) or (stderr_err[:1000] if stderr_err else "Unknown error")

        try:
            claude_path = _get_claude_path()
            fixed_code = await _regenerate_with_fix(
                claude_path, "", "", spec_path.read_text(encoding="utf-8"), error_summary, None
            )
            if fixed_code:
                spec_path.write_text(fixed_code, encoding="utf-8")
                log.info("[VALIDATE] Auto-fix applied, re-running...")
            else:
                log.warning("[VALIDATE] Fix produced no code, stopping")
                break
        except Exception as e:
            log.error("[VALIDATE] Fix error: %s", e)
            break

    return ValidateAndFixResponse(
        ok=False, status="failed",
        spec_code=spec_path.read_text(encoding="utf-8"),
        fixed=False, attempts=request.max_attempts,
        report=last_report, artifacts=last_artifacts,
    )


@app.post("/generator/validate-and-fix", response_model=ValidateAndFixResponse)
async def validate_and_fix_prefixed(request: ValidateAndFixRequest):
    """Backward-compatible alias for orchestrator routing."""
    return await validate_and_fix(request)


# ── List / Get / Delete generated tests ──────────────────────────

@app.get("/tests")
async def list_tests():
    """List all generated test files."""
    tests = []
    for meta_file in sorted(GENERATED_TESTS_DIR.glob("*.meta.json"), reverse=True):
        try:
            meta = json.loads(meta_file.read_text(encoding="utf-8"))
            spec_file = GENERATED_TESTS_DIR / meta["filename"]
            if spec_file.exists():
                tests.append(TestInfo(
                    test_id=meta["test_id"],
                    test_name=meta["test_name"],
                    file_path=str(spec_file),
                    created_at=meta.get("created_at", ""),
                    target_url=meta.get("target_url", ""),
                    prompt=meta.get("prompt", ""),
                ))
        except (json.JSONDecodeError, KeyError):
            continue
    return {"ok": True, "tests": tests}


@app.get("/tests/{test_id}")
async def get_test(test_id: str):
    """Get the content of a generated test file."""
    # Find the spec file matching this test_id
    matches = list(GENERATED_TESTS_DIR.glob(f"*-{test_id}.spec.ts"))
    if not matches:
        raise HTTPException(status_code=404, detail=f"Test {test_id} not found")
    spec_path = matches[0]
    code = spec_path.read_text(encoding="utf-8")

    # Load metadata if available
    meta_matches = list(GENERATED_TESTS_DIR.glob(f"*-{test_id}.meta.json"))
    meta = {}
    if meta_matches:
        try:
            meta = json.loads(meta_matches[0].read_text(encoding="utf-8"))
        except (json.JSONDecodeError, KeyError):
            pass

    return {
        "ok": True,
        "test_id": test_id,
        "spec_code": code,
        "file_path": str(spec_path),
        "target_url": meta.get("target_url", ""),
        "prompt": meta.get("prompt", ""),
        "created_at": meta.get("created_at", ""),
    }


@app.delete("/tests/{test_id}")
async def delete_test(test_id: str):
    """Delete a generated test file and its metadata."""
    deleted = False
    for pattern in [f"*-{test_id}.spec.ts", f"*-{test_id}.meta.json"]:
        for f in GENERATED_TESTS_DIR.glob(pattern):
            f.unlink()
            deleted = True
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Test {test_id} not found")
    return {"ok": True, "deleted": test_id}


# ── Main ──────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8002)
