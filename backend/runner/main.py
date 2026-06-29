"""
Autotest Playwright Runner — FastAPI service for executing recorded tests
in headless Playwright browsers with full browser-level capabilities.

Capabilities over the Chrome extension:
- Multi-browser (Chromium, Firefox, WebKit)
- Network interception & API mocking
- Device/mobile emulation
- Geolocation, timezone, locale, permissions
- Trace recording & viewer
- HAR capture
- Video recording
- Parallel test execution
- API testing (no browser)
- Cross-origin iframe access
- Programmatic file upload
"""

import asyncio
import os
import subprocess
import sys

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from loguru import logger
from pathlib import Path

from .models import (
    ApiTestRequest,
    ArtifactPaths,
    RunParallelRequest,
    RunParallelResponse,
    RunRequest,
    RunResponse,
    RunSpecRequest,
    RunSpecResponse,
)
from .executor import ARTIFACTS_DIR, clear_progress, get_live_queue, get_progress, run_api_test, run_spec_file, run_test, run_tests_parallel


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

# Configure logging
logger.remove()
logger.add(
    sys.stderr,
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="<green>{time:YYYY-MM-DD HH:mm:ss}</green> | <level>{level: <8}</level> | <cyan>{name}</cyan>:<cyan>{function}</cyan>:<cyan>{line}</cyan> - <level>{message}</level>",
)

# Create FastAPI app
app = FastAPI(
    title="Autotest Playwright Runner",
    description="Headless browser test execution service for the Autotest Chrome extension",
    version="1.0.0",
)

# Configure CORS — allow all origins (extension service worker + local dev)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Health ────────────────────────────────────────────────────────

@app.get("/")
async def root():
    return {"status": "ok", "service": "autotest-playwright-runner", "version": "1.0.0"}


@app.get("/health")
async def health():
    # Check if Playwright browsers are installed
    browsers_ok = True
    try:
        from playwright.async_api import async_playwright
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(headless=True)
            await browser.close()
    except Exception as e:
        browsers_ok = False
        logger.warning(f"Browser health check failed: {e}")

    # Detect outbound IPs for bot-prevention whitelisting
    outbound_ips = _get_outbound_ips()

    return {
        "status": "healthy" if browsers_ok else "degraded",
        "service": "autotest-playwright-runner",
        "browsers_installed": browsers_ok,
        "artifacts_dir": str(ARTIFACTS_DIR),
        "outbound_ips": outbound_ips,
    }


# ── Run a single test ────────────────────────────────────────────

