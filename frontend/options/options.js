/**
 * Options page controller — Environment configuration.
 *
 * Scope (per request):
 * - CRUD environments
 * - Each environment: id, name, baseUrl, isDefault
 * - URL validation
 * - Persistence via shared storage layer (versioned root)
 *
 * No recorder/replay integration yet.
 */

import { createVersionedStore } from "../shared/storage.js";

const STORE_ROOT_KEY = "autotest_root_v1";
const STORE_SCHEMA_VERSION = 1;
const ENV_KEY = "environments";
const RECORDING_KEY = "recordings";

const store = createVersionedStore({
  rootKey: STORE_ROOT_KEY,
  schemaVersion: STORE_SCHEMA_VERSION
});

const els = {
  pageStatus: document.getElementById("pageStatus"),
  resetBtn: document.getElementById("resetBtn"),

  envList: document.getElementById("envList"),
  addEnvBtn: document.getElementById("addEnvBtn"),

  emptyState: document.getElementById("emptyState"),
  editor: document.getElementById("editor"),
  envIdText: document.getElementById("envIdText"),

  envName: document.getElementById("envName"),
  appId: document.getElementById("appId"),
  baseUrl: document.getElementById("baseUrl"),
  isDefault: document.getElementById("isDefault"),
  addVarBtn: document.getElementById("addVarBtn"),
  varsBody: document.getElementById("varsBody"),
  varsError: document.getElementById("varsError"),

  deleteEnvBtn: document.getElementById("deleteEnvBtn"),
  saveBtn: document.getElementById("saveBtn"),

  status: document.getElementById("status"),
  formErrors: document.getElementById("formErrors"),
  envNameError: document.getElementById("envNameError"),
  baseUrlError: document.getElementById("baseUrlError"),
  recordingsList: document.getElementById("recordingsList"),
  
  // Capture settings
  captureModeNone: document.getElementById("captureModeNone"),
  captureModeScreenshots: document.getElementById("captureModeScreenshots"),
  captureModeVideo: document.getElementById("captureModeVideo"),
  captureModeBoth: document.getElementById("captureModeBoth"),
  captureOnFailureOnly: document.getElementById("captureOnFailureOnly"),
  saveCaptureSettings: document.getElementById("saveCaptureSettings"),
  captureStatus: document.getElementById("captureStatus"),
  
  // Generator configuration (Claude CLI + Playwright MCP)
  // generatorUrl removed — routed via orchestrator
  generatorStatus: document.getElementById("generatorStatus"),
  testGeneratorConnection: document.getElementById("testGeneratorConnection"),
  saveGeneratorConfig: document.getElementById("saveGeneratorConfig"),

  // AI Model selection
  aiModel: document.getElementById("aiModel"),
  
  // Tab Navigation
  basicTab: document.getElementById("basicTab"),
  captureTab: document.getElementById("captureTab"),
  recordingsTab: document.getElementById("recordingsTab"),
  advancedTab: document.getElementById("advancedTab"),
  recordingsCount: document.getElementById("recordingsCount"),
  recordingsCountBadge: document.getElementById("recordingsCountBadge"),
  
  // Recordings multi-select
  selectAllRecordings: document.getElementById("selectAllRecordings"),
  deleteSelectedBtn: document.getElementById("deleteSelectedBtn"),
  selectedCount: document.getElementById("selectedCount"),
  recordingsSearch: document.getElementById("recordingsSearch"),
  recordingsTypeFilter: document.getElementById("recordingsTypeFilter"),
  
  // Playwright Runner configuration
  runnerEnabled: document.getElementById("runnerEnabled"),
  runnerFields: document.getElementById("runnerFields"),
  // runnerUrl removed — routed via orchestrator
  testRunnerConnection: document.getElementById("testRunnerConnection"),
  saveRunnerConfig: document.getElementById("saveRunnerConfig"),
  runnerConfigStatus: document.getElementById("runnerConfigStatus"),
  
  // Master AI toggle
  enableAllAI: document.getElementById("enableAllAI"),
  aiConfigCard: document.getElementById("aiConfigCard"),

  // Account / Registry
  // accountTab removed — merged into advancedTab
  backendUrl: document.getElementById("backendUrl"),
  registryEmail: document.getElementById("registryEmail"),
  registryPassword: document.getElementById("registryPassword"),
  registryLoginFields: document.getElementById("registryLoginFields"),
  registryConnectBtn: document.getElementById("registryConnectBtn"),
  registryDisconnectBtn: document.getElementById("registryDisconnectBtn"),
  registryStatus: document.getElementById("registryStatus"),
  registryInfo: document.getElementById("registryInfo"),
  registryUserName: document.getElementById("registryUserName"),
  registryAccountName: document.getElementById("registryAccountName"),
  registryProjectName: document.getElementById("registryProjectName"),
  registryRoleBadge: document.getElementById("registryRoleBadge"),
  registryContextSwitcher: document.getElementById("registryContextSwitcher"),
  registryContextSelect: document.getElementById("registryContextSelect"),
  adminPanel: document.getElementById("adminPanel"),
  testManagementPanel: document.getElementById("testManagementPanel"),
  refreshTestsBtn: document.getElementById("refreshTestsBtn"),
  remoteTestsList: document.getElementById("remoteTestsList"),
  remoteTestsStatus: document.getElementById("remoteTestsStatus"),

  // Network settings
  networkTab: document.getElementById("networkTab"),
  blockPatterns: document.getElementById("blockPatterns"),
  capturePatterns: document.getElementById("capturePatterns"),
  saveNetworkSettings: document.getElementById("saveNetworkSettings"),
  networkStatus: document.getElementById("networkStatus")
};

let state = {
  environments: [],
  selectedEnvId: null,
  dirty: false,
  selectedRecordings: new Set(),
  currentTab: 'basic',
  recordingsFilter: {
    search: '',
    type: 'all'
  }
};

function setPageStatus(text) {
  els.pageStatus.textContent = text || "";
}

function setEditorStatus(text) {
  els.status.textContent = text || "";
}

function setDirty(isDirty) {
  state.dirty = isDirty;
  if (isDirty) setEditorStatus("Unsaved changes");
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `env_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

function normalizeBaseUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return { ok: false, value: "", error: "Base URL is required." };
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, value: "", error: "Base URL must be a valid URL (including https://)." };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, value: "", error: "Base URL must start with http:// or https://." };
  }
  // Remove hash/query to keep baseUrl stable for environment abstraction.
  u.hash = "";
  u.search = "";
  let normalized = u.toString().replace(/\/+$/, "");
  return { ok: true, value: normalized, error: "" };
}

function normalizeVariables(vars) {
  if (!Array.isArray(vars)) return [];
  return vars.map((v) => ({
    key: String(v?.key || "").trim(),
    value: typeof v?.value === "string" ? v.value : String(v?.value ?? ""),
    isSecret: Boolean(v?.isSecret)
  }));
}

function validateVariables(vars) {
  if (!Array.isArray(vars)) return ["Variables must be a list."];
  const errs = [];
  const seen = new Set();
  for (const v of vars) {
    const key = String(v?.key || "").trim();
    if (!key) {
      errs.push("Variable key is required.");
      continue;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      errs.push(`Invalid variable key: "${key}" (use letters, numbers, underscore; no spaces)`);
    }
    const canon = key.toUpperCase();
    if (seen.has(canon)) errs.push(`Duplicate variable key: "${key}"`);
    seen.add(canon);
  }
  return errs;
}

function validateEnvironment(env, allEnvs) {
  const errors = {};

  const name = String(env?.name || "").trim();
  if (!name) errors.name = "Name is required.";
  const lower = name.toLowerCase();
  const dup = allEnvs.find((e) => e.id !== env.id && String(e.name || "").trim().toLowerCase() === lower);
  if (!errors.name && dup) errors.name = "Name must be unique.";

  const base = normalizeBaseUrl(env?.baseUrl);
  if (!base.ok) errors.baseUrl = base.error;

  const varsErrs = validateVariables(env?.variables || []);
  if (varsErrs.length) errors.variables = varsErrs.join("\n");

  return { ok: Object.keys(errors).length === 0, errors, normalizedBaseUrl: base.value };
}

function currentEnv() {
  return state.environments.find((e) => e.id === state.selectedEnvId) || null;
}

function clearFieldErrors() {
  els.envNameError.textContent = "";
  els.baseUrlError.textContent = "";
  els.varsError.textContent = "";
  els.formErrors.hidden = true;
  els.formErrors.textContent = "";
}

function showTopErrors(lines) {
  if (!lines || !lines.length) {
    els.formErrors.hidden = true;
    els.formErrors.textContent = "";
    return;
  }
  els.formErrors.hidden = false;
  els.formErrors.innerHTML = `<div><b>Fix the following before saving:</b></div><ul>${lines
    .map((l) => `<li>${escapeHtml(l)}</li>`)
    .join("")}</ul>`;
}

function renderEnvList() {
  els.envList.innerHTML = "";

  if (!state.environments.length) {
    const div = document.createElement("div");
    div.className = "emptyState";
    div.innerHTML =
      '<div class="emptyState__title">No environments yet</div><div class="emptyState__body">Click “Add” to create one.</div>';
    els.envList.appendChild(div);
    return;
  }

  for (const env of state.environments) {
    const row = document.createElement("div");
    row.className = "envItem" + (env.id === state.selectedEnvId ? " envItem--selected" : "");
    const pill = env.isDefault ? '<span class="pill" title="Default">Default</span>' : "";
    row.innerHTML = `
      <div class="envItem__nameRow">
        <div class="envItem__name">${escapeHtml(env.name || "(unnamed)")}</div>
        ${pill}
      </div>
      <div class="envItem__url mono">${escapeHtml(env.baseUrl || "")}</div>
    `;
    row.addEventListener("click", () => selectEnv(env.id));
    els.envList.appendChild(row);
  }
}

function renderEditor() {
  clearFieldErrors();
  const env = currentEnv();

  if (!env) {
    els.editor.hidden = true;
    els.emptyState.hidden = false;
    return;
  }

  els.editor.hidden = false;
  els.emptyState.hidden = true;

  els.envIdText.textContent = env.id;
  els.envName.value = env.name || "";
  els.appId.value = env.appId || "";
  els.baseUrl.value = env.baseUrl || "";
  els.isDefault.checked = Boolean(env.isDefault);
  renderVariables(env);
}

function renderVariables(env) {
  els.varsBody.innerHTML = "";
  const vars = normalizeVariables(env.variables);
  env.variables = vars;

  if (!vars.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="4" style="color: var(--muted)">No variables. Add one if you need environment-specific values.</td>`;
    els.varsBody.appendChild(tr);
    return;
  }

  vars.forEach((v, idx) => {
    const tr = document.createElement("tr");

    const tdKey = document.createElement("td");
    const keyInput = document.createElement("input");
    keyInput.type = "text";
    keyInput.placeholder = "VAR_NAME";
    keyInput.value = v.key || "";
    tdKey.appendChild(keyInput);

    const tdVal = document.createElement("td");
    const valInput = document.createElement("input");
    valInput.type = v.isSecret ? "password" : "text";
    valInput.placeholder = "Value";
    valInput.value = v.value || "";
    tdVal.appendChild(valInput);

    const tdSecret = document.createElement("td");
    tdSecret.style.width = "90px";
    const secretLabel = document.createElement("label");
    secretLabel.style.display = "flex";
    secretLabel.style.alignItems = "center";
    secretLabel.style.gap = "8px";
    const secretInput = document.createElement("input");
    secretInput.type = "checkbox";
    secretInput.checked = Boolean(v.isSecret);
    const secretText = document.createElement("span");
    secretText.style.color = "var(--muted)";
    secretText.textContent = "Secret";
    secretLabel.appendChild(secretInput);
    secretLabel.appendChild(secretText);
    tdSecret.appendChild(secretLabel);

    const tdDel = document.createElement("td");
    tdDel.style.width = "50px";
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn btn--ghost";
    delBtn.textContent = "✕";
    tdDel.appendChild(delBtn);

    tr.appendChild(tdKey);
    tr.appendChild(tdVal);
    tr.appendChild(tdSecret);
    tr.appendChild(tdDel);
    els.varsBody.appendChild(tr);

    keyInput.addEventListener("input", (e) => {
      updateVariable(idx, { key: e.target.value });
    });
    valInput.addEventListener("input", (e) => {
      updateVariable(idx, { value: e.target.value });
    });
    secretInput.addEventListener("change", (e) => {
      updateVariable(idx, { isSecret: e.target.checked });
      // Re-render row to switch between password/text input.
      renderEditor();
      setDirty(true);
    });
    delBtn.addEventListener("click", () => {
      deleteVariable(idx);
    });
  });
}

