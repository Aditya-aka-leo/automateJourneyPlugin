/**
 * Content script recording engine.
 *
 * Captures:
 * - click
 * - input/change
 * - submit
 * - navigation
 *
 * Rules:
 * - Strip base URL using environment config
 * - Store only relativePath + queryParams
 * - Ignore extension UI interactions
 * - Prevent duplicate events
 *
 * Steps are sent to background for in-memory persistence.
 *
 * TODO: Add selector resilience strategy (this uses a minimal selector heuristic).
 * TODO: Add pause/resume recording from UI.
 */

window.__autotestContentLoaded = true;

const state = {
  isRecording: false,
  isAssertMode: false,
  assertHighlightEl: null,
  env: null,
  baseUrl: "",
  recentEvents: [],
  healingConfig: {
    enabled: false,
    autoApply: false
  },
  pendingInputStep: null,
  inputDebounceTimer: null,
  lastClickTarget: null,
  lastClickTime: 0,
  lastClickSentAt: 0, // Timestamp of last recorded click step (used to suppress SPA nav)
  // Persistent (not time-windowed) per-field dedup: once a value has been
  // recorded for a field, don't record it again unless it actually changes —
  // even if the page re-fires input/change on that field much later (AEM
  // commonly does this when cross-field rules re-evaluate a section).
  lastRecordedFieldValue: new Map()
};

// ── Network interception state (block/mock/capture) ──────────────
const networkInterceptState = {
  activeBlockPatterns: [],   // glob strings → abort matching requests during replay
  activeMocks: [],           // {url, method, status, headers, body} → return captured data
  capturePatterns: [],       // glob strings → capture response body during recording
};

function globMatches(pattern, url) {
  try {
    const re = new RegExp('^' + pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, ' ')
      .replace(/\*/g, '[^/]*')
      .replace(/ /g, '.*') + '$');
    return re.test(url);
  } catch {
    return false;
  }
}

function matchesAnyPattern(patterns, url) {
  return patterns.some(p => globMatches(p, url));
}

function findMock(url, method) {
  return networkInterceptState.activeMocks.find(m => {
    const urlOk = globMatches(m.url, url);
    const methodOk = !m.method || m.method.toUpperCase() === (method || '').toUpperCase();
    return urlOk && methodOk;
  });
}

function sendCapturedResponse(data) {
  try {
    chrome.runtime.sendMessage({ type: 'network_capture', ...data });
  } catch {
    // Extension context may be invalid on page unload — ignore.
  }
}

const DEDUPE_WINDOW_MS = 350;
const INPUT_DEBOUNCE_MS = 1000;
const CLICK_TO_INPUT_WINDOW_MS = 500; // If input happens within 500ms of click, merge them
const DEFAULT_WAIT = {
  // How long to wait for a step's target element to appear/become visible
  // before giving up on it. A slow-rendering popup (async data fetch,
  // multi-hop panel animation, etc.) can legitimately take a while to put
  // its fields on screen — this is deliberately generous (10 minutes) so we
  // never guess wrong just because we didn't wait long enough. If the
  // element still never appears within this window, performStep() reports
  // ELEMENT_NOT_FOUND, which aborts the whole replay (see sw.js) rather than
  // silently proceeding against a page that isn't ready.
  elementVisibleMs: 600000,
  domStableMs: 500,        // Wait for 500ms of DOM stability
  domStableTimeoutMs: 5000,
  networkIdleMs: 600,
  networkIdleTimeoutMs: 5000,
  // A visible loading overlay/popup-loader is an explicit, unambiguous "not
  // ready" signal from the page, so it gets the same 10-minute patience as
  // element-visibility above. Unlike before, exhausting this window is now a
  // hard failure (see waitForPageIdle's caller in performStep) instead of a
  // best-effort "warn and continue" — proceeding against a page that never
  // finished loading risks silently interacting with the wrong state.
  loadingIndicatorTimeoutMs: 600000,
  // Used by waitForPageIdle. A one-time slow backend call (e.g. a prefill
  // lookup) usually resolves within a few seconds; perpetual chatter (a
  // countdown timer, a bouncing "scroll down" indicator) never goes quiet no
  // matter how long we wait. Since this is best-effort either way, a moderate
  // ceiling catches the former without paying the full cost of the latter on
  // every single step.
  pageIdleTimeoutMs: 6000,
  // How long things must stay quiet before waitForPageIdle declares the page
  // settled. This runs before every single step, so it's a guaranteed tax on
  // every step's latency — kept short since it only needs to catch an
  // immediate mutation/network burst, not a slow one (a slow one still gets
  // caught because it keeps resetting the timer for as long as it runs).
  pageIdleQuietMs: 250
};

// ── Console error capture for assertions ──
window.__autotestConsoleErrors = [];
const _origConsoleError = console.error;
console.error = function(...args) {
  try { window.__autotestConsoleErrors.push(args.map(a => String(a)).join(' ')); } catch {}
  return _origConsoleError.apply(console, args);
};

const networkTracker = {
  pending: 0,
  lastActivity: performance.now()
};

const debugBuffer = {
  consoleErrors: [],
  networkErrors: []
};

function recordConsoleError(entry) {
  debugBuffer.consoleErrors.push(entry);
  if (debugBuffer.consoleErrors.length > 50) debugBuffer.consoleErrors.shift();
}

function recordNetworkError(entry) {
  debugBuffer.networkErrors.push(entry);
  if (debugBuffer.networkErrors.length > 50) debugBuffer.networkErrors.shift();
}

function clearDebugBuffer() {
  debugBuffer.consoleErrors = [];
  debugBuffer.networkErrors = [];
}

function consumeDebugBuffer() {
  const payload = {
    consoleErrors: [...debugBuffer.consoleErrors],
    networkErrors: [...debugBuffer.networkErrors]
  };
  clearDebugBuffer();
  return payload;
}

function markNetworkActivity() {
  networkTracker.lastActivity = performance.now();
}

// Analytics/tracking/telemetry traffic that never truly stops (beacons, pixels,
// heartbeats) shouldn't count toward "is the page busy" — otherwise
// waitForNetworkIdle can never find a quiet moment on a page running Adobe
// Analytics/Target/Launch (or GA, etc.), and ends up burning its full timeout
// on every single check.
const NETWORK_IDLE_IGNORE_PATTERNS = [
  /google-analytics\.com/i, /googletagmanager\.com/i, /doubleclick\.net/i,
  /facebook\.com\/tr/i, /demdex\.net/i, /omtrdc\.net/i, /adobedtm\.com/i,
  /2o7\.net/i, /hotjar\.com/i, /clarity\.ms/i, /nr-data\.net/i, /newrelic\.com/i,
  /sentry\.io/i, /segment\.(io|com)/i, /mixpanel\.com/i, /amplitude\.com/i,
  /\/b\/ss\//i
];

function isBackgroundNoiseUrl(url) {
  const u = String(url || "");
  return NETWORK_IDLE_IGNORE_PATTERNS.some((re) => re.test(u));
}

function patchNetworkTracking() {
  if (patchNetworkTracking.done) return;
  patchNetworkTracking.done = true;

  // Track console errors (capture but do not block).
  const originalConsoleError = console.error.bind(console);
  console.error = (...args) => {
    recordConsoleError({
      message: args.map((a) => String(a)).join(" "),
      timestamp: Date.now()
    });
    originalConsoleError(...args);
  };

  window.addEventListener("error", (event) => {
    recordConsoleError({
      message: event.message || "Uncaught error",
      source: event.filename,
      line: event.lineno,
      column: event.colno,
      timestamp: Date.now()
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    recordConsoleError({
      message: String(event.reason || "Unhandled promise rejection"),
      timestamp: Date.now()
    });
  });

  // Track fetch (also handles block/mock/capture).
  if (window.fetch) {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const reqUrl = String(args?.[0] instanceof Request ? args[0].url : args?.[0] || '');
      const reqMethod = (args?.[1]?.method || (args?.[0] instanceof Request ? args[0].method : 'GET') || 'GET').toUpperCase();

      // Block check — abort matching requests during replay.
      if (networkInterceptState.activeBlockPatterns.length && matchesAnyPattern(networkInterceptState.activeBlockPatterns, reqUrl)) {
        recordNetworkError({ url: reqUrl, status: 0, statusText: 'Blocked by autotest', type: 'fetch', timestamp: Date.now() });
        return Promise.reject(new TypeError('Blocked by autotest'));
      }

      // Mock check — return captured response if match found.
      const mock = networkInterceptState.activeMocks.length ? findMock(reqUrl, reqMethod) : null;
      if (mock) {
        const body = typeof mock.body === 'string' ? mock.body : JSON.stringify(mock.body);
        const headers = { 'Content-Type': 'application/json', ...(mock.headers || {}) };
        return Promise.resolve(new Response(body, { status: mock.status || 200, headers }));
      }

      const isNoise = isBackgroundNoiseUrl(reqUrl);
      if (!isNoise) {
        networkTracker.pending += 1;
        markNetworkActivity();
      }
      try {
        const response = await originalFetch(...args);
        if (!response.ok) {
          recordNetworkError({
            url: response.url,
            status: response.status,
            statusText: response.statusText,
            type: "fetch",
            timestamp: Date.now()
          });
        }
        // Capture check — clone response body for matching URLs during recording.
        if (state.isRecording && networkInterceptState.capturePatterns.length && matchesAnyPattern(networkInterceptState.capturePatterns, response.url)) {
          const cloned = response.clone();
          cloned.text().then(bodyText => {
            let parsedBody;
            try { parsedBody = JSON.parse(bodyText); } catch { parsedBody = bodyText; }
            const capturedHeaders = {};
            response.headers.forEach((v, k) => { capturedHeaders[k] = v; });
            sendCapturedResponse({
              url: response.url,
              method: reqMethod,
              status: response.status,
              headers: capturedHeaders,
              body: parsedBody,
              capturedAt: Date.now()
            });
          }).catch(() => {});
        }
        return response;
      } catch (err) {
        recordNetworkError({
          url: reqUrl,
          status: 0,
          statusText: String(err || "Fetch error"),
          type: "fetch",
          timestamp: Date.now()
        });
        throw err;
      } finally {
        if (!isNoise) {
          networkTracker.pending = Math.max(0, networkTracker.pending - 1);
          markNetworkActivity();
        }
      }
    };
  }

  // Track XHR (also handles block/mock/capture).
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (...args) {
    this.__autotestTracked = true;
    this.__autotestUrl = String(args[1] || '');
    this.__autotestMethod = String(args[0] || 'GET').toUpperCase();
    return originalOpen.apply(this, args);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (!this.__autotestTracked) {
      return originalSend.apply(this, args);
    }

    const xhrUrl = this.__autotestUrl;
    const xhrMethod = this.__autotestMethod;

    // Block check.
    if (networkInterceptState.activeBlockPatterns.length && matchesAnyPattern(networkInterceptState.activeBlockPatterns, xhrUrl)) {
      recordNetworkError({ url: xhrUrl, status: 0, statusText: 'Blocked by autotest', type: 'xhr', timestamp: Date.now() });
      setTimeout(() => {
        Object.defineProperty(this, 'status', { get: () => 0 });
        Object.defineProperty(this, 'statusText', { get: () => 'Blocked by autotest' });
        this.dispatchEvent(Object.assign(new Event('error'), {}));
      }, 0);
      return;
    }

    // Mock check.
    const mock = networkInterceptState.activeMocks.length ? findMock(xhrUrl, xhrMethod) : null;
    if (mock) {
      const body = typeof mock.body === 'string' ? mock.body : JSON.stringify(mock.body);
      const self = this;
      setTimeout(() => {
        Object.defineProperty(self, 'status', { get: () => mock.status || 200 });
        Object.defineProperty(self, 'statusText', { get: () => 'OK' });
        Object.defineProperty(self, 'responseText', { get: () => body });
        Object.defineProperty(self, 'response', { get: () => body });
        Object.defineProperty(self, 'readyState', { get: () => 4 });
        if (typeof self.onreadystatechange === 'function') self.onreadystatechange();
        if (typeof self.onload === 'function') self.onload();
        self.dispatchEvent(new Event('load'));
        self.dispatchEvent(new Event('loadend'));
      }, 0);
      return;
    }

    const isNoise = isBackgroundNoiseUrl(xhrUrl);
    if (!isNoise) {
      networkTracker.pending += 1;
      markNetworkActivity();
    }
    this.addEventListener(
      "loadend",
      () => {
        if (this.status >= 400 || this.status === 0) {
          recordNetworkError({
            url: this.responseURL,
            status: this.status,
            statusText: this.statusText,
            type: "xhr",
            timestamp: Date.now()
          });
        }
        // Capture check.
        if (state.isRecording && networkInterceptState.capturePatterns.length && matchesAnyPattern(networkInterceptState.capturePatterns, this.responseURL || xhrUrl)) {
          let parsedBody;
          try { parsedBody = JSON.parse(this.responseText); } catch { parsedBody = this.responseText; }
          sendCapturedResponse({
            url: this.responseURL || xhrUrl,
            method: xhrMethod,
            status: this.status,
            headers: { 'Content-Type': this.getResponseHeader?.('Content-Type') || 'application/json' },
            body: parsedBody,
            capturedAt: Date.now()
          });
        }
        if (!isNoise) {
          networkTracker.pending = Math.max(0, networkTracker.pending - 1);
          markNetworkActivity();
        }
      },
      { once: true }
    );
    return originalSend.apply(this, args);
  };

  // Track resource entries when available (best-effort). Only count types that
  // actually reflect app data-loading (scripts, fetch/xhr) — images, CSS,
  // fonts, and tracking pixels load continuously on most real pages and would
  // otherwise make the page look "busy" forever.
  try {
    const MEANINGFUL_INITIATOR_TYPES = new Set(["script", "fetch", "xmlhttprequest"]);
    const observer = new PerformanceObserver((list) => {
      const hasMeaningfulActivity = list.getEntries().some((entry) =>
        MEANINGFUL_INITIATOR_TYPES.has(entry.initiatorType) && !isBackgroundNoiseUrl(entry.name)
      );
      if (hasMeaningfulActivity) markNetworkActivity();
    });
    observer.observe({ entryTypes: ["resource"] });
  } catch {
    // PerformanceObserver not supported; ignore.
  }
}

function nextFrame() {
  // requestAnimationFrame alone can be throttled to a crawl — or suspended
  // entirely — for a tab that isn't currently focused/visible. That's
  // exactly where a cross-tab journey (e.g. an eKYC redirect opening in a
  // new tab) can leave replay running, silently stalling every poll loop
  // that uses this (waitForElementVisible, waitForPageIdle, etc.) with no
  // logic bug at all — the browser just never calls the callback again.
  // Race it against a plain timer so progress continues either way; rAF
  // still wins (and keeps ticks aligned to paint) whenever the tab is
  // actually visible.
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(finish);
    setTimeout(finish, 50);
  });
}

function describeElementForLog(el) {
  if (!el) return "null";
  const id = el.id ? `#${el.id}` : "";
  const cls = el.className && typeof el.className === "string"
    ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
    : "";
  return `<${el.tagName?.toLowerCase()}${id}${cls}>`;
}

function isExtensionUiTarget(target) {
  if (!target || !target.closest) return false;
  return Boolean(target.closest('[data-autotest-extension="true"]'));
}

// AEM's WCM authoring/edit mode renders empty "Drag components here" drop
// zones with these markers. They only exist in the author/edit-mode view of
// a page — on the real published page a replay actually runs against, they
// either don't render at all or stay hidden, so a step recorded against one
// can never be found later, and polls forever. A click landing on one during
// recording is always an accident (the author overlay sitting over/near the
// real intended target), never a genuine interaction to replay.
function isAemAuthoringPlaceholder(target) {
  if (!target || !target.closest) return false;
  return Boolean(target.closest('.cq-placeholder, .afEditorPlaceholder, [data-emptytext]'));
}

function dedupeKey({ type, selector, value, relativePath, queryParams }) {
  const qp = JSON.stringify(queryParams || {});
  const selValue = selector?.primary?.value || "";
  return `${type}::${selValue}::${String(value ?? "")}::${relativePath}::${qp}`;
}

function isDuplicate(step) {
  // Value-carrying steps (input/change) get a permanent per-field dedup keyed
  // only on selector+value — NOT on step.type. Without this, a debounced
  // "input" step and a later "change" step for the same field with the same
  // (unchanged) value are treated as distinct events (dedupeKey includes
  // type), producing the duplicate INPUT-then-CHANGE pairs seen in practice
  // when AEM re-fires change on an already-filled field during a re-render.
  if ((step.type === "input" || step.type === "change") && step.value !== undefined) {
    const fieldKey = `${step.selector?.primary?.value || ""}::${step.relativePath || ""}`;
    if (state.lastRecordedFieldValue.get(fieldKey) === step.value) return true;
    state.lastRecordedFieldValue.set(fieldKey, step.value);
    return false;
  }

  // Everything else (click, submit, navigation, asserts) uses the short
  // time-windowed dedup — it only needs to guard against a genuine double
  // fire of the same discrete event, not a delayed re-fire.
  const key = dedupeKey(step);
  const now = Date.now();
  state.recentEvents = state.recentEvents.filter((e) => now - e.time < DEDUPE_WINDOW_MS);
  const found = state.recentEvents.find((e) => e.key === key);
  if (found) return true;
  state.recentEvents.push({ key, time: now });
  return false;
}

function getEnvironmentBaseUrl(env) {
  return String(env?.baseUrl || "").trim();
}

function computeRelativeLocation(urlString, baseUrlString) {
  const url = new URL(urlString);
  let relativePath = url.pathname || "/";

  if (baseUrlString) {
    try {
      const base = new URL(baseUrlString);
      if (base.origin === url.origin) {
        const basePath = base.pathname.replace(/\/+$/, "");
        if (basePath && relativePath.startsWith(basePath)) {
          relativePath = relativePath.slice(basePath.length) || "/";
        }
      }
    } catch {
      // Ignore invalid baseUrl; keep path as-is.
    }
  }

  const queryParams = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (!queryParams[key]) queryParams[key] = [];
    queryParams[key].push(value);
  }

  return { relativePath, queryParams };
}

