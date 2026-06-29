"""
Orchestrator — Central API Gateway
====================================
Single entry point for the Chrome extension. Handles authentication
centrally and routes requests to internal services.

Public (no auth):
  POST /auth/login        → Registry login
  POST /bootstrap         → Registry bootstrap
  GET  /health            → Orchestrator + downstream health

Authenticated (requires Bearer token):
  /auth/*                 → Registry auth endpoints
  /registry/*             → Registry (account/project/test management)
  /generator/*            → Generator (AI test generation)
  /runner/*               → Runner (headless Playwright execution)
  GET /me                 → Current user context
"""

import logging
import os
from typing import Optional

import httpx
from fastapi import FastAPI, Request, Response, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s | %(levelname)-7s | %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("orchestrator")

# ── Internal service URLs (Docker-internal, not exposed to host) ──
REGISTRY_URL = os.getenv("REGISTRY_URL", "http://registry:8003")
GENERATOR_URL = os.getenv("GENERATOR_URL", "http://generator:8002")
RUNNER_URL = os.getenv("RUNNER_URL", "http://runner:8001")
AGGREGATOR_URL = os.getenv("AGGREGATOR_URL", "http://aggregator:8005")

# Endpoints that don't require authentication
PUBLIC_PATHS = {
    ("POST", "/auth/login"),
    ("POST", "/bootstrap"),
    ("GET", "/health"),
}