@app.post("/run", response_model=RunResponse)
async def run_test_endpoint(req: RunRequest):
    """Execute a recording in a headless Playwright browser."""
    try:
        mocks = [m.model_dump() for m in req.network_mocks] if req.network_mocks else None
        report, artifacts = await run_test(
            steps=req.steps,
            config=req.config,
            network_mocks=mocks,
            block_patterns=req.block_patterns or None,
            run_id=req.run_id or None,
        )

        # Build artifact URLs
        artifact_urls = {}
        if artifacts.trace:
            artifact_urls["traceUrl"] = f"/trace/{artifacts.run_id}"
        if artifacts.video:
            artifact_urls["videoUrl"] = f"/video/{artifacts.run_id}"
        if artifacts.har:
            artifact_urls["harUrl"] = f"/har/{artifacts.run_id}"
        if artifacts.screenshots:
            artifact_urls["screenshots"] = [
                f"/screenshot/{artifacts.run_id}/{s}" for s in artifacts.screenshots
            ]

        # Schedule deferred cleanup of progress data (client has ~30s to read final state)
        asyncio.get_event_loop().call_later(30, clear_progress, req.run_id or report.run_id)
        return RunResponse(ok=True, report=report, artifacts=artifact_urls)

    except Exception as e:
        logger.exception(f"Test execution failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── Run tests in parallel ────────────────────────────────────────

@app.post("/run-parallel", response_model=RunParallelResponse)
async def run_parallel_endpoint(req: RunParallelRequest):
    """Execute multiple tests in parallel."""
    try:
        results = await run_tests_parallel(
            tests=req.tests,
            max_workers=req.max_workers,
        )

        responses = []
        for report, artifacts in results:
            artifact_urls = {}
            if artifacts.trace:
                artifact_urls["traceUrl"] = f"/trace/{artifacts.run_id}"
            if artifacts.video:
                artifact_urls["videoUrl"] = f"/video/{artifacts.run_id}"
            if artifacts.har:
                artifact_urls["harUrl"] = f"/har/{artifacts.run_id}"
            if artifacts.screenshots:
                artifact_urls["screenshots"] = [
                    f"/screenshot/{artifacts.run_id}/{s}" for s in artifacts.screenshots
                ]
            responses.append(RunResponse(ok=True, report=report, artifacts=artifact_urls))

        return RunParallelResponse(ok=True, results=responses)

    except Exception as e:
        logger.exception(f"Parallel test execution failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── Run a .spec.ts file ──────────────────────────────────────────

def _resolve_spec_path(spec_path: str) -> str:
    """Translate host paths to container paths when running inside Docker."""
    import re as _re
    import os as _os
    TESTS_STORE_ROOT = _os.getenv("TESTS_STORE_ROOT", "/app/tests-store")

    # 1. Match paths ending with generated-tests/<filename>
    m = _re.search(r"generated-tests[/\\](.+)$", spec_path)
    if m and not Path(spec_path).exists():
        container_path = f"/app/generated-tests/{m.group(1)}"
        if Path(container_path).exists():
            logger.info(f"Mapped host path to container: {spec_path} -> {container_path}")
            return container_path

    # 2. Match tests-store scoped paths (accounts/<acct>/projects/<proj>/tests/...)
    m2 = _re.search(r"tests-store[/\\](.+)$", spec_path)
    if m2 and not Path(spec_path).exists():
        container_path = f"{TESTS_STORE_ROOT}/{m2.group(1)}"
        if Path(container_path).exists():
            logger.info(f"Mapped host path to container: {spec_path} -> {container_path}")
            return container_path

    return spec_path


@app.post("/run-spec", response_model=RunSpecResponse)
async def run_spec_endpoint(req: RunSpecRequest):
    """Execute a .spec.ts file via `npx playwright test` and return results with artifacts."""
    try:
        report, artifact_urls = await run_spec_file(
            spec_path=_resolve_spec_path(req.spec_path),
            base_url=req.base_url or None,
            headed=req.headed,
            browsers=req.browsers,
            trace=req.trace,
            video=req.video,
            screenshots=req.screenshots,
        )
        return RunSpecResponse(ok=report.status == "passed", report=report, artifacts=artifact_urls)

    except Exception as e:
        logger.exception(f"Spec file execution failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── API testing (no browser) ─────────────────────────────────────

@app.post("/api-test")
async def api_test_endpoint(req: ApiTestRequest):
    """Execute API tests using Playwright's APIRequestContext (no browser)."""
    try:
        report = await run_api_test(
            requests_list=req.requests,
            base_url=req.base_url,
        )
        return {"ok": True, "report": report.model_dump()}

    except Exception as e:
        logger.exception(f"API test execution failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── Step progress polling ─────────────────────────────────────────

@app.get("/progress/{run_id}")
async def step_progress(run_id: str):
    """Return current step execution progress for a running test."""
    p = get_progress(run_id)
    if p is None:
        return {"ok": False, "error": "No progress data for this run"}
    return {"ok": True, **p}


# ── Live screencast stream ────────────────────────────────────────

@app.get("/live/{run_id}")
async def live_stream(run_id: str):
    """SSE endpoint that streams CDP screencast JPEG frames for a running test."""
    async def generate():
        # Wait up to 30 s for the run to register its frame queue
        loop = asyncio.get_event_loop()
        deadline = loop.time() + 30
        while get_live_queue(run_id) is None:
            if loop.time() > deadline:
                return
            await asyncio.sleep(0.1)

        q = get_live_queue(run_id)
        while True:
            try:
                frame = await asyncio.wait_for(q.get(), timeout=10.0)
                if frame is None:   # sentinel — run complete
                    break
                yield f"data: {frame}\n\n"
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"  # prevent proxy/browser from closing idle stream

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Artifact download endpoints ──────────────────────────────────

@app.get("/trace/{run_id}")
async def get_trace(run_id: str):
    """Download the Playwright trace zip for a test run."""
    trace_path = ARTIFACTS_DIR / run_id / "trace.zip"
    if not trace_path.exists():
        raise HTTPException(status_code=404, detail="Trace not found")
    return FileResponse(
        str(trace_path),
        media_type="application/zip",
        filename=f"trace-{run_id}.zip",
    )


@app.get("/video/{run_id}")
async def get_video(run_id: str):
    """Download the recorded video for a test run."""
    video_dir = ARTIFACTS_DIR / run_id / "video"
    if not video_dir.exists():
        raise HTTPException(status_code=404, detail="Video not found")
    videos = list(video_dir.glob("*.webm"))
    if not videos:
        raise HTTPException(status_code=404, detail="Video file not found")
    return FileResponse(
        str(videos[0]),
        media_type="video/webm",
        filename=f"recording-{run_id}.webm",
    )


@app.get("/har/{run_id}")
async def get_har(run_id: str):
    """Download the HAR network log for a test run."""
    har_path = ARTIFACTS_DIR / run_id / "network.har"
    if not har_path.exists():
        raise HTTPException(status_code=404, detail="HAR not found")
    return FileResponse(
        str(har_path),
        media_type="application/json",
        filename=f"network-{run_id}.har",
    )


@app.get("/screenshot/{run_id}/{filename}")
async def get_screenshot(run_id: str, filename: str):
    """Download a step screenshot."""
    # Sanitize filename to prevent path traversal
    safe_name = Path(filename).name
    ss_path = ARTIFACTS_DIR / run_id / safe_name
    if not ss_path.exists():
        raise HTTPException(status_code=404, detail="Screenshot not found")
    return FileResponse(str(ss_path), media_type="image/png")


# ── Startup / Shutdown ────────────────────────────────────────────

@app.on_event("startup")
async def startup_event():
    logger.info("Autotest Playwright Runner starting up...")
    logger.info(f"Artifacts directory: {ARTIFACTS_DIR}")


@app.on_event("shutdown")
async def shutdown_event():
    logger.info("Autotest Playwright Runner shutting down...")


def run():
    """Run the server."""
    port = int(os.getenv("PORT", "8001"))
    uvicorn.run(
        "backend.runner.main:app",
        host="0.0.0.0",
        port=port,
        reload=os.getenv("DEBUG", "false").lower() == "true",
    )


if __name__ == "__main__":
    run()