function getVisibleText(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return "";
  const text = String(el.textContent || "").trim();
  if (!text) return "";
  // Keep text short to avoid extremely long selectors.
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/**
 * Extract a stable label from an element, stripping dynamic content like
 * prices, numbers, percentages, counts, timestamps, etc.
 * This is used for text-based selectors and element names to ensure they
 * remain valid across replays when dynamic values change.
 */
function getStableLabel(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return "";
  
  // Priority: aria-label > explicit label > first heading/strong text > cleaned full text
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.trim();
  
  // Check for a heading or strong child with stable text
  const headingOrStrong = el.querySelector('h1,h2,h3,h4,h5,h6,strong,b,.title,.heading,.name,.label');
  if (headingOrStrong) {
    const headText = (headingOrStrong.textContent || "").trim();
    if (headText && headText.length <= 60) return headText;
  }
  
  const raw = String(el.textContent || "").trim();
  if (!raw) return "";
  
  // Strip dynamic patterns: currency amounts, percentages, large numbers, dates
  let cleaned = raw
    // Currency: ₹3,958+, $29.99, €100, £50.00, etc.
    .replace(/[₹$€£¥]\s*[\d,]+\.?\d*/g, '')
    // Standalone numbers with commas/decimals: 3,958, 1234.56
    .replace(/\b[\d,]+\.?\d+\b/g, '')
    // Percentages: 15%, 3.5%
    .replace(/\d+\.?\d*\s*%/g, '')
    // Time patterns: 12:30, 09:45 AM
    .replace(/\d{1,2}:\d{2}\s*(AM|PM|am|pm)?/g, '')
    // Date patterns: 01/02/2026, 2026-02-05
    .replace(/\d{1,4}[-/]\d{1,2}[-/]\d{1,4}/g, '')
    // Standalone digits
    .replace(/\b\d+\b/g, '')
    // "+" signs left over from stripped prices
    .replace(/\+/g, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
  
  if (!cleaned) return "";
  // Keep it short
  return cleaned.length > 60 ? cleaned.slice(0, 57) + "..." : cleaned;
}

function cssEscape(value) {
  if (globalThis.CSS?.escape) return CSS.escape(value);
  return String(value).replace(/[^\w-]/g, "\\$&");
}

function escapeAttributeValue(value) {
  // For attribute selectors [attr="value"], we only need to escape quotes and backslashes
  // Do NOT use CSS.escape here as it escapes spaces/special chars unnecessarily
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildXPath(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return "";
  const segments = [];
  let node = el;
  while (node && node.nodeType === Node.ELEMENT_NODE) {
    const tag = node.tagName.toLowerCase();
    let index = 1;
    let sibling = node.previousElementSibling;
    while (sibling) {
      if (sibling.tagName.toLowerCase() === tag) index += 1;
      sibling = sibling.previousElementSibling;
    }
    segments.unshift(`${tag}[${index}]`);
    node = node.parentElement;
  }
  return `/${segments.join("/")}`;
}

// Checks whether a CSS selector resolves to exactly one element matching
// `el`, right now. Counts only VISIBLE matches when el itself is visible —
// AEM (and other frameworks) commonly leave hidden template/clone markup
// around with identical attributes to the real, interactable element, which
// would otherwise make an actually-unique-for-the-user's-purposes selector
// look ambiguous by a raw querySelectorAll().length check.
function isUniqueMatchFor(el, cssValue) {
  let matches;
  try {
    matches = document.querySelectorAll(cssValue);
  } catch {
    return false;
  }
  if (matches.length === 0) return false;
  if (isElementVisible(el)) {
    const visibleMatches = Array.from(matches).filter(isElementVisible);
    if (visibleMatches.length > 0) {
      return visibleMatches.length === 1 && visibleMatches[0] === el;
    }
  }
  return matches.length === 1 && matches[0] === el;
}

// UI frameworks (Angular Material/CDK, MUI, Radix, Chakra, React 18 useId(),
// Ember, react-select, etc.) assign ids from an incrementing counter tied to
// component MOUNT ORDER, not to the element's identity — e.g.
// "mat-mdc-checkbox-0-input". That index can land on a completely different
// element next run if anything upstream renders in a different order (async
// data, conditional branches, lazy-loaded modules). It's still unique *right
// now*, so treating it as a top-priority "stable id" selector works during
// recording and then silently points at the wrong element (or nothing) later.
function isLikelyUnstableFrameworkId(id) {
  // Matches both older Angular Material ids (mat-input-0, mat-checkbox-3)
  // and newer MDC-based ones (mat-mdc-checkbox-0-input) — "mat-" alone
  // covers both, since the latter is just "mat-" + "mdc-...".
  // "ui-id-" is jQuery UI's widget factory (autocomplete/tabs/accordion/etc.)
  // — it assigns ui-id-N from a single counter shared across every jQuery UI
  // widget instantiated on the page, so N depends on page load order/timing
  // and is not reproducible across sessions, even though it looks unique
  // (and stable) within any one snapshot of the DOM.
  return /^(mat-|cdk-|mdc-|mui-|radix-|chakra-|headlessui-|ember\d*-|react-select-|ui-id-)[\w-]*\d+/i.test(id)
    || /^:r[0-9a-z]+:$/i.test(id); // React 18 useId()
}

function generateSelector(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) {
    return { primary: null, fallbacks: [] };
  }

  const candidates = [];
  const tag = el.tagName.toLowerCase();
  const idIsUnstable = el.id && isLikelyUnstableFrameworkId(el.id);

  // 1) Stable id — skip framework auto-generated ids here; they're pushed
  // further down (after aria-label/name/text) as a lower-priority fallback
  // instead, since they still often work but shouldn't be trusted first.
  if (el.id && !idIsUnstable) {
    candidates.push({
      type: "css",
      value: `#${cssEscape(el.id)}`,
      reason: "Stable id is the most direct and unique selector."
    });
  }

  // 2) data-testid / data-test / name
  const testId =
    el.getAttribute("data-testid") ||
    el.getAttribute("data-test") ||
    el.getAttribute("data-test-id");
  if (testId) {
    candidates.push({
      type: "css",
      value: `[data-testid="${escapeAttributeValue(testId)}"]`,
      reason: "data-testid/data-test are stable test hooks."
    });
  }
  
  const name = el.getAttribute("name");
  if (name) {
    candidates.push({
      type: "css",
      value: `${tag}[name="${escapeAttributeValue(name)}"]`,
      reason: "Form element name is usually stable across environments."
    });
  }

  // 3) aria-label / role combinations
  const ariaLabel = el.getAttribute("aria-label");
  const role = el.getAttribute("role");
  const ariaLabelledBy = el.getAttribute("aria-labelledby");

  // Strip dynamic state suffixes from aria-labels, e.g.:
  //   "Switch between dark and light mode (currently light mode)"
  //   → staticLabel = "Switch between dark and light mode"
  // Common patterns: "(currently X)", "(X selected)", "(active)", "(open)", "(closed)", etc.
  const _ariaStaticPart = (label) => {
    if (!label) return label;
    // Remove trailing parenthetical state annotations
    const stripped = label.replace(/\s*\([^)]*\)\s*$/, '').trim();
    return stripped !== label ? stripped : null;  // null means no dynamic part found
  };
  const ariaLabelStatic = ariaLabel ? _ariaStaticPart(ariaLabel) : null;

  if (ariaLabel && role) {
    // Prefer starts-with when the label has dynamic state; exact match otherwise
    const attrOp = ariaLabelStatic ? `^=` : `=`;
    const attrVal = ariaLabelStatic || ariaLabel;
    candidates.push({
      type: "css",
      value: `${tag}[role="${escapeAttributeValue(role)}"][aria-label${attrOp}"${escapeAttributeValue(attrVal)}"]`,
      reason: "Combined role and aria-label (stable static prefix)."
    });
  }

  if (ariaLabel) {
    if (ariaLabelStatic) {
      // Primary: starts-with the static part (robust against state changes)
      candidates.push({
        type: "css",
        value: `[aria-label^="${escapeAttributeValue(ariaLabelStatic)}"]`,
        reason: "aria-label starts-with static prefix — ignores dynamic state suffix like '(currently X)'."
      });
      // Fallback: exact match (in case the state didn't change after all)
      candidates.push({
        type: "css",
        value: `[aria-label="${escapeAttributeValue(ariaLabel)}"]`,
        reason: "Exact aria-label match (fallback)."
      });
    } else {
      candidates.push({
        type: "css",
        value: `[aria-label="${escapeAttributeValue(ariaLabel)}"]`,
        reason: "aria-label is an accessibility label and tends to be stable."
      });
    }
  }
  
  if (role) {
    candidates.push({
      type: "css",
      value: `${tag}[role="${escapeAttributeValue(role)}"]`,
      reason: "role provides a semantic hook when ids/testids are absent."
    });
  }
  
  if (ariaLabelledBy) {
    candidates.push({
      type: "css",
      value: `[aria-labelledby="${escapeAttributeValue(ariaLabelledBy)}"]`,
      reason: "aria-labelledby links to label elements."
    });
  }

  // 3.5) Additional stable attributes
  const type = el.getAttribute("type");
  const placeholder = el.getAttribute("placeholder");
  
  if (name && type) {
    candidates.push({
      type: "css",
      value: `${tag}[name="${escapeAttributeValue(name)}"][type="${escapeAttributeValue(type)}"]`,
      reason: "Combined name and type for form elements."
    });
  }
  
  if (type && placeholder) {
    candidates.push({
      type: "css",
      value: `${tag}[type="${escapeAttributeValue(type)}"][placeholder="${escapeAttributeValue(placeholder)}"]`,
      reason: "Combined type and placeholder for input elements."
    });
  }
  
  // Class-based selector (if classes exist and are reasonable)
  const classes = Array.from(el.classList).filter(c => 
    c && !c.match(/^(active|selected|hover|focus|disabled|error)$/i) && c.length < 50
  );
  if (classes.length > 0 && classes.length <= 3) {
    candidates.push({
      type: "css",
      value: `${tag}.${classes.join('.')}`,
      reason: "Class-based selector as fallback."
    });
  }

  // 3.7) Structural selector: nth-of-type for role-based siblings
  // When multiple elements share the same role (e.g. fare radio buttons),
  // use nth-of-type to distinguish them stably (independent of text content)
  if (role) {
    const parent = el.parentElement;
    if (parent) {
      const siblings = Array.from(parent.querySelectorAll(`:scope > ${tag}[role="${escapeAttributeValue(role)}"]`));
      if (siblings.length > 1) {
        const idx = siblings.indexOf(el);
        if (idx >= 0) {
          candidates.push({
            type: "css",
            value: `${tag}[role="${escapeAttributeValue(role)}"]:nth-of-type(${idx + 1})`,
            reason: `Structural position among ${siblings.length} sibling ${role} elements.`
          });
        }
      }
    }
  }

  // 4) visible text — use stable label (stripped of prices, numbers, etc.)
  const stableLabel = getStableLabel(el);
  if (stableLabel) {
    candidates.push({
      type: "text",
      value: stableLabel,
      reason: "Stable text label (dynamic values stripped) for resilient matching."
    });
  }

  // 4b) Framework auto-generated id — kept as a low-confidence fallback
  // below aria-label/name/text. It resolves uniquely more often than not
  // (the mount-order index is frequently stable in practice), so it's still
  // worth trying, just not trusted as the primary selector.
  if (idIsUnstable) {
    candidates.push({
      type: "css",
      value: `#${cssEscape(el.id)}`,
      reason: "Framework auto-generated id (e.g. Angular Material/CDK) — kept as a low-priority fallback since its index can shift between sessions.",
      lowPriority: true
    });
  }

  // 5) XPath fallback
  const xpath = buildXPath(el);
  if (xpath) {
    candidates.push({
      type: "xpath",
      value: xpath,
      reason: "XPath provides a deterministic fallback when other selectors fail."
    });
  }

  // Prefer candidates that uniquely resolve to THIS element right now. A
  // selector like [aria-labelledby="..."] can be shared by several sibling
  // fields (e.g. a composite day/month/year date input where all three
  // sub-inputs point at the same shared error-description id) — without this
  // check, that non-unique selector can still end up as primary just because
  // it was pushed earlier, and querySelector will always resolve it to
  // whichever sibling comes first in DOM order, silently misdirecting every
  // step meant for the other siblings (e.g. month/year steps landing on day).
  //
  // Candidates flagged `lowPriority` (e.g. framework auto-generated ids like
  // Angular Material's "mat-option-12") are deliberately excluded from the
  // "unique right now" fast track even when they do resolve uniquely at
  // record time — that's exactly the trap: they're unique *this instant*
  // but the underlying index is tied to component mount order, so it can
  // resolve to nothing (or a different sibling) as soon as anything upstream
  // re-renders. A stable text/aria-label match is worth trying first even
  // though it's not a "css" selector, so it's ranked ahead of lowPriority
  // css candidates instead of always sinking below every css candidate.
  const uniqueCss = [];
  const lowPriorityCss = [];
  const nonUniqueCss = [];
  const nonCss = [];
  for (const c of candidates) {
    if (c.type !== "css") { nonCss.push(c); continue; }
    if (c.lowPriority) { lowPriorityCss.push(c); continue; }
    (isUniqueMatchFor(el, c.value) ? uniqueCss : nonUniqueCss).push(c);
  }
  const orderedCandidates = [...uniqueCss, ...nonCss, ...lowPriorityCss, ...nonUniqueCss];

  const [primary, ...fallbacks] = orderedCandidates;

  return { primary: primary || null, fallbacks };
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function textSimilarity(a, b) {
  const aTokens = new Set(tokenize(a));
  const bTokens = new Set(tokenize(b));
  if (!aTokens.size || !bTokens.size) return 0;
  let intersection = 0;
  for (const t of aTokens) if (bTokens.has(t)) intersection += 1;
  const union = new Set([...aTokens, ...bTokens]).size;
  return union ? intersection / union : 0;
}

function extractTagFromSelector(selector) {
  if (!selector || selector.type !== "css") return "";
  const value = selector.value || "";
  const match = value.match(/^([a-z0-9-]+)/i);
  return match ? match[1].toLowerCase() : "";
}

function extractRoleFromSelector(selector) {
  if (!selector || selector.type !== "css") return "";
  const value = selector.value || "";
  const match = value.match(/role\s*=\s*["']([^"']+)["']/i);
  return match ? match[1] : "";
}

function getTargetTextFromSelector(selector) {
  if (!selector) return "";
  const candidates = [];
  if (selector.primary) candidates.push(selector.primary);
  if (Array.isArray(selector.fallbacks)) candidates.push(...selector.fallbacks);
  const textCandidate = candidates.find((c) => c.type === "text");
  return textCandidate ? String(textCandidate.value || "") : "";
}

function healSelector(step, selector) {
  const targetText = getTargetTextFromSelector(selector) || (step?.value && String(step.value)) || "";
  const candidates = [];

  const primary = selector?.primary || null;
  const preferredTag = extractTagFromSelector(primary);
  const preferredRole = extractRoleFromSelector(primary);

  let nodes = [];
  if (preferredTag) {
    nodes = Array.from(document.querySelectorAll(preferredTag));
  } else if (preferredRole) {
    nodes = Array.from(document.querySelectorAll(`[role="${CSS.escape(preferredRole)}"]`));
  } else {
    nodes = Array.from(
      document.querySelectorAll("button, a, input, select, textarea, label, [role], [aria-label]")
    );
  }

  for (const node of nodes) {
    if (!isElementVisible(node)) continue;
    const text = getElementText(node);
    const textScore = targetText ? textSimilarity(targetText, text) : 0;
    const role = node.getAttribute("role") || "";
    const tag = node.tagName.toLowerCase();
    let score = textScore;
    if (preferredTag && tag === preferredTag) score += 0.15;
    if (preferredRole && role === preferredRole) score += 0.2;
    if (score > 0) {
      candidates.push({ node, score, text });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best || best.score < 0.35) return null;

  return {
    selector: generateSelector(best.node),
    confidence: Number(best.score.toFixed(2)),
    matchedText: best.text
  };
}

function scheduleHealing(step, selector) {
  if (!state.healingConfig.enabled) return;
  const runner = () => {
    try {
      const suggestion = healSelector(step, selector);
      if (suggestion) {
        chrome.runtime.sendMessage({
          type: "selector_heal_suggestion",
          stepId: step.id,
          suggestion
        });
      }
    } catch (err) {
      // Non-blocking by design: swallow healing errors.
      console.warn("Selector healing failed:", err);
    }
  };

  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(runner, { timeout: 200 });
  } else {
    setTimeout(runner, 0);
  }
}

// ============================================================================
// MULTI-HOP REFINEMENT SYSTEM
// ============================================================================

/**
 * Collect enhanced element information for backend refinement
 */
function getEnhancedElementInfo(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
  
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  const parent = el.parentElement;
  
  return {
    // Basic identification
    tag: el.tagName?.toLowerCase(),
    type: el.getAttribute('type'),
    id: el.id || null,
    name: el.getAttribute('name'),
    classes: el.className ? el.className.split(/\s+/).filter(Boolean) : [],
    
    // Text content variants
    text: el.textContent?.trim()?.substring(0, 200),
    innerText: el.innerText?.trim()?.substring(0, 200),
    value: el.value || null,
    
    // Accessibility
    label: el.getAttribute('aria-label'),
    placeholder: el.getAttribute('placeholder'),
    ariaLabel: el.getAttribute('aria-label'),
    ariaDescribedby: el.getAttribute('aria-describedby'),
    ariaExpanded: el.getAttribute('aria-expanded'),
    ariaHaspopup: el.getAttribute('aria-haspopup'),
    role: el.getAttribute('role'),
    title: el.getAttribute('title'),
    
    // Selectors
    selector: generateSelector(el)?.primary?.value,
    xpath: buildXPath(el),
    uniqueSelector: getUniqueSelector(el),
    
    // Position & visibility
    boundingRect: {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
      bottom: rect.bottom,
      right: rect.right
    },
    visible: isElementVisible(el),
    inViewport: rect.top >= 0 && rect.left >= 0 && 
                rect.bottom <= window.innerHeight && 
                rect.right <= window.innerWidth,
    zIndex: parseInt(style.zIndex) || 0,
    
    // Hierarchy
    parentTag: parent?.tagName?.toLowerCase(),
    parentId: parent?.id || null,
    parentClasses: parent?.className?.split(/\s+/).filter(Boolean),
    parentText: parent?.textContent?.trim()?.substring(0, 100),
    childCount: el.children?.length || 0,
    siblingIndex: getSiblingIndex(el),
    
    // Nearby elements context
    nearbyLabels: getNearbyLabels(el),
    formFieldLabel: getFormFieldLabel(el),
    precedingText: getPrecedingText(el),
    
    // Interaction hints
    isClickable: isClickable(el),
    isEditable: isEditable(el),
    isFocusable: el.tabIndex >= 0 || ['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'A'].includes(el.tagName),
    isDisabled: el.disabled || el.getAttribute('disabled') !== null,
    hasOnclick: !!el.onclick || el.hasAttribute('onclick'),
    
    // Data attributes
    dataTestid: el.getAttribute('data-testid') || el.getAttribute('data-test-id'),
    dataAttributes: getDataAttributes(el),
    
    // Computed styles
    display: style.display,
    cursor: style.cursor
  };
}

function getUniqueSelector(el) {
  if (!el) return null;
  
  // Try data-testid first
  const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
  if (testId) return `[data-testid="${testId}"]`;
  
  // Try ID
  if (el.id) return `#${cssEscape(el.id)}`;
  
  // Try name + type for inputs
  const name = el.getAttribute('name');
  const type = el.getAttribute('type');
  if (name && type) return `${el.tagName.toLowerCase()}[name="${name}"][type="${type}"]`;
  if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
  
  // Try aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return `[aria-label="${ariaLabel}"]`;
  
  return null;
}

function getSiblingIndex(el) {
  if (!el || !el.parentElement) return -1;
  return Array.from(el.parentElement.children).indexOf(el);
}

function getNearbyLabels(el) {
  const labels = [];
  const searchRadius = 100; // pixels
  
  // Find labels within search radius
  const allLabels = document.querySelectorAll('label, [class*="label"], .form-label');
  for (const label of allLabels) {
    const labelRect = label.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    
    const distance = Math.sqrt(
      Math.pow(labelRect.left - elRect.left, 2) + 
      Math.pow(labelRect.top - elRect.top, 2)
    );
    
    if (distance < searchRadius) {
      labels.push(label.textContent?.trim());
    }
  }
  
  return labels.slice(0, 5);
}

function getFormFieldLabel(el) {
  // Check for associated label
  if (el.id) {
    const label = document.querySelector(`label[for="${el.id}"]`);
    if (label) return label.textContent?.trim();
  }
  
  // Check for parent label
  const parentLabel = el.closest('label');
  if (parentLabel) return parentLabel.textContent?.trim();
  
  // Check for preceding sibling label
  const prevSibling = el.previousElementSibling;
  if (prevSibling?.tagName === 'LABEL') {
    return prevSibling.textContent?.trim();
  }
  
  return null;
}

function getPrecedingText(el) {
  // Get text content from preceding sibling or parent
  const prev = el.previousSibling;
  if (prev && prev.nodeType === Node.TEXT_NODE) {
    return prev.textContent?.trim();
  }
  
  const prevEl = el.previousElementSibling;
  if (prevEl) {
    return prevEl.textContent?.trim()?.substring(0, 50);
  }
  
  return null;
}

function isClickable(el) {
  const tag = el.tagName?.toUpperCase();
  const role = el.getAttribute('role');
  const cursor = window.getComputedStyle(el).cursor;
  
  return tag === 'BUTTON' || 
         tag === 'A' || 
         (tag === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type)) ||
         role === 'button' || 
         role === 'link' ||
         cursor === 'pointer' ||
         el.onclick !== null ||
         el.hasAttribute('onclick');
}

function isEditable(el) {
  const tag = el.tagName?.toUpperCase();
  return tag === 'INPUT' || 
         tag === 'TEXTAREA' || 
         tag === 'SELECT' ||
         el.isContentEditable;
}

function getDataAttributes(el) {
  const attrs = {};
  for (const attr of el.attributes) {
    if (attr.name.startsWith('data-')) {
      attrs[attr.name] = attr.value;
    }
  }
  return Object.keys(attrs).length > 0 ? attrs : null;
}

/**
 * Find candidate elements that might match the target
 */
function findCandidateElements(targetDescriptor, targetType, maxCandidates = 10) {
  const candidates = [];
  const targetText = (targetDescriptor || '').toLowerCase();
  
  // Build query based on target type
  let querySets = [];
  if (targetType === 'input' || targetType === 'change') {
    querySets = [
      'input', 'textarea', 'select', '[contenteditable]'
    ];
  } else if (targetType === 'click') {
    querySets = [
      'button', 'a', '[role="button"]', '[role="link"]', 
      'input[type="submit"]', 'input[type="button"]',
      '[onclick]', '[tabindex]'
    ];
  } else {
    querySets = [
      'button', 'a', 'input', 'textarea', 'select',
      '[role="button"]', '[role="link"]', '[onclick]'
    ];
  }
  
  const seenElements = new Set();
  
  for (const selector of querySets) {
    try {
      const elements = document.querySelectorAll(selector);
      
      for (const el of elements) {
        if (seenElements.has(el)) continue;
        seenElements.add(el);
        
        if (!isElementVisible(el)) continue;
        
        // Calculate match score
        const elementInfo = getEnhancedElementInfo(el);
        const { score, reasons } = calculateMatchScore(elementInfo, targetText);
        
        if (score > 0.1) {
          candidates.push({
            element: elementInfo,
            matchScore: score,
            matchReasons: reasons,
            distanceFromExpected: null // Could calculate based on expected position
          });
        }
      }
    } catch (e) {
      // Invalid selector, continue
    }
  }
  
  // Sort by score and return top candidates
  candidates.sort((a, b) => b.matchScore - a.matchScore);
  return candidates.slice(0, maxCandidates);
}

/**
 * Calculate how well an element matches the target descriptor
 */
function calculateMatchScore(elementInfo, targetText) {
  let score = 0;
  const reasons = [];
  
  if (!elementInfo || !targetText) return { score: 0, reasons: [] };
  
  const target = targetText.toLowerCase();
  
  // Text content match
  const text = (elementInfo.text || '').toLowerCase();
  if (text === target) {
    score += 0.9;
    reasons.push('exact text match');
  } else if (text.includes(target)) {
    score += 0.6;
    reasons.push('text contains target');
  } else if (target.includes(text) && text.length > 3) {
    score += 0.3;
    reasons.push('target contains element text');
  }
  
  // Aria-label match
  const ariaLabel = (elementInfo.ariaLabel || '').toLowerCase();
  if (ariaLabel === target) {
    score += 0.95;
    reasons.push('exact aria-label match');
  } else if (ariaLabel.includes(target)) {
    score += 0.7;
    reasons.push('aria-label contains target');
  }
  
  // Placeholder match
  const placeholder = (elementInfo.placeholder || '').toLowerCase();
  if (placeholder.includes(target) || target.includes(placeholder)) {
    score += 0.5;
    reasons.push('placeholder match');
  }
  
  // Name/ID match
  const name = (elementInfo.name || '').toLowerCase().replace(/[-_]/g, ' ');
  const id = (elementInfo.id || '').toLowerCase().replace(/[-_]/g, ' ');
  if (name.includes(target.replace(/\s+/g, '')) || target.includes(name)) {
    score += 0.4;
    reasons.push('name attribute match');
  }
  if (id.includes(target.replace(/\s+/g, '')) || target.includes(id)) {
    score += 0.3;
    reasons.push('id attribute match');
  }
  
  // Form field label match
  const fieldLabel = (elementInfo.formFieldLabel || '').toLowerCase();
  if (fieldLabel.includes(target) || target.includes(fieldLabel)) {
    score += 0.6;
    reasons.push('form field label match');
  }
  
  // Nearby labels match
  for (const label of (elementInfo.nearbyLabels || [])) {
    if ((label || '').toLowerCase().includes(target)) {
      score += 0.3;
      reasons.push('nearby label match');
      break;
    }
  }
  
  // data-testid match
  const testId = (elementInfo.dataTestid || '').toLowerCase().replace(/[-_]/g, ' ');
  if (testId.includes(target.replace(/\s+/g, '')) || target.includes(testId)) {
    score += 0.5;
    reasons.push('data-testid match');
  }
  
  // Cap score at 1.0
  return { score: Math.min(score, 1.0), reasons };
}

/**
 * Request selector refinement from backend
 */
async function requestBackendRefinement(step, selector, selectorAttempts, candidates, error) {
  // Backend service has been removed
  return { ok: false, error: "Backend removed" };
}

/**
 * Find the most relevant DOM region for a target descriptor
 */
function findRelevantDOMRegion(targetDesc) {
  if (!targetDesc) return null;
  
  // Try to find an element containing the target text
  const allElements = document.querySelectorAll('form, section, [role="main"], main, .container, .content, [role="dialog"]');
  
  for (const region of allElements) {
    const text = (region.textContent || '').toLowerCase();
    if (text.includes(targetDesc)) {
      return region;
    }
  }
  
  // Fallback: return main content area
  return document.querySelector('main') || document.querySelector('[role="main"]') || document.querySelector('form');
}

/**
 * Build a map of ALL interactive element selectors on the page
 */
function buildAllSelectorsMap() {
  const selectorMap = [];
  const interactiveSelectors = 'button, a[href], input, textarea, select, [role="button"], [role="link"], [role="textbox"], [onclick], [data-testid], [aria-label]';
  
  const elements = document.querySelectorAll(interactiveSelectors);
  
  for (const el of elements) {
    if (!isElementVisible(el)) continue;
    
    const entry = {
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type'),
      text: (el.textContent || '').trim().substring(0, 80),
      selectors: []
    };
    
    // Collect all selectors
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
    if (testId) entry.selectors.push(`[data-testid="${testId}"]`);
    
    if (el.id) entry.selectors.push(`#${el.id}`);
    
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) entry.selectors.push(`[aria-label="${ariaLabel}"]`);
    
    const name = el.getAttribute('name');
    if (name) entry.selectors.push(`${entry.tag}[name="${name}"]`);
    
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) entry.selectors.push(`${entry.tag}[placeholder="${placeholder}"]`);
    
    if (entry.selectors.length > 0) {
      selectorMap.push(entry);
    }
  }
  
  return selectorMap;
}

/**
 * Try refined selectors from backend with verification
 */
async function tryRefinedSelectors(refinedSelectors, expectedType) {
  console.log("[autotest][refinement] Trying", refinedSelectors.length, "refined selectors");
  
  for (const refined of refinedSelectors) {
    const selectorType = refined.selector_type || refined.selectorType;
    const selectorValue = refined.selector_value || refined.selectorValue;
    
    console.log("[autotest][refinement] Trying:", selectorType, selectorValue);
    
    try {
      let el = null;
      
      if (selectorType === 'css') {
        el = document.querySelector(selectorValue);
      } else if (selectorType === 'xpath') {
        const result = document.evaluate(
          selectorValue,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        );
        el = result.singleNodeValue;
      } else if (selectorType === 'text') {
        el = resolveByText(selectorValue);
      } else if (selectorType === 'aria') {
        el = document.querySelector(`[aria-label="${selectorValue}"]`);
      }
      
      if (!el) {
        console.log("[autotest][refinement] ✗ No element found for:", selectorValue);
        continue;
      }
      
      // VERIFICATION: check element is visible
      const visible = isElementVisible(el);
      if (!visible) {
        console.log("[autotest][refinement] ⚠ Element found but hidden:", selectorValue);
        // Still return it - some interactions work on hidden elements
      }
      
      // VERIFICATION: check element type compatibility
      const tag = el.tagName?.toLowerCase();
      const type = el.getAttribute('type');
      if (expectedType) {
        const typeCompatible = verifyElementType(el, expectedType);
        if (!typeCompatible) {
          console.log(`[autotest][refinement] ⚠ Element type mismatch: expected ${expectedType}, got ${tag}[${type}]`);
          // Don't skip - the element might still be correct, just different than expected
        }
      }
      
      console.log("[autotest][refinement] ✓ Found and verified element:", selectorValue, 
                  `(${tag}, visible=${visible})`);
      return { 
        el, 
        used: { type: selectorType, value: selectorValue },
        visible
      };
    } catch (e) {
      console.warn("[autotest][refinement] Selector failed:", selectorValue, e);
    }
  }
  
  return null;
}