function selectEnv(envId) {
  state.selectedEnvId = envId;
  renderEnvList();
  renderEditor();
  setEditorStatus("");
}

function addEnvironment() {
  const env = {
    id: newId(),
    name: "New Environment",
    baseUrl: "",
    isDefault: state.environments.length === 0,
    variables: []
  };
  if (env.isDefault) {
    // Ensure single default.
    state.environments.forEach((e) => (e.isDefault = false));
  }
  state.environments.push(env);
  state.selectedEnvId = env.id;
  setDirty(true);
  renderEnvList();
  renderEditor();
}

function deleteCurrentEnvironment() {
  const env = currentEnv();
  if (!env) return;

  const ok = confirm(`Delete environment "${env.name || env.id}"?`);
  if (!ok) return;

  const wasDefault = Boolean(env.isDefault);
  state.environments = state.environments.filter((e) => e.id !== env.id);

  if (wasDefault && state.environments.length) {
    // Minimal assumption: promote first environment to default.
    state.environments[0].isDefault = true;
  }

  state.selectedEnvId = state.environments[0]?.id || null;
  setDirty(true);
  renderEnvList();
  renderEditor();
}

function applyEditorToState() {
  const env = currentEnv();
  if (!env) return;

  env.name = els.envName.value;
  env.appId = String(els.appId.value || "").trim();
  env.baseUrl = els.baseUrl.value;
  env.isDefault = Boolean(els.isDefault.checked);
  env.variables = normalizeVariables(env.variables);

  if (env.isDefault) {
    // Ensure exactly one default.
    state.environments.forEach((e) => {
      if (e.id !== env.id) e.isDefault = false;
    });
  }
}

function addVariable() {
  const env = currentEnv();
  if (!env) return;
  env.variables = normalizeVariables(env.variables);
  env.variables.push({ key: "", value: "", isSecret: false });
  setDirty(true);
  renderEditor();
}

function updateVariable(index, patch) {
  const env = currentEnv();
  if (!env) return;
  env.variables = normalizeVariables(env.variables);
  if (!env.variables[index]) env.variables[index] = { key: "", value: "", isSecret: false };
  Object.assign(env.variables[index], patch);
  setDirty(true);
}

function deleteVariable(index) {
  const env = currentEnv();
  if (!env) return;
  env.variables = normalizeVariables(env.variables).filter((_, i) => i !== index);
  setDirty(true);
  renderEditor();
}

function normalizeEnvironmentsForSave(environments) {
  // Trim fields and normalize baseUrl. Enforce single default.
  const envs = environments.map((e) => ({
    id: String(e.id || "").trim() || newId(),
    name: String(e.name || "").trim(),
    appId: String(e.appId || "").trim(),
    baseUrl: String(e.baseUrl || "").trim(),
    isDefault: Boolean(e.isDefault),
    variables: normalizeVariables(e.variables)
  }));

  // Enforce at most one default: keep first marked default; if none, mark first env.
  let foundDefault = false;
  for (const e of envs) {
    if (e.isDefault && !foundDefault) {
      foundDefault = true;
    } else {
      e.isDefault = false;
    }
  }
  if (!foundDefault && envs.length) envs[0].isDefault = true;

  // Normalize baseUrl strings.
  for (const e of envs) {
    const base = normalizeBaseUrl(e.baseUrl);
    e.baseUrl = base.ok ? base.value : e.baseUrl;
  }

  return envs;
}

function validateAll(environments) {
  const envs = normalizeEnvironmentsForSave(environments);
  const byId = {};
  let ok = true;

  // Ensure unique IDs.
  const ids = new Set();
  for (const e of envs) {
    if (ids.has(e.id)) {
      ok = false;
      byId[e.id] = { ...(byId[e.id] || {}), id: "Duplicate id." };
    }
    ids.add(e.id);
  }

  // Ensure exactly one default (or 0 if no envs).
  const defaultCount = envs.filter((e) => e.isDefault).length;
  if (envs.length && defaultCount !== 1) ok = false;

  for (const env of envs) {
    const v = validateEnvironment(env, envs);
    if (!v.ok) ok = false;
    byId[env.id] = { ...(byId[env.id] || {}), ...v.errors };
    if (v.ok) {
      env.baseUrl = v.normalizedBaseUrl;
    }
  }

  return { ok, envs, byId };
}

function showValidationForSelected(validation) {
  clearFieldErrors();
  if (validation.ok) return true;

  const env = currentEnv();
  const lines = [];

  if (!env) {
    showTopErrors(["Validation failed. Select an environment to see details."]);
    return false;
  }

  const eErr = validation.byId?.[env.id] || {};
  if (eErr.name) els.envNameError.textContent = eErr.name;
  if (eErr.baseUrl) els.baseUrlError.textContent = eErr.baseUrl;
  if (eErr.variables) els.varsError.textContent = eErr.variables;

  if (eErr.id) lines.push(eErr.id);
  if (Object.keys(eErr).length === 0) {
    // Errors might be on a different env (e.g. duplicate name).
    lines.push("One or more environments has validation errors. Select them to view details.");
  }

  showTopErrors(lines);
  return false;
}

async function saveEnvironments() {
  applyEditorToState();

  const validation = validateAll(state.environments);
  const ok = showValidationForSelected(validation);
  if (!ok) {
    setEditorStatus("Not saved — fix validation errors");
    return;
  }

  await store.set(ENV_KEY, validation.envs);
  state.environments = validation.envs;
  state.dirty = false;
  setEditorStatus("Saved");
  renderEnvList();
  renderEditor();
}

async function resetAll() {
  if (state.dirty) {
    const ok = confirm("You have unsaved changes. Reset anyway?");
    if (!ok) return;
  }
  const ok = confirm("Reset all environments? This cannot be undone.");
  if (!ok) return;

  state.environments = [];
  state.selectedEnvId = null;
  state.dirty = false;
  await store.set(ENV_KEY, []);
  renderEnvList();
  renderEditor();
  setEditorStatus("");
  setPageStatus("Reset complete");
}

function wireEvents() {
  els.addEnvBtn.addEventListener("click", () => addEnvironment());
  els.deleteEnvBtn.addEventListener("click", () => deleteCurrentEnvironment());
  els.addVarBtn.addEventListener("click", () => addVariable());
  els.saveBtn.addEventListener("click", async () => {
    try {
      await saveEnvironments();
    } catch (e) {
      console.error(e);
      setEditorStatus("Save failed — see console");
    }
  });
  els.resetBtn.addEventListener("click", async () => {
    try {
      await resetAll();
    } catch (e) {
      console.error(e);
      setPageStatus("Reset failed — see console");
    }
  });
  
  // Capture settings
  els.saveCaptureSettings.addEventListener("click", async () => {
    try {
      await saveCaptureSettings();
    } catch (e) {
      console.error(e);
      els.captureStatus.textContent = "Failed to save capture settings";
    }
  });

  // ── Replay Settings ──
  const saveReplayBtn = document.getElementById("saveReplaySettings");
  const replayStatus = document.getElementById("replaySettingsStatus");
  if (saveReplayBtn) {
    // Load existing settings
    chrome.storage.local.get(['replaySettings'], (data) => {
      const s = data.replaySettings || {};
      const retryInput = document.getElementById("defaultRetryCount");
      const softInput = document.getElementById("defaultSoftAssertions");
      const vpW = document.getElementById("viewportWidth");
      const vpH = document.getElementById("viewportHeight");
      if (retryInput && s.retryCount !== undefined) retryInput.value = s.retryCount;
      if (softInput) softInput.checked = !!s.softAssertions;
      if (vpW && s.viewportWidth) vpW.value = s.viewportWidth;
      if (vpH && s.viewportHeight) vpH.value = s.viewportHeight;
    });

    saveReplayBtn.addEventListener("click", async () => {
      const retryCount = parseInt(document.getElementById("defaultRetryCount")?.value, 10) || 0;
      const softAssertions = !!document.getElementById("defaultSoftAssertions")?.checked;
      const viewportWidth = parseInt(document.getElementById("viewportWidth")?.value, 10) || 0;
      const viewportHeight = parseInt(document.getElementById("viewportHeight")?.value, 10) || 0;
      await chrome.storage.local.set({
        replaySettings: { retryCount, softAssertions, viewportWidth, viewportHeight }
      });
      if (replayStatus) {
        replayStatus.textContent = "Replay settings saved!";
        replayStatus.style.color = "#2ecc71";
        setTimeout(() => { replayStatus.textContent = ""; }, 3000);
      }
    });
  }

  [els.envName, els.appId, els.baseUrl].forEach((el) => {
    el.addEventListener("input", () => {
      applyEditorToState();
      setDirty(true);
      renderEnvList();
    });
  });
  els.isDefault.addEventListener("change", () => {
    applyEditorToState();
    setDirty(true);
    renderEnvList();
    renderEditor(); // ensures checkbox consistency after forcing single default
  });

  els.editor.addEventListener("submit", (e) => e.preventDefault());

  window.addEventListener("beforeunload", (e) => {
    if (!state.dirty) return;
    e.preventDefault();
    e.returnValue = "";
  });
}

