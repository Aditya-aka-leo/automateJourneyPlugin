"""
Step Executor — converts Autotest step JSON into Playwright commands and runs them.

This mirrors the step-type mapping in frontend/shared/playwright-export.js
but executes steps live in a headless browser instead of generating code.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from loguru import logger
from playwright.async_api import (
    Browser,
    BrowserContext,
    Page,
    Playwright,
    async_playwright,
    expect,
)

from .models import (
    ArtifactPaths,
    RunConfig,
    SpecStepReport,
    SpecTestReport,
    StepReport,
    StepStatus,
    TestReport,
    TestStatus,
)

# ── Artifact storage ──────────────────────────────────────────────
ARTIFACTS_DIR = Path(os.getenv("ARTIFACTS_DIR", "/tmp/autotest-artifacts"))
ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)


def _artifact_dir(run_id: str) -> Path:
    d = ARTIFACTS_DIR / run_id
    d.mkdir(parents=True, exist_ok=True)
    return d


async def _launch_browser(browser_type, browser_name: str, launch_args: list[str]) -> Browser:
    """
    Launch a browser with an optional Chromium channel override.
    If a configured channel is missing (common in minimal containers),
    automatically fall back to Playwright's bundled Chromium.
    """
    launch_opts: dict[str, Any] = {
        "headless": True,
        "args": launch_args,
    }

    if browser_name == "chromium":
        channel = os.getenv("PLAYWRIGHT_CHROMIUM_CHANNEL", "").strip()
        if channel:
            launch_opts["channel"] = channel

    try:
        return await browser_type.launch(**launch_opts)
    except Exception as e:
        err_msg = str(e).lower()
        if launch_opts.get("channel") and "distribution" in err_msg and "not found" in err_msg:
            missing_channel = launch_opts.pop("channel")
            logger.warning(
                f"Configured Chromium channel '{missing_channel}' was not found. "
                "Falling back to bundled Playwright Chromium."
            )
            return await browser_type.launch(**launch_opts)
        raise


# ── Selector resolution ──────────────────────────────────────────

def _resolve_locator(page: Page, selector: Any):
    """
    Resolve a selector object (with primary + fallbacks) to a Playwright locator.
    Mirrors the resolveLocator helper in playwright-export.js.
    """
    candidates = []
    if isinstance(selector, str):
        # Simple string selector — treat as CSS
        return page.locator(selector)

    if isinstance(selector, dict):
        primary = selector.get("primary")
        if primary:
            candidates.append(primary)
        fallbacks = selector.get("fallbacks", [])
        if isinstance(fallbacks, list):
            candidates.extend(fallbacks)

    if not candidates:
        raise ValueError("No selector candidates found")

    # Return the first candidate as a locator; the step runner will handle retries.
    return _candidate_to_locator(page, candidates[0])


def _candidate_to_locator(page: Page, candidate: dict):
    sel_type = candidate.get("type", "css")
    value = candidate.get("value", "")
    match_index = candidate.get("matchIndex")

    if sel_type == "text":
        loc = page.get_by_text(value, exact=True)
    elif sel_type == "xpath":
        loc = page.locator(f"xpath={value}")
    elif sel_type == "role":
        # getByRole support
        role = candidate.get("role", value)
        name = candidate.get("name")
        if name:
            loc = page.get_by_role(role, name=name)
        else:
            loc = page.get_by_role(role)
    elif sel_type == "label":
        loc = page.get_by_label(value)
    elif sel_type == "placeholder":
        loc = page.get_by_placeholder(value)
    else:
        # Default: CSS selector
        loc = page.locator(value)

    if match_index is not None and isinstance(match_index, int):
        loc = loc.nth(match_index)
    else:
        loc = loc.first

    return loc


async def _resolve_with_fallbacks(page: Page, selector: Any, timeout_ms: int = 4000):
    """Try primary, then each fallback until one is visible."""
    candidates = []
    if isinstance(selector, str):
        candidates.append({"type": "css", "value": selector})
    elif isinstance(selector, dict):
        primary = selector.get("primary")
        if primary:
            candidates.append(primary)
        fallbacks = selector.get("fallbacks", [])
        if isinstance(fallbacks, list):
            candidates.extend(fallbacks)

    last_err = None
    for c in candidates:
        try:
            loc = _candidate_to_locator(page, c)
            await loc.wait_for(state="visible", timeout=timeout_ms)
            return loc
        except Exception as e:
            last_err = e
            continue

    raise last_err or ValueError("No selector candidates found")


# ── URL helpers ───────────────────────────────────────────────────

def _get_navigation_target(step: dict) -> tuple[str, str]:
    """
    Resolve a navigation target from step fields.
    Source priority:
    1) relativePath
    2) url
    3) value
    4) meta.url
    """
    rel = str(step.get("relativePath") or "").strip()
    if rel:
        return rel, "relativePath"

    raw_url = step.get("url")
    if isinstance(raw_url, str) and raw_url.strip():
        return raw_url.strip(), "url"

    raw_value = step.get("value")
    if isinstance(raw_value, str) and raw_value.strip():
        return raw_value.strip(), "value"

    meta = step.get("meta") or {}
    meta_url = meta.get("url")
    if isinstance(meta_url, str) and meta_url.strip():
        return meta_url.strip(), "meta.url"

    return "/", "default"


def _build_url(base_url: str, step: dict, nav_target: str | None = None) -> str:
    """
    Build an absolute URL from base_url + recorded navigation target.
    Also supports absolute targets and query strings embedded in the target.
    """
    from urllib.parse import parse_qsl, urlencode, urlsplit

    target = nav_target if nav_target is not None else _get_navigation_target(step)[0]
    target = str(target or "/").strip()

    # If target is absolute and base_url is configured, extract the path so
    # the recording can be replayed against a different environment (e.g.
    # staging recording replayed against production). This mirrors the normal
    # mode behaviour in sw.js buildReplayUrl which always combines base_url
    # with relativePath and never uses an absolute URL as-is.
    if target.startswith("http://") or target.startswith("https://"):
        if base_url:
            target_parsed = urlsplit(target)
            path = target_parsed.path or "/"
            base_path = urlsplit(base_url).path.rstrip("/")
            if base_path and path.startswith(base_path):
                path = path[len(base_path):] or "/"
            # Preserve any query embedded in the absolute URL; explicit
            # queryParams from the step are merged in below.
            target = (path + "?" + target_parsed.query) if target_parsed.query else path
            # Fall through to relative-path handling.
        else:
            return target  # No base_url configured: use absolute URL as-is.

    parsed = urlsplit(target)
    path = parsed.path or "/"
    if not path.startswith("/"):
        path = "/" + path

    url = (base_url.rstrip("/") + path) if base_url else path

    pairs: list[tuple[str, str]] = []

    # Query embedded directly in target path/value (e.g. /search?q=x).
    if parsed.query:
        pairs.extend(parse_qsl(parsed.query, keep_blank_values=True))

    # Explicit queryParams object from recorded step.
    qp = step.get("queryParams", {})
    if qp:
        for k, v in qp.items():
            if isinstance(v, list):
                for item in v:
                    pairs.append((str(k), str(item)))
            elif v is not None:
                pairs.append((str(k), str(v)))

    if pairs:
        url += "?" + urlencode(pairs, doseq=True)
    return url


def _safe_page_url(page: Page) -> str:
    """Best-effort URL read for logging."""
    try:
        if page.is_closed():
            return "<page-closed>"
        return page.url or "about:blank"
    except Exception:
        return "<url-unavailable>"


# ── Step execution ────────────────────────────────────────────────

async def _execute_step(
    page: Page,
    step: dict,
    base_url: str,
    step_index: int,
    run_dir: Path,
    run_id: str,
    capture_screenshots: bool = True,
    console_errors: list | None = None,
) -> StepReport:
    """Execute a single step and return the report."""
    step_type = step.get("type", "")
    value = step.get("value")
    meta = step.get("meta", {}) or {}
    selector = step.get("selector")
    timeout_ms = meta.get("timeout") or step.get("timeout") or 15000
    soft = step.get("soft", False)
    start = time.time()

    try:
        logger.info(
            f"[run:{run_id}] Step {step_index + 1} start "
            f"type={step_type} current_url={_safe_page_url(page)}"
        )

        # ── Navigation ──
        if step_type == "navigation":
            nav_target, nav_source = _get_navigation_target(step)
            if nav_source != "relativePath":
                logger.warning(
                    f"[run:{run_id}] Step {step_index + 1} navigation missing relativePath; "
                    f"using {nav_source}={nav_target!r}"
                )
            url = _build_url(base_url, step, nav_target=nav_target)
            logger.info(
                f"[run:{run_id}] Step {step_index + 1} navigation target_url={url} "
                f"from_url={_safe_page_url(page)}"
            )
            resp = await page.goto(url, wait_until="commit", timeout=60000)
            if resp:
                logger.info(
                    f"[run:{run_id}] Step {step_index + 1} navigation response "
                    f"status={resp.status} url={resp.url}"
                )
            else:
                logger.warning(
                    f"[run:{run_id}] Step {step_index + 1} navigation returned no response "
                    f"target_url={url}"
                )
            try:
                await page.wait_for_load_state("domcontentloaded", timeout=30000)
            except Exception:
                pass
            logger.info(
                f"[run:{run_id}] Step {step_index + 1} navigation landed_url={_safe_page_url(page)}"
            )

        # ── Click ──
        elif step_type == "click":
            loc = await _resolve_with_fallbacks(page, selector, timeout_ms)
            await loc.click()

        # ── Input / Change ──
        elif step_type in ("input", "change"):
            loc = await _resolve_with_fallbacks(page, selector, timeout_ms)
            await loc.fill(str(value or ""))

        # ── Submit ──
        elif step_type == "submit":
            loc = await _resolve_with_fallbacks(page, selector, timeout_ms)
            await loc.evaluate(
                "(el) => el.closest('form')?.requestSubmit?.() || el.closest('form')?.submit()"
            )

        # ── Hover ──
        elif step_type == "hover":
            loc = await _resolve_with_fallbacks(page, selector, timeout_ms)
            await loc.hover()

        # ── Scroll ──
        elif step_type == "scroll":
            loc = await _resolve_with_fallbacks(page, selector, timeout_ms)
            await loc.scroll_into_view_if_needed()

        # ── Select ──
        elif step_type == "select":
            loc = await _resolve_with_fallbacks(page, selector, timeout_ms)
            await loc.select_option(str(value or ""))

        # ── Keyboard ──
        elif step_type in ("key", "keypress"):
            key = meta.get("key") or value or "Enter"
            parts = []
            if meta.get("ctrlKey"):
                parts.append("Control")
            if meta.get("shiftKey"):
                parts.append("Shift")
            if meta.get("altKey"):
                parts.append("Alt")
            if meta.get("metaKey"):
                parts.append("Meta")
            parts.append(key)
            await page.keyboard.press("+".join(parts))

        # ── File upload ──
        elif step_type == "upload":
            loc = await _resolve_with_fallbacks(page, selector, timeout_ms)
            file_path = meta.get("filePath") or meta.get("fileName") or "test-file.txt"
            await loc.set_input_files(file_path)

        # ── Drag & Drop ──
        elif step_type == "drag_drop":
            loc = await _resolve_with_fallbacks(page, selector, timeout_ms)
            target_sel = meta.get("targetSelector", "")
            if target_sel:
                target_loc = page.locator(target_sel)
                await loc.drag_to(target_loc)

        # ── Assertions ──
        elif step_type in ("assert_exists", "assert_visible"):
            loc = await _resolve_with_fallbacks(page, selector, timeout_ms)
            await expect(loc).to_be_visible(timeout=timeout_ms)

        elif step_type == "assert_hidden":
            loc = _resolve_locator(page, selector)
            await expect(loc).to_be_hidden(timeout=timeout_ms)

        elif step_type == "assert_text_equals":
            loc = await _resolve_with_fallbacks(page, selector, timeout_ms)
            await expect(loc).to_have_text(str(value or ""), timeout=timeout_ms)

        elif step_type == "assert_text_contains":
            loc = await _resolve_with_fallbacks(page, selector, timeout_ms)
            await expect(loc).to_contain_text(str(value or ""), timeout=timeout_ms)

        elif step_type == "assert_attr_equals":
            loc = await _resolve_with_fallbacks(page, selector, timeout_ms)
            attr = str(meta.get("attr", ""))
            await expect(loc).to_have_attribute(attr, str(value or ""), timeout=timeout_ms)

        elif step_type == "assert_url_contains":
            expected = str(value or "")
            logger.info(
                f"[run:{run_id}] Step {step_index + 1} assert_url_contains "
                f"expected_contains={expected!r} current_url={_safe_page_url(page)}"
            )
            await expect(page).to_have_url(re.compile(re.escape(expected)), timeout=timeout_ms)
            logger.info(
                f"[run:{run_id}] Step {step_index + 1} assert_url_contains passed "
                f"current_url={_safe_page_url(page)}"
            )

        elif step_type == "assert_checked":
            loc = await _resolve_with_fallbacks(page, selector, timeout_ms)
            await expect(loc).to_be_checked(timeout=timeout_ms)

        elif step_type == "assert_disabled":
            loc = await _resolve_with_fallbacks(page, selector, timeout_ms)
            await expect(loc).to_be_disabled(timeout=timeout_ms)

        elif step_type == "assert_enabled":
            loc = await _resolve_with_fallbacks(page, selector, timeout_ms)
            await expect(loc).to_be_enabled(timeout=timeout_ms)

        elif step_type == "assert_has_class":
            loc = await _resolve_with_fallbacks(page, selector, timeout_ms)
            await expect(loc).to_have_class(re.compile(re.escape(str(value or ""))), timeout=timeout_ms)

        elif step_type == "assert_has_value":
            loc = await _resolve_with_fallbacks(page, selector, timeout_ms)
            await expect(loc).to_have_value(str(value or ""), timeout=timeout_ms)

        elif step_type == "assert_has_title":
            await expect(page).to_have_title(re.compile(re.escape(str(value or ""))), timeout=timeout_ms)

        elif step_type == "assert_count":
            loc = _resolve_locator(page, selector)
            await expect(loc).to_have_count(int(value or 0), timeout=timeout_ms)

        elif step_type == "assert_editable":
            loc = await _resolve_with_fallbacks(page, selector, timeout_ms)
            await expect(loc).to_be_editable(timeout=timeout_ms)

        elif step_type == "assert_no_console_errors":
            # Check collected console errors
            if console_errors:
                raise AssertionError(
                    f"Found {len(console_errors)} console error(s): {console_errors[0]}"
                )

        elif step_type == "assert_screenshot":
            await expect(page).to_have_screenshot(timeout=timeout_ms)

        # ── Wait steps ──
        elif step_type == "wait_delay":
            await page.wait_for_timeout(int(value or 1000))

        elif step_type == "wait_for_url":
            expected = str(value or "")
            logger.info(
                f"[run:{run_id}] Step {step_index + 1} wait_for_url "
                f"expected_contains={expected!r} current_url={_safe_page_url(page)}"
            )
            await page.wait_for_url(re.compile(re.escape(expected)), timeout=timeout_ms)
            logger.info(
                f"[run:{run_id}] Step {step_index + 1} wait_for_url matched "
                f"current_url={_safe_page_url(page)}"
            )

        elif step_type == "wait_for_text":
            loc = await _resolve_with_fallbacks(page, selector, timeout_ms)
            await expect(loc).to_contain_text(str(value or ""), timeout=timeout_ms)

        elif step_type == "waitForElement":
            loc = _resolve_locator(page, selector)
            await loc.wait_for(state="visible", timeout=timeout_ms)

        elif step_type == "waitForNavigation":
            await page.wait_for_load_state("networkidle", timeout=timeout_ms)

        # ── Control flow ──
        elif step_type == "if_exists":
            # Evaluate condition: check if element exists
            try:
                loc = _resolve_locator(page, selector)
                count = await loc.count()
                return StepReport(
                    index=step_index,
                    type=step_type,
                    status=StepStatus.PASSED,
                    duration_ms=int((time.time() - start) * 1000),
                    condition_result=count > 0,
                )
            except Exception:
                return StepReport(
                    index=step_index,
                    type=step_type,
                    status=StepStatus.PASSED,
                    duration_ms=int((time.time() - start) * 1000),
                    condition_result=False,
                )

        elif step_type == "if_not_exists":
            try:
                loc = _resolve_locator(page, selector)
                count = await loc.count()
                return StepReport(
                    index=step_index,
                    type=step_type,
                    status=StepStatus.PASSED,
                    duration_ms=int((time.time() - start) * 1000),
                    condition_result=count == 0,
                )
            except Exception:
                return StepReport(
                    index=step_index,
                    type=step_type,
                    status=StepStatus.PASSED,
                    duration_ms=int((time.time() - start) * 1000),
                    condition_result=True,
                )

        elif step_type in ("end_if", "loop_end"):
            pass  # Control markers — handled by the orchestrator loop

        elif step_type == "loop_start":
            pass  # Loop count is handled by the orchestrator loop

        else:
            logger.warning(f"Unsupported step type: {step_type}")
            return StepReport(
                index=step_index,
                type=step_type,
                status=StepStatus.SKIPPED,
                duration_ms=int((time.time() - start) * 1000),
                error=f"Unsupported step type: {step_type}",
            )

        # Capture screenshot on success
        screenshot_path = None
        if capture_screenshots:
            ss_file = run_dir / f"step-{step_index}.png"
            await page.screenshot(path=str(ss_file))
            screenshot_path = f"step-{step_index}.png"

        return StepReport(
            index=step_index,
            type=step_type,
            status=StepStatus.PASSED,
            duration_ms=int((time.time() - start) * 1000),
            screenshot=screenshot_path,
        )

    except Exception as e:
        logger.error(
            f"[run:{run_id}] Step {step_index + 1} failed type={step_type} "
            f"current_url={_safe_page_url(page)} error={e}"
        )
        duration_ms = int((time.time() - start) * 1000)
        # Capture screenshot on failure
        screenshot_path = None
        try:
            ss_file = run_dir / f"step-{step_index}-fail.png"
            await page.screenshot(path=str(ss_file))
            screenshot_path = f"step-{step_index}-fail.png"
        except Exception:
            pass

        status = StepStatus.SOFT_FAIL if soft else StepStatus.FAILED
        return StepReport(
            index=step_index,
            type=step_type,
            status=status,
            duration_ms=duration_ms,
            error=str(e),
            screenshot=screenshot_path,
        )


# ── Control-flow orchestrator ─────────────────────────────────────

async def _run_steps_with_control_flow(
    page: Page,
    steps: list[dict],
    base_url: str,
    run_dir: Path,
    run_id: str,
    capture_screenshots: bool,
    console_errors: list,
    total_steps: int | None = None,
) -> list[StepReport]:
    """
    Execute steps with if/else and loop control flow.
    """
    if total_steps is None:
        total_steps = len(steps)
    reports: list[StepReport] = []
    i = 0
    skip_depth = 0  # > 0 means we're inside a skipped conditional block

    while i < len(steps):
        step = steps[i]
        step_type = step.get("type", "")

        # ── Handle conditional blocks ──
        if step_type in ("if_exists", "if_not_exists"):
            report = await _execute_step(
                page, step, base_url, i, run_dir, run_id, capture_screenshots, console_errors
            )
            reports.append(report)
            condition = report.condition_result if report.condition_result is not None else True
            if not condition:
                skip_depth += 1
            i += 1
            continue

        if step_type == "end_if":
            if skip_depth > 0:
                skip_depth -= 1
            reports.append(StepReport(
                index=i, type=step_type, status=StepStatus.PASSED, duration_ms=0
            ))
            i += 1
            continue

        if skip_depth > 0:
            reports.append(StepReport(
                index=i, type=step_type, status=StepStatus.SKIPPED, duration_ms=0
            ))
            i += 1
            continue

        # ── Handle loops ──
        if step_type == "loop_start":
            loop_count = int(step.get("value") or step.get("meta", {}).get("loopCount") or 1)
            # Find matching loop_end
            depth = 1
            end_i = i + 1
            while end_i < len(steps) and depth > 0:
                if steps[end_i].get("type") == "loop_start":
                    depth += 1
                elif steps[end_i].get("type") == "loop_end":
                    depth -= 1
                end_i += 1
            loop_body = steps[i + 1 : end_i - 1] if depth == 0 else steps[i + 1 :]

            reports.append(StepReport(
                index=i, type="loop_start", status=StepStatus.PASSED, duration_ms=0
            ))

            for iteration in range(loop_count):
                logger.info(f"Loop iteration {iteration + 1}/{loop_count}")
                body_reports = await _run_steps_with_control_flow(
                    page, loop_body, base_url, run_dir, run_id, capture_screenshots, console_errors
                )
                reports.extend(body_reports)
                # Stop loop if any hard failure
                if any(r.status == StepStatus.FAILED for r in body_reports):
                    break

            if depth == 0:
                reports.append(StepReport(
                    index=end_i - 1, type="loop_end", status=StepStatus.PASSED, duration_ms=0
                ))
            i = end_i if depth == 0 else len(steps)
            continue

        if step_type == "loop_end":
            # Should be handled by loop_start; skip if encountered out of context
            reports.append(StepReport(
                index=i, type=step_type, status=StepStatus.PASSED, duration_ms=0
            ))
            i += 1
            continue

        # ── Normal step ──
        update_progress(run_id, i, step_type, "running", total_steps)
        report = await _execute_step(
            page, step, base_url, i, run_dir, run_id, capture_screenshots, console_errors
        )
        reports.append(report)
        update_progress(run_id, i, step_type, report.status.value, total_steps)

        # Stop on hard failure
        if report.status == StepStatus.FAILED:
            # Mark remaining steps as skipped and update progress for each
            for j in range(i + 1, len(steps)):
                skipped_type = steps[j].get("type", "")
                reports.append(StepReport(
                    index=j,
                    type=skipped_type,
                    status=StepStatus.SKIPPED,
                    duration_ms=0,
                ))
                update_progress(run_id, j, skipped_type, "skipped", total_steps)
            break

        i += 1

    return reports


# ── Network mocking ───────────────────────────────────────────────

async def _setup_network_mocks(page: Page, mocks: list[dict]):
    """Set up page.route() for each network mock rule."""
    for mock in mocks:
        url_pattern = mock.get("url", "**/*")
        method = mock.get("method", "").upper()
        response_cfg = mock.get("response", {})
        status = response_cfg.get("status", 200)
        body = response_cfg.get("body")
        headers = response_cfg.get("headers", {"Content-Type": "application/json"})

        async def route_handler(route, url_pat=url_pattern, meth=method, st=status, bd=body, hd=headers):
            if meth and route.request.method.upper() != meth:
                await route.fallback()
                return
            body_str = json.dumps(bd) if not isinstance(bd, str) else bd
            await route.fulfill(status=st, body=body_str, headers=hd)

        await page.route(url_pattern, route_handler)
        logger.info(f"Mock registered: {method or 'ANY'} {url_pattern} -> {status}")


async def _setup_network_blocks(page: Page, patterns: list[str]):
    """Abort all requests whose URL matches any of the given glob patterns."""
    for pattern in patterns:
        await page.route(pattern, lambda route: route.abort())
        logger.info(f"Block registered: {pattern}")


# ── Live screencast registry ──────────────────────────────────────

_frame_queues: dict[str, asyncio.Queue] = {}

# ── Step progress registry ────────────────────────────────────────

_progress: dict[str, dict] = {}


def update_progress(run_id: str, step_index: int, step_type: str, status: str, total: int):
    """Record the latest step result for a run."""
    prev = _progress.get(run_id, {})
    completed = prev.get("completed", 0) + (1 if status != "running" else 0)
    passed = prev.get("passed", 0) + (1 if status == "passed" else 0)
    failed = prev.get("failed", 0) + (1 if status in ("failed", "soft_fail") else 0)
    _progress[run_id] = {
        "run_id": run_id,
        "current_step": step_index,
        "current_type": step_type,
        "current_status": status,
        "completed": completed,
        "total": total,
        "passed": passed,
        "failed": failed,
        "done": False,
    }
    logger.debug(f"[progress:{run_id}] step={step_index} type={step_type} status={status} completed={completed}/{total}")


def finish_progress(run_id: str):
    """Mark a run as done."""
    if run_id in _progress:
        _progress[run_id]["done"] = True


def get_progress(run_id: str) -> dict | None:
    return _progress.get(run_id)


def clear_progress(run_id: str):
    _progress.pop(run_id, None)


def _register_live_run(run_id: str) -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue(maxsize=10)
    _frame_queues[run_id] = q
    return q


def _unregister_live_run(run_id: str) -> None:
    _frame_queues.pop(run_id, None)


def get_live_queue(run_id: str) -> asyncio.Queue | None:
    return _frame_queues.get(run_id)


# ── Main run function ─────────────────────────────────────────────

async def run_test(
    steps: list[dict],
    config: RunConfig,
    network_mocks: list[dict] | None = None,
    block_patterns: list[str] | None = None,
    run_id: str | None = None,
) -> tuple[TestReport, ArtifactPaths]:
    """
    Execute a list of recorded steps in a headless Playwright browser.
    Returns a TestReport and ArtifactPaths.
    """
    run_id = run_id or str(uuid.uuid4())[:12]
    run_dir = _artifact_dir(run_id)
    start_time = time.time()

    # Initialize progress tracking so polls before the first step return meaningful data
    _progress[run_id] = {
        "run_id": run_id,
        "current_step": -1,
        "current_type": "initializing",
        "current_status": "running",
        "completed": 0,
        "total": len(steps),
        "passed": 0,
        "failed": 0,
        "done": False,
    }
    logger.info(f"[run:{run_id}] Progress tracking initialized for {len(steps)} steps")

    logger.info(f"[run:{run_id}] Starting test — {len(steps)} steps, browser={config.browser}")

    async with async_playwright() as pw:
        browser_type = getattr(pw, config.browser, pw.chromium)
        # Chromium-specific flags — Firefox & WebKit don't recognise them
        launch_args = []
        if config.browser == "chromium":
            launch_args = [
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
            ]
        browser: Browser = await _launch_browser(browser_type, config.browser, launch_args)

        # Build context options
        ctx_opts: dict[str, Any] = {
            "ignore_https_errors": True,
            "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        }

        # Device emulation
        if config.device:
            device_cfg = pw.devices.get(config.device)
            if device_cfg:
                ctx_opts.update(device_cfg)
                logger.info(f"[run:{run_id}] Device emulation: {config.device}")

        # Viewport override
        if config.viewport:
            ctx_opts["viewport"] = {
                "width": config.viewport.get("width", 1280),
                "height": config.viewport.get("height", 720),
            }

        # Geolocation
        if config.geolocation:
            ctx_opts["geolocation"] = config.geolocation
            ctx_opts.setdefault("permissions", []).append("geolocation") if "permissions" not in ctx_opts else None

        # Permissions
        if config.permissions:
            ctx_opts["permissions"] = config.permissions

        # Timezone
        if config.timezone_id:
            ctx_opts["timezone_id"] = config.timezone_id

        # Locale
        if config.locale:
            ctx_opts["locale"] = config.locale

        # Storage state
        if config.storage_state:
            # Write to temp file
            state_file = run_dir / "storage-state.json"
            state_file.write_text(json.dumps(config.storage_state))
            ctx_opts["storage_state"] = str(state_file)

        # Video recording
        if config.video:
            ctx_opts["record_video_dir"] = str(run_dir / "video")
            ctx_opts["record_video_size"] = ctx_opts.get("viewport", {"width": 1280, "height": 720})

        # HAR recording
        if config.har:
            ctx_opts["record_har_path"] = str(run_dir / "network.har")

        # Create context and page
        context: BrowserContext = await browser.new_context(**ctx_opts)

        # Hide automation signals that cause some sites (e.g. AEM/Cloudflare) to
        # behave differently or refuse to render dynamic content for headless browsers.
        await context.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
        )

        # Trace recording
        if config.trace:
            await context.tracing.start(screenshots=True, snapshots=True, sources=True)

        page: Page = await context.new_page()

        # ── Live CDP screencast (Chromium only) ───────────────────────
        # CDP is not available on Firefox/WebKit, so only start screencast
        # when running on Chromium.
        frame_queue = _register_live_run(run_id)
        cdp = None
        if config.browser == "chromium":
            try:
                cdp = await context.new_cdp_session(page)
                await cdp.send("Page.startScreencast", {
                    "format": "jpeg", "quality": 60,
                    "maxWidth": 1280, "maxHeight": 800, "everyNthFrame": 2,
                })

                async def _on_screencast_frame(params):
                    try:
                        await cdp.send("Page.screencastFrameAck", {"sessionId": params["sessionId"]})
                    except Exception:
                        pass
                    try:
                        frame_queue.put_nowait(params["data"])
                    except asyncio.QueueFull:
                        pass  # Drop frame — consumer is slow

                cdp.on("Page.screencastFrame", _on_screencast_frame)
            except Exception as e:
                logger.warning(f"[run:{run_id}] CDP screencast not available: {e}")
                cdp = None

        # URL + network diagnostics for debugging navigation and 404 issues.
        def _on_frame_navigated(frame):
            if frame == page.main_frame:
                logger.info(f"[run:{run_id}] Navigated main frame url={frame.url}")

        def _on_response(resp):
            status = resp.status
            if status < 400:
                return
            req = resp.request
            method = req.method if req else "UNKNOWN"
            resource = req.resource_type if req else "unknown"
            # Keep logs focused on likely failures users care about.
            if status == 404 or status >= 500:
                logger.warning(
                    f"[run:{run_id}] HTTP {status} method={method} resource={resource} url={resp.url}"
                )

        def _on_request_failed(req):
            failure = req.failure if req.failure else "unknown"
            logger.warning(
                f"[run:{run_id}] Request failed method={req.method} resource={req.resource_type} "
                f"url={req.url} reason={failure}"
            )

        page.on("framenavigated", _on_frame_navigated)
        page.on("response", _on_response)
        page.on("requestfailed", _on_request_failed)

        # Console error collection
        console_errors: list[str] = []
        page.on("console", lambda msg: (
            console_errors.append(f"[{msg.type}] {msg.text}")
            if msg.type == "error" else None
        ))

        # Set up network blocks and mocks
        if block_patterns:
            await _setup_network_blocks(page, block_patterns)
        if network_mocks:
            await _setup_network_mocks(page, network_mocks)

        # Navigate to the recording's starting page if the first step is not a
        # navigation. In normal (browser) mode the tab is already on the right
        # page; in Playwright we start from about:blank so we need to go there
        # first. Use the first step's relativePath (which every recorded step
        # carries) so we land on the exact page the recording began, not just
        # the base-URL root.
        if steps and steps[0].get("type") != "navigation" and config.base_url:
            start_url = _build_url(config.base_url, steps[0])
            logger.info(f"[run:{run_id}] Initial goto start_url={start_url}")
            resp = await page.goto(start_url, wait_until="commit", timeout=60000)
            if resp:
                logger.info(
                    f"[run:{run_id}] Initial goto response status={resp.status} url={resp.url}"
                )
            try:
                await page.wait_for_load_state("domcontentloaded", timeout=30000)
            except Exception:
                pass
            try:
                await page.wait_for_load_state("load", timeout=30000)
            except Exception:
                pass
            # Wait for the first step's target element to be visible rather than
            # relying on networkidle (which never completes on pages with continuous
            # background activity like large AEM forms). This ensures the page has
            # rendered its interactive content before step execution begins.
            first_selector = steps[0].get("selector") if steps else None
            if first_selector:
                try:
                    loc = _candidate_to_locator(
                        page,
                        first_selector.get("primary") if isinstance(first_selector, dict) else {"type": "css", "value": first_selector},
                    )
                    await loc.wait_for(state="visible", timeout=60000)
                    logger.info(f"[run:{run_id}] First element visible — page ready")
                except Exception:
                    logger.warning(f"[run:{run_id}] First element not visible within 60s — proceeding anyway")
            logger.info(f"[run:{run_id}] Initial page url={_safe_page_url(page)}")

        # Execute steps
        try:
            step_reports = await _run_steps_with_control_flow(
                page, steps, config.base_url, run_dir, run_id,
                capture_screenshots=config.screenshots,
                console_errors=console_errors,
                total_steps=len(steps),
            )
        finally:
            # Always mark progress as done, even if steps error out
            finish_progress(run_id)
            # Signal end of live stream
            q = get_live_queue(run_id)
            if q:
                await q.put(None)  # sentinel — SSE consumer will stop
            _unregister_live_run(run_id)

        # Stop trace
        trace_path = None
        if config.trace:
            try:
                trace_file = run_dir / "trace.zip"
                await asyncio.wait_for(context.tracing.stop(path=str(trace_file)), timeout=15)
                trace_path = "trace.zip"
            except (asyncio.TimeoutError, Exception) as e:
                logger.warning(f"[run:{run_id}] Trace stop failed: {e}")

        # Close context and browser with timeout to avoid hanging
        try:
            await asyncio.wait_for(context.close(), timeout=10)
        except (asyncio.TimeoutError, Exception) as e:
            logger.warning(f"[run:{run_id}] Context close timed out: {e}")
        try:
            await asyncio.wait_for(browser.close(), timeout=10)
        except (asyncio.TimeoutError, Exception) as e:
            logger.warning(f"[run:{run_id}] Browser close timed out: {e}")

    # Collect artifact paths
    video_path = None
    if config.video:
        video_dir = run_dir / "video"
        if video_dir.exists():
            videos = list(video_dir.glob("*.webm"))
            if videos:
                video_path = f"video/{videos[0].name}"

    har_path = None
    if config.har and (run_dir / "network.har").exists():
        har_path = "network.har"

    screenshot_paths = [
        r.screenshot for r in step_reports if r.screenshot
    ]

    # Build report
    total_duration = int((time.time() - start_time) * 1000)
    passed = sum(1 for r in step_reports if r.status == StepStatus.PASSED)
    failed = sum(1 for r in step_reports if r.status == StepStatus.FAILED)
    skipped = sum(1 for r in step_reports if r.status == StepStatus.SKIPPED)
    soft_fails = sum(1 for r in step_reports if r.status == StepStatus.SOFT_FAIL)

    overall_status = TestStatus.PASSED
    if failed > 0:
        overall_status = TestStatus.FAILED
    elif soft_fails > 0:
        overall_status = TestStatus.SOFT_FAILED

    report = TestReport(
        run_id=run_id,
        status=overall_status,
        duration_ms=total_duration,
        steps=step_reports,
        passed=passed,
        failed=failed,
        skipped=skipped,
        soft_fails=soft_fails,
        console_errors=console_errors if console_errors else None,
    )

    artifacts = ArtifactPaths(
        run_id=run_id,
        trace=trace_path,
        video=video_path,
        har=har_path,
        screenshots=screenshot_paths,
    )

    logger.info(
        f"[run:{run_id}] Complete — {overall_status.value} "
        f"({passed} passed, {failed} failed, {skipped} skipped) in {total_duration}ms"
    )

    return report, artifacts


# ── Parallel execution ────────────────────────────────────────────

async def run_tests_parallel(
    tests: list[dict],
    max_workers: int = 4,
) -> list[tuple[TestReport, ArtifactPaths]]:
    """
    Run multiple tests in parallel using a semaphore to limit concurrency.
    Each item in `tests` should have: { "steps": [...], "config": {...}, "networkMocks": [...] }
    """
    sem = asyncio.Semaphore(max_workers)

    async def run_one(test_data: dict):
        async with sem:
            config = RunConfig(**test_data.get("config", {}))
            return await run_test(
                steps=test_data.get("steps", []),
                config=config,
                network_mocks=test_data.get("networkMocks"),
                block_patterns=test_data.get("blockPatterns"),
                run_id=test_data.get("runId"),
            )

    results = await asyncio.gather(
        *(run_one(t) for t in tests),
        return_exceptions=True,
    )

    output = []
    for r in results:
        if isinstance(r, Exception):
            logger.error(f"Parallel test failed: {r}")
            error_report = TestReport(
                run_id="error",
                status=TestStatus.FAILED,
                duration_ms=0,
                steps=[],
                passed=0,
                failed=1,
                skipped=0,
                soft_fails=0,
                error=str(r),
            )
            output.append((error_report, ArtifactPaths(run_id="error")))
        else:
            output.append(r)
    return output


# ── API testing (no browser) ─────────────────────────────────────

async def run_api_test(
    requests_list: list[dict],
    base_url: str = "",
) -> TestReport:
    """
    Run API tests using Playwright's APIRequestContext (no browser needed).
    Each item: { "method": "GET", "url": "/api/users", "body": {...}, "expect": { "status": 200 } }
    """
    run_id = str(uuid.uuid4())[:12]
    start_time = time.time()
    step_reports: list[StepReport] = []

    async with async_playwright() as pw:
        api_context = await pw.request.new_context(base_url=base_url)

        for i, req in enumerate(requests_list):
            step_start = time.time()
            method = req.get("method", "GET").upper()
            url = req.get("url", "/")
            body = req.get("body")
            headers = req.get("headers", {})
            expected = req.get("expect", {})

            try:
                if method == "GET":
                    resp = await api_context.get(url, headers=headers)
                elif method == "POST":
                    resp = await api_context.post(url, data=body, headers=headers)
                elif method == "PUT":
                    resp = await api_context.put(url, data=body, headers=headers)
                elif method == "PATCH":
                    resp = await api_context.patch(url, data=body, headers=headers)
                elif method == "DELETE":
                    resp = await api_context.delete(url, headers=headers)
                else:
                    raise ValueError(f"Unsupported HTTP method: {method}")

                # Validate expectations
                errors = []
                if "status" in expected and resp.status != expected["status"]:
                    errors.append(f"Expected status {expected['status']}, got {resp.status}")

                if "bodyContains" in expected:
                    body_text = await resp.text()
                    if expected["bodyContains"] not in body_text:
                        errors.append(f"Body does not contain: {expected['bodyContains']}")

                if errors:
                    raise AssertionError("; ".join(errors))

                step_reports.append(StepReport(
                    index=i,
                    type=f"api_{method.lower()}",
                    status=StepStatus.PASSED,
                    duration_ms=int((time.time() - step_start) * 1000),
                ))

            except Exception as e:
                step_reports.append(StepReport(
                    index=i,
                    type=f"api_{method.lower()}",
                    status=StepStatus.FAILED,
                    duration_ms=int((time.time() - step_start) * 1000),
                    error=str(e),
                ))

        await api_context.dispose()

    total_duration = int((time.time() - start_time) * 1000)
    passed = sum(1 for r in step_reports if r.status == StepStatus.PASSED)
    failed = sum(1 for r in step_reports if r.status == StepStatus.FAILED)

    return TestReport(
        run_id=run_id,
        status=TestStatus.PASSED if failed == 0 else TestStatus.FAILED,
        duration_ms=total_duration,
        steps=step_reports,
        passed=passed,
        failed=failed,
        skipped=0,
        soft_fails=0,
    )


# ── Run a .spec.ts file directly ─────────────────────────────────

async def run_spec_file(
    spec_path: str,
    headed: bool = False,
    browsers: list[str] | None = None,
    trace: bool = True,
    video: bool = False,
    screenshots: bool = True,
) -> tuple[SpecTestReport, dict]:
    """
    Execute a Playwright .spec.ts file using `npx playwright test` and return
    structured results with artifact paths.
    """
    import subprocess as sp

    run_id = str(uuid.uuid4())[:12]
    run_dir = _artifact_dir(run_id)
    start_time = time.time()
    spec = Path(spec_path)

    if not spec.exists():
        return SpecTestReport(
            run_id=run_id,
            status="failed",
            error=f"Spec file not found: {spec_path}",
        ), {}

    browsers = browsers or ["chromium"]
    npx_path = shutil.which("npx")
    if not npx_path:
        return SpecTestReport(
            run_id=run_id,
            status="failed",
            error="npx not found on PATH",
        ), {}

    # Build playwright test command
    cmd = [
        npx_path, "playwright", "test", str(spec),
        "--reporter=json",
        f"--output={run_dir}",
    ]

    if headed:
        cmd.append("--headed")

    # Create a minimal playwright.config.ts in the spec directory if missing
    config_path = spec.parent / "playwright.config.ts"
    if not config_path.exists():
        config_content = (
            'import { defineConfig, devices } from "@playwright/test";\n'
            "export default defineConfig({\n"
            '  use: { screenshot: "on" },\n'
            "  projects: [\n"
        )
        for b in browsers:
            device_map = {
                "chromium": "Desktop Chrome",
                "firefox": "Desktop Firefox",
                "webkit": "Desktop Safari",
            }
            device = device_map.get(b, "Desktop Chrome")
            config_content += f'    {{ name: "{b}", use: {{ ...devices["{device}"] }} }},\n'
        config_content += "  ],\n});\n"
        config_path.write_text(config_content)
        logger.info(f"[run-spec:{run_id}] Created playwright.config.ts with projects: {browsers}")

    # Set projects (browsers)
    for browser in browsers:
        cmd.extend(["--project", browser])

    # Build environment for playwright config
    env = os.environ.copy()
    env["PLAYWRIGHT_JSON_OUTPUT_NAME"] = str(run_dir / "results.json")
    # Ensure globally-installed @playwright/test is resolvable from any cwd
    env["NODE_PATH"] = "/usr/lib/node_modules"

    # Configure trace, video, screenshots via env/CLI
    if trace:
        cmd.append("--trace=on")
    if video:
        cmd.append("--video=on")
    # Screenshots are captured automatically by Playwright on failure;
    # there is no --screenshot CLI flag.

    logger.info(f"[run-spec:{run_id}] Executing: {' '.join(cmd)}")

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            cwd=str(spec.parent),
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=300)

        stdout_text = stdout.decode().strip()
        stderr_text = stderr.decode().strip()

        logger.info(f"[run-spec:{run_id}] Exit code: {proc.returncode}")
        if stderr_text:
            logger.info(f"[run-spec:{run_id}] stderr: {stderr_text[:500]}")

        # Parse JSON results if available
        results_file = run_dir / "results.json"
        test_results: list[SpecStepReport] = []
        total = passed = failed_count = skipped = 0

        if results_file.exists():
            try:
                report_data = json.loads(results_file.read_text(encoding="utf-8"))

                def _walk_suites(suites):
                    """Recursively walk nested suites to find all specs."""
                    nonlocal total, passed, failed_count, skipped
                    for suite in suites:
                        for spec_item in suite.get("specs", []):
                            for test in spec_item.get("tests", []):
                                for result in test.get("results", []):
                                    status = result.get("status", "unknown")
                                    total += 1
                                    if status == "passed":
                                        passed += 1
                                    elif status in ("failed", "timedOut"):
                                        failed_count += 1
                                    elif status == "skipped":
                                        skipped += 1
                                    error_msg = None
                                    if result.get("error"):
                                        error_msg = result["error"].get("message", str(result["error"]))
                                    test_results.append(SpecStepReport(
                                        title=spec_item.get("title", "Unknown"),
                                        status=status,
                                        duration_ms=result.get("duration", 0),
                                        error=error_msg,
                                    ))
                        # Recurse into nested suites (e.g. describe blocks)
                        _walk_suites(suite.get("suites", []))

                _walk_suites(report_data.get("suites", []))
            except (json.JSONDecodeError, KeyError) as e:
                logger.warning(f"[run-spec:{run_id}] Failed to parse results.json: {e}")

        # Determine overall status
        overall_status = "passed" if proc.returncode == 0 else "failed"
        duration_ms = int((time.time() - start_time) * 1000)

        # Collect artifacts
        artifact_urls = {}

        # Screenshots — copy from subdirs to top-level run dir for serving
        screenshot_files = list(run_dir.glob("**/*.png"))
        seen_names: set = set()
        if screenshot_files:
            artifact_urls["screenshots"] = []
            for ss in screenshot_files:
                name = ss.name
                if name in seen_names:
                    name = f"{ss.parent.name}--{name}"
                seen_names.add(name)
                dest = run_dir / name
                if ss != dest and not dest.exists():
                    shutil.copy2(str(ss), str(dest))
                artifact_urls["screenshots"].append(f"/screenshot/{run_id}/{name}")

        # Trace
        trace_files = list(run_dir.glob("**/*.zip"))
        if trace_files:
            # Copy first trace to standard location
            trace_dest = run_dir / "trace.zip"
            if not trace_dest.exists() and trace_files[0] != trace_dest:
                import shutil as sh
                sh.copy2(str(trace_files[0]), str(trace_dest))
            artifact_urls["traceUrl"] = f"/trace/{run_id}"

        # Video
        video_files = list(run_dir.glob("**/*.webm"))
        if video_files:
            video_dir = run_dir / "video"
            video_dir.mkdir(exist_ok=True)
            if not (video_dir / video_files[0].name).exists():
                import shutil as sh
                sh.copy2(str(video_files[0]), str(video_dir / video_files[0].name))
            artifact_urls["videoUrl"] = f"/video/{run_id}"

        report = SpecTestReport(
            run_id=run_id,
            status=overall_status,
            duration_ms=duration_ms,
            total=total,
            passed=passed,
            failed=failed_count,
            skipped=skipped,
            tests=test_results,
            error=stderr_text if proc.returncode != 0 and not test_results else None,
        )

        logger.info(
            f"[run-spec:{run_id}] Complete — {overall_status} "
            f"({passed} passed, {failed_count} failed, {skipped} skipped) in {duration_ms}ms"
        )

        return report, artifact_urls

    except asyncio.TimeoutError:
        return SpecTestReport(
            run_id=run_id,
            status="failed",
            duration_ms=int((time.time() - start_time) * 1000),
            error="Playwright test timed out after 300s",
        ), {}
    except Exception as e:
        logger.exception(f"[run-spec:{run_id}] Execution error: {e}")
        return SpecTestReport(
            run_id=run_id,
            status="failed",
            duration_ms=int((time.time() - start_time) * 1000),
            error=str(e),
        ), {}