/**
 * Verify element type matches expected action type
 */
function verifyElementType(el, expectedType) {
  const tag = el.tagName?.toLowerCase();
  const type = el.getAttribute('type');
  const role = el.getAttribute('role');
  
  switch (expectedType) {
    case 'click':
      return tag === 'button' || tag === 'a' || role === 'button' || role === 'link' ||
             type === 'submit' || type === 'button' || 
             el.onclick !== null || el.hasAttribute('onclick') ||
             window.getComputedStyle(el).cursor === 'pointer';
    case 'input':
    case 'change':
      return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
    case 'select':
      return tag === 'select' || role === 'combobox' || role === 'listbox';
    default:
      return true; // Don't reject for unknown types
  }
}

/**
 * Fulfill backend context requests during refinement loop
 */
async function fulfillContextRequests() {
  // Backend service has been removed
  return;
}

/**
 * SVG/non-interactive xpath parent fallback.
 * If the xpath ends in svg, path, g, circle, etc., truncate step-by-step
 * and try to find an interactive parent (span[role=checkbox], button, label, etc.).
 */
async function trySvgParentFallback(selector, step) {
  const nonInteractiveTags = new Set(['svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'g', 'use', 'img', 'i', 'em', 'strong', 'b']);
  
  // Collect all xpath selectors from the candidates
  const candidates = [];
  if (selector?.primary) candidates.push(selector.primary);
  if (Array.isArray(selector?.fallbacks)) candidates.push(...selector.fallbacks);
  
  for (const cand of candidates) {
    if (cand?.type !== 'xpath') continue;
    const xpath = cand.value;
    if (!xpath) continue;
    
    // Check if the xpath ends with a non-interactive tag
    const lastSegmentMatch = xpath.match(/\/([a-zA-Z][a-zA-Z0-9]*)\s*(?:\[\d+\])?\s*$/);
    if (!lastSegmentMatch) continue;
    const lastTag = lastSegmentMatch[1].toLowerCase();
    if (!nonInteractiveTags.has(lastTag)) continue;
    
    console.log("[autotest][fallback] XPath ends in non-interactive tag:", lastTag, "— trying parent truncation");
    
    // Progressively remove segments from the end
    let truncated = xpath;
    for (let depth = 0; depth < 4; depth++) {
      // Remove the last /tag[n] segment
      const lastSlash = truncated.lastIndexOf('/');
      if (lastSlash <= 0) break;
      truncated = truncated.substring(0, lastSlash);
      
      try {
        const res = document.evaluate(truncated, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        const parentEl = res.singleNodeValue;
        if (!parentEl) continue;
        
        const pTag  = parentEl.tagName?.toLowerCase();
        const pRole = parentEl.getAttribute?.('role')?.toLowerCase();
        
        // Found an interactive parent?
        const isInteractive = pRole === 'checkbox' || pRole === 'radio' || pRole === 'switch' || pRole === 'button'
          || pTag === 'button' || pTag === 'a' || pTag === 'label'
          || (pTag === 'input');
        
        if (isInteractive) {
          console.log("[autotest][fallback] ✓ Found interactive parent via xpath truncation:", pTag, pRole || '');
          return {
            el: parentEl,
            used: { type: 'xpath', value: truncated, reason: 'svg-parent-fallback' },
            selectorAttempts: [{
              candidate: { type: 'xpath', value: truncated },
              found: true,
              visible: isElementVisible(parentEl),
              timestamp: Date.now(),
              fallbackType: 'svg-parent'
            }],
            visible: isElementVisible(parentEl)
          };
        }
        
        // Not the right parent yet, but check if it CONTAINS a checkbox/radio/switch
        const nestedToggle = parentEl.querySelector('[role="checkbox"], [role="radio"], [role="switch"]');
        if (nestedToggle) {
          console.log("[autotest][fallback] ✓ Found nested toggle element inside truncated xpath parent");
          return {
            el: nestedToggle,
            used: { type: 'xpath', value: truncated, reason: 'svg-parent-nested-toggle' },
            selectorAttempts: [{
              candidate: { type: 'xpath', value: truncated },
              found: true,
              visible: isElementVisible(nestedToggle),
              timestamp: Date.now(),
              fallbackType: 'svg-parent-nested'
            }],
            visible: isElementVisible(nestedToggle)
          };
        }

        // Also check for hidden input checkbox/radio siblings
        const hiddenInput = parentEl.querySelector('input[type="checkbox"], input[type="radio"]');
        if (hiddenInput) {
          // Prefer clicking the visible toggle or label near the hidden input
          const visibleToggle = parentEl.querySelector('[role="checkbox"], [role="radio"], [role="switch"], label');
          if (visibleToggle && isElementVisible(visibleToggle)) {
            console.log("[autotest][fallback] ✓ Found visible toggle near hidden input in truncated parent");
            return {
              el: visibleToggle,
              used: { type: 'xpath', value: truncated, reason: 'svg-parent-visible-toggle' },
              selectorAttempts: [{
                candidate: { type: 'xpath', value: truncated },
                found: true,
                visible: true,
                timestamp: Date.now(),
                fallbackType: 'svg-parent-visible-toggle'
              }],
              visible: true
            };
          }
          // Fall back to the hidden input itself (the click handler can resolve it)
          console.log("[autotest][fallback] ✓ Found hidden input in truncated parent, returning it");
          return {
            el: hiddenInput,
            used: { type: 'xpath', value: truncated, reason: 'svg-parent-hidden-input' },
            selectorAttempts: [{
              candidate: { type: 'xpath', value: truncated },
              found: true,
              visible: false,
              timestamp: Date.now(),
              fallbackType: 'svg-parent-hidden-input'
            }],
            visible: false
          };
        }
      } catch (e) {
        // xpath evaluation error — continue truncating
      }
    }
  }
  return null;
}

/**
 * Attribute-based fallback for checkbox/radio elements.
 * Uses the step's elementName, value, or selector metadata to find the element
 * by id, name, aria-label, or surrounding label text.
 */
function tryCheckboxRadioAttributeFallback(step, selector) {
  // Extract identifying info from step
  const name = step?.elementName || step?.customName || '';
  const selectorValue = selector?.primary?.value || '';
  
  // Try to extract an ID or name from the xpath (e.g. ...[@id='privacyPolicy'])
  let idHint = null;
  let nameHint = null;
  const idMatch = selectorValue.match(/\[@id=['"]([^'"]+)['"]\]/) || selectorValue.match(/#([a-zA-Z][\w-]*)/);
  if (idMatch) idHint = idMatch[1];
  const nameMatch = selectorValue.match(/\[@name=['"]([^'"]+)['"]\]/) || selectorValue.match(/\[name=['"]([^'"]+)['"]\]/);
  if (nameMatch) nameHint = nameMatch[1];
  
  // Also extract from the xpath path — look for id= in any of the fallbacks
  const allCandidates = [];
  if (selector?.primary) allCandidates.push(selector.primary);
  if (Array.isArray(selector?.fallbacks)) allCandidates.push(...selector.fallbacks);
  
  for (const cand of allCandidates) {
    if (!idHint && cand?.value) {
      const m = cand.value.match(/\[@id=['"]([^'"]+)['"]\]/) || cand.value.match(/#([a-zA-Z][\w-]*)/);
      if (m) idHint = m[1];
    }
    if (!nameHint && cand?.value) {
      const m = cand.value.match(/\[@name=['"]([^'"]+)['"]\]/) || cand.value.match(/\[name=['"]([^'"]+)['"]\]/);
      if (m) nameHint = m[1];
    }
  }
  
  // Try finding by ID
  if (idHint) {
    const byId = document.getElementById(idHint);
    if (byId) {
      const tag = byId.tagName?.toLowerCase();
      const inpType = byId.getAttribute?.('type')?.toLowerCase();
      const role = byId.getAttribute?.('role')?.toLowerCase();
      if ((tag === 'input' && (inpType === 'checkbox' || inpType === 'radio')) ||
          role === 'checkbox' || role === 'radio' || role === 'switch') {
        console.log("[autotest][fallback] Found checkbox/radio by ID:", idHint);
        return { el: byId, used: { type: 'css', value: `#${CSS.escape(idHint)}`, reason: 'attribute-fallback-id' } };
      }
      // Also check the related label element with -label suffix
      const labelId = idHint + '-label';
      const labelEl = document.getElementById(labelId);
      if (labelEl) {
        const lRole = labelEl.getAttribute?.('role')?.toLowerCase();
        if (lRole === 'checkbox' || lRole === 'radio' || lRole === 'switch') {
          console.log("[autotest][fallback] Found custom toggle by ID-label pattern:", labelId);
          return { el: labelEl, used: { type: 'css', value: `#${CSS.escape(labelId)}`, reason: 'attribute-fallback-label-id' } };
        }
      }
    }
  }
  
  // Try finding by name
  if (nameHint) {
    const byName = document.querySelector(`input[name="${CSS.escape(nameHint)}"]`);
    if (byName) {
      const inpType = byName.getAttribute?.('type')?.toLowerCase();
      if (inpType === 'checkbox' || inpType === 'radio') {
        console.log("[autotest][fallback] Found checkbox/radio by name:", nameHint);
        return { el: byName, used: { type: 'css', value: `input[name="${CSS.escape(nameHint)}"]`, reason: 'attribute-fallback-name' } };
      }
    }
  }
  
  // Try finding by aria-label containing the element name
  if (name && name.length > 3) {
    const allToggles = document.querySelectorAll('[role="checkbox"], [role="radio"], [role="switch"], input[type="checkbox"], input[type="radio"]');
    for (const toggle of allToggles) {
      const ariaLabel = toggle.getAttribute('aria-label') || '';
      const text = toggle.textContent || '';
      if (ariaLabel.toLowerCase().includes(name.toLowerCase()) || text.toLowerCase().includes(name.toLowerCase())) {
        console.log("[autotest][fallback] Found toggle by aria-label/text match:", name);
        return { el: toggle, used: { type: 'attribute', value: `aria-label match: ${name}`, reason: 'attribute-fallback-text' } };
      }
    }
  }
  
  return null;
}

/**
 * Multi-hop element finding with backend refinement
 */
async function findElementWithRefinement(step, selector, maxRetries = 3, customTimeoutMs) {
  console.log("[autotest][refinement] ===== MULTI-HOP ELEMENT FINDING =====");
  
  // First, try standard element finding (with optional custom timeout)
  const waitOpts = customTimeoutMs ? { timeoutMs: customTimeoutMs } : {};
  const initialResult = await waitForElementVisible(selector, waitOpts);
  
  if (initialResult.el) {
    return initialResult;
  }
  
  // ── SVG/non-interactive xpath fallback ──
  // If the selector is an xpath ending in svg/path/g/circle/etc., the element
  // was likely recorded on an icon inside a custom control (e.g. role="checkbox").
  // Try truncating the xpath progressively to find the interactive parent.
  const svgParentResult = await trySvgParentFallback(selector, step);
  if (svgParentResult?.el) {
    console.log("[autotest][refinement] Found element via SVG parent xpath fallback");
    return svgParentResult;
  }
  
  // ── Attribute-based fallback for checkboxes/radios ──
  // Try to find the element using step metadata (name, id, aria-label, etc.)
  const attrResult = tryCheckboxRadioAttributeFallback(step, selector);
  if (attrResult?.el) {
    console.log("[autotest][refinement] Found element via checkbox/radio attribute fallback");
    return {
      el: attrResult.el,
      used: attrResult.used,
      selectorAttempts: [...(initialResult.selectorAttempts || []), {
        candidate: attrResult.used,
        found: true,
        visible: isElementVisible(attrResult.el),
        timestamp: Date.now(),
        fallbackType: 'attribute'
      }],
      visible: isElementVisible(attrResult.el)
    };
  }
  
  // Backend service has been removed — skip refinement loop
  console.log("[autotest][refinement] Backend removed, skipping refinement");
  return initialResult;
}

// Deliberately does NOT check opacity. Many UI libraries (Angular Material's
// MDC checkboxes/radios/switches, MUI, and plenty of custom widgets) render
// the real native <input> transparent (opacity: 0) and layered on top of a
// decorative sibling that shows the visible checkmark/box — the input is
// still exactly where the user clicks and still toggles on click, it's just
// visually see-through. Treating opacity 0 as "not visible" made replay wait
// out the full 10-minute elementVisibleMs timeout on every such control
// (see waitForElementVisible) since it never becomes non-transparent.
function isElementVisible(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
  const style = window.getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * Strip dynamic content (prices, numbers, dates, etc.) from text for comparison.
 */
function stripDynamicContent(text) {
  return String(text || "")
    .replace(/[₹$€£¥]\s*[\d,]+\.?\d*/g, '')   // Currency
    .replace(/\b[\d,]+\.?\d+\b/g, '')            // Numbers with commas/decimals
    .replace(/\d+\.?\d*\s*%/g, '')                // Percentages
    .replace(/\d{1,2}:\d{2}\s*(AM|PM|am|pm)?/g, '') // Times
    .replace(/\d{1,4}[-/]\d{1,2}[-/]\d{1,4}/g, '')  // Dates
    .replace(/\b\d+\b/g, '')                      // Standalone digits
    .replace(/\+/g, '')                            // Plus signs from prices
    .replace(/\s+/g, ' ')                          // Collapse whitespace
    .trim()
    .toLowerCase();
}

function resolveByText(text) {
  const wanted = String(text || "").trim();
  if (!wanted) return null;
  
  const wantedLower = wanted.toLowerCase();
  const wantedStripped = stripDynamicContent(wanted);
  
  const nodes = Array.from(document.querySelectorAll("button, a, label, [role], [aria-label], span, div"));
  
  // Phase 1: Exact text match
  for (const node of nodes) {
    const t = String(node.textContent || "").trim();
    if (t === wanted && isElementVisible(node)) return node;
  }
  
  // Phase 2: Case-insensitive exact match
  for (const node of nodes) {
    const t = String(node.textContent || "").trim().toLowerCase();
    if (t === wantedLower && isElementVisible(node)) return node;
  }
  
  // Phase 3: Fuzzy match — strip dynamic content and compare
  if (wantedStripped && wantedStripped.length >= 3) {
    let bestNode = null;
    let bestScore = 0;
    
    for (const node of nodes) {
      if (!isElementVisible(node)) continue;
      const nodeStripped = stripDynamicContent(node.textContent);
      if (!nodeStripped) continue;
      
      // Exact match after stripping dynamic content
      if (nodeStripped === wantedStripped) {
        return node;
      }
      
      // Containment match (wanted is in the node text or vice versa)
      if (nodeStripped.includes(wantedStripped)) {
        const score = wantedStripped.length / nodeStripped.length;
        if (score > bestScore) {
          bestScore = score;
          bestNode = node;
        }
      } else if (wantedStripped.includes(nodeStripped) && nodeStripped.length > 5) {
        const score = nodeStripped.length / wantedStripped.length * 0.8;
        if (score > bestScore) {
          bestScore = score;
          bestNode = node;
        }
      }
    }
    
    // Accept if we have a reasonable match (>40% overlap)
    if (bestNode && bestScore > 0.4) {
      console.log(`[autotest][resolveByText] Fuzzy match: "${wanted}" → "${bestNode.textContent?.trim()?.substring(0, 50)}" (score: ${bestScore.toFixed(2)})`);
      return bestNode;
    }
  }
  
  return null;
}

/**
 * Walk all elements (including inside open shadow roots) and test each
 * against a predicate. Stops at the first match.
 */
function _walkDOM(root, predicate) {
  if (!root) return null;
  const iter = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node = iter.nextNode();
  while (node) {
    if (predicate(node)) return node;
    // Recurse into open shadow roots
    if (node.shadowRoot) {
      const inShadow = _walkDOM(node.shadowRoot, predicate);
      if (inShadow) return inShadow;
    }
    node = iter.nextNode();
  }
  return null;
}

/**
 * Parse a simple [attr="value"], [attr^="value"], or [attr*="value"] pattern
 * from a CSS selector string and return {attr, op, value} or null.
 */
function _parseSimpleAttrSelector(css) {
  const m = css.match(/^\[([a-zA-Z][\w-]*)(=|\^=|\*=)"([^"]*)"\]$/);
  if (!m) return null;
  return { attr: m[1], op: m[2], value: m[3] };
}

function resolveBySelectorCandidate(candidate) {
  if (!candidate) return null;

  // Try main document first, then fallback to iframes and shadow DOMs
  const mainResult = _resolveInDocument(candidate, document);
  if (mainResult) return mainResult;

  // ── iframe fallback: search inside same-origin iframes ──
  try {
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        const iDoc = iframe.contentDocument;
        if (!iDoc) continue; // cross-origin
        const found = _resolveInDocument(candidate, iDoc);
        if (found) {
          console.log('[autotest][selector] Element found inside iframe:', iframe.src || iframe.id);
          return found;
        }
      } catch { /* cross-origin or security error */ }
    }
  } catch {}

  // ── Shadow DOM fallback: search inside open shadow roots ──
  try {
    const found = _resolveInShadowRoots(candidate, document.body);
    if (found) {
      console.log('[autotest][selector] Element found inside shadow DOM');
      return found;
    }
  } catch {}

  // ── Attribute DOM-walk fallback ───────────────────────────────────────────
  // When querySelectorAll returns nothing (e.g. attribute value encoding edge
  // cases, detached sub-trees, or unusual DOM structures), walk the full DOM
  // tree manually and compare attribute values directly via getAttribute().
  // This handles [aria-label="..."], [data-testid="..."], [placeholder="..."],
  // [title="..."], etc. — any single-attribute CSS selector pattern.
  if (candidate?.type === 'css') {
    const parsed = _parseSimpleAttrSelector(candidate.value.trim());
    if (parsed) {
      const { attr, op, value } = parsed;
      const found = _walkDOM(document.body, (el) => {
        const attrVal = el.getAttribute(attr);
        if (attrVal === null) return false;
        if (op === '=')  return attrVal === value;
        if (op === '^=') return attrVal.startsWith(value);
        if (op === '*=') return attrVal.includes(value);
        return false;
      });
      if (found) {
        console.log(`[autotest][selector] Element found via attr DOM-walk: ${attr}${op}"${value}"`);
        return found;
      }
    }
  }

  return null;
}

/**
 * Dedicated aria-label search using JS attribute filtering.
 * Handles exact match, starts-with (^=), and contains (*=) by reading
 * getAttribute('aria-label') directly — immune to CSS-engine quoting edge cases.
 *
 * Also strips dynamic state suffixes like "(currently light mode)" from exact
 * match selectors before searching, so a recorded step survives state changes.
 */
function _resolveByAriaLabel(cssValue, doc) {
  const m = cssValue.trim().match(/^\[aria-label(=|\^=|\*=)"([^"]*)"\]$/);
  if (!m) return null;
  const op = m[1], value = m[2];

  // For exact-match selectors with a trailing parenthetical state suffix,
  // automatically fall back to a starts-with search using the stable prefix.
  // e.g. [aria-label="Toggle (currently ON)"] → also try startsWith("Toggle")
  const strippedValue = value.replace(/\s*\([^)]*\)\s*$/, '').trim();

  const all = doc.querySelectorAll('[aria-label]');
  let fallbackMatch = null;

  for (const el of all) {
    const label = el.getAttribute('aria-label');
    if (label === null) continue;

    if (op === '=')  { if (label === value) return el; }
    else if (op === '^=') { if (label.startsWith(value)) return el; }
    else if (op === '*=') { if (label.includes(value)) return el; }

    // Stable-prefix fallback for exact-match selectors
    if (op === '=' && strippedValue && strippedValue !== value && !fallbackMatch) {
      if (label.startsWith(strippedValue)) fallbackMatch = el;
    }
  }

  return fallbackMatch || null;
}

function _resolveInDocument(candidate, doc) {
  if (!candidate || !doc) return null;
  if (candidate.type === "css") {
    // Fast path: aria-label selectors use JS attribute filtering for reliability.
    // This bypasses any CSS-engine quoting/encoding edge cases entirely.
    if (/\[aria-label[*^]?=/.test(candidate.value)) {
      const found = _resolveByAriaLabel(candidate.value, doc);
      if (found) return found;
      // Fall through to querySelectorAll as secondary attempt
    }

    if (Number.isInteger(candidate.matchIndex) && candidate.matchIndex >= 0) {
      try {
        const nodes = Array.from(doc.querySelectorAll(candidate.value));
        const idx = candidate.matchIndex;
        const node = nodes[idx] || null;
        if (node && isElementVisible(node)) return node;
        const visible = nodes.find((n) => isElementVisible(n));
        if (visible) return visible;
        return node || nodes[0] || null;
      } catch (err) {
        console.warn("[autotest] Invalid CSS selector:", candidate.value, err);
        return null;
      }
    }
    try {
      const nodes = doc.querySelectorAll(candidate.value);
      return nodes[0] || null;
    } catch (err) {
      console.warn("[autotest] Invalid CSS selector:", candidate.value, err);
      return null;
    }
  }
  if (candidate.type === "text") {
    return resolveByText(candidate.value);
  }
  if (candidate.type === "xpath") {
    try {
      const res = doc.evaluate(
        candidate.value,
        doc,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      );
      return res.singleNodeValue || null;
    } catch {
      return null;
    }
  }
  return null;
}

function _resolveInShadowRoots(candidate, root) {
  if (!root) return null;
  // Check this element's shadow root
  if (root.shadowRoot) {
    const found = _resolveInDocument(candidate, root.shadowRoot);
    if (found) return found;
    // Also recurse into children of shadow root
    for (const child of root.shadowRoot.children) {
      const deep = _resolveInShadowRoots(candidate, child);
      if (deep) return deep;
    }
  }
  // Recurse into regular children
  for (const child of root.children || []) {
    const deep = _resolveInShadowRoots(candidate, child);
    if (deep) return deep;
  }
  return null;
}

/**
 * For CSS attribute selectors that use exact-match (attr="value"), automatically
 * generate looser fallback variants to handle dynamic values at replay time.
 *
 * Examples:
 *   [aria-label="Switch between dark and light mode (currently light mode)"]
 *   → [aria-label^="Switch between dark and light mode"]  (starts-with static part)
 *   → [aria-label*="Switch between dark and light mode"]  (contains static part)
 */
function _looseCssFallbacks(cssValue) {
  if (typeof cssValue !== 'string') return [];
  const fallbacks = [];

  // Match [attr="value"] patterns
  const exactAttrRe = /\[([a-zA-Z][\w-]*)="([^"]+)"\]/g;
  let match;
  while ((match = exactAttrRe.exec(cssValue)) !== null) {
    const attr = match[1];
    const val  = match[2];

    // Strip trailing parenthetical state: "Label text (currently X)" → "Label text"
    const stripped = val.replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (stripped && stripped !== val) {
      // starts-with the stable prefix
      fallbacks.push({
        type: "css",
        value: cssValue.replace(match[0], `[${attr}^="${stripped.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`),
        reason: `Dynamic attr fallback: ${attr} starts-with stable prefix`
      });
      // contains the stable prefix (even looser)
      fallbacks.push({
        type: "css",
        value: cssValue.replace(match[0], `[${attr}*="${stripped.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`),
        reason: `Dynamic attr fallback: ${attr} contains stable prefix`
      });
    }
  }
  return fallbacks;
}

async function waitForElementVisible(selector, { timeoutMs = DEFAULT_WAIT.elementVisibleMs } = {}) {
  if (!selector) return { el: null, used: null, selectorAttempts: [], visible: false };
  const candidates = [];
  if (selector.primary) candidates.push(selector.primary);
  if (Array.isArray(selector.fallbacks)) candidates.push(...selector.fallbacks);

  // Auto-inject loose fallbacks for any exact CSS attribute selectors
  // (handles dynamic aria-labels, titles, etc. recorded with state in the value)
  const looseFallbacks = [];
  for (const c of candidates) {
    if (c?.type === 'css') {
      looseFallbacks.push(..._looseCssFallbacks(c.value));
    }
  }
  if (looseFallbacks.length) candidates.push(...looseFallbacks);

  // Validate CSS candidates once up front, not on every poll tick.
  const validCandidates = candidates.filter((candidate) => {
    if (candidate?.type !== "css") return true;
    try {
      document.querySelectorAll(candidate.value);
      return true;
    } catch (err) {
      console.warn(`[autotest][replay] ✗ Invalid CSS selector, skipping:`, candidate.value, err.message);
      return false;
    }
  });

  console.log("[autotest][replay] Trying selectors:", {
    total: validCandidates.length,
    primary: selector.primary?.value || selector.primary?.type,
    fallbackCount: selector.fallbacks?.length || 0
  });

  // Check every candidate on every poll tick (instead of exhausting the
  // primary candidate's own timeout before even trying a fallback). If the
  // primary selector never matches, a working fallback still resolves within
  // one poll interval instead of after several seconds of wasted waiting.
  const selectorAttempts = [];
  let bestHidden = null; // first found-but-not-yet-visible match, kept as a fallback result

  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    let firstVisible = null; // first visible match, in candidate priority order — used if none are unique
    // Lowest priority: unique right now, but via a framework auto-generated id
    // (e.g. jQuery UI autocomplete's #ui-id-N). These are assigned from a
    // counter shared across every such widget on the page, so the number is
    // tied to page load order/timing, not to any specific option — it can
    // (and does) point at a completely different element in a later session,
    // even though it resolves to exactly one real element right now. This
    // matters most for OLD recordings made before this candidate ordering
    // existed, where the unstable id may still be stored as primary — this
    // check demotes it at replay time too, so a better fallback (typically a
    // text match on the option's actual visible label) gets tried first
    // without needing to re-record.
    let unstableIdMatch = null;
    for (const candidate of validCandidates) {
      const el = resolveBySelectorCandidate(candidate);
      if (!el) continue;
      if (isElementVisible(el)) {
        // A recorded selector can be shared by several sibling elements (e.g.
        // a composite date field where day/month/year all point at the same
        // aria-labelledby). If this candidate resolves to exactly one element
        // right now, trust it immediately — don't let an earlier, ambiguous
        // candidate (which also happens to be visible) win just because it's
        // first in priority order.
        // Use the same visibility-aware uniqueness check as generateSelector —
        // a raw querySelectorAll().length count would wrongly reject a
        // genuinely-unique-for-the-user's-purposes selector whenever AEM (or
        // similar frameworks) leave a hidden template/clone element around
        // with identical attributes, sending resolution all the way down to
        // the brittle XPath fallback for no real reason.
        const isUnique = candidate.type !== "css" || isUniqueMatchFor(el, candidate.value);
        const idMatch = candidate.type === "css" ? /^#([\w-]+)$/.exec(candidate.value) : null;
        const isUnstableId = !!idMatch && isLikelyUnstableFrameworkId(idMatch[1]);
        if (isUnique && !isUnstableId) {
          console.log(`[autotest][replay] ✓ Selector matched (visible, unique):`, {
            type: candidate?.type,
            value: candidate?.value?.substring?.(0, 100)
          });
          selectorAttempts.push({ candidate, found: true, visible: true, timestamp: Date.now() });
          return { el, used: candidate, selectorAttempts, visible: true };
        }
        if (isUnique && isUnstableId) {
          if (!unstableIdMatch) unstableIdMatch = { el, candidate };
          continue; // keep looking for something more trustworthy this tick
        }
        if (!firstVisible) firstVisible = { el, candidate };
      } else if (!bestHidden) {
        bestHidden = { el, candidate };
      }
    }
    // No trustworthy candidate uniquely matched this tick — fall back to the
    // first ambiguous-but-visible match in priority order, and only then to
    // an unstable-id match (better than nothing, but least trusted).
    if (firstVisible) {
      console.log(`[autotest][replay] ✓ Selector matched (visible, ambiguous — no unique candidate available):`, {
        type: firstVisible.candidate?.type,
        value: firstVisible.candidate?.value?.substring?.(0, 100)
      });
      selectorAttempts.push({ candidate: firstVisible.candidate, found: true, visible: true, timestamp: Date.now() });
      return { el: firstVisible.el, used: firstVisible.candidate, selectorAttempts, visible: true };
    }
    if (unstableIdMatch) {
      console.warn(`[autotest][replay] ⚠ Selector matched (visible, unique) but only via a framework auto-generated id — using as last resort:`, {
        type: unstableIdMatch.candidate?.type,
        value: unstableIdMatch.candidate?.value?.substring?.(0, 100)
      });
      selectorAttempts.push({ candidate: unstableIdMatch.candidate, found: true, visible: true, timestamp: Date.now() });
      return { el: unstableIdMatch.el, used: unstableIdMatch.candidate, selectorAttempts, visible: true };
    }
    await nextFrame();
  }

  // Nothing became visible within the timeout — if something matched but
  // stayed hidden, return it anyway (some interactions work on hidden elements).
  if (bestHidden) {
    console.log(`[autotest][replay] ⚠ Selector matched (hidden):`, {
      type: bestHidden.candidate?.type,
      value: bestHidden.candidate?.value?.substring?.(0, 100)
    });
    selectorAttempts.push({ candidate: bestHidden.candidate, found: true, visible: false, timestamp: Date.now() });
    return { el: bestHidden.el, used: bestHidden.candidate, selectorAttempts, visible: false };
  }

  for (const candidate of validCandidates) {
    selectorAttempts.push({ candidate, found: false, visible: false, timestamp: Date.now() });
  }
  console.log("[autotest][replay] All selectors exhausted. No element found.");
  return { el: null, used: null, selectorAttempts, visible: false };
}

function getElementText(el) {
  if (!el) return "";
  // Prefer innerText (respects visibility); fallback to textContent.
  const text = typeof el.innerText === "string" ? el.innerText : el.textContent;
  return String(text || "").trim();
}

async function waitForDOMStable({
  stableMs = DEFAULT_WAIT.domStableMs,
  timeoutMs = DEFAULT_WAIT.domStableTimeoutMs
} = {}) {
  let lastMutation = performance.now(); // must observe a real quiet period before declaring stable
  const observer = new MutationObserver(() => {
    lastMutation = performance.now();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true
  });

  const start = performance.now();
  try {
    while (performance.now() - start < timeoutMs) {
      const now = performance.now();
      const idleFor = now - lastMutation;
      if (idleFor >= stableMs) return { ok: true };
      await nextFrame();
    }
    return { ok: false, error: "DOM did not stabilize within timeout." };
  } finally {
    observer.disconnect();
  }
}

async function waitForNetworkIdle({
  idleMs = DEFAULT_WAIT.networkIdleMs,
  timeoutMs = DEFAULT_WAIT.networkIdleTimeoutMs
} = {}) {
  patchNetworkTracking();
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const now = performance.now();
    const idleFor = now - networkTracker.lastActivity;
    if (networkTracker.pending === 0 && idleFor >= idleMs) {
      return { ok: true };
    }
    await nextFrame();
  }
  return { ok: false, error: "Network did not become idle within timeout." };
}

// Generic patterns for app-rendered loading overlays/spinners. A spinner is
// often just a static SVG/icon with a CSS animation — once inserted it stops
// triggering DOM mutations, so waitForDOMStable alone can't detect it. This
// catches the case where a loader appears *after* the page already looked
// quiet (e.g. a delayed data fetch that re-renders the form a few seconds
// after initial load).
const LOADING_INDICATOR_SELECTORS = [
  '[aria-busy="true"]',
  '[role="progressbar"]',
  '[class*="spinner" i]',
  '[class*="loader" i]',
  '[class*="loading" i]',
  '[class*="blockui" i]',
  '[class*="busy" i]'
];

// "overlay"/"backdrop" class names are ambiguous: they match real blocking
// loaders (a custom "loading-overlay" div) but also the dimming layer that
// legitimate modals/dialogs render behind themselves — jQuery UI's
// .ui-widget-overlay, Bootstrap's .modal-backdrop, etc. When a dialog is
// genuinely open, that backdrop staying visible for as long as the user is
// filling in fields inside it is expected, not a "still loading" signal.
// These patterns are only trusted when getOpenDialog() finds no open dialog
// (see findVisibleLoadingIndicator) — unlike a "loaderPanel"-style false
// positive, a real backdrop has no form content of its own to filter on.
const OVERLAY_INDICATOR_SELECTORS = [
  '[class*="overlay" i]',
  '[class*="backdrop" i]'
];

// Name-agnostic backstop: a large, high-z-index, fixed/absolute element
// covering most of the viewport is very likely a blocking overlay regardless
// of what it's actually called — e.g. jQuery's blockUI plugin (common on
// older AEM/jQuery forms) names its overlay ".blockOverlay"/".blockMsg",
// which none of the class-name patterns above account for. Requiring large
// coverage + high z-index keeps this from matching normal fixed headers,
// cookie banners, etc.
function isLikelyBlockingOverlay(el) {
  if (!el || !isElementVisible(el)) return false;
  // AEM's author-mode editing placeholders ("drag components here" drop
  // targets, e.g. .cq-placeholder/.afEditorPlaceholder) stay in the DOM even
  // on published pages. They're normally-empty structural scaffolding, not a
  // loading state — but one can inherit the same fixed/full-coverage/
  // high-z-index styling as a real popup sitting next to it (no interactive
  // content to otherwise exclude it), which made it look like a permanently
  // stuck "loading overlay" that would never actually clear.
  if (el.classList.contains('cq-placeholder') || el.classList.contains('afEditorPlaceholder')) return false;
  const style = window.getComputedStyle(el);
  if (style.position !== "fixed" && style.position !== "absolute") return false;
  const rect = el.getBoundingClientRect();
  const viewportArea = window.innerWidth * window.innerHeight;
  if (viewportArea <= 0) return false;
  const coverage = (rect.width * rect.height) / viewportArea;
  if (coverage < 0.6) return false;
  const zIndex = parseInt(style.zIndex, 10);
  if (Number.isNaN(zIndex) || zIndex < 100) return false;
  if (containsInteractiveFormContent(el)) return false;
  return true;
}

// A genuine loading spinner/overlay is decorative — it never contains actual
// form controls the user needs to interact with. Some apps' popup/panel
// containers happen to carry a "loader"/"loading"/"overlay"-named class for
// unrelated reasons (transition/animation styling, legacy naming, etc.) —
// e.g. an AEM Forms guide popup panel named "...FormPopupPanel loaderPanel"
// that holds real input fields and a submit button. Class-name matching alone
// can't tell these apart, but content can: if the "loader" candidate contains
// real interactive controls, it's a content panel, not a blocking loader.
function containsInteractiveFormContent(el) {
  try {
    return !!el.querySelector('input, textarea, select, button, a[href]');
  } catch (_) {
    return false;
  }
}

function findVisibleLoadingIndicator() {
  for (const sel of LOADING_INDICATOR_SELECTORS) {
    let els;
    try {
      els = document.querySelectorAll(sel);
    } catch (_) {
      continue; // Some browsers may not support the "i" case-insensitive flag.
    }
    for (const el of els) {
      if (isExtensionUiTarget(el)) continue; // Ignore our own HUD/panel.
      if (!isElementVisible(el)) continue;
      if (containsInteractiveFormContent(el)) continue;
      return el;
    }
  }

  // A genuinely open dialog/modal explains any overlay/backdrop-shaped
  // element on the page — it's the dialog's own dimming layer, not a
  // blocking loader. Treating it as one here would make every step
  // targeting fields inside the dialog wait out the full timeout for as
  // long as the dialog stays open, since the backdrop never disappears
  // until the dialog itself closes.
  if (getOpenDialog()) return null;

  for (const sel of OVERLAY_INDICATOR_SELECTORS) {
    let els;
    try {
      els = document.querySelectorAll(sel);
    } catch (_) {
      continue;
    }
    for (const el of els) {
      if (isExtensionUiTarget(el)) continue;
      if (!isElementVisible(el)) continue;
      if (containsInteractiveFormContent(el)) continue;
      return el;
    }
  }

  // Fall back to the name-agnostic overlay heuristic, checked over a bounded
  // set of candidates (elements with a non-static position, which is most of
  // what modals/overlays/loaders use) rather than every element on the page.
  try {
    const candidates = document.querySelectorAll('div, section, aside');
    for (const el of candidates) {
      if (isExtensionUiTarget(el)) continue;
      if (isLikelyBlockingOverlay(el)) return el;
    }
  } catch (_) {}

  return null;
}

async function waitForNoLoadingIndicator({
  timeoutMs = DEFAULT_WAIT.loadingIndicatorTimeoutMs
} = {}) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const indicator = findVisibleLoadingIndicator();
    if (!indicator) return { ok: true };
    await nextFrame();
  }
  return { ok: false, error: "A loading indicator is still visible after timeout.", code: "LOADER_STILL_VISIBLE" };
}

