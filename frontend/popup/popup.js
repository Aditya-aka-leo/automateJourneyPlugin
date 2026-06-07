/**
 * Popup UI controller — QA-focused replay controls.
 */

import { createVersionedStore } from "../shared/storage.js";
import { playwrightToSteps, stepsToPlaywright } from "../shared/playwright-converter.js";

const STORE_ROOT_KEY = "autotest_root_v1";
const STORE_SCHEMA_VERSION = 1;
const ENV_KEY = "environments";

const store = createVersionedStore({
  rootKey: STORE_ROOT_KEY,
  schemaVersion: STORE_SCHEMA_VERSION
});

// ============================================================
// Context Detection: Popup / Side Panel / HUD iframe
// ============================================================
const IS_SIDE_PANEL = document.body.classList.contains('sidepanel-mode');
const IS_HUD = new URLSearchParams(window.location.search).get('context') === 'hud';

// If running inside HUD iframe, tag the body so CSS can adapt
if (IS_HUD) document.body.classList.add('hud-mode');

// Cached overlay mode — updated on load and via storage listener.
// Used so click handlers can read it synchronously (preserving user gesture).
let _cachedOverlayMode = 'none';

// ── Tab-specific overlay state ───────────────────────────────
// HUD/overlay state is per-tab so opening the HUD on Tab A doesn't
// affect Tab B.  _overlayTabId is the tab ID used for overlay storage keys.
let _overlayTabId = IS_HUD
  ? (parseInt(new URLSearchParams(window.location.search).get('tabId'), 10) || null)
  : null;

/** Generate a tab-specific storage key, e.g. "overlayMode_123".
 *  Returns null if tab ID is not yet known, so callers can skip the operation. */
function _tabKey(key) {
  return _overlayTabId ? `${key}_${_overlayTabId}` : null;
}

// In side panel mode, track the currently active tab across switches
let _sidePanelActiveTabId = null;

const els = {
  status: document.getElementById("status"),
  statusBadge: document.getElementById("statusBadge"),
  envSelect: document.getElementById("envSelect"),
  envHint: document.getElementById("envHint"),
  recordingSelect: document.getElementById("recordingSelect"),
  recordingHint: document.getElementById("recordingHint"),
  recordBtn: document.getElementById("recordBtn"),
  replayBtn: document.getElementById("replayBtn"),
  replayPartialBtn: document.getElementById("replayPartialBtn"),
  stopReplayBtn: document.getElementById("stopReplayBtn"),
  stepsList: document.getElementById("stepsList"),
  openOptions: document.getElementById("openOptions"),
  hudToggle: document.getElementById("hudToggle"),
  artifactsCard: document.getElementById("artifactsCard"),
  artifactsList: document.getElementById("artifactsList"),
  captureNone: document.getElementById("captureNone"),
  captureScreenshots: document.getElementById("captureScreenshots"),
  captureVideo: document.getElementById("captureVideo"),
  captureBoth: document.getElementById("captureBoth"),
  captureOnFailureOnly: document.getElementById("captureOnFailureOnly"),
  // AI Test Generator elements
  generateWithAIBtn: document.getElementById("generateWithAIBtn"),
  aiPromptSection: document.getElementById("aiPromptSection"),
  aiPromptInput: document.getElementById("aiPromptInput"),
  generateTestBtn: document.getElementById("generateTestBtn"),
  aiTestStatus: document.getElementById("aiTestStatus"),
  replayHeadlessBtn: document.getElementById("replayHeadlessBtn"),
  aiPromptSpinner: document.querySelector(".ai-prompt-spinner"),
  aiPromptContainer: document.querySelector(".ai-prompt-container"),
  // Cross-tab recording prompt
  crossTabPromptBanner: document.getElementById("crossTabPromptBanner"),
  crossTabPromptDomain: document.getElementById("crossTabPromptDomain"),
  confirmRecordTabBtn: document.getElementById("confirmRecordTabBtn"),
  dismissPromptBtn: document.getElementById("dismissPromptBtn"),
  // Discard recording button
  discardRecordingBtn: document.getElementById("discardRecordingBtn"),
  // Overlay mode
  overlayHudBtn: document.getElementById("overlayHudBtn"),
  overlaySidePanelBtn: document.getElementById("overlaySidePanelBtn"),
  unpinBtn: document.getElementById("unpinBtn"),
  // Replay controls bar
  replayControlsBar: document.getElementById("replayControlsBar"),
  pauseReplayBtn: document.getElementById("pauseReplayBtn"),
  resumeReplayBtn: document.getElementById("resumeReplayBtn"),
  stopReplayBtn2: document.getElementById("stopReplayBtn2"),
  // Step editor
  stepEditorPanel: document.getElementById("stepEditorPanel"),
  stepEditorIdx: document.getElementById("stepEditorIdx"),
  stepEditorName: document.getElementById("stepEditorName"),
  stepEditorType: document.getElementById("stepEditorType"),
  stepEditorValue: document.getElementById("stepEditorValue"),
  stepEditorSelector: document.getElementById("stepEditorSelector"),
  stepEditorSave: document.getElementById("stepEditorSave"),
  stepEditorDelete: document.getElementById("stepEditorDelete"),
  stepEditorCancel: document.getElementById("stepEditorCancel"),
  stepEditorClose: document.getElementById("stepEditorClose"),
  stepEditorAttr: document.getElementById("stepEditorAttr"),
  stepEditorAttrField: document.getElementById("stepEditorAttrField"),
  stepEditorTimeout: document.getElementById("stepEditorTimeout"),
  stepEditorSoft: document.getElementById("stepEditorSoft"),
  stepEditorSoftField: document.getElementById("stepEditorSoftField"),
  // Feature toolbar
  addAssertionBtn: document.getElementById("addAssertionBtn"),
  exportPlaywrightBtn: document.getElementById("exportPlaywrightBtn"),
  viewReportBtn: document.getElementById("viewReportBtn"),
  runAllBtn: document.getElementById("runAllBtn"),
  saveStorageStateBtn: document.getElementById("saveStorageStateBtn"),
  // Assert mode (during recording)
  assertModeBtn: document.getElementById("assertModeBtn"),
  // Playwright Runner
  playwrightPanel: document.getElementById("playwrightPanel"),
  playwrightPanelClose: document.getElementById("playwrightPanelClose"),
  pwBrowserGroup: document.getElementById("pwBrowserGroup"),
  pwDeviceGroup: document.getElementById("pwDeviceGroup"),
  pwTrace: document.getElementById("pwTrace"),
  pwVideo: document.getElementById("pwVideo"),
  pwHAR: document.getElementById("pwHAR"),
  pwScreenshots: document.getElementById("pwScreenshots"),
  pwTimezone: document.getElementById("pwTimezone"),
  pwLocale: document.getElementById("pwLocale"),
  pwGeoLat: document.getElementById("pwGeoLat"),
  pwGeoLon: document.getElementById("pwGeoLon"),
  pwNetworkMocks: document.getElementById("pwNetworkMocks"),
  pwUseCapturedMocks: document.getElementById("pwUseCapturedMocks"),
  pwCapturedCount: document.getElementById("pwCapturedCount"),
  useCapturedMocks: document.getElementById("useCapturedMocks"),
  capturedMocksRow: document.getElementById("capturedMocksRow"),
  capturedResponseCount: document.getElementById("capturedResponseCount"),
  pwLiveFeed: document.getElementById("pwLiveFeed"),
  pwRunBtn: document.getElementById("pwRunBtn"),
  pwStatus: document.getElementById("pwStatus"),
  pwLiveView: document.getElementById("pwLiveView"),
  pwLiveFrame: document.getElementById("pwLiveFrame"),
  pwResults: document.getElementById("pwResults"),
  // Main Steps/Code tab bar
  mainTabSteps: document.getElementById("mainTabSteps"),
  mainTabCode: document.getElementById("mainTabCode"),
  mainCodeView: document.getElementById("mainCodeView"),
  mainCodeViewer: document.getElementById("mainCodeViewer"),
  // Home grid
  homeRecordBtn: document.getElementById("homeRecordBtn"),
  homeGenerateBtn: document.getElementById("homeGenerateBtn"),
  homeReplayBtn: document.getElementById("homeReplayBtn"),
  homeHeadlessBtn: document.getElementById("homeHeadlessBtn"),
  // Mode header + back
  modeHeader: document.getElementById("modeHeader"),
  modeStatusDot: document.getElementById("modeStatusDot"),
  modeStatusText: document.getElementById("modeStatusText"),
  modeStepCount: document.getElementById("modeStepCount"),
  backToHomeBtn: document.getElementById("backToHomeBtn"),
  // Completion card
  completionCard: document.getElementById("completionCard"),
  completionIcon: document.getElementById("completionIcon"),
  completionMsg: document.getElementById("completionMsg"),
  completionDetails: document.getElementById("completionDetails"),
  // Headless stop + Replay start + Rerun
  pwStopBtn: document.getElementById("pwStopBtn"),
  pwRerunBtn: document.getElementById("pwRerunBtn"),
  startReplayBtn: document.getElementById("startReplayBtn"),
  // AI generation details
  aiGenDetails: document.getElementById("aiGenDetails"),
  aiGenTarget: document.getElementById("aiGenTarget"),
  aiGenPrompt: document.getElementById("aiGenPrompt"),
  aiGenTimer: document.getElementById("aiGenTimer"),
  aiGenLog: document.getElementById("aiGenLog"),
  aiGenResult: document.getElementById("aiGenResult"),
  // Mode header clear button
  clearModeBtn: document.getElementById("clearModeBtn"),
  // Home button status indicators
  homeRecordStatus: document.getElementById("homeRecordStatus"),
  homeGenerateStatus: document.getElementById("homeGenerateStatus"),
  homeReplayStatus: document.getElementById("homeReplayStatus"),
  homeHeadlessStatus: document.getElementById("homeHeadlessStatus"),
  // Network Filters
  nfToggleBtn: document.getElementById("nfToggleBtn"),
  nfBody: document.getElementById("nfBody"),
  nfBlockBadge: document.getElementById("nfBlockBadge"),
  nfCaptureBadge: document.getElementById("nfCaptureBadge"),
  blockPatternsEnabled: document.getElementById("blockPatternsEnabled"),
  blockPatternsInput: document.getElementById("blockPatternsInput"),
  capturePatternsEnabled: document.getElementById("capturePatternsEnabled"),
  capturePatternsInput: document.getElementById("capturePatternsInput"),
};

const state = {
  envs: [],
  recordings: [],
  lastReplayEnvId: null,
  lastSelectedRecordingId: null,
  isRecording: false,
  isReplaying: false,
  isPaused: false,
  isAssertMode: false,
  editingStepIndex: -1,
  lastSteps: [],
  lastReport: null
};

// ─── Feature Gates ────────────────────────────────────────
// CSS hides .ai-gated and .login-gated by default; this function
// adds body.ai-enabled and body.logged-in to reveal them.
// Advanced features (AI Generator, Playwright Runner) require registry login.
async function applyFeatureGates() {
  try {
    const result = await chrome.storage.local.get(['aiEnabled', 'registryConfig']);
    const aiEnabled = result.aiEnabled === true;
    const loggedIn = result.registryConfig?.connected === true && !!result.registryConfig?.sessionToken;
    document.body.classList.toggle('ai-enabled', aiEnabled);
    document.body.classList.toggle('logged-in', loggedIn);
    if ((!aiEnabled || !loggedIn) && els.aiPromptSection) {
      els.aiPromptSection.style.display = 'none';
      if (els.generateWithAIBtn) els.generateWithAIBtn.classList.remove('active');
    }
    if (!loggedIn && els.playwrightPanel) {
      els.playwrightPanel.style.display = 'none';
    }
  } catch (e) {
    console.warn('[popup] Failed to apply feature gates:', e);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.aiEnabled || changes.registryConfig)) {
    applyFeatureGates();
  }
});

// ─── UI Mode Manager ───────────────────────────────────────
// Modes: 'home' | 'recording' | 'replay-setup' | 'replaying' | 'generate' | 'headless' | 'completed'
const ALL_MODE_CLASSES = [
  'app--home', 'app--recording', 'app--replay-setup', 'app--replaying',
  'app--generate', 'app--headless', 'app--completed'
];

// Per-mode state: 'idle' | 'running' | 'success' | 'failed' | 'cancelled'
// Persists across home/mode switches so home buttons show last state.
const _modeState = {
  recording:  { status: 'idle', text: '' },
  generating: { status: 'idle', text: '' },
  replaying:  { status: 'idle', text: '' },
  headless:   { status: 'idle', text: '' },
};

function setModeState(key, status, text = '') {
  _modeState[key] = { status, text };
  // Auto-refresh home indicators if currently on home screen
  if (document.querySelector('.app')?.classList.contains('app--home')) {
    updateHomeIndicators();
  }
}

const _MODE_STATUS_LABELS = {
  idle: 'Ready',
  running: 'Running...',
  success: 'Passed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function updateHomeIndicators() {
  const map = [
    { btn: els.homeRecordBtn, statusEl: els.homeRecordStatus, key: 'recording' },
    { btn: els.homeGenerateBtn, statusEl: els.homeGenerateStatus, key: 'generating' },
    { btn: els.homeReplayBtn, statusEl: els.homeReplayStatus, key: 'replaying' },
    { btn: els.homeHeadlessBtn, statusEl: els.homeHeadlessStatus, key: 'headless' },
  ];
  for (const { btn, statusEl, key } of map) {
    if (!btn) continue;
    const { status, text } = _modeState[key];
    btn.setAttribute('data-state', status);
    if (statusEl) statusEl.textContent = text || _MODE_STATUS_LABELS[status] || '';
  }
}

function setUIMode(mode) {
  const app = document.querySelector('.app');
  ALL_MODE_CLASSES.forEach(c => app.classList.remove(c));
  if (app?.dataset?.completedMode) delete app.dataset.completedMode;

  // Reset ALL inline display overrides so CSS mode classes have full control.
  // Each mode case below re-sets only what it needs.
  if (els.playwrightPanel) els.playwrightPanel.style.display = '';
  if (els.aiPromptSection) els.aiPromptSection.style.display = '';
  if (els.replayControlsBar) els.replayControlsBar.style.display = '';
  if (els.pwStopBtn) els.pwStopBtn.style.display = 'none';
  if (els.pwRerunBtn) els.pwRerunBtn.style.display = '';
  if (els.pwLiveView) els.pwLiveView.style.display = '';
  if (els.pwResults) els.pwResults.style.display = '';
  if (els.clearModeBtn) els.clearModeBtn.style.display = 'none';
  if (els.stopReplayBtn) els.stopReplayBtn.style.display = '';
  if (els.aiGenDetails) els.aiGenDetails.style.display = '';
  if (els.aiGenResult) els.aiGenResult.style.display = '';
  if (els.discardRecordingBtn) els.discardRecordingBtn.style.display = 'none';

  switch (mode) {
    case 'home':
      app.classList.add('app--home');
      updateHomeIndicators();
      break;

    case 'recording':
      app.classList.add('app--recording');
      state.isReplaying = false;
      setModeState('recording', 'running', 'Recording...');
      hideReplayControls();
      if (els.assertModeBtn) els.assertModeBtn.style.display = '';
      if (els.discardRecordingBtn) els.discardRecordingBtn.style.display = '';
      updateModeHeader('Recording...', 'running');
      break;

    case 'replay-setup':
      app.classList.add('app--replay-setup');
      state.isRecording = false;
      disableAssertModeUI();
      updateModeHeader('Replay', 'idle');
      if (els.replayControlsBar) els.replayControlsBar.style.display = 'flex';
      // CSS shows startReplayBtn, hides pause/resume/stop
      break;

    case 'replaying':
      app.classList.add('app--replaying');
      state.isRecording = false;
      setModeState('replaying', 'running', 'Replaying...');
      showReplayControls();
      disableAssertModeUI();
      updateModeHeader('Replaying...', 'running');
      break;

    case 'generate':
      app.classList.add('app--generate');
      state.isRecording = false;
      state.isReplaying = false;
      hideReplayControls();
      disableAssertModeUI();
      if (els.aiPromptSection) els.aiPromptSection.style.display = 'block';
      updateModeHeader('Generate', 'idle');
      break;

    case 'headless':
      app.classList.add('app--headless');
      state.isRecording = false;
      state.isReplaying = false;
      hideReplayControls();
      disableAssertModeUI();
      if (els.playwrightPanel) els.playwrightPanel.style.display = 'block';
      if (els.pwStopBtn) {
        els.pwStopBtn.style.display = _modeState.headless.status === 'running' ? 'inline-flex' : 'none';
      }
      updateModeHeader('Headless', 'idle');
      break;
  }
  closeStepEditor();
}

function updateModeHeader(text, dotStatus, count = '') {
  if (els.modeStatusText) els.modeStatusText.textContent = text;
  if (els.modeStatusDot) els.modeStatusDot.className = `status-dot status-dot--${dotStatus}`;
  if (els.modeStepCount) els.modeStepCount.textContent = count;
}

// Tracks which mode triggered the current completion, so Clear can return there
let _completedFromMode = '';

/**
 * Show the completion card. `resultStatus` is 'success' | 'failed' | 'cancelled'.
 * `modeKey` identifies which home button to update (recording/generating/replaying/headless).
 */
function showCompletion(icon, message, details = '', { resultStatus = 'success', modeKey = '' } = {}) {
  const app = document.querySelector('.app');
  ALL_MODE_CLASSES.forEach(c => app.classList.remove(c));
  app.classList.remove('app--ai-idle', 'app--ai-generating', 'app--ai-generated', 'app--ai-running', 'app--ai-results');
  app.classList.add('app--completed');
  if (modeKey) {
    app.dataset.completedMode = modeKey;
  } else if (app?.dataset?.completedMode) {
    delete app.dataset.completedMode;
  }
  _completedFromMode = modeKey;
  // Update the specific mode's home-button state with details as summary
  if (modeKey) {
    setModeState(modeKey, resultStatus, details || message);
  }
  if (els.completionIcon) els.completionIcon.textContent = icon;
  if (els.completionMsg) els.completionMsg.textContent = message;
  if (els.completionDetails) els.completionDetails.textContent = details;
  updateModeHeader('Completed', resultStatus === 'success' ? 'success' : 'failure');
  // Show clear button in completed state
  if (els.clearModeBtn) els.clearModeBtn.style.display = '';
  // Show rerun button for headless completions
  if (els.pwRerunBtn) els.pwRerunBtn.style.display = modeKey === 'headless' ? 'inline-flex' : 'none';
  hideReplayControls();
  if (els.pwStopBtn) els.pwStopBtn.style.display = 'none';
  if (els.pwLiveView) els.pwLiveView.style.display = 'none';
}

function hideCompletion() {
  const app = document.querySelector('.app');
  app?.classList.remove('app--completed');
  if (app?.dataset?.completedMode) delete app.dataset.completedMode;
}

function showReplayControls() {
  if (els.replayControlsBar) els.replayControlsBar.style.display = 'flex';
  state.isPaused = false;
  if (els.startReplayBtn) els.startReplayBtn.style.display = 'none';
  if (els.pauseReplayBtn) els.pauseReplayBtn.style.display = 'inline-flex';
  if (els.resumeReplayBtn) els.resumeReplayBtn.style.display = 'none';
}

function hideReplayControls() {
  if (els.replayControlsBar) els.replayControlsBar.style.display = 'none';
}

function setStatus(text, status = "idle") {
  els.status.textContent = text || "";
  // Update the status dot colour
  els.statusBadge.className = `status-dot status-dot--${status === "stopped" ? "idle" : status}`;
  // If running inside HUD iframe, broadcast mini-status for the HUD container pill
  if (IS_HUD) {
    const miniKey = _tabKey('hudMiniStatus');
    if (miniKey) {
      const dotMap = { idle: 'idle', running: 'running', paused: 'paused', success: 'success', failure: 'failure', stopped: 'idle' };
      chrome.storage.local.set({
        [miniKey]: {
          dotClass: `__autotest_hud____mini-dot--${dotMap[status] || 'idle'}`,
          label: text || 'Idle',
          counter: ''
        }
      });
    }
  }
}

function renderEnvSelect() {
  els.envSelect.innerHTML = "";
  if (!state.envs.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No environments";
    els.envSelect.appendChild(opt);
    els.envSelect.disabled = true;
    els.envHint.textContent = "Create an environment in settings first.";
    els.replayBtn.disabled = true;
    return;
  }

  els.envSelect.disabled = false;
  state.envs.forEach((env) => {
    const opt = document.createElement("option");
    opt.value = env.id;
    opt.textContent = `${env.name} (${env.appId || "default"})`;
    if (env.isDefault) opt.dataset.default = "true";
    els.envSelect.appendChild(opt);
  });

  const defaultEnv = state.envs.find((e) => e.isDefault) || state.envs[0];
  els.envSelect.value = state.lastReplayEnvId || defaultEnv?.id || "";
  els.envHint.textContent = defaultEnv ? `Default: ${defaultEnv.name}` : "";
  els.replayBtn.disabled = false;
}

function renderRecordButton() {
  const svgRecord = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg>`;
  const svgStop   = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>`;
  if (state.isRecording) {
    els.recordBtn.innerHTML = `${svgStop} Stop`;
    els.recordBtn.className = "btn btn--danger";
  } else {
    els.recordBtn.innerHTML = `${svgRecord} Record`;
    els.recordBtn.className = "btn btn--record";
  }
}

// ─── Assert mode (during recording) ──────────────────────────
function renderAssertModeButton() {
  if (!els.assertModeBtn) return;
  if (state.isAssertMode) {
    els.assertModeBtn.classList.add('btn--assert-active');
    els.assertModeBtn.title = 'Assert mode ON — click elements on the page to add assertions';
  } else {
    els.assertModeBtn.classList.remove('btn--assert-active');
    els.assertModeBtn.title = 'Toggle assert mode — click page elements to add assertions';
  }
}

let _assertPollTimer = null;

