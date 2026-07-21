/**
 * Background service worker (MV3).
 *
 * Current scope:
 * - In-memory storage for recorded steps (per tab)
 * - Environment lookup for recorder (reads options via storage layer)
 *
 * TODO: Add durable run storage + diagnostics.
 * TODO: Implement recorder/replay state machine.
 * TODO: Implement message schema validation.
 */

import { createVersionedStore } from "../shared/storage.js";
import { addFlowVersion, createFlow, getLatestVersion } from "../shared/flows.js";
import { exportFlowToPlaywright, exportRecordingToPlaywright, generateHtmlReport, generatePlaywrightConfig, generateGitHubActionsWorkflow } from "../shared/playwright-export.js";
import { captureScreenshot, downloadBlob } from "../shared/media-capture.js";
import { generateDOCXReport } from "../shared/docx-generator.js";
import { batchRecordedToNL } from "../shared/step-converter.js";
import { playwrightToSteps } from "../shared/playwright-converter.js";

console.log("[sw] ✅ Service worker loaded successfully");

const STORE_ROOT_KEY = "autotest_root_v1";
const STORE_SCHEMA_VERSION = 1;
const ENV_KEY = "environments";
const FLOW_KEY = "flows";
const RECORDING_KEY = "recordings";

// ── Backend Orchestrator URL ─────────────────────────────────
const DEFAULT_BACKEND_URL = "http://localhost:8000";

/**
 * Get the backend orchestrator URL from storage.
 */
async function getBackendUrl() {
  try {
    const result = await chrome.storage.local.get(["backendConfig"]);
    const config = result.backendConfig || {};
    return (config.url || DEFAULT_BACKEND_URL).replace(/\/+$/, "");
  } catch (err) {
    console.error("[sw][backend] Failed to get backend config:", err);
    return DEFAULT_BACKEND_URL;
  }
}

/**
 * Get the Playwright Runner service URL (via orchestrator).
 * Falls back to http://localhost:8000/runner if not configured.
 */
async function getRunnerUrl() {
  try {
    const result = await chrome.storage.local.get(["runnerConfig"]);
    const config = result.runnerConfig || {};
    if (!config.enabled) return null;
    return `${await getBackendUrl()}/runner`;
  } catch (err) {
    console.error("[sw][runner] Failed to get runner config:", err);
    return null;
  }
}


const store = createVersionedStore({
  rootKey: STORE_ROOT_KEY,
  schemaVersion: STORE_SCHEMA_VERSION
});

const stepsByTab = new Map();
const replayLocks = new Map();
const lastReportByTab = new Map();
const recordingByTab = new Map();
const badgeTimersByTab = new Map();
const pausedReplays = new Map(); // Track paused replays by tabId
const screenshotsByTab = new Map(); // Track screenshots by tabId
const videoDataByTab = new Map(); // Track video data by tabId
const capturedNetworkByTab = new Map(); // Captured API responses during recording per tabId
const selectorHealing = {
  enabled: false,
  autoApply: false
};
const healingSuggestionsByStepId = new Map();
// Maps originTabId → Set of linked new-tab IDs recorded in the same session
const linkedTabsByOrigin = new Map();
// Maps tabId → its tab index within the current recording (0=origin, 1=first linked tab, etc.)
const tabIndexByTabId = new Map();
// The tab currently executing replay steps (switches on cross-tab; null when idle)
let activeReplayTabId = null;
// The origin tab where the replay was started (holds the lastReportByTab entry)
let activeReplayOriginTabId = null;

function getStepsForTab(tabId) {
  if (!stepsByTab.has(tabId)) stepsByTab.set(tabId, []);
  return stepsByTab.get(tabId);
}

async function getDefaultEnvironment() {
  const envs = (await store.get(ENV_KEY)) || [];
  if (!Array.isArray(envs) || envs.length === 0) return null;
  return envs.find((e) => e?.isDefault) || envs[0];
}

/**
 * Ensure an environment exists for the given URL.
 * If no environment matches the URL's origin, create one automatically.
 * @param {string} url - Full URL (e.g. "https://example.com/page")
 * @param {"ai"|"manual"} source - How the recording was created
 * @returns {Promise<{id: string, name: string, baseUrl: string}|null>} The matching or newly created environment
 */
async function ensureEnvironmentForUrl(url, source = "manual") {
  if (!url) return null;
  let origin;
  try {
    const parsed = new URL(url);
    origin = parsed.origin; // e.g. "https://example.com"
  } catch {
    return null; // invalid URL
  }

  const envs = (await store.get(ENV_KEY)) || [];

  // Check if any existing env matches this origin
  const match = envs.find((e) => {
    if (!e?.baseUrl) return false;
    try {
      return new URL(e.baseUrl).origin === origin;
    } catch {
      return false;
    }
  });
  if (match) {
    console.log("[sw][env] Existing environment matches URL:", match.name, origin);
    return match;
  }

  // No match — create a new environment
  const hostname = new URL(url).hostname; // e.g. "staging.example.com"
  const label = source === "ai" ? "Auto - AI" : "Auto - Manual";
  const envName = `${label} - ${hostname}`;
  const isFirst = envs.length === 0;
  const newEnv = {
    id: `auto_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    name: envName,
    baseUrl: origin,
    isDefault: isFirst,
    variables: [],
  };
  envs.push(newEnv);
  await store.set(ENV_KEY, envs);
  console.log("[sw][env] Auto-created environment:", envName, "→", origin);
  return newEnv;
}

async function getRecordingNameById(recordingId) {
  if (!recordingId) return null;
  const recordings = (await store.get(RECORDING_KEY)) || [];
  const recording = recordings.find(r => r.id === recordingId);
  return recording?.name || null;
}

function setRecordingBadge(tabId, active) {
  if (!tabId) return;

  // Always clear any existing timer first to prevent orphaned intervals
  const existingTimer = badgeTimersByTab.get(tabId);
  if (existingTimer) clearInterval(existingTimer);
  badgeTimersByTab.delete(tabId);

  if (!active) {
    // Clear badge immediately
    chrome.action.setBadgeText({ tabId, text: "" });
    // Safety: clear again after the interval period to win any race
    // with a pending setBadgeText("REC") from the last timer callback
    setTimeout(() => {
      chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
    }, 600);
    return;
  }

  chrome.action.setBadgeBackgroundColor({ tabId, color: "#ff4d4d" });
  let on = false;
  const timer = setInterval(() => {
    on = !on;
    chrome.action.setBadgeText({ tabId, text: on ? "REC" : "" });
  }, 500);
  badgeTimersByTab.set(tabId, timer);
}

function setReplayBadge(tabId, currentStep, totalSteps, status = "running") {
  if (!tabId) return;
  
  if (status === "clear") {
    chrome.action.setBadgeText({ tabId, text: "" });
    // Don't clear persisted status for "clear"
    return;
  }
  
  if (status === "running") {
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#4CAF50" });
    chrome.action.setBadgeText({ tabId, text: `${currentStep}/${totalSteps}` });
  } else if (status === "success") {
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#4CAF50" });
    chrome.action.setBadgeText({ tabId, text: "✓" });
    
    // Persist success status for this tab
    chrome.tabs.get(tabId, (tab) => {
      if (tab?.url) {
        const urlKey = new URL(tab.url).origin;
        chrome.storage.local.get(['badgeStatusByUrl'], (result) => {
          const statusMap = result.badgeStatusByUrl || {};
          statusMap[urlKey] = { status: 'success', text: '✓', color: '#4CAF50', timestamp: Date.now() };
          chrome.storage.local.set({ badgeStatusByUrl: statusMap });
        });
      }
    });
    
    // Don't auto-clear on success - let it persist
  } else if (status === "stopped") {
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#FFA500" });
    chrome.action.setBadgeText({ tabId, text: "⏹" });
    
    // Persist stopped status for this tab
    chrome.tabs.get(tabId, (tab) => {
      if (tab?.url) {
        const urlKey = new URL(tab.url).origin;
        chrome.storage.local.get(['badgeStatusByUrl'], (result) => {
          const statusMap = result.badgeStatusByUrl || {};
          statusMap[urlKey] = { status: 'stopped', text: '⏹', color: '#FFA500', timestamp: Date.now() };
          chrome.storage.local.set({ badgeStatusByUrl: statusMap });
        });
      }
    });
    
    // Don't auto-clear on stop - let it persist
  } else if (status === "failed") {
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#f44336" });
    chrome.action.setBadgeText({ tabId, text: "✗" });
    
    // Persist failure status for this tab
    chrome.tabs.get(tabId, (tab) => {
      if (tab?.url) {
        const urlKey = new URL(tab.url).origin;
        chrome.storage.local.get(['badgeStatusByUrl'], (result) => {
          const statusMap = result.badgeStatusByUrl || {};
          statusMap[urlKey] = { status: 'failed', text: '✗', color: '#f44336', timestamp: Date.now() };
          chrome.storage.local.set({ badgeStatusByUrl: statusMap });
        });
      }
    });
    
    // Don't auto-clear on failure - let it persist
  }
}

async function startRecordingOnTab(tabId) {
  console.log("[sw] startRecordingOnTab called, tabId:", tabId);
  const env = await getDefaultEnvironment();
  console.log("[sw] getDefaultEnvironment returned:", env?.name || "(null)");
  stepsByTab.set(tabId, []);
  capturedNetworkByTab.set(tabId, []);
  recordingByTab.set(tabId, true);
  setRecordingBadge(tabId, true);
  // tabIndex defaults to 0; linked tabs will override this in onCreated handler
  if (!tabIndexByTabId.has(tabId)) tabIndexByTabId.set(tabId, 0);

  // Load network filter patterns and push them to the content script.
  const {
    capturePatterns = [], capturePatternsEnabled = false,
    blockPatterns = [], blockPatternsEnabled = false
  } = await chrome.storage.local.get(['capturePatterns', 'capturePatternsEnabled', 'blockPatterns', 'blockPatternsEnabled']);
  const effectiveCapturePatterns = capturePatternsEnabled ? capturePatterns : [];
  const effectiveBlockPatterns = blockPatternsEnabled ? blockPatterns : [];
  if (effectiveCapturePatterns.length) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'set_capture_patterns', patterns: effectiveCapturePatterns });
    } catch {
      // Content script not yet injected; patterns will be sent again after injection below.
    }
  }
  if (effectiveBlockPatterns.length) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'network_mock_setup', mocks: [], blockPatterns: effectiveBlockPatterns });
    } catch {
      // Content script not yet injected; will be sent again after injection below.
    }
  }

  // Try sending recorder_start directly. If the content script is already
  // injected (via manifest), this succeeds on the first attempt.
  try {
    console.log("[sw] Sending recorder_start to tab", tabId);
    await chrome.tabs.sendMessage(tabId, { type: "recorder_start", env });
    console.log("[sw] recorder_start succeeded on first attempt");
    return env;
  } catch (firstErr) {
    console.log("[sw] recorder_start failed (content script may not be present), injecting…", firstErr?.message);
  }

  // Content script wasn't reachable — inject it only if not already present, then retry.
  try {
    const injected = await ensureContentScriptsInjected(tabId);
    console.log(injected ? "[sw] Injected content scripts…" : "[sw] Content scripts already present, skipping injection.");
    // Give the content script a moment to initialise its onMessage listener.
    await new Promise(r => setTimeout(r, 300));
    console.log("[sw] Retrying recorder_start after injection…");
    await chrome.tabs.sendMessage(tabId, { type: "recorder_start", env });
    console.log("[sw] recorder_start succeeded after injection");
    if (effectiveCapturePatterns.length) {
      try { await chrome.tabs.sendMessage(tabId, { type: 'set_capture_patterns', patterns: effectiveCapturePatterns }); } catch {}
    }
    if (effectiveBlockPatterns.length) {
      try { await chrome.tabs.sendMessage(tabId, { type: 'network_mock_setup', mocks: [], blockPatterns: effectiveBlockPatterns }); } catch {}
    }
  } catch (retryErr) {
    console.error("[sw] recorder_start retry failed:", retryErr);
    recordingByTab.set(tabId, false);
    setRecordingBadge(tabId, false);
    throw new Error("Recorder could not start. Make sure the page is a regular web page (http/https).");
  }
  return env;
}

async function stopRecordingOnTab(tabId) {
  recordingByTab.set(tabId, false);
  setRecordingBadge(tabId, false);
  try {
    await chrome.tabs.sendMessage(tabId, { type: "recorder_stop" });
  } catch {
    // Ignore if content script isn't available; state is cleared.
  }
  // Clear any block patterns that were applied during recording.
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'network_mock_teardown' });
  } catch {}

  // Merge steps from any still-open linked tabs. Tabs that closed early were already
  // merged inline by the onRemoved handler, so linked.size may be 0 here — that's fine.
  const linked = linkedTabsByOrigin.get(tabId);
  if (linked && linked.size > 0) {
    const originSteps = getStepsForTab(tabId);
    for (const linkedTabId of linked) {
      originSteps.push(...getStepsForTab(linkedTabId));
      recordingByTab.set(linkedTabId, false);
      try { await chrome.tabs.sendMessage(linkedTabId, { type: "recorder_stop" }); } catch (_) {}
      try { await chrome.tabs.sendMessage(linkedTabId, { type: 'network_mock_teardown' }); } catch (_) {}
      stepsByTab.delete(linkedTabId);
      capturedNetworkByTab.delete(linkedTabId);
    }
    originSteps.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  }
  linkedTabsByOrigin.delete(tabId);
  tabIndexByTabId.delete(tabId);
}

// Waits for a specific tab to load a real http/https URL.
// Handles blank new tabs (chrome://newtab) by continuing to watch until the user
// navigates to a real URL, or until timeoutMs (default 60 s for manual navigation).
function waitForTabLoad(tabId, timeoutMs = 60000) {
  return new Promise((resolve) => {
    let settled = false;
    function done(tab) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(tab);
    }
    const timer = setTimeout(() => done(null), timeoutMs);
    function isRealUrl(url) {
      return url && (url.startsWith('http://') || url.startsWith('https://'));
    }
    function onUpdated(id, info, tab) {
      if (id !== tabId) return;
      if (info.status === 'complete' && isRealUrl(tab.url)) done(tab);
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then(tab => {
      if (tab.status === 'complete' && isRealUrl(tab.url)) done(tab);
    }).catch(() => {});
  });
}

// Waits up to timeoutMs for any tab to load whose hostname matches domain.
// Also checks existing tabs immediately in case the tab already loaded before this is called.
function waitForTabWithDomain(domain, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let settled = false;
    function done(tab) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(tab);
    }
    const timer = setTimeout(() => done(null), timeoutMs);
    function onUpdated(id, info, tab) {
      if (info.status !== 'complete' || !tab.url) return;
      try { if (new URL(tab.url).hostname === domain) done(tab); } catch (_) {}
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.query({}).then(tabs => {
      for (const tab of tabs) {
        if (tab.status === 'complete' && tab.url) {
          try { if (new URL(tab.url).hostname === domain) { done(tab); return; } } catch (_) {}
        }
      }
    }).catch(() => {});
  });
}

// Waits for any brand-new tab to be created and load a real URL.
// Used during replay when switching to a same-domain tab (domain matching alone is ambiguous).
function waitForNewTabCreated(timeoutMs = 30000) {
  return new Promise((resolve) => {
    let settled = false;
    let pendingTabId = null;
    function done(tab) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onCreated.removeListener(onCreated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(tab);
    }
    const timer = setTimeout(() => done(null), timeoutMs);
    function onCreated(tab) { pendingTabId = tab.id; }
    function onUpdated(id, info, tab) {
      if (id !== pendingTabId || info.status !== 'complete') return;
      if (tab.url && (tab.url.startsWith('http://') || tab.url.startsWith('https://'))) done(tab);
    }
    chrome.tabs.onCreated.addListener(onCreated);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function loadFlows() {
  const flows = (await store.get(FLOW_KEY)) || [];
  return Array.isArray(flows) ? flows : [];
}

async function saveFlows(flows) {
  await store.set(FLOW_KEY, flows);
}

async function loadRecordings() {
  const recordings = (await store.get(RECORDING_KEY)) || [];
  return Array.isArray(recordings) ? recordings : [];
}

async function saveRecordings(recordings) {
  await store.set(RECORDING_KEY, recordings);
}

function findFlowById(flows, flowId) {
  return flows.find((f) => f?.id === flowId) || null;
}

function normalizeStep(step) {
  return {
    id: step.id || `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    type: String(step.type || "unknown"),
    timestamp: step.timestamp || Date.now(),
    relativePath: String(step.relativePath || ""),
    queryParams: step.queryParams || {},
    selector: step.selector || null,
    value: step.value ?? null,
    envId: step.envId || null,
    appId: step.appId || null,
    tabDomain: step.tabDomain || null,
    tabIndex: step.tabIndex ?? 0,
    meta: step.meta || {}
  };
}