// Runs the DOM/network/loader checks as ONE continuous poll loop instead of
// three sequential ones. Calling waitForDOMStable() then waitForNetworkIdle()
// then waitForNoLoadingIndicator() back-to-back leaves gaps where nothing is
// actively watching — e.g. a delayed prefill fetch that starts right in the
// gap between two of those calls (or right after the last one returns) slips
// through undetected. Here all three signals are re-checked every frame for
// the whole window, so something that starts a few seconds in still resets
// the "quiet" timer and gets waited out.
async function waitForPageIdle({
  quietMs = DEFAULT_WAIT.pageIdleQuietMs,
  timeoutMs = DEFAULT_WAIT.pageIdleTimeoutMs,
  loaderTimeoutMs = DEFAULT_WAIT.loadingIndicatorTimeoutMs
} = {}) {
  // Phase 1: a visible loading overlay gets its own dedicated, 10-minute wait,
  // separate from (and before) the fast ambient DOM/network quiet check
  // below. It's a much stronger "not ready" signal than background chatter,
  // so unlike phase 2 below, exhausting this window is treated as a real
  // failure by performStep() (which aborts the whole replay) rather than
  // proceeding against a page that's still loading.
  const loaderResult = await waitForNoLoadingIndicator({ timeoutMs: loaderTimeoutMs });
  if (!loaderResult.ok) return loaderResult;

  patchNetworkTracking();
  const root = document.documentElement;
  let lastUnsettled = performance.now();
  const observer = new MutationObserver((mutations) => {
    // Ignore mutations that are just network-tracker-main.js reporting its
    // own state — those are handled explicitly via mainWorldBusy below, and
    // double-counting them here doesn't add signal, just noise in the diff.
    const realMutation = mutations.some((m) =>
      !(m.type === "attributes" && m.target === root &&
        (m.attributeName === "data-autotest-net-pending" || m.attributeName === "data-autotest-net-last-activity"))
    );
    if (realMutation) lastUnsettled = performance.now();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true
  });

  const start = performance.now();
  try {
    while (performance.now() - start < timeoutMs) {
      const now = performance.now();
      // networkTracker only sees fetch/XHR calls the extension's own isolated
      // world makes — it can't see the page's real network calls (those run
      // in the MAIN world, a separate JS realm with its own fetch/XHR).
      // network-tracker-main.js patches the real ones and reports back via
      // DOM attributes, which (unlike JS state) are visible across worlds.
      const isolatedWorldBusy = networkTracker.pending > 0 || (now - networkTracker.lastActivity) < quietMs;
      const mainWorldPending = Number(root.getAttribute("data-autotest-net-pending") || "0");
      const mainWorldLastActivity = Number(root.getAttribute("data-autotest-net-last-activity") || "0");
      const mainWorldBusy = mainWorldPending > 0 || (mainWorldLastActivity && (Date.now() - mainWorldLastActivity) < quietMs);
      const loaderVisible = !!findVisibleLoadingIndicator();
      if (isolatedWorldBusy || mainWorldBusy || loaderVisible) {
        lastUnsettled = now;
      }
      if (now - lastUnsettled >= quietMs) return { ok: true };
      await nextFrame();
    }
    // Note: unlike the phase-1 loader timeout above, this stays best-effort —
    // some pages legitimately never go fully network/DOM quiet (analytics
    // beacons, countdown timers), so proceeding anyway avoids the whole
    // replay aborting over background chatter that isn't actually blocking.
    return { ok: false, error: "Page did not settle (DOM/network/loading indicator) within timeout.", code: "PAGE_NOT_SETTLED" };
  } finally {
    observer.disconnect();
  }
}

/**
 * Dispatch a full, realistic click event sequence on an element.
 * A real user click produces: pointerdown → mousedown → pointerup → mouseup → click.
 * Many frameworks (React, Angular, Vue) listen for mousedown/pointerdown
 * and will NOT respond to a bare el.click(). This is critical for custom
 * radio buttons, checkboxes, toggles, and dropdown triggers.
 */
/**
 * Dispatch a realistic click sequence on an element.
 *
 * Two modes:
 *   • **nativeCheckRadio = true** (for `<input type="checkbox/radio">`):
 *       Uses synthetic `MouseEvent('click')` which toggles `.checked` once.
 *       Does NOT call `el.click()` (would double-toggle).
 *
 *   • **nativeCheckRadio = false** (buttons, links, divs, custom controls):
 *       Dispatches pointer/mouse DOWN/UP events for hover/focus effects,
 *       then uses `el.click()` as the ONLY click trigger.
 *       `el.click()` produces `isTrusted: true` in Chrome, which is critical
 *       because React 17+ delegated listeners process trusted events properly.
 *       The synthetic `MouseEvent('click')` (isTrusted: false) is SKIPPED —
 *       it would trigger the browser's default action (page navigation for
 *       `<a>` tags, form submit for `<button>` in `<form>`) before React's
 *       handler has a chance to call `e.preventDefault()`.
 */
function dispatchRealClick(el, { nativeCheckRadio = false } = {}) {
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  
  const shared = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    screenX: x + window.screenX,
    screenY: y + window.screenY,
    button: 0,
  };
  
  // Focus the element first (some controls need focus before click)
  try { el.focus(); } catch (e) { /* non-focusable */ }
  
  // 1. Pointer events (modern browsers) — no default actions, safe to dispatch
  try {
    el.dispatchEvent(new PointerEvent('pointerdown', { ...shared, buttons: 1, pointerId: 1, pointerType: 'mouse' }));
  } catch (e) { /* PointerEvent not supported */ }
  
  // 2. Mouse down — no default navigation action
  el.dispatchEvent(new MouseEvent('mousedown', { ...shared, buttons: 1 }));
  
  // 3. Pointer up
  try {
    el.dispatchEvent(new PointerEvent('pointerup', { ...shared, buttons: 0, pointerId: 1, pointerType: 'mouse' }));
  } catch (e) { /* PointerEvent not supported */ }
  
  // 4. Mouse up
  el.dispatchEvent(new MouseEvent('mouseup', { ...shared, buttons: 0 }));
  
  // 5. Click — strategy depends on element type
  if (nativeCheckRadio) {
    // Checkbox/radio: use synthetic event to toggle .checked once.
    // el.click() would also toggle, causing a double-toggle, so we skip it.
    el.dispatchEvent(new MouseEvent('click', { ...shared, buttons: 0 }));
  } else {
    // Everything else (buttons, links, custom controls, React components):
    // Use el.click() exclusively. This produces isTrusted:true which React
    // and other frameworks handle correctly. The synthetic MouseEvent('click')
    // is intentionally NOT dispatched — it would trigger default browser
    // actions (navigation, form submit) without React's handler having a
    // chance to call preventDefault().
    try { el.click(); } catch (e) { /* .click() not available */ }
  }
}

/**
 * Directly invoke a React component's onClick handler by walking the React
 * fiber tree attached to the DOM element. This bypasses React's event
 * delegation entirely and is the most reliable way to trigger React handlers.
 *
 * @returns {boolean} true if a React handler was found and invoked
 */
function tryReactOnClick(el) {
  if (!el) return false;
  
  // React attaches fibers via __reactFiber$... or __reactInternalInstance$... keys
  const fiberKey = Object.keys(el).find(k =>
    k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
  );
  if (!fiberKey) return false;
  
  let fiber = el[fiberKey];
  
  // Walk up the fiber tree to find an onClick prop (max 15 levels)
  for (let i = 0; i < 15 && fiber; i++) {
    const props = fiber.memoizedProps || fiber.pendingProps;
    if (props?.onClick && typeof props.onClick === 'function') {
      console.log("[autotest][replay] Found React onClick handler on fiber, invoking directly");
      try {
        // Create a minimal synthetic-React-like event object
        const fakeEvent = {
          type: 'click',
          target: el,
          currentTarget: el,
          bubbles: true,
          cancelable: true,
          defaultPrevented: false,
          isTrusted: true,
          preventDefault() { this.defaultPrevented = true; },
          stopPropagation() {},
          stopImmediatePropagation() {},
          persist() {},
          nativeEvent: new MouseEvent('click', { bubbles: true }),
        };
        props.onClick(fakeEvent);
        return true;
      } catch (err) {
        console.warn("[autotest][replay] React onClick invocation failed:", err);
        return false;
      }
    }
    fiber = fiber.return; // Walk up the tree
  }
  
  // Also check __reactProps$... (React 18+)
  const propsKey = Object.keys(el).find(k => k.startsWith('__reactProps$'));
  if (propsKey) {
    const props = el[propsKey];
    if (props?.onClick && typeof props.onClick === 'function') {
      console.log("[autotest][replay] Found React onClick via __reactProps$, invoking directly");
      try {
        const fakeEvent = {
          type: 'click',
          target: el,
          currentTarget: el,
          bubbles: true,
          cancelable: true,
          defaultPrevented: false,
          isTrusted: true,
          preventDefault() { this.defaultPrevented = true; },
          stopPropagation() {},
          stopImmediatePropagation() {},
          persist() {},
          nativeEvent: new MouseEvent('click', { bubbles: true }),
        };
        props.onClick(fakeEvent);
        return true;
      } catch (err) {
        console.warn("[autotest][replay] React onClick (__reactProps$) invocation failed:", err);
        return false;
      }
    }
  }
  
  return false;
}

/**
 * Returns the topmost open dialog/modal element, or null if none is open.
 * Covers: <dialog open>, [role="dialog"], common modal class patterns.
 */
