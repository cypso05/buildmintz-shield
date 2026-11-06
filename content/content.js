/* BuildMintZ Shield — cosmetic filtering content script */
(() => {
  'use strict';

  const SELECTORS = [
    // General ad networks
    'ins.adsbygoogle',
    '[id^="google_ads_"]',
    '[id^="google_ads_iframe"]',
    '[id^="div-gpt-ad"]',
    '[data-ad-slot]',
    '[data-ad-client]',
    'iframe[src*="doubleclick.net"]',
    'iframe[src*="googlesyndication.com"]',
    'iframe[src*="amazon-adsystem.com"]',
    '[aria-label="advertisement"]',
    '[aria-label="Advertisement"]',
    '[class*="sponsored-content"]',
    '[data-testid*="ad-"]',
    '[id*="taboola"]',
    '[id*="outbrain"]',
    '[class*="ad-overlay"]',
    '[class*="adOverlay"]',
    '[class*="image-ad"]',

    // YouTube — banners, sidebars, feed ads
    '#player-ads',
    '#masthead-ad',
    'ytd-display-ad-renderer',
    'ytd-promoted-sparkles-web-renderer',
    'ytd-ad-slot-renderer',
    'ytd-in-feed-ad-layout-renderer',
    'ytd-promoted-video-renderer',
    'ytd-banner-promo-renderer',
    'ytd-statement-banner-renderer',
    'ytd-compact-promoted-video-renderer',
    'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"]',
    'ytd-rich-item-renderer:has(> #content > ytd-ad-slot-renderer)',
    '#player-ads ytd-ad-slot-renderer',

    // YouTube — in-player image overlay / survey ads (the "Next" carousel)
    '.ytp-ad-overlay-container',
    '.ytp-ad-overlay-slot',
    '.ytp-ad-image-overlay',
    '.ytp-ad-text-overlay',
    '.ytp-ad-survey',
    '.ytp-ad-survey-container',
    '.ytp-ad-player-overlay-layout',
    '.ytp-ad-module',
    '.ytp-ad-suggested-action',
    '.ytp-suggested-action',
    '.ytp-ad-overlay-ad-info-dialog-container',
    '.ytp-ad-overlay-ad-info-button-container',
    '.ytp-ad-overlay-close-container'
  ];

  const SELECTOR = SELECTORS.join(',');
  const STYLE_ID = 'buildmintz-shield-cosmetic';
  const FLUSH_INTERVAL_MS = 2000;
  const OBSERVE_DEBOUNCE_MS = 200;
  const NAVIGATION_CHECK_MS = 1000;

  let active = false;
  let observer = null;
  let pendingCount = 0;
  let flushTimer = null;
  let observeTimer = null;
  let navigationTimer = null;
  let lastHref = location.href;
  let evaluationId = 0;

  // ---- batched cosmetic counting (do not run querySelectorAll per mutation) ----
  const countQueue = [];
  let countScheduled = false;
  function scheduleCountFlush() {
    if (countScheduled) return;
    countScheduled = true;
    const run = () => {
      countScheduled = false;
      const batch = countQueue.splice(0, countQueue.length);
      for (const root of batch) countMatches(root);
    };
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(run, { timeout: 1000 });
    } else {
      setTimeout(run, 400);
    }
  }

  const hostMatches = (host, entry) => host === entry || host.endsWith(`.${entry}`);

  function normalizeHost(value) {
    if (typeof value !== 'string') return null;
    const host = value.trim().toLowerCase().replace(/^www\./, '');
    if (!host || host.length > 253 || !host.includes('.') ||
        /[/:@*?#\s\\]/.test(host) ||
        host.startsWith('.') || host.endsWith('.') || host.includes('..')) return null;
    return host;
  }

  async function readState() {
    try {
      return await new Promise(resolve => {
        chrome.storage.local.get({ enabled: true, cosmetic: true, allowlist: [] }, result => {
          if (chrome.runtime.lastError) return resolve({ enabled: false, cosmetic: false, allowlist: [] });
          resolve(result);
        });
      });
    } catch { return { enabled: false, cosmetic: false, allowlist: [] }; }
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const target = document.head || document.documentElement;
    if (!target) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `${SELECTOR} { display: none !important; visibility: hidden !important; }`;
    target.appendChild(style);
  }

  function removeStyle() {
    try { document.getElementById(STYLE_ID)?.remove(); } catch {}
  }

  function countMatches(root) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return;
    try {
      if (root.matches(SELECTOR)) pendingCount++;
      pendingCount += root.querySelectorAll(SELECTOR).length;
    } catch {}
  }

  function scheduleObserve() {
    if (observeTimer || !active) return;
    observeTimer = setTimeout(() => {
      observeTimer = null;
      if (!active || observer || !document.documentElement) return;
      try {
        observer = new MutationObserver(mutations => {
          if (!active) return;
          if (!document.getElementById(STYLE_ID)) injectStyle();  // YouTube SPA can replace <head>
          for (const m of mutations) {
            for (const node of m.addedNodes) {
              if (node.nodeType === Node.ELEMENT_NODE) {
                countQueue.push(node);
                scheduleCountFlush();
              }
            }
          }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
      } catch {
        observer?.disconnect();
        observer = null;
      }
    }, OBSERVE_DEBOUNCE_MS);
  }

  function flush() {
    if (pendingCount <= 0) return;
    const count = pendingCount;
    pendingCount = 0;
    try { chrome.runtime.sendMessage({ type: 'cosmeticHidden', count }).catch(() => {}); } catch {}
  }

  // Write pause state to a data attribute page.js can read from the MAIN world.
  function publishEnabled(enabled) {
    try {
      document.documentElement.setAttribute('data-bmz-enabled', enabled ? '1' : '0');
    } catch {}
  }

  function start() {
    if (active) { injectStyle(); scheduleObserve(); return; }
    active = true;
    injectStyle();
    try { if (document.documentElement) countMatches(document.documentElement); } catch {}
    scheduleObserve();
    if (!flushTimer) flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
  }

  function stop() {
    active = false;
    if (observeTimer) { clearTimeout(observeTimer); observeTimer = null; }
    try { observer?.disconnect(); } catch {}
    observer = null;
    removeStyle();
    if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
    flush();
  }

  async function evaluate() {
    const currentEvaluation = ++evaluationId;
    const state = await readState();
    if (currentEvaluation !== evaluationId) return;

    publishEnabled(!!state.enabled);

    const host = location.hostname.toLowerCase().replace(/^www\./, '');
    const allowlist = Array.isArray(state.allowlist)
      ? state.allowlist.map(normalizeHost).filter(Boolean) : [];
    const exempt = allowlist.some(entry => hostMatches(host, entry));

    if (state.enabled && state.cosmetic && !exempt) start();
    else stop();
  }

  function checkNavigation() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    evaluate().catch(() => {});
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local') return;
    if (changes.enabled || changes.cosmetic || changes.allowlist) evaluate().catch(() => {});
  }

  function cleanup() {
    flush();
    if (navigationTimer) { clearInterval(navigationTimer); navigationTimer = null; }
    if (observeTimer) { clearTimeout(observeTimer); observeTimer = null; }
    try { observer?.disconnect(); } catch {}
    observer = null;
    active = false;
    if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  }

  try { chrome.storage.onChanged.addListener(onStorageChanged); } catch {}

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'forceReevaluate') {
      lastHref = location.href;
      evaluate().catch(() => {});
      sendResponse({ ok: true });
    }
  });

  // Handshake from page.js — keep the existing token-based slip-report channel.
  let bmzSecretToken = null;
  document.addEventListener('bmz-handshake', event => {
    if (typeof event.detail === 'string') bmzSecretToken = event.detail;
  });
  if (!bmzSecretToken) {
    const datasetToken = document.documentElement.dataset.bmzToken;
    if (datasetToken) bmzSecretToken = datasetToken;
  }

  try {
    window.addEventListener('message', event => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.__bmz !== 'adSlipped') return;
      if (!bmzSecretToken || data.token !== bmzSecretToken) return;
      if (window.top !== window) return;
      try { chrome.runtime.sendMessage({ type: 'recordSlippedAd', record: data }).catch(() => {}); } catch {}
    });
  } catch {}

  try {
    window.addEventListener('pagehide', flush, { capture: true });
    window.addEventListener('pageshow', () => { lastHref = location.href; evaluate().catch(() => {}); });
  } catch {}

  navigationTimer = setInterval(checkNavigation, NAVIGATION_CHECK_MS);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { evaluate().catch(() => {}); }, { once: true });
  }
  evaluate().catch(() => {});
  window.addEventListener('pagehide', cleanup, { once: true });
})();