function resolveNavigationPathForRunner(step) {
  const rel = typeof step?.relativePath === "string" ? step.relativePath.trim() : "";
  if (rel) return { path: rel, source: "relativePath" };

  const candidates = [
    { key: "url", value: step?.url },
    { key: "value", value: step?.value },
    { key: "meta.url", value: step?.meta?.url },
  ];
  for (const c of candidates) {
    if (typeof c.value === "string" && c.value.trim()) {
      return { path: c.value.trim(), source: c.key };
    }
  }
  return { path: "", source: "none" };
}

function normalizeRunnerSteps(steps) {
  return (steps || []).map((step, idx) => {
    if (!step || typeof step !== "object") return step;
    if (String(step.type || "") !== "navigation") return step;

    const { path, source } = resolveNavigationPathForRunner(step);
    if (!path || source === "relativePath") return step;

    const patched = { ...step, relativePath: path };
    console.warn(
      `[sw][runner] navigation step ${idx + 1} missing relativePath; using ${source}:`,
      path
    );
    return patched;
  });
}

function findEnvById(envs, envId) {
  if (!Array.isArray(envs)) return null;
  return envs.find((e) => e?.id === envId) || null;
}

function findEnvByAppId(envs, appId) {
  if (!Array.isArray(envs)) return null;
  const matches = envs.filter((e) => String(e?.appId || "") === String(appId));
  if (!matches.length) return null;
  return matches.find((e) => e?.isDefault) || matches[0];
}

function resolveEnvForStep(step, envs, defaultEnv) {
  if (step?.envId) {
    const env = findEnvById(envs, step.envId);
    if (!env) {
      throw new Error(`Environment not found for step.envId="${step.envId}".`);
    }
    return env;
  }
  if (step?.appId) {
    const env = findEnvByAppId(envs, step.appId);
    if (!env) {
      throw new Error(`Environment not found for step.appId="${step.appId}".`);
    }
    return env;
  }
  return defaultEnv;
}

function buildReplayUrl(env, step) {
  const baseUrl = String(env?.baseUrl || "").trim();
  if (!baseUrl) {
    throw new Error("Selected environment has no baseUrl.");
  }
  const url = new URL(baseUrl);
  const rel = String(step?.relativePath || "/");
  const joinedPath = rel.startsWith("/") ? rel : `/${rel}`;
  url.pathname = joinPaths(url.pathname, joinedPath);
  url.search = "";
  const qp = step?.queryParams || {};
  for (const [key, values] of Object.entries(qp)) {
    if (Array.isArray(values)) {
      for (const v of values) url.searchParams.append(key, String(v));
    } else if (values != null) {
      url.searchParams.append(key, String(values));
    }
  }
  return url.toString();
}

function joinPaths(basePath, relPath) {
  const base = String(basePath || "").replace(/\/+$/, "");
  const rel = String(relPath || "").replace(/^\/+/, "");
  return `/${[base, rel].filter(Boolean).join("/")}`;
}

// requireFreshLoad=true skips the "already complete" fast path and only
// resolves on a genuine future onUpdated "complete" event. Use this whenever
// the caller is about to (or just did) trigger a navigation itself — checking
// tab.status synchronously right after chrome.tabs.update() is racy, since
// Chrome hasn't always flipped status away from the *previous* page's
// "complete" by the time we read it, which let replay treat a page as loaded
// before it had even started navigating.
function waitForTabComplete(tabId, timeoutMs = 30000, { requireFreshLoad = false } = {}) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      // Don't reject - some pages never fully "complete" but are usable
      console.warn("[autotest] Navigation timeout, but continuing anyway...");
      resolve(); // Resolve instead of reject to allow replay to continue
    }, timeoutMs);

    function finish() {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      console.log("[autotest] Tab loaded successfully");
      resolve();
    }

    function listener(updatedTabId, info) {
      if (updatedTabId !== tabId) return;
      if (info.status === "complete") finish();
    }

    // Attach the listener before any synchronous check so we never miss a
    // transition that happens concurrently with it.
    chrome.tabs.onUpdated.addListener(listener);

    if (requireFreshLoad) return;

    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error(`Tab not found: ${chrome.runtime.lastError.message}`));
        return;
      }
      if (tab.status === "complete") {
        console.log("[autotest] Tab already complete");
        finish();
      }
    });
  });
}

// Poll the content script with lightweight pings until it responds, instead of
// blindly sleeping a fixed duration. Resolves as soon as the script is alive
// (typically well under 500ms) and only gives up after timeoutMs.
async function waitForContentScriptAlive(tabId, { timeoutMs = 8000, intervalMs = 100 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await chrome.tabs.sendMessage(tabId, { type: "ping" });
      if (resp?.alive) return true;
    } catch (_) {
      // Content script not yet listening — keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

// content.js/hud.js are ALSO declaratively auto-injected by manifest.json on
// every http/https page at document_idle. Re-injecting them unconditionally
// (as several call sites used to) races with that auto-injection and, when
// it loses the race, crashes with "Identifier 'state'/'HUD_ID' has already
// been declared" — since top-level const/class declarations can't be
// redeclared in the same JS realm. That crash silently aborts the ENTIRE
// re-injected script, including whatever recovery step it was meant to
// perform. Checking window.__autotestContentLoaded first makes this safe.
async function ensureContentScriptsInjected(tabId, { includeHud = true } = {}) {
  let contentLoaded = false;
  let hudLoaded = false;
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({ content: !!window.__autotestContentLoaded, hud: !!window.__autotestHudLoaded })
    });
    contentLoaded = r?.result?.content === true;
    hudLoaded = r?.result?.hud === true;
  } catch {
    // Tab may not support scripting (e.g. chrome:// pages) — treat as not loaded.
  }

  const files = [];
  if (includeHud && !hudLoaded) files.push("content/hud.js");
  if (!contentLoaded) files.push("content/content.js");
  if (files.length === 0) return false;
  await chrome.scripting.executeScript({ target: { tabId }, files });
  return true;
}

async function captureStepScreenshot(tabId, captureSettings, screenshots) {
  console.log("[autotest][capture] captureStepScreenshot called:", {
    tabId,
    captureEnabled: captureSettings?.screenshots,
    screenshotsArrayLength: screenshots?.length || 0
  });
  
  // Check if we should capture screenshots
  if (!captureSettings || !captureSettings.screenshots) {
    console.log("[autotest][capture] Screenshots disabled, skipping");
    return null;
  }
  
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.id != null) {
      await chrome.tabs.update(tabId, { active: true });
    }
    
    console.log("[autotest][capture] Attempting to capture screenshot for tab", tabId);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    console.log("[autotest][capture] Screenshot captured, size:", dataUrl?.length || 0);
    
    // Store screenshot if array is provided
    if (screenshots && Array.isArray(screenshots) && dataUrl) {
      screenshots.push(dataUrl);
      console.log("[autotest][capture] Screenshot added to array, total:", screenshots.length);
    }
    
    return dataUrl;
  } catch (err) {
    console.error("[autotest][capture] Screenshot capture failed:", err);
    return null;
  }
}

function buildReport({ envId, steps, recordingId }) {
  return {
    envId,
    recordingId: recordingId || null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: "running",
    steps: steps.map((s) => ({
      id: s.id,
      type: s.type,
      relativePath: s.relativePath,
      queryParams: s.queryParams,
      selector: s.selector || null,
      envId: s.envId || null,
      appId: s.appId || null,
      elementName: s.elementName || null,
      customName: s.customName || null,
      value: s.value || null,
      status: "pending",
      screenshot: null,
      consoleErrors: [],
      networkErrors: [],
      selectorAttempts: [],
      error: null
    })),
    summary: null
  };
}

function finalizeReport(report, status, error) {
  report.status = status;
  report.endedAt = new Date().toISOString();
  report.summary = {
    status,
    error: error ? { message: error.message, code: error.code || null } : null
  };
  return report;
}

// ── Service URLs (routed via orchestrator) ──────────────────

async function getGeneratorUrl() {
  return `${await getBackendUrl()}/generator`;
}

async function getGeneratorConfig() {
  try {
    const result = await chrome.storage.local.get(["generatorConfig"]);
    const config = result.generatorConfig || { model: "claude-opus-4-6" };
    // Migrate stale model IDs that have invalid date suffixes (-20250527)
    if (config.model && config.model.endsWith("-20250527")) {
      config.model = config.model.replace(/-20250527$/, "");
      await chrome.storage.local.set({ generatorConfig: config });
    }
    return config;
  } catch (err) {
    console.error("[sw][generator] Failed to get config:", err);
    return { model: "claude-opus-4-6" };
  }
}

/**
 * Get auth headers for orchestrator requests.
 * Returns { Authorization: "Bearer <token>" } if logged in, else {}.
 */
async function getAuthHeaders() {
  try {
    const result = await chrome.storage.local.get(["registryConfig"]);
    const cfg = result.registryConfig || {};
    if (cfg.sessionToken) return { "Authorization": `Bearer ${cfg.sessionToken}` };
    if (cfg.accessKey) return { "X-Access-Key": cfg.accessKey };
  } catch (_) { /* ignore */ }
  return {};
}

// ── AI Fix Step Prompt Builder ────────────────────────────────
function buildAIFixPrompt({ failedStep, failedStepIndex, error, selectorAttempts,
                            selectorHealing, notFoundTarget, contextSteps,
                            pageUrl, recordingName, pageSnapshot }) {
  const selectorInfo = failedStep.selector?.primary
    ? `${failedStep.selector.primary.type}: "${failedStep.selector.primary.value}"`
    : 'none';
  const fallbacks = (failedStep.selector?.fallbacks || [])
    .map(f => `${f.type}: "${f.value}"`).join(', ');

  let prompt = `A test step failed during browser replay. Analyze the failure and suggest a fixed step.

## Failed Step (index ${failedStepIndex})
- Type: ${failedStep.type}
- Name: ${failedStep.elementName || failedStep.customName || 'unnamed'}
- Selector: ${selectorInfo}
- Fallbacks: ${fallbacks || 'none'}
- Value: ${JSON.stringify(failedStep.value) || 'null'}
- Page: ${pageUrl}
- Recording: ${recordingName}

## Error
- Message: ${error?.message || 'Unknown'}
- Code: ${error?.code || 'NO_CODE'}`;

  if (notFoundTarget) {
    prompt += `\n- Target not found: ${notFoundTarget.name || ''}${notFoundTarget.text ? ` / "${notFoundTarget.text}"` : ''}`;
  }
  if (selectorHealing) {
    prompt += `\n- Healing suggestion: ${selectorHealing.name} (confidence: ${selectorHealing.confidence || 'unknown'})`;
  }
  if (selectorAttempts?.length) {
    prompt += `\n- Selector attempts: ${selectorAttempts.length}`;
    selectorAttempts.slice(0, 5).forEach((a, i) => {
      prompt += `\n  ${i + 1}. ${a.type}: "${a.value}" → ${a.found ? 'found' : 'not found'}`;
    });
  }

  if (contextSteps?.length) {
    prompt += `\n\n## Previous Steps (for context)`;
    contextSteps.forEach((s, i) => {
      prompt += `\n${i + 1}. [${s.type}] ${s.elementName || ''} ${s.value ? `= "${s.value}"` : ''} → selector: ${s.selector?.primary?.value || 'none'}`;
    });
  }

  if (pageSnapshot) {
    prompt += `\n\n## Current Page Elements (interactive)\n${pageSnapshot}`;
  }

  prompt += `\n\n## Instructions
Return a JSON object with the fixed step. The step must have:
- "type": the step type (click, input, fill, select, assert_visible, assert_text, navigation, etc.)
- "selector": { "primary": { "type": "css"|"text"|"xpath", "value": "..." }, "fallbacks": [...] }
- "value": the value if applicable (for input/fill/assert_text)
- "elementName": human-readable description

Match the element on the CURRENT page. Use the page elements list to find the best selector.
Prefer stable selectors: data-testid > aria-label > role+name > id > CSS class.
Return ONLY valid JSON, no markdown.`;

  return prompt;
}
  