async function toggleAssertMode() {
  state.isAssertMode = !state.isAssertMode;
  renderAssertModeButton();

  const tabId = await getActiveTabId();
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: state.isAssertMode ? 'assert_mode_on' : 'assert_mode_off'
    });
  } catch (err) {
    console.warn('[autotest][popup] Failed to toggle assert mode on content script:', err);
  }

  // Poll for live step updates while assert mode is on
  if (state.isAssertMode) {
    _startAssertPoll();
    setStatus('Assert mode ON — click elements on the page', 'running');
  } else {
    _stopAssertPoll();
    setStatus('Recording...', 'running');
  }
}

function _startAssertPoll() {
  _stopAssertPoll();
  _assertPollTimer = setInterval(async () => {
    if (!state.isRecording || !state.isAssertMode) { _stopAssertPoll(); return; }
    await refreshRecordedSteps();
  }, 1200);
}

function _stopAssertPoll() {
  if (_assertPollTimer) { clearInterval(_assertPollTimer); _assertPollTimer = null; }
}

function disableAssertModeUI() {
  if (els.assertModeBtn) els.assertModeBtn.style.display = 'none';
  _stopAssertPoll();
  if (state.isAssertMode) {
    state.isAssertMode = false;
    renderAssertModeButton();
    // Tell content script to turn off assert mode
    getActiveTabId().then((tabId) => {
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { type: 'assert_mode_off' }).catch(() => {});
      }
    });
  }
}

// ─── SVG icon helpers ────────────────────────────────────────
const STEP_ICONS = {
  passed : `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  failed : `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  soft_fail: `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>`,
  skipped: `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/></svg>`,
  running: `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
  pending: `<svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor" opacity="0.35"><circle cx="12" cy="12" r="5"/></svg>`,
};

function buildStepRow(step, idx, { statusOverride, showActions = false, showStartFrom = false } = {}) {
  const status = statusOverride || step.status || 'pending';
  const row = document.createElement("div");
  row.className = `step-row step-row--${status}`;
  row.setAttribute("data-step-index", idx);

  // Number + status icon
  const num = document.createElement("span");
  num.className = "step-num";
  num.innerHTML = STEP_ICONS[status] || `<span>${idx + 1}</span>`;

  // Type badge
  const typeBadge = document.createElement("span");
  typeBadge.className = "step-type-badge";
  typeBadge.textContent = (step.type || 'action').toUpperCase();

  // Name
  const name = document.createElement("span");
  name.className = "step-label";
  const displayName = getStepDisplayName(step);
  const nlPrefix = step.nlDescription ? '\u{1F916} ' : '';
  name.textContent = nlPrefix + displayName;
  name.title = displayName;

  // Value pill (for input / change)
  let valuePill = null;
  if ((step.type === 'input' || step.type === 'change') && step.value) {
    valuePill = document.createElement("span");
    valuePill.className = "step-value";
    const v = String(step.value);
    valuePill.textContent = `"${v.substring(0, 18)}${v.length > 18 ? '…' : ''}"`;
    valuePill.title = v;
  }

  // Status text (right side)
  const statusEl = document.createElement("span");
  statusEl.className = `step-status step-status--${status}`;
  statusEl.textContent = status === 'passed' ? 'PASS'
    : status === 'failed' ? 'FAIL'
    : status === 'soft_fail' ? 'WARN'
    : status === 'skipped' ? 'SKIP'
    : status === 'running' ? 'RUN' : '';

  // Hover actions: "Start from here" + replay-to
  let actions = null;
  if (showStartFrom) {
    actions = document.createElement("span");
    actions.className = "step-actions";
    const startBtn = document.createElement("button");
    startBtn.className = "step-action-btn step-action-btn--start";
    startBtn.title = `Start replay from step ${idx + 1} on current page`;
    startBtn.innerHTML = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polygon points="5 3 19 12 5 21 5 3"/><line x1="19" y1="3" x2="19" y2="21"/></svg>`;
    startBtn.onclick = (e) => { e.stopPropagation(); startFromStep(idx); };
    actions.appendChild(startBtn);
  }

  // Assemble
  row.appendChild(num);
  row.appendChild(typeBadge);
  row.appendChild(name);
  if (valuePill) row.appendChild(valuePill);
  row.appendChild(statusEl);
  if (actions) row.appendChild(actions);

  return row;
}

function renderSteps(report) {
  els.stepsList.innerHTML = "";
  if (!report?.steps?.length) {
    els.stepsList.innerHTML = `<div class="step-empty">No steps yet.</div>`;
    return;
  }
  
  const pageGroups = groupStepsByPage(report.steps);
  
  pageGroups.forEach((group, groupIdx) => {
    const color = PAGE_COLORS[groupIdx % PAGE_COLORS.length];
    els.stepsList.appendChild(renderPageHeader(group.page, group.steps.length, color));
    
    group.steps.forEach(({ step, idx }) => {
      const row = buildStepRow(step, idx, { showStartFrom: true });
      row.style.setProperty('--page-color', color);
      row.classList.add('step-row--grouped');
      els.stepsList.appendChild(row);

      if (step.status === "failed" && step.error) {
        const details = document.createElement("div");
        details.className = "step-error";
        const selectorAttempts = step.selectorAttempts || [];
        const attemptsCount = selectorAttempts.length;
        const notFound = step?.selectorHealing?.name || step?.notFoundTarget?.name;
        const notFoundText = step?.notFoundTarget?.text;
        const targetLabel = notFoundText ? `${notFound} / "${notFoundText}"` : notFound;
        const targetInfo = targetLabel ? ` · target: ${targetLabel}` : "";
        details.textContent = `${step.error.message || "Unknown"} (${step.error.code || "NO_CODE"})${targetInfo} · attempts: ${attemptsCount}`;
        els.stepsList.appendChild(details);

        // Fix & Continue buttons container
        const fixBtns = document.createElement("div");
        fixBtns.className = "step-fix-btns";

        // Manual Fix & Continue
        const fixBtn = document.createElement("button");
        fixBtn.className = "step-fix-btn";
        fixBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg> Fix & Continue`;
        fixBtn.onclick = () => fixFailedStepAndContinue(idx, report);
        fixBtns.appendChild(fixBtn);

        // AI Fix & Continue (only visible when AI is enabled)
        const aiFixBtn = document.createElement("button");
        aiFixBtn.className = "step-fix-btn step-fix-btn--ai ai-gated";
        aiFixBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg> Fix with AI`;
        aiFixBtn.onclick = () => fixWithAI(idx, step, report);
        fixBtns.appendChild(aiFixBtn);

        els.stepsList.appendChild(fixBtns);
      }
    });
  });
}

// Page-group color palette shared by popup + HUD
const PAGE_COLORS = ['#3498db','#9b59b6','#1abc9c','#e67e22','#e74c3c','#f1c40f','#2ecc71','#34495e'];

function groupStepsByPage(steps) {
  const groups = [];
  let curPage = null, curGroup = [];
  steps.forEach((step, idx) => {
    const p = step.relativePath || '/';
    if (p !== curPage) {
      if (curGroup.length) groups.push({ page: curPage, steps: curGroup });
      curPage = p;
      curGroup = [{ step, idx }];
    } else {
      curGroup.push({ step, idx });
    }
  });
  if (curGroup.length) groups.push({ page: curPage, steps: curGroup });
  return groups;
}

function renderPageHeader(page, count, color) {
  const el = document.createElement("div");
  el.className = "step-page-header";
  el.style.setProperty('--page-color', color);
  el.innerHTML = `
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
    <span class="step-page-path" title="${page}">${page}</span>
    <span class="step-page-count">${count}</span>
  `;
  return el;
}

function renderStepsFromRecorded(steps) {
  els.stepsList.innerHTML = "";
  if (!steps?.length) {
    els.stepsList.innerHTML = `<div class="step-empty">No steps yet.</div>`;
    return;
  }
  
  const pageGroups = groupStepsByPage(steps);
  
  pageGroups.forEach((group, groupIdx) => {
    const color = PAGE_COLORS[groupIdx % PAGE_COLORS.length];
    els.stepsList.appendChild(renderPageHeader(group.page, group.steps.length, color));
    
    group.steps.forEach(({ step, idx }) => {
      const row = document.createElement("div");
      row.className = "step-row step-row--recorded";
      row.style.setProperty('--page-color', color);
      if (step.nlDescription) row.classList.add('step-row--nl');

      // Number
      const num = document.createElement("span");
      num.className = "step-num step-num--index";
      num.textContent = idx + 1;

      // Type badge
      const typeBadge = document.createElement("span");
      const isAssert = (step.type || '').startsWith('assert_');
      typeBadge.className = "step-type-badge" + (isAssert ? " step-type-badge--assert" : "");
      typeBadge.textContent = isAssert
        ? step.type.replace('assert_', '').replace(/_/g, ' ').toUpperCase()
        : (step.type || 'action').toUpperCase();

      // Name (editable)
      const name = document.createElement("span");
      name.className = "step-label step-label--editable";
      name.title = 'Click to edit name';
      name.dataset.stepIdx = idx;
      const displayName = getStepDisplayName(step);
      const nlPrefix = step.nlDescription ? '\u{1F916} ' : '';
      name.textContent = nlPrefix + displayName;
      name.addEventListener('click', (e) => {
        e.stopPropagation();
        editStepNameInline(idx, step, name);
      });

      // Actions (appear on hover)
      const actions = document.createElement("span");
      actions.className = "step-actions";
      // Start-from-here button
      const startFromBtn = document.createElement("button");
      startFromBtn.className = "step-action-btn step-action-btn--start";
      startFromBtn.title = `Start from step ${idx + 1} on current page`;
      startFromBtn.innerHTML = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polygon points="5 3 19 12 5 21 5 3"/><line x1="19" y1="3" x2="19" y2="21"/></svg>`;
      startFromBtn.onclick = (e) => { e.stopPropagation(); startFromStep(idx); };
      // Replay-to button
      const playBtn = document.createElement("button");
      playBtn.className = "step-action-btn";
      playBtn.title = `Replay to step ${idx + 1}`;
      playBtn.innerHTML = `<svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
      playBtn.onclick = (e) => { e.stopPropagation(); startPartialReplay(idx + 1); };
      // Edit button (opens step editor panel)
      const editBtn = document.createElement("button");
      editBtn.className = "step-action-btn step-action-btn--edit";
      editBtn.title = `Edit step ${idx + 1}`;
      editBtn.innerHTML = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>`;
      editBtn.onclick = (e) => { e.stopPropagation(); openStepEditor(idx); };
      // Re-record button (replays to step, then records)
      const reRecordBtn = document.createElement("button");
      reRecordBtn.className = "step-action-btn step-action-btn--rerecord";
      reRecordBtn.title = `Re-record step ${idx + 1}`;
      reRecordBtn.innerHTML = `<svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="7"/></svg>`;
      reRecordBtn.onclick = (e) => { e.stopPropagation(); reRecordStep(idx); };

      actions.appendChild(startFromBtn);
      actions.appendChild(playBtn);
      actions.appendChild(editBtn);
      actions.appendChild(reRecordBtn);

      row.appendChild(num);
      row.appendChild(typeBadge);
      row.appendChild(name);
      row.appendChild(actions);
      els.stepsList.appendChild(row);
    });
  });
}

// Helper function to generate step display name (matches HUD logic)
function getStepDisplayName(step) {
  // Priority 0: Use custom name if set (user-edited name always wins)
  if (step.customName?.trim()) {
    let name = `${step.type.toUpperCase()}: ${step.customName.trim()}`;
    // Add value for input steps
    if ((step.type === 'input' || step.type === 'change') && step.value) {
      const displayValue = String(step.value).substring(0, 20);
      name += ` "${displayValue}${step.value.length > 20 ? '...' : ''}"`;
    }
    return name;
  }
  
  // List of generic/non-meaningful element names to ignore
  const genericNames = ['input', 'button', 'select', 'textarea', 'div', 'span', 'a', 'form', 'label'];
  
  // Priority 1: Use captured element name if it's meaningful
  const elementName = step.elementName?.trim();
  const isGenericName = elementName && genericNames.some(tag => 
    elementName.toLowerCase() === tag || 
    elementName.toLowerCase().startsWith(tag + '[')
  );
  
  if (elementName && elementName !== step.type && !isGenericName) {
    let name = `${step.type.toUpperCase()}: ${elementName}`;
    // Add value for input steps
    if ((step.type === 'input' || step.type === 'change') && step.value) {
      const displayValue = String(step.value).substring(0, 20);
      name += ` "${displayValue}${step.value.length > 20 ? '...' : ''}"`;
    }
    return name;
  }
  
  // Priority 2: Just show type and value for input steps
  if ((step.type === 'input' || step.type === 'change') && step.value) {
    const displayValue = String(step.value).substring(0, 30);
    return `${step.type.toUpperCase()}: "${displayValue}${step.value.length > 30 ? '...' : ''}"`;
  }
  
  // Default: just the type
  return step.type.toUpperCase();
}

function renderRecordingSelect() {
  els.recordingSelect.innerHTML = "";

  const allRecordings = state.recordings;

  if (!allRecordings.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No recordings";
    els.recordingSelect.appendChild(opt);
    els.recordingSelect.disabled = true;
    els.recordingHint.textContent = "Record and save a flow to replay it.";
    renderStepsFromRecorded([]);
  } else {
    els.recordingSelect.disabled = false;
    allRecordings.forEach((rec) => {
      const opt = document.createElement("option");
      opt.value = rec.id;
      const prefix = rec.source === 'ai' ? '\u2728 ' : '';
      opt.textContent = `${prefix}${rec.name} (${rec.steps?.length || 0} steps)`;
      els.recordingSelect.appendChild(opt);
    });

    // Restore last selected recording or default to first
    const lastSelectedId = state.lastSelectedRecordingId;
    const hasLastSelected = lastSelectedId && allRecordings.some(r => r.id === lastSelectedId);
    els.recordingSelect.value = hasLastSelected ? lastSelectedId : (allRecordings[0]?.id || "");
    els.recordingHint.textContent = "";

    // Show steps for the selected recording
    const selectedRecording = allRecordings.find((r) => r.id === els.recordingSelect.value);
    if (selectedRecording) {
      renderStepsFromRecorded(selectedRecording.steps || []);
      loadRecordingIntoCodeViewer(selectedRecording);
    }
  }

}

function updateCapturedMocksUI(recording) {
  const count = recording?.capturedResponses?.length || 0;
  if (els.capturedMocksRow) els.capturedMocksRow.style.display = count > 0 ? '' : 'none';
  if (els.capturedResponseCount) els.capturedResponseCount.textContent = count;
  if (els.pwCapturedCount) els.pwCapturedCount.textContent = `(${count} responses)`;
}

// Add event listener for recording selection changes
els.recordingSelect.addEventListener("change", () => {
  const selectedId = els.recordingSelect.value;
  // Save the selection
  state.lastSelectedRecordingId = selectedId;
  chrome.storage.local.set({ lastSelectedRecordingId: selectedId });

  const selectedRecording = state.recordings.find((r) => r.id === selectedId);
  if (selectedRecording) {
    renderStepsFromRecorded(selectedRecording.steps || []);
    updateCapturedMocksUI(selectedRecording);
    // If this is an AI recording with specCode, load it into the code viewer
    if (selectedRecording.source === 'ai' && selectedRecording.specCode) {
      loadRecordingIntoCodeViewer(selectedRecording);
    } else {
      // For normal recordings, generate Playwright code on the fly
      loadRecordingIntoCodeViewer(selectedRecording);
    }
  }
});

// ── Main Steps/Code tab switching ────────────────────────────
function switchMainTab(tab) {
  if (tab === 'code') {
    els.mainTabCode?.classList.add('steps-tab--active');
    els.mainTabSteps?.classList.remove('steps-tab--active');
    els.stepsList.style.display = 'none';
    if (els.mainCodeView) els.mainCodeView.style.display = '';
  } else {
    els.mainTabSteps?.classList.add('steps-tab--active');
    els.mainTabCode?.classList.remove('steps-tab--active');
    els.stepsList.style.display = '';
    if (els.mainCodeView) els.mainCodeView.style.display = 'none';
  }
}

if (els.mainTabSteps) els.mainTabSteps.addEventListener('click', () => switchMainTab('steps'));
if (els.mainTabCode) els.mainTabCode.addEventListener('click', () => switchMainTab('code'));

/**
 * Load a recording (normal or AI) into the code viewer.
 * - AI recordings: use stored specCode
 * - Normal recordings: generate Playwright code from steps via stepsToPlaywright()
 */
function loadRecordingIntoCodeViewer(recording) {
  if (!els.mainCodeViewer) return;
  let code = '';
  if (recording.source === 'ai' && recording.specCode) {
    code = recording.specCode;
  } else if (recording.steps?.length) {
    // Reverse-convert normal recording steps to Playwright
    const baseUrl = state.envs?.find(e => e.id === recording.envId)?.baseUrl || '';
    code = stepsToPlaywright(recording.steps, recording.name || 'Recorded test', baseUrl);
  }
  els.mainCodeViewer.textContent = code || '// No code available';
}

async function getActiveTabId() {
  // In side panel mode, prefer our tracked tab id (updated on tab switch)
  if (IS_SIDE_PANEL && _sidePanelActiveTabId) {
    return _sidePanelActiveTabId;
  }
  // Try currentWindow first, then fall back to lastFocusedWindow
  let tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs || tabs.length === 0) {
    tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  }
  const tabId = tabs[0]?.id || null;
  if (IS_SIDE_PANEL && tabId) {
    _sidePanelActiveTabId = tabId;
  }
  return tabId;
}

async function loadEnvironments() {
  const envs = (await store.get(ENV_KEY)) || [];
  state.envs = Array.isArray(envs) ? envs : [];
  renderEnvSelect();
}

async function loadRecordings() {
  const resp = await chrome.runtime.sendMessage({ type: "get_recordings" });
  state.recordings = Array.isArray(resp?.recordings) ? resp.recordings : [];
  renderRecordingSelect();
  
  // Ensure steps are shown for the selected recording after rendering
  const selectedRecording = state.recordings.find((r) => r.id === els.recordingSelect.value);
  if (selectedRecording && selectedRecording.steps?.length > 0) {
    renderStepsFromRecorded(selectedRecording.steps);
    updateCapturedMocksUI(selectedRecording);
  }
}

async function loadLastReport() {
  const tabId = await getActiveTabId();
  if (!tabId) return;
  const resp = await chrome.runtime.sendMessage({ type: "get_last_report", tabId });
  if (resp?.ok && resp.report) {
    if (resp.report.status === 'running' && !_browserRunInProgress && !['running', 'results'].includes(aiState.phase)) {
      // Only switch to replay mode if this isn't an AI-initiated run
      setUIMode('replaying');
      els.stopReplayBtn.style.display = 'block';
      els.replayBtn.disabled = true;
      if (els.replayPartialBtn) els.replayPartialBtn.disabled = true;
    } else {
      // Report is complete — ensure UI is not stuck in replaying mode
      if (state.isReplaying) {
        setUIMode('home');
      }
    }
    if (resp.report.status === 'passed' || resp.report.status === 'failed') {
      state.lastReport = resp.report;
      if (els.viewReportBtn) els.viewReportBtn.style.display = '';
    }
    renderSteps(resp.report);
    renderArtifacts(resp.report);
    const status = resp.report.status === "passed" ? "success" : resp.report.status === "failed" ? "failure" : "idle";
    const statusText = resp.report.status === "passed" ? "Last replay: Success ✓" : resp.report.status === "failed" ? "Last replay: Failed ✗" : resp.report.status;
    setStatus(statusText, status);
  } else {
    // Check for persisted status by URL
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.url) {
      const urlKey = new URL(tabs[0].url).origin;
      const result = await chrome.storage.local.get(['badgeStatusByUrl']);
      const statusMap = result.badgeStatusByUrl || {};
      const savedStatus = statusMap[urlKey];
      
      if (savedStatus) {
        const ageHours = (Date.now() - savedStatus.timestamp) / (1000 * 60 * 60);
        if (ageHours < 24) {
          const statusText = savedStatus.status === 'success' ? "Last replay: Success ✓" : "Last replay: Failed ✗";
          const statusType = savedStatus.status === 'success' ? "success" : "failure";
          setStatus(statusText, statusType);
          return;
        }
      }
    }
    
    // No last report — keep the steps from the selected recording as-is
  }
}

function renderArtifacts(report) {
  if (!report || (!report.screenshotArtifact && !report.videoArtifact)) {
    els.artifactsCard.style.display = 'none';
    return;
  }
  
  els.artifactsCard.style.display = 'block';
  els.artifactsList.innerHTML = '';
  
  // Show screenshots artifact
  if (report.screenshotArtifact) {
    const artifactDiv = document.createElement('div');
    artifactDiv.className = 'artifact-item';
    
    const screenshotCount = report.screenshotArtifact.screenshotCount || 0;
    const hasScreenshots = report.screenshotArtifact.screenshots && report.screenshotArtifact.screenshots.length > 0;
    
    artifactDiv.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <rect x="3" y="3" width="14" height="14" rx="2" stroke="currentColor" stroke-width="1.5"/>
        <path d="M3 13L6 10L9 13L14 8L17 11V15C17 16.1046 16.1046 17 15 17H5C3.89543 17 3 16.1046 3 15V13Z" fill="currentColor" opacity="0.3"/>
      </svg>
      <div class="artifact-info">
        <div class="artifact-name">📄 HTML Report with Screenshots</div>
        <div class="artifact-details">${screenshotCount} screenshot${screenshotCount !== 1 ? 's' : ''} • Open in Word to save as DOCX</div>
      </div>
      ${hasScreenshots ? `<button class="btn btn--ghost btn--small" style="margin-left: auto;">View</button>` : ''}
    `;
    
    // Add click handler to view screenshots
    if (hasScreenshots) {
      const viewBtn = artifactDiv.querySelector('button');
      viewBtn.addEventListener('click', () => {
        openScreenshotViewer(report.screenshotArtifact.screenshots, report);
      });
    }
    
    els.artifactsList.appendChild(artifactDiv);
  }
  
  // Show video artifact
  if (report.videoArtifact) {
    const artifactDiv = document.createElement('div');
    artifactDiv.className = 'artifact-item';
    
    const sizeMB = (report.videoArtifact.size / 1024 / 1024).toFixed(2);
    
    artifactDiv.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <rect x="2" y="4" width="16" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/>
        <path d="M8 8L12 10L8 12V8Z" fill="currentColor"/>
      </svg>
      <div class="artifact-info">
        <div class="artifact-name">🎥 Video Recording</div>
        <div class="artifact-details">${report.videoArtifact.filename} • ${sizeMB} MB</div>
      </div>
    `;
    
    els.artifactsList.appendChild(artifactDiv);
  }
}