app = FastAPI(title="Autotest Orchestrator", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Auth validation cache (per-request, not long-lived) ──────────

async def validate_token(token: str) -> Optional[dict]:
    """Validate a session token against the Registry service."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{REGISTRY_URL}/me",
                headers={"Authorization": f"Bearer {token}"},
            )
            if resp.status_code == 200:
                return resp.json()
            return None
    except httpx.RequestError as exc:
        log.error("Registry validation failed: %s", exc)
        return None


async def get_auth_context(request: Request) -> Optional[dict]:
    """Extract and validate the Bearer token from the request."""
    auth_header = request.headers.get("authorization", "")
    if not auth_header.startswith("Bearer "):
        return None
    token = auth_header[7:]
    return await validate_token(token)


# ── Reverse proxy helpers ─────────────────────────────────────────

def _build_upstream_url(upstream_base: str, upstream_path: str, query: str) -> str:
    url = f"{upstream_base}{upstream_path}"
    if query:
        url = f"{url}?{query}"
    return url


def _forward_headers(request: Request) -> dict:
    headers = dict(request.headers)
    headers.pop("host", None)
    return headers


async def proxy_request(
    request: Request,
    upstream_base: str,
    upstream_path: str,
) -> Response:
    """Forward the incoming request to an upstream service and return its response."""
    url = _build_upstream_url(upstream_base, upstream_path, str(request.url.query))
    body = await request.body()
    headers = _forward_headers(request)

    log.info("PROXY %s %s → %s", request.method, request.url.path, url)

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=10.0)) as client:
            resp = await client.request(
                method=request.method,
                url=url,
                content=body,
                headers=headers,
            )
    except httpx.ConnectError:
        raise HTTPException(status_code=502, detail=f"Cannot reach upstream service at {upstream_base}")
    except httpx.ReadTimeout:
        raise HTTPException(status_code=504, detail="Upstream service timed out")

    # Forward response headers (skip hop-by-hop)
    skip_headers = {"transfer-encoding", "connection", "keep-alive"}
    response_headers = {
        k: v for k, v in resp.headers.items()
        if k.lower() not in skip_headers
    }

    return Response(
        content=resp.content,
        status_code=resp.status_code,
        headers=response_headers,
    )


async def proxy_stream(
    request: Request,
    upstream_base: str,
    upstream_path: str,
) -> StreamingResponse:
    """Stream the upstream response (for SSE / long-lived connections)."""
    url = _build_upstream_url(upstream_base, upstream_path, str(request.url.query))
    headers = _forward_headers(request)

    log.info("PROXY-STREAM %s %s → %s", request.method, request.url.path, url)

    body = await request.body()
    client = httpx.AsyncClient(timeout=httpx.Timeout(None, connect=10.0))

    try:
        req = client.build_request(method=request.method, url=url, headers=headers, content=body)
        resp = await client.send(req, stream=True)
    except httpx.ConnectError:
        await client.aclose()
        raise HTTPException(status_code=502, detail=f"Cannot reach upstream service at {upstream_base}")

    async def stream_body():
        try:
            async for chunk in resp.aiter_bytes():
                yield chunk
        finally:
            await resp.aclose()
            await client.aclose()

    return StreamingResponse(
        stream_body(),
        status_code=resp.status_code,
        headers=dict(resp.headers),
        media_type=resp.headers.get("content-type", "text/event-stream"),
    )


# ── Health endpoint ──────────────────────────────────────────────

@app.get("/health")
async def health():
    """Return orchestrator health + downstream service status."""
    statuses = {}
    async with httpx.AsyncClient(timeout=5) as client:
        for name, url in [("registry", REGISTRY_URL), ("generator", GENERATOR_URL), ("runner", RUNNER_URL), ("aggregator", AGGREGATOR_URL)]:
            try:
                resp = await client.get(f"{url}/health")
                statuses[name] = "healthy" if resp.status_code == 200 else f"unhealthy ({resp.status_code})"
            except Exception:
                statuses[name] = "unreachable"

    overall = "healthy" if all(v == "healthy" for v in statuses.values()) else "degraded"
    return {"status": overall, "services": statuses}


# ── Public auth endpoint (login) ─────────────────────────────────

@app.post("/auth/login")
async def auth_login(request: Request):
    """Proxy login to registry — no auth required."""
    return await proxy_request(request, REGISTRY_URL, "/auth/login")


@app.post("/bootstrap")
async def bootstrap(request: Request):
    """Proxy bootstrap to registry — no auth required."""
    return await proxy_request(request, REGISTRY_URL, "/bootstrap")


# ── /me shortcut ─────────────────────────────────────────────────

@app.get("/me")
async def me(request: Request):
    """Proxy /me to registry (requires auth)."""
    ctx = await get_auth_context(request)
    if not ctx:
        raise HTTPException(status_code=401, detail="Authentication required")
    return await proxy_request(request, REGISTRY_URL, "/me")


# ── Public health endpoints for each service ─────────────────────

@app.get("/generator/health")
async def generator_health(request: Request):
    """Proxy generator health — no auth required."""
    return await proxy_request(request, GENERATOR_URL, "/health")


@app.get("/runner/health")
async def runner_health(request: Request):
    """Proxy runner health — no auth required."""
    return await proxy_request(request, RUNNER_URL, "/health")


@app.get("/registry/health")
async def registry_health(request: Request):
    """Proxy registry health — no auth required."""
    return await proxy_request(request, REGISTRY_URL, "/health")


# ── SSE live stream (must be before catch-all) ───────────────────

@app.get("/runner/live/{run_id}")
async def runner_live_stream(request: Request, run_id: str):
    """Stream live screencast frames from runner via SSE (no auth — EventSource can't send headers)."""
    return await proxy_stream(request, RUNNER_URL, f"/live/{run_id}")


# ── Runner artifact endpoints (no auth — loaded by <img>/<a> tags) ──

@app.get("/runner/screenshot/{run_id}/{filename}")
async def runner_screenshot(request: Request, run_id: str, filename: str):
    """Proxy screenshot download — no auth (browser loads via <img src>)."""
    return await proxy_request(request, RUNNER_URL, f"/screenshot/{run_id}/{filename}")


@app.get("/runner/trace/{run_id}")
async def runner_trace(request: Request, run_id: str):
    """Proxy trace download — no auth."""
    return await proxy_request(request, RUNNER_URL, f"/trace/{run_id}")


@app.get("/runner/video/{run_id}")
async def runner_video(request: Request, run_id: str):
    """Proxy video download — no auth."""
    return await proxy_request(request, RUNNER_URL, f"/video/{run_id}")


@app.get("/runner/har/{run_id}")
async def runner_har(request: Request, run_id: str):
    """Proxy HAR download — no auth."""
    return await proxy_request(request, RUNNER_URL, f"/har/{run_id}")


# ── Catch-all route for proxied services ─────────────────────────

@app.api_route("/auth/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def auth_proxy(request: Request, path: str):
    """Proxy all /auth/* routes to registry (login already handled above)."""
    ctx = await get_auth_context(request)
    if not ctx:
        raise HTTPException(status_code=401, detail="Authentication required")
    return await proxy_request(request, REGISTRY_URL, f"/auth/{path}")


@app.api_route("/registry/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def registry_proxy(request: Request, path: str):
    """Proxy /registry/* → Registry service (strip prefix)."""
    ctx = await get_auth_context(request)
    if not ctx:
        raise HTTPException(status_code=401, detail="Authentication required")
    return await proxy_request(request, REGISTRY_URL, f"/{path}")


@app.post("/generator/generate-test-stream")
async def generator_stream(request: Request):
    """Proxy generate-test-stream SSE → Generator (streaming)."""
    ctx = await get_auth_context(request)
    if not ctx:
        raise HTTPException(status_code=401, detail="Authentication required")
    return await proxy_stream(request, GENERATOR_URL, "/generate-test-stream")


@app.api_route("/generator/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def generator_proxy(request: Request, path: str):
    """Proxy /generator/* → Generator service (strip prefix)."""
    ctx = await get_auth_context(request)
    if not ctx:
        raise HTTPException(status_code=401, detail="Authentication required")
    return await proxy_request(request, GENERATOR_URL, f"/{path}")


RUNNER_PUBLIC_PREFIXES = ("live/", "screenshot/", "trace/", "video/", "har/", "health")

@app.api_route("/runner/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def runner_proxy(request: Request, path: str):
    """Proxy /runner/* → Runner service (strip prefix)."""
    # Allow public access to artifact/live/health endpoints
    is_public = any(path.startswith(p) for p in RUNNER_PUBLIC_PREFIXES)
    if not is_public:
        ctx = await get_auth_context(request)
        if not ctx:
            raise HTTPException(status_code=401, detail="Authentication required")
    # Use streaming proxy for live SSE endpoints
    if path.startswith("live/"):
        return await proxy_stream(request, RUNNER_URL, f"/{path}")
    return await proxy_request(request, RUNNER_URL, f"/{path}")


# ── Startup logging ──────────────────────────────────────────────

@app.get("/aggregator/health")
async def aggregator_health(request: Request):
    """Proxy aggregator health — no auth required."""
    return await proxy_request(request, AGGREGATOR_URL, "/health")


@app.api_route("/aggregator/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def aggregator_proxy(request: Request, path: str):
    """Proxy /aggregator/* → Aggregator service (strip prefix)."""
    ctx = await get_auth_context(request)
    if not ctx:
        raise HTTPException(status_code=401, detail="Authentication required")
    return await proxy_request(request, AGGREGATOR_URL, f"/{path}")


@app.on_event("startup")
async def startup():
    log.info("Orchestrator started")
    log.info("  Registry   → %s", REGISTRY_URL)
    log.info("  Generator  → %s", GENERATOR_URL)
    log.info("  Runner     → %s", RUNNER_URL)
    log.info("  Aggregator → %s", AGGREGATOR_URL)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