async function init() {
  wireEvents();
  initTabs();
  initRecordingsMultiSelect();
  setPageStatus("");

  const loaded = (await store.get(ENV_KEY)) || [];
  state.environments = Array.isArray(loaded) ? loaded : [];
  state.environments = normalizeEnvironmentsForSave(state.environments);

  state.selectedEnvId = state.environments.find((e) => e.isDefault)?.id || state.environments[0]?.id || null;

  renderEnvList();
  renderEditor();
  await renderRecordings();
  await loadCaptureSettings();
  await loadAIEnabledState();
  await loadRunnerConfig();
  await loadNetworkSettings();
  const loggedIn = await applyLoginGates();
  if (loggedIn) {
    await testGeneratorConnection();
    if (els.runnerEnabled?.checked) {
      await testRunnerConnectionFunc();
    }
  }

  if (!state.environments.length) {
    setPageStatus("Add an environment to get started");
  }
}

// ============================================
// Tab Navigation
// ============================================
function initTabs() {
  const tabButtons = document.querySelectorAll('.tabNav__tab');
  
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.dataset.tab;
      switchTab(tabId);
    });
  });
}

function switchTab(tabId) {
  state.currentTab = tabId;
  
  // Update tab buttons
  document.querySelectorAll('.tabNav__tab').forEach(btn => {
    btn.classList.toggle('tabNav__tab--active', btn.dataset.tab === tabId);
  });
  
  // Update tab content
  document.querySelectorAll('.tabContent').forEach(content => {
    content.classList.toggle('tabContent--active', content.id === `${tabId}Tab`);
  });
}

// ============================================
// Recordings Multi-Select
// ============================================
function initRecordingsMultiSelect() {
  // Select All checkbox
  els.selectAllRecordings?.addEventListener('change', (e) => {
    const isChecked = e.target.checked;
    const checkboxes = document.querySelectorAll('.recordingCheckbox');
    
    checkboxes.forEach(cb => {
      cb.checked = isChecked;
      const recordingId = cb.dataset.recordingId;
      if (isChecked) {
        state.selectedRecordings.add(recordingId);
      } else {
        state.selectedRecordings.delete(recordingId);
      }
    });
    
    updateSelectedCount();
  });
  
  // Delete Selected button
  els.deleteSelectedBtn?.addEventListener('click', async () => {
    if (state.selectedRecordings.size === 0) return;
    
    const count = state.selectedRecordings.size;
    if (!confirm(`Delete ${count} selected recording${count > 1 ? 's' : ''}? This cannot be undone.`)) {
      return;
    }
    
    await deleteSelectedRecordings();
  });
  
  // Search input
  els.recordingsSearch?.addEventListener('input', (e) => {
    state.recordingsFilter.search = e.target.value.toLowerCase();
    renderRecordings();
  });
  
  // Type filter
  els.recordingsTypeFilter?.addEventListener('change', (e) => {
    state.recordingsFilter.type = e.target.value;
    renderRecordings();
  });
}

function updateSelectedCount() {
  const count = state.selectedRecordings.size;
  if (els.selectedCount) {
    els.selectedCount.textContent = count;
  }
  if (els.deleteSelectedBtn) {
    els.deleteSelectedBtn.disabled = count === 0;
  }
  
  // Update Select All checkbox state
  const checkboxes = document.querySelectorAll('.recordingCheckbox');
  if (els.selectAllRecordings && checkboxes.length > 0) {
    const allChecked = Array.from(checkboxes).every(cb => cb.checked);
    const someChecked = Array.from(checkboxes).some(cb => cb.checked);
    els.selectAllRecordings.checked = allChecked;
    els.selectAllRecordings.indeterminate = someChecked && !allChecked;
  }
}

function toggleRecordingSelection(recordingId, isSelected) {
  if (isSelected) {
    state.selectedRecordings.add(recordingId);
  } else {
    state.selectedRecordings.delete(recordingId);
  }
  updateSelectedCount();
}

async function deleteSelectedRecordings() {
  try {
    const recordings = (await store.get(RECORDING_KEY)) || [];
    const filtered = recordings.filter(r => !state.selectedRecordings.has(r.id));
    await store.set(RECORDING_KEY, filtered);
    
    const deletedCount = state.selectedRecordings.size;
    state.selectedRecordings.clear();
    
    setPageStatus(`${deletedCount} recording${deletedCount > 1 ? 's' : ''} deleted`);
    
    // Reset Select All checkbox
    if (els.selectAllRecordings) {
      els.selectAllRecordings.checked = false;
      els.selectAllRecordings.indeterminate = false;
    }
    
    await renderRecordings();
  } catch (e) {
    console.error(e);
    setPageStatus("Failed to delete recordings — see console");
  }
}

function isNLPRecording(recording) {
  // Check if recording is NLP-based
  return recording.id?.startsWith('nlp_') || 
         recording.isNLP === true ||
         recording.steps?.some(s => s.nlDescription && !s.selector?.primary);
}

async function loadCaptureSettings() {
  const settings = await chrome.storage.local.get(['captureSettings']);
  const captureSettings = settings.captureSettings || {
    screenshots: false,
    video: false,
    onFailureOnly: false
  };
  
  // Set radio button based on screenshots and video flags
  if (captureSettings.screenshots && captureSettings.video) {
    els.captureModeBoth.checked = true;
  } else if (captureSettings.screenshots) {
    els.captureModeScreenshots.checked = true;
  } else if (captureSettings.video) {
    els.captureModeVideo.checked = true;
  } else {
    els.captureModeNone.checked = true;
  }
  
  els.captureOnFailureOnly.checked = captureSettings.onFailureOnly;
}

async function saveCaptureSettings() {
  // Get selected radio button value
  let selectedMode = 'none';
  if (els.captureModeScreenshots.checked) selectedMode = 'screenshots';
  else if (els.captureModeVideo.checked) selectedMode = 'video';
  else if (els.captureModeBoth.checked) selectedMode = 'both';
  
  const captureSettings = {
    screenshots: selectedMode === 'screenshots' || selectedMode === 'both',
    video: selectedMode === 'video' || selectedMode === 'both',
    onFailureOnly: els.captureOnFailureOnly.checked
  };
  
  await chrome.storage.local.set({ captureSettings });
  console.log("[options] Capture settings saved:", captureSettings);
  els.captureStatus.textContent = "✓ Capture settings saved successfully";
  els.captureStatus.style.color = "#4CAF50";
  setTimeout(() => {
    els.captureStatus.textContent = "";
  }, 3000);
}