async function runReplayOnTab({ tabId, env, steps, recordingId, skipNavigation = false, softAssertions = false }) {
  if (replayLocks.get(tabId)) {
    throw new Error("Replay already in progress for this tab.");
  }
  replayLocks.set(tabId, true);
  activeReplayTabId = tabId;
  activeReplayOriginTabId = tabId;
  const report = buildReport({ envId: env?.id || null, steps, recordingId });
  lastReportByTab.set(tabId, report); // Store initial report
  
  console.log("[autotest][replay] Starting replay on tab", tabId,
    skipNavigation ? "(from-step, no navigation)" : "(full replay)",
    "in background mode");
  
  // Load capture settings
  const captureSettingsData = await chrome.storage.local.get(['captureSettings']);
  const captureSettings = captureSettingsData.captureSettings || {
    screenshots: false,
    video: false,
    onFailureOnly: false
  };
  
  const screenshots = [];
  screenshotsByTab.set(tabId, screenshots);
  
  console.log("[autotest][capture] Capture settings:", captureSettings);
  
  if (skipNavigation) {
    // Page is already open — just a brief wait for content script readiness
    await new Promise(resolve => setTimeout(resolve, 300));
  } else {
    // Wait for tab to complete loading before starting replay
    try {
      await waitForTabComplete(tabId, 30000); // 30 second timeout
    } catch (tabErr) {
      console.warn("[autotest][replay] Tab load timeout, but continuing:", tabErr.message);
      // Send HUD update about slow page load
      chrome.tabs.sendMessage(tabId, { 
        type: "hud_update", 
        report: {
          ...report,
          status: "running",
          warning: "Page is taking longer than expected to load, but replay will continue..."
        }
      }).catch(() => {});
    }
    await new Promise(resolve => setTimeout(resolve, 1000)); // Extra delay for content script init
  }
  
  // Start video recording if enabled (AFTER content script is loaded)
  console.log("[autotest][video] Video recording check:", {
    videoEnabled: captureSettings.video,
    onFailureOnly: captureSettings.onFailureOnly,
    shouldStartVideo: captureSettings.video && !captureSettings.onFailureOnly
  });
  
  if (captureSettings.video && !captureSettings.onFailureOnly) {
    try {
      console.log("[autotest][video] ===== STARTING VIDEO RECORDING =====");
      console.log("[autotest][video] Sending video_start_recording message to tab:", tabId);
      
      const videoResp = await chrome.tabs.sendMessage(tabId, { 
        type: "video_start_recording"
      }).catch(err => {
        console.error("[autotest][video] Video recording message failed:", err);
        return { ok: false, error: err.message };
      });
      
      console.log("[autotest][video] Video start response:", videoResp);
      
      if (videoResp?.ok) {
        console.log("[autotest][video] ✅ Video recording started successfully");
      } else {
        console.warn("[autotest][video] ❌ Video recording failed to start:", videoResp?.error);
      }
    } catch (err) {
      console.error("[autotest][video] ❌ Exception starting video recording:", err);
    }
  } else {
    console.log("[autotest][video] Video recording not started (disabled or onFailureOnly mode)");
  }
  
  // activeTabId tracks which tab is currently being operated on.
  // It starts as tabId (the original replay tab) but switches when a step's
  // tabDomain differs — e.g. after a link opens a new tab.
  let activeTabId = tabId;
  // When we switch to a new tab we skip its first navigation step, because
  // that tab was opened by a click (already at the right URL).
  let skipNextNavOnNewTab = false;
  // Tracks which tab session index is currently active (mirrors step.tabIndex)
  let currentTabIndex = 0;
  // Pre-registered watcher for a same-domain cross-tab switch.
  // Started BEFORE the step that opens the new tab so the listener is
  // already in place when the click fires — avoids the race where the tab
  // is created before waitForNewTabCreated registers its onCreated listener.
  let pendingNewTabWatcher = null;

  try {
    const envs = (await store.get(ENV_KEY)) || [];

    for (let i = 0; i < steps.length; i += 1) {
      // Unconditional trace — logs EVERY step the loop visits, before any
      // skip/control-flow branch below has a chance to `continue` past it.
      // If a step's id never shows up here, it never reached the loop body
      // at all (e.g. missing from the `steps` array passed into this
      // function); if it shows up here but not in the "Sending message to
      // content script" trace further down, something between here and
      // there is skipping it.
      console.log(`[autotest][replay][step-trace] i=${i}/${steps.length} id=${steps[i]?.id} type=${steps[i]?.type} value=${JSON.stringify(steps[i]?.value)} selector=${steps[i]?.selector?.primary?.value || null}`);

      // Check if replay has been stopped
      if (!replayLocks.get(tabId)) {
        console.log("[autotest][replay] Replay stopped by user at step", i);
        report.status = "stopped";
        report.endedAt = new Date().toISOString();
        report.error = { message: "Replay stopped by user", code: "USER_STOPPED" };
        throw { report, code: "USER_STOPPED", message: "Replay stopped by user" };
      }
      
      // Check if replay is paused
      let wasPaused = false;
      if (pausedReplays.get(tabId)) {
        console.log("[autotest][replay] Entering pause wait loop at step", i, "tabId:", tabId);
      }
      while (pausedReplays.get(tabId)) {
        wasPaused = true;
        // Also check if stopped while paused
        if (!replayLocks.get(tabId)) {
          console.log("[autotest][replay] Replay stopped while paused at step", i);
          report.status = "stopped";
          report.endedAt = new Date().toISOString();
          report.error = { message: "Replay stopped by user", code: "USER_STOPPED" };
          throw { report, code: "USER_STOPPED", message: "Replay stopped by user" };
        }
        console.log("[autotest][replay] Paused at step", i, "- waiting for resume...");
        await new Promise(resolve => setTimeout(resolve, 500)); // Check every 500ms
      }
      // Only log "Resumed" if this step actually went through the pause-wait
      // loop above — pausedReplays.has(tabId) is false by default for nearly
      // every step (whether or not pause was ever used), so checking that
      // instead logged "Resumed!" on every single step, paused or not.
      if (wasPaused) {
        console.log("[autotest][replay] Resumed! Continuing from step", i);
      }
      
      const step = steps[i];
      const stepReport = report.steps[i];
      const stepEnv = resolveEnvForStep(step, envs, env);
      
      // Get screenshots array from map
      const screenshots = screenshotsByTab.get(tabId) || [];
      
      // Update badge to show progress
      setReplayBadge(tabId, i + 1, steps.length, "running");

      // ── Control flow: conditionals ──
      if (step?.type === "if_exists" || step?.type === "if_not_exists") {
        let elementFound = false;
        try {
          const checkResp = await chrome.tabs.sendMessage(activeTabId, {
            type: "replay_execute_step",
            step: { ...step, type: "assert_exists" },
            healingConfig: { enabled: false }
          });
          elementFound = !!checkResp?.ok;
        } catch { elementFound = false; }

        const shouldSkip = (step.type === "if_exists" && !elementFound) || (step.type === "if_not_exists" && elementFound);
        if (shouldSkip) {
          // Skip ahead to matching end_if
          let depth = 1;
          let j = i + 1;
          while (j < steps.length && depth > 0) {
            if (steps[j].type === "if_exists" || steps[j].type === "if_not_exists") depth++;
            if (steps[j].type === "end_if") depth--;
            if (depth > 0) { report.steps[j].status = "skipped"; report.steps[j].skipReason = `Conditional: ${step.type} not met`; }
            j++;
          }
          i = j - 1; // Will be incremented by for loop
          stepReport.status = "passed";
          stepReport.skipped = true;
          stepReport.skipReason = `Condition not met — skipped to end_if`;
          lastReportByTab.set(tabId, report);
          continue;
        }
        stepReport.status = "passed";
        lastReportByTab.set(tabId, report);
        continue;
      }
      if (step?.type === "end_if") {
        stepReport.status = "passed";
        lastReportByTab.set(tabId, report);
        continue;
      }

      // ── Control flow: loops ──
      if (step?.type === "loop_start") {
        const loopCount = parseInt(step?.value, 10) || 1;
        if (!step._loopRemaining && step._loopRemaining !== 0) {
          step._loopRemaining = loopCount - 1; // first iteration is implicit
        }
        stepReport.status = "passed";
        lastReportByTab.set(tabId, report);
        continue;
      }
      if (step?.type === "loop_end") {
        // Find matching loop_start going backwards
        let depth = 1;
        let j = i - 1;
        while (j >= 0 && depth > 0) {
          if (steps[j].type === "loop_end") depth++;
          if (steps[j].type === "loop_start") depth--;
          if (depth > 0) j--;
        }
        if (j >= 0 && steps[j]._loopRemaining > 0) {
          steps[j]._loopRemaining--;
          i = j; // Jump back to loop_start (will be incremented by for loop, then skip loop_start)
          stepReport.status = "passed";
          lastReportByTab.set(tabId, report);
          continue;
        }
        // Loop finished — clean up
        if (j >= 0) delete steps[j]._loopRemaining;
        stepReport.status = "passed";
        lastReportByTab.set(tabId, report);
        continue;
      }
      
      console.log("[autotest][replay] step start", { idx: i, id: step?.id, type: step?.type, value: step?.value, envId: stepEnv?.id || null });

      // ── Cross-tab tab-index switch ───────────────────────────────────────
      // Switch tabs when the step's tabIndex differs from the currently active
      // tabIndex. This handles BOTH different-domain and same-domain cross-tab.
      const stepTabIndex = step.tabIndex ?? 0;
      if (stepTabIndex !== currentTabIndex) {
        let newTab = null;

        if (stepTabIndex === 0) {
          activeTabId = tabId;
          currentTabIndex = 0;
          skipNextNavOnNewTab = false;
          activeReplayTabId = activeTabId;
        } else {
          const stepDomain = step.tabDomain || null;
          let currentDomain = null;
          try {
            const currentTab = await chrome.tabs.get(activeTabId).catch(() => null);
            if (currentTab?.url) currentDomain = new URL(currentTab.url).hostname;
          } catch (_) {}

          if (stepDomain && stepDomain !== currentDomain) {
            newTab = await waitForTabWithDomain(stepDomain, 30000);
          } else if (pendingNewTabWatcher) {
            // Listener was pre-registered before the triggering step — guaranteed
            // to have caught the tab even if it opened before this code runs.
            console.log(`[replay] Step ${i}: Using pre-registered tab watcher for same-domain cross-tab switch`);
            newTab = await pendingNewTabWatcher;
            pendingNewTabWatcher = null;
          } else {
            newTab = await waitForNewTabCreated(30000);
          }

          if (!newTab) {
            const desc = stepDomain && stepDomain !== currentDomain
              ? `domain "${stepDomain}"`
              : `new tab (same domain "${currentDomain}")`;
            const err = new Error(`Waiting for ${desc} — nothing appeared within 30 s`);
            err.code = "CROSS_TAB_TIMEOUT";
            stepReport.status = "failed";
            stepReport.error = { message: err.message, code: err.code };
            lastReportByTab.set(tabId, report);
            throw err;
          }

          activeTabId = newTab.id;
          currentTabIndex = stepTabIndex;
          skipNextNavOnNewTab = true;
          activeReplayTabId = activeTabId;
        }

        // Re-inject content scripts and show the HUD on the tab we just switched to
        try {
          await ensureContentScriptsInjected(activeTabId);
          await new Promise(r => setTimeout(r, 500));
        } catch (injErr) {
          console.warn("[autotest][replay] Could not inject content scripts into switched tab:", injErr?.message);
        }
        // Show the HUD so the user can see replay progress on the new tab
        chrome.tabs.sendMessage(activeTabId, { type: "hud_show" }).catch(() => {});
        // Also activate the tab so it's visible
        chrome.tabs.update(activeTabId, { active: true }).catch(() => {});
      }

      // ── Pre-register tab watcher for the next step if it needs a same-domain switch ──
      // We start waitForNewTabCreated HERE (before executing the current step) so
      // its onCreated listener is in place when the click fires and opens the new tab.
      // For different-domain switches, waitForTabWithDomain checks existing tabs at
      // call time, so no pre-registration is needed there.
      if (pendingNewTabWatcher === null) {
        const nextStep = steps[i + 1];
        if (nextStep) {
          const nextTabIdx = nextStep.tabIndex ?? 0;
          if (nextTabIdx !== currentTabIndex && nextTabIdx > 0) {
            const nextDomain = nextStep.tabDomain || null;
            let curDomain = null;
            try {
              const cur = await chrome.tabs.get(activeTabId).catch(() => null);
              if (cur?.url) curDomain = new URL(cur.url).hostname;
            } catch (_) {}
            if (!nextDomain || nextDomain === curDomain) {
              console.log(`[replay] Step ${i}: Pre-registering tab watcher for same-domain cross-tab switch at step ${i + 1}`);
              pendingNewTabWatcher = waitForNewTabCreated(30000);
            }
          }
        }
      }
      // ─────────────────────────────────────────────────────────────────────────────

      // Skip the FIRST navigation step encountered after switching to a new tab.
      // The tab is already open at the right URL (opened by the triggering click),
      // so replaying the recorded navigation would reload to the old journey URL.
      // Non-navigation steps do NOT clear the flag — we hold it until we see a nav.
      if (step?.type === "navigation" && skipNextNavOnNewTab) {
        skipNextNavOnNewTab = false;
        stepReport.status = "passed";
        stepReport.skipped = true;
        stepReport.skipReason = "Initial navigation skipped — tab already open at this URL";
        lastReportByTab.set(tabId, report);
        continue;
      }
      // ────────────────────────────────────────────────────────────────────

      if (step?.type === "navigation") {
        const navKind = step?.meta?.kind;
        const prevStep = i > 0 ? steps[i - 1] : null;
        const prevWasClick = prevStep?.type === 'click' || prevStep?.type === 'input' || prevStep?.type === 'change' || prevStep?.type === 'submit';
        
        // Skip SPA navigations (pushState/replaceState) that follow a click.
        // In React/Angular/Vue SPAs and micro-frontend architectures, the click
        // step already triggers the SPA transition — replaying a separate
        // navigation step would cause a destructive full page reload.
        if ((navKind === 'pushState' || navKind === 'replaceState') && prevWasClick) {
          console.log("[autotest][replay] Skipping SPA navigation (", navKind, ") after click step — SPA transition handled by click");
          stepReport.status = "passed";
          stepReport.skipped = true;
          stepReport.skipReason = "SPA navigation handled by preceding click";
          lastReportByTab.set(tabId, report);
          continue;
        }
        
        const url = buildReplayUrl(stepEnv, step);
        console.log("[autotest][replay] navigation", { idx: i, url, kind: navKind });
        // Arm the completion listener BEFORE triggering navigation so we can't
        // miss the transition, then require a fresh "complete" event rather
        // than trusting a possibly-stale status snapshot from the old page.
        const tabCompletePromise = waitForTabComplete(activeTabId, 30000, { requireFreshLoad: true });
        await chrome.tabs.update(activeTabId, { url });
        await tabCompletePromise;

        // Poll for the content script instead of blindly sleeping — it may be
        // ready sooner (fast page) or later (slow bundle) than any fixed delay.
        const scriptAlive = await waitForContentScriptAlive(activeTabId);
        if (!scriptAlive) {
          throw new Error("Content script did not respond after navigation.");
        }

        const readyResp = await chrome.tabs.sendMessage(activeTabId, {
          type: "replay_wait_ready"
        });
        
        if (!readyResp?.ok) {
          const err = new Error(readyResp?.error || "Post-navigation wait failed.");
          err.code = readyResp?.code || "WAIT_FAILED";
          throw err;
        }
        stepReport.status = "passed";
        stepReport.screenshot = await captureStepScreenshot(activeTabId, captureSettings, screenshots);
        lastReportByTab.set(tabId, report); // Update report after each step
        continue;
      }

      // Check if content script is alive before each step
      console.log(`[autotest][replay] Step ${i}: Pinging content script...`);
      let contentScriptAlive = false;
      let needsActivation = false;

      try {
        const pingStartTime = Date.now();
        const pingResp = await Promise.race([
          chrome.tabs.sendMessage(activeTabId, { type: "ping" }),
          new Promise((_, rej) => setTimeout(() => rej(new Error("ping timeout")), 5000))
        ]);
        const pingDuration = Date.now() - pingStartTime;
        
        if (pingResp?.alive) {
          console.log(`[autotest][replay] Step ${i}: Content script is alive`);
          contentScriptAlive = true;
          
          // If a new tab stole focus, bring the replay tab back to the foreground.
          if (pingResp?.documentHidden === true) {
            console.log(`[autotest][replay] Step ${i}: Tab is hidden (another tab took focus), activating...`);
            await chrome.tabs.update(activeTabId, { active: true });
          }
        }
      } catch (pingErr) {
        console.warn(`[autotest][replay] Step ${i}: Content script not responding to ping:`, pingErr);
        needsActivation = true;
      }
      
      // Only activate tab if content script is not responding
      if (needsActivation || !contentScriptAlive) {
        console.log(`[autotest][replay] Step ${i}: Activating tab due to unresponsive content script...`);
        let activateAttempts = 0;
        while (activateAttempts < 3) {
          try {
            const tab = await chrome.tabs.get(activeTabId);
            console.log(`[autotest][replay] Step ${i}: Tab state before activation:`, {
              active: tab.active,
              status: tab.status,
              url: tab.url
            });

            await chrome.tabs.update(activeTabId, { active: true });

            // Verify activation
            const updatedTab = await chrome.tabs.get(activeTabId);
            console.log(`[autotest][replay] Step ${i}: Tab state after activation:`, {
              active: updatedTab.active,
              status: updatedTab.status
            });

            if (updatedTab.active) {
              console.log(`[autotest][replay] Step ${i}: Tab successfully activated`);
              break;
            } else {
              throw new Error("Tab did not become active");
            }
          } catch (updateErr) {
            activateAttempts++;
            console.warn(`[autotest][replay] Step ${i}: Could not activate tab (attempt ${activateAttempts}/3):`, updateErr);
            if (activateAttempts < 3) {
              await new Promise(resolve => setTimeout(resolve, 500));
            }
          }
        }

        if (activateAttempts >= 3) {
          console.error(`[autotest][replay] Step ${i}: FAILED to activate tab after 3 attempts`);
        }

        // Add delay after activation to let Chrome settle
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      // If content script still not alive, try to reinject
      if (!contentScriptAlive) {
        console.log(`[autotest][replay] Step ${i}: Attempting to reinject content script...`);
        try {
          // Also reinject HUD if it was enabled for this tab
          const hudState = await chrome.storage.local.get([`hudEnabled_${activeTabId}`]);
          await ensureContentScriptsInjected(activeTabId, { includeHud: !!hudState[`hudEnabled_${activeTabId}`] });

          console.log(`[autotest][replay] Step ${i}: Content script reinjected successfully`);

          // Poll until the reinjected script responds instead of guessing a fixed delay.
          if (await waitForContentScriptAlive(activeTabId)) {
            console.log(`[autotest][replay] Step ${i}: Content script verified after reinjection`);
            contentScriptAlive = true;
          }
        } catch (reinjectErr) {
          console.error(`[autotest][replay] Step ${i}: Failed to reinject content script:`, reinjectErr);
        }
      }

      if (!contentScriptAlive) {
        console.error(`[autotest][replay] Step ${i}: Content script is not available, cannot continue`);
        throw new Error("Content script is not responding. The page may have been suspended or navigated.");
      }

      console.log(`[autotest][replay][step-trace] Step ${i}: Sending message to content script...`, { id: step?.id, type: step?.type, value: step?.value });

      let resp;
      // Must exceed content.js's own internal waits (up to 10 minutes for a
      // slow-loading popup's target element / loading indicator, see
      // DEFAULT_WAIT in content.js) plus a buffer, so this outer guard never
      // fires first and masks the more specific ELEMENT_NOT_FOUND /
      // LOADING_INDICATOR_TIMEOUT failure content.js would otherwise report.
      const stepTimeoutMs = 660000; // 11 minutes max per step
      try {
        const sendStartTime = Date.now();
        resp = await Promise.race([
          chrome.tabs.sendMessage(activeTabId, {
            type: "replay_execute_step",
            step,
            env: stepEnv,
            healingConfig: selectorHealing
          }),
          new Promise((_, rej) => setTimeout(() => rej(new Error(`Step execution timed out after ${stepTimeoutMs / 1000}s`)), stepTimeoutMs))
        ]);
        const sendDuration = Date.now() - sendStartTime;
        
        console.log(`[autotest][replay][step-trace] Step ${i}: Received response from content script:`, {
          id: step?.id,
          ok: resp?.ok,
          code: resp?.code,
          sendDuration
        });
      } catch (sendErr) {
        // If sendMessage fails, the page might have navigated.
        // Chrome uses several different strings for this class of error.
        const errMsg = sendErr?.message || String(sendErr);
        console.error(`[autotest][replay][step-trace] Step ${i}: sendMessage THREW`, { id: step?.id, type: step?.type, value: step?.value, error: errMsg });
        const isChannelError = (
          errMsg.includes("Receiving end does not exist") ||
          errMsg.includes("message channel closed") ||
          errMsg.includes("message port closed") ||
          errMsg.includes("back/forward cache") ||
          errMsg.includes("timed out") ||
          errMsg.includes("asynchronous response")   // "A listener indicated an asynchronous response..."
        );

        let retriedAfterNav = false;

        if (isChannelError) {
          console.log("[autotest][replay] Step triggered navigation (channel closed), waiting for page load...");
          await waitForTabComplete(activeTabId);
          await new Promise(resolve => setTimeout(resolve, 500));

          // Re-inject content scripts if the new page's own auto-injection
          // (via manifest.json's content_scripts) hasn't happened/landed yet.
          try {
            await ensureContentScriptsInjected(activeTabId);
            console.log("[autotest][replay] Re-injected content scripts after navigation");
            await new Promise(resolve => setTimeout(resolve, 300));
          } catch (injectErr) {
            console.warn("[autotest][replay] Could not re-inject content scripts:", injectErr?.message);
          }

          // Now verify the new page is ready. No artificial timeout here —
          // replay_wait_ready itself already waits as long as genuinely
          // needed (see waitForPageIdle); racing it against a short fixed
          // timeout just aborts the whole replay on any page that happens to
          // take longer than that to settle after the navigation.
          try {
            const scriptAlive = await waitForContentScriptAlive(activeTabId);
            if (!scriptAlive) {
              throw new Error("Content script did not respond after navigation.");
            }
            const readyResp = await chrome.tabs.sendMessage(activeTabId, { type: "replay_wait_ready" });
            if (readyResp?.ok) {
              // A click/submit plausibly caused a real navigation, in which
              // case the triggering step already did its job — assume passed.
              // But "input"/"change" steps typing a value can NOT legitimately
              // cause a channel-closing navigation on their own; a channel
              // closure here almost always means an unrelated async re-render
              // (e.g. a prefill/journey API call reshaping the DOM) raced with
              // the input and killed the port before the value was confirmed
              // set. Blindly marking it "passed" reports false success while
              // the field is actually left empty — re-send it against the
              // now-recovered page instead of assuming it worked.
              if (step?.type === "input" || step?.type === "change") {
                console.log(`[autotest][replay][step-trace] Step ${i}: re-sending input/change after channel closure (value likely never applied)`);
                try {
                  resp = await Promise.race([
                    chrome.tabs.sendMessage(activeTabId, {
                      type: "replay_execute_step",
                      step,
                      env: stepEnv,
                      healingConfig: selectorHealing
                    }),
                    new Promise((_, rej) => setTimeout(() => rej(new Error("Retry after channel closure timed out")), stepTimeoutMs))
                  ]);
                  console.log(`[autotest][replay][step-trace] Step ${i}: retry response`, { id: step?.id, ok: resp?.ok, code: resp?.code });
                } catch (retryErr) {
                  console.error(`[autotest][replay][step-trace] Step ${i}: retry after channel closure also failed`, retryErr?.message);
                  resp = { ok: false, error: `Retry after channel closure failed: ${retryErr?.message}`, code: "RETRY_AFTER_NAV_FAILED" };
                }
                // Let the normal resp?.ok handling below (after this whole
                // try/catch) report the retry's real outcome, instead of the
                // unconditional failure branch further down.
                retriedAfterNav = true;
              } else {
                stepReport.status = "passed";
                stepReport.screenshot = await captureStepScreenshot(activeTabId, captureSettings, screenshots);
                lastReportByTab.set(tabId, report);
                continue;
              }
            }
          } catch (readyErr) {
            console.error("[autotest][replay] Failed to verify page ready after navigation:", readyErr?.message);
          }
        }

        if (!retriedAfterNav) {
          // Not a navigation error, or verification failed — surface as step failure
          if (softAssertions) {
            // In soft mode, log and continue instead of aborting
            console.warn(`[autotest][replay] Step ${i} failed (soft mode, continuing):`, errMsg);
            stepReport.status = "soft_fail";
            stepReport.error = { message: errMsg, code: "EXEC_ERROR", soft: true };
            stepReport.screenshot = await captureStepScreenshot(activeTabId, captureSettings, screenshots);
            lastReportByTab.set(tabId, report);
            continue;
          }
          throw new Error("Failed to execute step: " + errMsg);
        }
      }
      
      console.log("[autotest][replay] step response", { idx: i, ok: !!resp?.ok, code: resp?.code || null });
      if (!resp?.ok) {
        const msg = resp?.error || "Step failed.";
        const err = new Error(msg);
        err.code = resp?.code || "STEP_FAILED";
        err.step = step;
        console.log("[autotest][replay] step failed", { idx: i, code: err.code, message: err.message });

        // ── Soft mode: if softAssertions is on OR step has meta.soft, don't stop ──
        const isAssertStep = (step?.type || '').startsWith('assert_');
        const isSoft = softAssertions || step?.meta?.soft === true;

        if (isSoft) {
          // In soft mode, ALL failures (actions + assertions) are non-fatal
          stepReport.status = "soft_fail";
          stepReport.consoleErrors = resp?.debug?.consoleErrors || [];
          stepReport.networkErrors = resp?.debug?.networkErrors || [];
          stepReport.selectorAttempts = resp?.debug?.selectorAttempts || [];
          stepReport.selectorHealing = healingSuggestionsByStepId.get(step.id) || resp?.debug?.selectorHealing || null;
          stepReport.notFoundTarget = resp?.debug?.notFoundTarget || null;
          stepReport.error = { message: msg, code: err.code, soft: true };
          stepReport.screenshot = await captureStepScreenshot(activeTabId, captureSettings, screenshots);
          lastReportByTab.set(tabId, report);
          console.log(`[autotest][replay] Soft failure (${isAssertStep ? 'assertion' : 'action'}) — continuing:`, msg);
          // Continue to next step instead of throwing
        } else {
          stepReport.status = "failed";
          stepReport.consoleErrors = resp?.debug?.consoleErrors || [];
          stepReport.networkErrors = resp?.debug?.networkErrors || [];
          stepReport.selectorAttempts = resp?.debug?.selectorAttempts || [];
          stepReport.selectorHealing = healingSuggestionsByStepId.get(step.id) || resp?.debug?.selectorHealing || null;
          stepReport.notFoundTarget = resp?.debug?.notFoundTarget || null;
          stepReport.error = { message: err.message, code: err.code };
          stepReport.screenshot = await captureStepScreenshot(activeTabId, captureSettings, screenshots);
          lastReportByTab.set(tabId, report);
          throw err;
        }
      } else {
        stepReport.status = "passed";
        stepReport.consoleErrors = resp?.debug?.consoleErrors || [];
        stepReport.networkErrors = resp?.debug?.networkErrors || [];
        stepReport.selectorAttempts = resp?.debug?.selectorAttempts || [];
        stepReport.selectorHealing = healingSuggestionsByStepId.get(step.id) || resp?.debug?.selectorHealing || null;
        stepReport.notFoundTarget = resp?.debug?.notFoundTarget || null;
        stepReport.screenshot = await captureStepScreenshot(activeTabId, captureSettings, screenshots);
        lastReportByTab.set(tabId, report);
      }

      // ── Post-click navigation recovery ──────────────────────────────
      // Clicks (and form submits) often trigger full-page navigations.
      // After a click step succeeds, briefly check if the page navigated
      // so the next step isn't sent to a dead content script.
      if (step?.type === "click" || step?.type === "submit") {
        await new Promise(r => setTimeout(r, 500)); // let navigation start
        try {
          await Promise.race([
            chrome.tabs.sendMessage(activeTabId, { type: "ping" }),
            new Promise((_, rej) => setTimeout(() => rej(new Error("post-click ping timeout")), 3000))
          ]);
          // Content script still alive — no navigation, proceed normally
        } catch (_postClickErr) {
          // Content script gone — page likely navigated
          console.log("[autotest][replay] Post-click navigation detected, waiting for new page…");
          await waitForTabComplete(activeTabId, 30000);
          await new Promise(r => setTimeout(r, 800)); // wait for content script init via manifest
          // Verify new content script is alive
          let recovered = false;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const pr = await Promise.race([
                chrome.tabs.sendMessage(activeTabId, { type: "ping" }),
                new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000))
              ]);
              if (pr?.alive) { recovered = true; break; }
            } catch {
              // Try re-injecting on second attempt
              if (attempt === 1) {
                try {
                  await ensureContentScriptsInjected(activeTabId);
                  await new Promise(r => setTimeout(r, 500));
                } catch {}
              }
              await new Promise(r => setTimeout(r, 500));
            }
          }
          if (recovered) {
            console.log("[autotest][replay] Content script recovered after navigation");
          } else {
            console.warn("[autotest][replay] Content script not recovered — next step may fail");
          }
        }
      }

      // Send HUD update after each step
      chrome.tabs.sendMessage(activeTabId, {
        type: "hud_update",
        report: report
      }).catch(() => {
        // HUD might not be enabled, ignore errors
      });
    }
    // Check if there were any soft failures
    const hasSoftFails = report.steps.some(s => s.status === "soft_fail");
    const finalStatus = hasSoftFails ? "passed_with_warnings" : "passed";
    finalizeReport(report, finalStatus, null);
    if (hasSoftFails) {
      report.summary.softFailCount = report.steps.filter(s => s.status === "soft_fail").length;
    }
    lastReportByTab.set(tabId, report); // Final update

    // Send final HUD update to whichever tab is currently active
    chrome.tabs.sendMessage(activeTabId, {
      type: "hud_update",
      report: report
    }).catch(() => {});

    setReplayBadge(tabId, steps.length, steps.length, "success");
    return { ok: true, report };
  } catch (err) {
    // Check if it's a user-stopped error
    if (err?.code === "USER_STOPPED") {
      finalizeReport(report, "stopped", err);
      lastReportByTab.set(tabId, report);

      chrome.tabs.sendMessage(activeTabId, {
        type: "hud_update",
        report: report
      }).catch(() => {});

      setReplayBadge(tabId, 0, steps.length, "stopped");
      err.report = report;
      throw err;
    } else {
      // Regular failure
      finalizeReport(report, "failed", err);
      lastReportByTab.set(tabId, report); // Update report on error

      chrome.tabs.sendMessage(activeTabId, {
        type: "hud_update",
        report: report
      }).catch(() => {});

      setReplayBadge(tabId, 0, steps.length, "failed");
      err.report = report;
      throw err;
    }
  } finally {
    replayLocks.delete(tabId);
    pausedReplays.delete(tabId); // Clear pause state
    activeReplayTabId = null;
    activeReplayOriginTabId = null;
    
    // Stop video recording if enabled
    console.log("[autotest][video] ===== STOPPING VIDEO RECORDING =====");
    console.log("[autotest][video] Video enabled?", captureSettings.video);
    
    if (captureSettings.video) {
      try {
        console.log("[autotest][video] Sending video_stop_recording message to tab:", tabId);
        
        const videoResp = await chrome.tabs.sendMessage(tabId, { 
          type: "video_stop_recording"
        }).catch(err => {
          console.error("[autotest][video] ❌ Video stop message failed:", err);
          return { ok: false, error: err.message };
        });
        
        console.log("[autotest][video] Video stop response:", videoResp);
        
        if (videoResp?.ok && videoResp.videoData) {
          console.log("[autotest][video] ✅ Video recording stopped successfully");
          console.log("[autotest][video] Video size:", videoResp.size, "bytes");
          console.log("[autotest][video] Video mime type:", videoResp.mimeType);
          console.log("[autotest][video] Video data length:", videoResp.videoData?.length);
          
          // Check if we should capture based on failure setting
          const shouldCapture = !captureSettings.onFailureOnly || (report.status === "failed");
          console.log("[autotest][video] Should capture video?", shouldCapture, "(onFailureOnly:", captureSettings.onFailureOnly, "status:", report.status, ")");
          
          // Store video data
          if (shouldCapture) {
            console.log("[autotest][video] Preparing to download video...");
            
            const recordings = (await store.get(RECORDING_KEY)) || [];
            const recording = recordings.find(r => r.id === recordingId);
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
            const recordingName = (recording?.name || 'recording').replace(/[^a-zA-Z0-9]/g, '_');
            const videoFilename = `replay_${recordingName}_${timestamp}_${report.status}.webm`;
            
            console.log("[autotest][video] Video filename:", videoFilename);
            console.log("[autotest][video] Converting base64 to blob...");
            
            // Convert base64 to blob and download
            const videoBlob = await fetch(videoResp.videoData).then(r => r.blob());
            console.log("[autotest][video] Blob created, size:", videoBlob.size);
            
            console.log("[autotest][video] Triggering download...");
            await downloadBlob(videoBlob, videoFilename);
            console.log("[autotest][video] ✅ Video download initiated:", videoFilename);
            
            // Store video artifact info
            report.videoArtifact = {
              filename: videoFilename,
              size: videoResp.size,
              mimeType: videoResp.mimeType
            };
            console.log("[autotest][video] Video artifact info stored in report");
          } else {
            console.log("[autotest][video] ⚠️ Video captured but not saved (onFailureOnly mode and replay passed)");
          }
        } else {
          console.warn("[autotest][video] ⚠️ Video stop response invalid or no video data");
        }
      } catch (videoErr) {
        console.error("[autotest][video] ❌ Exception handling video:", videoErr);
      }
    } else {
      console.log("[autotest][video] Video recording not enabled, skipping stop");
    }
    
    // Get screenshots from map
    const screenshots = screenshotsByTab.get(tabId) || [];
    const shouldCapture = !captureSettings.onFailureOnly || (report.status === "failed");
    
    console.log("[autotest][capture] Finally block - screenshots:", screenshots.length, "shouldCapture:", shouldCapture, "onFailureOnly:", captureSettings.onFailureOnly, "status:", report.status);
    
    // Generate DOCX report from screenshots if captured
    if (screenshots.length > 0 && shouldCapture) {
      try {
        console.log("[autotest][capture] Generating DOCX report from", screenshots.length, "screenshots...");
        const recordings = (await store.get(RECORDING_KEY)) || [];
        const recording = recordings.find(r => r.id === recordingId);
        const envs = (await store.get(ENV_KEY)) || [];
        const env = envs.find(e => e.id === report.envId);
        
        const docxBlob = await generateDOCXReport(screenshots, {
          recordingName: recording?.name || 'Unknown Recording',
          envName: env?.name || 'Unknown Environment',
          status: report.status,
          startedAt: report.startedAt,
          endedAt: report.endedAt,
          totalSteps: steps.length,
          steps: report.steps,
          error: report.error?.message || null
        });
        
        console.log("[autotest][capture] DOCX blob generated, size:", docxBlob.size);
        
        // Generate filename
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        const recordingName = (recording?.name || 'recording').replace(/[^a-zA-Z0-9]/g, '_');
        const filename = `replay_${recordingName}_${timestamp}_${report.status}.html`;
        
        console.log("[autotest][capture] Triggering download for:", filename);
        
        // Download DOCX report
        await downloadBlob(docxBlob, filename);
        console.log("[autotest][capture] Screenshots report download initiated:", filename);
        
        // Store artifact info in report (including screenshots for inline viewing)
        report.screenshotArtifact = { 
          filename, 
          screenshotCount: screenshots.length,
          screenshots: screenshots // Store screenshots in report for inline viewing
        };
        
        console.log("[autotest][capture] Artifact info stored in report");
        
        // Update last report with artifact info
        lastReportByTab.set(tabId, report);
        console.log("[autotest][capture] Last report updated with artifacts");
        
        // Send HUD update with artifacts
        chrome.tabs.sendMessage(tabId, { 
          type: "hud_update", 
          report: report 
        }).catch(() => {});
        
      } catch (docxErr) {
        console.error("[autotest][capture] Failed to generate DOCX report:", docxErr);
      }
    } else {
      console.log("[autotest][capture] Skipping DOCX report generation - screenshots:", screenshots.length, "shouldCapture:", shouldCapture);
    }
    
    // Clear screenshots array
    screenshotsByTab.delete(tabId);
    console.log("[autotest][capture] Screenshots cleared from memory");
  }
}

