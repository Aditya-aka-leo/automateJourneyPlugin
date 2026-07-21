/**
 * On-page HUD overlay — iframe-based.
 * Loads the extension popup inside a draggable, minimizable container
 * so the HUD is functionally identical to the side panel.
 */

window.__autotestHudLoaded = true;

const HUD_ID = "__autotest_hud__";

// Styles live in hud.css (declared in manifest.json's content_scripts.css)
// instead of being injected here via a JS-created <style> element — some
// sites enforce a nonce-only style-src CSP with no 'unsafe-inline' fallback,
// which silently blocks a script-injected <style> tag (no catchable
// exception, the HUD just renders unstyled). CSS declared in the manifest is
// injected by the browser's extension system itself and is exempt from the
// page's CSP, the same way content_scripts JS files are exempt from
// script-src.

/* ═══════════════════════════════════════════════════════════ */
const HUD_SVG = {
  logo    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>`,
  minimize: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  expand  : `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>`,
};

/* ─── Tab-specific storage helper ──────────────────────────── */
let _ownTabId = null;

/** Returns a tab-specific storage key, e.g. "overlayMode_123".
 *  If tab ID is unknown, returns null so callers can skip the write. */
function _tabKey(key) {
  return _ownTabId ? `${key}_${_ownTabId}` : null;
}

/** Resolve this tab's ID from the background (cached). */
async function _resolveTabId() {
  if (_ownTabId) return _ownTabId;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'get_tab_id' });
    _ownTabId = resp?.tabId || null;
  } catch { _ownTabId = null; }
  return _ownTabId;
}

// Start resolving the tab ID as soon as the script loads.
// This way _ownTabId is very likely set by the time show()/hide() are called.
const _tabIdReady = _resolveTabId();

class AutotestHUD {
  constructor() {
    this.hud = null;
    this.iframe = null;
    this.isVisible = false;
    this.isMinimized = false;
    this._dragData = null;
    this._storageListener = null;
  }

  init() {
    if (this.hud) return;

    // Build container
    this.hud = document.createElement("div");
    this.hud.id = HUD_ID;
    this.hud.style.display = "none";
    this.hud.innerHTML = `
      <div id="${HUD_ID}__header">
        <span id="${HUD_ID}__header-logo">${HUD_SVG.logo}</span>
        <span id="${HUD_ID}__title">Autotest</span>
        <span id="${HUD_ID}__mini-status">
          <span id="${HUD_ID}__mini-dot" class="${HUD_ID}__mini-dot--idle"></span>
          <span id="${HUD_ID}__mini-label">Idle</span>
          <span id="${HUD_ID}__mini-counter"></span>
        </span>
        <button id="${HUD_ID}__minimize-btn" class="${HUD_ID}__hdr-btn" title="Minimize">${HUD_SVG.minimize}</button>
        <button id="${HUD_ID}__close" class="${HUD_ID}__hdr-btn" title="Hide HUD">&times;</button>
      </div>
      <div id="${HUD_ID}__body">
        <iframe id="${HUD_ID}__iframe" src="${chrome.runtime.getURL('popup/popup.html?context=hud' + (_ownTabId ? '&tabId=' + _ownTabId : ''))}"></iframe>
      </div>
    `;
    document.body.appendChild(this.hud);

    this.iframe = this.hud.querySelector(`#${HUD_ID}__iframe`);

    // Listeners
    this.hud.querySelector(`#${HUD_ID}__close`).addEventListener("click", (e) => {
      e.stopPropagation();
      this.hide();
      const ek = _tabKey('hudEnabled'), mk = _tabKey('overlayMode');
      if (ek && mk) chrome.storage.local.set({ [ek]: false, [mk]: 'none' });
    });
    this.hud.querySelector(`#${HUD_ID}__minimize-btn`).addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleMinimize();
    });

    // Drag support on header
    const header = this.hud.querySelector(`#${HUD_ID}__header`);
    header.addEventListener('mousedown', (e) => this._onDragStart(e));
    header.addEventListener('dblclick', (e) => { e.preventDefault(); this.toggleMinimize(); });

    // Listen for storage changes to update mini-status AND react to mode switches.
    // Only react to this tab's keys (skip if tab ID unknown).
    this._storageListener = (changes) => {
      if (!_ownTabId) return;
      const miniKey = _tabKey('hudMiniStatus');
      const modeKey = _tabKey('overlayMode');
      if (miniKey && this.isMinimized && changes[miniKey]) {
        this._applyMiniStatus(changes[miniKey].newValue);
      }
      // If overlay mode changed away from HUD for this tab, hide ourselves
      if (modeKey && changes[modeKey] && changes[modeKey].newValue !== 'hud') {
        this.hide();
      }
    };
    chrome.storage.onChanged.addListener(this._storageListener);
  }

  /* ─────── Drag handling ──────────────────────────────── */
  _onDragStart(e) {
    if (e.target.closest('button')) return;
    e.preventDefault();
    const rect = this.hud.getBoundingClientRect();
    this._dragData = { startX: e.clientX, startY: e.clientY, origLeft: rect.left, origTop: rect.top, moved: false };
    this.hud.classList.add(`${HUD_ID}--dragging`);

    const onMove = (ev) => {
      if (!this._dragData) return;
      const dx = ev.clientX - this._dragData.startX;
      const dy = ev.clientY - this._dragData.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this._dragData.moved = true;
      if (!this._dragData.moved) return;
      let newLeft = this._dragData.origLeft + dx;
      let newTop  = this._dragData.origTop  + dy;
      const w = this.hud.offsetWidth, h = this.hud.offsetHeight;
      newLeft = Math.max(0, Math.min(window.innerWidth  - w, newLeft));
      newTop  = Math.max(0, Math.min(window.innerHeight - h, newTop));
      this.hud.style.left  = newLeft + 'px';
      this.hud.style.top   = newTop  + 'px';
      this.hud.style.right = 'auto';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      this.hud.classList.remove(`${HUD_ID}--dragging`);
      if (this._dragData?.moved) this._savePosition();
      this._dragData = null;
    };
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
  }

  _savePosition() {
    if (!this.hud) return;
    const rect = this.hud.getBoundingClientRect();
    chrome.storage.local.set({ hudPosition: { left: rect.left, top: rect.top } });
  }

  _restorePosition(pos) {
    if (!this.hud || !pos) return;
    let { left, top } = pos;
    const w = this.hud.offsetWidth || 370, h = this.hud.offsetHeight || 600;
    left = Math.max(0, Math.min(window.innerWidth  - w, left));
    top  = Math.max(0, Math.min(window.innerHeight - h, top));
    this.hud.style.left  = left + 'px';
    this.hud.style.top   = top  + 'px';
    this.hud.style.right = 'auto';
  }

  /* ─────── Minimize / Expand ────────────────────────── */
  toggleMinimize() {
    this.isMinimized = !this.isMinimized;
    const btn = this.hud.querySelector(`#${HUD_ID}__minimize-btn`);
    if (this.isMinimized) {
      this.hud.classList.add(`${HUD_ID}--mini`);
      btn.innerHTML = HUD_SVG.expand;
      btn.title = 'Expand';
      // Fetch latest mini-status from storage (tab-specific)
      const miniKey = _tabKey('hudMiniStatus');
      if (miniKey) {
        chrome.storage.local.get([miniKey], (res) => {
          if (res[miniKey]) this._applyMiniStatus(res[miniKey]);
        });
      }
    } else {
      this.hud.classList.remove(`${HUD_ID}--mini`);
      btn.innerHTML = HUD_SVG.minimize;
      btn.title = 'Minimize';
    }
    const minKey = _tabKey('hudMinimized');
    if (minKey) chrome.storage.local.set({ [minKey]: this.isMinimized });
  }

  _applyMiniStatus(status) {
    if (!this.hud || !status) return;
    const dot   = this.hud.querySelector(`#${HUD_ID}__mini-dot`);
    const label = this.hud.querySelector(`#${HUD_ID}__mini-label`);
    const count = this.hud.querySelector(`#${HUD_ID}__mini-counter`);
    if (!dot) return;
    dot.className = '';
    if (status.dotClass) dot.className = status.dotClass;
    if (status.label) label.textContent = status.label;
    if (status.counter) count.textContent = status.counter;
  }

  /* ─────── Show / Hide ──────────────────────────────── */
  async show() {
    // Ensure we know our tab ID before writing to storage
    if (!_ownTabId) await _tabIdReady;
    if (!_ownTabId) return; // Cannot determine tab — bail out

    if (!this.hud) this.init();
    this.hud.style.display = "flex";
    this.isVisible = true;
    if (this.isMinimized) {
      this.hud.classList.add(`${HUD_ID}--mini`);
      const btn = this.hud.querySelector(`#${HUD_ID}__minimize-btn`);
      if (btn) { btn.innerHTML = HUD_SVG.expand; btn.title = 'Expand'; }
    }
    const vk = _tabKey('hudIsVisible');
    if (vk) chrome.storage.local.set({ [vk]: true });
  }

  async hide() {
    if (!_ownTabId) await _tabIdReady;
    if (this.hud) {
      this.hud.style.display = "none";
      this.isVisible = false;
      const vk = _tabKey('hudIsVisible');
      if (vk) chrome.storage.local.set({ [vk]: false });
    }
  }

  destroy() {
    if (this.hud) { this.hud.remove(); this.hud = null; }
    if (this._storageListener) {
      chrome.storage.onChanged.removeListener(this._storageListener);
      this._storageListener = null;
    }
    this.iframe = null;
    this.isVisible = false;
    this.isMinimized = false;
    this._dragData = null;
  }

  async restoreState() {
    if (typeof chrome === 'undefined' || !chrome.storage) return;
    // Resolve this tab's ID so all storage keys are tab-specific
    await _tabIdReady;
    if (!_ownTabId) return; // Can't determine tab — don't restore

    const result = await chrome.storage.local.get([
      _tabKey('hudIsVisible'), _tabKey('hudEnabled'),
      'hudPosition', // position stays global
      _tabKey('hudMinimized'), _tabKey('overlayMode')
    ]);
    const mode = result[_tabKey('overlayMode')] || 'none';
    const enabled = result[_tabKey('hudEnabled')];
    const visible = result[_tabKey('hudIsVisible')];
    if ((mode === 'hud' || enabled) && visible) {
      if (!this.hud) this.init();
      // Restore minimized state first
      if (result[_tabKey('hudMinimized')]) {
        this.isMinimized = false;
        this.toggleMinimize();
      }
      this.show();
      if (result.hudPosition) this._restorePosition(result.hudPosition);
    }
  }

  /* Legacy API stubs — these are no longer needed because the iframe
     handles all state, but kept so content.js doesn't throw errors. */
  update() {}
  setMode() {}
  updateRecording() {}
}

// Global instance
window.__autotestHUD = window.__autotestHUD || new AutotestHUD();

// Auto-restore
if (typeof chrome !== 'undefined' && chrome.storage) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => window.__autotestHUD.restoreState());
  } else {
    window.__autotestHUD.restoreState();
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = AutotestHUD;
}