function formatQueryParams(queryParams) {
  const qp = queryParams || {};
  const parts = [];
  for (const [key, values] of Object.entries(qp)) {
    if (Array.isArray(values)) {
      for (const v of values) parts.push(`${key}=${v}`);
    } else {
      parts.push(`${key}=${values}`);
    }
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

function selectorToText(selector) {
  if (!selector) return "";
  if (typeof selector === "string") return selector;
  if (selector.primary?.value) return selector.primary.value;
  return "";
}

async function renderRecordings() {
  const allRecordings = (await store.get(RECORDING_KEY)) || [];
  els.recordingsList.innerHTML = "";
  
  // Update recordings count badge
  if (els.recordingsCount) {
    els.recordingsCount.textContent = allRecordings.length;
    if (els.recordingsCountBadge) {
      els.recordingsCountBadge.textContent = allRecordings.length;
    }
  }
  
  if (!Array.isArray(allRecordings) || allRecordings.length === 0) {
    const empty = document.createElement("div");
    empty.className = "field__hint";
    empty.style.padding = "20px";
    empty.style.textAlign = "center";
    empty.textContent = "No recordings saved yet.";
    els.recordingsList.appendChild(empty);
    
    // Reset multi-select state
    state.selectedRecordings.clear();
    updateSelectedCount();
    return;
  }
  
  // Apply filters
  let recordings = allRecordings;
  
  // Filter by type
  if (state.recordingsFilter.type === 'nlp') {
    recordings = recordings.filter(r => isNLPRecording(r));
  } else if (state.recordingsFilter.type === 'manual') {
    recordings = recordings.filter(r => !isNLPRecording(r));
  }
  
  // Filter by search
  if (state.recordingsFilter.search) {
    const searchTerm = state.recordingsFilter.search.toLowerCase();
    recordings = recordings.filter(r => {
      const name = (r.name || '').toLowerCase();
      const id = (r.id || '').toLowerCase();
      const steps = r.steps || [];
      const stepsText = steps.map(s => 
        `${s.type} ${s.elementName || ''} ${s.value || ''} ${s.nlDescription || ''}`
      ).join(' ').toLowerCase();
      
      return name.includes(searchTerm) || 
             id.includes(searchTerm) || 
             stepsText.includes(searchTerm);
    });
  }
  
  if (recordings.length === 0) {
    const empty = document.createElement("div");
    empty.className = "field__hint";
    empty.style.padding = "20px";
    empty.style.textAlign = "center";
    empty.textContent = "No recordings match your filter criteria.";
    els.recordingsList.appendChild(empty);
    return;
  }
  
  // Clean up selected recordings that no longer exist
  const currentIds = new Set(recordings.map(r => r.id));
  state.selectedRecordings.forEach(id => {
    if (!currentIds.has(id)) {
      state.selectedRecordings.delete(id);
    }
  });
  updateSelectedCount();
  
  // Show filter summary
  const nlpCount = allRecordings.filter(r => isNLPRecording(r)).length;
  const manualCount = allRecordings.length - nlpCount;
  
  const summary = document.createElement("div");
  summary.className = "recordingsSummary";
  summary.style.cssText = "display: flex; gap: 16px; padding: 12px; margin-bottom: 12px; background: rgba(124, 92, 255, 0.05); border-radius: 8px; font-size: 13px;";
  summary.innerHTML = `
    <span>📊 <strong>${recordings.length}</strong> of ${allRecordings.length} recordings shown</span>
    <span style="color: var(--muted);">|</span>
    <span style="color: #4CAF50;">🤖 NLP: ${nlpCount}</span>
    <span style="color: #2196F3;">📹 Manual: ${manualCount}</span>
  `;
  els.recordingsList.appendChild(summary);

  recordings.forEach((rec, recIdx) => {
    const isNLP = isNLPRecording(rec);
    const isSelected = state.selectedRecordings.has(rec.id);
    
    const card = document.createElement("div");
    card.className = `recordingCard ${isNLP ? 'recordingCard--nlp' : 'recordingCard--manual'} ${isSelected ? 'recordingCard--selected' : ''}`;
    card.dataset.recordingId = rec.id;
    
    const header = document.createElement("div");
    header.className = "recordingHeader";
    
    // Checkbox for multi-select
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "recordingCheckbox";
    checkbox.checked = isSelected;
    checkbox.dataset.recordingId = rec.id;
    checkbox.addEventListener("change", (e) => {
      toggleRecordingSelection(rec.id, e.target.checked);
      card.classList.toggle('recordingCard--selected', e.target.checked);
    });
    
    const titleWrap = document.createElement("div");
    titleWrap.style.display = "flex";
    titleWrap.style.alignItems = "center";
    titleWrap.style.gap = "10px";
    titleWrap.style.flex = "1";
    
    const title = document.createElement("div");
    title.className = "recordingTitle";
    title.textContent = rec.name || "(unnamed)";
    
    // Type badge
    const typeBadge = document.createElement("span");
    typeBadge.className = `recordingTypeBadge ${isNLP ? 'recordingTypeBadge--nlp' : 'recordingTypeBadge--manual'}`;
    typeBadge.textContent = isNLP ? 'NLP' : 'Manual';
    
    titleWrap.appendChild(title);
    titleWrap.appendChild(typeBadge);
    
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn btn--danger btn--small";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete recording "${rec.name || "(unnamed)"}"?`)) return;
      await deleteRecording(rec.id);
    });
    
    header.appendChild(checkbox);
    header.appendChild(titleWrap);
    header.appendChild(deleteBtn);
    
    const meta = document.createElement("div");
    meta.className = "recordingMeta";
    meta.style.marginLeft = "28px"; // Align with title after checkbox
    meta.textContent = `Steps: ${rec.steps?.length || 0} • Created: ${rec.createdAt || ""} • ID: ${rec.id}`;
    
    card.appendChild(header);
    card.appendChild(meta);

    const stepsWrap = document.createElement("div");
    stepsWrap.className = "recordingSteps";
    
    // Group steps by page (matching HUD logic)
    const pageGroups = [];
    let currentPage = null;
    let currentGroup = [];
    
    (rec.steps || []).forEach((step, idx) => {
      const pagePath = step.relativePath || '/';
      
      if (pagePath !== currentPage) {
        if (currentGroup.length > 0) {
          pageGroups.push({ page: currentPage, steps: currentGroup });
        }
        currentPage = pagePath;
        currentGroup = [{ step, idx }];
      } else {
        currentGroup.push({ step, idx });
      }
    });
    
    if (currentGroup.length > 0) {
      pageGroups.push({ page: currentPage, steps: currentGroup });
    }
    
    // Color palette (matching HUD)
    const pageColors = [
      { bg: 'rgba(52, 152, 219, 0.1)', border: '#3498db', text: '#3498db' },   // Blue
      { bg: 'rgba(155, 89, 182, 0.1)', border: '#9b59b6', text: '#9b59b6' },   // Purple
      { bg: 'rgba(26, 188, 156, 0.1)', border: '#1abc9c', text: '#1abc9c' },   // Teal
      { bg: 'rgba(230, 126, 34, 0.1)', border: '#e67e22', text: '#e67e22' },   // Orange
      { bg: 'rgba(231, 76, 60, 0.1)', border: '#e74c3c', text: '#e74c3c' },    // Red
      { bg: 'rgba(241, 196, 15, 0.1)', border: '#f1c40f', text: '#f1c40f' },   // Yellow
      { bg: 'rgba(46, 204, 113, 0.1)', border: '#2ecc71', text: '#2ecc71' },   // Green
      { bg: 'rgba(52, 73, 94, 0.1)', border: '#34495e', text: '#34495e' }      // Gray
    ];
    
    // Render each page group
    pageGroups.forEach((group, groupIdx) => {
      const color = pageColors[groupIdx % pageColors.length];
      
      // Add page header
      const pageHeader = document.createElement('div');
      pageHeader.style.cssText = `
        padding: 8px 12px;
        margin: 12px 0 4px 0;
        background: ${color.bg};
        border-left: 3px solid ${color.border};
        border-radius: 4px;
        font-size: 11px;
        font-weight: 600;
        color: ${color.text};
        display: flex;
        align-items: center;
        gap: 6px;
      `;
      pageHeader.innerHTML = `
        <span style="opacity: 0.7;">📄 Page ${groupIdx + 1}:</span>
        <span style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(group.page)}">${escapeHtml(group.page)}</span>
        <span style="opacity: 0.6; font-size: 10px;">(${group.steps.length} steps)</span>
      `;
      stepsWrap.appendChild(pageHeader);
      
      // Render steps for this page
      group.steps.forEach(({ step, idx }) => {
        const row = document.createElement("div");
        row.className = "recordingStepRow";
        row.style.borderLeft = `3px solid ${color.border}`;
        row.style.marginLeft = '4px';
        
        const label = document.createElement("div");
        label.className = "recordingLabel";
        
        // Use the same display logic as HUD
        const displayName = getStepDisplayNameForOptions(step);
        label.textContent = `${idx + 1}. ${displayName}`;
        
        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "btn btn--ghost btn--small";
        editBtn.textContent = "✎ Edit";
        editBtn.style.marginLeft = "auto";
        editBtn.addEventListener("click", () => {
          openStepEditor(rec, idx);
        });
        
        row.appendChild(label);
        row.appendChild(editBtn);
        stepsWrap.appendChild(row);
      });
    });
    
    card.appendChild(stepsWrap);
    els.recordingsList.appendChild(card);
  });
}

