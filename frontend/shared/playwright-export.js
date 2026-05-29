/**
 * Export flows to Playwright test code.
 *
 * Requirements:
 * - Environment variables via process.env
 * - Reusable selectors
 * - Assertions translated correctly
 * - Clean, readable output
 */

import { getLatestVersion } from "./flows.js";

function toEnvVarName(name) {
  return String(name || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function envVarForEnv(env) {
  const base = env?.appId ? `${env.appId}_BASE_URL` : `ENV_${env?.id || "BASE"}_BASE_URL`;
  return toEnvVarName(base);
}

function quote(str) {
  return JSON.stringify(String(str || ""));
}

function selectorSignature(selector) {
  try {
    return JSON.stringify(selector || {});
  } catch {
    return String(selector || "");
  }
}

function buildSelectorMap(steps) {
  const map = new Map();
  let counter = 1;
  for (const step of steps) {
    if (!step?.selector) continue;
    const sig = selectorSignature(step.selector);
    if (!map.has(sig)) {
      map.set(sig, { id: `SEL_${counter}`, selector: step.selector });
      counter += 1;
    }
  }
  return map;
}

function getSelectorRef(selectorMap, selector) {
  const sig = selectorSignature(selector);
  return selectorMap.get(sig)?.id || null;
}

function resolveBaseUrlForStep(step, envs) {
  if (step?.envId) return envs.find((e) => e?.id === step.envId) || null;
  if (step?.appId) return envs.find((e) => String(e?.appId || "") === String(step.appId)) || null;
  return envs.find((e) => e?.isDefault) || envs[0] || null;
}

function buildUrlExpression(envVar, step) {
  const path = String(step?.relativePath || "/");
  const qp = step?.queryParams || {};
  const queryPairs = [];
  for (const [key, values] of Object.entries(qp)) {
    if (Array.isArray(values)) {
      for (const v of values) queryPairs.push([key, String(v)]);
    } else if (values != null) {
      queryPairs.push([key, String(values)]);
    }
  }

  if (queryPairs.length === 0) {
    return `\`${"${"}${envVar}}${path.startsWith("/") ? "" : "/"}${path}\``;
  }

  const queryString = queryPairs
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return `\`${"${"}${envVar}}${path.startsWith("/") ? "" : "/"}${path}?${queryString}\``;
}

function stepToPlaywright(step, selectorRef) {
  const type = step?.type;
  const value = step?.value;
  const meta = step?.meta || {};

  if (type === "navigation") {
    return { kind: "navigation" };
  }

  if (type === "click") {
    return { kind: "action", line: `await ${selectorRef}.click();` };
  }

  if (type === "input" || type === "change") {
    return { kind: "action", line: `await ${selectorRef}.fill(${quote(value ?? "")});` };
  }

  if (type === "submit") {
    return { kind: "action", line: `await ${selectorRef}.evaluate((el) => el.closest("form")?.requestSubmit?.() || el.closest("form")?.submit());` };
  }

  if (type === "hover") {
    return { kind: "action", line: `await ${selectorRef}.hover();` };
  }

  if (type === "scroll") {
    return { kind: "action", line: `await ${selectorRef}.scrollIntoViewIfNeeded();` };
  }

  if (type === "select") {
    return { kind: "action", line: `await ${selectorRef}.selectOption(${quote(value ?? "")});` };
  }

  if (type === "key" || type === "keypress") {
    const k = meta?.key || value || "Enter";
    let pwKey = k;
    if (meta?.ctrlKey) pwKey = "Control+" + pwKey;
    if (meta?.shiftKey) pwKey = "Shift+" + pwKey;
    if (meta?.altKey) pwKey = "Alt+" + pwKey;
    if (meta?.metaKey) pwKey = "Meta+" + pwKey;
    return { kind: "action", line: `await page.keyboard.press(${quote(pwKey)});` };
  }

  if (type === "upload") {
    const filePath = meta?.filePath || meta?.fileName || "test-file.txt";
    return { kind: "action", line: `await ${selectorRef}.setInputFiles(${quote(filePath)});` };
  }

  if (type === "drag_drop") {
    return { kind: "action", line: `await ${selectorRef}.dragTo(page.locator(${quote(meta?.targetSelector || "")}));` };
  }

  // ── Assertions ──
  if (type === "assert_exists" || type === "assert_visible") {
    return { kind: "assert", line: `await expect(${selectorRef}).toBeVisible();` };
  }
  if (type === "assert_hidden") {
    return { kind: "assert", line: `await expect(${selectorRef}).toBeHidden();` };
  }
  if (type === "assert_text_equals") {
    return { kind: "assert", line: `await expect(${selectorRef}).toHaveText(${quote(value ?? "")});` };
  }
  if (type === "assert_text_contains") {
    return { kind: "assert", line: `await expect(${selectorRef}).toContainText(${quote(value ?? "")});` };
  }
  if (type === "assert_attr_equals") {
    const attr = meta?.attr ? String(meta.attr) : "";
    return { kind: "assert", line: `await expect(${selectorRef}).toHaveAttribute(${quote(attr)}, ${quote(value ?? "")});` };
  }
  if (type === "assert_url_contains") {
    return { kind: "assert", line: `await expect(page).toHaveURL(new RegExp(${quote(String(value ?? ""))}));` };
  }
  if (type === "assert_checked") {
    return { kind: "assert", line: `await expect(${selectorRef}).toBeChecked();` };
  }
  if (type === "assert_disabled") {
    return { kind: "assert", line: `await expect(${selectorRef}).toBeDisabled();` };
  }
  if (type === "assert_enabled") {
    return { kind: "assert", line: `await expect(${selectorRef}).toBeEnabled();` };
  }
  if (type === "assert_has_class") {
    return { kind: "assert", line: `await expect(${selectorRef}).toHaveClass(new RegExp(${quote(value ?? "")}));` };
  }
  if (type === "assert_has_value") {
    return { kind: "assert", line: `await expect(${selectorRef}).toHaveValue(${quote(value ?? "")});` };
  }
  if (type === "assert_has_title") {
    return { kind: "assert", line: `await expect(page).toHaveTitle(new RegExp(${quote(value ?? "")}));` };
  }
  if (type === "assert_count") {
    return { kind: "assert", line: `await expect(${selectorRef}).toHaveCount(${parseInt(value, 10) || 0});` };
  }
  if (type === "assert_editable") {
    return { kind: "assert", line: `await expect(${selectorRef}).toBeEditable();` };
  }
  if (type === "assert_no_console_errors") {
    return { kind: "assert_console", line: `expect(consoleErrors, "Expected no console errors").toHaveLength(0);` };
  }
  if (type === "assert_screenshot") {
    return { kind: "assert", line: `await expect(page).toHaveScreenshot();` };
  }

  // ── Wait steps ──
  if (type === "wait_delay") {
    return { kind: "action", line: `await page.waitForTimeout(${parseInt(value, 10) || 1000});` };
  }
  if (type === "wait_for_url") {
    return { kind: "action", line: `await page.waitForURL(new RegExp(${quote(value ?? "")}));` };
  }
  if (type === "wait_for_text") {
    return { kind: "assert", line: `await expect(${selectorRef}).toContainText(${quote(value ?? "")});` };
  }
  if (type === "waitForElement") {
    return { kind: "action", line: `await ${selectorRef}.waitFor({ state: "visible" });` };
  }
  if (type === "waitForNavigation") {
    return { kind: "action", line: `await page.waitForNavigation();` };
  }

  // ── Control flow ──
  if (type === "if_exists") {
    return { kind: "control_if_exists", line: null };
  }
  if (type === "if_not_exists") {
    return { kind: "control_if_not_exists", line: null };
  }
  if (type === "end_if") {
    return { kind: "control_end_if", line: null };
  }
  if (type === "loop_start") {
    const count = parseInt(value, 10) || parseInt(meta?.loopCount, 10) || 1;
    return { kind: "control_loop_start", line: null, loopCount: count };
  }
  if (type === "loop_end") {
    return { kind: "control_loop_end", line: null };
  }

  return { kind: "comment", line: `// TODO: Unsupported step type: ${type}` };
}

/**
 * Core generator — takes a test name, steps array, and environments list.
 * Used by both flow and recording exporters.
 */
function generatePlaywrightScript(testName, steps, envs) {
  const selectorMap = buildSelectorMap(steps);
  const selectors = Array.from(selectorMap.values());

  const envList = Array.isArray(envs) ? envs : [];
  const envVarMap = new Map();
  for (const env of envList) {
    envVarMap.set(env.id, envVarForEnv(env));
  }

  const lines = [];
  lines.push(`import { test, expect } from "@playwright/test";`);
  lines.push("");
  lines.push(`const BASE_URLS = {`);
  for (const env of envList) {
    const envVar = envVarMap.get(env.id);
    lines.push(`  ${quote(env.id)}: process.env.${envVar} || ${quote(env.baseUrl || "")},`);
  }
  lines.push(`};`);
  lines.push("");
  lines.push(`function getBaseUrl(envId) {`);
  lines.push(`  const url = BASE_URLS[envId];`);
  lines.push(`  if (!url) throw new Error(\`Missing base URL for environment "\${envId}"\`);`);
  lines.push(`  return url.replace(/\\/+$/, "");`);
  lines.push(`}`);
  lines.push("");

  lines.push(`function resolveLocator(page, selector) {`);
  lines.push(`  const candidates = [];`);
  lines.push(`  if (selector?.primary) candidates.push(selector.primary);`);
  lines.push(`  if (Array.isArray(selector?.fallbacks)) candidates.push(...selector.fallbacks);`);
  lines.push(`  return { async firstVisible(timeoutMs = 4000) {`);
  lines.push(`    for (const c of candidates) {`);
  lines.push(`      try {`);
  lines.push(`        let locator;`);
  lines.push(`        switch (c.type) {`);
  lines.push(`          case "text": locator = page.getByText(c.value, { exact: true }); break;`);
  lines.push(`          case "role": locator = c.name ? page.getByRole(c.value, { name: c.name }) : page.getByRole(c.value); break;`);
  lines.push(`          case "label": locator = page.getByLabel(c.value); break;`);
  lines.push(`          case "placeholder": locator = page.getByPlaceholder(c.value); break;`);
  lines.push(`          case "xpath": locator = page.locator("xpath=" + c.value); break;`);
  lines.push(`          default: locator = page.locator(c.value); break;`);
  lines.push(`        }`);
  lines.push(`        if (c.matchIndex != null) locator = locator.nth(c.matchIndex);`);
  lines.push(`        else locator = locator.first();`);
  lines.push(`        await locator.waitFor({ state: "visible", timeout: timeoutMs });`);
  lines.push(`        return locator;`);
  lines.push(`      } catch {`);
  lines.push(`        // Try next candidate`);
  lines.push(`      }`);
  lines.push(`    }`);
  lines.push(`    throw new Error("Element not found using selector fallbacks.");`);
  lines.push(`  }};`);
  lines.push(`}`);
  lines.push("");

  if (selectors.length) {
    lines.push(`const SELECTORS = {`);
    for (const entry of selectors) {
      lines.push(`  ${entry.id}: ${JSON.stringify(entry.selector, null, 2)},`);
    }
    lines.push(`};`);
    lines.push("");
  }

  // Check if any step uses assert_no_console_errors
  const needsConsoleTracking = steps.some(s => s?.type === "assert_no_console_errors");

  lines.push(`test(${quote(testName)}, async ({ page }) => {`);

  // Add console error collector if needed
  if (needsConsoleTracking) {
    lines.push(`  const consoleErrors = [];`);
    lines.push(`  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });`);
    lines.push("");
  }

  let indent = "  ";   // current indentation
  let loopCounter = 0; // for unique loop variable names

  for (const step of steps) {
    const env = resolveBaseUrlForStep(step, envList);
    const envId = env?.id || (envList[0]?.id ?? "default");
    const envVar = envVarMap.get(envId) || "BASE_URL";

    if (step?.type === "navigation") {
      const urlExpr = buildUrlExpression(envVar, step);
      lines.push(`${indent}await page.goto(${urlExpr});`);
      continue;
    }

    const selectorRefId = step?.selector ? getSelectorRef(selectorMap, step.selector) : null;
    const selectorRef = selectorRefId ? `locator_${selectorRefId}` : "page";
    const op = stepToPlaywright(step, selectorRef);

    // ── Control flow ──
    if (op.kind === "control_if_exists" && selectorRefId) {
      lines.push(`${indent}// Conditional: if element exists`);
      lines.push(`${indent}if (await page.locator(SELECTORS.${selectorRefId}?.primary?.value || "").count() > 0) {`);
      indent += "  ";
      continue;
    }
    if (op.kind === "control_if_not_exists" && selectorRefId) {
      lines.push(`${indent}// Conditional: if element does NOT exist`);
      lines.push(`${indent}if (await page.locator(SELECTORS.${selectorRefId}?.primary?.value || "").count() === 0) {`);
      indent += "  ";
      continue;
    }
    if (op.kind === "control_if_exists" || op.kind === "control_if_not_exists") {
      // No selector — emit a commented-out block
      lines.push(`${indent}// Conditional: ${step.type} (no selector — skipped)`);
      lines.push(`${indent}if (true) { // TODO: add condition`);
      indent += "  ";
      continue;
    }
    if (op.kind === "control_end_if") {
      if (indent.length > 2) indent = indent.slice(2);
      lines.push(`${indent}}`);
      continue;
    }
    if (op.kind === "control_loop_start") {
      const count = op.loopCount || 1;
      const varName = `i_loop${loopCounter++}`;
      lines.push(`${indent}for (let ${varName} = 0; ${varName} < ${count}; ${varName}++) {`);
      indent += "  ";
      continue;
    }
    if (op.kind === "control_loop_end") {
      if (indent.length > 2) indent = indent.slice(2);
      lines.push(`${indent}}`);
      continue;
    }

    // ── Console error assertion ──
    if (op.kind === "assert_console") {
      lines.push(`${indent}${op.line}`);
      continue;
    }

    // ── Normal steps ──
    if (selectorRefId) {
      lines.push(`${indent}const ${selectorRef} = await resolveLocator(page, SELECTORS.${selectorRefId}).firstVisible();`);
    }
    if (op.line) lines.push(`${indent}${op.line}`);
  }
  lines.push(`});`);

  return lines.join("\n");
}

/**
 * Export a recording (with steps) to a Playwright test script.
 */
export function exportRecordingToPlaywright(recording, envs) {
  if (!recording) throw new Error("Recording is required.");
  const steps = Array.isArray(recording.steps) ? recording.steps : [];
  if (!steps.length) throw new Error("Recording has no steps.");
  const name = recording.name || recording.id || "Untitled Recording";
  return generatePlaywrightScript(name, steps, envs);
}

/**
 * Generate an HTML test report from a replay report object.
 */
export function generateHtmlReport(report, recording, env) {
  const name = recording?.name || report?.recordingId || "Test Run";
  const envName = env?.name || report?.envId || "Unknown";
  const steps = report?.steps || [];
  const passed = steps.filter(s => s.status === "passed").length;
  const failed = steps.filter(s => s.status === "failed").length;
  const skipped = steps.filter(s => s.status === "skipped" || s.status === "pending").length;
  const total = steps.length;
  const status = report?.status === "passed" ? "PASSED" : "FAILED";
  const statusColor = status === "PASSED" ? "#2ecc71" : "#e74c3c";
  const duration = report?.durationMs ? `${(report.durationMs / 1000).toFixed(1)}s` : "—";

  const stepRows = steps.map((s, i) => {
    const sStatus = s.status || "pending";
    const sColor = sStatus === "passed" ? "#2ecc71" : sStatus === "failed" ? "#e74c3c" : "#8891a5";
    const sIcon = sStatus === "passed" ? "&#10003;" : sStatus === "failed" ? "&#10007;" : "&#8212;";
    const errorHtml = s.error ? `<div class="step-error">${escHtml(s.error)}</div>` : "";
    const sType = escHtml(s.type || "action");
    const sName = escHtml(s.elementName || s.customName || s.nlDescription || sType);
    const sDur = s.durationMs ? `${s.durationMs}ms` : "";
    return `<tr>
      <td class="num">${i + 1}</td>
      <td><span class="badge">${sType.toUpperCase()}</span></td>
      <td>${sName}${errorHtml}</td>
      <td class="dur">${sDur}</td>
      <td style="color:${sColor};font-weight:700;">${sIcon} ${sStatus}</td>
    </tr>`;
  }).join("\n");

  function escHtml(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Test Report — ${escHtml(name)}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#0f1117;color:#e7e9ee;padding:24px;line-height:1.5}
  h1{font-size:22px;font-weight:800;margin-bottom:4px}
  .meta{color:#8891a5;font-size:13px;margin-bottom:20px}
  .summary{display:flex;gap:16px;margin-bottom:24px}
  .summary-card{padding:14px 20px;border-radius:10px;background:#161a26;border:1px solid rgba(255,255,255,0.07);min-width:100px;text-align:center}
  .summary-card .value{font-size:28px;font-weight:800}
  .summary-card .label{font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#8891a5;margin-top:2px}
  .status-banner{padding:12px 20px;border-radius:8px;font-weight:800;font-size:16px;margin-bottom:24px;text-align:center;letter-spacing:0.5px}
  table{width:100%;border-collapse:collapse;background:#161a26;border-radius:10px;overflow:hidden;border:1px solid rgba(255,255,255,0.07)}
  th{background:#1a1f2e;text-align:left;padding:10px 14px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#8891a5;font-weight:700}
  td{padding:10px 14px;border-top:1px solid rgba(255,255,255,0.04);font-size:13px;vertical-align:top}
  .num{width:40px;text-align:center;color:#8891a5}
  .dur{width:60px;text-align:right;color:#8891a5;font-size:12px}
  .badge{display:inline-block;padding:2px 6px;border-radius:4px;background:rgba(124,92,255,0.12);color:#a78bfa;font-size:10px;font-weight:700;letter-spacing:0.3px}
  .step-error{margin-top:4px;padding:4px 8px;background:rgba(231,76,60,0.08);border-left:2px solid #e74c3c;border-radius:3px;font-size:11px;color:#ff6b6b;font-family:monospace}
  @media(prefers-color-scheme:light){
    body{background:#f2f4f8;color:#111318}
    .summary-card{background:#fff;border-color:rgba(0,0,0,0.08)}
    table{background:#fff;border-color:rgba(0,0,0,0.08)}
    th{background:#f7f8fa}
    td{border-top-color:rgba(0,0,0,0.04)}
    .step-error{background:rgba(231,76,60,0.04)}
  }
</style>
</head>
<body>
<h1>Test Report</h1>
<div class="meta">${escHtml(name)} &middot; Env: ${escHtml(envName)} &middot; ${new Date(report?.startedAt || Date.now()).toLocaleString()}</div>

<div class="status-banner" style="background:${statusColor}22;color:${statusColor};border:1px solid ${statusColor}44">${status}</div>

<div class="summary">
  <div class="summary-card"><div class="value">${total}</div><div class="label">Total</div></div>
  <div class="summary-card"><div class="value" style="color:#2ecc71">${passed}</div><div class="label">Passed</div></div>
  <div class="summary-card"><div class="value" style="color:#e74c3c">${failed}</div><div class="label">Failed</div></div>
  <div class="summary-card"><div class="value" style="color:#8891a5">${skipped}</div><div class="label">Skipped</div></div>
  <div class="summary-card"><div class="value">${duration}</div><div class="label">Duration</div></div>
</div>

<table>
<thead><tr><th>#</th><th>Type</th><th>Step</th><th>Time</th><th>Status</th></tr></thead>
<tbody>
${stepRows}
</tbody>
</table>

<div class="meta" style="margin-top:20px;text-align:center">Generated by Autotest Extension</div>
</body>
</html>`;
}

export function exportFlowToPlaywright(flow, envs) {
  if (!flow) throw new Error("Flow is required.");
  const version = getLatestVersion(flow);
  if (!version) throw new Error("Flow has no versions.");
  const steps = Array.isArray(version.steps) ? version.steps : [];
  const testName = `${flow.name} @ ${version.version}`;
  return generatePlaywrightScript(testName, steps, envs);
}

/**
 * Generate a playwright.config.ts with multi-browser and viewport support.
 */
export function generatePlaywrightConfig(options = {}) {
  const {
    baseURL = '',
    viewport = { width: 1280, height: 720 },
    retries = 1,
    fullyParallel = true,
    browsers = ['chromium', 'firefox', 'webkit']
  } = options;

  const projects = browsers.map(b => `    {
      name: ${quote(b)},
      use: { ...devices['Desktop Chrome'] },
    }`).join(',\n');

  return `import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: ${fullyParallel},
  retries: ${retries},
  reporter: [["html"], ["list"]],
  use: {
    baseURL: process.env.BASE_URL || ${quote(baseURL)},
    viewport: { width: ${viewport.width}, height: ${viewport.height} },
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
${projects}
  ],
});
`;
}

/**
 * Generate a GitHub Actions CI workflow for running Playwright tests.
 */
export function generateGitHubActionsWorkflow(options = {}) {
  const { nodeVersion = '18', baseURL = '' } = options;

  // Build the BASE_URL env value separately to avoid template literal issues
  // with GitHub Actions ${{ }} syntax (which conflicts with JS template expressions).
  const ghSecret = '$' + '{{ secrets.BASE_URL }}';
  const baseUrlEnvValue = baseURL ? baseURL : ghSecret;

  return `name: Playwright Tests

on:
  push:
    branches: [main, master]
  pull_request:
    branches: [main, master]

jobs:
  test:
    timeout-minutes: 30
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '${nodeVersion}'

      - name: Install dependencies
        run: npm ci

      - name: Install Playwright browsers
        run: npx playwright install --with-deps

      - name: Run Playwright tests
        run: npx playwright test
        env:
          BASE_URL: ${baseUrlEnvValue}

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 14
`;
}