function getOpenDialog() {
  // Native <dialog> element
  const nativeDialog = document.querySelector('dialog[open]');
  if (nativeDialog) return nativeDialog;

  // ARIA dialog roles that are visible
  const ariaDialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"]');
  for (const d of ariaDialogs) {
    if (isElementVisible(d)) return d;
  }

  // Common class-based modals (Bootstrap, Tailwind, Material, jQuery UI, etc.)
  // jQuery UI's .dialog() widget (which AEM Forms guide "popup" panels are
  // commonly rendered through) wraps content in .ui-dialog; it also sets
  // role="dialog" in modern versions, but older markup may omit it.
  const classPatterns = [
    '.modal.show',          // Bootstrap
    '.modal[style*="display: block"]',
    '[data-modal][aria-hidden="false"]',
    '.MuiDialog-root',       // Material UI
    '.ant-modal-root',       // Ant Design
    '.ui-dialog',            // jQuery UI (used by AEM Forms guide popup panels)
    '[class*="modal"][class*="open"]',
    '[class*="modal"][class*="visible"]',
    '[class*="dialog"][class*="open"]',
  ];
  for (const sel of classPatterns) {
    try {
      const el = document.querySelector(sel);
      if (el && isElementVisible(el)) return el;
    } catch { /* invalid selector */ }
  }

  return null;
}

/**
 * Attempt to dismiss any open dialog/modal by:
 *  1. Pressing Escape (works for most ARIA-compliant dialogs)
 *  2. Clicking an explicit close button inside the dialog
 * Returns true if a dialog was found and dismissed.
 */
async function dismissOpenDialog() {
  const dialog = getOpenDialog();
  if (!dialog) return false;

  console.log("[autotest][replay] Open dialog detected — attempting to dismiss:", dialog.tagName, dialog.className.slice(0, 60));

  // Try close/cancel button inside the dialog first (more reliable than Escape)
  const closeSelectors = [
    '[aria-label*="close" i]',
    '[aria-label*="dismiss" i]',
    '[aria-label*="cancel" i]',
    'button[class*="close" i]',
    'button[class*="dismiss" i]',
    '.modal-close',
    '.dialog-close',
  ];
  for (const sel of closeSelectors) {
    try {
      const btn = dialog.querySelector(sel);
      if (btn && isElementVisible(btn)) {
        console.log("[autotest][replay] Clicking dialog close button:", sel);
        btn.click();
        await new Promise(r => setTimeout(r, 400));
        return true;
      }
    } catch { /* ignore */ }
  }

  // Fallback: send Escape key to the document
  const escDown = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true });
  const escUp   = new KeyboardEvent('keyup',   { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true });
  document.dispatchEvent(escDown);
  document.dispatchEvent(escUp);
  // Also dispatch on the dialog itself (some implementations listen there)
  dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));

  await new Promise(r => setTimeout(r, 400));
  return true;
}

// AEM Forms' typeahead widget (guideDropDownList) hides the real <select>
// (display:none) and shows a plain text <input> next to it — typing into
// that input triggers a live search-as-you-type API call, and clicking a
// resulting option sets the hidden select's value. Setting the whole value
// in one shot (our normal fast path) never triggers that search at all, so
// the option list never renders and a later click step meant to select from
// it can't find anything. Detect this pattern by looking for a hidden
// <select> among nearby ancestors.
function isTypeaheadInput(el) {
  if (!el || el.tagName?.toLowerCase() !== 'input') return false;
  // jQuery UI autocomplete (and similar widgets) mark the input itself with
  // a class like "ui-autocomplete-input" — no hidden <select> involved at
  // all, so the AEM-style check below never catches it. Check this directly
  // first since it's the cheapest, most reliable signal for that pattern.
  if (/autocomplete|typeahead/i.test(el.className || '')) return true;
  let node = el.parentElement;
  for (let i = 0; i < 3 && node; i++, node = node.parentElement) {
    const hiddenSelect = node.querySelector?.('select');
    if (hiddenSelect && !isElementVisible(hiddenSelect)) return true;
  }
  return false;
}