function openScreenshotViewer(screenshots, report) {
  // Create modal overlay
  const modal = document.createElement('div');
  modal.className = 'screenshot-viewer-modal';
  modal.innerHTML = `
    <div class="screenshot-viewer-container">
      <div class="screenshot-viewer-header">
        <h3>📸 Screenshot Gallery (${screenshots.length})</h3>
        <button class="screenshot-viewer-close">&times;</button>
      </div>
      <div class="screenshot-viewer-content">
        <div class="screenshot-viewer-grid">
          ${screenshots.map((screenshot, index) => {
            const step = report.steps[index] || {};
            const stepName = step.customName || step.elementName || step.type || `Step ${index + 1}`;
            const statusClass = step.status === 'passed' ? 'passed' : step.status === 'failed' ? 'failed' : 'pending';
            return `
              <div class="screenshot-viewer-item" data-index="${index}">
                <img src="${screenshot}" alt="Step ${index + 1}">
                <div class="screenshot-viewer-item-info">
                  <div class="screenshot-viewer-item-title">${index + 1}. ${stepName}</div>
                  <div class="screenshot-viewer-item-status status-${statusClass}">${step.status || 'unknown'}</div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  // Close on background click or close button
  const closeBtn = modal.querySelector('.screenshot-viewer-close');
  closeBtn.addEventListener('click', () => {
    document.body.removeChild(modal);
  });
  
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      document.body.removeChild(modal);
    }
  });
  
  // Click on screenshot to view full size
  const items = modal.querySelectorAll('.screenshot-viewer-item img');
  items.forEach((img, index) => {
    img.addEventListener('click', () => {
      openFullscreenImage(screenshots[index]);
    });
  });
}

function openFullscreenImage(imageSrc) {
  const fullscreenModal = document.createElement('div');
  fullscreenModal.className = 'fullscreen-image-modal';
  fullscreenModal.innerHTML = `
    <span class="fullscreen-image-close">&times;</span>
    <img src="${imageSrc}" alt="Fullscreen screenshot">
  `;
  
  document.body.appendChild(fullscreenModal);
  
  const closeBtn = fullscreenModal.querySelector('.fullscreen-image-close');
  closeBtn.addEventListener('click', () => {
    document.body.removeChild(fullscreenModal);
  });
  
  fullscreenModal.addEventListener('click', (e) => {
    if (e.target === fullscreenModal || e.target.tagName === 'IMG') {
      document.body.removeChild(fullscreenModal);
    }
  });
  
  // Close on Escape key
  const escHandler = (e) => {
    if (e.key === 'Escape') {
      document.body.removeChild(fullscreenModal);
      document.removeEventListener('keydown', escHandler);
    }
  };
  document.addEventListener('keydown', escHandler);
}

async function refreshRecordingState() {
  const tabId = await getActiveTabId();
  if (!tabId) return;

  // Check if this tab has a pending "record this tab?" prompt from the background.
  if (IS_HUD && _overlayTabId) {
    const promptKey = `crossTabPrompt_${_overlayTabId}`;
    const stored = await chrome.storage.local.get(promptKey);
    const prompt = stored[promptKey];
    if (prompt) {
      console.log("[popup][cross-tab] Pending prompt found for tab", _overlayTabId, "domain:", prompt.domain);
      showCrossTabPrompt(prompt.domain);
      return; // Don't check recording state — we're in prompt mode
    }
  }

  const resp = await chrome.runtime.sendMessage({ type: "get_recording_state", tabId });
  if (resp?.ok) {
    state.isRecording = Boolean(resp.isRecording);
    renderRecordButton();
    if (resp.isReplaying) {
      state.isReplaying = true;
      setUIMode('replaying');
      setStatus("Replaying…", "running");
      // Start live polling using the origin tab's report (where steps are stored)
      startLinkedTabReplayPolling(resp.replayOriginTabId || tabId);
    } else if (state.isRecording) {
      setUIMode('recording');
      setStatus("Recording…", "running");
    }
  }
}

function showCrossTabPrompt(domain) {
  if (els.crossTabPromptBanner) {
    els.crossTabPromptBanner.style.display = '';
    if (els.crossTabPromptDomain) {
      els.crossTabPromptDomain.textContent = domain ? `Page: ${domain}` : 'Record your actions on this tab.';
    }
  }
}

function hideCrossTabPrompt() {
  if (els.crossTabPromptBanner) els.crossTabPromptBanner.style.display = 'none';
}

function startLinkedTabReplayPolling(reportTabId) {
  const pollInterval = setInterval(async () => {
    try {
      const resp = await chrome.runtime.sendMessage({ type: "get_last_report", tabId: reportTabId });
      if (!resp?.ok || !resp.report) { clearInterval(pollInterval); return; }
      renderStepsWithProgress(resp.report);
      const done = resp.report.steps?.filter(s => s.status === 'passed' || s.status === 'failed').length || 0;
      const total = resp.report.steps?.length || 0;
      if (resp.report.status === 'running') {
        setStatus(`Replaying ${done}/${total}…`, 'running');
        updateModeHeader('Replaying...', 'running', `${done}/${total}`);
      } else {
        clearInterval(pollInterval);
      }
    } catch { clearInterval(pollInterval); }
  }, 500);
}

async function refreshRecordedSteps() {
  if (!state.isRecording) return;
  const tabId = await getActiveTabId();
  if (!tabId) return;
  const resp = await chrome.runtime.sendMessage({ type: "get_steps", tabId });
  if (resp?.ok) {
    state.lastSteps = resp.steps || [];
    renderStepsFromRecorded(state.lastSteps);
    updateModeHeader('Recording...', 'running', `${state.lastSteps.length} steps`);
    setModeState('recording', 'running', `${state.lastSteps.length} steps captured`);
  }
}

function getCapturedMocksParams(recording) {
  const useCaptured = els.useCapturedMocks?.checked && (recording?.capturedResponses?.length || 0) > 0;
  return {
    useCapturedMocks: useCaptured,
    capturedResponses: useCaptured ? (recording?.capturedResponses || []) : []
  };
}

async function startReplay({ requireDifferentEnv } = {}) {
  // Get current tab
  const tabId = await getActiveTabId();
  if (!tabId) {
    setStatus("Could not determine current tab.", "failure");
    return;
  }
  
  const envId = els.envSelect.value;
  if (!envId) {
    setStatus("Select an environment first.", "failure");
    return;
  }
  const recordingId = els.recordingSelect.value;
  const selectedRecording = state.recordings.find((r) => r.id === recordingId);
  const steps = selectedRecording?.steps || null;
  
  if (!steps || steps.length === 0) {
    setStatus("No steps to replay.", "failure");
    return;
  }
  
  if (requireDifferentEnv && state.lastReplayEnvId && envId === state.lastReplayEnvId) {
    setStatus("Choose a different environment before replay.", "failure");
    els.envSelect.focus();
    return;
  }

  // Get environment to construct URL
  const env = state.envs.find(e => e.id === envId);
  if (!env) {
    setStatus("Environment not found.", "failure");
    return;
  }
  
  // Get first step's URL
  const firstStep = steps[0];
  const queryString = firstStep.queryParams && Object.keys(firstStep.queryParams).length > 0
    ? '?' + new URLSearchParams(firstStep.queryParams).toString()
    : '';
  const targetUrl = firstStep?.relativePath 
    ? `${env.baseUrl}${firstStep.relativePath}${queryString}`
    : env.baseUrl;

  setStatus("Opening URL and starting replay…", "running");
  setUIMode('replaying');
  
  // Show stop button, disable other replay buttons
  els.stopReplayBtn.style.display = 'block';
  els.replayBtn.disabled = true;
  if (els.replayPartialBtn) els.replayPartialBtn.disabled = true;
  
  // Check HUD settings (tab-specific)
  if (!_overlayTabId && tabId) _overlayTabId = tabId;
  const hudKey = _tabKey('hudEnabled');
  const isHudEnabled = hudKey
    ? (await chrome.storage.local.get([hudKey]))[hudKey]
    : false;
  
  // Update current tab URL
  try {
    await chrome.tabs.update(tabId, { url: targetUrl });
  } catch (tabErr) {
    setStatus("Failed to update tab: " + tabErr?.message, "failure");
    setUIMode('home');
    return;
  }
  
  // If HUD is enabled AND we're in the popup (not side panel), close after sending
  if (isHudEnabled && !IS_SIDE_PANEL) {
    try {
      // Show HUD immediately with initial state
      try {
        await chrome.tabs.sendMessage(tabId, { type: "hud_show" });
        
        const initialReport = {
          recordingId: selectedRecording.id,
          envId,
          startedAt: new Date().toISOString(),
          status: "running",
          steps: steps.map((s) => ({ ...s, status: "pending" }))
        };
        
        await chrome.tabs.sendMessage(tabId, { type: "hud_update", report: initialReport });
      } catch (hudErr) {
        console.log("Could not initialize HUD (tab may be loading):", hudErr);
      }
      
      // Fire replay message — background will wait for tab to be ready
      const capturedMocksParams = getCapturedMocksParams(selectedRecording);
      const response = await chrome.runtime.sendMessage({ type: "replay_start", envId, tabId, steps, recordingId: selectedRecording.id, ...capturedMocksParams });

      if (!response.ok && response.code === 'REPLAY_IN_PROGRESS') {
        const forceStop = confirm(response.error + "\n\nDo you want to force stop the current replay and start a new one?");
        if (forceStop) {
          await chrome.runtime.sendMessage({ type: "force_stop_replay", tabId });
          await chrome.runtime.sendMessage({ type: "replay_start", envId, tabId, steps, recordingId: selectedRecording.id, ...capturedMocksParams });
        } else {
          setStatus("Replay cancelled.", "failure");
          els.stopReplayBtn.style.display = 'none';
          els.replayBtn.disabled = false;
          if (els.replayPartialBtn) els.replayPartialBtn.disabled = false;
          setUIMode('home');
          return;
        }
      }
    } catch (err) {
      console.error("Failed to start replay:", err);
      setStatus("Failed to start replay: " + err?.message, "failure");
      els.stopReplayBtn.style.display = 'none';
      els.replayBtn.disabled = false;
      if (els.replayPartialBtn) els.replayPartialBtn.disabled = false;
      setUIMode('home');
      return;
    }
    
    // Close popup after message is sent (not side panel)
    window.close();
    return;
  }
  
  // ---------------------------------------------------------------
  // For side panel (with or without HUD) or popup without HUD:
  // Stay open and show live progress via polling.
  // ---------------------------------------------------------------

  // If HUD is enabled (side panel path), try to show it
  if (isHudEnabled) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "hud_show" });
    } catch (e) {
      console.log("Could not initialize HUD (tab may be loading):", e);
    }
  }

  // Wait for the tab to finish loading
  await new Promise(resolve => {
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(resolve, 5000); // Fallback timeout
  });
  
  // Small delay for content script to initialize
  await new Promise(resolve => setTimeout(resolve, 500));
  
  // Show initial "in progress" state
  if (steps && steps.length > 0) {
    renderStepsInProgress(steps);
  }
  setStatus(`Replaying step 0/${steps.length}…`, "running");
  
  // Fire replay WITHOUT awaiting — so polling can run while replay is in flight
  const capturedMocksParamsSP = getCapturedMocksParams(selectedRecording);
  const replayPromise = chrome.runtime.sendMessage({
    type: "replay_start", envId, tabId, steps, recordingId: selectedRecording.id, ...capturedMocksParamsSP
  });
  
  // Poll for live status updates (runs in parallel with the replay)
  const pollInterval = setInterval(async () => {
    try {
      const resp = await chrome.runtime.sendMessage({ type: "get_last_report", tabId });
      if (resp?.ok && resp.report) {
        renderStepsWithProgress(resp.report);
        
        // Update status text with step count
        const completedCount = resp.report.steps?.filter(
          s => s.status === 'passed' || s.status === 'failed'
        ).length || 0;
        const runningStep = resp.report.steps?.find(s => s.status === 'running');
        const totalCount = resp.report.steps?.length || steps.length;
        
        if (resp.report.status === "running") {
          if (state.isPaused) {
            setStatus(`Paused at ${completedCount}/${totalCount}`, "paused");
            updateModeHeader('Replay paused', 'paused', `${completedCount}/${totalCount}`);
          } else {
            const stepLabel = runningStep?.elementName || `step ${completedCount + 1}`;
            setStatus(`Replaying ${completedCount}/${totalCount} — ${stepLabel}…`, "running");
            updateModeHeader('Replaying...', 'running', `${completedCount}/${totalCount}`);
            setModeState('replaying', 'running', `${completedCount}/${totalCount} steps`);
          }
        }

        if (resp.report.status !== "running") {
          clearInterval(pollInterval);
        }
      }
    } catch (pollErr) {
      // Popup/side-panel may have lost connection briefly; just retry next tick
      console.warn("[popup] Poll error:", pollErr);
    }
  }, 500);
  
  // Wait for the replay to complete
  const resp = await replayPromise;
  clearInterval(pollInterval);
  
  // Handle "replay already in progress" — show force-stop option
  if (!resp.ok && resp.code === 'REPLAY_IN_PROGRESS') {
    if (resp.currentReport) {
      renderStepsWithProgress(resp.currentReport);
    }
    setStatus(resp.error, "failure");
    
    const forceStopBtn = document.createElement('button');
    forceStopBtn.className = 'btn btn--danger';
    forceStopBtn.textContent = 'Force Stop & Replay';
    forceStopBtn.style.marginTop = '8px';
    forceStopBtn.onclick = async () => {
      setStatus("Stopping current replay…", "running");
      await chrome.runtime.sendMessage({ type: "force_stop_replay", tabId });
      setStatus("Stopped. Starting new replay…", "running");
      await startReplay({ requireDifferentEnv: false });
    };
    
    const statusEl = document.querySelector('.status-bar');
    if (statusEl && !statusEl.querySelector('.btn--danger')) {
      statusEl.appendChild(forceStopBtn);
    }
    return;
  }
  
  // Hide stop button, re-enable other buttons
  els.stopReplayBtn.style.display = 'none';
  els.replayBtn.disabled = false;
  if (els.replayPartialBtn) els.replayPartialBtn.disabled = false;

  if (resp?.ok) {
    state.lastReplayEnvId = envId;
    chrome.storage.local.set({ lastReplayEnvId: envId });
    const report = resp.report;
    const passed = report?.steps?.filter(s => s.status === 'passed').length || 0;
    const failed = report?.steps?.filter(s => s.status === 'failed').length || 0;
    const total = report?.steps?.length || 0;
    const ok = report?.status === 'passed';
    showCompletion(ok ? '✓' : '✗', ok ? 'Replay passed!' : 'Replay failed', `${passed}/${total} passed${failed ? `, ${failed} failed` : ''} — ${report?.duration_ms || 0}ms`, { resultStatus: ok ? 'success' : 'failed', modeKey: 'replaying' });
    setStatus("Replay complete", ok ? "success" : "failure");
    renderSteps(report);
  } else {
    showCompletion('✗', 'Replay failed', resp?.error || 'Unknown error', { resultStatus: 'failed', modeKey: 'replaying' });
    setStatus(resp?.error || "Replay failed ✗", "failure");
    renderSteps(resp?.report);
  }
}

function renderStepsInProgress(steps) {
  els.stepsList.innerHTML = "";
  if (!steps?.length) {
    els.stepsList.innerHTML = `<div class="step-empty">No steps yet.</div>`;
    return;
  }
  
  const pageGroups = groupStepsByPage(steps);
  
  pageGroups.forEach((group, groupIdx) => {
    const color = PAGE_COLORS[groupIdx % PAGE_COLORS.length];
    els.stepsList.appendChild(renderPageHeader(group.page, group.steps.length, color));
    
    group.steps.forEach(({ step, idx }) => {
      const row = buildStepRow(step, idx, { statusOverride: 'pending' });
      row.style.setProperty('--page-color', color);
      row.classList.add('step-row--grouped');
      els.stepsList.appendChild(row);
    });
  });
}

