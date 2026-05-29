# Adobe AI Labs Hackathon — Scoping Sheet

---

## Team Name
**Auto Mate**

## Build Title
**Autotest — AI-Powered End-to-End Test Generation & Execution from Natural Language**

## Build Type
**Workflow / Agent** — AI agent that autonomously generates, executes, and validates browser tests

## Target Impact Level
**Team-level** — QA teams, developers, and product managers across Adobe

---

## User Persona

| Persona | Role | Pain Point |
|---------|------|------------|
| **Primary** | QA Engineers / SDETs | Spend hours writing and maintaining E2E test suites manually |
| **Secondary** | Developers | Need regression tests but lack QA bandwidth |
| **Tertiary** | Product Managers / Designers | Want to validate user flows without writing code |

---

## Problem Statement

Writing and maintaining end-to-end browser tests is one of the most time-consuming tasks in software development. A typical E2E test for a single user flow takes **30–60 minutes** to write manually in Playwright/Selenium, requiring deep knowledge of CSS selectors, async patterns, and framework APIs. Test suites of 50+ tests can take **weeks** to create. When the UI changes, tests break and require manual updates.

This bottleneck means most teams have **inadequate test coverage**, leading to bugs reaching production, slower release cycles, and increased manual QA effort.

---

## Starting Context

The user opens any web application in Chrome, activates the Autotest extension, and either:

1. **Records** interactions (clicks, typing, navigation) via the extension's built-in recorder
2. **Describes** what to test in natural language (e.g., *"Test the login flow with invalid credentials and verify error messages"*)

No setup, no code editor, no test framework configuration required.

---

## Input Provided

| Mode | Input |
|------|-------|
| **AI Generation** | Natural language prompt + current page URL (auto-captured from active browser tab) |
| **Recording** | User's browser interactions — clicks, keystrokes, scrolls, navigations, assertions |
| **Headless Replay** | Recorded/generated test steps + configuration (browser type, viewport, device emulation) |

---

## Expected Output

1. **Generated Playwright `.spec.ts` test file** — production-ready, with proper assertions, waits, and error handling
2. **Step-by-step execution report** — pass/fail status per step with screenshots
3. **Rich artifacts** — Playwright trace files, HAR network logs, video recordings, step screenshots
4. **Live visual feed** — real-time CDP screencast of headless browser execution streamed to the extension
5. **Cross-browser/device results** — parallel execution across Chromium, Firefox, WebKit with desktop and mobile viewports

---

## Actual Output

All expected outputs are **fully functional and demonstrated end-to-end**:

- AI generates complete `.spec.ts` files from natural language using Claude API
- Tests execute in headless Playwright browsers via Docker with full artifact collection
- Live screencast streams via SSE (Server-Sent Events) to the extension popup in real time
- Real-time step progress tracking displays passed/failed/pending counts during execution
- Multi-browser parallel execution produces combined reporting with per-browser results
- Artifacts (trace, video, HAR, screenshots) are downloadable for post-run analysis

---

## Accuracy

| Metric | Value |
|--------|-------|
| **Test generation accuracy** | ~85–90% of generated tests run successfully on first attempt for standard web flows |
| **Replay fidelity** | 95%+ — recorded steps replay accurately with smart selector fallback (data-testid → aria → CSS → XPath) |
| **Assertion quality** | AI-generated assertions cover positive and negative cases with meaningful validation |

---

## Primary Impact Type
**Efficiency / Time Savings**

## Estimated Impact

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Test creation time per flow | 30–60 min | 2–5 min | **10–15x faster** |
| Test maintenance | Manual selector updates | Auto-regenerate from NL | **Near-zero maintenance** |
| Test coverage achievable | Limited by QA bandwidth | 3–5x more in same time | **3–5x coverage increase** |
| Team-level savings (5 QA engineers) | — | 20+ hours/week saved | **1,000+ hours/year** |
| Cost equivalent | — | — | **0.5–1 FTE per QA team** |

---

## Secondary Impact