// Types text one character at a time via execCommand('insertText'), firing a
// real InputEvent per character — required for typeahead widgets that ignore
// a bulk value assignment and only react to character-level input to
// trigger their live search.
async function typeCharByChar(el, text) {
  el.focus();
  if (el.value) {
    el.setSelectionRange?.(0, el.value.length);
    document.execCommand('selectAll', false);
    document.execCommand('delete', false);
  }
  for (const char of String(text ?? "")) {
    document.execCommand('insertText', false, char);
    await new Promise((r) => setTimeout(r, 40));
  }
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

async function performStep(step) {
  const type = step?.type;
  console.log("[autotest][replay] performStep", { type, selectorType: step?.selector?.primary?.type || null });
  if (type === "navigation") {
    return { ok: false, error: "Navigation is handled by background.", code: "NAV_IN_BG" };
  }

  clearDebugBuffer();

  let selector = step?.selector;
  if (typeof selector === "string") {
    selector = { primary: { type: "css", value: selector }, fallbacks: [] };
  }

  // URL assertion does not require element resolution.
  if (type === "assert_url_contains") {
    const expected = String(step?.value ?? "");
    if (!expected) {
      return {
        ok: false,
        error: "URL assertion requires a non-empty expected value.",
        code: "ASSERT_INVALID",
        debug: consumeDebugBuffer()
      };
    }
    const url = window.location.href;
    if (!url.includes(expected)) {
      return {
        ok: false,
        error: `URL assertion failed: expected URL to contain "${expected}", got "${url}".`,
        code: "ASSERT_URL_CONTAINS",
        debug: consumeDebugBuffer()
      };
    }
    return { ok: true, debug: consumeDebugBuffer() };
  }

  // Gate every step (not just navigation) on the form being genuinely idle —
  // no pending mutations, no in-flight requests, no visible loader — before
  // we touch it. This catches both the previous step kicking off an async
  // validation call, and a delayed fetch (e.g. a prefill lookup) that starts
  // a moment after the page first looked quiet.
  const pageIdle = await waitForPageIdle();
  if (!pageIdle.ok) {
    if (pageIdle.code === "LOADER_STILL_VISIBLE") {
      // A loading indicator (e.g. a popup that never finished loading) was
      // still visible after the full 10-minute wait — proceeding anyway
      // would mean interacting with a page we know isn't ready, so fail the
      // step outright. In non-soft mode this aborts the whole replay rather
      // than silently producing wrong/missed field values.
      console.error("[autotest][replay] Loading indicator never cleared, aborting step:", pageIdle.error);
      return {
        ok: false,
        error: pageIdle.error,
        code: "LOADING_INDICATOR_TIMEOUT",
        debug: consumeDebugBuffer()
      };
    }
    // DOM/network settle timeout stays best-effort: some pages legitimately
    // never go fully quiet (analytics beacons, countdown timers), so wait up
    // to the timeout and proceed anyway rather than aborting the whole replay.
    console.warn("[autotest][replay] Page never fully settled before step, continuing:", pageIdle.error);
  }

  // ============================================================================
  // NLP ELEMENT FINDING
  // If step has nlDescription but no resolved selector, try AI-powered finding
  // ============================================================================
  let el, used, selectorAttempts, elVisible;
  
  // Standard selector-based element finding with multi-hop refinement
  // Try findElementWithRefinement which includes backend refinement loop
  // Custom timeout from step.meta.timeout overrides default
  {
    const result = await findElementWithRefinement(step, selector, 3, step?.meta?.timeout);
    el = result.el;
    used = result.used;
    selectorAttempts = result.selectorAttempts;
    elVisible = result.visible;
  }

  // ── Dialog-blocking guard ────────────────────────────────────────────────
  // If a modal/dialog is open and the target element is NOT inside it,
  // dismiss the dialog first so background elements become interactable.
  if (el) {
    const openDialog = getOpenDialog();
    if (openDialog && !openDialog.contains(el)) {
      console.log("[autotest][replay] Target element is behind an open dialog — dismissing dialog first");
      await dismissOpenDialog();
      // Re-wait for DOM to settle after the dialog closes
      await waitForDOMStable({ stableMs: 300, timeoutMs: 3000 });
      // Re-find the element now that the dialog is gone
      const reResult = await findElementWithRefinement(step, selector, 2, step?.meta?.timeout);
      if (reResult.el) { el = reResult.el; used = reResult.used; elVisible = reResult.visible; }
    }
  } else {
    // Element not found — check if a dialog is covering the page and retry after dismissing
    const openDialog = getOpenDialog();
    if (openDialog) {
      console.log("[autotest][replay] Element not found and a dialog is open — dismissing dialog and retrying");
      await dismissOpenDialog();
      await waitForDOMStable({ stableMs: 300, timeoutMs: 3000 });
      const reResult = await findElementWithRefinement(step, selector, 2, step?.meta?.timeout);
      if (reResult.el) { el = reResult.el; used = reResult.used; elVisible = reResult.visible; }
    }
  }
  // ── End dialog-blocking guard ─────────────────────────────────────────────

  if (!el) {
    console.warn("[autotest][replay] element not found", { type });
    const selectorText =
      selector?.primary?.type === "text"
        ? selector.primary.value
        : selector?.fallbacks?.find((f) => f.type === "text")?.value || "";
    const selectorName =
      selector?.primary?.value ||
      selector?.fallbacks?.[0]?.value ||
      "";
    // Non-blocking selector healing; suggestions are sent to background.
    scheduleHealing(step, selector);
    return {
      ok: false,
      error: "Target element not found using selector fallbacks.",
      code: "ELEMENT_NOT_FOUND",
      debug: {
        ...consumeDebugBuffer(),
        selectorAttempts,
        notFoundTarget: {
          name: selectorName,
          text: selectorText,
          selectorType: selector?.primary?.type || null
        }
      }
    };
  }


  if (type === "assert_exists") {
    return {
      ok: true,
      meta: { usedSelector: used },
      debug: { ...consumeDebugBuffer(), selectorAttempts }
    };
  }

  if (type === "assert_text_equals" || type === "assert_text_contains") {
    const expected = String(step?.value ?? "");
    if (!expected) {
      return { ok: false, error: "Text assertion requires a non-empty expected value.", code: "ASSERT_INVALID" };
    }
    const actual = getElementText(el);

    if (type === "assert_text_equals") {
      if (actual !== expected) {
        // Case-insensitive fallback: CSS text-transform can change visible case.
        // If only case differs, pass with a warning instead of failing.
        if (actual.toLowerCase() === expected.toLowerCase()) {
          console.warn(`[autotest][assert] Case mismatch (CSS text-transform?): expected "${expected}", got "${actual}" — passing.`);
          return {
            ok: true,
            warning: `Case mismatch (CSS text-transform?): expected "${expected}", got "${actual}".`,
            meta: { usedSelector: used },
            debug: { ...consumeDebugBuffer(), selectorAttempts }
          };
        }
        return {
          ok: false,
          error: `Text assertion failed: expected "${expected}", got "${actual}".`,
          code: "ASSERT_TEXT_EQUALS",
          debug: consumeDebugBuffer()
        };
      }
    }
    if (type === "assert_text_contains") {
      if (!actual.includes(expected)) {
        // Case-insensitive fallback
        if (actual.toLowerCase().includes(expected.toLowerCase())) {
          console.warn(`[autotest][assert] Case mismatch (CSS text-transform?): "${actual}" contains "${expected}" case-insensitively — passing.`);
          return {
            ok: true,
            warning: `Case mismatch: text contains "${expected}" case-insensitively.`,
            meta: { usedSelector: used },
            debug: { ...consumeDebugBuffer(), selectorAttempts }
          };
        }
        return {
          ok: false,
          error: `Text assertion failed: expected text to contain "${expected}", got "${actual}".`,
          code: "ASSERT_TEXT_CONTAINS",
          debug: consumeDebugBuffer()
        };
      }
    }
    return {
      ok: true,
      meta: { usedSelector: used },
      debug: { ...consumeDebugBuffer(), selectorAttempts }
    };
  }

  if (type === "assert_attr_equals") {
    const attrName = String(step?.meta?.attr || "").trim();
    const expected = String(step?.value ?? "");
    if (!attrName) {
      return { ok: false, error: "Attribute assertion requires meta.attr.", code: "ASSERT_INVALID" };
    }
    const actual = String(el.getAttribute(attrName) ?? "");
    if (actual !== expected) {
      return {
        ok: false,
        error: `Attribute assertion failed: expected ${attrName}="${expected}", got "${actual}".`,
        code: "ASSERT_ATTR_EQUALS",
        debug: consumeDebugBuffer()
      };
    }
    return {
      ok: true,
      meta: { usedSelector: used },
      debug: { ...consumeDebugBuffer(), selectorAttempts }
    };
  }

  // ── New assertion types (Playwright parity) ──────────────────

  if (type === "assert_visible") {
    const isVis = el && el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
    if (!isVis) {
      return { ok: false, error: "Element is not visible.", code: "ASSERT_VISIBLE", debug: consumeDebugBuffer() };
    }
    return { ok: true, meta: { usedSelector: used }, debug: { ...consumeDebugBuffer(), selectorAttempts } };
  }

  if (type === "assert_hidden") {
    const isVis = el && el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
    if (isVis) {
      return { ok: false, error: "Element is visible but expected hidden.", code: "ASSERT_HIDDEN", debug: consumeDebugBuffer() };
    }
    return { ok: true, meta: { usedSelector: used }, debug: { ...consumeDebugBuffer(), selectorAttempts } };
  }

  if (type === "assert_checked") {
    const checked = el.checked === true || el.getAttribute('aria-checked') === 'true';
    if (!checked) {
      return { ok: false, error: "Element is not checked.", code: "ASSERT_CHECKED", debug: consumeDebugBuffer() };
    }
    return { ok: true, meta: { usedSelector: used }, debug: { ...consumeDebugBuffer(), selectorAttempts } };
  }

  if (type === "assert_disabled") {
    const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
    if (!disabled) {
      return { ok: false, error: "Element is not disabled.", code: "ASSERT_DISABLED", debug: consumeDebugBuffer() };
    }
    return { ok: true, meta: { usedSelector: used }, debug: { ...consumeDebugBuffer(), selectorAttempts } };
  }

  if (type === "assert_enabled") {
    const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
    if (disabled) {
      return { ok: false, error: "Element is disabled but expected enabled.", code: "ASSERT_ENABLED", debug: consumeDebugBuffer() };
    }
    return { ok: true, meta: { usedSelector: used }, debug: { ...consumeDebugBuffer(), selectorAttempts } };
  }

  if (type === "assert_has_class") {
    const expected = String(step?.value ?? "").trim();
    if (!expected) {
      return { ok: false, error: "Class assertion requires a non-empty class name.", code: "ASSERT_INVALID" };
    }
    if (!el.classList.contains(expected)) {
      return { ok: false, error: `Element does not have class "${expected}". Classes: "${el.className}".`, code: "ASSERT_HAS_CLASS", debug: consumeDebugBuffer() };
    }
    return { ok: true, meta: { usedSelector: used }, debug: { ...consumeDebugBuffer(), selectorAttempts } };
  }

  if (type === "assert_has_value") {
    const expected = String(step?.value ?? "");
    const actual = String(el.value ?? "");
    if (actual !== expected) {
      return { ok: false, error: `Value assertion failed: expected "${expected}", got "${actual}".`, code: "ASSERT_HAS_VALUE", debug: consumeDebugBuffer() };
    }
    return { ok: true, meta: { usedSelector: used }, debug: { ...consumeDebugBuffer(), selectorAttempts } };
  }

  if (type === "assert_has_title") {
    const expected = String(step?.value ?? "");
    if (!expected) {
      return { ok: false, error: "Title assertion requires a non-empty expected value.", code: "ASSERT_INVALID" };
    }
    const actual = document.title;
    if (!actual.includes(expected)) {
      if (actual.toLowerCase().includes(expected.toLowerCase())) {
        return { ok: true, warning: `Title case mismatch: "${actual}" contains "${expected}" case-insensitively.`, meta: { usedSelector: used }, debug: { ...consumeDebugBuffer(), selectorAttempts } };
      }
      return { ok: false, error: `Title assertion failed: expected title to contain "${expected}", got "${actual}".`, code: "ASSERT_HAS_TITLE", debug: consumeDebugBuffer() };
    }
    return { ok: true, meta: { usedSelector: used }, debug: { ...consumeDebugBuffer(), selectorAttempts } };
  }

  if (type === "assert_count") {
    const expected = parseInt(step?.value, 10);
    if (isNaN(expected)) {
      return { ok: false, error: "Count assertion requires a numeric value.", code: "ASSERT_INVALID" };
    }
    const selectorValue = step?.selector?.primary?.value;
    if (!selectorValue) {
      return { ok: false, error: "Count assertion requires a CSS selector.", code: "ASSERT_INVALID" };
    }
    const actual = document.querySelectorAll(selectorValue).length;
    if (actual !== expected) {
      return { ok: false, error: `Count assertion failed: expected ${expected} elements, found ${actual}.`, code: "ASSERT_COUNT", debug: consumeDebugBuffer() };
    }
    return { ok: true, meta: { usedSelector: used, count: actual }, debug: { ...consumeDebugBuffer(), selectorAttempts } };
  }

  if (type === "assert_editable") {
    const editable = !el.disabled && !el.readOnly;
    if (!editable) {
      return { ok: false, error: "Element is not editable (disabled or readOnly).", code: "ASSERT_EDITABLE", debug: consumeDebugBuffer() };
    }
    return { ok: true, meta: { usedSelector: used }, debug: { ...consumeDebugBuffer(), selectorAttempts } };
  }

  if (type === "assert_no_console_errors") {
    // Check console errors captured during replay for this page
    const errors = window.__autotestConsoleErrors || [];
    if (errors.length > 0) {
      return { ok: false, error: `Found ${errors.length} console error(s): ${errors.slice(0, 3).join('; ')}`, code: "ASSERT_CONSOLE_ERRORS", debug: consumeDebugBuffer() };
    }
    return { ok: true, meta: { usedSelector: used }, debug: { ...consumeDebugBuffer(), selectorAttempts } };
  }

  if (type === "assert_screenshot") {
    // Delegate to background service worker for screenshot comparison
    try {
      const result = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: "compare_screenshot",
          recordingId: step?.meta?.recordingId || step?.recordingId,
          stepIndex: step?.meta?.stepIndex ?? step?.idx,
          threshold: step?.meta?.threshold || 5
        }, resolve);
      });
      if (result?.ok) {
        return { ok: true, meta: { usedSelector: used, isBaseline: result.isBaseline, diffPercent: result.diffPercent }, debug: consumeDebugBuffer() };
      }
      return { ok: false, error: result?.error || "Screenshot comparison failed.", code: "VISUAL_REGRESSION", debug: consumeDebugBuffer() };
    } catch (err) {
      return { ok: false, error: err?.message || "Screenshot comparison error.", code: "VISUAL_REGRESSION", debug: consumeDebugBuffer() };
    }
  }

  if (type === "click") {
    
    let clickTarget = el;
    const tagLower = el.tagName?.toLowerCase();
    const inputType = el.getAttribute?.('type')?.toLowerCase();
    const role = el.getAttribute?.('role')?.toLowerCase();
    const isNativeCheckRadio = tagLower === 'input' && (inputType === 'radio' || inputType === 'checkbox');
    const isCustomCheckRadio = role === 'radio' || role === 'checkbox' || role === 'switch';
    
    console.log("[autotest][replay] Click target analysis:", {
      tag: tagLower, inputType, role, visible: elVisible,
      isNativeCheckRadio, isCustomCheckRadio
    });

    // ---- Resolve the best clickable element ----
    
    // 1) Hidden native <input type="radio/checkbox"> — click its <label> or
    //    sibling span[role="checkbox/radio"] instead
    if (isNativeCheckRadio && !elVisible) {
      // First try: sibling span/div with role="checkbox" or role="radio"
      const siblingToggle = el.parentElement?.querySelector('[role="checkbox"], [role="radio"], [role="switch"]');
      if (siblingToggle && isElementVisible(siblingToggle)) {
        console.log("[autotest][replay] Hidden checkbox/radio — clicking sibling role toggle:", siblingToggle.tagName);
        clickTarget = siblingToggle;
      } else {
        // Second try: associated <label>
        const labelEl = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
        if (labelEl && isElementVisible(labelEl)) {
          console.log("[autotest][replay] Hidden radio/checkbox — clicking associated label");
          clickTarget = labelEl;
        } else {
          const parentLabel = el.closest('label');
          if (parentLabel && isElementVisible(parentLabel)) {
            console.log("[autotest][replay] Hidden radio/checkbox — clicking parent label");
            clickTarget = parentLabel;
          }
        }
      }
    }
    
    // 2) Custom role="radio/checkbox/switch" — if not visible, walk up
    if (isCustomCheckRadio && !elVisible) {
      let parent = el.parentElement;
      while (parent && parent !== document.body) {
        if (isElementVisible(parent)) {
          clickTarget = parent;
          console.log("[autotest][replay] Custom toggle — clicking visible ancestor:", parent.tagName);
          break;
        }
        parent = parent.parentElement;
      }
    }
    
    // 3) If the resolved element is an SVG/path inside a custom toggle, walk up
    const svgLike = new Set(['svg','path','circle','rect','line','polyline','polygon','g','use']);
    if (svgLike.has(tagLower)) {
      let ancestor = el.parentElement;
      let depth = 0;
      while (ancestor && ancestor !== document.body && depth < 6) {
        const aRole = ancestor.getAttribute?.('role')?.toLowerCase();
        if (aRole === 'checkbox' || aRole === 'radio' || aRole === 'switch' || aRole === 'button') {
          clickTarget = ancestor;
          console.log("[autotest][replay] SVG inside role=" + aRole + " — clicking ancestor");
          break;
        }
        if (ancestor.tagName?.toLowerCase() === 'button' || ancestor.tagName?.toLowerCase() === 'a') {
          clickTarget = ancestor;
          break;
        }
        ancestor = ancestor.parentElement;
        depth++;
      }
    }
    
    // ---- Scroll into view ----
    try {
      clickTarget.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
      await new Promise(resolve => setTimeout(resolve, 50));
    } catch (e) {
      // Ignore scroll errors
    }
    
    // ---- Snapshot "before" state for verification ----
    let hiddenInput = null;
    let checkedBefore = null;
    let ariaCheckedBefore = null;
    
    // For custom checkboxes, find the associated hidden native input
    const clickRole = clickTarget.getAttribute?.('role')?.toLowerCase();
    if (clickRole === 'checkbox' || clickRole === 'radio' || clickRole === 'switch') {
      ariaCheckedBefore = clickTarget.getAttribute('aria-checked');
      // Look for hidden <input type="checkbox/radio"> as sibling or within parent
      hiddenInput = clickTarget.parentElement?.querySelector('input[type="checkbox"], input[type="radio"]');
      if (!hiddenInput) {
        // Also check grandparent (common pattern: div > div > input + span)
        hiddenInput = clickTarget.parentElement?.parentElement?.querySelector('input[type="checkbox"], input[type="radio"]');
      }
      if (hiddenInput) {
        checkedBefore = hiddenInput.checked;
        console.log("[autotest][replay] Found associated hidden input:", hiddenInput.id || hiddenInput.name, "checked:", checkedBefore);
      }
    }
    
    if (isNativeCheckRadio) {
      checkedBefore = el.checked;
    }
    
    // ---- Dispatch a full realistic click event sequence ----
    // For non-checkbox/radio: dispatchRealClick uses el.click() exclusively
    // (produces isTrusted:true, so React handles it correctly and can call
    // e.preventDefault() to stop form submission / navigation).
    // For native checkbox/radio: uses synthetic MouseEvent (toggles .checked).
    const clickTargetIsNativeCheck = clickTarget.tagName?.toLowerCase() === 'input' &&
      (clickTarget.getAttribute('type')?.toLowerCase() === 'radio' || clickTarget.getAttribute('type')?.toLowerCase() === 'checkbox');
    
    // Snapshot URL to detect if the click triggered a full navigation
    const urlBefore = window.location.href;
    
    dispatchRealClick(clickTarget, { nativeCheckRadio: clickTargetIsNativeCheck });
    
    // ---- React fallback: if el.click() didn't trigger the React handler ----
    // This can happen when the event listener is on a parent React root or
    // when the element is deeply nested. Directly invoke React's onClick prop.
    if (!clickTargetIsNativeCheck && !isCustomCheckRadio) {
      await new Promise(resolve => setTimeout(resolve, 60));
      
      // Check if the page is about to reload (URL unchanged = SPA should have
      // handled it; if DOM hasn't changed, React handler likely didn't fire)
      const urlAfter = window.location.href;
      if (urlAfter === urlBefore) {
        // Try direct React fiber invocation as a second attempt
        const reactHandled = tryReactOnClick(clickTarget);
        if (!reactHandled) {
          // Walk up to find a React handler on an ancestor (e.g. wrapper div)
          let ancestor = clickTarget.parentElement;
          for (let d = 0; d < 5 && ancestor && ancestor !== document.body; d++) {
            if (tryReactOnClick(ancestor)) {
              console.log("[autotest][replay] Found React handler on ancestor level", d + 1);
              break;
            }
            ancestor = ancestor.parentElement;
          }
        }
        
        // Final fallback: keyboard Enter (many buttons respond to Enter)
        try {
          clickTarget.focus();
          clickTarget.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13,
            bubbles: true, cancelable: true
          }));
          clickTarget.dispatchEvent(new KeyboardEvent('keypress', {
            key: 'Enter', code: 'Enter', keyCode: 13,
            bubbles: true, cancelable: true
          }));
          clickTarget.dispatchEvent(new KeyboardEvent('keyup', {
            key: 'Enter', code: 'Enter', keyCode: 13,
            bubbles: true, cancelable: true
          }));
        } catch (e) { /* keyboard dispatch error */ }
      }
    }
    
    // ---- Verify state change ----
    await new Promise(resolve => setTimeout(resolve, 80));
    
    // A) Native radio/checkbox: verify .checked toggled
    if (isNativeCheckRadio) {
      if (inputType === 'radio' && !el.checked) {
        console.log("[autotest][replay] Radio not checked after click, forcing via native setter");
        const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked');
        if (desc?.set) desc.set.call(el, true);
        else el.checked = true;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
      if (inputType === 'checkbox' && el.checked === checkedBefore) {
        console.log("[autotest][replay] Checkbox did not toggle after click, forcing toggle");
        const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked');
        if (desc?.set) desc.set.call(el, !checkedBefore);
        else el.checked = !checkedBefore;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
    }
    
    // B) Custom role="checkbox/radio/switch": verify aria-checked or hidden input toggled
    if (clickRole === 'checkbox' || clickRole === 'radio' || clickRole === 'switch') {
      const ariaCheckedAfter = clickTarget.getAttribute('aria-checked');
      const inputToggled = hiddenInput && hiddenInput.checked !== checkedBefore;
      const ariaToggled = ariaCheckedAfter !== ariaCheckedBefore;
      
      console.log("[autotest][replay] Custom toggle verification:", {
        ariaCheckedBefore, ariaCheckedAfter, ariaToggled,
        checkedBefore, checkedAfter: hiddenInput?.checked, inputToggled
      });
      
      if (!ariaToggled && !inputToggled) {
        console.log("[autotest][replay] Custom toggle did not change — forcing hidden input");
        
        // Strategy 1: Try clicking the hidden input directly
        if (hiddenInput) {
          const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked');
          const newVal = checkedBefore === false || checkedBefore === null ? true : !checkedBefore;
          if (desc?.set) desc.set.call(hiddenInput, newVal);
          else hiddenInput.checked = newVal;
          hiddenInput.dispatchEvent(new Event('input', { bubbles: true }));
          hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
          hiddenInput.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          
          console.log("[autotest][replay] Forced hidden input checked =", hiddenInput.checked);
        }
        
        // Strategy 2: Also flip aria-checked on the visible element
        if (ariaCheckedBefore === 'false') {
          clickTarget.setAttribute('aria-checked', 'true');
        } else if (ariaCheckedBefore === 'true') {
          clickTarget.setAttribute('aria-checked', 'false');
        }
        
        // Strategy 3: Try dispatching keyboard Space (many toggle implementations
        // listen for Space/Enter on the role="checkbox" element)
        try {
          clickTarget.focus();
          clickTarget.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', keyCode: 32, bubbles: true }));
          clickTarget.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', keyCode: 32, bubbles: true }));
          clickTarget.dispatchEvent(new KeyboardEvent('keypress', { key: ' ', code: 'Space', keyCode: 32, bubbles: true }));
        } catch (e) { /* keyboard dispatch not supported */ }
      }
    }
    
    // No post-action wait here — the next step's own pre-step gate in
    // performStep() already waits for the page to settle before it acts, so
    // waiting again here would just pay the same quiet-period cost twice.
    return {
      ok: true,
      meta: { usedSelector: used },
      debug: { ...consumeDebugBuffer(), selectorAttempts }
    };
  }

  if (type === "input" || type === "change") {
    // ── Radio / Checkbox: treat as click instead of text input ──
    // Old recordings may have captured radio/checkbox interactions as "input".
    // Setting el.value on a radio does nothing; we need to click / check it.
    const tagLower = el.tagName?.toLowerCase();
    const inpType  = el.getAttribute?.('type')?.toLowerCase();
    const isCheckRadio = tagLower === 'input' && (inpType === 'radio' || inpType === 'checkbox');
    
    if (isCheckRadio) {
      console.log("[autotest][replay] Radio/checkbox detected in input step — routing to click logic", {
        tag: tagLower, type: inpType, value: step?.value
      });
      
      // If there are multiple radios with the same name, try to find the one
      // whose value attribute matches step.value
      if (inpType === 'radio' && step?.value) {
        const radioName = el.getAttribute('name');
        if (radioName) {
          const matchByValue = document.querySelector(
            `input[type="radio"][name="${CSS.escape(radioName)}"][value="${CSS.escape(step.value)}"]`
          );
          if (matchByValue && matchByValue !== el) {
            console.log("[autotest][replay] Found radio with matching value, switching target");
            el = matchByValue;
          }
        }
      }
      
      // Resolve click target (hidden inputs → visible toggle or label)
      let clickTarget = el;
      const elVis = isElementVisible(el);
      const checkedBefore = el.checked;
      
      if (!elVis) {
        // First try: sibling span/div with role="checkbox/radio"
        const siblingToggle = el.parentElement?.querySelector('[role="checkbox"], [role="radio"], [role="switch"]');
        if (siblingToggle && isElementVisible(siblingToggle)) {
          console.log("[autotest][replay] Hidden input — clicking sibling role toggle:", siblingToggle.getAttribute('role'));
          clickTarget = siblingToggle;
        } else {
          const labelEl = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
          if (labelEl && isElementVisible(labelEl)) {
            clickTarget = labelEl;
          } else {
            const parentLabel = el.closest('label');
            if (parentLabel && isElementVisible(parentLabel)) {
              clickTarget = parentLabel;
            }
          }
        }
      }
      
      try {
        clickTarget.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
        await new Promise(resolve => setTimeout(resolve, 50));
      } catch (e) { /* ignore */ }
      
      const ctIsNative = clickTarget.tagName?.toLowerCase() === 'input' &&
        (clickTarget.getAttribute('type')?.toLowerCase() === 'radio' || clickTarget.getAttribute('type')?.toLowerCase() === 'checkbox');
      dispatchRealClick(clickTarget, { nativeCheckRadio: ctIsNative });
      
      // Verify + force (using native setter to bypass React controlled components)
      await new Promise(resolve => setTimeout(resolve, 80));
      
      if (inpType === 'radio' && !el.checked) {
        console.log("[autotest][replay] Radio not checked after click, forcing via native setter");
        const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked');
        if (desc?.set) desc.set.call(el, true);
        else el.checked = true;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
      
      if (inpType === 'checkbox' && el.checked === checkedBefore) {
        console.log("[autotest][replay] Checkbox did not toggle, forcing via native setter");
        const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked');
        if (desc?.set) desc.set.call(el, !checkedBefore);
        else el.checked = !checkedBefore;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
      
      // No post-action wait — the next step's pre-step gate covers this.
      return {
        ok: true,
        meta: { usedSelector: used },
        debug: { ...consumeDebugBuffer(), selectorAttempts }
      };
    }
    
    // ── Custom role="radio/checkbox/switch": treat as click ──
    const elRole = el.getAttribute?.('role')?.toLowerCase();
    if (elRole === 'radio' || elRole === 'checkbox' || elRole === 'switch') {
      console.log("[autotest][replay] Custom toggle element (role=" + elRole + ") in input step — clicking");
      let clickTarget = el;
      if (!isElementVisible(el)) {
        let parent = el.parentElement;
        while (parent && parent !== document.body) {
          if (isElementVisible(parent)) { clickTarget = parent; break; }
          parent = parent.parentElement;
        }
      }
      
      const ariaCheckedBefore = clickTarget.getAttribute('aria-checked');
      const hiddenInput = clickTarget.parentElement?.querySelector('input[type="checkbox"], input[type="radio"]')
                       || clickTarget.parentElement?.parentElement?.querySelector('input[type="checkbox"], input[type="radio"]');
      const checkedBefore = hiddenInput?.checked;
      
      try {
        clickTarget.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
        await new Promise(resolve => setTimeout(resolve, 50));
      } catch (e) { /* ignore */ }
      
      dispatchRealClick(clickTarget);
      await new Promise(resolve => setTimeout(resolve, 80));
      
      // Verify toggle happened
      const ariaCheckedAfter = clickTarget.getAttribute('aria-checked');
      const inputToggled = hiddenInput && hiddenInput.checked !== checkedBefore;
      if (ariaCheckedAfter === ariaCheckedBefore && !inputToggled) {
        console.log("[autotest][replay] Custom toggle in input step did not change — forcing");
        if (hiddenInput) {
          const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked');
          const newVal = !checkedBefore;
          if (desc?.set) desc.set.call(hiddenInput, newVal);
          else hiddenInput.checked = newVal;
          hiddenInput.dispatchEvent(new Event('input', { bubbles: true }));
          hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
          hiddenInput.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
        if (ariaCheckedBefore === 'false') clickTarget.setAttribute('aria-checked', 'true');
        else if (ariaCheckedBefore === 'true') clickTarget.setAttribute('aria-checked', 'false');
        // Try keyboard space
        try {
          clickTarget.focus();
          clickTarget.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', keyCode: 32, bubbles: true }));
          clickTarget.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', keyCode: 32, bubbles: true }));
        } catch (e) { /* ignore */ }
      }
      
      // No post-action wait — the next step's pre-step gate covers this.
      return {
        ok: true,
        meta: { usedSelector: used },
        debug: { ...consumeDebugBuffer(), selectorAttempts }
      };
    }
    
    // ── Select dropdown: use selectedIndex / value matching ──
    if (tagLower === 'select') {
      console.log("[autotest][replay] Select element detected, setting value:", step?.value);
      el.focus();
      el.value = step?.value ?? "";
      // If value didn't stick (option not found by value), try matching by text
      if (el.value !== step?.value) {
        const opts = Array.from(el.options || []);
        const match = opts.find(o => o.text === step?.value || o.textContent?.trim() === step?.value);
        if (match) {
          el.value = match.value;
          console.log("[autotest][replay] Matched select option by text:", match.value);
        }
      }
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      // No post-action wait — the next step's pre-step gate covers this.
      return {
        ok: true,
        meta: { usedSelector: used },
        debug: { ...consumeDebugBuffer(), selectorAttempts }
      };
    }
    
    // ── Standard text input / textarea ──
    if (!("value" in el)) {
      console.warn("[autotest][replay] input failed: element has no value property", {
        tag: tagLower,
        role: el?.getAttribute?.("role") || null
      });
      return {
        ok: false,
        error: "Target element does not accept input.",
        code: "NOT_INPUT",
        debug: consumeDebugBuffer()
      };
    }
    
    // Try to make the element interactable if it's hidden
    if (!elVisible) {
      try {
        el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
      } catch (e) {
        // Ignore scroll errors
      }
    }
    
    // Focus and clear existing value with realistic events
    el.focus();

    const targetValue = step?.value ?? "";

    // Typeahead widgets need character-level typing to trigger their own
    // live search — a one-shot value assignment never fires it, so the
    // option list a later click step depends on would never render.
    if (isTypeaheadInput(el)) {
      console.log("[autotest][replay] Typeahead input detected — typing char-by-char:", targetValue);
      await typeCharByChar(el, targetValue);
      const postIdle = await waitForPageIdle();
      if (!postIdle.ok) {
        console.warn("[autotest][replay] Page still settling after typeahead typing, continuing:", postIdle.error);
      }
      return {
        ok: true,
        meta: { usedSelector: used },
        debug: { ...consumeDebugBuffer(), selectorAttempts }
      };
    }

    const elDesc = describeElementForLog(el);

    // Use native input setter to bypass React's synthetic event system
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set || Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set;

    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, targetValue);
    } else {
      el.value = targetValue;
    }

    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new FocusEvent("blur", { bubbles: true }));

    if (el.value !== targetValue) {
      console.warn(`[autotest][replay] Value mismatch immediately after dispatch — expected "${targetValue}", got "${el.value}" on`, elDesc);
    }

    // Fire-and-forget delayed re-check: some frameworks (React controlled
    // inputs, AEM guide field validation) reset the value a tick or more
    // after blur — e.g. an onBlur validator that rejects the value and
    // clears it, or a duplicate/stale element getting the value while a
    // different visible element is what's actually on screen. Only logs if
    // something actually went wrong — doesn't block the step's return.
    const capturedEl = el;
    setTimeout(() => {
      const laterValue = capturedEl.value;
      if (laterValue !== targetValue) {
        console.warn(
          `[autotest][replay] Value changed after step — 300ms later, expected "${targetValue}", found "${laterValue}" (element still in DOM: ${document.contains(capturedEl)}) on`,
          elDesc
        );
      }
    }, 300);

    // No post-action wait — the next step's pre-step gate covers this
    // (typing/blurring a field commonly triggers a debounced validation call,
    // e.g. OTP/PAN/pincode lookups, same as a click can).

    return {
      ok: true,
      meta: { usedSelector: used },
      debug: { ...consumeDebugBuffer(), selectorAttempts }
    };
  }

  if (type === "submit") {
    const form = el.tagName?.toLowerCase() === "form" ? el : el.closest("form");
    if (!form) {
      return { ok: false, error: "No form found to submit.", code: "NO_FORM", debug: consumeDebugBuffer() };
    }
    if (form.requestSubmit) form.requestSubmit();
    else form.submit();
    
    // Wait for network to stabilize, but don't fail if it doesn't
    const postNet = await waitForNetworkIdle();
    if (!postNet.ok) {
      console.warn("[autotest][replay] Network still active after submit, continuing anyway");
    }
    
    return {
      ok: true,
      meta: { usedSelector: used },
      debug: { ...consumeDebugBuffer(), selectorAttempts }
    };
  }

  // Handle keypress/keyboard events (e.g., pressing Enter to submit search)
  if (type === "keypress" || type === "key") {
    const key = step?.meta?.key || step?.value || step?.key || 'Enter';
    const ctrlKey = step?.meta?.ctrlKey || false;
    const shiftKey = step?.meta?.shiftKey || false;
    const altKey = step?.meta?.altKey || false;
    const metaKey = step?.meta?.metaKey || false;
    console.log("[autotest][replay] Dispatching key event:", key, { ctrlKey, shiftKey, altKey, metaKey }, "on element:", el.tagName);
    
    // Focus the element first
    if (el.focus) el.focus();
    
    // Compute keyCode
    const KEY_CODES = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
    const keyCode = KEY_CODES[key] || key.charCodeAt(0);
    const code = step?.meta?.code || KEY_CODES[key] ? key : `Key${key.toUpperCase()}`;

    const keyEventInit = {
      key, code, keyCode, which: keyCode,
      ctrlKey, shiftKey, altKey, metaKey,
      bubbles: true, cancelable: true
    };
    
    el.dispatchEvent(new KeyboardEvent('keydown', keyEventInit));
    el.dispatchEvent(new KeyboardEvent('keypress', keyEventInit));
    el.dispatchEvent(new KeyboardEvent('keyup', keyEventInit));
    
    // For Enter key on form elements, also try to submit the form
    if (key === 'Enter' && !ctrlKey && !altKey && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
      const form = el.closest('form');
      if (form) {
        console.log("[autotest][replay] Submitting form after Enter key");
        await new Promise(resolve => setTimeout(resolve, 100));
        if (form.requestSubmit) {
          form.requestSubmit();
        } else {
          form.submit();
        }
      }
    }
    
    // For Ctrl+A, simulate select all
    if ((ctrlKey || metaKey) && key.toLowerCase() === 'a') {
      try { el.select?.(); } catch {}
    }
    
    const postNet = await waitForNetworkIdle();
    if (!postNet.ok) {
      console.warn("[autotest][replay] Network still active after keypress, continuing anyway");
    }
    
    return {
      ok: true,
      meta: { usedSelector: used, key, ctrlKey, shiftKey, altKey, metaKey },
      debug: { ...consumeDebugBuffer(), selectorAttempts }
    };
  }

  // ── File upload ──
  if (type === "upload") {
    console.log("[autotest][replay] File upload step — triggering file picker on element:", el.tagName);
    // In a Chrome extension, we can't set files programmatically due to security.
    // We trigger the click to open the native file dialog.
    try { el.click(); } catch {}
    // Give user time to pick a file
    await new Promise(resolve => setTimeout(resolve, 2000));
    return {
      ok: true,
      warning: "File upload: native file picker was triggered. File must be selected manually.",
      meta: { usedSelector: used, fileName: step?.meta?.fileName },
      debug: { ...consumeDebugBuffer(), selectorAttempts }
    };
  }

  // ── Drag and drop ──
  if (type === "drag_drop") {
    const targetSel = step?.meta?.targetSelector;
    if (!targetSel?.primary?.value) {
      return { ok: false, error: "Drag & drop requires a target selector.", code: "DRAG_INVALID" };
    }
    // Find the drop target
    let dropTarget = null;
    try {
      if (targetSel.primary.type === 'css') {
        dropTarget = document.querySelector(targetSel.primary.value);
      } else if (targetSel.primary.type === 'xpath') {
        dropTarget = document.evaluate(targetSel.primary.value, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      }
    } catch {}
    if (!dropTarget) {
      return { ok: false, error: "Drag & drop target element not found.", code: "DRAG_TARGET_NOT_FOUND", debug: consumeDebugBuffer() };
    }

    const srcRect = el.getBoundingClientRect();
    const dstRect = dropTarget.getBoundingClientRect();
    const srcX = srcRect.left + srcRect.width / 2;
    const srcY = srcRect.top + srcRect.height / 2;
    const dstX = dstRect.left + dstRect.width / 2;
    const dstY = dstRect.top + dstRect.height / 2;

    const dataTransfer = new DataTransfer();

    el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, clientX: srcX, clientY: srcY, dataTransfer }));
    await new Promise(r => setTimeout(r, 100));
    dropTarget.dispatchEvent(new DragEvent('dragenter', { bubbles: true, clientX: dstX, clientY: dstY, dataTransfer }));
    dropTarget.dispatchEvent(new DragEvent('dragover', { bubbles: true, clientX: dstX, clientY: dstY, dataTransfer }));
    await new Promise(r => setTimeout(r, 50));
    dropTarget.dispatchEvent(new DragEvent('drop', { bubbles: true, clientX: dstX, clientY: dstY, dataTransfer }));
    el.dispatchEvent(new DragEvent('dragend', { bubbles: true, clientX: dstX, clientY: dstY, dataTransfer }));

    return {
      ok: true,
      meta: { usedSelector: used },
      debug: { ...consumeDebugBuffer(), selectorAttempts }
    };
  }

  // ============================================================================
  // JOURNEY STEP TYPES
  // ============================================================================

  // Handle waitForNavigation step - waits for page to change
  if (type === "waitForNavigation") {
    console.log("[autotest][replay] waitForNavigation step - waiting for page navigation");
    const timeout = step.timeout || 30000;
    const startUrl = window.location.href;
    const startTime = Date.now();
    
    // Poll for URL change
    while (Date.now() - startTime < timeout) {
      await new Promise(resolve => setTimeout(resolve, 500));
      if (window.location.href !== startUrl) {
        console.log("[autotest][replay] ✓ Navigation detected:", window.location.href);
        // Wait for DOM to stabilize on new page
        await waitForDOMStable({ timeoutMs: 5000 });
        return {
          ok: true,
          meta: { fromUrl: startUrl, toUrl: window.location.href },
          debug: consumeDebugBuffer()
        };
      }
    }
    
    // Navigation didn't happen - might be expected if we're continuing on same page
    console.log("[autotest][replay] No navigation occurred within timeout, continuing");
    return {
      ok: true,
      meta: { noNavigation: true, url: startUrl },
      debug: consumeDebugBuffer()
    };
  }

  // Handle waitForElement step - waits for specific element to appear
  if (type === "waitForElement") {
    console.log("[autotest][replay] waitForElement step:", step.target?.descriptor);
    const timeout = step.timeout || 10000;
    const startTime = Date.now();
    
    // Try to find the element using NL description or selector
    const targetDesc = step.target?.descriptor || step.nlDescription || '';
    
    while (Date.now() - startTime < timeout) {
      // Try selector-based finding
      if (selector?.primary?.value) {
        try {
          const foundEl = document.querySelector(selector.primary.value);
          if (foundEl && isElementVisible(foundEl)) {
            console.log("[autotest][replay] ✓ Element found:", targetDesc);
            return {
              ok: true,
              meta: { found: true, descriptor: targetDesc },
              debug: consumeDebugBuffer()
            };
          }
        } catch (e) {
          // Invalid selector, try text matching
        }
      }
      
      // Try text matching (fuzzy — ignores dynamic content like prices)
      const targetStripped = stripDynamicContent(targetDesc);
      if (targetStripped && targetStripped.length >= 3) {
        const elements = document.querySelectorAll('button, a, label, [role], [aria-label], span, div, input, select, textarea');
        for (const elem of elements) {
          if (!isElementVisible(elem)) continue;
          const elemStripped = stripDynamicContent(elem.textContent || elem.ariaLabel || '');
          if (elemStripped && (elemStripped.includes(targetStripped) || targetStripped.includes(elemStripped))) {
            console.log("[autotest][replay] ✓ Element found by fuzzy text:", targetDesc);
            return {
              ok: true,
              meta: { found: true, descriptor: targetDesc, matchType: 'fuzzy_text' },
              debug: consumeDebugBuffer()
            };
          }
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    return {
      ok: false,
      error: `Element not found within timeout: ${targetDesc}`,
      code: "ELEMENT_TIMEOUT",
      debug: consumeDebugBuffer()
    };
  }

  // ── Explicit wait steps ──────────────────────────────────────

  if (type === "wait_delay") {
    const ms = parseInt(step?.value, 10) || 1000;
    console.log(`[autotest][replay] wait_delay: sleeping ${ms}ms`);
    await new Promise(resolve => setTimeout(resolve, ms));
    return { ok: true, meta: { waited: ms }, debug: consumeDebugBuffer() };
  }

  if (type === "wait_for_url") {
    const expected = String(step?.value ?? "");
    if (!expected) return { ok: false, error: "wait_for_url requires a value.", code: "WAIT_INVALID" };
    const timeout = step?.meta?.timeout || 15000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (window.location.href.includes(expected)) {
        return { ok: true, meta: { url: window.location.href }, debug: consumeDebugBuffer() };
      }
      await new Promise(r => setTimeout(r, 300));
    }
    return { ok: false, error: `Timed out waiting for URL to contain "${expected}". Current: "${window.location.href}"`, code: "WAIT_URL_TIMEOUT", debug: consumeDebugBuffer() };
  }

  if (type === "wait_for_text") {
    const expected = String(step?.value ?? "");
    if (!expected) return { ok: false, error: "wait_for_text requires a value.", code: "WAIT_INVALID" };
    const timeout = step?.meta?.timeout || 15000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (el) {
        const actual = getElementText(el);
        if (actual.includes(expected)) {
          return { ok: true, meta: { text: actual, usedSelector: used }, debug: { ...consumeDebugBuffer(), selectorAttempts } };
        }
      }
      await new Promise(r => setTimeout(r, 300));
    }
    return { ok: false, error: `Timed out waiting for text "${expected}" in element.`, code: "WAIT_TEXT_TIMEOUT", debug: consumeDebugBuffer() };
  }

  // Handle compare step - finds and compares multiple elements
  if (type === "compare") {
    console.log("[autotest][replay] compare step:", step.selectCriteria, step.target?.descriptor);
    const criteria = step.selectCriteria || 'lowest';
    const targetDesc = (step.target?.descriptor || '').toLowerCase();
    
    // Find all elements that might contain comparable values (prices, ratings, etc.)
    const candidates = [];
    const allElements = document.querySelectorAll('[class*="price"], [class*="cost"], [class*="rate"], [class*="fare"], [data-price], [data-cost]');
    
    for (const elem of allElements) {
      if (!isElementVisible(elem)) continue;
      
      const text = elem.textContent || '';
      // Extract numeric value (handle currency symbols, commas, etc.)
      const numMatch = text.match(/[\d,]+\.?\d*/);
      if (numMatch) {
        const value = parseFloat(numMatch[0].replace(/,/g, ''));
        if (!isNaN(value)) {
          candidates.push({ element: elem, value, text: text.trim() });
        }
      }
    }
    
    if (candidates.length === 0) {
      console.log("[autotest][replay] No comparable elements found");
      return {
        ok: false,
        error: 'No elements found for comparison',
        code: 'NO_COMPARE_ELEMENTS',
        debug: consumeDebugBuffer()
      };
    }
    
    console.log("[autotest][replay] Found", candidates.length, "candidates for comparison");
    
    // Sort based on criteria
    let selected;
    if (criteria === 'lowest' || criteria === 'cheapest' || criteria === 'min') {
      candidates.sort((a, b) => a.value - b.value);
      selected = candidates[0];
    } else if (criteria === 'highest' || criteria === 'max' || criteria === 'best') {
      candidates.sort((a, b) => b.value - a.value);
      selected = candidates[0];
    } else if (criteria === 'first') {
      selected = candidates[0];
    } else if (criteria.startsWith('contains:')) {
      const searchText = criteria.replace('contains:', '').toLowerCase();
      selected = candidates.find(c => c.text.toLowerCase().includes(searchText));
    } else {
      // Default to lowest
      candidates.sort((a, b) => a.value - b.value);
      selected = candidates[0];
    }
    
    if (selected) {
      console.log("[autotest][replay] ✓ Selected:", selected.text, "value:", selected.value);
      
      // Find clickable element near the selected element (parent or sibling button)
      let clickTarget = selected.element.closest('button, a, [role="button"], [onclick]');
      if (!clickTarget) {
        // Look for sibling or nearby button
        const parent = selected.element.closest('div, li, article, tr');
        if (parent) {
          clickTarget = parent.querySelector('button, a[href], [role="button"]');
        }
      }
      
      if (clickTarget) {
        clickTarget.click();
        await waitForDOMStable();
      }
      
      return {
        ok: true,
        meta: { 
          selectedValue: selected.value, 
          selectedText: selected.text,
          totalCandidates: candidates.length,
          criteria
        },
        debug: consumeDebugBuffer()
      };
    }
    
    return {
      ok: false,
      error: `No element matched criteria: ${criteria}`,
      code: 'COMPARE_NO_MATCH',
      debug: consumeDebugBuffer()
    };
  }

  // Handle scroll step
  if (type === "scroll") {
    const direction = step.value || step.direction || 'down';
    const amount = step.amount || 300;
    
    if (direction === 'down') {
      window.scrollBy(0, amount);
    } else if (direction === 'up') {
      window.scrollBy(0, -amount);
    } else if (direction === 'top') {
      window.scrollTo(0, 0);
    } else if (direction === 'bottom') {
      window.scrollTo(0, document.body.scrollHeight);
    }
    
    await new Promise(resolve => setTimeout(resolve, 300));
    
    return {
      ok: true,
      meta: { direction, amount },
      debug: consumeDebugBuffer()
    };
  }

  // Handle hover step
  if (type === "hover") {
    if (el) {
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    return {
      ok: true,
      meta: { usedSelector: used },
      debug: consumeDebugBuffer()
    };
  }

  return { ok: false, error: `Unsupported step type: ${type}`, code: "UNSUPPORTED_STEP" };
}

async function sendStep(step) {
  if (!state.isRecording) return;
  if (isDuplicate(step)) return;
  if (!step.id) step.id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  // Remember the step behind a click/input/change/submit so a suppressed SPA
  // navigation right after it (see handleNavigation) can patch this step's
  // relativePath to the page it actually landed on.
  if (step.type === "click" || step.type === "input" || step.type === "change" || step.type === "submit") {
    state.lastInteractionStep = step;
  }
  await chrome.runtime.sendMessage({ type: "record_step", step });

  // Learn from recording — every recorded action is a confirmed-good interaction
  learnFromRecordedStep(step);
}

/**
 * Report a recorded step to the backend learning system.
 * During recording the user is interacting with real elements, so every
 * captured step is a guaranteed success. This is the highest-quality
 * learning data we can get.
 */
function learnFromRecordedStep(step) {
  // Backend service has been removed
  return;
}

function makeStep(type, target, value) {
  const { relativePath, queryParams } = computeRelativeLocation(window.location.href, state.baseUrl);
  let selector = generateSelector(target);
  let matchInfo = null;
  
  // Extract element name/label for display
  let elementName = null;
  if (target) {
    // Priority order for extracting meaningful names:
    // 1. aria-label (most semantic)
    elementName = target.getAttribute('aria-label');
    
    // 2. For inputs: placeholder or label
    if (!elementName && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) {
      elementName = target.getAttribute('placeholder') || 
                    target.getAttribute('title') ||
                    target.getAttribute('name')?.replace(/-|_/g, ' ');
      
      // Try to find associated label
      if (!elementName) {
        const id = target.id;
        if (id) {
          const label = document.querySelector(`label[for="${id}"]`);
          if (label) elementName = label.textContent?.trim();
        }
      }
    }
    
    // 3. For buttons: text content or value
    if (!elementName && (target.tagName === 'BUTTON' || target.type === 'submit' || target.type === 'button')) {
      elementName = target.textContent?.trim() ||
                    target.getAttribute('value') ||
                    target.getAttribute('title') ||
                    target.getAttribute('aria-label');
    }
    
    // 4. For links: text content or title
    if (!elementName && target.tagName === 'A') {
      elementName = target.textContent?.trim() ||
                    target.getAttribute('title') ||
                    target.getAttribute('aria-label');
    }
    
    // 5. Generic fallbacks
    if (!elementName) {
      elementName = target.getAttribute('name')?.replace(/-|_/g, ' ') ||
                    target.getAttribute('id')?.replace(/-|_/g, ' ') ||
                    target.getAttribute('data-testid')?.replace(/-|_/g, ' ') ||
                    target.getAttribute('title');
    }
    
    // 6. For elements with text content (not too long)
    if (!elementName) {
      const text = target.textContent?.trim();
      if (text && text.length > 0 && text.length <= 50) {
        elementName = text;
      }
    }
    
    // 7. Last resort: tag name + type
    if (!elementName) {
      const tagName = target.tagName.toLowerCase();
      const inputType = target.getAttribute('type');
      elementName = inputType ? `${tagName}[${inputType}]` : tagName;
    }
    
    // Clean up the element name — strip dynamic content (prices, numbers, etc.)
    // so the name stays stable across replays
    if (elementName) {
      // First, try to extract just the stable part (heading, label, first meaningful word)
      const stableVersion = getStableLabel(target);
      if (stableVersion && stableVersion.length >= 3) {
        elementName = stableVersion;
      } else {
        elementName = elementName
          .substring(0, 100) // Limit length
          .trim()
          .replace(/\s+/g, ' '); // Normalize whitespace
      }
    }
  }
  
  try {
    const primary = selector?.primary;
    if (primary?.type === "css" && primary?.value) {
      const all = Array.from(document.querySelectorAll(primary.value));
      const idx = all.indexOf(target);
      matchInfo = { selector: primary.value, matchCount: all.length, matchIndex: idx };
      if (idx >= 0) {
        primary.matchIndex = idx;
        primary.matchCount = all.length;
      }
    }
  } catch (err) {
    matchInfo = { error: String(err || "matchInfo error") };
  }
  return {
    type,
    timestamp: Date.now(),
    relativePath,
    queryParams,
    selector,
    value: value ?? null,
    elementName, // Store element name for display
    envId: state.env?.id || null,
    appId: state.env?.appId || null,
    meta: { matchInfo }
  };
}

function flushPendingInput() {
  if (state.pendingInputStep) {
    if (state.inputDebounceTimer) {
      clearTimeout(state.inputDebounceTimer);
      state.inputDebounceTimer = null;
    }
    sendStep(state.pendingInputStep);
    state.pendingInputStep = null;
  }
}

/**
 * Walk up from a non-interactive element (svg, path, span without role, etc.)
 * to the nearest semantically meaningful interactive ancestor.
 * This ensures we record clicks on the right element, not on SVG icons inside
 * custom checkboxes / radio buttons / buttons.
 */
function resolveClickTarget(target) {
  const tag = target.tagName?.toLowerCase();
  
  // Already interactive — use as-is
  const interactiveTags = new Set(['input','button','select','textarea','a']);
  if (interactiveTags.has(tag)) return target;
  if (target.getAttribute?.('role') === 'checkbox') return target;
  if (target.getAttribute?.('role') === 'radio') return target;
  if (target.getAttribute?.('role') === 'switch') return target;
  if (target.getAttribute?.('role') === 'button') return target;
  if (target.getAttribute?.('tabindex') != null && target.getAttribute('role')) return target;
  
  // Non-interactive (svg, path, span, div, etc.) — walk up to find the
  // nearest interactive ancestor within a reasonable depth
  const nonInteractive = new Set(['svg','path','circle','rect','line','polyline','polygon','g','use','img','span','div','i','em','strong','b']);
  if (nonInteractive.has(tag) || tag?.startsWith?.('svg:')) {
    let el = target.parentElement;
    let depth = 0;
    while (el && el !== document.body && depth < 6) {
      const pTag  = el.tagName?.toLowerCase();
      const pRole = el.getAttribute?.('role')?.toLowerCase();
      // Found a custom checkbox/radio/switch/button
      if (pRole === 'checkbox' || pRole === 'radio' || pRole === 'switch' || pRole === 'button') {
        return el;
      }
      // Found a native interactive element
      if (interactiveTags.has(pTag)) return el;
      // Found something with tabindex and click handler (likely a custom control)
      if (el.getAttribute?.('tabindex') != null && el.onclick) return el;
      // Found a label wrapping a hidden input
      if (pTag === 'label') return el;
      el = el.parentElement;
      depth++;
    }
  }
  
  return target;
}

// resolveClickTarget() walks up looking for an interactive ancestor, but
// falls back to returning the original element unchanged if it never finds
// one within 6 levels — e.g. a plain wrapper div with no text, no label, no
// click handler, no role. A click landing there is almost always incidental
// (padding, whitespace, a decorative icon, an AEM authoring artifact like
// cq-placeholder) rather than a genuine interaction. Recording it produces a
// step that's either meaningless or impossible to find again on replay.
// Reference: a sibling recorder (hdfc-form-Filler) avoids this entirely by
// only recording clicks on button/input[type=submit|button] — too narrow for
// us (we also need radio/checkbox/custom ARIA toggles/div-styled buttons),
// but its "reject empty text + no name" guard is the right general filter.
function isMeaninglessClickTarget(el) {
  if (!el) return true;
  const tag = el.tagName?.toLowerCase();
  const interactiveTags = new Set(['input', 'button', 'select', 'textarea', 'a']);
  if (interactiveTags.has(tag)) return false;
  if (el.getAttribute?.('role')) return false; // explicit ARIA role — treat as intentional
  if (el.onclick || el.getAttribute?.('tabindex') != null) return false;
  if ((el.textContent || '').trim()) return false;
  if (el.getAttribute?.('aria-label') || el.getAttribute?.('title') || el.getAttribute?.('name')) return false;
  // A wrapper with no text/label of its own but that directly contains a
  // real form control is still a meaningful target — clicking it is how
  // users commonly focus/activate the control inside (e.g. a styled
  // "textField" div wrapping a plain <input>).
  if (el.querySelector?.('input, textarea, select, button, a')) return false;
  // Nothing suggests this is a genuine, findable interactive element.
  return true;
}

// ═══════════════════════════════════════════════════════════════
// ─── Assert Mode (capture assertions during recording) ───────
// ═══════════════════════════════════════════════════════════════

const ASSERT_PICKER_ID = '__autotest_assert_picker';
const ASSERT_HIGHLIGHT_STYLE = '2px solid #22c55e';
const ASSERT_HIGHLIGHT_OFFSET = '2px';

function enableAssertMode() {
  state.isAssertMode = true;
  document.addEventListener('mouseover', handleAssertHover, true);
  document.addEventListener('mouseout', handleAssertUnhover, true);
  console.log('[autotest][assert-mode] Enabled');
}

function disableAssertMode() {
  state.isAssertMode = false;
  removeAssertHighlight();
  removeAssertPicker();
  document.removeEventListener('mouseover', handleAssertHover, true);
  document.removeEventListener('mouseout', handleAssertUnhover, true);
  console.log('[autotest][assert-mode] Disabled');
}

function handleAssertHover(e) {
  if (!state.isAssertMode || !state.isRecording) return;
  if (isExtensionUiTarget(e.target)) return;
  // Don't highlight the assert picker itself
  const picker = document.getElementById(ASSERT_PICKER_ID);
  if (picker && picker.contains(e.target)) return;

  const target = resolveClickTarget(e.target);
  if (state.assertHighlightEl === target) return;

  removeAssertHighlight();
  // Store original styles so we can restore them
  target.__autotest_orig_outline = target.style.outline;
  target.__autotest_orig_outlineOffset = target.style.outlineOffset;
  target.style.outline = ASSERT_HIGHLIGHT_STYLE;
  target.style.outlineOffset = ASSERT_HIGHLIGHT_OFFSET;
  state.assertHighlightEl = target;
}

function handleAssertUnhover(e) {
  if (!state.isAssertMode) return;
  // Don't remove highlight if hovering into the assert picker
  const picker = document.getElementById(ASSERT_PICKER_ID);
  if (picker && picker.contains(e.relatedTarget)) return;
  removeAssertHighlight();
}

function removeAssertHighlight() {
  const el = state.assertHighlightEl;
  if (el) {
    el.style.outline = el.__autotest_orig_outline || '';
    el.style.outlineOffset = el.__autotest_orig_outlineOffset || '';
    delete el.__autotest_orig_outline;
    delete el.__autotest_orig_outlineOffset;
    state.assertHighlightEl = null;
  }
}

function showAssertPicker(target, event) {
  removeAssertPicker();

  // Use innerText (not textContent) to capture the VISUAL text,
  // respecting CSS text-transform (e.g. uppercase/lowercase).
  const textContent = (typeof target.innerText === 'string' ? target.innerText : target.textContent || '').trim().substring(0, 100);
  const currentUrl = window.location.href;
  let urlPath = '';
  try { urlPath = new URL(currentUrl).pathname; } catch { urlPath = currentUrl; }

  // Truncate helper
  const trunc = (s, n) => s.length > n ? s.substring(0, n) + '...' : s;

  const picker = document.createElement('div');
  picker.id = ASSERT_PICKER_ID;
  picker.setAttribute('data-autotest-extension', 'true');
  picker.style.cssText = `
    position: fixed;
    z-index: 2147483647;
    background: #1a1a2e;
    border: 1px solid #3a3a5c;
    border-radius: 8px;
    padding: 6px 0;
    min-width: 240px;
    max-width: 320px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
    color: #e0e0e0;
    line-height: 1.4;
  `;

  // Build options with context-aware labels
  const tagName = target.tagName?.toLowerCase() || '';
  const isInput = tagName === 'input' || tagName === 'textarea' || tagName === 'select';
  const isCheckable = (tagName === 'input' && (target.type === 'checkbox' || target.type === 'radio')) || target.getAttribute('role') === 'checkbox' || target.getAttribute('role') === 'radio' || target.getAttribute('role') === 'switch';

  const options = [
    { type: 'assert_exists', label: 'Element exists', value: null },
    { type: 'assert_visible', label: 'Element is visible', value: null },
    { type: 'assert_hidden', label: 'Element is hidden', value: null },
  ];

  if (textContent) {
    options.push(
      { type: 'assert_text_equals', label: `Text equals "${trunc(textContent, 40)}"`, value: textContent },
      { type: 'assert_text_contains', label: `Text contains "${trunc(textContent, 30)}"`, value: textContent }
    );
  }

  if (isCheckable) {
    const isChecked = target.checked || target.getAttribute('aria-checked') === 'true';
    options.push({ type: 'assert_checked', label: `Checked (currently ${isChecked ? 'yes' : 'no'})`, value: null });
  }

  if (isInput) {
    const val = target.value || '';
    if (val) options.push({ type: 'assert_has_value', label: `Value equals "${trunc(val, 35)}"`, value: val });
    options.push({ type: 'assert_editable', label: 'Is editable', value: null });
  }

  if (target.disabled !== undefined) {
    options.push({ type: target.disabled ? 'assert_disabled' : 'assert_enabled', label: target.disabled ? 'Is disabled' : 'Is enabled', value: null });
  }

  // Class assertion
  if (target.className && typeof target.className === 'string') {
    const firstClass = target.className.split(/\s+/).filter(c => c && c.length < 40)[0];
    if (firstClass) options.push({ type: 'assert_has_class', label: `Has class "${trunc(firstClass, 30)}"`, value: firstClass });
  }

  options.push(
    { type: 'assert_has_title', label: `Page title contains "${trunc(document.title, 30)}"`, value: document.title },
    { type: 'assert_attr_equals', label: 'Attribute equals...', value: null, needsAttr: true },
    { type: 'assert_url_contains', label: `URL contains "${trunc(urlPath, 35)}"`, value: urlPath }
  );

  // Header
  const header = document.createElement('div');
  header.textContent = 'Add Assertion';
  header.style.cssText = 'padding: 6px 14px 4px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: #4ade80; font-weight: 600;';
  picker.appendChild(header);

  for (const opt of options) {
    const item = document.createElement('div');
    item.style.cssText = 'padding: 7px 14px; cursor: pointer; transition: background 0.15s; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';

    // Icon + label
    const icon = opt.type === 'assert_exists' || opt.type === 'assert_visible' ? '\u2713'
      : opt.type === 'assert_hidden' ? '\u2717'
      : opt.type === 'assert_checked' ? '\u2611'
      : opt.type === 'assert_disabled' || opt.type === 'assert_enabled' ? '\u26A0'
      : opt.type === 'assert_editable' ? '\u270E'
      : opt.type === 'assert_has_class' ? '#'
      : opt.type === 'assert_has_value' ? '='
      : opt.type === 'assert_has_title' ? '\u2261'
      : opt.type === 'assert_count' ? '\u2116'
      : opt.type.includes('text') ? 'T'
      : opt.type.includes('attr') ? '@'
      : opt.type.includes('console') ? '!'
      : '\u29C9';
    item.innerHTML = `<span style="display:inline-block;width:18px;color:#4ade80;font-weight:600;">${icon}</span> ${escapeHtml(opt.label)}`;

    item.addEventListener('mouseenter', () => { item.style.background = '#2a2a4e'; });
    item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; });
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();

      if (opt.needsAttr) {
        // Prompt for attribute name
        const attrName = promptAttrInPicker(picker, target, opt);
        return; // handled asynchronously
      }

      recordAssertionStep(opt.type, target, opt.value);
      removeAssertPicker();
    });
    picker.appendChild(item);
  }

  // Cancel
  const cancel = document.createElement('div');
  cancel.textContent = 'Cancel';
  cancel.style.cssText = 'padding: 7px 14px; cursor: pointer; color: #888; border-top: 1px solid #3a3a5c; margin-top: 4px;';
  cancel.addEventListener('mouseenter', () => { cancel.style.background = '#2a2a4e'; });
  cancel.addEventListener('mouseleave', () => { cancel.style.background = 'transparent'; });
  cancel.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); removeAssertPicker(); });
  picker.appendChild(cancel);

  // Position near the click, keeping within viewport
  const x = Math.min(event.clientX + 4, window.innerWidth - 260);
  const y = Math.min(event.clientY + 4, window.innerHeight - 300);
  picker.style.left = `${Math.max(4, x)}px`;
  picker.style.top = `${Math.max(4, y)}px`;

  document.body.appendChild(picker);

  // Close on outside click (delayed to avoid the triggering click)
  setTimeout(() => {
    document.addEventListener('click', _closeAssertPickerOutside, true);
  }, 50);
}