function renderStepsWithProgress(report) {
  els.stepsList.innerHTML = "";
  if (!report?.steps?.length) {
    els.stepsList.innerHTML = `<div class="step-empty">No steps yet.</div>`;
    return;
  }
  
  let runningStepIndex = -1;
  const pageGroups = groupStepsByPage(report.steps);
  
  pageGroups.forEach((group, groupIdx) => {
    const color = PAGE_COLORS[groupIdx % PAGE_COLORS.length];
    els.stepsList.appendChild(renderPageHeader(group.page, group.steps.length, color));
    
    group.steps.forEach(({ step, idx }) => {
      let status = step.status || 'pending';
      if (status === 'pending') {
        const prev = report.steps[idx - 1];
        if (idx === 0 || prev?.status === 'passed' || prev?.status === 'failed') {
          status = 'running';
          runningStepIndex = idx;
        }
      }
      const row = buildStepRow(step, idx, { statusOverride: status });
      row.style.setProperty('--page-color', color);
      row.classList.add('step-row--grouped');
      els.stepsList.appendChild(row);

      if (step.status === "failed" && step.error) {
        const details = document.createElement("div");
        details.className = "step-error";
        const attemptsCount = step.selectorAttempts?.length || 0;
        const notFound = step?.selectorHealing?.name || step?.notFoundTarget?.name;
        const notFoundText = step?.notFoundTarget?.text;
        const targetLabel = notFoundText ? `${notFound} / "${notFoundText}"` : notFound;
        const targetInfo = targetLabel ? ` · target: ${targetLabel}` : "";
        details.textContent = `${step.error.message || "Unknown"} (${step.error.code || "NO_CODE"})${targetInfo} · attempts: ${attemptsCount}`;
        els.stepsList.appendChild(details);

        // Fix & Continue buttons
        const fixBtns = document.createElement("div");
        fixBtns.className = "step-fix-btns";

        const fixBtn = document.createElement("button");
        fixBtn.className = "step-fix-btn";
        fixBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg> Fix & Continue`;
        fixBtn.onclick = () => fixFailedStepAndContinue(idx, report);
        fixBtns.appendChild(fixBtn);

        const aiFixBtn = document.createElement("button");
        aiFixBtn.className = "step-fix-btn step-fix-btn--ai ai-gated";
        aiFixBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg> Fix with AI`;
        aiFixBtn.onclick = () => fixWithAI(idx, step, report);
        fixBtns.appendChild(aiFixBtn);

        els.stepsList.appendChild(fixBtns);
      }
    });
  });

  // Auto-scroll to the running step
  if (runningStepIndex >= 0) {
    const runningRow = els.stepsList.querySelector(`[data-step-index="${runningStepIndex}"]`);
    if (runningRow) {
      runningRow.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }
}

// Helper: send a message to the background with a timeout (ms).
// Retries up to 3 times to handle MV3 service-worker cold-start delays.
async function sendMessageWithTimeout(msg, timeoutMs = 10000) {
  const MAX_ATTEMPTS = 3;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await Promise.race([
        chrome.runtime.sendMessage(msg),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("timeout")), timeoutMs)
        )
      ]);
      return resp;
    } catch (err) {
      lastErr = err;
      const errMsg = err?.message || String(err);
      // Retry on timeout or SW-not-ready errors; abort on definitive failures
      const retriable =
        errMsg === "timeout" ||
        errMsg.includes("Receiving end does not exist") ||
        errMsg.includes("Extension context invalidated") ||
        errMsg.includes("message port closed");
      if (!retriable || attempt === MAX_ATTEMPTS) break;
      console.warn(`[popup] sendMessage attempt ${attempt}/${MAX_ATTEMPTS} failed (${errMsg}), retrying…`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error(
    lastErr?.message === "timeout"
      ? "Background did not respond (service worker may have crashed). Reload the extension and try again."
      : lastErr?.message || "Background communication failed"
  );
}

async function toggleRecording() {
  const tabId = await getActiveTabId();
  if (!tabId) {
    setStatus("No active tab to record on.", "failure");
    return;
  }
  try {
    if (!state.isRecording) {
      setStatus("Starting recorder…", "running");
      const resp = await sendMessageWithTimeout({ type: "recorder_start_for_tab", tabId });
      if (!resp?.ok) throw new Error(resp?.error || "Recorder start failed.");
      state.isRecording = true;
      setUIMode('recording');
      setStatus("Recording…", "running");
    } else {
      // Check if this is a re-record operation or fix-and-continue
      const storageData = await chrome.storage.local.get(['reRecordContext', 'fixAndContinueContext']);
      const reRecordContext = storageData?.reRecordContext;
      const fixAndContinueContext = storageData?.fixAndContinueContext;
      
      if (fixAndContinueContext) {
        // Fix & Continue mode: replace step and continue replay
        const { recordingId, stepIndex, recordingName, remainingSteps, envId } = fixAndContinueContext;
        
        // Get the newly recorded steps
        const stepsResp = await chrome.runtime.sendMessage({ type: "get_steps", tabId });
        const newSteps = stepsResp?.steps || [];
        
        if (newSteps.length === 0) {
          throw new Error("No new step was recorded");
        }
        
        if (newSteps.length > 1) {
          const useFirst = window.confirm(
            `You recorded ${newSteps.length} steps, but only one is needed.\n\n` +
            `Use the first step?\n` +
            `(Click Cancel to use all ${newSteps.length} steps)`
          );
          if (useFirst) {
            newSteps.splice(1);
          }
        }
        
        // Get the original recording and replace the step
        const selectedRecording = state.recordings.find((r) => r.id === recordingId);
        if (selectedRecording) {
          selectedRecording.steps.splice(stepIndex, 1, ...newSteps);
          
          // Save updated recording
          await chrome.runtime.sendMessage({
            type: "update_recording",
            recordingId,
            steps: selectedRecording.steps,
            name: recordingName
          });
          
          setStatus(`Step ${stepIndex + 1} fixed, continuing replay...`, "success");
          
          // Stop recording
          await chrome.runtime.sendMessage({ type: "recorder_stop_for_tab", tabId });
          state.isRecording = false;
          setUIMode('home');
          renderRecordButton();
          
          // Clear context
          await chrome.storage.local.remove('fixAndContinueContext');
          
          // Continue replay from the next step
          if (remainingSteps && remainingSteps.length > 0) {
            await new Promise(resolve => setTimeout(resolve, 500));
            
            setUIMode('replaying');
            setStatus(`Continuing replay (${remainingSteps.length} steps remaining)...`, "running");
            
            const continueResp = await chrome.runtime.sendMessage({
              type: "replay_start",
              envId,
              tabId,
              steps: remainingSteps
            });
            
            setUIMode('home');
            if (continueResp?.ok) {
              setStatus("Replay completed successfully!", "success");
              renderSteps(continueResp.report);
            } else {
              setStatus(continueResp?.error || "Continue failed", "failure");
              renderSteps(continueResp?.report);
            }
          } else {
            setUIMode('home');
            setStatus("Step fixed, no remaining steps", "success");
          }
          
          await loadRecordings();
          return;
        }
      } else if (reRecordContext) {
        // Re-record mode: replace the specific step
        const { recordingId, stepIndex, recordingName } = reRecordContext;
        
        // Get the newly recorded steps
        const stepsResp = await chrome.runtime.sendMessage({ type: "get_steps", tabId });
        const newSteps = stepsResp?.steps || [];
        
        if (newSteps.length === 0) {
          throw new Error("No new step was recorded");
        }
        
        if (newSteps.length > 1) {
          const useFirst = window.confirm(
            `You recorded ${newSteps.length} steps, but only one is needed.\n\n` +
            `Use the first step to replace step ${stepIndex + 1}?\n` +
            `(Click Cancel to use all ${newSteps.length} steps)`
          );
          if (useFirst) {
            newSteps.splice(1); // Keep only first
          }
        }
        
        // Get the original recording and replace the step
        const selectedRecording = state.recordings.find((r) => r.id === recordingId);
        if (selectedRecording) {
          selectedRecording.steps.splice(stepIndex, 1, ...newSteps);
          
          // Save updated recording
          const saveResp = await chrome.runtime.sendMessage({
            type: "update_recording",
            recordingId,
            steps: selectedRecording.steps,
            name: recordingName
          });
          
          if (!saveResp?.ok) {
            // If update endpoint doesn't exist, delete and recreate
            await chrome.runtime.sendMessage({ type: "delete_recording", recordingId });
            await chrome.runtime.sendMessage({
              type: "save_recording",
              tabId,
              name: recordingName,
              steps: selectedRecording.steps
            });
          }
          
          setStatus(`Step ${stepIndex + 1} updated`, "success");
        }
        
        // Clear the re-record context
        await chrome.storage.local.remove('reRecordContext');
      } else {
        // Normal recording mode: save as new
        const name = window.prompt("Save recording as:", "");
        if (!name || !name.trim()) {
          setStatus("Recording name is required to save.", "failure");
          return;
        }
        const saveResp = await chrome.runtime.sendMessage({
          type: "save_recording",
          tabId,
          name: name.trim()
        });
        if (!saveResp?.ok) throw new Error(saveResp?.error || "Save recording failed.");
        setStatus("Recording saved", "success");
        // Refresh envs in case a new auto-environment was created
        await loadEnvironments();
      }

      const resp = await chrome.runtime.sendMessage({ type: "recorder_stop_for_tab", tabId });
      if (!resp?.ok) throw new Error(resp?.error || "Recorder stop failed.");
      state.isRecording = false;
      showCompletion('✓', 'Recording saved!', `${state.lastSteps?.length || 0} steps captured`, { resultStatus: 'success', modeKey: 'recording' });
      setStatus("Recording saved", "success");
    }
    renderRecordButton();
    await loadRecordings();
    await refreshRecordedSteps();
  } catch (err) {
    console.error("[autotest][popup] toggleRecording error:", err);
    state.isRecording = false;
    setModeState('recording', 'failed', 'Recording failed');
    setUIMode('home');
    renderRecordButton();
    const msg = err?.message || "Unknown error";
    setStatus(`Recording failed: ${msg}`, "failure");
    // Ensure recording badge is cleared in the background even on error
    try {
      const tid = await getActiveTabId();
      if (tid) await chrome.runtime.sendMessage({ type: "recorder_stop_for_tab", tabId: tid });
    } catch (_) { /* best-effort */ }
  }
}

async function startPartialReplay(upToStep) {
  const tabId = await getActiveTabId();
  if (!tabId) {
    setStatus("No active tab to replay on.", "failure");
    return;
  }
  const envId = els.envSelect.value;
  if (!envId) {
    setStatus("Select an environment first.", "failure");
    return;
  }
  const recordingId = els.recordingSelect.value;
  const selectedRecording = state.recordings.find((r) => r.id === recordingId);
  const allSteps = selectedRecording?.steps || [];
  
  // Only replay up to the specified step
  const steps = allSteps.slice(0, upToStep);
  
  if (!steps || steps.length === 0) {
    setStatus("No steps to replay.", "failure");
    return;
  }

  setStatus(`Running replay (steps 1-${upToStep})…`, "running");
  setUIMode('replaying');
  
  // Initialize steps as "in progress"
  renderStepsInProgress(steps);
  
  // Start replay (non-blocking) — poll runs in parallel
  const replayPromise = chrome.runtime.sendMessage({ type: "replay_start", envId, tabId, steps, recordingId: selectedRecording.id });
  
  // Poll for live status updates during partial replay
  const pollInterval = setInterval(async () => {
    try {
      const resp = await chrome.runtime.sendMessage({ type: "get_last_report", tabId });
      if (resp?.ok && resp.report) {
        renderStepsWithProgress(resp.report);
        
        const completedCount = resp.report.steps?.filter(
          s => s.status === 'passed' || s.status === 'failed'
        ).length || 0;
        const runningStep = resp.report.steps?.find(s => s.status === 'running');
        const totalCount = resp.report.steps?.length || steps.length;
        
        if (resp.report.status === "running") {
          if (state.isPaused) {
            setStatus(`Paused at ${completedCount}/${totalCount}`, "paused");
            updateModeHeader('Replay paused', 'paused', `${completedCount}/${totalCount}`);
          } else {
            const stepLabel = runningStep?.elementName || `step ${completedCount + 1}`;
            setStatus(`Replaying ${completedCount}/${totalCount} — ${stepLabel}…`, "running");
            updateModeHeader('Replaying...', 'running', `${completedCount}/${totalCount}`);
            setModeState('replaying', 'running', `${completedCount}/${totalCount} steps`);
          }
        }

        if (resp.report.status !== "running") {
          clearInterval(pollInterval);
        }
      }
    } catch (pollErr) {
      console.warn("[popup] Poll error:", pollErr);
    }
  }, 500);
  
  // Wait for replay to complete
  const resp = await replayPromise;
  clearInterval(pollInterval);
  setUIMode('home');
  
  if (resp?.ok) {
    state.lastReplayEnvId = envId;
    chrome.storage.local.set({ lastReplayEnvId: envId });
    setStatus(`Replay complete (steps 1-${upToStep}) ✓`, "success");
    renderSteps(resp.report);
  } else {
    setStatus(resp?.error || "Replay failed ✗", "failure");
    renderSteps(resp?.report);
  }
}

/**
 * Start replay from a specific step index on the CURRENT page.
 * Does NOT navigate to the original recording URL — it uses whatever page
 * is already open and runs from step `fromIndex` to the end (or to the
 * last step on the same page).
 */
async function startFromStep(fromIndex) {
  const tabId = await getActiveTabId();
  if (!tabId) {
    setStatus("No active tab to replay on.", "failure");
    return;
  }
  const envId = els.envSelect.value;
  if (!envId) {
    setStatus("Select an environment first.", "failure");
    return;
  }
  const recordingId = els.recordingSelect.value;
  const selectedRecording = state.recordings.find((r) => r.id === recordingId);
  const allSteps = selectedRecording?.steps || [];
  
  if (fromIndex < 0 || fromIndex >= allSteps.length) {
    setStatus("Invalid step index.", "failure");
    return;
  }
  
  // Slice from the chosen step to the end
  const steps = allSteps.slice(fromIndex);
  
  if (!steps.length) {
    setStatus("No steps to replay.", "failure");
    return;
  }
  
  const startNum = fromIndex + 1;
  const endNum = allSteps.length;
  setStatus(`Starting from step ${startNum}/${endNum} on current page…`, "running");
  setUIMode('replaying');
  
  // Show stop button, disable other replay buttons
  els.stopReplayBtn.style.display = 'block';
  els.replayBtn.disabled = true;
  if (els.replayPartialBtn) els.replayPartialBtn.disabled = true;
  
  // Initialize steps as "in progress"
  renderStepsInProgress(steps);
  
  // Fire replay — use replay_from_step message so background knows not to navigate
  const replayPromise = chrome.runtime.sendMessage({
    type: "replay_from_step",
    envId,
    tabId,
    steps,
    fromIndex,
    recordingId: selectedRecording.id
  });
  
  // Poll for live status updates (startFromStep)
  const pollInterval = setInterval(async () => {
    try {
      const resp = await chrome.runtime.sendMessage({ type: "get_last_report", tabId });
      if (resp?.ok && resp.report) {
        renderStepsWithProgress(resp.report);
        
        const completedCount = resp.report.steps?.filter(
          s => s.status === 'passed' || s.status === 'failed'
        ).length || 0;
        const runningStep = resp.report.steps?.find(s => s.status === 'running');
        const totalCount = resp.report.steps?.length || steps.length;
        
        if (resp.report.status === "running") {
          if (state.isPaused) {
            setStatus(`Paused at ${completedCount}/${totalCount} (from step ${startNum})`, "paused");
          } else {
            const stepLabel = runningStep?.elementName || `step ${completedCount + 1}`;
            setStatus(`Replaying ${completedCount}/${totalCount} (from step ${startNum}) — ${stepLabel}…`, "running");
          }
        }
        
        if (resp.report.status !== "running") {
          clearInterval(pollInterval);
        }
      }
    } catch (pollErr) {
      console.warn("[popup] Poll error:", pollErr);
    }
  }, 500);
  
  // Wait for replay to complete
  const resp = await replayPromise;
  clearInterval(pollInterval);
  
  // Re-enable buttons
  els.stopReplayBtn.style.display = 'none';
  els.replayBtn.disabled = false;
  if (els.replayPartialBtn) els.replayPartialBtn.disabled = false;
  setUIMode('home');
  
  if (resp?.ok) {
    state.lastReplayEnvId = envId;
    chrome.storage.local.set({ lastReplayEnvId: envId });
    setStatus(`Replay complete (steps ${startNum}-${endNum}) ✓`, "success");
    renderSteps(resp.report);
  } else {
    setStatus(resp?.error || "Replay failed ✗", "failure");
    renderSteps(resp?.report);
  }
}

async function editStepNameInline(stepIndex, step, nameElement) {
  const recordingId = els.recordingSelect.value;
  const selectedRecording = state.recordings.find((r) => r.id === recordingId);
  
  if (!selectedRecording) return;
  
  const currentName = step.customName || '';
  
  // Create input element
  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentName;
  input.style.cssText = `
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 12px;
    color: var(--text);
    font-family: inherit;
    width: 100%;
  `;
  
  // Save function
  const saveEdit = async () => {
    const newName = input.value.trim();
    
    // Update the step with custom name
    step.customName = newName || null;
    
    // Save recording
    try {
      await chrome.runtime.sendMessage({
        type: 'update_recording',
        recording: selectedRecording
      });
      
      // Refresh display with new display name
      const displayName = getStepDisplayName(step);
      nameElement.textContent = `${stepIndex + 1}. ${displayName}`;
      nameElement.style.cursor = 'pointer';
      
      setStatus("Step name updated", "success");
    } catch (err) {
      console.error('Failed to update step name:', err);
      setStatus("Failed to update step name", "failure");
    }
  };
  
  // Handle blur and enter
  input.addEventListener('blur', saveEdit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // Cancel - restore original
      const displayName = getStepDisplayName(step);
      nameElement.textContent = `${stepIndex + 1}. ${displayName}`;
      nameElement.style.cursor = 'pointer';
    }
  });
  
  // Replace with input
  nameElement.textContent = '';
  nameElement.appendChild(input);
  nameElement.style.cursor = 'text';
  input.focus();
  input.select();
}