// Helper function to generate step display name (matching HUD logic exactly)
function getStepDisplayNameForOptions(step) {
  // Priority 0: Use custom name if set (user-edited name always wins)
  if (step.customName?.trim()) {
    let name = `${step.type.toUpperCase()}: ${step.customName.trim()}`;
    // Add value for input steps
    if ((step.type === 'input' || step.type === 'change') && step.value) {
      const displayValue = String(step.value).substring(0, 30);
      name += ` "${displayValue}${step.value.length > 30 ? '...' : ''}"`;
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
      const displayValue = String(step.value).substring(0, 30);
      name += ` "${displayValue}${step.value.length > 30 ? '...' : ''}"`;
    }
    return name;
  }
  
  // Priority 2: Extract meaningful name from selector (user-visible text first!)
  const selector = step.selector?.primary?.value || step.selector;
  if (typeof selector === 'string' && selector) {
    // Try to extract from common attributes in priority order
    let extracted = null;
    
    // 1. aria-label (highest semantic value)
    let match = selector.match(/\[aria-label=["']([^"']+)["']\]/i) || 
                selector.match(/\[aria-label=\\["']([^"']+)\\["']\]/i);
    if (match) extracted = match[1];
    
    // 2. placeholder (what users see in the input field)
    if (!extracted) {
      match = selector.match(/\[placeholder=["']([^"']+)["']\]/i) || 
              selector.match(/\[placeholder=\\["']([^"']+)\\["']\]/i);
      if (match) extracted = match[1];
    }
    
    // 3. title (tooltip text - often descriptive)
    if (!extracted) {
      match = selector.match(/\[title=["']([^"']+)["']\]/i) || 
              selector.match(/\[title=\\["']([^"']+)\\["']\]/i);
      if (match) extracted = match[1];
    }
    
    // 4. name attribute (form field names are often meaningful)
    if (!extracted) {
      match = selector.match(/\[name=["']([^"']+)["']\]/i);
      if (match) {
        const name = match[1].replace(/-/g, ' ').replace(/_/g, ' ');
        // Only use if it's not too technical
        if (!name.match(/^(ctrl|field|input|txt|btn)\d+/i)) {
          extracted = name;
        }
      }
    }
    
    // 5. data-testid or data-test (test IDs are often semantic)
    if (!extracted) {
      match = selector.match(/\[data-(?:testid|test)=["']([^"']+)["']\]/i);
      if (match) extracted = match[1].replace(/-/g, ' ').replace(/_/g, ' ');
    }
    
    // 6. id attribute (clean up)
    if (!extracted) {
      match = selector.match(/#([a-zA-Z0-9_-]+)/);
      if (match) {
        const id = match[1];
        // Filter out generic IDs
        if (!id.match(/^(input|btn|field|txt|div|span)\d+$/i)) {
          extracted = id
            .replace(/-/g, ' ')
            .replace(/_/g, ' ')
            .replace(/([a-z])([A-Z])/g, '$1 $2'); // camelCase to spaces
        }
      }
    }
    
    // 7. role attribute
    if (!extracted) {
      match = selector.match(/\[role=["']([^"']+)["']\]/i);
      if (match) {
        const role = match[1];
        extracted = role.charAt(0).toUpperCase() + role.slice(1);
      }
    }
    
    // If we extracted something meaningful, use it
    if (extracted) {
      // Clean and capitalize
      extracted = extracted
        .trim()
        .split(' ')
        .filter(word => word.length > 0)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
      
      let name = `${step.type.toUpperCase()}: ${extracted}`;
      
      // Add value for input steps
      if ((step.type === 'input' || step.type === 'change') && step.value) {
        const displayValue = String(step.value).substring(0, 30);
        name += ` "${displayValue}${step.value.length > 30 ? '...' : ''}"`;
      }
      
      return name;
    }
  }
  
  // Priority 3: For navigation, show the relative path
  if (step.type === 'navigation' && step.relativePath) {
    return `NAVIGATION: ${step.relativePath}`;
  }
  
  // Priority 4: Just show type and value for input steps
  if ((step.type === 'input' || step.type === 'change') && step.value) {
    const displayValue = String(step.value).substring(0, 40);
    return `${step.type.toUpperCase()}: "${displayValue}${step.value.length > 40 ? '...' : ''}"`;
  }
  
  // Default: just the type
  return step.type.toUpperCase();
}

async function deleteRecording(recordingId) {
  try {
    const recordings = (await store.get(RECORDING_KEY)) || [];
    const filtered = recordings.filter((r) => r.id !== recordingId);
    await store.set(RECORDING_KEY, filtered);
    setPageStatus("Recording deleted");
    await renderRecordings();
  } catch (e) {
    console.error(e);
    setPageStatus("Failed to delete recording — see console");
  }
}

function openStepEditor(recording, stepIndex) {
  const step = recording.steps[stepIndex];
  if (!step) return;
  
  // Create modal backdrop
  const backdrop = document.createElement("div");
  backdrop.className = "modalBackdrop";
  backdrop.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  `;
  
  // Create modal
  const modal = document.createElement("div");
  modal.className = "stepEditorModal";
  modal.style.cssText = `
    background: var(--panel);
    border-radius: 8px;
    padding: 24px;
    max-width: 700px;
    width: 100%;
    max-height: 90vh;
    overflow-y: auto;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  `;
  
  const selectorPrimary = typeof step.selector === 'string' ? step.selector : (step.selector?.primary?.value || '');
  const selectorType = typeof step.selector === 'string' ? 'css' : (step.selector?.primary?.type || 'css');
  const selectorReason = typeof step.selector === 'string' ? '' : (step.selector?.primary?.reason || '');
  const matchIndex = typeof step.selector === 'string' ? '' : (step.selector?.primary?.matchIndex ?? '');
  const matchCount = typeof step.selector === 'string' ? '' : (step.selector?.primary?.matchCount ?? '');
  const fallbackSelectors = (typeof step.selector === 'object' && Array.isArray(step.selector?.fallbacks)) 
    ? step.selector.fallbacks 
    : [];
  
  // Build fallback selector display
  let fallbacksHtml = `
    <div class="field">
      <label class="field__label">Fallback Selectors (${fallbackSelectors.length})</label>
      <div id="fallbackSelectorsContainer" style="background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: 4px; padding: 8px; max-height: 240px; overflow-y: auto;">
        ${fallbackSelectors.map((fb, idx) => `
          <div class="fallbackSelectorRow" data-index="${idx}" style="padding: 8px; margin-bottom: 8px; background: rgba(0,0,0,0.2); border-radius: 4px; border: 1px solid var(--border);">
            <div style="display: flex; gap: 8px; margin-bottom: 4px;">
              <select class="fallback-type input" style="width: 120px; padding: 4px 8px; font-size: 12px;" data-index="${idx}">
                <option value="css" ${fb.type === 'css' ? 'selected' : ''}>CSS</option>
                <option value="xpath" ${fb.type === 'xpath' ? 'selected' : ''}>XPath</option>
                <option value="text" ${fb.type === 'text' ? 'selected' : ''}>Text</option>
              </select>
              <button class="btn btn--danger btn--small removeFallback" data-index="${idx}" style="padding: 4px 8px; font-size: 11px;">✕ Remove</button>
            </div>
            <textarea class="fallback-value input" data-index="${idx}" rows="2" style="width: 100%; font-size: 12px; font-family: monospace; padding: 6px;">${escapeHtml(fb.value || '')}</textarea>
          </div>
        `).join('')}
      </div>
      <button id="addFallbackSelector" class="btn btn--secondary" style="margin-top: 8px; padding: 6px 12px; font-size: 12px;">+ Add Fallback Selector</button>
      <div class="field__hint">Backup selectors tried if primary fails (in order)</div>
    </div>
  `;
  
  // Query params display
  const queryParamsStr = step.queryParams ? JSON.stringify(step.queryParams, null, 2) : '';
  
  modal.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
      <div>
        <h2 style="margin: 0; font-size: 18px; font-weight: 600;">Edit Step ${stepIndex + 1}</h2>
        <div style="font-size: 12px; color: var(--muted); margin-top: 4px;">
          Timestamp: ${step.timestamp ? new Date(step.timestamp).toLocaleString() : 'N/A'}
        </div>
      </div>
      <button id="closeStepEditor" class="btn btn--ghost" style="padding: 4px 8px;">✕</button>
    </div>
    
    <div class="field">
      <label class="field__label">Step Type</label>
      <select id="stepType" class="input">
        <option value="click" ${step.type === 'click' ? 'selected' : ''}>Click</option>
        <option value="input" ${step.type === 'input' ? 'selected' : ''}>Input</option>
        <option value="change" ${step.type === 'change' ? 'selected' : ''}>Change</option>
        <option value="submit" ${step.type === 'submit' ? 'selected' : ''}>Submit</option>
        <option value="navigation" ${step.type === 'navigation' ? 'selected' : ''}>Navigation</option>
      </select>
    </div>
    
    <div class="field">
      <label class="field__label">Custom Step Name</label>
      <input id="customStepName" class="input" type="text" value="${escapeHtml(step.customName || '')}" placeholder="e.g., Submit Order Button" />
      <div class="field__hint">User-friendly name for this step (overrides auto-generated name)</div>
    </div>
    
    <div class="field">
      <label class="field__label">Element Name (auto-captured)</label>
      <input id="elementName" class="input" type="text" value="${escapeHtml(step.elementName || '')}" placeholder="e.g., Submit Button" readonly style="opacity: 0.6;" />
      <div class="field__hint">Auto-captured name from aria-label, placeholder, name, or id</div>
    </div>
    
    <div class="field">
      <label class="field__label">Value</label>
      <input id="stepValue" class="input" type="text" value="${escapeHtml(step.value || '')}" placeholder="e.g., test@example.com" />
      <div class="field__hint">For input/change steps, the value to enter</div>
    </div>
    
    <div style="border-top: 1px solid var(--border); padding-top: 16px; margin-top: 16px;">
      <h3 style="margin: 0 0 12px 0; font-size: 14px; font-weight: 600;">Selector Configuration</h3>
      
      <div class="field">
        <label class="field__label">Primary Selector Type</label>
        <select id="selectorType" class="input">
          <option value="css" ${selectorType === 'css' ? 'selected' : ''}>CSS Selector</option>
          <option value="xpath" ${selectorType === 'xpath' ? 'selected' : ''}>XPath</option>
          <option value="text" ${selectorType === 'text' ? 'selected' : ''}>Text Content</option>
        </select>
      </div>
      
      <div class="field">
        <label class="field__label">Primary Selector Value</label>
        <textarea id="selectorValue" class="input" rows="3" placeholder="e.g., #submit-button">${escapeHtml(selectorPrimary)}</textarea>
        <div class="field__hint">The primary selector to find the element</div>
      </div>
      
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
        <div class="field">
          <label class="field__label">Match Index</label>
          <input id="matchIndex" class="input" type="number" value="${matchIndex}" placeholder="0" />
          <div class="field__hint">If multiple matches, which one (0-based)</div>
        </div>
        
        <div class="field">
          <label class="field__label">Match Count</label>
          <input id="matchCount" class="input" type="number" value="${matchCount}" placeholder="1" readonly style="opacity: 0.6;" />
          <div class="field__hint">Total matches found during recording</div>
        </div>
      </div>
      
      <div class="field">
        <label class="field__label">Selector Reason</label>
        <input id="selectorReason" class="input" type="text" value="${escapeHtml(selectorReason)}" placeholder="Why this selector was chosen" />
        <div class="field__hint">Explanation of why this selector was chosen</div>
      </div>
      
      ${fallbacksHtml}
    </div>
    
    <div style="border-top: 1px solid var(--border); padding-top: 16px; margin-top: 16px;">
      <h3 style="margin: 0 0 12px 0; font-size: 14px; font-weight: 600;">URL & Environment</h3>
      
      <div class="field">
        <label class="field__label">Relative Path</label>
        <input id="relativePath" class="input" type="text" value="${escapeHtml(step.relativePath || '')}" placeholder="/page/path" />
        <div class="field__hint">The URL path for this step (relative to environment base URL)</div>
      </div>
      
      ${queryParamsStr ? `
        <div class="field">
          <label class="field__label">Query Parameters (JSON)</label>
          <textarea id="queryParams" class="input" rows="3" placeholder="{}">${escapeHtml(queryParamsStr)}</textarea>
          <div class="field__hint">URL query parameters as JSON object</div>
        </div>
      ` : ''}
      
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
        <div class="field">
          <label class="field__label">Environment ID</label>
          <input class="input" type="text" value="${escapeHtml(step.envId || '')}" readonly style="opacity: 0.6;" />
          <div class="field__hint">Recorded environment</div>
        </div>
        
        <div class="field">
          <label class="field__label">App ID</label>
          <input class="input" type="text" value="${escapeHtml(step.appId || '')}" readonly style="opacity: 0.6;" />
          <div class="field__hint">Application identifier</div>
        </div>
      </div>
    </div>
    
    ${step.meta?.matchInfo ? `
      <div style="border-top: 1px solid var(--border); padding-top: 16px; margin-top: 16px;">
        <h3 style="margin: 0 0 12px 0; font-size: 14px; font-weight: 600;">Debug Info</h3>
        <pre style="background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: 4px; padding: 8px; font-size: 11px; overflow-x: auto; margin: 0;">${escapeHtml(JSON.stringify(step.meta.matchInfo, null, 2))}</pre>
      </div>
    ` : ''}
    
    <div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--border);">
      <button id="cancelStepEdit" class="btn btn--ghost">Cancel</button>
      <button id="saveStepEdit" class="btn btn--primary">Save Changes</button>
    </div>
  `;
  
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  
  // Wire up events
  const closeBtn = modal.querySelector('#closeStepEditor');
  const cancelBtn = modal.querySelector('#cancelStepEdit');
  const saveBtn = modal.querySelector('#saveStepEdit');
  
  const close = () => {
    backdrop.remove();
  };
  
  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  
  saveBtn.addEventListener('click', async () => {
    const newType = modal.querySelector('#stepType').value;
    const newSelectorType = modal.querySelector('#selectorType').value;
    const newSelectorValue = modal.querySelector('#selectorValue').value;
    const newSelectorReason = modal.querySelector('#selectorReason').value;
    const newMatchIndex = modal.querySelector('#matchIndex').value;
    const newMatchCount = modal.querySelector('#matchCount').value;
    const newCustomStepName = modal.querySelector('#customStepName').value;
    const newElementName = modal.querySelector('#elementName').value;
    const newValue = modal.querySelector('#stepValue').value;
    const newRelativePath = modal.querySelector('#relativePath').value;
    const queryParamsEl = modal.querySelector('#queryParams');
    
    // Parse query params if field exists
    let newQueryParams = step.queryParams;
    if (queryParamsEl) {
      try {
        newQueryParams = JSON.parse(queryParamsEl.value || '{}');
      } catch (e) {
        alert('Invalid JSON in query parameters: ' + e.message);
        return;
      }
    }
    
    // Collect fallback selectors from editable fields
    const fallbackRows = modal.querySelectorAll('.fallbackSelectorRow');
    const newFallbacks = [];
    fallbackRows.forEach((row) => {
      const type = row.querySelector('.fallback-type').value;
      const value = row.querySelector('.fallback-value').value.trim();
      if (value) { // Only include non-empty fallbacks
        newFallbacks.push({ type, value });
      }
    });
    
    // Update the step
    step.type = newType;
    step.customName = newCustomStepName?.trim() || null;
    step.elementName = newElementName || step.elementName; // Keep original if not changed
    step.value = newValue;
    step.relativePath = newRelativePath;
    step.queryParams = newQueryParams;
    
    console.log('[options] Updating step with customName:', step.customName);
    
    // Update selector
    if (typeof step.selector === 'string') {
      step.selector = {
        primary: {
          type: newSelectorType,
          value: newSelectorValue,
          reason: newSelectorReason || 'Manually edited',
          matchIndex: newMatchIndex ? parseInt(newMatchIndex, 10) : undefined,
          matchCount: newMatchCount ? parseInt(newMatchCount, 10) : undefined
        },
        fallbacks: newFallbacks
      };
    } else {
      step.selector = step.selector || { primary: null, fallbacks: [] };
      step.selector.primary = {
        type: newSelectorType,
        value: newSelectorValue,
        reason: newSelectorReason || step.selector.primary?.reason || 'Manually edited',
        matchIndex: newMatchIndex ? parseInt(newMatchIndex, 10) : step.selector.primary?.matchIndex,
        matchCount: newMatchCount ? parseInt(newMatchCount, 10) : step.selector.primary?.matchCount
      };
      // Update with edited fallbacks
      step.selector.fallbacks = newFallbacks;
      // Preserve meta if it exists
      if (step.selector.meta) {
        step.selector.meta = step.selector.meta;
      }
    }
    
    // Save to storage
    try {
      const recordings = (await store.get(RECORDING_KEY)) || [];
      const recIdx = recordings.findIndex(r => r.id === recording.id);
      if (recIdx >= 0) {
        recordings[recIdx] = recording;
        recordings[recIdx].updatedAt = new Date().toISOString();
        console.log('[options] Saving recording:', recordings[recIdx].id, 'Step', stepIndex, 'customName:', recordings[recIdx].steps[stepIndex].customName);
        await store.set(RECORDING_KEY, recordings);
        setPageStatus("Step updated successfully");
        await renderRecordings();
        close();
      } else {
        console.error('[options] Recording not found in storage:', recording.id);
        alert("Recording not found in storage");
      }
    } catch (e) {
      console.error('[options] Error saving step:', e);
      alert("Failed to save step changes: " + e.message);
    }
  });
  
  // Add event listener for adding new fallback selectors
  const addFallbackBtn = modal.querySelector('#addFallbackSelector');
  if (addFallbackBtn) {
    addFallbackBtn.addEventListener('click', () => {
      const container = modal.querySelector('#fallbackSelectorsContainer');
      const currentCount = container.querySelectorAll('.fallbackSelectorRow').length;
      const newRow = document.createElement('div');
      newRow.className = 'fallbackSelectorRow';
      newRow.setAttribute('data-index', currentCount);
      newRow.style.cssText = 'padding: 8px; margin-bottom: 8px; background: rgba(0,0,0,0.2); border-radius: 4px; border: 1px solid var(--border);';
      newRow.innerHTML = `
        <div style="display: flex; gap: 8px; margin-bottom: 4px;">
          <select class="fallback-type input" style="width: 120px; padding: 4px 8px; font-size: 12px;" data-index="${currentCount}">
            <option value="css" selected>CSS</option>
            <option value="xpath">XPath</option>
            <option value="text">Text</option>
          </select>
          <button class="btn btn--danger btn--small removeFallback" data-index="${currentCount}" style="padding: 4px 8px; font-size: 11px;">✕ Remove</button>
        </div>
        <textarea class="fallback-value input" data-index="${currentCount}" rows="2" style="width: 100%; font-size: 12px; font-family: monospace; padding: 6px;" placeholder="Enter selector value..."></textarea>
      `;
      container.appendChild(newRow);
      
      // Add remove handler for the new row
      const removeBtn = newRow.querySelector('.removeFallback');
      removeBtn.addEventListener('click', () => {
        newRow.remove();
        // Update label count
        const label = modal.querySelector('.field__label');
        const remainingCount = container.querySelectorAll('.fallbackSelectorRow').length;
        if (label && label.textContent.includes('Fallback Selectors')) {
          label.textContent = `Fallback Selectors (${remainingCount})`;
        }
      });
      
      // Update label count
      const label = modal.querySelector('.field__label');
      if (label && label.textContent.includes('Fallback Selectors')) {
        label.textContent = `Fallback Selectors (${currentCount + 1})`;
      }
    });
  }
  
  // Add event listeners for removing fallback selectors
  const removeFallbackBtns = modal.querySelectorAll('.removeFallback');
  removeFallbackBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const row = btn.closest('.fallbackSelectorRow');
      if (row) {
        row.remove();
        // Update label count
        const container = modal.querySelector('#fallbackSelectorsContainer');
        const remainingCount = container.querySelectorAll('.fallbackSelectorRow').length;
        const label = modal.querySelector('.field__label');
        if (label && label.textContent.includes('Fallback Selectors')) {
          label.textContent = `Fallback Selectors (${remainingCount})`;
        }
      }
    });
  });
}