function _closeAssertPickerOutside(e) {
  const picker = document.getElementById(ASSERT_PICKER_ID);
  if (picker && !picker.contains(e.target)) {
    e.stopPropagation();
    e.preventDefault();
    removeAssertPicker();
  }
}

function removeAssertPicker() {
  const picker = document.getElementById(ASSERT_PICKER_ID);
  if (picker) picker.remove();
  document.removeEventListener('click', _closeAssertPickerOutside, true);
}

/**
 * Show an inline input inside the picker for attribute assertions.
 */
function promptAttrInPicker(picker, target, opt) {
  // Replace picker contents with an attribute input form
  const existingItems = Array.from(picker.children);
  existingItems.forEach(c => c.style.display = 'none');

  const form = document.createElement('div');
  form.style.cssText = 'padding: 10px 14px;';
  form.innerHTML = `
    <div style="font-size:11px;color:#94a3b8;margin-bottom:6px;">Attribute name (e.g. href, data-id)</div>
    <input type="text" placeholder="attribute" style="
      width: 100%; box-sizing: border-box; padding: 6px 8px; background: #0d0d1a; border: 1px solid #3a3a5c;
      border-radius: 4px; color: #e0e0e0; font-size: 13px; font-family: monospace; outline: none;
    " />
    <div style="display:flex;gap:6px;margin-top:8px;">
      <button style="flex:1;padding:5px 0;background:#166534;color:#4ade80;border:1px solid #22c55e;border-radius:4px;cursor:pointer;font-size:12px;">OK</button>
      <button style="flex:1;padding:5px 0;background:transparent;color:#888;border:1px solid #3a3a5c;border-radius:4px;cursor:pointer;font-size:12px;">Cancel</button>
    </div>
  `;
  picker.appendChild(form);

  const input = form.querySelector('input');
  const [okBtn, cancelBtn] = form.querySelectorAll('button');

  input.focus();

  okBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    const attrName = input.value.trim();
    if (!attrName) { input.style.borderColor = '#ef4444'; return; }
    const attrVal = target.getAttribute(attrName) || '';
    recordAssertionStep('assert_attr_equals', target, attrVal, { attr: attrName });
    removeAssertPicker();
  });

  cancelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    // Restore picker items
    form.remove();
    existingItems.forEach(c => c.style.display = '');
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); okBtn.click(); }
    if (e.key === 'Escape') { e.preventDefault(); cancelBtn.click(); }
  });
}

/**
 * Record an assertion step using the same makeStep infrastructure.
 */