async function reRecordStep(stepIndex) {
  const recordingId = els.recordingSelect.value;
  const selectedRecording = state.recordings.find((r) => r.id === recordingId);
  
  if (!selectedRecording) {
    setStatus("No recording selected.", "failure");
    return;
  }
  
  const tabId = await getActiveTabId();
  if (!tabId) {
    setStatus("No active tab.", "failure");
    return;
  }
  
  // Ask user to confirm
  const stepInfo = selectedRecording.steps[stepIndex];
  const confirm = window.confirm(
    `Re-record step ${stepIndex + 1} (${stepInfo.type})?\n\n` +
    `This will:\n` +
    `1. Replay steps 1-${stepIndex} to get to the correct state\n` +
    `2. Enable recording mode\n` +
    `3. Wait for you to perform the action\n` +
    `4. Replace step ${stepIndex + 1} with the new recording\n\n` +
    `Click OK to continue.`
  );
  
  if (!confirm) return;
  
  try {
    // Step 1: Replay up to (but not including) the step we want to re-record
    if (stepIndex > 0) {
      setStatus(`Replaying to step ${stepIndex}...`, "running");
      const stepsBeforeTarget = selectedRecording.steps.slice(0, stepIndex);
      const envId = els.envSelect.value;
      
      const replayResp = await chrome.runtime.sendMessage({
        type: "replay_start",
        envId,
        tabId,
        steps: stepsBeforeTarget,
        recordingId: selectedRecording.id
      });
      
      if (!replayResp?.ok) {
        throw new Error(replayResp?.error || "Failed to replay to target step");
      }
      
      // Wait a bit for page to settle
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Step 2: Clear current steps and start recording
    await chrome.runtime.sendMessage({ type: "clear_steps", tabId });
    const startResp = await chrome.runtime.sendMessage({ type: "recorder_start_for_tab", tabId });
    if (!startResp?.ok) {
      throw new Error("Failed to start recording");
    }
    
    state.isRecording = true;
    setUIMode('recording');
    renderRecordButton();
    
    setStatus(`Recording mode active - perform step ${stepIndex + 1} now`, "running");
    
    // Show instruction dialog
    alert(
      `Recording mode is now active!\n\n` +
      `Perform the action for step ${stepIndex + 1} (${stepInfo.type}), then:\n` +
      `1. Click "Stop recording" in the popup\n` +
      `2. The new step will replace step ${stepIndex + 1}\n\n` +
      `Note: The recording name will remain the same.`
    );
    
    // Store the context for when recording stops
    chrome.storage.local.set({
      reRecordContext: {
        recordingId: selectedRecording.id,
        stepIndex: stepIndex,
        recordingName: selectedRecording.name
      }
    });
    
  } catch (err) {
    console.error(err);
    setStatus(`Re-record failed: ${err.message}`, "failure");
  }
}

async function fixFailedStepAndContinue(failedStepIndex, failedReport) {
  const recordingId = els.recordingSelect.value;
  const selectedRecording = state.recordings.find((r) => r.id === recordingId);
  
  if (!selectedRecording) {
    setStatus("No recording selected.", "failure");
    return;
  }
  
  const tabId = await getActiveTabId();
  if (!tabId) {
    setStatus("No active tab.", "failure");
    return;
  }
  
  const stepInfo = selectedRecording.steps[failedStepIndex];
  const totalSteps = selectedRecording.steps.length;
  const remainingSteps = totalSteps - failedStepIndex - 1;
  
  const confirm = window.confirm(
    `Fix step ${failedStepIndex + 1} and continue?\n\n` +
    `Failed step: ${stepInfo.type}\n` +
    `Remaining steps: ${remainingSteps}\n\n` +
    `This will:\n` +
    `1. Enable recording for the failed step\n` +
    `2. Wait for you to perform the correct action\n` +
    `3. Update the recording with the new step\n` +
    `4. Continue replay from step ${failedStepIndex + 2}\n\n` +
    `The page is already at the correct state. Click OK to start recording.`
  );
  
  if (!confirm) return;
  
  try {
    // Step 1: Clear and start recording
    await chrome.runtime.sendMessage({ type: "clear_steps", tabId });
    const startResp = await chrome.runtime.sendMessage({ type: "recorder_start_for_tab", tabId });
    if (!startResp?.ok) {
      throw new Error("Failed to start recording");
    }
    
    state.isRecording = true;
    setUIMode('recording');
    renderRecordButton();
    
    setStatus(`Recording step ${failedStepIndex + 1} - perform action now`, "running");
    
    // Store context for automatic continuation
    chrome.storage.local.set({
      fixAndContinueContext: {
        recordingId: selectedRecording.id,
        stepIndex: failedStepIndex,
        recordingName: selectedRecording.name,
        remainingSteps: selectedRecording.steps.slice(failedStepIndex + 1),
        envId: els.envSelect.value
      }
    });
    
    // Show instruction
    alert(
      `Recording mode active!\n\n` +
      `Perform the action for step ${failedStepIndex + 1} (${stepInfo.type}), then:\n` +
      `1. Click "Stop recording"\n` +
      `2. Replay will automatically continue from step ${failedStepIndex + 2}\n\n` +
      `Total remaining: ${remainingSteps} steps`
    );
    
  } catch (err) {
    console.error(err);
    setStatus(`Fix & Continue failed: ${err.message}`, "failure");
  }
}

// ── Fix with AI ──────────────────────────────────────────────
async function fixWithAI(failedStepIndex, failedStep, failedReport) {
  const recordingId = els.recordingSelect.value;
  const selectedRecording = state.recordings.find((r) => r.id === recordingId);

  if (!selectedRecording) {
    setStatus("No recording selected.", "failure");
    return;
  }

  const tabId = await getActiveTabId();
  if (!tabId) {
    setStatus("No active tab.", "failure");
    return;
  }

  const totalSteps = selectedRecording.steps.length;
  const remainingCount = totalSteps - failedStepIndex - 1;

  setStatus(`AI is analyzing failed step ${failedStepIndex + 1}...`, "running");

  try {
    // Gather context about the failure
    const pageUrl = failedReport?.steps?.[failedStepIndex]?.url
      || failedReport?.url || '';

    // Build context: previous steps (for flow understanding) + failed step + error
    const contextSteps = selectedRecording.steps.slice(
      Math.max(0, failedStepIndex - 3), failedStepIndex + 1
    );

    const resp = await chrome.runtime.sendMessage({
      type: "ai_fix_step",
      tabId,
      failedStep: selectedRecording.steps[failedStepIndex],
      failedStepIndex,
      error: failedStep.error || {},
      selectorAttempts: failedStep.selectorAttempts || [],
      selectorHealing: failedStep.selectorHealing || null,
      notFoundTarget: failedStep.notFoundTarget || null,
      contextSteps,
      pageUrl,
      recordingName: selectedRecording.name,
    });

    if (!resp?.ok || !resp.fixedStep) {
      setStatus(`AI fix failed: ${resp?.error || 'No fix suggested'}`, "failure");
      return;
    }

    // Replace the failed step with the AI-fixed step
    const fixedStep = resp.fixedStep;
    selectedRecording.steps[failedStepIndex] = {
      ...selectedRecording.steps[failedStepIndex],
      ...fixedStep,
      meta: { ...selectedRecording.steps[failedStepIndex].meta, ...fixedStep.meta, aiFixed: true },
    };

    // Save updated recording
    const updateResp = await chrome.runtime.sendMessage({
      type: "update_recording",
      recordingId: selectedRecording.id,
      steps: selectedRecording.steps,
      name: selectedRecording.name,
    });

    if (!updateResp?.ok) {
      setStatus(`Failed to save AI fix: ${updateResp?.error || 'Unknown'}`, "failure");
      return;
    }

    setStatus(`AI fixed step ${failedStepIndex + 1}. Continuing replay...`, "success");

    // Brief pause then continue replay from the fixed step onward
    await new Promise(r => setTimeout(r, 500));

    const envId = els.envSelect.value;
    const stepsToReplay = selectedRecording.steps.slice(failedStepIndex);

    setUIMode('replaying');
    renderStepsInProgress(stepsToReplay);

    const continueResp = await chrome.runtime.sendMessage({
      type: "replay_start",
      envId,
      tabId,
      steps: stepsToReplay,
      skipNavigation: true,
      softAssertions: true,
    });

    if (continueResp?.ok) {
      setStatus(`Replay continued — AI fixed step ${failedStepIndex + 1}`, "success");
      await loadLastReport();
    } else {
      setStatus(`Replay failed after AI fix: ${continueResp?.error || 'Unknown'}`, "failure");
    }

    setUIMode('home');
    await loadRecordings();

  } catch (err) {
    console.error("[popup] Fix with AI error:", err);
    setStatus(`Fix with AI failed: ${err.message}`, "failure");
  }
}

els.replayBtn.addEventListener("click", () => startReplay({ requireDifferentEnv: false }));
els.stopReplayBtn.addEventListener("click", async () => {
  const confirmed = confirm("Are you sure you want to stop the current replay? This cannot be undone.");
  if (!confirmed) return;
  
  try {
    const tabId = await getActiveTabId();
    const response = await chrome.runtime.sendMessage({ type: 'replay_stop', tabId });
    
    if (response?.ok) {
      setStatus("Replay stopped by user.", "stopped");
      els.stopReplayBtn.style.display = 'none';
      els.replayBtn.disabled = false;
      if (els.replayPartialBtn) els.replayPartialBtn.disabled = false;
      setUIMode('home');
      
      // Refresh the steps display
      const report = await chrome.runtime.sendMessage({ type: "get_last_report", tabId });
      if (report?.ok && report.report) {
        renderSteps(report.report);
      }
    } else {
      setStatus("Failed to stop replay: " + (response?.error || "Unknown error"), "failure");
    }
  } catch (err) {
    console.error("Error stopping replay:", err);
    setStatus("Error stopping replay: " + err.message, "failure");
  }
});
// ─── Replay Controls Bar: Pause / Resume / Stop ──────────
els.pauseReplayBtn?.addEventListener("click", async () => {
  try {
    const tabId = await getActiveTabId();
    const response = await chrome.runtime.sendMessage({ type: 'replay_pause', tabId });
    if (response?.ok) {
      state.isPaused = true;
      els.pauseReplayBtn.style.display = 'none';
      els.resumeReplayBtn.style.display = 'inline-flex';
      setStatus("Replay paused", "paused");
    }
  } catch (err) {
    console.error("[popup] Failed to pause replay:", err);
  }
});

els.resumeReplayBtn?.addEventListener("click", async () => {
  try {
    const tabId = await getActiveTabId();
    const response = await chrome.runtime.sendMessage({ type: 'replay_resume', tabId });
    if (response?.ok) {
      state.isPaused = false;
      els.resumeReplayBtn.style.display = 'none';
      els.pauseReplayBtn.style.display = 'inline-flex';
      setStatus("Replay resumed", "running");
    }
  } catch (err) {
    console.error("[popup] Failed to resume replay:", err);
  }
});

els.stopReplayBtn2?.addEventListener("click", async () => {
  const confirmed = confirm("Stop the current replay?");
  if (!confirmed) return;
  try {
    const tabId = await getActiveTabId();
    const response = await chrome.runtime.sendMessage({ type: 'replay_stop', tabId });
    if (response?.ok) {
      setStatus("Replay stopped by user.", "stopped");
      setModeState('replaying', 'cancelled', 'Stopped');
      els.replayBtn.disabled = false;
      if (els.replayPartialBtn) els.replayPartialBtn.disabled = false;
      setUIMode('home');
      const report = await chrome.runtime.sendMessage({ type: "get_last_report", tabId });
      if (report?.ok && report.report) renderSteps(report.report);
    }
  } catch (err) {
    console.error("Error stopping replay:", err);
  }
});

// ─── Step Editor Logic ───────────────────────────────────
function toggleAttrField(type) {
  if (els.stepEditorAttrField) {
    els.stepEditorAttrField.style.display = type === 'assert_attr_equals' ? '' : 'none';
  }
  // Show soft assertion toggle only for assertion types
  if (els.stepEditorSoftField) {
    els.stepEditorSoftField.style.display = (type || '').startsWith('assert_') ? '' : 'none';
  }
}
if (els.stepEditorType) {
  els.stepEditorType.addEventListener('change', () => toggleAttrField(els.stepEditorType.value));
}

function openStepEditor(stepIndex) {
  const recordingId = els.recordingSelect.value;
  const selectedRecording = state.recordings.find((r) => r.id === recordingId);
  if (!selectedRecording || stepIndex < 0 || stepIndex >= selectedRecording.steps.length) return;
  
  const step = selectedRecording.steps[stepIndex];
  state.editingStepIndex = stepIndex;
  
  els.stepEditorIdx.textContent = `#${stepIndex + 1}`;
  els.stepEditorName.value = step.customName || getStepDisplayName(step);
  els.stepEditorType.value = step.type || 'click';
  els.stepEditorValue.value = step.value || '';
  els.stepEditorSelector.value = step.cssSelector || step.selector || step.xpath || '';
  if (els.stepEditorAttr) els.stepEditorAttr.value = step.meta?.attr || '';
  if (els.stepEditorTimeout) els.stepEditorTimeout.value = step.meta?.timeout || '';
  if (els.stepEditorSoft) els.stepEditorSoft.checked = !!step.meta?.soft;
  toggleAttrField(step.type);
  
  // Show soft assertion toggle for assertion types
  const isAssertType = (step.type || '').startsWith('assert_');
  if (els.stepEditorSoftField) els.stepEditorSoftField.style.display = isAssertType ? '' : 'none';
  
  els.stepEditorPanel.style.display = 'block';
  els.stepEditorPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  els.stepEditorName.focus();
}

function closeStepEditor() {
  els.stepEditorPanel.style.display = 'none';
  state.editingStepIndex = -1;
}

async function saveStepEdit() {
  const recordingId = els.recordingSelect.value;
  const selectedRecording = state.recordings.find((r) => r.id === recordingId);
  if (!selectedRecording || state.editingStepIndex < 0) return;
  
  const step = selectedRecording.steps[state.editingStepIndex];
  const newName = els.stepEditorName.value.trim();
  const newType = els.stepEditorType.value;
  const newValue = els.stepEditorValue.value;
  const newSelector = els.stepEditorSelector.value.trim();
  
  // Apply edits
  if (newName && newName !== getStepDisplayName(step)) step.customName = newName;
  step.type = newType;
  step.value = newValue;
  // Save attribute for assert_attr_equals
  if (newType === 'assert_attr_equals') {
    step.meta = step.meta || {};
    step.meta.attr = els.stepEditorAttr?.value?.trim() || '';
  }
  // Save custom timeout
  step.meta = step.meta || {};
  const timeoutVal = parseInt(els.stepEditorTimeout?.value, 10);
  if (timeoutVal > 0) {
    step.meta.timeout = timeoutVal;
  } else {
    delete step.meta.timeout;
  }
  // Save soft assertion flag
  if (newType.startsWith('assert_')) {
    step.meta.soft = !!els.stepEditorSoft?.checked;
  }
  if (newSelector) {
    if (newSelector.startsWith('/') || newSelector.startsWith('(')) {
      step.xpath = newSelector;
    } else {
      step.cssSelector = newSelector;
    }
  }
  
  // Persist
  await store.update("recordings", (recordings) => {
    const recs = recordings || [];
    const rec = recs.find(r => r.id === recordingId);
    if (rec) rec.steps[state.editingStepIndex] = step;
    return recs;
  });
  
  setStatus(`Step ${state.editingStepIndex + 1} updated`, "idle");
  closeStepEditor();
  await loadRecordings();
  const r = state.recordings.find((r) => r.id === recordingId);
  if (r) renderStepsFromRecorded(r.steps);
}

async function deleteStep() {
  const recordingId = els.recordingSelect.value;
  const selectedRecording = state.recordings.find((r) => r.id === recordingId);
  if (!selectedRecording || state.editingStepIndex < 0) return;
  
  const confirmed = confirm(`Delete step ${state.editingStepIndex + 1}?`);
  if (!confirmed) return;
  
  selectedRecording.steps.splice(state.editingStepIndex, 1);
  
  await store.update("recordings", (recordings) => {
    const recs = recordings || [];
    const rec = recs.find(r => r.id === recordingId);
    if (rec) rec.steps = selectedRecording.steps;
    return recs;
  });
  
  setStatus(`Step deleted`, "idle");
  closeStepEditor();
  await loadRecordings();
  const r = state.recordings.find((r) => r.id === recordingId);
  if (r) renderStepsFromRecorded(r.steps);
}

els.stepEditorSave?.addEventListener("click", () => saveStepEdit());
els.stepEditorDelete?.addEventListener("click", () => deleteStep());
els.stepEditorCancel?.addEventListener("click", () => closeStepEditor());
els.stepEditorClose?.addEventListener("click", () => closeStepEditor());

// ============================================================
// Add Assertion Step
// ============================================================
els.addAssertionBtn?.addEventListener("click", async () => {
  const recordingId = els.recordingSelect.value;
  const selectedRecording = state.recordings.find((r) => r.id === recordingId);
  if (!selectedRecording) {
    setStatus("Select a recording first.", "failure");
    return;
  }
  // Open the step editor in "add" mode with an assertion type pre-selected
  const newStep = {
    id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    type: "assert_exists",
    timestamp: Date.now(),
    relativePath: "",
    queryParams: {},
    selector: null,
    value: "",
    meta: {},
    customName: "New Assertion"
  };
  // Insert after the currently selected step, or at the end if none selected
  const insertAfter = (state.editingStepIndex >= 0 && state.editingStepIndex < selectedRecording.steps.length)
    ? state.editingStepIndex
    : selectedRecording.steps.length - 1;
  const insertAt = insertAfter + 1;
  selectedRecording.steps.splice(insertAt, 0, newStep);

  await store.update("recordings", (recordings) => {
    const recs = recordings || [];
    const rec = recs.find(r => r.id === recordingId);
    if (rec) rec.steps = selectedRecording.steps;
    return recs;
  });
  await loadRecordings();
  const r = state.recordings.find((r) => r.id === recordingId);
  if (r) renderStepsFromRecorded(r.steps);
  // Open editor on the new step
  openStepEditor(insertAt);
  setStatus(`Assertion added after step ${insertAfter + 1} — configure it below.`, "idle");
});

// ============================================================
// Export to Playwright
// ============================================================
els.exportPlaywrightBtn?.addEventListener("click", async () => {
  const recordingId = els.recordingSelect.value;
  if (!recordingId) {
    setStatus("Select a recording first.", "failure");
    return;
  }
  setStatus("Generating Playwright script...", "running");
  try {
    const resp = await chrome.runtime.sendMessage({ type: "export_recording_playwright", recordingId });
    if (!resp?.ok) {
      setStatus(resp?.error || "Export failed.", "failure");
      return;
    }
    // Download the script as a .spec.js file
    const blob = new Blob([resp.output], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const rec = state.recordings.find(r => r.id === recordingId);
    const safeName = (rec?.name || "test").replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
    a.download = `${safeName}.spec.js`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus("Playwright script exported!", "success");
  } catch (err) {
    setStatus("Export error: " + err.message, "failure");
  }
});

// ============================================================
// View HTML Report
// ============================================================
els.viewReportBtn?.addEventListener("click", async () => {
  if (!state.lastReport) {
    setStatus("No report available. Run a replay first.", "failure");
    return;
  }
  setStatus("Generating report...", "running");
  try {
    const resp = await chrome.runtime.sendMessage({ type: "generate_html_report", report: state.lastReport });
    if (!resp?.ok) {
      setStatus(resp?.error || "Report generation failed.", "failure");
      return;
    }
    // Open report in a new tab
    const blob = new Blob([resp.html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
    setStatus("Report opened in new tab.", "success");
  } catch (err) {
    setStatus("Report error: " + err.message, "failure");
  }
});

// ============================================================
// Run All Recordings
// ============================================================
els.runAllBtn?.addEventListener("click", async () => {
  if (!state.recordings || state.recordings.length === 0) {
    setStatus("No recordings to run.", "failure");
    return;
  }
  const envId = els.envSelect?.value;
  if (!envId) {
    setStatus("Select an environment first.", "failure");
    return;
  }
  const tabId = await getActiveTabId();
  if (!tabId) {
    setStatus("No active tab to replay on.", "failure");
    return;
  }

  setStatus("Running all recordings sequentially...", "running");
  const results = [];
  for (const rec of state.recordings) {
    if (!rec.steps || rec.steps.length === 0) continue;
    try {
      setStatus(`Running: ${rec.name}...`, "running");
      const resp = await chrome.runtime.sendMessage({
        type: "replay_start",
        envId,
        tabId,
        steps: rec.steps,
        recordingId: rec.id,
        retryCount: 0
      });
      results.push({ name: rec.name, ok: resp?.ok, error: resp?.error });
    } catch (err) {
      results.push({ name: rec.name, ok: false, error: err.message });
    }
  }
  const passedCount = results.filter(r => r.ok).length;
  const failedCount = results.filter(r => !r.ok).length;
  setStatus(`Suite: ${passedCount} passed, ${failedCount} failed out of ${results.length}`, passedCount === results.length ? "success" : "failure");
});

// ============================================================
// Save Storage State
// ============================================================
els.saveStorageStateBtn?.addEventListener("click", async () => {
  setStatus("Saving auth/session state...", "running");
  try {
    const resp = await chrome.runtime.sendMessage({ type: "save_storage_state" });
    if (resp?.ok) {
      setStatus(`State saved! (${resp.cookieCount} cookies, ${resp.storageKeyCount} storage keys)`, "success");
    } else {
      setStatus(resp?.error || "Failed to save state.", "failure");
    }
  } catch (err) {
    setStatus("Error: " + err.message, "failure");
  }
});

// ============================================================
// Playwright Runner
// ============================================================

els.playwrightPanelClose?.addEventListener("click", () => {
  setUIMode('home');
});

// Helper: fetch a screenshot URL and return a base64 data URL, or null on failure
async function _pwFetchScreenshotBase64(url) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const blob = await resp.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  } catch { return null; }
}

function _escHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Generate a rich HTML report matching the normal replay report style with embedded screenshots
async function _pwGenerateHtmlReport(reportData) {
  const { title, timestamp, recording, summary, results, runnerUrl, steps: recordingSteps } = reportData;

  // Pre-fetch all screenshots as base64 so the HTML is self-contained
  const screenshotCache = {};
  const fetchPromises = [];
  for (const r of results) {
    for (const s of (r.report.steps || [])) {
      if (s.screenshot && runnerUrl) {
        const url = `${runnerUrl}/screenshot/${r.report.run_id}/${s.screenshot}`;
        fetchPromises.push(
          _pwFetchScreenshotBase64(url).then((data) => { if (data) screenshotCache[url] = data; })
        );
      }
    }
  }
  await Promise.all(fetchPromises);

  const comboSections = results.map((r) => {
    const passed = r.report.status === "passed";
    const statusColor = passed ? "#2ecc71" : "#e74c3c";
    const statusText = passed ? "PASSED" : "FAILED";
    const duration = r.report.duration_ms ? `${(r.report.duration_ms / 1000).toFixed(1)}s` : "—";

    const stepCards = (r.report.steps || []).map((s) => {
      const sColor = s.status === "passed" ? "#2ecc71" : s.status === "failed" ? "#e74c3c" : s.status === "soft_fail" ? "#f0ad4e" : "#8891a5";
      const sIcon = s.status === "passed" ? "&#10003;" : s.status === "failed" ? "&#10007;" : s.status === "soft_fail" ? "&#9888;" : "&#8212;";
      const sStatusText = (s.status || "unknown").toUpperCase();

      // Get original step details if available
      const origStep = recordingSteps ? recordingSteps[s.index] || {} : {};
      const stepName = _escHtml(origStep.customName || origStep.elementName || origStep.nlDescription || s.type || "action");
      const stepType = _escHtml(s.type || origStep.type || "action");

      // Screenshot
      let screenshotHtml = "";
      if (s.screenshot && runnerUrl) {
        const url = `${runnerUrl}/screenshot/${r.report.run_id}/${s.screenshot}`;
        const dataUrl = screenshotCache[url];
        if (dataUrl) {
          screenshotHtml = `<img src="${dataUrl}" alt="Step ${s.index + 1} screenshot" onclick="openModal(this.src)" />`;
        }
      }

      // Step info details
      let infoHtml = `<div><strong>Type:</strong> ${stepType}</div>`;
      infoHtml += `<div><strong>Status:</strong> <span style="color:${sColor};font-weight:600;">${sIcon} ${sStatusText}</span></div>`;
      infoHtml += `<div><strong>Duration:</strong> ${s.duration_ms}ms</div>`;
      if (origStep.elementName) infoHtml += `<div><strong>Element:</strong> ${_escHtml(origStep.elementName)}</div>`;
      if (origStep.selector) {
        const selStr = typeof origStep.selector === "string" ? origStep.selector : JSON.stringify(origStep.selector);
        infoHtml += `<div><strong>Selector:</strong> <code>${_escHtml(selStr)}</code></div>`;
      }
      if (origStep.value) infoHtml += `<div><strong>Value:</strong> ${_escHtml(String(origStep.value).substring(0, 200))}</div>`;
      if (origStep.url) infoHtml += `<div><strong>URL:</strong> ${_escHtml(origStep.url)}</div>`;
      if (s.error) infoHtml += `<div><strong>Error:</strong> <span style="color:#e74c3c;">${_escHtml(s.error)}</span></div>`;

      return `
      <div class="screenshot">
        <h3>Step ${s.index + 1}: ${stepName}</h3>
        ${screenshotHtml}
        <div class="step-info">${infoHtml}</div>
      </div>`;
    }).join("");

    // Console errors section
    const consoleHtml = (r.report.console_errors && r.report.console_errors.length)
      ? `<div class="screenshot">
          <h3>Console Errors (${r.report.console_errors.length})</h3>
          <div class="step-info" style="font-family:monospace;font-size:11px;">
            ${r.report.console_errors.map((e) => `<div style="margin-bottom:4px;color:#e74c3c;">${_escHtml(e)}</div>`).join("")}
          </div>
        </div>`
      : "";

    return `
    <div class="combo-section">
      <div class="combo-header">
        <h2>${_escHtml(r.browser)} / ${_escHtml(r.device)}</h2>
        <div class="status-banner" style="background:${statusColor}22;color:${statusColor};border:1px solid ${statusColor}44">${statusText}</div>
      </div>
      <div class="summary">
        <div class="summary-card"><div class="value">${(r.report.steps || []).length}</div><div class="label">Total</div></div>
        <div class="summary-card"><div class="value" style="color:#2ecc71">${r.report.passed}</div><div class="label">Passed</div></div>
        <div class="summary-card"><div class="value" style="color:#e74c3c">${r.report.failed}</div><div class="label">Failed</div></div>
        <div class="summary-card"><div class="value" style="color:#8891a5">${r.report.skipped}</div><div class="label">Skipped</div></div>
        <div class="summary-card"><div class="value">${duration}</div><div class="label">Duration</div></div>
      </div>
      ${stepCards}
      ${consoleHtml}
    </div>`;
  }).join("<hr style='border:none;border-top:2px solid #eee;margin:30px 0;'>");

  const overallSummary = summary
    ? `<div class="summary" style="margin-bottom:24px;">
        <div class="summary-card"><div class="value">${summary.total}</div><div class="label">Combos</div></div>
        <div class="summary-card"><div class="value" style="color:#2ecc71">${summary.passed}</div><div class="label">Passed</div></div>
        <div class="summary-card"><div class="value" style="color:#e74c3c">${summary.failed}</div><div class="label">Failed</div></div>
        <div class="summary-card"><div class="value">${(summary.duration_ms / 1000).toFixed(1)}s</div><div class="label">Total Time</div></div>
      </div>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${_escHtml(title)}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;padding:20px;background:#f5f5f5;color:#333;line-height:1.5}
  h1{font-size:22px;font-weight:800;margin-bottom:4px}
  h2{font-size:18px;font-weight:700;margin-bottom:8px}
  .metadata{color:#666;font-size:13px;margin-bottom:20px}
  .metadata div{margin:3px 0}
  .summary{display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap}
  .summary-card{padding:12px 18px;border-radius:8px;background:#fff;border:1px solid rgba(0,0,0,0.08);min-width:80px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.05)}
  .summary-card .value{font-size:24px;font-weight:800}
  .summary-card .label{font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:#888;margin-top:2px}
  .status-banner{padding:8px 16px;border-radius:6px;font-weight:800;font-size:14px;text-align:center;letter-spacing:0.5px;display:inline-block;margin-bottom:12px}
  .combo-section{margin-bottom:30px}
  .combo-header{margin-bottom:16px}
  .screenshot{background:#fff;padding:15px;margin-bottom:16px;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.08);page-break-inside:avoid}
  .screenshot h3{margin:0 0 10px 0;color:#444;font-size:15px}
  .screenshot img{width:100%;border:1px solid #ddd;border-radius:4px;cursor:pointer;margin-bottom:10px}
  .screenshot img:hover{opacity:0.9}
  .step-info{padding:10px;background:#f9f9f9;border-radius:4px;font-size:13px}
  .step-info div{margin:3px 0}
  .step-info code{background:#eee;padding:1px 4px;border-radius:3px;font-size:11px;word-break:break-all}
  .header{background:#fff;padding:20px;margin-bottom:20px;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.08)}
  .modal{display:none;position:fixed;z-index:1000;left:0;top:0;width:100%;height:100%;background-color:rgba(0,0,0,0.9)}
  .modal.active{display:flex;align-items:center;justify-content:center}
  .modal img{max-width:95%;max-height:95%;object-fit:contain}
  .modal-close{position:absolute;top:20px;right:35px;color:#f1f1f1;font-size:40px;font-weight:bold;cursor:pointer}
  .modal-close:hover{color:#bbb}
  @media print{body{background:#fff;padding:10px}.screenshot{page-break-after:always;box-shadow:none;border:1px solid #eee}}
</style>
</head>
<body>
<div class="header">
  <h1>${_escHtml(title)}</h1>
  <div class="metadata">
    <div><strong>Recording:</strong> ${_escHtml(recording)}</div>
    <div><strong>Generated:</strong> ${timestamp}</div>
  </div>
  ${overallSummary}
</div>
${comboSections}
<div style="margin-top:30px;text-align:center;font-size:11px;color:#bbb;">Generated by Autotest Playwright Runner</div>

<div id="imageModal" class="modal" onclick="closeModal()">
  <span class="modal-close">&times;</span>
  <img id="modalImg" src="" alt="Full screen screenshot">
</div>
<script>
  function openModal(src){var m=document.getElementById('imageModal'),i=document.getElementById('modalImg');m.classList.add('active');i.src=src;}
  function closeModal(){document.getElementById('imageModal').classList.remove('active');}
  document.addEventListener('keydown',function(e){if(e.key==='Escape')closeModal();});
</script>
</body>
</html>`;
}

async function _pwDownloadHtmlReport(reportData, filename) {
  const html = await _pwGenerateHtmlReport(reportData);
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Stores last run results for report download buttons
let _pwLastResults = null;

els.pwRunBtn?.addEventListener("click", async () => {
  const recordingId = els.recordingSelect.value;
  const selectedRecording = state.recordings.find((r) => r.id === recordingId);
  if (!selectedRecording || !selectedRecording.steps.length) {
    els.pwStatus.textContent = "Select a recording with steps first.";
    els.pwStatus.style.color = "var(--red)";
    return;
  }

  // Collect selected browsers and devices
  const selectedBrowsers = [...(els.pwBrowserGroup?.querySelectorAll("input:checked") || [])]
    .map((cb) => cb.value)
    .filter(Boolean);
  const selectedDevices = [...(els.pwDeviceGroup?.querySelectorAll("input:checked") || [])]
    .map((cb) => cb.value); // "" = Desktop

  if (!selectedBrowsers.length) {
    els.pwStatus.textContent = "Select at least one browser.";
    els.pwStatus.style.color = "var(--red)";
    return;
  }
  if (!selectedDevices.length) {
    els.pwStatus.textContent = "Select at least one device.";
    els.pwStatus.style.color = "var(--red)";
    return;
  }

  // Build combos: browser × device
  const combos = [];
  for (const browser of selectedBrowsers) {
    for (const device of selectedDevices) {
      combos.push({ browser, device: device || null });
    }
  }

  // Build shared config from UI
  const selectedEnv = state.envs.find((e) => e.id === els.envSelect.value) || state.envs.find((e) => e.isDefault) || state.envs[0];
  const baseURL = selectedEnv?.baseUrl || "";

  const sharedConfig = {
    baseURL,
    trace: els.pwTrace?.checked || false,
    video: els.pwVideo?.checked || false,
    har: els.pwHAR?.checked || false,
    screenshots: els.pwScreenshots?.checked !== false,
  };

  // Advanced options
  if (els.pwTimezone?.value) sharedConfig.timezoneId = els.pwTimezone.value;
  if (els.pwLocale?.value) sharedConfig.locale = els.pwLocale.value;
  if (els.pwGeoLat?.value && els.pwGeoLon?.value) {
    sharedConfig.geolocation = {
      latitude: parseFloat(els.pwGeoLat.value),
      longitude: parseFloat(els.pwGeoLon.value),
    };
    sharedConfig.permissions = ["geolocation"];
  }

  // Network mocks (manual JSON + optional captured responses merged)
  let networkMocks = null;
  if (els.pwNetworkMocks?.value?.trim()) {
    try {
      networkMocks = JSON.parse(els.pwNetworkMocks.value);
    } catch (e) {
      els.pwStatus.textContent = "Invalid network mocks JSON: " + e.message;
      els.pwStatus.style.color = "var(--red)";
      return;
    }
  }
  // Merge captured mocks if checkbox is enabled
  if (els.pwUseCapturedMocks?.checked && selectedRecording?.capturedResponses?.length) {
    const capturedAsMocks = selectedRecording.capturedResponses.map(r => ({
      url: r.url,
      method: r.method || undefined,
      response: { status: r.status, body: r.body, headers: r.headers }
    }));
    networkMocks = [...(networkMocks || []), ...capturedAsMocks];
  }

  // Block patterns from UI (only when toggle is enabled)
  let blockPatterns = null;
  if (els.blockPatternsEnabled?.checked) {
    const patterns = parseNFPatterns(els.blockPatternsInput?.value || '');
    if (patterns.length) blockPatterns = patterns;
  }

  // Get runner URL for live stream + artifact links
  let runnerUrl = "";
  try {
    const rc = await chrome.storage.local.get(["runnerConfig"]);
    const bc = await chrome.storage.local.get(["backendConfig"]);
    runnerUrl = ((bc.backendConfig?.url || "http://localhost:8000") + "/runner").replace(/\/+$/, "");
  } catch (_) {}

  const liveFeedEnabled = els.pwLiveFeed?.checked && runnerUrl;
  const runId = crypto.randomUUID(); // used for live feed on first combo

  const totalSteps = selectedRecording.steps?.length || 0;
  const comboLabel = combos.map((c) => `${c.browser}/${c.device || "Desktop"}`).join(", ");
  const liveTag = liveFeedEnabled ? " | Live remote feed" : "";
  els.pwStatus.textContent = combos.length === 1
    ? `Running on ${comboLabel}${liveTag} — 0/${totalSteps} steps...`
    : `Running ${combos.length} combos: ${comboLabel}${liveTag} — 0/${totalSteps} steps...`;
  els.pwStatus.style.color = "var(--blue)";
  els.pwRunBtn.disabled = true;
  setModeState('headless', 'running', 'Running...');
  if (els.pwStopBtn) els.pwStopBtn.style.display = 'inline-flex';
  els.pwResults.style.display = "none";
  setUIMode('headless');
  updateModeHeader('Headless run...', 'running');

  // Open live SSE screencast stream for the first combo
  let evtSource = null;
  if (liveFeedEnabled) {
    evtSource = new EventSource(`${runnerUrl}/live/${runId}`);
    evtSource.onmessage = (e) => {
      if (els.pwLiveFrame) els.pwLiveFrame.src = `data:image/jpeg;base64,${e.data}`;
      if (els.pwLiveView) els.pwLiveView.style.display = "block";
    };
    evtSource.onerror = () => evtSource.close();
  }

  // Poll step progress from runner (via service worker to avoid CORS/popup fetch issues)
  let progressPollId = null;
  if (runnerUrl) {
    progressPollId = setInterval(async () => {
      try {
        const data = await chrome.runtime.sendMessage({ type: "pw_get_progress", runId });
        if (data?.ok) {
          const { completed, total, passed, failed, current_type, done } = data;
          const skipped = completed - passed - failed;
          const pending = total - completed;
          const stepInfo = current_type ? ` — ${current_type}` : "";
          const failInfo = failed > 0 ? `, ${failed} failed` : "";
          const skippedInfo = skipped > 0 ? `, ${skipped} skipped` : "";
          const pendingInfo = pending > 0 ? `, ${pending} pending` : "";
          const isDone = done || completed >= total;
          const baseLabel = combos.length === 1
            ? (isDone ? `Completed on ${comboLabel}` : `Running on ${comboLabel}`)
            : (isDone ? `Completed ${combos.length} combos: ${comboLabel}` : `Running ${combos.length} combos: ${comboLabel}`);
          els.pwStatus.textContent = `${baseLabel}${isDone ? "" : liveTag} — ${completed}/${total} steps (${passed} passed${failInfo}${skippedInfo}${pendingInfo})${stepInfo}`;
          updateModeHeader(isDone ? 'Completing...' : 'Headless run...', 'running', `${completed}/${total}`);
          setModeState('headless', 'running', `${completed}/${total} steps — ${passed} passed${failInfo}`);
          if (isDone) clearInterval(progressPollId);
        }
      } catch (_) {}
    }, 800);
  }

  try {
    let allResults = [];

    if (combos.length === 1) {
      // Single combo — use /run endpoint directly
      const config = { ...sharedConfig, browser: combos[0].browser, device: combos[0].device, runId };
      const resp = await chrome.runtime.sendMessage({
        type: "playwright_run",
        steps: selectedRecording.steps,
        config,
        networkMocks,
        blockPatterns,
      });
      if (!resp?.ok) throw new Error(resp?.error || "Playwright run failed");
      allResults.push({
        combo: combos[0],
        report: resp.report,
        artifacts: resp.artifacts || {},
      });
    } else {
      // Multiple combos — use /run-parallel via new message type
      const resp = await chrome.runtime.sendMessage({
        type: "playwright_run_multi",
        steps: selectedRecording.steps,
        combos,
        sharedConfig,
        networkMocks,
        blockPatterns,
        runId: liveFeedEnabled ? runId : null, // live feed for first combo
      });
      if (!resp?.ok) throw new Error(resp?.error || "Parallel Playwright run failed");
      allResults = resp.results.map((r, i) => ({
        combo: combos[i],
        report: r.report,
        artifacts: r.artifacts || {},
      }));
    }

    // Summarize results
    const passedCount = allResults.filter((r) => r.report.status === "passed").length;
    const failedCount = allResults.length - passedCount;
    const allPassed = failedCount === 0;
    // Combos run in parallel — use wall-clock max, not sum of all durations
    const totalMs = Math.max(...allResults.map(r => r.report.duration_ms || 0));

    els.pwStatus.textContent = allPassed
      ? `All ${allResults.length} combo(s) passed (${totalMs}ms total)`
      : `${passedCount} passed, ${failedCount} failed (${totalMs}ms total)`;
    els.pwStatus.style.color = allPassed ? "var(--green)" : "var(--red)";

    // Store results for download buttons
    _pwLastResults = allResults;
    const recordingName = selectedRecording.name || selectedRecording.id || "test";
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

    // Render results for each combo
    let resultsHtml = "";

    // Download Full Report button (always shown, useful for single or multi)
    resultsHtml += `<div class="pw-report-actions">`;
    resultsHtml += `<button class="pw-report-btn" data-action="download-full" title="Download complete report (all combos)">Download Full Report</button>`;
    resultsHtml += `</div>`;

    for (let ci = 0; ci < allResults.length; ci++) {
      const { combo, report, artifacts } = allResults[ci];
      const isPassed = report.status === "passed";
      const comboName = `${combo.browser} / ${combo.device || "Desktop"}`;
      resultsHtml += `
        <div class="pw-results-card pw-results-card--${isPassed ? 'passed' : 'failed'}">
          <div class="pw-results-header">
            <span>${isPassed ? 'PASSED' : 'FAILED'} — ${comboName}</span>
            <span style="font-weight:400;font-size:10px;color:var(--muted);">${report.duration_ms}ms</span>
          </div>
          <div class="pw-results-stats">
            <span style="color:var(--green);">${report.passed} passed</span>
            <span style="color:var(--red);">${report.failed} failed</span>
            <span>${report.skipped} skipped</span>
          </div>`;

      // Artifact links + per-combo download
      const links = [];
      links.push(`<a class="pw-artifact-link pw-report-btn-inline" href="#" data-action="download-combo" data-idx="${ci}" title="Download report for this combo">Report</a>`);
      if (artifacts.traceUrl) {
        links.push(`<a class="pw-artifact-link" href="${runnerUrl}${artifacts.traceUrl}" target="_blank" title="Download trace">Trace</a>`);
      }
      if (artifacts.videoUrl) {
        links.push(`<a class="pw-artifact-link" href="${runnerUrl}${artifacts.videoUrl}" target="_blank">Video</a>`);
      }
      if (artifacts.harUrl) {
        links.push(`<a class="pw-artifact-link" href="${runnerUrl}${artifacts.harUrl}" target="_blank">HAR</a>`);
      }
      resultsHtml += `<div class="pw-artifacts">${links.join("")}</div>`;

      // Per-step results
      if (report.steps && report.steps.length) {
        resultsHtml += `<div class="pw-step-results">`;
        for (const s of report.steps) {
          const statusIcon = s.status === "passed" ? "✓" : s.status === "failed" ? "✗" : s.status === "soft_fail" ? "⚠" : "—";
          const statusClass = s.status === "passed" ? "pw-step--passed" : s.status === "failed" ? "pw-step--failed" : s.status === "soft_fail" ? "pw-step--warn" : "pw-step--skip";
          resultsHtml += `<div class="pw-step-row ${statusClass}">
            <span class="pw-step-icon">${statusIcon}</span>
            <span class="pw-step-idx">${s.index + 1}</span>
            <span class="pw-step-type">${s.type}</span>
            <span class="pw-step-dur">${s.duration_ms}ms</span>`;
          if (s.screenshot) {
            resultsHtml += `<a class="pw-step-ss" href="${runnerUrl}/screenshot/${report.run_id}/${s.screenshot}" target="_blank" title="View screenshot">📷</a>`;
          }
          resultsHtml += `</div>`;
          if (s.error) {
            resultsHtml += `<div class="pw-step-error">${s.error}</div>`;
          }
        }
        resultsHtml += `</div>`;
      }

      // Screenshot gallery
      if (artifacts.screenshots && artifacts.screenshots.length) {
        resultsHtml += `<div class="pw-screenshots-section">
          <div class="pw-screenshots-label">Screenshots (${artifacts.screenshots.length})</div>
          <div class="pw-screenshots-grid">`;
        for (const ssUrl of artifacts.screenshots) {
          const fullUrl = `${runnerUrl}${ssUrl}`;
          resultsHtml += `<a class="pw-ss-thumb" href="${fullUrl}" target="_blank"><img src="${fullUrl}" loading="lazy" /></a>`;
        }
        resultsHtml += `</div></div>`;
      }

      // Console errors
      if (report.console_errors && report.console_errors.length) {
        resultsHtml += `<div class="pw-console-errors">
          <div class="pw-screenshots-label">Console Errors (${report.console_errors.length})</div>`;
        for (const err of report.console_errors) {
          resultsHtml += `<div class="pw-console-error-line">${err}</div>`;
        }
        resultsHtml += `</div>`;
      }

      resultsHtml += `</div>`;
    }

    els.pwResults.innerHTML = resultsHtml;
    els.pwResults.style.display = "block";

    // Wire up download buttons via event delegation
    const _recSteps = selectedRecording.steps;
    const _runnerUrl = runnerUrl;
    els.pwResults.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        if (!_pwLastResults) return;
        btn.disabled = true;
        btn.style.opacity = "0.5";
        const origText = btn.textContent;
        btn.textContent = "Generating...";
        try {
          const action = btn.dataset.action;
          const ts = new Date().toLocaleString();
          if (action === "download-full") {
            await _pwDownloadHtmlReport({
              title: "Playwright Test Report",
              timestamp: ts,
              recording: recordingName,
              runnerUrl: _runnerUrl,
              steps: _recSteps,
              summary: { total: _pwLastResults.length, passed: passedCount, failed: failedCount, duration_ms: totalMs },
              results: _pwLastResults.map((r) => ({
                browser: r.combo.browser,
                device: r.combo.device || "Desktop",
                report: r.report,
              })),
            }, `report-${recordingName}-${timestamp}.html`);
          } else if (action === "download-combo") {
            const idx = parseInt(btn.dataset.idx, 10);
            const r = _pwLastResults[idx];
            if (!r) return;
            const comboName = `${r.combo.browser} / ${r.combo.device || "Desktop"}`;
            await _pwDownloadHtmlReport({
              title: `Playwright Test Report — ${comboName}`,
              timestamp: ts,
              recording: recordingName,
              runnerUrl: _runnerUrl,
              steps: _recSteps,
              results: [{
                browser: r.combo.browser,
                device: r.combo.device || "Desktop",
                report: r.report,
              }],
            }, `report-${recordingName}-${r.combo.browser}-${(r.combo.device || "Desktop").replace(/\s+/g, "_")}-${timestamp}.html`);
          }
        } finally {
          btn.disabled = false;
          btn.style.opacity = "";
          btn.textContent = origText;
        }
      });
    });

    requestAnimationFrame(() => els.pwResults.scrollIntoView({ behavior: "smooth", block: "start" }));

    // Show completion card
    showCompletion(
      allPassed ? '✓' : '✗',
      allPassed ? `All ${allResults.length} combo(s) passed` : `${passedCount} passed, ${failedCount} failed`,
      `${totalMs}ms total`,
      { resultStatus: allPassed ? 'success' : 'failed', modeKey: 'headless' }
    );

  } catch (err) {
    els.pwStatus.textContent = err.message;
    els.pwStatus.style.color = "var(--red)";
    // Render error details into pwResults so they're visible in completed mode
    els.pwResults.innerHTML = `
      <div class="pw-results-card pw-results-card--failed" style="margin-top:4px;">
        <div class="pw-results-header"><span>FAILED</span></div>
        <div class="pw-step-error" style="padding:6px 8px;">${err.message}</div>
      </div>`;
    els.pwResults.style.display = 'block';
    showCompletion('✗', 'Headless run failed', err.message, { resultStatus: 'failed', modeKey: 'headless' });
  } finally {
    els.pwRunBtn.disabled = false;
    if (els.pwStopBtn) els.pwStopBtn.style.display = 'none';
    if (evtSource) evtSource.close();
    if (progressPollId) clearInterval(progressPollId);
    if (els.pwLiveView) els.pwLiveView.style.display = "none";
  }
});