- **Quality**: More comprehensive test coverage catches bugs earlier in the development cycle
- **Accessibility**: Non-technical team members (PMs, designers) can create and validate tests without coding
- **Developer Experience**: Faster feedback loops with instant test generation and headless execution
- **Cross-browser Confidence**: Parallel multi-browser testing catches browser-specific regressions automatically

---

## Key Assumptions

1. Users have Chrome browser installed (extension is Chrome MV3)
2. Docker is available for headless backend execution (or a hosted service endpoint is provided)
3. Claude API access is available for AI test generation
4. Target web applications are accessible from the test execution environment
5. Target apps use standard web technologies (HTML/CSS/JS) — not Canvas-only or WebGL-only apps

---

## Scalability Potential

| Dimension | How It Scales |
|-----------|---------------|
| **Horizontal** | Docker-based backend scales to N parallel test workers |
| **Organizational** | Chrome extension distributable via enterprise Chrome Web Store |
| **CI/CD Integration** | REST API backend plugs into GitHub Actions, Jenkins, or any pipeline |
| **Multi-tenant** | Backend can serve multiple teams/users simultaneously |
| **Enterprise** | Can integrate with Adobe's internal test infrastructure and deployment pipelines |

---

## Human Oversight

- **Generation review**: Users can review and edit AI-generated test code before execution
- **Step-by-step visibility**: Live screencast + real-time step progress provides full transparency
- **Artifact inspection**: Trace viewer, HAR logs, and video recordings enable thorough post-run analysis
- **No autonomous deployment**: Tests are generated and run locally — no automatic code commits or deployments
- **Responsible AI**: No sensitive user data sent to AI; only page structure and user prompts are transmitted

---

## Sensitive Data Used

| Data | Handling |
|------|----------|
| Page URLs and DOM structure | Sent to Claude API for test generation (no credentials or PII included) |
| User authentication tokens | **Not captured or transmitted** |
| Test artifacts (screenshots, videos, HAR) | Stored locally in Docker volumes, auto-cleaned after configurable retention |

---

## Architecture Overview

```
┌─────────────────────────────────────┐
│         Chrome Extension (MV3)       │
│  ┌─────────┐ ┌────────┐ ┌────────┐ │
│  │ Popup   │ │ Side   │ │Content │ │
│  │  UI     │ │ Panel  │ │Scripts │ │
│  └────┬────┘ └───┬────┘ └───┬────┘ │
│       └──────┬───┘           │      │
│         Service Worker (sw.js)       │
│              │                       │
└──────────────┼───────────────────────┘
               │ REST API
    ┌──────────┼──────────┐
    ▼                     ▼
┌──────────┐      ┌─────────────┐
│Generator │      │  Playwright  │
│ (Claude  │      │   Runner     │
│  API)    │      │  (headless)  │
│ :8002    │      │   :8001      │
└──────────┘      └─────────────┘
    Docker Compose
```

---

# AI Labs Hackathon Submission Form — Quick Reference

## Required Submissions (upload to shared folder before 11:59 PM):

1. **Completed Scoping Sheet** — This document
2. **2-Minute Demo Video** — Screen recording showing:
   - Opening the extension on a live website
   - Recording a user flow OR typing a natural language prompt
   - AI generating a Playwright test file
   - Running the test headless with live screencast feed
   - Viewing results: step progress, pass/fail, artifacts
3. **Link to the Build** — GitHub repo URL or deployed instance link

## Judging Criteria

| Criteria | Our Strengths |
|----------|---------------|
| **Impact** | 10–15x test creation speedup, team-wide efficiency gains, 1000+ hours/year saved |
| **Functionality** | Full working system: record → generate → execute → report, all integrated |
| **Scalability** | Docker-based, REST API, CI/CD-ready, multi-browser parallel execution |
| **UX** | Chrome extension with live feed, one-click flows, zero setup friction |
| **Innovation** | NL → E2E tests is novel; live CDP screencast during headless runs is unique |
| **Responsible AI** | Human review at every stage, no PII sent to AI, full transparency via artifacts |
