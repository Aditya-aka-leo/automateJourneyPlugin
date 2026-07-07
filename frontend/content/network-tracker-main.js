// Runs in the page's MAIN world (declared via "world": "MAIN" in manifest.json),
// NOT the content script's isolated world. A content script's isolated world
// has its own separate copy of window.fetch/XMLHttpRequest — patching those
// from content.js only ever sees requests the extension itself makes, never
// the page's own script calls. This script patches the real globals the page
// actually uses, and exposes the result via DOM attributes on <html>, which
// (unlike JS globals) are visible to the isolated-world content script since
// both worlds share the same DOM.
(() => {
  if (window.__autotestNetPatched) return;
  window.__autotestNetPatched = true;

  // Keep in sync with NETWORK_IDLE_IGNORE_PATTERNS in content.js.
  const NOISE_PATTERNS = [
    /google-analytics\.com/i, /googletagmanager\.com/i, /doubleclick\.net/i,
    /facebook\.com\/tr/i, /demdex\.net/i, /omtrdc\.net/i, /adobedtm\.com/i,
    /2o7\.net/i, /hotjar\.com/i, /clarity\.ms/i, /nr-data\.net/i, /newrelic\.com/i,
    /sentry\.io/i, /segment\.(io|com)/i, /mixpanel\.com/i, /amplitude\.com/i,
    /\/b\/ss\//i
  ];
  const isNoise = (url) => NOISE_PATTERNS.some((re) => re.test(String(url || "")));

  let pending = 0;
  const root = document.documentElement;

  function sync() {
    root.setAttribute("data-autotest-net-pending", String(pending));
    root.setAttribute("data-autotest-net-last-activity", String(Date.now()));
  }
  sync();

  const originalFetch = window.fetch ? window.fetch.bind(window) : null;
  if (originalFetch) {
    window.fetch = async (...args) => {
      const url = String(args?.[0] instanceof Request ? args[0].url : args?.[0] || "");
      const noise = isNoise(url);
      if (!noise) { pending += 1; sync(); }
      try {
        return await originalFetch(...args);
      } finally {
        if (!noise) { pending = Math.max(0, pending - 1); sync(); }
      }
    };
  }

  const OrigOpen = XMLHttpRequest.prototype.open;
  const OrigSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (...args) {
    this.__autotestUrl = String(args[1] || "");
    return OrigOpen.apply(this, args);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const noise = isNoise(this.__autotestUrl);
    if (!noise) { pending += 1; sync(); }
    this.addEventListener("loadend", () => {
      if (!noise) { pending = Math.max(0, pending - 1); sync(); }
    }, { once: true });
    return OrigSend.apply(this, args);
  };
})();