els.replayPartialBtn?.addEventListener("click", async () => {
  const recordingId = els.recordingSelect.value;
  const selectedRecording = state.recordings.find((r) => r.id === recordingId);
  if (!selectedRecording || !selectedRecording.steps.length) {
    setStatus("No recording selected or no steps.", "failure");
    return;
  }
  const stepNum = window.prompt(`Replay up to which step? (1-${selectedRecording.steps.length}):`, String(selectedRecording.steps.length));
  if (stepNum) {
    const num = parseInt(stepNum, 10);
    if (num >= 1 && num <= selectedRecording.steps.length) {
      await startPartialReplay(num);
    } else {
      setStatus(`Invalid step number. Enter 1-${selectedRecording.steps.length}.`, "failure");
    }
  }
});
els.recordBtn.addEventListener("click", () => toggleRecording());

// Assert mode toggle (visible during recording)
if (els.assertModeBtn) {
  els.assertModeBtn.addEventListener("click", () => toggleAssertMode());
}

// Listen for auto-off signal from content script (one-shot assert mode)
chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
  if (message?.type === 'assert_mode_auto_off' && state.isAssertMode) {
    state.isAssertMode = false;
    renderAssertModeButton();
    _stopAssertPoll();
    if (state.isRecording) {
      setStatus('Recording...', 'running');
      refreshRecordedSteps(); // Refresh to show the newly added assertion
    }
  }

  return false; // This listener never sends a response
});

// Persist environment selection when changed
els.envSelect.addEventListener("change", () => {
  const envId = els.envSelect.value;
  if (envId) {
    state.lastReplayEnvId = envId;
    chrome.storage.local.set({ lastReplayEnvId: envId });
  }
});

els.openOptions.addEventListener("click", async () => {
  await chrome.runtime.openOptionsPage();
});

// ============================================================
// Home Grid — 4 main action buttons
// Clicking an active button resumes that mode's view
// ============================================================
els.homeRecordBtn?.addEventListener("click", () => {
  if (_modeState.recording.status === 'running') {
    setUIMode('recording');
    return;
  }
  toggleRecording();
});

els.homeGenerateBtn?.addEventListener("click", () => {
  setUIMode('generate');
  if (_modeState.generating.status === 'running') {
    setAIPhase(aiState.phase || 'generating');
  } else if (aiState.currentSpecCode) {
    setAIPhase('generated');
  } else {
    setAIPhase('idle');
  }
  els.aiPromptInput?.focus();
});

els.homeReplayBtn?.addEventListener("click", () => {
  if (_modeState.replaying.status === 'running') {
    setUIMode('replaying');
    return;
  }
  setUIMode('replay-setup');
  const selectedId = els.recordingSelect?.value;
  const rec = state.recordings.find(r => r.id === selectedId);
  if (rec) renderStepsFromRecorded(rec.steps || []);
});

els.homeHeadlessBtn?.addEventListener("click", () => {
  setUIMode('headless');
});

// ============================================================
// Start Replay — from replay-setup mode
// ============================================================
els.startReplayBtn?.addEventListener("click", () => {
  startReplay({ requireDifferentEnv: false });
});

// ============================================================
// Back to Home — switch view without stopping background processes
// ============================================================
els.backToHomeBtn?.addEventListener("click", () => {
  setUIMode('home');
});

// ============================================================
// Clear — reset completed state, return to that mode's setup view
// ============================================================
els.clearModeBtn?.addEventListener("click", () => {
  const mode = _completedFromMode;
  // Reset just this mode's state
  if (mode) setModeState(mode, 'idle');
  // Clean up results/panels
  if (els.pwResults) { els.pwResults.style.display = 'none'; els.pwResults.innerHTML = ''; }
  if (els.pwStatus) els.pwStatus.textContent = '';
  if (els.aiGenResult) { els.aiGenResult.style.display = 'none'; els.aiGenResult.innerHTML = ''; }
  if (els.aiGenDetails) els.aiGenDetails.style.display = 'none';
  // Navigate to the mode's setup view
  switch (mode) {
    case 'recording':
      setUIMode('home');
      break;
    case 'generating': {
      setUIMode('generate');
      const app = document.querySelector('.app');
      app.classList.remove('app--ai-idle', 'app--ai-generating', 'app--ai-generated', 'app--ai-running', 'app--ai-results');
      aiState.phase = 'idle';
      setAIPhase('idle');
      els.aiPromptInput?.focus();
      break;
    }
    case 'replaying':
      setUIMode('replay-setup');
      break;
    case 'headless':
      setUIMode('headless');
      break;
    default:
      setUIMode('home');
  }
});

// ============================================================
// Headless Rerun — go back to headless config to pick and run
// ============================================================
els.pwRerunBtn?.addEventListener("click", () => {
  if (els.pwResults) { els.pwResults.style.display = 'none'; els.pwResults.innerHTML = ''; }
  if (els.pwStatus) els.pwStatus.textContent = '';
  setModeState('headless', 'idle');
  setUIMode('headless');
});

// ============================================================
// Headless Stop — cancel a running headless test
// ============================================================
els.pwStopBtn?.addEventListener("click", () => {
  if (els.pwRunBtn) els.pwRunBtn.disabled = false;
  if (els.pwStopBtn) els.pwStopBtn.style.display = 'none';
  if (els.pwLiveView) els.pwLiveView.style.display = 'none';
  if (els.pwStatus) { els.pwStatus.textContent = 'Run cancelled by user.'; els.pwStatus.style.color = 'var(--orange)'; }
  showCompletion('⏹', 'Headless run cancelled', 'The backend run may still be completing in the background.', { resultStatus: 'cancelled', modeKey: 'headless' });
});

// ============================================================
// Overlay Mode: HUD / Side Panel (mutually exclusive)
// ============================================================
function updateOverlayButtons(mode) {
  _cachedOverlayMode = mode;
  if (els.overlayHudBtn)       els.overlayHudBtn.classList.toggle('active', mode === 'hud');
  if (els.overlaySidePanelBtn) els.overlaySidePanelBtn.classList.toggle('active', mode === 'sidepanel');
}

/**
 * setOverlayMode — switch between HUD / Side Panel / none.
 *
 * IMPORTANT: chrome.sidePanel.open() MUST be called synchronously
 * from a user-gesture context (no preceding awaits).  When the
 * target mode is 'sidepanel', the caller should invoke
 * _openSidePanelNow() BEFORE calling this function.
 */