function recordAssertionStep(type, target, value, extra) {
  const step = makeStep(type, target, value);

  // For text assertions, use the VISUAL text (innerText) to respect CSS text-transform
  if ((type === 'assert_text_equals' || type === 'assert_text_contains') && !value) {
    step.value = (typeof target.innerText === 'string' ? target.innerText : target.textContent || '').trim();
  }

  // For URL assertions, clear the selector — the URL is the target
  if (type === 'assert_url_contains') {
    step.value = value || window.location.pathname;
  }

  // For attribute assertions, store the attribute name in meta
  if (type === 'assert_attr_equals' && extra?.attr) {
    step.meta = step.meta || {};
    step.meta.attr = extra.attr;
  }

  console.log(`[autotest][assert-mode] Recorded: ${type}`, step);
  sendStep(step);

  // ── One-shot: auto-disable assert mode after capturing an assertion ──
  // This returns the user to normal recording immediately so they can
  // continue clicking / typing without having to manually toggle off.
  disableAssertMode();
  // Notify popup/sidepanel so the UI button resets
  chrome.runtime.sendMessage({ type: 'assert_mode_auto_off' }).catch(() => {});
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

// ═══════════════════════════════════════════════════════════════

function handleClick(event) {
  if (!state.isRecording) return;
  if (event.button !== 0) return;
  if (isExtensionUiTarget(event.target)) return;
  if (isAemAuthoringPlaceholder(event.target)) {
    console.log("[autotest][record] Ignoring click on AEM authoring placeholder (cq-placeholder) — not a real page element, would never be findable on replay.");
    return;
  }

  // ── Assert mode: intercept click to capture assertion instead ──
  if (state.isAssertMode) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const target = resolveClickTarget(event.target);
    removeAssertHighlight();
    showAssertPicker(target, event);
    return;
  }
  
  // Walk up from non-interactive targets (svg, path, etc.) to the real control
  const target = resolveClickTarget(event.target);
  const tagName = target.tagName?.toLowerCase();
  const inputType = target.getAttribute?.('type')?.toLowerCase();
  const targetRole = target.getAttribute?.('role')?.toLowerCase();
  const isInputElement = (tagName === "input" || tagName === "textarea" || tagName === "select" || target.isContentEditable);
  
  // ── Native radio / checkbox: always record as CLICK immediately ──
  const isNativeCheckRadio = tagName === 'input' && (inputType === 'radio' || inputType === 'checkbox');
  if (isNativeCheckRadio) {
    flushPendingInput();
    sendStep(makeStep("click", target));
    state.lastClickTarget = target;
    state.lastClickTime = Date.now();
    state.lastClickSentAt = Date.now();
    return;
  }
  
  // ── Custom role="checkbox/radio/switch": record as CLICK immediately ──
  if (targetRole === 'checkbox' || targetRole === 'radio' || targetRole === 'switch') {
    flushPendingInput();
    sendStep(makeStep("click", target));
    state.lastClickTarget = target;
    state.lastClickTime = Date.now();
    state.lastClickSentAt = Date.now();
    return;
  }
  
  // If clicking on a text-like input element, track it but delay sending the click.
  // If an input event follows quickly, we skip the click and only record the input.
  if (isInputElement) {
    const clickTime = Date.now();
    state.lastClickTarget = target;
    state.lastClickTime = clickTime;

    setTimeout(() => {
      if (state.lastClickTarget === target && state.lastClickTime === clickTime) {
        flushPendingInput();
        sendStep(makeStep("click", target));
        state.lastClickSentAt = Date.now();
        state.lastClickTarget = null;
        state.lastClickTime = 0;
      }
    }, CLICK_TO_INPUT_WINDOW_MS);
    return;
  }
  
  // For non-input elements, send click immediately — unless nothing about
  // the resolved target suggests it's a genuine, findable interactive
  // element (no text, no label, no role, no handler), in which case this is
  // almost certainly an incidental click, not something worth replaying.
  if (isMeaninglessClickTarget(target)) {
    console.log("[autotest][record] Ignoring click — no text/label/role/handler on resolved target, likely incidental:", {
      tag: target.tagName?.toLowerCase(),
      class: typeof target.className === "string" ? target.className.slice(0, 60) : null
    });
    return;
  }
  flushPendingInput();
  sendStep(makeStep("click", target));
  state.lastClickSentAt = Date.now();
}

function handleInput(event) {
  if (!state.isRecording) return;
  if (isExtensionUiTarget(event.target)) return;
  const target = event.target;
  if (!target || !("value" in target)) return;
  
  // ── Skip radio/checkbox: already recorded as a click ──
  // Native <input type="radio/checkbox"> and custom role="radio/checkbox" elements
  // are toggled by click, not by setting a text value.
  const tagLower = target.tagName?.toLowerCase();
  const inpType  = target.getAttribute?.('type')?.toLowerCase();
  const inpRole  = target.getAttribute?.('role')?.toLowerCase();
  if (tagLower === 'input' && (inpType === 'radio' || inpType === 'checkbox')) {
    return; // Nothing to record — the click step handles the toggle
  }
  if (inpRole === 'radio' || inpRole === 'checkbox' || inpRole === 'switch') {
    return; // Custom toggle component — click already recorded
  }
  
  // Check if this input is on the element we just clicked
  const timeSinceClick = Date.now() - state.lastClickTime;
  const isSameAsClickedElement = state.lastClickTarget === target;

  // If input happens shortly after clicking the same element, cancel the pending click
  if (isSameAsClickedElement && timeSinceClick < CLICK_TO_INPUT_WINDOW_MS) {
    state.lastClickTarget = null;
    state.lastClickTime = 0;
  }

  const step = makeStep(event.type, target, target.value);

  // Check if this is input on the same field as pending step
  const sameField = state.pendingInputStep &&
    state.pendingInputStep.selector?.primary?.value === step.selector?.primary?.value &&
    state.pendingInputStep.relativePath === step.relativePath;

  if (sameField) {
    // Update pending step with new value instead of creating new step
    state.pendingInputStep.value = step.value;
    state.pendingInputStep.timestamp = Date.now();
    
    // Reset debounce timer
    if (state.inputDebounceTimer) {
      clearTimeout(state.inputDebounceTimer);
    }
    
    // Send after INPUT_DEBOUNCE_MS of no activity
    state.inputDebounceTimer = setTimeout(() => {
      if (state.pendingInputStep) {
        sendStep(state.pendingInputStep);
        state.pendingInputStep = null;
        state.inputDebounceTimer = null;
      }
    }, INPUT_DEBOUNCE_MS);
  } else {
    // Different field - flush any pending step first
    if (state.pendingInputStep) {
      clearTimeout(state.inputDebounceTimer);
      sendStep(state.pendingInputStep);
      state.pendingInputStep = null;
      state.inputDebounceTimer = null;
    }
    
    // Start new pending step
    state.pendingInputStep = step;
    state.inputDebounceTimer = setTimeout(() => {
      if (state.pendingInputStep) {
        sendStep(state.pendingInputStep);
        state.pendingInputStep = null;
        state.inputDebounceTimer = null;
      }
    }, INPUT_DEBOUNCE_MS);
  }
}

function handleSubmit(event) {
  if (!state.isRecording) return;
  if (isExtensionUiTarget(event.target)) return;
  flushPendingInput(); // Flush any pending input before submit
  sendStep(makeStep("submit", event.target));
}

/**
 * Time window (ms) after a click within which we suppress pushState /
 * replaceState navigation recordings.  In React SPAs and micro-frontend
 * architectures, clicking a button often triggers history.pushState as
 * part of the SPA transition.  Recording this as a separate "navigation"
 * step would cause a full page reload during replay, which is wrong —
 * the click step alone is sufficient to trigger the SPA transition.
 */
const CLICK_NAV_SUPPRESS_MS = 2000;

function handleNavigation(kind) {
  if (!state.isRecording) return;
  
  // ── Suppress SPA navigations triggered by a recent click ──
  // pushState / replaceState fired within CLICK_NAV_SUPPRESS_MS after the
  // last recorded click are side-effects of that click (React Router,
  // micro-frontend shell, etc.).  The click step is already recorded;
  // adding a navigation step would cause a redundant full page reload
  // during replay.
  if (kind === 'pushState' || kind === 'replaceState') {
    const timeSinceClick = Date.now() - (state.lastClickSentAt || 0);
    if (timeSinceClick < CLICK_NAV_SUPPRESS_MS) {
      console.log("[autotest][record] Suppressing", kind, "navigation —",
        timeSinceClick + "ms after click (SPA transition)");
      // Update the last recorded step's relativePath to the NEW path so the
      // step list/HUD reflects the page this step actually landed on,
      // instead of the page it was clicked from.
      const interactionStep = state.lastInteractionStep;
      if (interactionStep) {
        const { relativePath, queryParams } = computeRelativeLocation(window.location.href, state.baseUrl);
        interactionStep.relativePath = relativePath;
        interactionStep.queryParams = queryParams;
        chrome.runtime.sendMessage({
          type: "patch_step_path",
          stepId: interactionStep.id,
          relativePath,
          queryParams
        }).catch(() => {});
      }
      return;
    }
  }
  
  flushPendingInput(); // Flush any pending input before navigation
  const step = makeStep("navigation", null);
  step.meta = { kind };
  sendStep(step);
}

function hookHistory() {
  const originalPush = history.pushState;
  const originalReplace = history.replaceState;

  history.pushState = function (...args) {
    const ret = originalPush.apply(this, args);
    handleNavigation("pushState");
    return ret;
  };
  history.replaceState = function (...args) {
    const ret = originalReplace.apply(this, args);
    handleNavigation("replaceState");
    return ret;
  };

  window.addEventListener("popstate", () => handleNavigation("popstate"));
  window.addEventListener("hashchange", () => handleNavigation("hashchange"));
}

async function startRecording(envOverride) {
  if (state.isRecording) return;
  
  // Auto-close HUD if it's open
  if (window.__autotestHUD && window.__autotestHUD.isVisible) {
    console.log("[autotest][recording] Auto-closing HUD during recording");
    window.__autotestHUD.hide();
  }
  
  // Use whatever env was provided (may be null if none configured).
  // We intentionally do NOT round-trip to the background here — the caller
  // (background's startRecordingOnTab or restoreRecordingState) already
  // fetched the environment and passed it through.
  state.env = envOverride || null;
  state.baseUrl = getEnvironmentBaseUrl(state.env);
  state.lastRecordedFieldValue.clear();
  state.isRecording = true;
  console.log("[autotest][content] Recording started, env:", state.env?.name || "(none)");
}

function stopRecording() {
  flushPendingInput(); // Flush any pending input before stopping
  state.isRecording = false;
  // Always disable assert mode when recording stops
  if (state.isAssertMode) disableAssertMode();
  // Clear network intercept state set during recording
  networkInterceptState.capturePatterns = [];
  networkInterceptState.activeBlockPatterns = [];
}

// ── Keyboard recording ──────────────────────────────────────
const SPECIAL_KEYS = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
const MODIFIER_COMBOS = new Set(['a', 'c', 'v', 'x', 'z', 's', 'f']); // Ctrl/Cmd + key
// Backspace/Delete while actively typing in a text field are pure
// self-corrections — the *next* input event already reflects the edited
// value. Recording them as their own step (which flushes whatever was typed
// so far first) fragments one edit into many: typing "adi", backspacing, and
// retyping "agarwal" becomes 5+ separate recorded steps instead of one final
// "agarwal". Replaying all of those fires the page's own field validation
// repeatedly in rapid succession — much faster than the user actually typed —
// which some forms' async validation can't handle cleanly.
const TEXT_CORRECTION_KEYS = new Set(['Backspace', 'Delete']);

function handleKeyDown(event) {
  if (!state.isRecording) return;
  if (isExtensionUiTarget(event.target)) return;
  if (state.isAssertMode) return;

  const key = event.key;
  const hasModifier = event.ctrlKey || event.metaKey || event.altKey;

  // Record special keys and modifier combos only
  const isSpecial = SPECIAL_KEYS.has(key);
  const isModCombo = hasModifier && key.length === 1 && MODIFIER_COMBOS.has(key.toLowerCase());

  if (!isSpecial && !isModCombo) return;

  // Don't record Tab if it's just navigating focus during typing
  if (key === 'Tab' && !hasModifier) {
    // Only record Tab if the user isn't currently typing in an input
    const tag = event.target.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
  }

  // Don't record/flush Backspace or Delete while actively editing a text
  // field — let it be absorbed into the ongoing typing session instead (see
  // TEXT_CORRECTION_KEYS above).
  if (TEXT_CORRECTION_KEYS.has(key) && !hasModifier) {
    const tag = event.target.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || event.target.isContentEditable) return;
  }

  flushPendingInput();
  const step = makeStep("key", event.target, key);
  step.meta = step.meta || {};
  step.meta.key = key;
  step.meta.code = event.code;
  step.meta.ctrlKey = event.ctrlKey;
  step.meta.shiftKey = event.shiftKey;
  step.meta.altKey = event.altKey;
  step.meta.metaKey = event.metaKey;
  sendStep(step);
}

// ── File upload recording ──────────────────────────────────
function handleFileUpload(event) {
  if (!state.isRecording) return;
  if (isExtensionUiTarget(event.target)) return;

  const target = event.target;
  if (target.tagName?.toLowerCase() !== 'input' || target.type !== 'file') return;

  const files = target.files;
  if (!files || files.length === 0) return;

  const step = makeStep("upload", target, null);
  step.meta = step.meta || {};
  step.meta.fileCount = files.length;
  step.meta.fileName = files[0]?.name || '';
  step.meta.fileNames = Array.from(files).map(f => f.name);
  sendStep(step);
}

// ── Drag and drop recording ────────────────────────────────
let _dragSource = null;
let _dragSourceSelector = null;

function handleDragStart(event) {
  if (!state.isRecording) return;
  if (isExtensionUiTarget(event.target)) return;
  _dragSource = event.target;
  _dragSourceSelector = generateSelector(event.target);
}

function handleDrop(event) {
  if (!state.isRecording) return;
  if (!_dragSource) return;
  if (isExtensionUiTarget(event.target)) return;

  const target = event.target;
  const step = makeStep("drag_drop", _dragSource, null);
  step.meta = step.meta || {};
  step.meta.sourceSelector = _dragSourceSelector;
  step.meta.targetSelector = generateSelector(target);
  sendStep(step);

  _dragSource = null;
  _dragSourceSelector = null;
}

function wireListeners() {
  document.addEventListener("click", handleClick, true);
  document.addEventListener("input", handleInput, true);
  document.addEventListener("change", handleInput, true);
  document.addEventListener("change", handleFileUpload, true);
  document.addEventListener("submit", handleSubmit, true);
  document.addEventListener("keydown", handleKeyDown, true);
  document.addEventListener("dragstart", handleDragStart, true);
  document.addEventListener("drop", handleDrop, true);
  hookHistory();
}

/**
 * Report action success/failure to the backend learning system.
 * Fire-and-forget: errors are logged but never block the replay.
 */
function reportActionToLearning(step, result) {
  // Backend service has been removed
  return;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void sender;

  // ── Storage state helpers (Group M) ──
  if (message?.type === "get_local_storage") {
    try {
      const data = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        data[key] = localStorage.getItem(key);
      }
      sendResponse({ ok: true, data });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
    return false;
  }

  if (message?.type === "set_local_storage") {
    try {
      const data = message?.data || {};
      for (const [key, val] of Object.entries(data)) {
        localStorage.setItem(key, val);
      }
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
    return false;
  }

  // Page context extraction for NLP
  if (message?.type === "extract_page_context") {
    console.log("[autotest][content] ===== PAGE CONTEXT EXTRACTION REQUEST =====");
    (async () => {
      try {
        console.log("[autotest][content] Importing page-context module...");
        const { extractPageContext } = await import(chrome.runtime.getURL('shared/page-context.js'));
        console.log("[autotest][content] Page-context module imported");
        
        console.log("[autotest][content] Extracting page context...");
        const context = extractPageContext({
          maxElements: 50,
          maxTextLength: 100,
          includeHidden: false
        });
        console.log("[autotest][content] ✓ Page context extracted:", {
          elementsCount: context.elements?.length || 0,
          formsCount: context.forms?.length || 0,
          linksCount: context.links?.length || 0
        });
        
        sendResponse({ ok: true, context });
      } catch (err) {
        console.error("[autotest][content] ❌ Context extraction failed:", err);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
  
  // Video recording messages
  if (message?.type === "video_start_recording") {
    console.log("[autotest][content] ===== VIDEO START REQUEST RECEIVED =====");
    (async () => {
      try {
        console.log("[autotest][content] Importing video-recorder module...");
        const videoRecorderModule = await import(chrome.runtime.getURL('content/video-recorder.js'));
        const videoRecorder = videoRecorderModule.videoRecorder;
        console.log("[autotest][content] Video recorder module imported");
        
        console.log("[autotest][content] Calling videoRecorder.startRecording()...");
        const result = await videoRecorder.startRecording();
        console.log("[autotest][content] Video start result:", result);
        
        sendResponse(result);
      } catch (err) {
        console.error("[autotest][content] ❌ Video start exception:", err);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
  
  if (message?.type === "video_stop_recording") {
    console.log("[autotest][content] ===== VIDEO STOP REQUEST RECEIVED =====");
    (async () => {
      try {
        console.log("[autotest][content] Importing video-recorder module...");
        const videoRecorderModule = await import(chrome.runtime.getURL('content/video-recorder.js'));
        const videoRecorder = videoRecorderModule.videoRecorder;
        console.log("[autotest][content] Video recorder module imported");
        
        console.log("[autotest][content] Calling videoRecorder.stopRecording()...");
        const result = await videoRecorder.stopRecording();
        console.log("[autotest][content] Video stop result:", {
          ok: result.ok,
          hasVideoData: !!result.videoData,
          videoDataLength: result.videoData?.length,
          size: result.size,
          mimeType: result.mimeType,
          error: result.error
        });
        
        sendResponse(result);
      } catch (err) {
        console.error("[autotest][content] ❌ Video stop exception:", err);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
  
  // Health check - respond immediately
  if (message?.type === "ping") {
    const receiveTime = Date.now();
    console.log("[autotest][content] Received ping, responding...");
    
    sendResponse({ ok: true, alive: true, documentHidden: document.hidden, visibilityState: document.visibilityState });
    return true;
  }
  
  if (message?.type === "recorder_start") {
    startRecording(message?.env)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error(err);
        sendResponse({ ok: false, error: "START_FAILED" });
      });
    return true;
  }
  if (message?.type === "recorder_stop") {
    stopRecording();
    sendResponse({ ok: true });
    return true;
  }
  // ── Assert mode messages ──
  if (message?.type === "assert_mode_on") {
    enableAssertMode();
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "assert_mode_off") {
    disableAssertMode();
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "refresh_environment") {
    state.env = message.env || state.env;
    state.baseUrl = getEnvironmentBaseUrl(state.env);
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "replay_execute_step") {
    const receiveTime = Date.now();
    console.log("[autotest][content] Received replay_execute_step message, step:", message?.step?.type, message?.step?.id);
    
    console.log("[autotest][content] Document state:", {
      readyState: document.readyState,
      hidden: document.hidden,
      visibilityState: document.visibilityState,
      url: window.location.href
    });
    
    if (message?.healingConfig) state.healingConfig = message.healingConfig;
    
    // Add validation
    if (!message.step) {
      console.error("[autotest][content] No step provided in message");
      sendResponse({ ok: false, error: "No step provided.", code: "EXEC_ERROR" });
      return true;
    }
    
    // CRITICAL FIX: Wait for tab to become visible before executing step
    const waitForVisible = async () => {
      if (!document.hidden) return; // Already visible
      
      console.log("[autotest][content] Tab is hidden, waiting for visibility before executing step...");
      
      return new Promise((resolve) => {
        const checkVisibility = () => {
          if (!document.hidden) {
            console.log("[autotest][content] Tab is now visible, proceeding with step execution");
            document.removeEventListener('visibilitychange', checkVisibility);
            resolve();
          }
        };
        
        document.addEventListener('visibilitychange', checkVisibility);
        
        // Also set a timeout to prevent infinite waiting
        setTimeout(() => {
          document.removeEventListener('visibilitychange', checkVisibility);
          resolve();
        }, 300000); // 5 minutes max
      });
    };
    
    // Wait for visibility, then execute step
    (async () => {
      try {
        await waitForVisible();
        
        console.log("[autotest][content] Starting performStep for step:", message.step.id);
        const performStartTime = Date.now();
        
        const result = await performStep(message.step);
        const performDuration = Date.now() - performStartTime;
        const completeTime = Date.now();
        
        console.log("[autotest][content] performStep completed successfully:", result);
        
        // Report to learning system (fire and forget)
        reportActionToLearning(message.step, result);
        
        try {
          sendResponse(result);
        } catch (err) {
          console.log("[autotest][replay] Response channel closed, step may have triggered navigation");
        }
      } catch (err) {
        console.error("[autotest][replay] performStep error:", err);
        
        // Report failure to learning system (fire and forget)
        reportActionToLearning(message.step, { ok: false, error: err?.message });
        
        try {
          sendResponse({ 
            ok: false, 
            error: `Step execution failed: ${err?.message || String(err)}`, 
            code: "EXEC_ERROR",
            debug: {
              errorStack: err?.stack,
              stepType: message?.step?.type
            }
          });
        } catch (sendErr) {
          console.log("[autotest][replay] Error response channel closed");
        }
      }
    })();
    
    return true;
  }
  
  // ── HUD messages (iframe-based HUD — only show/hide needed) ──
  // show() / hide() are async (they await tab ID resolution)
  if (message?.type === "hud_show") {
    if (window.__autotestHUD) {
      Promise.resolve(window.__autotestHUD.show())
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: true }));
    } else {
      sendResponse({ ok: true });
    }
    return true;
  }
  if (message?.type === "hud_hide") {
    if (window.__autotestHUD) {
      Promise.resolve(window.__autotestHUD.hide())
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: true }));
    } else {
      sendResponse({ ok: true });
    }
    return true;
  }
  // Legacy HUD messages — no-ops now (iframe handles state via popup.js)
  if (message?.type === "hud_update" ||
      message?.type === "hud_recording_start" ||
      message?.type === "hud_recording_update" ||
      message?.type === "hud_recording_stop") {
    sendResponse({ ok: true });
    return true;
  }
  
  if (message?.type === "replay_wait_ready") {
    Promise.resolve()
      .then(async () => {
        // Best-effort: some pages never go fully quiet (animated loaders,
        // analytics beacons, keep-alive pings). Wait up to the timeout for
        // real idle, but don't abort the whole replay if it never arrives —
        // just proceed with a warning, same as the post-action waits do.
        const pageIdle = await waitForPageIdle();
        if (!pageIdle.ok) console.warn("[autotest][replay] Page never fully settled post-navigation, continuing:", pageIdle.error);
        return { ok: true };
      })
      .then((resp) => sendResponse(resp))
      .catch((err) => {
        console.error(err);
        sendResponse({ ok: false, error: "Wait failed.", code: "WAIT_FAILED" });
      });
    return true;
  }

  // ── Network block/mock setup for replay ──
  if (message?.type === "network_mock_setup") {
    networkInterceptState.activeMocks = message.mocks || [];
    networkInterceptState.activeBlockPatterns = message.blockPatterns || [];
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "network_mock_teardown") {
    networkInterceptState.activeMocks = [];
    networkInterceptState.activeBlockPatterns = [];
    sendResponse({ ok: true });
    return true;
  }

  // ── Capture patterns update (sent when recording starts) ──
  if (message?.type === "set_capture_patterns") {
    networkInterceptState.capturePatterns = message.patterns || [];
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

wireListeners();
patchNetworkTracking();

// Check if recording was active before page navigation/reload
// This ensures recording continues across page navigations
(async function restoreRecordingState() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: "get_recording_state" });
    if (resp?.ok && resp?.isRecording) {
      // Get environment info and restart recording
      const envResp = await chrome.runtime.sendMessage({ type: "get_environment" });
      await startRecording(envResp?.env || null);
      console.log("[autotest][recorder] Recording state restored after navigation");
    }
  } catch (err) {
    console.error("[autotest][recorder] Failed to restore recording state:", err);
  }
})();