chrome.runtime.onInstalled.addListener(() => {
  // Clean up stale global (non-tab-specific) overlay keys.
  // Overlay state is now per-tab (e.g. overlayMode_123).  Old global keys
  // could cause every tab to show the HUD.
  chrome.storage.local.remove([
    'overlayMode', 'hudEnabled', 'hudMiniStatus',
    'hudMinimized', 'hudIsVisible'
  ]).catch(() => {});

  // Keep the default popup behavior on action click (don't auto-open side panel)
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })
      .then(() => console.log("[sw] Side panel: default popup behavior preserved"))
      .catch((err) => console.warn("[sw] Side panel setPanelBehavior error:", err));
  }

  // Add context menu item for opening the side panel
  if (chrome.contextMenus) {
    chrome.contextMenus.create({
      id: "autotest-open-sidepanel",
      title: "Open Autotest in Side Panel",
      contexts: ["action"]
    }, () => {
      if (chrome.runtime.lastError) {
        // Context menu already exists or error — ignore
        console.warn("[sw] Context menu create:", chrome.runtime.lastError.message);
      }
    });
  }
});

// Handle context menu click for side panel
if (chrome.contextMenus) {
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === "autotest-open-sidepanel") {
      try {
        if (chrome.sidePanel && chrome.sidePanel.open) {
          await chrome.sidePanel.open({ windowId: tab?.windowId });
          console.log("[sw] Side panel opened via context menu");
        }
      } catch (err) {
        console.error("[sw] Failed to open side panel from context menu:", err);
      }
    }
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message?.type;
  const tabId = sender?.tab?.id ?? message?.tabId ?? null;

  async function handle() {
    async function isAIDisabled() {
      const result = await chrome.storage.local.get(['aiEnabled']);
      return result.aiEnabled !== true;
    }

    async function isNotLoggedIn() {
      const result = await chrome.storage.local.get(['registryConfig']);
      const cfg = result.registryConfig || {};
      return !(cfg.connected === true && cfg.sessionToken);
    }

    // ── Tab ID helper (for content scripts that need their own tab ID) ──
    if (type === "get_tab_id") {
      return { tabId: tabId };
    }

    if (type === "recorder_start") {
      if (tabId != null) stepsByTab.set(tabId, []);
      const env = await getDefaultEnvironment();
      return { ok: true, env };
    }

    if (type === "recorder_stop") {
      return { ok: true };
    }

    if (type === "recorder_start_for_tab") {
      console.log("[sw] recorder_start_for_tab received, tabId:", tabId);
      if (!tabId) return { ok: false, error: "NO_TAB" };
      const env = await startRecordingOnTab(tabId);
      console.log("[sw] startRecordingOnTab completed, env:", env?.name || "(none)");
      // Notify HUD of recording start
      try {
        await chrome.tabs.sendMessage(tabId, { type: "hud_recording_start", steps: [] });
      } catch (_) { /* tab may not be ready */ }
      console.log("[sw] recorder_start_for_tab done, returning ok");
      return { ok: true, env };
    }

    if (type === "recorder_stop_for_tab") {
      if (!tabId) return { ok: false, error: "NO_TAB" };
      await stopRecordingOnTab(tabId);
      // Notify HUD of recording stop
      try {
        await chrome.tabs.sendMessage(tabId, { type: "hud_recording_stop" });
      } catch (_) {}
      return { ok: true };
    }

    // Popup confirms (or declines) recording a newly opened tab
    // HUD "Stop Recording" button
    if (type === "stop_recording_from_hud") {
      const recordingTabId = sender?.tab?.id || tabId;
      if (recordingTabId) {
        // If this is a linked new tab, find its origin and stop that instead
        // so the step merge logic in stopRecordingOnTab runs correctly.
        let originTabId = recordingTabId;
        for (const [origin, linked] of linkedTabsByOrigin.entries()) {
          if (linked.has(recordingTabId)) { originTabId = origin; break; }
        }
        await stopRecordingOnTab(originTabId);
        // Notify HUD on all involved tabs
        try { await chrome.tabs.sendMessage(originTabId, { type: "hud_recording_stop" }); } catch (_) {}
        if (originTabId !== recordingTabId) {
          try { await chrome.tabs.sendMessage(recordingTabId, { type: "hud_recording_stop" }); } catch (_) {}
        }
      }
      return { ok: true };
    }

    // User clicked "Record this tab" in the new tab's HUD prompt.
    if (type === "confirm_record_new_tab") {
      console.log("[cross-tab] confirm_record_new_tab received, tabId:", tabId);
      if (!tabId) return { ok: false, error: "NO_TAB" };
      const storageKey = `crossTabPrompt_${tabId}`;
      const stored = await chrome.storage.local.get(storageKey);
      const prompt = stored[storageKey];
      console.log("[cross-tab] Stored prompt data:", prompt);
      if (!prompt?.originTabId || !recordingByTab.get(prompt.originTabId)) {
        console.warn("[cross-tab] No active recording found for origin tab", prompt?.originTabId);
        return { ok: false, error: "No active recording session found." };
      }
      const { originTabId, domain } = prompt;
      if (!linkedTabsByOrigin.has(originTabId)) linkedTabsByOrigin.set(originTabId, new Set());
      const linkedSet = linkedTabsByOrigin.get(originTabId);
      const newTabIndex = linkedSet.size + 1;
      linkedSet.add(tabId);
      tabIndexByTabId.set(tabId, newTabIndex);
      console.log(`[cross-tab] Linking tab ${tabId} as tabIndex ${newTabIndex} under origin ${originTabId}`);
      try {
        await startRecordingOnTab(tabId);
        chrome.storage.local.remove(storageKey).catch(() => {});
        chrome.tabs.sendMessage(originTabId, { type: "hud_cross_tab_started", domain }).catch(() => {});
        console.log(`[cross-tab] Recording started on tab ${tabId} (domain: ${domain})`);
        return { ok: true };
      } catch (err) {
        console.error(`[cross-tab] Failed to start recording on tab ${tabId}:`, err?.message);
        linkedTabsByOrigin.get(originTabId)?.delete(tabId);
        tabIndexByTabId.delete(tabId);
        return { ok: false, error: err.message };
      }
    }

    // User chose to discard the recording without saving.
    if (type === "discard_recording") {
      console.log("[discard] discard_recording received, tabId:", tabId);
      if (!tabId) return { ok: false, error: "NO_TAB" };
      // Resolve to origin tab if this is a linked tab.
      let originTabId = tabId;
      for (const [origin, linked] of linkedTabsByOrigin.entries()) {
        if (linked.has(tabId)) { originTabId = origin; break; }
      }
      console.log(`[discard] Discarding recording — origin tab: ${originTabId}, linked tabs:`, [...(linkedTabsByOrigin.get(originTabId) || [])]);
      // Wipe steps before stopping so stopRecordingOnTab has nothing to merge/save.
      stepsByTab.delete(originTabId);
      capturedNetworkByTab.delete(originTabId);
      for (const linkedId of (linkedTabsByOrigin.get(originTabId) || new Set())) {
        stepsByTab.delete(linkedId);
        capturedNetworkByTab.delete(linkedId);
      }
      await stopRecordingOnTab(originTabId);
      console.log("[discard] Recording discarded successfully");
      return { ok: true };
    }

    if (type === "record_step") {
      if (tabId == null) return { ok: false, error: "NO_TAB" };
      // Tag each step with the domain of the tab it was recorded on
      let tabDomain = null;
      try {
        const senderTab = await chrome.tabs.get(tabId).catch(() => null);
        if (senderTab?.url) tabDomain = new URL(senderTab.url).hostname;
      } catch (_) {}
      const tabIndex = tabIndexByTabId.get(tabId) ?? 0;
      const list = getStepsForTab(tabId);
      list.push(normalizeStep({ ...(message.step || {}), tabDomain, tabIndex }));
      // Notify HUD with updated step list
      try {
        await chrome.tabs.sendMessage(tabId, { type: "hud_recording_update", steps: [...list] });
      } catch (_) { /* HUD may not be active */ }
      return { ok: true };
    }

    if (type === "patch_step_path") {
      // Fired when content.js suppresses a click-triggered SPA navigation
      // (pushState/replaceState) — the step itself already recorded, but its
      // relativePath/queryParams still reflect the pre-navigation page. This
      // patches the in-progress step to the page it actually landed on.
      if (tabId == null) return { ok: false, error: "NO_TAB" };
      const list = getStepsForTab(tabId);
      const step = list.find((s) => s.id === message?.stepId);
      if (step) {
        if (typeof message.relativePath === "string") step.relativePath = message.relativePath;
        if (message.queryParams) step.queryParams = message.queryParams;
        try {
          await chrome.tabs.sendMessage(tabId, { type: "hud_recording_update", steps: [...list] });
        } catch (_) { /* HUD may not be active */ }
      }
      return { ok: true };
    }

    if (type === "network_capture") {
      if (tabId == null) return { ok: false };
      const captures = capturedNetworkByTab.get(tabId);
      if (captures) {
        captures.push({
          url: message.url,
          method: message.method,
          status: message.status,
          headers: message.headers || {},
          body: message.body,
          capturedAt: message.capturedAt || Date.now()
        });
      }
      return { ok: true };
    }

    if (type === "selector_heal_suggestion") {
      const stepId = message?.stepId;
      if (stepId) {
        healingSuggestionsByStepId.set(stepId, message?.suggestion || null);
        if (selectorHealing.autoApply && message?.suggestion?.selector) {
          const list = tabId != null ? getStepsForTab(tabId) : [];
          const step = list.find((s) => s.id === stepId);
          if (step) step.selector = message.suggestion.selector;
        }
      }
      return { ok: true };
    }

    if (type === "replay_start") {
      // Validate envId before proceeding
      if (!message?.envId || typeof message.envId !== "string") {
        return { ok: false, error: "Environment selection is required before replay.", code: "ENV_REQUIRED" };
      }
      
      const envs = (await store.get(ENV_KEY)) || [];
      const env = findEnvById(envs, message.envId);
      if (!env) return { ok: false, error: "Environment not found.", code: "ENV_NOT_FOUND" };
      if (!tabId) return { ok: false, error: "No active tab to replay on.", code: "NO_TAB" };

      const steps = Array.isArray(message?.steps) ? message.steps : getStepsForTab(tabId);
      if (!steps || steps.length === 0) {
        return { ok: false, error: "No steps to replay.", code: "NO_STEPS" };
      }
      
      // Check if replay is already in progress
      if (replayLocks.get(tabId)) {
        const report = lastReportByTab.get(tabId);
        const runningStepsCount = report?.steps?.filter(s => s.status === 'running' || s.status === 'passed' || s.status === 'failed').length || 0;
        return { 
          ok: false, 
          error: `Replay already in progress (${runningStepsCount}/${steps.length} steps). Click "Force Stop & Replay" to cancel and restart.`, 
          code: "REPLAY_IN_PROGRESS",
          canForceStop: true,
          currentReport: report
        };
      }

      // ── Data-driven testing: loop over data rows ──
      const dataRows = message?.dataRows; // Array of { key: value } objects
      if (Array.isArray(dataRows) && dataRows.length > 0) {
        const allReports = [];
        for (let rowIdx = 0; rowIdx < dataRows.length; rowIdx++) {
          const row = dataRows[rowIdx];
          // Substitute {{placeholder}} in step values
          const substitutedSteps = steps.map(s => {
            const clone = JSON.parse(JSON.stringify(s));
            if (typeof clone.value === 'string') {
              clone.value = clone.value.replace(/\{\{(\w+)\}\}/g, (_, key) => row[key] !== undefined ? String(row[key]) : `{{${key}}}`);
            }
            return clone;
          });
          try {
            const result = await runReplayOnTab({ tabId, env, steps: substitutedSteps, recordingId: message.recordingId, softAssertions: !!message?.softAssertions });
            result.report.dataRow = rowIdx + 1;
            result.report.dataValues = row;
            allReports.push({ ok: true, report: result.report });
          } catch (err) {
            if (err?.report) {
              err.report.dataRow = rowIdx + 1;
              err.report.dataValues = row;
            }
            allReports.push({ ok: false, report: err?.report || null, error: err?.message });
            if (err?.code === "USER_STOPPED") break;
          }
        }
        const lastReport = allReports[allReports.length - 1]?.report;
        if (lastReport) lastReportByTab.set(tabId, lastReport);
        return { ok: allReports.every(r => r.ok), reports: allReports, dataRowCount: dataRows.length };
      }

      // ── Network block/mock setup for this replay ──
      const { blockPatterns = [], blockPatternsEnabled = false } = await chrome.storage.local.get(['blockPatterns', 'blockPatternsEnabled']);
      const effectiveBlockPatterns = blockPatternsEnabled ? blockPatterns : [];
      const capturedMocks = message.useCapturedMocks ? (message.capturedResponses || []) : [];
      if (effectiveBlockPatterns.length || capturedMocks.length) {
        try {
          await chrome.tabs.sendMessage(tabId, {
            type: 'network_mock_setup',
            mocks: capturedMocks,
            blockPatterns: effectiveBlockPatterns
          });
        } catch {
          // Content script may not be loaded yet; it will receive patterns on injection.
        }
      }

      // ── Retry logic: re-run the entire replay up to N times on failure ──
      const maxRetries = parseInt(message?.retryCount, 10) || 0;
      let lastResult = null;
      let lastErr = null;

      try {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            const result = await runReplayOnTab({ tabId, env, steps, recordingId: message.recordingId, softAssertions: !!message?.softAssertions });
            result.report.attempt = attempt + 1;
            result.report.maxRetries = maxRetries;
            lastReportByTab.set(tabId, result.report);
            return { ok: true, report: result.report };
          } catch (err) {
            lastErr = err;
            if (err?.report) {
              err.report.attempt = attempt + 1;
              err.report.maxRetries = maxRetries;
              lastReportByTab.set(tabId, err.report);
            }
            // Don't retry on user stop
            if (err?.code === "USER_STOPPED") break;
            if (attempt < maxRetries) {
              console.log(`[autotest][replay] Attempt ${attempt + 1} failed, retrying (${maxRetries - attempt} retries left)...`);
              // Brief pause before retry
              await new Promise(r => setTimeout(r, 1500));
            }
          }
        }
      } finally {
        // Always tear down network intercepts after replay completes.
        if (effectiveBlockPatterns.length || capturedMocks.length) {
          try { await chrome.tabs.sendMessage(tabId, { type: 'network_mock_teardown' }); } catch {}
        }
      }
      return {
        ok: false,
        error: lastErr?.message || "Replay failed.",
        code: lastErr?.code || "REPLAY_FAILED",
        report: lastErr?.report || null
      };
    }

    // ── replay_from_step: run steps on the CURRENT page (no navigation) ──
    if (type === "replay_from_step") {
      if (!message?.envId || typeof message.envId !== "string") {
        return { ok: false, error: "Environment selection is required before replay.", code: "ENV_REQUIRED" };
      }
      
      const envs = (await store.get(ENV_KEY)) || [];
      const env = findEnvById(envs, message.envId);
      if (!env) return { ok: false, error: "Environment not found.", code: "ENV_NOT_FOUND" };
      if (!tabId) return { ok: false, error: "No active tab to replay on.", code: "NO_TAB" };

      const steps = Array.isArray(message?.steps) ? message.steps : [];
      if (!steps.length) {
        return { ok: false, error: "No steps to replay.", code: "NO_STEPS" };
      }
      
      if (replayLocks.get(tabId)) {
        const report = lastReportByTab.get(tabId);
        return { 
          ok: false, 
          error: `Replay already in progress. Force stop first.`, 
          code: "REPLAY_IN_PROGRESS",
          canForceStop: true,
          currentReport: report
        };
      }

      try {
        // Run replay on the tab as-is (no URL navigation — skipNavigation flag)
        const result = await runReplayOnTab({
          tabId, env, steps,
          recordingId: message.recordingId,
          skipNavigation: true
        });
        lastReportByTab.set(tabId, result.report);
        return { ok: true, report: result.report };
      } catch (err) {
        if (err?.report) lastReportByTab.set(tabId, err.report);
        return {
          ok: false,
          error: err?.message || "Replay failed.",
          code: err?.code || "REPLAY_FAILED",
          report: err?.report || null
        };
      }
    }
    
    if (type === "force_stop_replay") {
      if (!tabId) return { ok: false, error: "No active tab.", code: "NO_TAB" };
      
      // Clear the replay lock
      replayLocks.delete(tabId);
      activeReplayTabId = null;

      // Clear badge
      await chrome.action.setBadgeText({ text: "", tabId });
      
      return { ok: true, message: "Replay stopped. You can now start a new replay." };
    }
    
    if (type === "replay_stop") {
      if (!tabId) return { ok: false, error: "No active tab.", code: "NO_TAB" };
      
      console.log("[autotest][stop] Stopping replay for tab", tabId);
      
      // Mark the current report as stopped (not failed)
      const report = lastReportByTab.get(tabId);
      if (report) {
        report.status = "stopped";
        report.endedAt = new Date().toISOString();
        report.error = { message: "Replay stopped by user", code: "USER_STOPPED" };
        lastReportByTab.set(tabId, report);
        
        // Send update to content script to update HUD
        try {
          await chrome.tabs.sendMessage(tabId, {
            type: "hud_update",
            report: report
          });
        } catch (err) {
          console.log("[autotest][stop] Failed to update HUD:", err);
        }
      }
      
      // Clear the replay lock to stop further execution
      replayLocks.delete(tabId);
      activeReplayTabId = null;

      // Clear pause state if paused
      pausedReplays.delete(tabId);
      
      // Update badge to show stopped
      await chrome.action.setBadgeText({ text: "⏹", tabId });
      await chrome.action.setBadgeBackgroundColor({ color: "#FFA500", tabId }); // Orange instead of red
      
      console.log("[autotest][stop] Replay stopped successfully");
      return { ok: true, message: "Replay stopped.", report };
    }
    
    if (type === "replay_pause") {
      console.log("[autotest][pause] Received pause request, tabId:", tabId, "sender.tab:", sender?.tab);
      if (!tabId) {
        console.error("[autotest][pause] No tabId available!");
        return { ok: false, error: "No active tab.", code: "NO_TAB" };
      }
      
      // Set pause flag
      pausedReplays.set(tabId, true);
      console.log("[autotest][pause] Pause flag set for tab", tabId, "pausedReplays size:", pausedReplays.size);
      
      // Update badge
      await chrome.action.setBadgeText({ text: "⏸", tabId });
      await chrome.action.setBadgeBackgroundColor({ color: "#FFA500", tabId }); // Orange
      
      console.log("[autotest][pause] Replay paused on tab", tabId);
      return { ok: true };
    }
    
    if (type === "replay_resume") {
      console.log("[autotest][resume] Received resume request, tabId:", tabId, "sender.tab:", sender?.tab);
      if (!tabId) {
        console.error("[autotest][resume] No tabId available!");
        return { ok: false, error: "No active tab.", code: "NO_TAB" };
      }
      
      // Check if was actually paused
      const wasPaused = pausedReplays.get(tabId);
      console.log("[autotest][resume] Was paused?", wasPaused);
      
      // Clear pause flag
      pausedReplays.delete(tabId);
      console.log("[autotest][resume] Pause flag cleared for tab", tabId, "pausedReplays size:", pausedReplays.size);
      
      // Restore badge to running state
      const report = lastReportByTab.get(tabId);
      if (report) {
        const passedSteps = report.steps.filter(s => s.status === 'passed').length;
        const totalSteps = report.steps.length;
        await chrome.action.setBadgeText({ text: `${passedSteps}/${totalSteps}`, tabId });
        await chrome.action.setBadgeBackgroundColor({ color: "#3498db", tabId }); // Blue
      }
      
      console.log("[autotest][resume] Replay resumed on tab", tabId);
      return { ok: true };
    }
    
    if (type === "replay_pause_at_step") {
      // This is handled during replay execution
      return { ok: true };
    }
    
    if (type === "replay_edit_step") {
      // This is handled separately - placeholder for future implementation
      return { ok: true };
    }
    
    if (type === "update_step_name") {
      const stepIndex = message?.stepIndex;
      const customName = message?.customName;
      const recordingId = message?.recordingId;
      
      if (stepIndex == null) {
        return { ok: false, error: "Missing stepIndex" };
      }
      
      // Update the step in the current report (in-memory)
      if (tabId) {
        const report = lastReportByTab.get(tabId);
        if (report && report.steps[stepIndex]) {
          report.steps[stepIndex].customName = customName || null;
          lastReportByTab.set(tabId, report);
          console.log("[autotest] Updated step customName in report:", stepIndex, customName);
        }
      }
      
      // Also persist to recording storage if recordingId is provided
      if (recordingId) {
        try {
          const recordings = await loadRecordings();
          const recIdx = recordings.findIndex(r => r.id === recordingId);
          if (recIdx >= 0 && recordings[recIdx].steps[stepIndex]) {
            recordings[recIdx].steps[stepIndex].customName = customName || null;
            recordings[recIdx].updatedAt = new Date().toISOString();
            await saveRecordings(recordings);
            console.log("[autotest] Persisted step customName to recording:", stepIndex, customName);
          }
        } catch (err) {
          console.error("[autotest] Failed to persist step customName:", err);
          return { ok: false, error: "Failed to persist to recording storage" };
        }
      }
      
      return { ok: true };
    }

    if (type === "set_selector_healing") {
      selectorHealing.enabled = Boolean(message?.enabled);
      selectorHealing.autoApply = Boolean(message?.autoApply);
      return { ok: true, config: { ...selectorHealing } };
    }

    if (type === "flow_create") {
      const flows = await loadFlows();
      const flow = createFlow({
        name: message?.name,
        version: message?.version,
        author: message?.author,
        changelog: message?.changelog,
        steps: message?.steps
      });
      flows.push(flow);
      await saveFlows(flows);
      return { ok: true, flow };
    }

    if (type === "flow_add_version") {
      const flows = await loadFlows();
      const flow = findFlowById(flows, message?.flowId);
      if (!flow) return { ok: false, error: "Flow not found.", code: "FLOW_NOT_FOUND" };
      addFlowVersion(flow, {
        version: message?.version,
        author: message?.author,
        changelog: message?.changelog,
        steps: message?.steps
      });
      await saveFlows(flows);
      return { ok: true, flow };
    }

    if (type === "flow_get") {
      const flows = await loadFlows();
      const flow = findFlowById(flows, message?.flowId);
      if (!flow) return { ok: false, error: "Flow not found.", code: "FLOW_NOT_FOUND" };
      return { ok: true, flow };
    }

    if (type === "flow_list") {
      const flows = await loadFlows();
      const summary = flows.map((f) => ({
        id: f.id,
        name: f.name,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
        latestVersion: getLatestVersion(f)?.version || null
      }));
      return { ok: true, flows: summary };
    }

    if (type === "flow_export_playwright") {
      const flows = await loadFlows();
      const flow = findFlowById(flows, message?.flowId);
      if (!flow) return { ok: false, error: "Flow not found.", code: "FLOW_NOT_FOUND" };
      const envs = (await store.get(ENV_KEY)) || [];
      const output = exportFlowToPlaywright(flow, envs);
      return { ok: true, output };
    }

    // ── Export recording as Playwright script ────────────────
    if (type === "export_recording_playwright") {
      const recordings = await loadRecordings();
      const rec = recordings.find(r => r.id === message?.recordingId);
      if (!rec) return { ok: false, error: "Recording not found.", code: "RECORDING_NOT_FOUND" };
      const envs = (await store.get(ENV_KEY)) || [];
      const output = exportRecordingToPlaywright(rec, envs);
      return { ok: true, output };
    }

    // ── Export Playwright config + CI workflow ────────────────
    if (type === "export_playwright_config") {
      try {
        const config = generatePlaywrightConfig(message?.options || {});
        const workflow = generateGitHubActionsWorkflow(message?.options || {});
        return { ok: true, config, workflow };
      } catch (err) {
        return { ok: false, error: err?.message };
      }
    }

    // ── Generate HTML test report ──────────────────────────
    if (type === "generate_html_report") {
      const report = message?.report;
      if (!report) return { ok: false, error: "No report data." };
      const recordings = await loadRecordings();
      const rec = recordings.find(r => r.id === report?.recordingId) || { name: report?.recordingId };
      const envs = (await store.get(ENV_KEY)) || [];
      const env = envs.find(e => e.id === report?.envId) || { name: report?.envId };
      const html = generateHtmlReport(report, rec, env);
      return { ok: true, html };
    }

    if (type === "save_recording") {
      // AI-generated recordings may not have a tabId — only require it for normal recordings
      const name = String(message?.name || "").trim();
      if (!name) return { ok: false, error: "Recording name is required.", code: "NAME_REQUIRED" };
      const steps = Array.isArray(message?.steps) ? message.steps : getStepsForTab(tabId);
      if (!steps || steps.length === 0) return { ok: false, error: "No steps to save.", code: "NO_STEPS" };

      // Auto-create environment if the domain isn't already in the env list
      const source = message?.source || null;
      let envId = message?.envId || steps[0]?.envId || null;
      const targetUrl = message?.targetUrl || null;
      let autoEnvUrl = targetUrl;

      // If no explicit targetUrl, try to determine from tab URL or first navigation step
      if (!autoEnvUrl && tabId) {
        try {
          const tab = await chrome.tabs.get(tabId);
          autoEnvUrl = tab?.url;
        } catch {}
      }
      if (!autoEnvUrl) {
        const navStep = steps.find(s => s.type === "navigation");
        if (navStep?.relativePath) {
          // relativePath might be a full URL if no env was set during recording
          try { new URL(navStep.relativePath); autoEnvUrl = navStep.relativePath; } catch {}
        }
      }

      if (autoEnvUrl) {
        // Always ensure the URL's domain has an environment, even if envId is set
        // (envId might point to a different domain if user recorded on a non-matching site)
        const env = await ensureEnvironmentForUrl(autoEnvUrl, source === "ai" ? "ai" : "manual");
        if (env) {
          // Use the matching env if no envId was set, or if the current envId's baseUrl doesn't match
          if (!envId) {
            envId = env.id;
          } else {
            const envs = (await store.get(ENV_KEY)) || [];
            const currentEnv = envs.find(e => e.id === envId);
            if (currentEnv) {
              try {
                const currentOrigin = new URL(currentEnv.baseUrl).origin;
                const recordedOrigin = new URL(autoEnvUrl).origin;
                if (currentOrigin !== recordedOrigin) {
                  envId = env.id; // Switch to the correct environment
                }
              } catch {}
            }
          }
        }
      }

      const recordings = await loadRecordings();
      const capturedResponses = capturedNetworkByTab.get(tabId) || [];
      capturedNetworkByTab.delete(tabId);
      const recording = {
        id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
        name,
        createdAt: new Date().toISOString(),
        envId,
        appId: message?.appId || steps[0]?.appId || null,
        source,                                 // 'ai' for AI-generated tests
        specCode: message?.specCode || null,     // Playwright code (for AI tests)
        steps,
        capturedResponses
      };
      recordings.push(recording);
      await saveRecordings(recordings);

      return { ok: true, recording };
    }

    if (type === "get_recordings") {
      const recordings = await loadRecordings();
      return { ok: true, recordings };
    }

    if (type === "update_recording") {
      // Accept either recordingId + updates OR full recording object
      if (message?.recording) {
        // Full recording object provided
        const recordings = await loadRecordings();
        const index = recordings.findIndex(r => r.id === message.recording.id);
        if (index === -1) return { ok: false, error: "Recording not found.", code: "NOT_FOUND" };
        
        // Update the recording
        recordings[index] = {
          ...message.recording,
          updatedAt: new Date().toISOString()
        };
        
        await saveRecordings(recordings);
        return { ok: true, recording: recordings[index] };
      } else if (message?.recordingId) {
        // Legacy format: recordingId + individual updates
        const recordings = await loadRecordings();
        const recording = recordings.find(r => r.id === message.recordingId);
        if (!recording) return { ok: false, error: "Recording not found.", code: "NOT_FOUND" };
        
        if (message.name) recording.name = message.name;
        if (Array.isArray(message.steps)) recording.steps = message.steps;
        recording.updatedAt = new Date().toISOString();
        
        await saveRecordings(recordings);
        return { ok: true, recording };
      } else {
        return { ok: false, error: "Recording ID or recording object required.", code: "ID_REQUIRED" };
      }
    }

    if (type === "delete_recording") {
      if (!message?.recordingId) return { ok: false, error: "Recording ID required.", code: "ID_REQUIRED" };
      const recordings = await loadRecordings();
      const index = recordings.findIndex(r => r.id === message.recordingId);
      if (index === -1) return { ok: false, error: "Recording not found.", code: "NOT_FOUND" };
      
      recordings.splice(index, 1);
      await saveRecordings(recordings);
      return { ok: true };
    }

    if (type === "get_last_report") {
      if (tabId == null) return { ok: false, error: "NO_TAB" };
      const report = lastReportByTab.get(tabId)
        // Linked tab: fall back to the origin tab's report so it gets live updates
        || (activeReplayOriginTabId && activeReplayOriginTabId !== tabId
            ? lastReportByTab.get(activeReplayOriginTabId)
            : null)
        || null;
      return { ok: true, report };
    }

    if (type === "get_recording_state") {
      if (tabId == null) return { ok: false, error: "NO_TAB" };
      const isRecording = Boolean(recordingByTab.get(tabId));
      const stepsCount = getStepsForTab(tabId).length;
      const isReplaying = tabId === activeReplayTabId;
      return { ok: true, isRecording, stepsCount, isReplaying, replayOriginTabId: activeReplayOriginTabId };
    }

    if (type === "get_steps") {
      if (tabId == null) return { ok: false, error: "NO_TAB" };
      return { ok: true, steps: getStepsForTab(tabId) };
    }

    if (type === "get_environment") {
      const env = await getDefaultEnvironment();
      return { ok: true, env };
    }

    if (type === "clear_steps") {
      if (tabId != null) stepsByTab.set(tabId, []);
      return { ok: true };
    }

    // ============================================================================
    // Storage State (Group M)
    // ============================================================================

    if (type === "save_storage_state") {
      try {
        // Capture cookies for the current tab's URL
        const tab = await chrome.tabs.get(tabId);
        const url = new URL(tab.url);
        const cookies = await chrome.cookies.getAll({ domain: url.hostname });
        
        // Capture localStorage via content script
        let localStorage = {};
        try {
          const lsResp = await chrome.tabs.sendMessage(tabId, { type: "get_local_storage" });
          localStorage = lsResp?.data || {};
        } catch {}

        const stateBlob = {
          cookies,
          localStorage,
          url: tab.url,
          savedAt: new Date().toISOString()
        };

        const stateKey = message?.stateKey || `auth_state_${Date.now()}`;
        await chrome.storage.local.set({ [`storageState_${stateKey}`]: stateBlob });
        return { ok: true, stateKey, cookieCount: cookies.length, storageKeyCount: Object.keys(localStorage).length };
      } catch (err) {
        return { ok: false, error: err?.message || "Failed to save storage state." };
      }
    }

    if (type === "restore_storage_state") {
      try {
        const stateKey = message?.stateKey;
        if (!stateKey) return { ok: false, error: "stateKey required." };
        const stored = await chrome.storage.local.get([`storageState_${stateKey}`]);
        const stateBlob = stored[`storageState_${stateKey}`];
        if (!stateBlob) return { ok: false, error: "Storage state not found." };

        // Restore cookies
        for (const cookie of (stateBlob.cookies || [])) {
          try {
            const cookieObj = {
              url: `http${cookie.secure ? 's' : ''}://${cookie.domain.replace(/^\./, '')}${cookie.path}`,
              name: cookie.name,
              value: cookie.value,
              domain: cookie.domain,
              path: cookie.path,
              secure: cookie.secure,
              httpOnly: cookie.httpOnly,
              sameSite: cookie.sameSite || "unspecified"
            };
            if (cookie.expirationDate) cookieObj.expirationDate = cookie.expirationDate;
            await chrome.cookies.set(cookieObj);
          } catch (ce) {
            console.warn("[autotest][storage] Failed to restore cookie:", cookie.name, ce.message);
          }
        }

        // Restore localStorage via content script
        try {
          await chrome.tabs.sendMessage(tabId, {
            type: "set_local_storage",
            data: stateBlob.localStorage || {}
          });
        } catch {}

        return { ok: true, cookiesRestored: stateBlob.cookies?.length || 0 };
      } catch (err) {
        return { ok: false, error: err?.message || "Failed to restore storage state." };
      }
    }

    if (type === "list_storage_states") {
      try {
        const all = await chrome.storage.local.get(null);
        const states = [];
        for (const [key, val] of Object.entries(all)) {
          if (key.startsWith('storageState_')) {
            states.push({
              stateKey: key.replace('storageState_', ''),
              savedAt: val.savedAt,
              url: val.url,
              cookieCount: val.cookies?.length || 0
            });
          }
        }
        return { ok: true, states };
      } catch (err) {
        return { ok: false, error: err?.message };
      }
    }

    // ============================================================================
    // Visual Regression (Group N)
    // ============================================================================

    if (type === "compare_screenshot") {
      try {
        const recordingId = message?.recordingId;
        const stepIndex = message?.stepIndex;
        if (!recordingId || stepIndex == null) return { ok: false, error: "recordingId and stepIndex required." };

        // Capture current screenshot
        const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
        const baselineKey = `vr_baseline_${recordingId}_${stepIndex}`;

        const stored = await chrome.storage.local.get([baselineKey]);
        const baseline = stored[baselineKey];

        if (!baseline) {
          // First run: save as baseline
          await chrome.storage.local.set({ [baselineKey]: dataUrl });
          return { ok: true, isBaseline: true, message: "Baseline screenshot saved." };
        }

        // Compare: simple pixel comparison using data URLs length as a crude diff metric
        // For production, a canvas-based pixel diff would be ideal but would require offscreen document
        const diff = Math.abs(dataUrl.length - baseline.length) / Math.max(dataUrl.length, baseline.length) * 100;
        const threshold = message?.threshold || 5; // 5% tolerance by default

        if (diff > threshold) {
          return {
            ok: false,
            error: `Visual regression: ${diff.toFixed(2)}% difference (threshold: ${threshold}%).`,
            code: "VISUAL_REGRESSION",
            diffPercent: diff,
            current: dataUrl
          };
        }
        return { ok: true, diffPercent: diff };
      } catch (err) {
        return { ok: false, error: err?.message || "Screenshot comparison failed." };
      }
    }

    if (type === "update_vr_baseline") {
      try {
        const recordingId = message?.recordingId;
        const stepIndex = message?.stepIndex;
        if (!recordingId || stepIndex == null) return { ok: false, error: "recordingId and stepIndex required." };
        const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
        await chrome.storage.local.set({ [`vr_baseline_${recordingId}_${stepIndex}`]: dataUrl });
        return { ok: true, message: "Baseline updated." };
      } catch (err) {
        return { ok: false, error: err?.message };
      }
    }

    // ============================================================================
    // AI Fix Step Handler
    // ============================================================================

    if (type === "ai_fix_step") {
      if (await isNotLoggedIn()) {
        return { ok: false, error: "Login to registry required. Connect in Settings > Account." };
      }
      if (await isAIDisabled()) {
        return { ok: false, error: "AI features are disabled. Enable them in Settings > AI." };
      }

      const { failedStep, failedStepIndex, error, selectorAttempts, selectorHealing,
              notFoundTarget, contextSteps, pageUrl, recordingName } = message;

      if (!failedStep) return { ok: false, error: "No failed step provided" };

      console.log("[sw][ai-fix] Analyzing failed step:", failedStep.type, "at index", failedStepIndex);

      try {
        // Get the current page DOM snapshot for context
        let pageSnapshot = '';
        if (tabId) {
          try {
            const [result] = await chrome.scripting.executeScript({
              target: { tabId },
              func: () => {
                // Gather relevant DOM context around likely interactive elements
                const interactiveEls = document.querySelectorAll(
                  'a, button, input, select, textarea, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="combobox"], [role="tab"], [data-testid], [aria-label]'
                );
                const elements = [];
                interactiveEls.forEach(el => {
                  if (elements.length >= 100) return; // limit
                  const rect = el.getBoundingClientRect();
                  if (rect.width === 0 && rect.height === 0) return; // skip hidden
                  elements.push({
                    tag: el.tagName.toLowerCase(),
                    id: el.id || undefined,
                    className: el.className?.toString()?.substring(0, 100) || undefined,
                    text: el.textContent?.trim()?.substring(0, 80) || undefined,
                    type: el.type || undefined,
                    role: el.getAttribute('role') || undefined,
                    ariaLabel: el.getAttribute('aria-label') || undefined,
                    placeholder: el.getAttribute('placeholder') || undefined,
                    name: el.getAttribute('name') || undefined,
                    href: el.href || undefined,
                    testId: el.getAttribute('data-testid') || undefined,
                    visible: rect.width > 0 && rect.height > 0,
                  });
                });
                return JSON.stringify(elements);
              },
            });
            pageSnapshot = result?.result || '';
          } catch (e) {
            console.warn("[sw][ai-fix] Could not get page snapshot:", e.message);
          }
        }

        // Build the prompt for Claude
        const prompt = buildAIFixPrompt({
          failedStep, failedStepIndex, error, selectorAttempts, selectorHealing,
          notFoundTarget, contextSteps, pageUrl, recordingName, pageSnapshot
        });

        const fixConfig = await getGeneratorConfig();
        const resp = await fetch(`${await getGeneratorUrl()}/fix-step`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(await getAuthHeaders()) },
          body: JSON.stringify({
            prompt,
            failed_step: failedStep,
            page_url: pageUrl,
            model: fixConfig.model || null,
          }),
        });
        const data = await resp.json();

        if (data.ok && data.fixed_step) {
          console.log("[sw][ai-fix] AI suggested fix:", data.fixed_step);
          return { ok: true, fixedStep: data.fixed_step, explanation: data.explanation || '' };
        } else {
          console.warn("[sw][ai-fix] AI fix failed:", data.error);
          return { ok: false, error: data.error || "AI could not suggest a fix" };
        }
      } catch (err) {
        console.error("[sw][ai-fix] Error:", err);
        return { ok: false, error: `AI fix failed: ${err.message}` };
      }
    }

    // ============================================================================
    // AI Test Generator (Claude CLI + Playwright MCP) Message Handlers
    // ============================================================================

    if (type === "pw_get_progress") {
      try {
        const runnerUrl = await getRunnerUrl();
        if (!runnerUrl) return { ok: false, error: "Runner not configured" };
        const resp = await fetch(`${runnerUrl}/progress/${message.runId}`, {
          headers: await getAuthHeaders(),
        });
        return await resp.json();
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    if (type === "cancel_generation") {
      try {
        const resp = await fetch(`${await getGeneratorUrl()}/cancel-generation`, {
          method: "POST",
          headers: await getAuthHeaders(),
        });
        const data = await resp.json();
        return data;
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    if (type === "generate_mcp_test") {
      if (await isNotLoggedIn()) {
        return { ok: false, error: "Login to registry required. Connect in Settings > Account." };
      }
      if (await isAIDisabled()) {
        return { ok: false, error: "AI features are disabled. Enable them in Settings > AI." };
      }

      const { prompt, targetUrl, validate } = message;
      if (!prompt || !targetUrl) {
        return { ok: false, error: "prompt and targetUrl are required" };
      }

      const genConfig = await getGeneratorConfig();
      console.log("[sw][mcp] Generating test via streaming SSE:", { prompt: prompt.substring(0, 80), targetUrl, model: genConfig.model || "default" });

      // Clear any stale result/log from a previous generation.
      await chrome.storage.local.remove(["genResult", "genLog"]);

      // Fire-and-forget: run the full generate+validate pipeline in the background
      // so the message channel is freed immediately (Chrome closes it after ~5 min).
      // The popup polls chrome.storage.local for genProgress (live phases) and
      // genResult (the final outcome).
      (async () => {
        let genResult = { ok: false, error: "Generation did not complete" };
        try {
          const regResult = await chrome.storage.local.get(["registryConfig"]);
          const regConfig = regResult.registryConfig || {};
          const body = {
            prompt,
            target_url: targetUrl,
            model: message.model || genConfig.model || null,
            validate: validate === true,
          };
          if (regConfig.connected && regConfig.sessionToken) {
            body.account_slug = regConfig.accountSlug;
            body.project_slug = regConfig.projectSlug;
            body.session_token = regConfig.sessionToken;
          } else if (regConfig.connected && regConfig.accessKey) {
            body.account_slug = regConfig.accountSlug;
            body.project_slug = regConfig.projectSlug;
            body.access_key = regConfig.accessKey;
          }

          const generatorBaseUrl = await getGeneratorUrl();
          const backendBaseUrl = await getBackendUrl();
          const requestInit = {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(await getAuthHeaders()) },
            body: JSON.stringify(body),
          };

          // Use streaming endpoint first; if 404, fall back to legacy/direct endpoints.
          let resp = await fetch(`${generatorBaseUrl}/generate-test-stream`, requestInit);
          let responseMode = "stream"; // "stream" (SSE) | "json" (non-stream generate-test)
          let endpointUsed = `${generatorBaseUrl}/generate-test-stream`;

          if (resp.status === 404) {
            endpointUsed = `${backendBaseUrl}/generate-test-stream`;
            console.warn("[sw][mcp] Stream endpoint not found, trying legacy path:", endpointUsed);
            resp = await fetch(endpointUsed, requestInit);
          }
          if (resp.status === 404) {
            responseMode = "json";
            endpointUsed = `${generatorBaseUrl}/generate-test`;
            console.warn("[sw][mcp] Stream path still 404, falling back to non-stream:", endpointUsed);
            resp = await fetch(endpointUsed, requestInit);
          }
          if (resp.status === 404) {
            responseMode = "json";
            endpointUsed = `${backendBaseUrl}/generate-test`;
            console.warn("[sw][mcp] Generator path still 404, trying final fallback:", endpointUsed);
            resp = await fetch(endpointUsed, requestInit);
          }

          if (!resp.ok) {
            const errText = await resp.text();
            genResult = { ok: false, error: `Generator returned ${resp.status} at ${endpointUsed}: ${errText}` };
            return;
          }

          if (responseMode === "json") {
            const data = await resp.json().catch(() => ({}));
            genResult = data?.ok ? data : { ok: false, error: data?.error || `Generator returned ${resp.status} at ${endpointUsed}` };
            return;
          }

          // Read SSE stream
          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let finalResult = null;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            // Parse SSE events from buffer
            const lines = buffer.split("\n");
            buffer = lines.pop(); // keep incomplete line in buffer
            let eventType = null;
            for (const line of lines) {
              if (line.startsWith("event: ")) {
                eventType = line.slice(7).trim();
              } else if (line.startsWith("data: ") && eventType) {
                if (eventType === "log") {
                  // Append to genLog ring buffer (keep last 50 lines) — separate from genProgress
                  try {
                    const data = JSON.parse(line.slice(6));
                    const r = await chrome.storage.local.get("genLog");
                    const arr = (r.genLog || []).slice(-49);
                    arr.push({ text: data.text, phase: data.phase, ts: Date.now() });
                    await chrome.storage.local.set({ genLog: arr });
                  } catch (_) {}
                } else {
                  try {
                    const data = JSON.parse(line.slice(6));
                    console.log(`[sw][mcp] SSE ${eventType}:`, data.phase || data.error || "");
                    // Store progress for popup to poll
                    await chrome.storage.local.set({
                      genProgress: { event: eventType, ...data, timestamp: Date.now() }
                    });
                    if (eventType === "done") {
                      finalResult = data;
                    } else if (eventType === "error") {
                      finalResult = { ok: false, error: data.error };
                    }
                  } catch (parseErr) {
                    console.warn("[sw][mcp] Failed to parse SSE data:", line);
                  }
                }
                eventType = null;
              }
            }
          }

          if (finalResult && finalResult.ok !== false) {
            console.log("[sw][mcp] Test generated:", finalResult.test_name, finalResult.test_id);
            genResult = { ok: true, ...finalResult };
          } else if (finalResult) {
            console.error("[sw][mcp] Generation failed:", finalResult.error);
            genResult = finalResult;
          } else {
            genResult = { ok: false, error: "Stream ended without a result" };
          }
        } catch (err) {
          console.error("[sw][mcp] Generate test error:", err);
          genResult = { ok: false, error: `Failed to connect to Claude proxy: ${err.message}` };
        } finally {
          await chrome.storage.local.remove(["genProgress", "genLog"]);
          await chrome.storage.local.set({ genResult });
        }
      })();

      // Immediately release the message channel; popup will poll genResult.
      return { ok: true, pending: true };
    }

    if (type === "run_generated_test") {
      const { specPath, headed } = message;
      if (!specPath) {
        return { ok: false, error: "specPath is required" };
      }

      console.log("[sw][mcp] Running generated test:", { specPath, headed });

      try {
        const resp = await fetch(`${await getRunnerUrl() || `${await getBackendUrl()}/runner`}/run-spec`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(await getAuthHeaders()) },
          body: JSON.stringify({
            spec_path: specPath,
            headed: headed || false,
            browsers: ["chromium"],
            trace: true,
            screenshots: true,
          }),
        });
        const data = await resp.json();
        console.log("[sw][mcp] Run result:", data.ok, data.report?.status);
        return data;
      } catch (err) {
        console.error("[sw][mcp] Run test error:", err);
        return { ok: false, error: `Failed to connect to Playwright runner: ${err.message}` };
      }
    }

    // ── Validate & auto-fix generated spec via runner, then Claude code fix if needed ──
    if (type === "validate_generated_test") {
      const { specPath } = message;
      if (!specPath) {
        return { ok: false, error: "specPath is required" };
      }

      console.log("[sw][mcp] Validating generated test:", specPath);

      try {
        const generatorBaseUrl = await getGeneratorUrl();
        const backendBaseUrl = await getBackendUrl();
        const runnerUrl = await getRunnerUrl() || `${backendBaseUrl}/runner`;
        const body = JSON.stringify({ spec_path: specPath, runner_url: runnerUrl, max_attempts: 2 });
        const headers = { "Content-Type": "application/json", ...(await getAuthHeaders()) };

        // Try generator service first, fall back to backend proxy
        let resp = await fetch(`${generatorBaseUrl}/validate-and-fix`, { method: "POST", headers, body });
        if (resp.status === 404) {
          resp = await fetch(`${backendBaseUrl}/generator/validate-and-fix`, { method: "POST", headers, body });
        }

        const data = await resp.json();
        console.log("[sw][mcp] Validate result:", data.status, "fixed:", data.fixed, "attempts:", data.attempts);
        return data;
      } catch (err) {
        console.error("[sw][mcp] Validate test error:", err);
        return { ok: false, error: `Validation error: ${err.message}` };
      }
    }

    // ── Run in Browser: convert Playwright spec → extension steps and replay ──
    if (type === "run_in_browser") {
      const { testId } = message;
      if (!testId) return { ok: false, error: "testId is required" };

      try {
        // 1. Fetch spec code + metadata from proxy
        const testResp = await fetch(`${await getGeneratorUrl()}/tests/${testId}`, {
          headers: await getAuthHeaders(),
        });
        if (!testResp.ok) return { ok: false, error: `Failed to fetch test: HTTP ${testResp.status}` };
        const testData = await testResp.json();
        if (!testData.ok) return { ok: false, error: testData.error || "Failed to fetch test" };

        const { spec_code, target_url } = testData;
        if (!spec_code) return { ok: false, error: "No spec code found for this test" };
        if (!target_url) return { ok: false, error: "No target URL in test metadata" };

        // 2. Convert Playwright spec → extension steps
        const { steps, warnings } = playwrightToSteps(spec_code, target_url);
        console.log("[sw][run_in_browser] Converted", steps.length, "steps, warnings:", warnings);
        if (!steps.length) return { ok: false, error: "No convertible steps found in spec file", warnings };

        // 3. Ensure a persistent environment exists for the target URL
        const persistedEnv = await ensureEnvironmentForUrl(target_url, "ai");
        const syntheticEnv = persistedEnv || {
          id: `generated-${testId}`,
          name: "Generated Test",
          baseUrl: new URL(target_url).origin,
        };

        // 4. Get active tab
        let activeTabId = tabId;
        if (!activeTabId) {
          try {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            activeTabId = activeTab?.id;
          } catch {}
        }

        if (!activeTabId) {
          // Create a new tab with a blank page — navigation step will handle the URL
          const tab = await chrome.tabs.create({ url: target_url });
          activeTabId = tab.id;
          await waitForTabComplete(activeTabId, 30000);
        }

        // 5. Let runReplayOnTab handle ALL steps including navigation.
        // The navigation step will navigate the tab to the correct URL.
        const result = await runReplayOnTab({
          tabId: activeTabId,
          env: syntheticEnv,
          steps,
          recordingId: `gen-${testId}`,
          skipNavigation: false,
          softAssertions: true,
        });
        return { ok: true, report: result.report, warnings };
      } catch (err) {
        console.error("[sw][run_in_browser] Error:", err);
        return {
          ok: false,
          error: err?.message || "Run in browser failed",
          report: err?.report || null,
        };
      }
    }

    // ── Registry: pull test and save locally ──
    if (type === "registry_pull_test") {
      try {
        const { testName, specCode, targetUrl } = message;
        if (!specCode) return { ok: false, error: "No spec code provided" };

        // Convert Playwright spec → extension steps
        const { steps, warnings } = playwrightToSteps(specCode, targetUrl);
        if (!steps.length) return { ok: false, error: "No convertible steps found", warnings };

        // Ensure environment exists
        const env = await ensureEnvironmentForUrl(targetUrl, "ai");

        // Save as a recording
        const recordings = await loadRecordings();
        const newRec = {
          id: `registry_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
          name: testName || "Pulled from Registry",
          steps,
          createdAt: new Date().toISOString(),
          source: "registry",
          specCode,
          targetUrl
        };
        recordings.push(newRec);
        await saveRecordings(recordings);
        console.log("[sw][registry] Pulled test:", newRec.id, testName);
        return { ok: true, recordingId: newRec.id };
      } catch (err) {
        console.error("[sw][registry] Pull test error:", err);
        return { ok: false, error: err.message };
      }
    }

    // ── Registry: push local test to registry ──
    if (type === "registry_push_test") {
      try {
        const { testName, specCode, targetUrl, prompt } = message;
        const result = await chrome.storage.local.get(["registryConfig"]);
        const config = result.registryConfig || {};
        if (!config.connected || (!config.sessionToken && !config.accessKey)) {
          return { ok: false, error: "Not connected to registry" };
        }
        const backendUrl = await getBackendUrl();
        const authHeaders = config.sessionToken
          ? { "Authorization": `Bearer ${config.sessionToken}` }
          : { "X-Access-Key": config.accessKey };
        const resp = await fetch(`${backendUrl}/registry/tests`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...authHeaders,
          },
          body: JSON.stringify({
            test_name: testName,
            spec_code: specCode,
            target_url: targetUrl,
            prompt: prompt || "",
          }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`);
        console.log("[sw][registry] Pushed test:", data.test_id);
        return { ok: true, test_id: data.test_id };
      } catch (err) {
        console.error("[sw][registry] Push test error:", err);
        return { ok: false, error: err.message };
      }
    }

    if (type === "list_generated_tests") {
      try {
        const resp = await fetch(`${await getGeneratorUrl()}/tests`, {
          headers: await getAuthHeaders(),
        });
        const data = await resp.json();
        return data;
      } catch (err) {
        console.error("[sw][mcp] List tests error:", err);
        return { ok: false, tests: [], error: err.message };
      }
    }

    if (type === "get_generated_test") {
      const { testId } = message;
      if (!testId) return { ok: false, error: "testId required" };

      try {
        const resp = await fetch(`${await getGeneratorUrl()}/tests/${testId}`, {
          headers: await getAuthHeaders(),
        });
        const data = await resp.json();
        return data;
      } catch (err) {
        console.error("[sw][mcp] Get test error:", err);
        return { ok: false, error: err.message };
      }
    }

    if (type === "delete_generated_test") {
      const { testId } = message;
      if (!testId) return { ok: false, error: "testId required" };

      try {
        const resp = await fetch(`${await getGeneratorUrl()}/tests/${testId}`, {
          method: "DELETE",
          headers: await getAuthHeaders(),
        });
        const data = await resp.json();
        return data;
      } catch (err) {
        console.error("[sw][mcp] Delete test error:", err);
        return { ok: false, error: err.message };
      }
    }


    // Catch-all: backend service has been removed
    if (type?.startsWith("backend_")) {
      return { ok: false, error: "Backend service has been removed", code: "BACKEND_REMOVED" };
    }

    // NOTE: Old backend_* handlers removed (were wrapped in dead code block)
    // ============================================================
    // Playwright Runner (headless browser execution)
    // ============================================================

    if (type === "playwright_run") {
      console.log("[sw][runner] Playwright run requested");
      if (await isNotLoggedIn()) {
        return { ok: false, error: "Login to registry required. Connect in Settings > Account.", code: "LOGIN_REQUIRED" };
      }
      try {
        const runnerUrl = await getRunnerUrl();
        if (!runnerUrl) {
          return { ok: false, error: "Playwright Runner not configured. Enable it in Settings > Playwright.", code: "RUNNER_NOT_CONFIGURED" };
        }

        const config = { ...(message.config || {}) };
        if (!config.baseURL && typeof config.baseUrl === "string") config.baseURL = config.baseUrl;
        if (!config.baseURL && typeof config.base_url === "string") config.baseURL = config.base_url;

        const normalizedSteps = normalizeRunnerSteps(message.steps || []);
        const navPreview = normalizedSteps
          .filter((s) => String(s?.type || "") === "navigation")
          .slice(0, 5)
          .map((s, i) => ({
            idx: i + 1,
            relativePath: s?.relativePath || "",
            value: s?.value || "",
            url: s?.url || "",
          }));
        console.log("[sw][runner] Payload summary:", {
          totalSteps: normalizedSteps.length,
          navigationSteps: navPreview.length,
          baseURL: config.baseURL || "",
          navPreview,
        });

        const payload = {
          steps: normalizedSteps,
          config,
          networkMocks: message.networkMocks || null,
          blockPatterns: message.blockPatterns || null,
          runId: message.config?.runId || null,
        };

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 600000); // 10 min for large tests

        const response = await fetch(`${runnerUrl}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(await getAuthHeaders()) },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Runner returned ${response.status}: ${errText}`);
        }

        const data = await response.json();
        console.log("[sw][runner] Run complete:", data.report?.status);
        return { ok: true, report: data.report, artifacts: data.artifacts };
      } catch (err) {
        console.error("[sw][runner] Playwright run failed:", err);
        const msg = err.name === "AbortError"
          ? "Test execution timed out (10 min). The test may be too long or the runner is unresponsive."
          : err.message === "Failed to fetch"
            ? "Cannot reach the Playwright Runner. Is the Docker container running?"
            : err.message;
        return { ok: false, error: msg, code: "RUNNER_ERROR" };
      }
    }

    if (type === "playwright_run_multi") {
      // Multi-browser/device combo run — builds parallel test list from combos
      console.log("[sw][runner] Playwright multi-combo run requested");
      try {
        const runnerUrl = await getRunnerUrl();
        if (!runnerUrl) {
          return { ok: false, error: "Playwright Runner not configured.", code: "RUNNER_NOT_CONFIGURED" };
        }

        const normalizedSteps = normalizeRunnerSteps(message.steps || []);
        const combos = message.combos || [];
        const sharedConfig = message.sharedConfig || {};
        const networkMocks = message.networkMocks || null;
        const blockPatterns = message.blockPatterns || null;
        const liveRunId = message.runId || null;

        // Build test entries — one per combo
        const tests = combos.map((combo, idx) => ({
          steps: normalizedSteps,
          config: {
            ...sharedConfig,
            browser: combo.browser,
            device: combo.device,
          },
          networkMocks,
          blockPatterns,
          // Pass runId only to the first combo for live feed
          runId: idx === 0 ? liveRunId : null,
        }));

        const controller = new AbortController();
        const timeoutMs = 120000 * combos.length; // scale timeout with combo count
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(`${runnerUrl}/run-parallel`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(await getAuthHeaders()) },
          body: JSON.stringify({ tests, max_workers: Math.min(combos.length, 8) }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Runner returned ${response.status}: ${errText}`);
        }

        const data = await response.json();
        return { ok: true, results: data.results };
      } catch (err) {
        console.error("[sw][runner] Multi-combo run failed:", err);
        const msg = err.name === "AbortError"
          ? "Multi-combo execution timed out."
          : err.message === "Failed to fetch"
            ? "Cannot reach the Playwright Runner. Is the Docker container running?"
            : err.message;
        return { ok: false, error: msg, code: "RUNNER_ERROR" };
      }
    }

    if (type === "playwright_run_parallel") {
      console.log("[sw][runner] Playwright parallel run requested");
      try {
        const runnerUrl = await getRunnerUrl();
        if (!runnerUrl) {
          return { ok: false, error: "Playwright Runner URL not configured.", code: "RUNNER_NOT_CONFIGURED" };
        }

        const response = await fetch(`${runnerUrl}/run-parallel`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(await getAuthHeaders()) },
          body: JSON.stringify({
            tests: message.tests || [],
            max_workers: message.maxWorkers || 4,
          }),
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Runner returned ${response.status}: ${errText}`);
        }

        const data = await response.json();
        return { ok: true, results: data.results };
      } catch (err) {
        console.error("[sw][runner] Parallel run failed:", err);
        return { ok: false, error: err.message, code: "RUNNER_ERROR" };
      }
    }

    if (type === "playwright_api_test") {
      console.log("[sw][runner] Playwright API test requested");
      try {
        const runnerUrl = await getRunnerUrl();
        if (!runnerUrl) {
          return { ok: false, error: "Playwright Runner URL not configured.", code: "RUNNER_NOT_CONFIGURED" };
        }

        const response = await fetch(`${runnerUrl}/api-test`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(await getAuthHeaders()) },
          body: JSON.stringify({
            requests: message.requests || [],
            baseURL: message.baseURL || "",
          }),
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Runner returned ${response.status}: ${errText}`);
        }

        const data = await response.json();
        return { ok: true, report: data.report };
      } catch (err) {
        console.error("[sw][runner] API test failed:", err);
        return { ok: false, error: err.message, code: "RUNNER_ERROR" };
      }
    }

    if (type === "playwright_test_connection") {
      console.log("[sw][runner] Testing Playwright Runner connection");
      try {
        const runnerUrl = await getRunnerUrl();
        if (!runnerUrl) {
          return { ok: false, error: "Playwright Runner not configured. Enable it in Settings > Playwright." };
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const response = await fetch(`${runnerUrl}/health`, {
          method: "GET",
          headers: await getAuthHeaders(),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`Runner returned HTTP ${response.status}`);
        }

        const data = await response.json();
        return { ok: true, status: data.status, browsersInstalled: data.browsers_installed, outboundIps: data.outbound_ips || [] };
      } catch (err) {
        console.error("[sw][runner] Connection test failed:", err);
        const msg = err.name === "AbortError"
          ? `Connection timed out. Is the runner container running? (docker compose up runner)`
          : err.message === "Failed to fetch"
            ? `Cannot reach runner. Make sure the Docker container is running (docker compose -f backend/docker-compose.yml up -d runner) and the URL is correct.`
            : err.message;
        return { ok: false, error: msg };
      }
    }

    // ============================================================
    // Side Panel
    // ============================================================
    if (type === "toggle_side_panel" || type === "open_side_panel") {
      try {
        if (chrome.sidePanel && chrome.sidePanel.open) {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const windowId = activeTab?.windowId ?? (await chrome.windows.getCurrent()).id;
          await chrome.sidePanel.open({ windowId });
          console.log("[sw] Side panel opened via", type, "message");
          return { ok: true };
        } else {
          return { ok: false, error: "Side Panel API not available" };
        }
      } catch (err) {
        console.error("[sw] Failed to open side panel:", err);
        return { ok: false, error: err.message };
      }
    }

    return { ok: false, error: "UNKNOWN_MESSAGE" };
  }

  handle()
    .then((resp) => sendResponse(resp))
    .catch((err) => {
      console.error("Background message error:", err);
      // If a replay failed, attempt to attach a report stub.
      sendResponse({
        ok: false,
        error: err?.message || "INTERNAL_ERROR",
        code: err?.code || "INTERNAL_ERROR"
      });
    });

  return true; // keep message channel open for async response
});

// Restore badge status when tab is activated or updated
async function restoreBadgeForTab(tabId, url) {
  if (!tabId || !url) return;
  
  try {
    const urlKey = new URL(url).origin;
    const result = await chrome.storage.local.get(['badgeStatusByUrl']);
    const statusMap = result.badgeStatusByUrl || {};
    const savedStatus = statusMap[urlKey];
    
    if (savedStatus) {
      // Restore badge if saved within last 24 hours
      const ageHours = (Date.now() - savedStatus.timestamp) / (1000 * 60 * 60);
      if (ageHours < 24) {
        await chrome.action.setBadgeBackgroundColor({ tabId, color: savedStatus.color });
        await chrome.action.setBadgeText({ tabId, text: savedStatus.text });
      }
    }
  } catch (err) {
    console.error('[autotest] Failed to restore badge:', err);
  }
}

chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (tab?.url) {
      restoreBadgeForTab(activeInfo.tabId, tab.url);
    }
  });
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;

  restoreBadgeForTab(tabId, tab.url);

  // When a recording tab navigates to a new page (e.g. JS redirect, multi-page
  // flow, or a programmatically-opened tab that redirects after initial load),
  // re-send recorder_start to the fresh content script so recording continues.
  // The initial page load is NOT affected because recordingByTab is only set to
  // true inside startRecordingOnTab, which runs after waitForTabLoad resolves —
  // so the very first 'complete' event fires before recordingByTab is true.
  const isHttp = tab.url.startsWith('http://') || tab.url.startsWith('https://');
  if (!isHttp || !recordingByTab.get(tabId)) return;

  const env = await getDefaultEnvironment();
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'recorder_start', env });
  } catch {
    // Content script may not be ready yet (document_idle can lag briefly);
    // retry once after a short delay.
    await new Promise(r => setTimeout(r, 300));
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'recorder_start', env });
    } catch (e) {
      console.warn('[sw] Could not re-initialize recording after navigation on tab', tabId, e?.message);
    }
  }
});

// ── Detect new tabs opened during an active recording session ──────────
// When a new tab opens while recording is active, show a prompt in the
// new tab's HUD asking the user whether to record it. The user clicks
// "Record this tab" (or ignores it). This avoids timing/redirect races
// that broke the old auto-record approach.
chrome.tabs.onCreated.addListener(async (tab) => {
  // During replay the pre-registered watcher (pendingNewTabWatcher) already has
  // a listener in place — nothing extra needed here.
  if (replayLocks.size > 0) return;

  const originTabId = [...recordingByTab.keys()].find(id => recordingByTab.get(id));
  if (originTabId == null) return;
  console.log(`[cross-tab] New tab ${tab.id} opened during recording on origin ${originTabId} — waiting for it to load`);

  const resolvedTab = await waitForTabLoad(tab.id, 60000);
  if (!resolvedTab?.url) {
    console.warn(`[cross-tab] Tab ${tab.id} did not load a real URL within 60 s — ignoring`);
    return;
  }

  if (!recordingByTab.get(originTabId)) {
    console.log(`[cross-tab] Recording stopped on origin ${originTabId} before tab ${tab.id} loaded — ignoring`);
    return;
  }

  let domain;
  try { domain = new URL(resolvedTab.url).hostname; } catch {
    console.warn(`[cross-tab] Could not parse domain from ${resolvedTab.url} — ignoring`);
    return;
  }

  console.log(`[cross-tab] Showing "Record this tab?" prompt on tab ${tab.id} (domain: ${domain})`);
  // Store the pending prompt so the new tab's HUD popup can read it on load.
  await chrome.storage.local.set({ [`crossTabPrompt_${tab.id}`]: { originTabId, domain } });
  // Show the HUD on the new tab so the prompt is visible immediately.
  chrome.tabs.sendMessage(tab.id, { type: "hud_show" }).catch(e => console.warn(`[cross-tab] hud_show failed on tab ${tab.id}:`, e?.message));
  // Let the origin tab's HUD know a new tab opened (informational).
  chrome.tabs.sendMessage(originTabId, { type: "hud_cross_tab_prompt", domain }).catch(() => {});
});

// ── Clean up tab-specific storage keys when a tab is closed ──────────
chrome.tabs.onRemoved.addListener((tabId) => {
  const tabKeys = [
    `overlayMode_${tabId}`,
    `hudEnabled_${tabId}`,
    `hudMiniStatus_${tabId}`,
    `hudMinimized_${tabId}`,
    `hudIsVisible_${tabId}`,
    `crossTabPrompt_${tabId}`,
  ];
  chrome.storage.local.remove(tabKeys).catch(() => {});

  // Stop badge animation timer so it stops trying to update a closed tab
  setRecordingBadge(tabId, false);

  // If this was a linked recording tab that closed before the session ended,
  // immediately merge its captured steps into the origin tab so they aren't lost.
  for (const [originTabId, linked] of linkedTabsByOrigin.entries()) {
    if (!linked.has(tabId)) continue;

    const closedSteps = getStepsForTab(tabId);
    if (closedSteps.length > 0) {
      const originSteps = getStepsForTab(originTabId);
      originSteps.push(...closedSteps);
      originSteps.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    }

    stepsByTab.delete(tabId);
    capturedNetworkByTab.delete(tabId);
    tabIndexByTabId.delete(tabId);
    linked.delete(tabId);
    // Keep the origin entry in linkedTabsByOrigin even if set is now empty —
    // stopRecordingOnTab will clean it up. Removing it here was the bug.
    break;
  }

  // If the closed tab WAS an origin (user closed the recording tab itself), clean up fully
  linkedTabsByOrigin.delete(tabId);
});