async function setOverlayMode(mode) {
  const tabId = await getActiveTabId();
  // Ensure _overlayTabId is set for tab-specific keys
  if (!_overlayTabId && tabId) _overlayTabId = tabId;
  if (!_overlayTabId) {
    console.warn('[popup] Cannot set overlay mode — no tab ID');
    return;
  }

  // Close the previous overlay if switching away from HUD
  if (_cachedOverlayMode === 'hud' && mode !== 'hud' && tabId) {
    await chrome.tabs.sendMessage(tabId, { type: "hud_hide" }).catch(() => {});
    await chrome.storage.local.set({ [_tabKey('hudEnabled')]: false });
  }

  if (mode === 'hud') {
    await chrome.storage.local.set({ [_tabKey('overlayMode')]: 'hud', [_tabKey('hudEnabled')]: true });
    if (tabId) await chrome.tabs.sendMessage(tabId, { type: "hud_show" }).catch(() => {});
    updateOverlayButtons('hud');
    // Close the current view — side panel or popup
    if (IS_SIDE_PANEL || (!IS_SIDE_PANEL && !IS_HUD)) {
      setTimeout(() => window.close(), 200);
    }
  } else if (mode === 'sidepanel') {
    await chrome.storage.local.set({ [_tabKey('overlayMode')]: 'sidepanel', [_tabKey('hudEnabled')]: false });
    if (tabId) await chrome.tabs.sendMessage(tabId, { type: "hud_hide" }).catch(() => {});
    updateOverlayButtons('sidepanel');
    // NOTE: chrome.sidePanel.open() already called synchronously
    //       by the click handler before this function was called.
    // Close the popup if we're in popup context
    if (!IS_SIDE_PANEL && !IS_HUD) window.close();
  } else {
    // 'none' — disable both
    await chrome.storage.local.set({ [_tabKey('overlayMode')]: 'none', [_tabKey('hudEnabled')]: false });
    if (tabId) await chrome.tabs.sendMessage(tabId, { type: "hud_hide" }).catch(() => {});
    updateOverlayButtons('none');
  }
}

/**
 * Open the side panel from a user gesture context.
 * Must be called BEFORE any await in the click handler.
 * Uses .then() (microtask) instead of callback to preserve user gesture.
 */
function _openSidePanelNow() {
  chrome.tabs.query({ active: true, currentWindow: true })
    .then((tabs) => {
      const tabId = tabs?.[0]?.id;
      if (tabId) return chrome.sidePanel.open({ tabId });
    })
    .catch((err) => console.warn('[popup] sidePanel.open failed:', err));
}

if (els.overlayHudBtn) {
  els.overlayHudBtn.addEventListener("click", () => {
    // Read cached value synchronously — no await before async work
    const next = _cachedOverlayMode === 'hud' ? 'none' : 'hud';
    setOverlayMode(next);
  });
}

if (els.overlaySidePanelBtn) {
  els.overlaySidePanelBtn.addEventListener("click", () => {
    // Read cached value synchronously — no await before sidePanel.open
    const next = _cachedOverlayMode === 'sidepanel' ? 'none' : 'sidepanel';
    if (next === 'sidepanel') {
      // CRITICAL: open side panel FIRST, synchronously in the click handler,
      // before any async work, to preserve user gesture context.
      _openSidePanelNow();
    }
    setOverlayMode(next);
  });
}

// Load overlay preference (tab-specific)
(async function loadOverlayPreference() {
  // Ensure we know which tab we're operating on
  if (!_overlayTabId) {
    _overlayTabId = await getActiveTabId();
  }
  const key = _tabKey('overlayMode');
  if (key) {
    const result = await chrome.storage.local.get([key]);
    updateOverlayButtons(result[key] || 'none');
  } else {
    updateOverlayButtons('none');
  }
})();

// Load capture settings
chrome.storage.local.get(['captureSettings'], (result) => {
  const captureSettings = result.captureSettings || {
    screenshots: false,
    video: false,
    onFailureOnly: false
  };
  
  // Set radio button based on screenshots and video flags
  if (captureSettings.screenshots && captureSettings.video) {
    els.captureBoth.checked = true;
  } else if (captureSettings.screenshots) {
    els.captureScreenshots.checked = true;
  } else if (captureSettings.video) {
    els.captureVideo.checked = true;
  } else {
    els.captureNone.checked = true;
  }
  
  els.captureOnFailureOnly.checked = captureSettings.onFailureOnly;
});

// Capture mode change handlers (radio buttons)
const captureModeRadios = [els.captureNone, els.captureScreenshots, els.captureVideo, els.captureBoth];
captureModeRadios.forEach(radio => {
  radio.addEventListener("change", async () => {
    if (!radio.checked) return;
    
    const captureSettings = {
      screenshots: radio.value === 'screenshots' || radio.value === 'both',
      video: radio.value === 'video' || radio.value === 'both',
      onFailureOnly: els.captureOnFailureOnly.checked
    };
    await chrome.storage.local.set({ captureSettings });
    console.log("[popup] Capture settings updated:", captureSettings);
  });
});

els.captureOnFailureOnly.addEventListener("change", async () => {
  const settings = await chrome.storage.local.get(['captureSettings']);
  const captureSettings = settings.captureSettings || { screenshots: false, video: false };
  captureSettings.onFailureOnly = els.captureOnFailureOnly.checked;
  await chrome.storage.local.set({ captureSettings });
  console.log("[popup] Capture on failure updated:", captureSettings);
});

// =============================================
// AI Test Generator (Claude CLI + Playwright MCP)
// =============================================

// State for AI test generator
const aiState = {
  currentSpecCode: '',
  currentTestId: '',
  currentTestName: '',
  currentFilePath: '',
  currentRecordingId: '',  // ID in shared recordings storage
  generatedTests: [],
  phase: 'idle',       // idle | generating | generated | running | results
  convertedSteps: [],  // steps from playwrightToSteps()
};

function setAIStatus(text, type = 'info') {
  if (!els.aiTestStatus) return;
  els.aiTestStatus.textContent = text;
  els.aiTestStatus.className = `status-text nl-status--${type}`;
}

// ── AI Phase State Machine ──────────────────────────────────
function setAIPhase(phase) {
  const app = document.querySelector('.app');
  if (!app) return;
  // Remove AI sub-phase classes only (preserve mode class like app--generate)
  app.classList.remove('app--ai-idle', 'app--ai-generating', 'app--ai-generated', 'app--ai-running', 'app--ai-results');
  app.classList.add(`app--ai-${phase}`);
  aiState.phase = phase;
  // Update mode header for active AI phases
  if (phase === 'generating') {
    setModeState('generating', 'running', 'Generating...');
    updateModeHeader('Generating with AI...', 'running');
  } else if (phase === 'running') {
    updateModeHeader('Running AI test...', 'running');
  }
}

// "Generate with AI" button — toggles the inline prompt section
if (els.generateWithAIBtn) {
  els.generateWithAIBtn.addEventListener("click", () => {
    const section = els.aiPromptSection;
    if (!section) return;
    const isVisible = section.style.display !== 'none';
    section.style.display = isVisible ? 'none' : 'block';
    els.generateWithAIBtn.classList.toggle('active', !isVisible);
    chrome.storage.local.set({ aiTestPanelVisible: !isVisible });
    if (!isVisible) {
      if (aiState.currentSpecCode) {
        setAIPhase('generated');
      } else {
        setAIPhase('idle');
      }
      els.aiPromptInput?.focus();
    }
  });
}

// Replay Headless button — opens the Playwright panel
if (els.replayHeadlessBtn) {
  els.replayHeadlessBtn.addEventListener("click", () => {
    if (els.playwrightPanel) {
      const isHidden = els.playwrightPanel.style.display === 'none' || !els.playwrightPanel.style.display;
      els.playwrightPanel.style.display = isHidden ? 'block' : 'none';
      if (isHidden) {
        requestAnimationFrame(() => els.playwrightPanel.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      }
    }
  });
}

// Generation mode toggle (Fast / Reasoning)
function _applyGenModeStyles(activeMode) {
  document.querySelectorAll('.ai-gen-mode-btn').forEach(b => {
    const isActive = b.dataset.mode === activeMode;
    b.classList.toggle('active', isActive);
    b.style.background = isActive ? '#7c5cff' : 'transparent';
    b.style.borderColor = isActive ? '#7c5cff' : '#ccc';
    b.style.color = isActive ? '#fff' : '#666';
  });
}
document.querySelectorAll('.ai-gen-mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    _applyGenModeStyles(btn.dataset.mode);
    chrome.storage.local.set({ aiGenMode: btn.dataset.mode });
  });
});
// Restore saved mode
chrome.storage.local.get(['aiGenMode'], (result) => {
  _applyGenModeStyles(result.aiGenMode || 'fast');
});

// Hint chips
document.querySelectorAll('.ai-hint-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    if (els.aiPromptInput) {
      els.aiPromptInput.value = chip.dataset.hint;
      els.aiPromptInput.focus();
      els.aiPromptInput.style.height = 'auto';
      els.aiPromptInput.style.height = els.aiPromptInput.scrollHeight + 'px';
      chrome.storage.local.set({ aiPromptText: chip.dataset.hint });
    }
  });
});

// Auto-resize prompt textarea
if (els.aiPromptInput) {
  els.aiPromptInput.addEventListener('input', () => {
    els.aiPromptInput.style.height = 'auto';
    els.aiPromptInput.style.height = Math.min(els.aiPromptInput.scrollHeight, 120) + 'px';
  });
  // Enter (without Shift) submits
  els.aiPromptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      els.generateTestBtn?.click();
    }
  });
}

// Helper: get the active tab's URL
async function getActiveTabUrl() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.url && !tabs[0].url.startsWith('chrome://')) {
      return tabs[0].url;
    }
  } catch (e) {
    console.warn("[popup][ai] Could not get active tab URL:", e);
  }
  return null;
}

// Load AI prompt state
chrome.storage.local.get(['aiTestPanelVisible', 'aiPromptText'], (result) => {
  if (result.aiTestPanelVisible && els.aiPromptSection) {
    els.aiPromptSection.style.display = 'block';
    if (els.generateWithAIBtn) els.generateWithAIBtn.classList.add('active');
    setAIPhase(aiState.currentSpecCode ? 'generated' : 'idle');
  }
  if (result.aiPromptText && els.aiPromptInput) {
    els.aiPromptInput.value = result.aiPromptText;
  }
});

// Show active Claude model indicator
chrome.storage.local.get(['generatorConfig'], (result) => {
  const config = result.generatorConfig || {};
  const indicator = document.getElementById('aiModelIndicator');
  if (indicator) {
    const modelLabel = config.model ? config.model.replace(/-\d{8}$/, '') : 'default';
    indicator.textContent = `Model: ${modelLabel}`;
  }
});

// ── Registry Connection (popup config) ──────────────────────
const _reg = {
  bar: document.getElementById('registryBar'),
  connected: document.getElementById('registryConnected'),
  disconnected: document.getElementById('registryDisconnected'),
  barText: document.getElementById('registryBarText'),
  barRole: document.getElementById('registryBarRole'),
  barDisconnect: document.getElementById('registryBarDisconnect'),
  toggleConfig: document.getElementById('registryToggleConfig'),
  configPanel: document.getElementById('registryConfigPanel'),
  urlInput: document.getElementById('popupRegistryUrl'),
  emailInput: document.getElementById('popupRegistryEmail'),
  passwordInput: document.getElementById('popupRegistryPassword'),
  connectBtn: document.getElementById('popupRegistryConnect'),
  cancelBtn: document.getElementById('popupRegistryCancel'),
  status: document.getElementById('popupRegistryStatus'),
};

function showRegistryConnectedState(config) {
  if (_reg.connected) _reg.connected.style.display = 'flex';
  if (_reg.disconnected) _reg.disconnected.style.display = 'none';
  if (_reg.configPanel) _reg.configPanel.style.display = 'none';
  if (_reg.barText) _reg.barText.textContent = `${config.accountName || config.accountSlug} / ${config.projectName || config.projectSlug}`;
  if (_reg.barRole) _reg.barRole.textContent = config.role;
  const pushBtn = document.getElementById('pushToRegistryBtn');
  if (pushBtn) pushBtn.style.display = '';
}

function showRegistryDisconnectedState() {
  if (_reg.connected) _reg.connected.style.display = 'none';
  if (_reg.disconnected) _reg.disconnected.style.display = '';
  if (_reg.configPanel) _reg.configPanel.style.display = 'none';
  const pushBtn = document.getElementById('pushToRegistryBtn');
  if (pushBtn) pushBtn.style.display = 'none';
}

// Load on init
chrome.storage.local.get(['registryConfig'], (result) => {
  const config = result.registryConfig || {};
  if (config.connected) {
    showRegistryConnectedState(config);
  } else {
    showRegistryDisconnectedState();
    // Backend URL is configured in the options page
  }
});

// Toggle config panel
_reg.toggleConfig?.addEventListener('click', () => {
  if (_reg.configPanel) {
    _reg.configPanel.style.display = _reg.configPanel.style.display === 'none' ? '' : 'none';
    _reg.disconnected.style.display = _reg.configPanel.style.display === 'none' ? '' : 'none';
  }
});

// Cancel
_reg.cancelBtn?.addEventListener('click', () => {
  if (_reg.configPanel) _reg.configPanel.style.display = 'none';
  if (_reg.disconnected) _reg.disconnected.style.display = '';
  if (_reg.status) _reg.status.textContent = '';
});

// Login
_reg.connectBtn?.addEventListener('click', async () => {
  // Use popup URL field if filled, otherwise use stored backendConfig
  const popupUrl = _reg.urlInput?.value?.trim();
  let url;
  if (popupUrl) {
    url = popupUrl.replace(/\/+$/, '');
    await chrome.storage.local.set({ backendConfig: { url } });
  } else {
    const backendResult = await chrome.storage.local.get(['backendConfig']);
    url = ((backendResult.backendConfig?.url || 'http://localhost:8000')).replace(/\/+$/, '');
  }
  const email = _reg.emailInput?.value?.trim();
  const password = _reg.passwordInput?.value?.trim();
  if (!email || !password) {
    if (_reg.status) { _reg.status.textContent = 'Email and password required'; _reg.status.style.color = '#f44336'; }
    return;
  }
  if (_reg.status) { _reg.status.textContent = 'Logging in...'; _reg.status.style.color = '#888'; }
  try {
    const resp = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    const config = {
      connected: true,
      sessionToken: data.token,
      userId: data.user.id,
      userName: data.user.name,
      userEmail: data.user.email,
      accountId: data.current.account_id,
      accountSlug: data.current.account_slug,
      accountName: data.current.account_name,
      projectId: data.current.project_id,
      projectSlug: data.current.project_slug,
      projectName: data.current.project_name,
      role: data.current.role,
      availableRoles: data.roles,
    };
    await chrome.storage.local.set({ registryConfig: config });
    showRegistryConnectedState(config);
    if (_reg.emailInput) _reg.emailInput.value = '';
    if (_reg.passwordInput) _reg.passwordInput.value = '';
    if (_reg.status) _reg.status.textContent = '';
  } catch (err) {
    if (_reg.status) { _reg.status.textContent = err.message; _reg.status.style.color = '#f44336'; }
  }
});

// Disconnect
_reg.barDisconnect?.addEventListener('click', async () => {
  await chrome.storage.local.remove('registryConfig');
  showRegistryDisconnectedState();
});

// Push to Registry button
document.getElementById('pushToRegistryBtn')?.addEventListener('click', async () => {
  const recordingId = els.recordingSelect?.value;
  if (!recordingId) {
    setStatus("Select a recording first.", "failure");
    return;
  }
  setStatus("Exporting and pushing to registry...", "running");
  try {
    const exportResp = await chrome.runtime.sendMessage({ type: "export_recording_playwright", recordingId });
    if (!exportResp?.ok) {
      setStatus(exportResp?.error || "Export failed.", "failure");
      return;
    }
    const rec = state.recordings.find(r => r.id === recordingId);
    const testName = rec?.name || "test";
    const navStep = rec?.steps?.find(s => s.type === 'navigation');
    const targetUrl = navStep?.url || navStep?.value || '';

    const pushResp = await chrome.runtime.sendMessage({
      type: "registry_push_test",
      testName,
      specCode: exportResp.output,
      targetUrl,
      prompt: "",
    });
    if (pushResp?.ok) {
      setStatus("Pushed to registry!", "success");
    } else {
      setStatus(pushResp?.error || "Push failed.", "failure");
    }
  } catch (err) {
    setStatus("Push error: " + err.message, "failure");
  }
});

// Save prompt as user types (debounced)
if (els.aiPromptInput) {
  let saveTimeout = null;
  els.aiPromptInput.addEventListener("input", () => {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      chrome.storage.local.set({ aiPromptText: els.aiPromptInput.value });
    }, 500);
  });
}