// ============ Generator Configuration (Claude CLI + Playwright MCP) ============

const DEFAULT_BACKEND_URL = 'http://localhost:8000';

async function getBackendUrl() {
  try {
    const result = await chrome.storage.local.get(['backendConfig']);
    const config = result.backendConfig || {};
    return (config.url || DEFAULT_BACKEND_URL).replace(/\/+$/, '');
  } catch {
    return DEFAULT_BACKEND_URL;
  }
}

async function getGeneratorUrl() {
  return `${await getBackendUrl()}/generator`;
}

async function isRegistryLoggedIn() {
  const result = await chrome.storage.local.get(['registryConfig']);
  const config = result.registryConfig || {};
  return config.connected === true && !!config.sessionToken;
}

async function loadGeneratorConfig() {
  const result = await chrome.storage.local.get(['generatorConfig']);
  const config = result.generatorConfig || {};

  // Restore model selection (default: Claude Opus 4.6)
  if (els.aiModel) {
    els.aiModel.value = config.model || 'claude-opus-4-6';
  }
}

async function saveGeneratorConfigFunc() {
  if (!(await isRegistryLoggedIn())) {
    els.generatorStatus.textContent = 'Login required to save AI Generator settings.';
    els.generatorStatus.style.color = '#ff9800';
    return;
  }

  els.generatorStatus.textContent = 'Saving configuration...';
  els.generatorStatus.style.color = '#666';

  try {
    const config = {
      model: els.aiModel?.value || '',
    };
    await chrome.storage.local.set({ generatorConfig: config });
    els.generatorStatus.textContent = 'Configuration saved';
    els.generatorStatus.style.color = '#4CAF50';
  } catch (err) {
    console.error('[options] Failed to save generator config:', err);
    els.generatorStatus.textContent = `Error: ${err.message}`;
    els.generatorStatus.style.color = '#f44336';
  }
}

/**
 * Render (or update) an IP whitelist info box below the connection status.
 * Shows outbound IPs that need to be whitelisted in bot-prevention systems (Akamai, etc.).
 */
function _renderIpWhitelistBox(id, parentEl, ips, serviceName) {
  let box = document.getElementById(id);
  if (!ips || ips.length === 0) {
    if (box) box.remove();
    return;
  }
  if (!box) {
    box = document.createElement('div');
    box.id = id;
    box.className = 'infoBox infoBox--muted';
    box.style.marginTop = '10px';
    parentEl.appendChild(box);
  }
  box.innerHTML = `
    <strong style="display:block; margin-bottom:6px;">🛡️ ${serviceName} Outbound IPs — Whitelist for Bot Prevention</strong>
    <div style="font-size:12px; color:#888; margin-bottom:8px;">
      Sites behind bot-prevention (Akamai, Cloudflare, etc.) may block requests from the backend.
      Whitelist these IPs to allow ${serviceName.toLowerCase()} access:
    </div>
    <div style="display:flex; gap:8px; flex-wrap:wrap;">
      ${ips.map(ip => `<code style="background:var(--border); padding:4px 10px; border-radius:4px; font-size:13px; font-family:monospace; user-select:all;">${ip}</code>`).join('')}
    </div>
    <button class="btn btn--ghost" style="margin-top:8px; font-size:11px; padding:3px 10px;"
      onclick="navigator.clipboard.writeText('${ips.join(', ')}').then(()=>{this.textContent='Copied!'; setTimeout(()=>this.textContent='Copy IPs',1500)})">
      Copy IPs
    </button>
  `;
}

