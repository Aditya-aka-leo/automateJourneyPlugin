"""
Pydantic models for the Playwright Runner service.
"""

from enum import Enum
from typing import Any, Optional

from pydantic import AliasChoices, BaseModel, Field


# ── Enums ─────────────────────────────────────────────────────────

class StepStatus(str, Enum):
    PASSED = "passed"
    FAILED = "failed"
    SKIPPED = "skipped"
    SOFT_FAIL = "soft_fail"


class TestStatus(str, Enum):
    PASSED = "passed"
    FAILED = "failed"
    SOFT_FAILED = "soft_failed"


# ── Config models ─────────────────────────────────────────────────

class RunConfig(BaseModel):
    browser: str = Field(default="chromium", description="Browser engine: chromium, firefox, webkit")
    device: Optional[str] = Field(default=None, description="Device preset: 'iPhone 14', 'Pixel 7', etc.")
    viewport: Optional[dict] = Field(default=None, description="{ width, height }")
    base_url: str = Field(
        default="",
        alias="baseURL",
        validation_alias=AliasChoices("baseURL", "baseUrl", "base_url"),
    )
    geolocation: Optional[dict] = Field(default=None, description="{ latitude, longitude, accuracy? }")
    permissions: Optional[list[str]] = Field(default=None, description="Granted permissions list")
    timezone_id: Optional[str] = Field(default=None, alias="timezoneId")
    locale: Optional[str] = Field(default=None)
    storage_state: Optional[dict] = Field(default=None, alias="storageState")
    trace: bool = Field(default=False, description="Enable Playwright trace recording")
    video: bool = Field(default=False, description="Enable video recording")
    har: bool = Field(default=False, description="Enable HAR network capture")
    screenshots: bool = Field(default=True, description="Capture per-step screenshots")

    class Config:
        populate_by_name = True


class NetworkMock(BaseModel):
    url: str = Field(description="URL pattern (glob), e.g. '**/api/users'")
    method: Optional[str] = Field(default=None, description="HTTP method filter (GET, POST, etc.)")
    response: dict = Field(default_factory=lambda: {"status": 200, "body": {}})


# ── Request models ────────────────────────────────────────────────

class RunRequest(BaseModel):
    steps: list[dict] = Field(description="Array of recorded step objects")
    config: RunConfig = Field(default_factory=RunConfig)
    network_mocks: Optional[list[NetworkMock]] = Field(default=None, alias="networkMocks")
    block_patterns: Optional[list[str]] = Field(default=None, alias="blockPatterns", description="URL glob patterns to abort (e.g. '**/analytics/**')")
    run_id: Optional[str] = Field(default=None, alias="runId", description="Client-provided run ID for live streaming")

    class Config:
        populate_by_name = True


class RunParallelRequest(BaseModel):
    tests: list[dict] = Field(description="Array of test objects, each with steps/config/networkMocks")
    max_workers: int = Field(default=4, ge=1, le=16)


class ApiTestRequest(BaseModel):
    requests: list[dict] = Field(description="Array of API request objects")
    base_url: str = Field(
        default="",
        alias="baseURL",
        validation_alias=AliasChoices("baseURL", "baseUrl", "base_url"),
    )

    class Config:
        populate_by_name = True


# ── Report models ─────────────────────────────────────────────────

class StepReport(BaseModel):
    index: int
    type: str
    status: StepStatus
    duration_ms: int = 0
    error: Optional[str] = None
    screenshot: Optional[str] = None
    condition_result: Optional[bool] = None


class TestReport(BaseModel):
    run_id: str
    status: TestStatus
    duration_ms: int
    steps: list[StepReport]
    passed: int = 0
    failed: int = 0
    skipped: int = 0
    soft_fails: int = 0
    error: Optional[str] = None
    console_errors: Optional[list[str]] = None


class ArtifactPaths(BaseModel):
    run_id: str
    trace: Optional[str] = None
    video: Optional[str] = None
    har: Optional[str] = None
    screenshots: list[str] = Field(default_factory=list)


# ── Response models ───────────────────────────────────────────────

class RunResponse(BaseModel):
    ok: bool = True
    report: TestReport
    artifacts: dict = Field(default_factory=dict)


class RunParallelResponse(BaseModel):
    ok: bool = True
    results: list[RunResponse]


# ── Spec file execution models ───────────────────────────────────

class RunSpecRequest(BaseModel):
    spec_path: str = Field(description="Path to the .spec.ts file to execute")
    headed: bool = Field(default=False, description="Run with visible browser window")
    browsers: list[str] = Field(default_factory=lambda: ["chromium"], description="Browsers to run on")
    trace: bool = Field(default=True, description="Enable trace recording")
    video: bool = Field(default=False, description="Enable video recording")
    screenshots: bool = Field(default=True, description="Capture screenshots on failure")


class SpecStepReport(BaseModel):
    title: str
    status: str
    duration_ms: int = 0
    error: Optional[str] = None


class SpecTestReport(BaseModel):
    run_id: str
    status: str  # "passed", "failed", "timedOut"
    duration_ms: int = 0
    total: int = 0
    passed: int = 0
    failed: int = 0
    skipped: int = 0
    tests: list[SpecStepReport] = Field(default_factory=list)
    error: Optional[str] = None


class RunSpecResponse(BaseModel):
    ok: bool = True
    report: SpecTestReport
    artifacts: dict = Field(default_factory=dict)