// Generate Test button — with stop support
let _generationInProgress = false;
if (els.generateTestBtn) {
  els.generateTestBtn.addEventListener("click", async () => {
    // If generation is running, cancel it
    if (_generationInProgress) {
      setAIStatus("Cancelling generation...", "info");
      try { await chrome.runtime.sendMessage({ type: "cancel_generation" }); } catch {}
      _generationInProgress = false;
      els.generateTestBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';
      els.generateTestBtn.classList.remove('ai-prompt-stop');
      els.generateTestBtn.title = 'Generate Test';
      if (els.aiGenDetails) els.aiGenDetails.style.display = 'none';
      setAIPhase('idle');
      setAIStatus("Generation cancelled.", "info");
      setModeState('generating', 'cancelled', 'Cancelled');
      return;
    }

    const prompt = els.aiPromptInput?.value?.trim();
    if (!prompt) {
      setAIStatus("Please describe your test scenario.", "error");
      return;
    }

    // Always get URL from the active browser tab
    const targetUrl = await getActiveTabUrl();
    if (!targetUrl) {
      setAIStatus("Cannot detect the current page URL. Make sure you're on a web page.", "error");
      return;
    }

    // Read current model config
    const genConfigResult = await chrome.storage.local.get(['generatorConfig']);
    const genConfig = genConfigResult.generatorConfig || {};

    // Read generation mode (fast = no validation, reasoning = validate + auto-fix)
    const activeMode = document.querySelector('.ai-gen-mode-btn.active')?.dataset?.mode || 'fast';
    const useValidation = activeMode === 'reasoning';

    // Switch button to Stop mode
    _generationInProgress = true;
    els.generateTestBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>';
    els.generateTestBtn.classList.add('ai-prompt-stop');
    els.generateTestBtn.title = 'Stop Generation';
    setAIPhase('generating');
    setAIStatus("Generating test with Claude + Playwright MCP...", "info");
    els.artifactsCard.style.display = 'none';

    // Show live generation details
    if (els.aiGenResult) els.aiGenResult.style.display = 'none';
    if (els.aiGenLog) { els.aiGenLog.innerHTML = ''; els.aiGenLog.style.display = 'none'; }
    if (els.aiGenDetails) {
      els.aiGenDetails.style.display = 'flex';
      if (els.aiGenTarget) els.aiGenTarget.innerHTML = `<span class="ai-gen-detail-label">URL:</span> ${targetUrl}`;
      if (els.aiGenPrompt) els.aiGenPrompt.innerHTML = `<span class="ai-gen-detail-label">Prompt:</span> ${prompt.length > 60 ? prompt.slice(0, 60) + '...' : prompt}`;
      if (els.aiGenTimer) els.aiGenTimer.innerHTML = `<span class="ai-gen-detail-label">Elapsed:</span> <span id="aiGenTimerValue">0s</span>`;
    }
    const genModel = genConfig.model ? genConfig.model.replace(/-\d{8}$/, '') : 'default';
    setModeState('generating', 'running', `Generating on ${genModel}...`);

    // Start elapsed timer + progress poller
    const _genStartTime = Date.now();
    let _lastPhase = 'generating';
    const _genTimerInterval = setInterval(async () => {
      const elapsed = Math.round((Date.now() - _genStartTime) / 1000);
      const timerEl = document.getElementById('aiGenTimerValue');
      if (timerEl) timerEl.textContent = `${elapsed}s`;

      // Poll SSE progress + live log from storage (written by service worker)
      try {
        const [progressResult, logResult] = await Promise.all([
          chrome.storage.local.get('genProgress'),
          chrome.storage.local.get('genLog'),
        ]);
        const progress = progressResult.genProgress;
        const logLines = logResult.genLog || [];

        // Update live log panel
        if (els.aiGenLog && logLines.length > 0) {
          els.aiGenLog.innerHTML = logLines.slice(-15).map((l, i) => {
            const isThinking = l.text && l.text.startsWith('💭');
            const isBanner = i === 0;
            const cls = isThinking
              ? 'ai-gen-log__thinking'
              : `ai-gen-log__line ai-gen-log__line--${l.phase || 'generating'}${isBanner ? ' ai-gen-log__banner' : ''}`;
            return `<div class="${cls}">${_escHtml(l.text)}</div>`;
          }).join('');
          els.aiGenLog.scrollTop = els.aiGenLog.scrollHeight;
          els.aiGenLog.style.display = 'block';
        }

        if (progress && progress.phase && progress.phase !== _lastPhase) {
          _lastPhase = progress.phase;
          const phaseLabels = {
            generating: 'Generating test with Claude + MCP...',
            generated: 'Test generated. Validating...',
            validating: 'Running headless validation...',
            validated: 'Validation passed!',
            fixing: `Auto-fixing (attempt ${progress.attempt || 1}/${progress.max_attempts || 3})...`,
            revalidating: `Re-validating fix (attempt ${progress.attempt || 1})...`,
            fix_failed: `Fix attempt ${progress.attempt || 1} failed. Retrying...`,
            fix_exhausted: 'Could not auto-fix. Saving best version.',
            validation_skipped: 'Validation skipped (runner unavailable).',
          };
          const label = phaseLabels[progress.phase] || progress.message || progress.phase;
          setAIStatus(label, progress.phase === 'validated' ? 'success' : progress.phase.includes('fail') ? 'error' : 'info');
          setModeState('generating', 'running', `${label} (${elapsed}s)`);
          updateModeHeader(label, 'running', `${elapsed}s`);

          // Show full error details if fixing (no truncation)
          if (progress.error && els.aiGenPrompt) {
            els.aiGenPrompt.innerHTML = `<span class="ai-gen-detail-label">Issue:</span> <span class="ai-gen-error-text">${_escHtml(progress.error)}</span>`;
          }

          // Show runner test results when validation completes or fixing begins
          const tests = (progress.report && progress.report.tests) || progress.failed_tests || [];
          if (tests.length > 0 && els.aiGenLog) {
            const testHtml = tests.map(t => {
              const pass = t.status === 'passed';
              const err = t.error ? `<div class="ai-gen-log__test-err">${_escHtml((t.error || '').slice(0, 200))}</div>` : '';
              return `<div class="ai-gen-log__test ${pass ? 'ai-gen-log__test--pass' : 'ai-gen-log__test--fail'}">${pass ? '✓' : '✗'} ${_escHtml(t.title || 'test')}${err}</div>`;
            }).join('');
            els.aiGenLog.innerHTML = `<div class="ai-gen-log__section">Runner results</div>${testHtml}`;
            els.aiGenLog.style.display = 'block';
          }
        } else {
          setModeState('generating', 'running', `${_lastPhase === 'generating' ? 'Generating' : _lastPhase}... ${elapsed}s`);
        }
      } catch (_) {}
    }, 1000);

    try {
      let response = await chrome.runtime.sendMessage({
        type: "generate_mcp_test",
        prompt,
        targetUrl,
        model: genConfig.model || null,
        validate: useValidation,
      });

      // Service worker returns {pending:true} immediately to avoid the Chrome
      // message-channel timeout (~5 min). Poll storage for the actual result.
      if (response?.pending) {
        response = await new Promise((resolve) => {
          const _resultPoller = setInterval(async () => {
            try {
              const r = await chrome.storage.local.get("genResult");
              if (r.genResult) {
                clearInterval(_resultPoller);
                await chrome.storage.local.remove("genResult");
                resolve(r.genResult);
              }
            } catch (_) {}
          }, 500);
        });
      }

      clearInterval(_genTimerInterval);
      const elapsedSec = Math.round((Date.now() - _genStartTime) / 1000);

      if (!_generationInProgress) return; // was cancelled

      if (response?.ok && response.spec_code) {
        aiState.currentSpecCode = response.spec_code;
        aiState.currentTestId = response.test_id;
        aiState.currentTestName = response.test_name;
        aiState.currentFilePath = response.file_path;

        // Convert spec to steps for saving
        let stepCount = 0;
        try {
          const convertedResult = playwrightToSteps(response.spec_code, targetUrl);
          const steps = convertedResult.steps || [];
          stepCount = steps.length;
          if (steps.length) {
            const saveResp = await chrome.runtime.sendMessage({
              type: "save_recording",
              name: `AI: ${response.test_name}`,
              steps,
              source: 'ai',
              specCode: response.spec_code,
              targetUrl,
            });
            if (saveResp?.ok) {
              aiState.currentRecordingId = saveResp.recording?.id;
              await loadEnvironments();
              await loadRecordings();
              if (saveResp.recording?.envId) {
                els.envSelect.value = saveResp.recording.envId;
                state.lastReplayEnvId = saveResp.recording.envId;
                chrome.storage.local.set({ lastReplayEnvId: saveResp.recording.envId });
              }
              if (saveResp.recording?.id) {
                els.recordingSelect.value = saveResp.recording.id;
                state.lastSelectedRecordingId = saveResp.recording.id;
                chrome.storage.local.set({ lastSelectedRecordingId: saveResp.recording.id });
              }
            }
          }
        } catch (saveErr) {
          console.warn("[popup][ai] Failed to save AI test as recording:", saveErr);
        }

        // Show result summary card
        if (els.aiGenResult) {
          const codePreview = response.spec_code.split('\n').slice(0, 15).join('\n');
          els.aiGenResult.innerHTML = `
            <div class="ai-gen-result__title">✓ ${response.test_name}</div>
            <div class="ai-gen-result__row"><span class="ai-gen-result__label">Steps:</span> ${stepCount}</div>
            <div class="ai-gen-result__row"><span class="ai-gen-result__label">URL:</span> ${targetUrl}</div>
            <div class="ai-gen-result__row"><span class="ai-gen-result__label">Time:</span> ${elapsedSec}s</div>
            <div class="ai-gen-result__code">${codePreview.replace(/</g, '&lt;')}</div>`;
          els.aiGenResult.style.display = 'block';
        }

        setAIPhase('generated');
        setAIStatus(`Test generated: ${response.test_name}`, "success");
        const summaryText = `${response.test_name} — ${stepCount} steps in ${elapsedSec}s`;
        showCompletion('✓', 'Test generated!', summaryText, { resultStatus: 'success', modeKey: 'generating' });
      } else {
        const errMsg = response?.error || 'Unknown error';
        // Show error in result panel
        if (els.aiGenResult) {
          els.aiGenResult.innerHTML = `<div class="ai-gen-result__title" style="color:var(--red);">✗ Generation failed</div>
            <div class="ai-gen-result__row">${errMsg}</div>
            <div class="ai-gen-result__row"><span class="ai-gen-result__label">Time:</span> ${elapsedSec}s</div>`;
          els.aiGenResult.style.display = 'block';
        }
        setAIPhase('idle');
        setAIStatus(`Failed: ${errMsg}`, "error");
        showCompletion('✗', 'Generation failed', `${errMsg} (${elapsedSec}s)`, { resultStatus: 'failed', modeKey: 'generating' });
      }
    } catch (err) {
      clearInterval(_genTimerInterval);
      const elapsedSec = Math.round((Date.now() - _genStartTime) / 1000);
      console.error("[popup][ai] Generate error:", err);
      if (els.aiGenResult) {
        els.aiGenResult.innerHTML = `<div class="ai-gen-result__title" style="color:var(--red);">✗ Generation error</div>
          <div class="ai-gen-result__row">${err.message}</div>
          <div class="ai-gen-result__row"><span class="ai-gen-result__label">Time:</span> ${elapsedSec}s</div>`;
        els.aiGenResult.style.display = 'block';
      }
      setAIPhase('idle');
      setAIStatus(`Error: ${err.message}`, "error");
      showCompletion('✗', 'Generation failed', `${err.message} (${elapsedSec}s)`, { resultStatus: 'failed', modeKey: 'generating' });
    } finally {
      clearInterval(_genTimerInterval);
      if (els.aiGenDetails) els.aiGenDetails.style.display = 'none';
      _generationInProgress = false;
      els.generateTestBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';
      els.generateTestBtn.classList.remove('ai-prompt-stop');
      els.generateTestBtn.title = 'Generate Test';
    }
  });
}


// ── Screenshot lightbox overlay ──────────────────────────────────
function _showScreenshotOverlay(urls, startIndex) {
  let current = startIndex;
  // Remove existing overlay
  document.getElementById('screenshotOverlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'screenshotOverlay';
  overlay.className = 'screenshot-overlay';
  overlay.innerHTML = `
    <div class="screenshot-overlay-backdrop"></div>
    <div class="screenshot-overlay-content">
      <button class="screenshot-overlay-close" title="Close">&times;</button>
      <button class="screenshot-overlay-nav screenshot-overlay-prev" title="Previous">&lsaquo;</button>
      <img class="screenshot-overlay-img" src="${urls[current]}" alt="Screenshot" />
      <button class="screenshot-overlay-nav screenshot-overlay-next" title="Next">&rsaquo;</button>
      <div class="screenshot-overlay-footer">
        <span class="screenshot-overlay-counter">${current + 1} / ${urls.length}</span>
        <button class="btn btn--sm screenshot-overlay-open-tab">Open in New Tab</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const img = overlay.querySelector('.screenshot-overlay-img');
  const counter = overlay.querySelector('.screenshot-overlay-counter');
  const update = () => {
    img.src = urls[current];
    counter.textContent = `${current + 1} / ${urls.length}`;
  };

  overlay.querySelector('.screenshot-overlay-close').onclick = () => overlay.remove();
  overlay.querySelector('.screenshot-overlay-backdrop').onclick = () => overlay.remove();
  overlay.querySelector('.screenshot-overlay-prev').onclick = (e) => { e.stopPropagation(); current = (current - 1 + urls.length) % urls.length; update(); };
  overlay.querySelector('.screenshot-overlay-next').onclick = (e) => { e.stopPropagation(); current = (current + 1) % urls.length; update(); };
  overlay.querySelector('.screenshot-overlay-open-tab').onclick = () => chrome.tabs.create({ url: urls[current] });

  // Keyboard navigation
  const onKey = (e) => {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); }
    if (e.key === 'ArrowLeft') { current = (current - 1 + urls.length) % urls.length; update(); }
    if (e.key === 'ArrowRight') { current = (current + 1) % urls.length; update(); }
  };
  document.addEventListener('keydown', onKey);
}

// ── Download HTML report with embedded screenshots ──────────────
async function _downloadHtmlReport(report, artifacts, runnerUrl) {
  const screenshotUrls = (artifacts.screenshots || []).map(u => `${runnerUrl}${u}`);

  // Fetch and embed screenshots as base64
  const screenshotDataUrls = await Promise.all(
    screenshotUrls.map(async (url) => {
      try {
        const resp = await fetch(url);
        const blob = await resp.blob();
        return await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve({ url, dataUrl: reader.result, name: url.split('/').pop() });
          reader.readAsDataURL(blob);
        });
      } catch {
        return { url, dataUrl: '', name: url.split('/').pop() };
      }
    })
  );

  const tests = report.tests || [];
  const testRows = tests.length ? tests.map(t => `
    <tr class="${t.status === 'passed' ? 'pass' : 'fail'}">
      <td>${_escHtml(t.title)}</td>
      <td><span class="badge badge-${t.status === 'passed' ? 'pass' : 'fail'}">${t.status}</span></td>
      <td>${((t.duration_ms || 0) / 1000).toFixed(1)}s</td>
      <td>${t.error ? _escHtml(t.error.substring(0, 300)) : '-'}</td>
    </tr>
  `).join('') : '<tr><td colspan="4">No individual test details available</td></tr>';

  const screenshotHtml = screenshotDataUrls.map(s => s.dataUrl ? `
    <div class="ss-card">
      <img src="${s.dataUrl}" alt="${s.name}" />
      <div class="ss-name">${_escHtml(s.name)}</div>
    </div>
  ` : '').join('');

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" /><title>Test Report - ${_escHtml(report.run_id || 'unknown')}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f6fa; color: #2c3e50; padding: 24px; }
  h1 { font-size: 20px; margin-bottom: 16px; }
  .summary { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
  .stat { background: #fff; border-radius: 8px; padding: 12px 20px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .stat .label { font-size: 11px; text-transform: uppercase; color: #7f8c8d; }
  .stat .value { font-size: 22px; font-weight: 700; }
  .stat .value.pass { color: #27ae60; }
  .stat .value.fail { color: #e74c3c; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.08); margin-bottom: 24px; }
  th { background: #34495e; color: #fff; text-align: left; padding: 10px 14px; font-size: 12px; }
  td { padding: 10px 14px; border-bottom: 1px solid #ecf0f1; font-size: 13px; vertical-align: top; }
  tr.pass td:first-child { border-left: 3px solid #27ae60; }
  tr.fail td:first-child { border-left: 3px solid #e74c3c; }
  .badge { padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .badge-pass { background: #d5f5e3; color: #27ae60; }
  .badge-fail { background: #fadbd8; color: #e74c3c; }
  h2 { font-size: 16px; margin-bottom: 12px; }
  .ss-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .ss-card { background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .ss-card img { width: 100%; display: block; cursor: pointer; }
  .ss-card img:hover { opacity: .9; }
  .ss-name { padding: 8px 12px; font-size: 11px; color: #7f8c8d; word-break: break-all; }
  .footer { margin-top: 24px; font-size: 11px; color: #bdc3c7; }
</style></head><body>
<h1>Test Report</h1>
<div class="summary">
  <div class="stat"><div class="label">Status</div><div class="value ${report.status === 'passed' ? 'pass' : 'fail'}">${(report.status || 'unknown').toUpperCase()}</div></div>
  <div class="stat"><div class="label">Duration</div><div class="value">${((report.duration_ms || 0) / 1000).toFixed(1)}s</div></div>
  <div class="stat"><div class="label">Passed</div><div class="value pass">${report.passed || 0}</div></div>
  <div class="stat"><div class="label">Failed</div><div class="value fail">${report.failed || 0}</div></div>
  ${report.skipped ? `<div class="stat"><div class="label">Skipped</div><div class="value">${report.skipped}</div></div>` : ''}
</div>

<h2>Test Details</h2>
<table><thead><tr><th>Test</th><th>Status</th><th>Duration</th><th>Error</th></tr></thead><tbody>${testRows}</tbody></table>

${screenshotHtml ? `<h2>Screenshots</h2><div class="ss-grid">${screenshotHtml}</div>` : ''}

<div class="footer">Generated by Autotest on ${new Date().toLocaleString()} | Run ID: ${_escHtml(report.run_id || 'N/A')}</div>
</body></html>`;

  // Download as HTML file
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({
    url,
    filename: `test-report-${report.run_id || 'unknown'}.html`,
    saveAs: true,
  });
}


setStatus("Idle", "idle");
renderRecordButton();

// ============================================================
// Side Panel: auto-refresh on tab switch / navigation
// ============================================================
if (IS_SIDE_PANEL) {
  console.log("[popup] Running in Side Panel mode");

  // Refresh everything when the user switches to a different tab
  async function refreshAll() {
    try {
      await loadRecordings();
      await refreshRecordingState();
      await refreshRecordedSteps();
      await loadLastReport();
    } catch (err) {
      console.warn("[popup][sidepanel] refreshAll error:", err);
    }
  }

  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    _sidePanelActiveTabId = activeInfo.tabId;
    // Update overlay tab ID and re-read overlay state for the new tab
    _overlayTabId = activeInfo.tabId;
    const modeKey = _tabKey('overlayMode');
    const result = await chrome.storage.local.get([modeKey]);
    updateOverlayButtons(result[modeKey] || 'none');
    console.log("[popup][sidepanel] Tab switched to:", activeInfo.tabId);
    await refreshAll();
  });

  // Also refresh when the active tab finishes navigating
  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    if (tabId === _sidePanelActiveTabId && changeInfo.status === "complete") {
      console.log("[popup][sidepanel] Tab navigation complete:", tabId);
      await refreshAll();
    }
  });
}

// ============================================================
// (Pin to Side Panel is now handled by the overlay mode selector above)

// ============================================================
// Unpin / close side panel button (side panel mode only)
// ============================================================
if (els.unpinBtn) {
  els.unpinBtn.addEventListener("click", () => {
    // There's no direct API to close the side panel.
    // We can guide the user, or just close the window.
    window.close();
  });
}

// React to overlay mode changes for this tab (mutual exclusivity)
chrome.storage.onChanged.addListener((changes) => {
  const modeKey = _tabKey('overlayMode');
  if (modeKey && changes[modeKey]) {
    const newMode = changes[modeKey].newValue;
    updateOverlayButtons(newMode || 'none');
    // If we are the side panel and mode switched away from sidepanel → close
    if (IS_SIDE_PANEL && newMode && newMode !== 'sidepanel') {
      window.close();
    }
  }
});

// Load last selected recording from storage
chrome.storage.local.get(['lastSelectedRecordingId', 'lastReplayEnvId'], (result) => {
  if (result.lastSelectedRecordingId) {
    state.lastSelectedRecordingId = result.lastSelectedRecordingId;
  }
  if (result.lastReplayEnvId) {
    state.lastReplayEnvId = result.lastReplayEnvId;
  }
  
  applyFeatureGates();
  setUIMode('home');
  loadEnvironments().then(async () => {
    await loadRecordings();
    await refreshRecordingState();
    await refreshRecordedSteps();
    await loadLastReport();
  });
});

// ── Background health check on load ──────────────────────────
(async () => {
  try {
    const resp = await sendMessageWithTimeout({ type: "get_tab_id" }, 5000);
    console.log("[popup] Background health check OK:", resp);
  } catch (err) {
    console.error("[popup] Background health check FAILED:", err?.message);
    setStatus(`⚠ Service worker error: ${err?.message}`, "failure");
  }
})();

// ── Cross-tab prompt buttons ──────────────────────────────────
els.confirmRecordTabBtn?.addEventListener('click', async () => {
  const tabId = _overlayTabId || (await getActiveTabId());
  console.log("[popup][cross-tab] 'Record this tab' clicked, tabId:", tabId);
  if (!tabId) return;
  hideCrossTabPrompt();
  setStatus("Starting recording…", "running");
  try {
    const resp = await chrome.runtime.sendMessage({ type: "confirm_record_new_tab", tabId });
    console.log("[popup][cross-tab] confirm_record_new_tab response:", resp);
    if (!resp?.ok) throw new Error(resp?.error || "Failed to start recording");
    state.isRecording = true;
    setUIMode('recording');
    setStatus("Recording…", "running");
    renderRecordButton();
  } catch (err) {
    console.error("[popup][cross-tab] Failed to start recording on new tab:", err);
    setStatus(`Error: ${err.message}`, "failure");
  }
});

els.dismissPromptBtn?.addEventListener('click', async () => {
  const tabId = _overlayTabId;
  console.log("[popup][cross-tab] Prompt dismissed, tabId:", tabId);
  if (tabId) await chrome.storage.local.remove(`crossTabPrompt_${tabId}`).catch(() => {});
  hideCrossTabPrompt();
});

// ── Discard recording ─────────────────────────────────────────
els.discardRecordingBtn?.addEventListener('click', async () => {
  const confirmed = window.confirm("Discard this recording? All captured steps will be lost and nothing will be saved.");
  if (!confirmed) return;
  const tabId = await getActiveTabId();
  console.log("[popup][discard] Discarding recording, tabId:", tabId);
  if (!tabId) return;
  try {
    const resp = await chrome.runtime.sendMessage({ type: "discard_recording", tabId });
    console.log("[popup][discard] discard_recording response:", resp);
    state.isRecording = false;
    setUIMode('home');
    renderRecordButton();
    setStatus("Recording discarded.", "idle");
  } catch (err) {
    console.error("[popup][discard] Discard failed:", err);
    setStatus(`Discard failed: ${err.message}`, "failure");
  }
});

// ── Network Filters ───────────────────────────────────────────

function parseNFPatterns(text) {
  return text.split('\n').map(p => p.trim()).filter(Boolean);
}

function updateNfBadges() {
  const blockOn = els.blockPatternsEnabled?.checked;
  const captureOn = els.capturePatternsEnabled?.checked;
  const blockCount = parseNFPatterns(els.blockPatternsInput?.value || '').length;
  const captureCount = parseNFPatterns(els.capturePatternsInput?.value || '').length;

  if (els.nfBlockBadge) {
    const show = blockOn && blockCount > 0;
    els.nfBlockBadge.style.display = show ? '' : 'none';
    els.nfBlockBadge.textContent = `Block: ${blockCount}`;
  }
  if (els.nfCaptureBadge) {
    const show = captureOn && captureCount > 0;
    els.nfCaptureBadge.style.display = show ? '' : 'none';
    els.nfCaptureBadge.textContent = `Capture: ${captureCount}`;
  }
}

async function saveNetworkFilters() {
  const blockPatterns = parseNFPatterns(els.blockPatternsInput?.value || '');
  const capturePatterns = parseNFPatterns(els.capturePatternsInput?.value || '');
  const blockPatternsEnabled = els.blockPatternsEnabled?.checked || false;
  const capturePatternsEnabled = els.capturePatternsEnabled?.checked || false;
  await chrome.storage.local.set({ blockPatterns, capturePatterns, blockPatternsEnabled, capturePatternsEnabled });
  updateNfBadges();
}

// Expand/collapse
els.nfToggleBtn?.addEventListener('click', () => {
  const isOpen = els.nfBody?.style.display !== 'none';
  if (els.nfBody) els.nfBody.style.display = isOpen ? 'none' : '';
  const chevron = els.nfToggleBtn.querySelector('.nf-chevron');
  if (chevron) chevron.style.transform = isOpen ? '' : 'rotate(180deg)';
  chrome.storage.local.set({ nfExpanded: !isOpen });
});

// Block patterns toggle
els.blockPatternsEnabled?.addEventListener('change', () => {
  if (els.blockPatternsInput) els.blockPatternsInput.disabled = !els.blockPatternsEnabled.checked;
  saveNetworkFilters();
});
els.blockPatternsInput?.addEventListener('input', saveNetworkFilters);

// Capture patterns toggle
els.capturePatternsEnabled?.addEventListener('change', () => {
  if (els.capturePatternsInput) els.capturePatternsInput.disabled = !els.capturePatternsEnabled.checked;
  saveNetworkFilters();
});
els.capturePatternsInput?.addEventListener('input', saveNetworkFilters);

// Load persisted state on init
chrome.storage.local.get(
  ['blockPatterns', 'blockPatternsEnabled', 'capturePatterns', 'capturePatternsEnabled', 'nfExpanded'],
  (result) => {
    const blockEnabled = result.blockPatternsEnabled === true;
    const captureEnabled = result.capturePatternsEnabled === true;

    if (els.blockPatternsEnabled) els.blockPatternsEnabled.checked = blockEnabled;
    if (els.blockPatternsInput) {
      els.blockPatternsInput.value = (result.blockPatterns || []).join('\n');
      els.blockPatternsInput.disabled = !blockEnabled;
    }
    if (els.capturePatternsEnabled) els.capturePatternsEnabled.checked = captureEnabled;
    if (els.capturePatternsInput) {
      els.capturePatternsInput.value = (result.capturePatterns || []).join('\n');
      els.capturePatternsInput.disabled = !captureEnabled;
    }

    // Restore expanded state if user had it open
    if (result.nfExpanded && els.nfBody) {
      els.nfBody.style.display = '';
      const chevron = els.nfToggleBtn?.querySelector('.nf-chevron');
      if (chevron) chevron.style.transform = 'rotate(180deg)';
    }

    updateNfBadges();
  }
);