async function testGeneratorConnection() {
  const statusEl = els.generatorStatus;
  const btn = els.testGeneratorConnection;
  const loginSection = document.getElementById('claudeLoginSection');
  if (btn) btn.disabled = true;
  if (loginSection) loginSection.style.display = 'none';

  const loggedIn = await isRegistryLoggedIn();
  if (!loggedIn) {
    statusEl.textContent = 'Login required to test AI Generator connection.';
    statusEl.style.color = '#ff9800';
    statusEl.style.whiteSpace = 'normal';
    _renderIpWhitelistBox('generatorIpInfo', statusEl.parentElement, [], 'Generator');
    if (btn) btn.disabled = false;
    return;
  }

  statusEl.textContent = 'Testing connection...';
  statusEl.style.color = '#666';

  try {
    const url = await getGeneratorUrl();
    const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(20000) });
    if (resp.ok) {
      const data = await resp.json();
      const claudeOk = data.claude_available && data.claude_authenticated === true;
      const ips = data.outbound_ips || [];

      if (!data.claude_available) {
        statusEl.textContent = 'Connected — Claude CLI not found. Install: npm i -g @anthropic-ai/claude-code';
        statusEl.style.color = '#f44336';
      } else if (!claudeOk) {
        statusEl.textContent = 'Connected — Claude CLI not authenticated';
        statusEl.style.color = '#ff9800';
        if (loginSection) loginSection.style.display = 'block';
      } else {
        let statusText = 'Connected — Claude CLI ready';
        if (ips.length > 0) {
          statusText += `\nOutbound IPs (whitelist for bot prevention): ${ips.join(', ')}`;
        }
        statusEl.textContent = statusText;
        statusEl.style.whiteSpace = 'pre-line';
        statusEl.style.color = '#4CAF50';
      }

      // Show/update the IP info box
      _renderIpWhitelistBox('generatorIpInfo', statusEl.parentElement, ips, 'Generator');
    } else {
      statusEl.textContent = `Generator returned ${resp.status}`;
      statusEl.style.color = '#f44336';
      _renderIpWhitelistBox('generatorIpInfo', statusEl.parentElement, [], 'Generator');
    }
  } catch (err) {
    statusEl.textContent = 'Not connected — start the Generator service (python3 backend/generator.py)';
    statusEl.style.color = '#f44336';
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Claude Login Flow (PTY-based with code paste) ──

async function startClaudeLogin() {
  const loginStatus = document.getElementById('claudeLoginStatus');
  const loginPrompt = document.getElementById('claudeLoginPrompt');
  const loginUrlSection = document.getElementById('claudeLoginUrl');
  const loginLink = document.getElementById('claudeLoginLink');

  if (loginStatus) {
    loginStatus.textContent = 'Starting login...';
    loginStatus.style.color = '#666';
  }

  try {
    const url = await getGeneratorUrl();
    const resp = await fetch(`${url}/auth/login`, {
      method: 'POST',
      signal: AbortSignal.timeout(30000)
    });
    const data = await resp.json();

    if (data.ok && data.login_url) {
      if (loginPrompt) loginPrompt.style.display = 'none';
      if (loginUrlSection) loginUrlSection.style.display = 'block';
      if (loginLink) loginLink.href = data.login_url;
      if (loginStatus) loginStatus.textContent = '';
    } else if (data.ok && data.already_authenticated) {
      if (loginStatus) {
        loginStatus.textContent = 'Already authenticated!';
        loginStatus.style.color = '#4CAF50';
      }
      setTimeout(testGeneratorConnection, 1000);
    } else {
      if (loginStatus) {
        loginStatus.textContent = `Login failed: ${data.error || 'unknown error'}`;
        loginStatus.style.color = '#f44336';
      }
    }
  } catch (err) {
    if (loginStatus) {
      loginStatus.textContent = `Login request failed: ${err.message}`;
      loginStatus.style.color = '#f44336';
    }
  }
}

async function submitClaudeCode() {
  const codeInput = document.getElementById('claudeAuthCode');
  const loginStatus = document.getElementById('claudeLoginStatus');
  const code = codeInput?.value?.trim();

  if (!code) {
    if (loginStatus) {
      loginStatus.textContent = 'Please paste the authorization code.';
      loginStatus.style.color = '#ff9800';
    }
    return;
  }

  if (loginStatus) {
    loginStatus.textContent = 'Submitting code to Claude CLI...';
    loginStatus.style.color = '#666';
  }

  try {
    const url = await getGeneratorUrl();
    const resp = await fetch(`${url}/auth/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(45000)
    });
    const data = await resp.json();

    if (data.ok) {
      if (loginStatus) {
        loginStatus.textContent = 'Authentication successful!';
        loginStatus.style.color = '#4CAF50';
      }
      setTimeout(() => {
        const loginSection = document.getElementById('claudeLoginSection');
        if (loginSection) loginSection.style.display = 'none';
        testGeneratorConnection();
      }, 1500);
    } else {
      resetLoginUI();
      if (loginStatus) {
        loginStatus.textContent = `Authentication failed: ${data.error || 'unknown error'}`;
        loginStatus.style.color = '#f44336';
      }
    }
  } catch (err) {
    resetLoginUI();
    if (loginStatus) {
      loginStatus.textContent = `Request failed: ${err.message}`;
      loginStatus.style.color = '#f44336';
    }
  }
}

function resetLoginUI() {
  const loginPrompt = document.getElementById('claudeLoginPrompt');
  const loginUrlSection = document.getElementById('claudeLoginUrl');
  const codeInput = document.getElementById('claudeAuthCode');
  if (loginPrompt) loginPrompt.style.display = 'block';
  if (loginUrlSection) loginUrlSection.style.display = 'none';
  if (codeInput) codeInput.value = '';
}

if (els.testGeneratorConnection) {
  els.testGeneratorConnection.addEventListener('click', testGeneratorConnection);
}
if (els.saveGeneratorConfig) {
  els.saveGeneratorConfig.addEventListener('click', saveGeneratorConfigFunc);
}

// Wire Claude login buttons
document.getElementById('startClaudeLogin')?.addEventListener('click', startClaudeLogin);
document.getElementById('submitClaudeCode')?.addEventListener('click', submitClaudeCode);

// Load config and auto-check on load
loadGeneratorConfig();

// ============================================================
// Playwright Runner Configuration
// ============================================================

async function loadRunnerConfig() {
  const result = await chrome.storage.local.get(['runnerConfig']);
  const config = result.runnerConfig || { enabled: false };

  els.runnerEnabled.checked = config.enabled;
  updateRunnerFields();
}

function updateRunnerFields() {
  if (els.runnerFields) {
    els.runnerFields.style.display = els.runnerEnabled.checked ? 'block' : 'none';
  }
}

async function saveRunnerConfigFunc() {
  els.runnerConfigStatus.textContent = 'Saving configuration...';
  els.runnerConfigStatus.style.color = '#666';

  try {
    const config = {
      enabled: els.runnerEnabled.checked,
    };

    await chrome.storage.local.set({ runnerConfig: config });

    els.runnerConfigStatus.textContent = 'Configuration saved';
    els.runnerConfigStatus.style.color = '#4CAF50';
  } catch (err) {
    console.error('[options] Failed to save runner config:', err);
    els.runnerConfigStatus.textContent = `Error: ${err.message}`;
    els.runnerConfigStatus.style.color = '#f44336';
  }
}

async function testRunnerConnectionFunc() {
  const loggedIn = await isRegistryLoggedIn();
  if (!loggedIn) {
    els.runnerConfigStatus.textContent = 'Login required to test Headless Runner connection.';
    els.runnerConfigStatus.style.color = '#ff9800';
    els.runnerConfigStatus.style.whiteSpace = 'normal';
    _renderIpWhitelistBox('runnerIpInfo', els.runnerConfigStatus.parentElement, [], 'Runner');
    return;
  }

  els.runnerConfigStatus.textContent = 'Testing connection...';
  els.runnerConfigStatus.style.color = '#666';
  els.testRunnerConnection.disabled = true;

  try {
    await saveRunnerConfigFunc();

    const response = await chrome.runtime.sendMessage({ type: 'playwright_test_connection' });

    if (response.ok) {
      const browserStatus = response.browsersInstalled ? 'browsers installed' : 'browsers NOT installed';
      let statusText = `Connected! Status: ${response.status} (${browserStatus})`;
      els.runnerConfigStatus.style.color = '#4CAF50';

      // Show outbound IPs for bot-prevention whitelisting
      const ips = response.outboundIps || [];
      if (ips.length > 0) {
        statusText += `\nOutbound IPs (whitelist for bot prevention): ${ips.join(', ')}`;
      }
      els.runnerConfigStatus.textContent = statusText;
      els.runnerConfigStatus.style.whiteSpace = 'pre-line';

      // Show/update the IP info box
      _renderIpWhitelistBox('runnerIpInfo', els.runnerConfigStatus.parentElement, ips, 'Runner');
    } else {
      els.runnerConfigStatus.textContent = `Connection failed: ${response.error}`;
      els.runnerConfigStatus.style.color = '#f44336';
      _renderIpWhitelistBox('runnerIpInfo', els.runnerConfigStatus.parentElement, [], 'Runner');
    }
  } catch (err) {
    console.error('[options] Runner connection test failed:', err);
    els.runnerConfigStatus.textContent = `Connection failed: ${err.message}`;
    els.runnerConfigStatus.style.color = '#f44336';
  } finally {
    els.testRunnerConnection.disabled = false;
  }
}

els.runnerEnabled?.addEventListener('change', () => {
  updateRunnerFields();
  saveRunnerConfigFunc();
});
els.saveRunnerConfig?.addEventListener('click', saveRunnerConfigFunc);
els.testRunnerConnection?.addEventListener('click', testRunnerConnectionFunc);

// ============================================================
// ============================================================
// Login Gate — hide Runner/Generator tabs until logged in
// ============================================================

async function applyLoginGates() {
  const loggedIn = await isRegistryLoggedIn();
  // Show/hide login-dependent sections within the Advanced tab
  document.querySelectorAll('.login-gated-section').forEach(el => {
    el.style.display = loggedIn ? '' : 'none';
  });

  if (els.testGeneratorConnection) els.testGeneratorConnection.disabled = !loggedIn;
  if (els.saveGeneratorConfig) els.saveGeneratorConfig.disabled = !loggedIn;
  if (els.testRunnerConnection) els.testRunnerConnection.disabled = !loggedIn;
  if (els.saveRunnerConfig) els.saveRunnerConfig.disabled = !loggedIn;

  if (!loggedIn && els.generatorStatus) {
    els.generatorStatus.textContent = 'Login required to configure AI Test Generator.';
    els.generatorStatus.style.color = '#666';
    els.generatorStatus.style.whiteSpace = 'normal';
    const loginSection = document.getElementById('claudeLoginSection');
    if (loginSection) loginSection.style.display = 'none';
    _renderIpWhitelistBox('generatorIpInfo', els.generatorStatus.parentElement, [], 'Generator');
  }

  if (!loggedIn && els.runnerConfigStatus) {
    els.runnerConfigStatus.textContent = 'Login required to configure Headless Runner.';
    els.runnerConfigStatus.style.color = '#666';
    els.runnerConfigStatus.style.whiteSpace = 'normal';
    _renderIpWhitelistBox('runnerIpInfo', els.runnerConfigStatus.parentElement, [], 'Runner');
  }

  return loggedIn;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.registryConfig) {
    applyLoginGates().then((loggedIn) => {
      if (loggedIn) {
        testGeneratorConnection();
        if (els.runnerEnabled?.checked) testRunnerConnectionFunc();
      }
    });
  }
});

// ============================================================
// Master AI Toggle
// ============================================================

async function loadAIEnabledState() {
  const result = await chrome.storage.local.get(['aiEnabled']);
  const enabled = result.aiEnabled === true;
  els.enableAllAI.checked = enabled;
  applyAIEnabledState(enabled);
}

function applyAIEnabledState(enabled) {
  document.querySelectorAll('.ai-section').forEach(card => {
    card.classList.toggle('ai-disabled', !enabled);
  });
}

async function saveAIEnabledState() {
  const enabled = els.enableAllAI.checked;
  await chrome.storage.local.set({ aiEnabled: enabled });
  applyAIEnabledState(enabled);
  console.log("[options] Generator features:", enabled ? "enabled" : "DISABLED");
}

els.enableAllAI?.addEventListener('change', saveAIEnabledState);

// ============================================================
// Registry / Account Management
// ============================================================

async function loadRegistryConfig() {
  // Load backend URL into the Account tab field
  const backendResult = await chrome.storage.local.get(['backendConfig']);
  const backendCfg = backendResult.backendConfig || {};
  if (els.backendUrl) els.backendUrl.value = backendCfg.url || DEFAULT_BACKEND_URL;

  const result = await chrome.storage.local.get(['registryConfig']);
  const config = result.registryConfig || {};
  if (config.connected) {
    showRegistryConnected(config);
  }
}

function showRegistryConnected(config) {
  if (els.registryInfo) els.registryInfo.style.display = 'block';
  if (els.registryUserName) els.registryUserName.textContent = `${config.userName || ''} (${config.userEmail || ''})`;
  if (els.registryAccountName) els.registryAccountName.textContent = config.accountName || config.accountSlug || '—';
  if (els.registryProjectName) els.registryProjectName.textContent = config.projectName || config.projectSlug || '—';
  if (els.registryRoleBadge) els.registryRoleBadge.textContent = config.role || '—';
  if (els.registryConnectBtn) els.registryConnectBtn.style.display = 'none';
  if (els.registryDisconnectBtn) els.registryDisconnectBtn.style.display = '';
  if (els.registryLoginFields) els.registryLoginFields.style.display = 'none';
  if (els.backendUrl) els.backendUrl.disabled = true;

  // Show context switcher if multiple roles
  const roles = config.availableRoles || [];
  if (roles.length > 1 && els.registryContextSwitcher && els.registryContextSelect) {
    els.registryContextSwitcher.style.display = '';
    els.registryContextSelect.innerHTML = roles.map(r =>
      `<option value="${escapeHtml(r.account_id)}|${escapeHtml(r.project_id)}" ${
        r.account_id === config.accountId && r.project_id === config.projectId ? 'selected' : ''
      }>${escapeHtml(r.account_name)} / ${escapeHtml(r.project_name)} (${escapeHtml(r.role)})</option>`
    ).join('');
  }

  // Show admin note for admins (points to Autotest Admin extension)
  if (els.adminPanel) {
    els.adminPanel.style.display = config.role === 'admin' ? '' : 'none';
  }
  // Show test management for read-write+ roles
  if (els.testManagementPanel) {
    els.testManagementPanel.style.display = config.role !== 'write-only' ? '' : 'none';
  }

  if (config.role !== 'write-only') {
    loadRemoteTests();
  }
}

async function connectToRegistry() {
  // Save backend URL first
  const backendUrlVal = (els.backendUrl?.value?.trim() || DEFAULT_BACKEND_URL).replace(/\/+$/, '');
  await chrome.storage.local.set({ backendConfig: { url: backendUrlVal } });
  const url = backendUrlVal;
  const email = els.registryEmail?.value?.trim();
  const password = els.registryPassword?.value?.trim();
  if (!email || !password) {
    if (els.registryStatus) {
      els.registryStatus.textContent = 'Email and password are required';
      els.registryStatus.style.color = '#f44336';
    }
    return;
  }
  if (els.registryStatus) {
    els.registryStatus.textContent = 'Logging in...';
    els.registryStatus.style.color = '#666';
  }

  try {
    const resp = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      throw new Error(errData.detail || `HTTP ${resp.status}`);
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
    if (els.registryStatus) {
      els.registryStatus.textContent = 'Logged in!';
      els.registryStatus.style.color = '#4CAF50';
    }
    if (els.registryEmail) els.registryEmail.value = '';
    if (els.registryPassword) els.registryPassword.value = '';
    showRegistryConnected(config);
  } catch (err) {
    if (els.registryStatus) {
      els.registryStatus.textContent = `Login failed: ${err.message}`;
      els.registryStatus.style.color = '#f44336';
    }
  }
}

async function disconnectRegistry() {
  // Call logout endpoint
  try {
    const result = await chrome.storage.local.get(['registryConfig']);
    const config = result.registryConfig || {};
    if (config.sessionToken) {
      const url = await getBackendUrl();
      await fetch(`${url}/auth/logout`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${config.sessionToken}` },
      }).catch(() => {});
    }
  } catch (_) {}

  await chrome.storage.local.remove('registryConfig');
  if (els.registryInfo) els.registryInfo.style.display = 'none';
  if (els.registryConnectBtn) els.registryConnectBtn.style.display = '';
  if (els.registryDisconnectBtn) els.registryDisconnectBtn.style.display = 'none';
  if (els.registryLoginFields) els.registryLoginFields.style.display = '';
  if (els.backendUrl) els.backendUrl.disabled = false;
  if (els.registryContextSwitcher) els.registryContextSwitcher.style.display = 'none';
  if (els.adminPanel) els.adminPanel.style.display = 'none';
  if (els.testManagementPanel) els.testManagementPanel.style.display = 'none';
  if (els.registryStatus) {
    els.registryStatus.textContent = 'Logged out';
    els.registryStatus.style.color = '#666';
  }
}

async function switchRegistryContext() {
  const val = els.registryContextSelect?.value;
  if (!val) return;
  const [accountId, projectId] = val.split('|');

  const result = await chrome.storage.local.get(['registryConfig']);
  const config = result.registryConfig || {};
  if (!config.sessionToken) return;

  const url = await getBackendUrl();
  try {
    const resp = await fetch(`${url}/auth/switch-context`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.sessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ account_id: accountId, project_id: projectId }),
    });
    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      throw new Error(errData.detail || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    config.sessionToken = data.token;
    config.accountId = data.account_id;
    config.accountSlug = data.account_slug;
    config.accountName = data.account_name;
    config.projectId = data.project_id;
    config.projectSlug = data.project_slug;
    config.projectName = data.project_name;
    config.role = data.role;
    await chrome.storage.local.set({ registryConfig: config });
    showRegistryConnected(config);
  } catch (err) {
    if (els.registryStatus) {
      els.registryStatus.textContent = `Switch failed: ${err.message}`;
      els.registryStatus.style.color = '#f44336';
    }
  }
}

async function _registryFetch(path, options = {}) {
  const result = await chrome.storage.local.get(['registryConfig']);
  const config = result.registryConfig || {};
  if (!config.connected || !config.sessionToken) throw new Error('Not connected to registry');
  const url = await getBackendUrl();
  const headers = { 'Authorization': `Bearer ${config.sessionToken}`, ...options.headers };
  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  const resp = await fetch(`${url}/registry${path}`, { ...options, headers });
  if (!resp.ok) {
    const errData = await resp.json().catch(() => ({}));
    throw new Error(errData.detail || `HTTP ${resp.status}`);
  }
  return resp.json();
}

// ── Remote Tests ──
async function loadRemoteTests() {
  try {
    if (els.remoteTestsStatus) {
      els.remoteTestsStatus.textContent = 'Loading tests...';
      els.remoteTestsStatus.style.color = '#666';
    }
    const data = await _registryFetch('/tests');
    const tests = data.tests || [];
    if (els.remoteTestsStatus) els.remoteTestsStatus.textContent = '';

    if (els.remoteTestsList) {
      if (tests.length === 0) {
        els.remoteTestsList.innerHTML = '<div class="field__hint" style="padding:12px;">No tests found in this project.</div>';
      } else {
        const result = await chrome.storage.local.get(['registryConfig']);
        const role = result.registryConfig?.role || '';
        const canApprove = role === 'admin' || role === 'read-write-approve';

        els.remoteTestsList.innerHTML = tests.map(t => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);gap:8px;">
            <div style="flex:1;min-width:0;">
              <div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(t.test_name || t.test_id)}</div>
              <div style="font-size:11px;color:var(--muted);">${escapeHtml(t.target_url || '')}</div>
            </div>
            <span class="pill" style="background:${t.status === 'approved' ? 'rgba(76,175,80,0.15);color:#4CAF50' : 'rgba(255,152,0,0.15);color:#FF9800'};">${escapeHtml(t.status)}</span>
            <div style="display:flex;gap:4px;">
              ${t.status === 'pending' && canApprove ? `
                <button class="btn btn--primary btn--small" data-approve-test="${escapeHtml(t.test_id)}">Approve</button>
                <button class="btn btn--danger btn--small" data-reject-test="${escapeHtml(t.test_id)}">Reject</button>
              ` : ''}
              <button class="btn btn--ghost btn--small" data-pull-test="${escapeHtml(t.test_id)}">Pull</button>
            </div>
          </div>
        `).join('');

        els.remoteTestsList.querySelectorAll('[data-approve-test]').forEach(btn => {
          btn.addEventListener('click', () => approveTest(btn.dataset.approveTest));
        });
        els.remoteTestsList.querySelectorAll('[data-reject-test]').forEach(btn => {
          btn.addEventListener('click', () => rejectTest(btn.dataset.rejectTest));
        });
        els.remoteTestsList.querySelectorAll('[data-pull-test]').forEach(btn => {
          btn.addEventListener('click', () => pullTest(btn.dataset.pullTest));
        });
      }
    }
  } catch (err) {
    if (els.remoteTestsStatus) {
      els.remoteTestsStatus.textContent = `Error: ${err.message}`;
      els.remoteTestsStatus.style.color = '#f44336';
    }
  }
}

async function approveTest(testId) {
  try {
    await _registryFetch(`/tests/${testId}/approve`, { method: 'POST' });
    await loadRemoteTests();
  } catch (err) {
    console.error('[options] approveTest error:', err);
  }
}

async function rejectTest(testId) {
  if (!confirm('Reject and delete this pending test?')) return;
  try {
    await _registryFetch(`/tests/${testId}/reject`, { method: 'POST' });
    await loadRemoteTests();
  } catch (err) {
    console.error('[options] rejectTest error:', err);
  }
}

async function pullTest(testId) {
  try {
    const data = await _registryFetch(`/tests/${testId}`);
    // Send to service worker to save as a local recording
    const resp = await chrome.runtime.sendMessage({
      type: 'registry_pull_test',
      testId,
      testName: data.test_name,
      specCode: data.spec_code,
      targetUrl: data.target_url
    });
    if (resp?.ok) {
      if (els.remoteTestsStatus) {
        els.remoteTestsStatus.textContent = `Pulled "${data.test_name}" to local tests`;
        els.remoteTestsStatus.style.color = '#4CAF50';
        setTimeout(() => { if (els.remoteTestsStatus) els.remoteTestsStatus.textContent = ''; }, 3000);
      }
    }
  } catch (err) {
    console.error('[options] pullTest error:', err);
    if (els.remoteTestsStatus) {
      els.remoteTestsStatus.textContent = `Pull failed: ${err.message}`;
      els.remoteTestsStatus.style.color = '#f44336';
    }
  }
}

// Wire registry events
els.registryConnectBtn?.addEventListener('click', connectToRegistry);
els.registryDisconnectBtn?.addEventListener('click', disconnectRegistry);
els.registryContextSelect?.addEventListener('change', switchRegistryContext);
els.refreshTestsBtn?.addEventListener('click', loadRemoteTests);

// Load registry config on page load
loadRegistryConfig();

// ============================================================
// Network Settings (block/capture patterns)
// ============================================================

async function loadNetworkSettings() {
  const result = await chrome.storage.local.get(['blockPatterns', 'capturePatterns']);
  if (els.blockPatterns) {
    els.blockPatterns.value = (result.blockPatterns || []).join('\n');
  }
  if (els.capturePatterns) {
    els.capturePatterns.value = (result.capturePatterns || []).join('\n');
  }
}

async function saveNetworkSettings() {
  const blockPatterns = (els.blockPatterns?.value || '')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
  const capturePatterns = (els.capturePatterns?.value || '')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
  await chrome.storage.local.set({ blockPatterns, capturePatterns });
  if (els.networkStatus) {
    els.networkStatus.textContent = 'Network settings saved.';
    els.networkStatus.className = 'status status--success';
    setTimeout(() => { els.networkStatus.textContent = ''; els.networkStatus.className = 'status'; }, 2000);
  }
}

els.saveNetworkSettings?.addEventListener('click', saveNetworkSettings);

init().catch((e) => {
  console.error(e);
  setPageStatus("Failed to initialize — see console");
});
