/* BuildMintZ Shield — cosmetic filtering content script
 *
 * Runs in the ISOLATED world on HTTP(S) pages.
 * Injects CSS to hide ad containers and counts them.
 * Fails silently to avoid interfering with host pages.
 */

(() => {
  'use strict';

  // 1. General Ad Selectors + YouTube Specific Selectors
  const SELECTORS = [
    // General Ad Networks
    'ins.adsbygoogle',
    '[id^="google_ads_"]',
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

    // YouTube Visual Ads (Banners, Sidebars, Feed Ads)
    '#player-ads',
    '#masthead-ad',
    '.ytp-ad-overlay-container',
    '.ytp-ad-text-overlay',
    '.ytp-ad-image-overlay',
    'ytd-display-ad-renderer',
    'ytd-promoted-sparkles-web-renderer',
    'ytd-ad-slot-renderer',
    'ytd-in-feed-ad-layout-renderer',
    'ytd-promoted-video-renderer',

    // YouTube 2024–2026 containers
    '.ytp-ad-player-overlay-layout',
    '.ytp-ad-module',
    '.ytp-ad-overlay-slot',
    '.ytp-suggested-action',
    'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"]',
    'ytd-banner-promo-renderer',
    'ytd-statement-banner-renderer',
    'ytd-compact-promoted-video-renderer',
    'ytd-rich-item-renderer:has(> #content > ytd-ad-slot-renderer)',
    '#player-ads ytd-ad-slot-renderer'
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

  const hostMatches = (host, entry) =>
    host === entry || host.endsWith(`.${entry}`);

  function normalizeHost(value) {
    if (typeof value !== 'string') return null;
    const host = value.trim().toLowerCase().replace(/^www\./, '');
    if (
      !host ||
      host.length > 253 ||
      !host.includes('.') ||
      /[/:@*?#\s\\]/.test(host) ||
      host.startsWith('.') ||
      host.endsWith('.') ||
      host.includes('..')
    ) {
      return null;
    }
    return host;
  }

  async function readState() {
    try {
      return await new Promise(resolve => {
        chrome.storage.local.get(
          { enabled: true, cosmetic: true, allowlist: [] },
          result => {
            if (chrome.runtime.lastError) {
              resolve({ enabled: false, cosmetic: false, allowlist: [] });
              return;
            }
            resolve(result);
          }
        );
      });
    } catch {
      return { enabled: false, cosmetic: false, allowlist: [] };
    }
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const target = document.head || document.documentElement;
    if (!target) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `${SELECTOR} {
      display: none !important;
      visibility: hidden !important;
    }`;
    target.appendChild(style);
  }

  function removeStyle() {
    try {
      document.getElementById(STYLE_ID)?.remove();
    } catch {}
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

          // Self-heal: YouTube SPA replaces <head>, taking our style with it.
          if (!document.getElementById(STYLE_ID)) {
            injectStyle();
          }

          for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
              if (node.nodeType === Node.ELEMENT_NODE) {
                countMatches(node);
              }
            }
          }
        });

        observer.observe(document.documentElement, {
          childList: true,
          subtree: true
        });
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
    try {
      chrome.runtime.sendMessage({
        type: 'cosmeticHidden',
        count
      });
    } catch (e) {
      // Ignore errors if the page is unloading
    }
  }

  function start() {
    if (active) {
      injectStyle();
      scheduleObserve();
      return;
    }

    active = true;
    injectStyle();

    try {
      if (document.documentElement) {
        countMatches(document.documentElement);
      }
    } catch {}

    scheduleObserve();

    if (!flushTimer) {
      flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
    }
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

    // Ignore stale async results if a newer evaluation has started.
    if (currentEvaluation !== evaluationId) return;

    const host = location.hostname.toLowerCase().replace(/^www\./, '');
    const allowlist = Array.isArray(state.allowlist)
      ? state.allowlist.map(normalizeHost).filter(Boolean)
      : [];

    const exempt = allowlist.some(entry => hostMatches(host, entry));

    if (state.enabled && state.cosmetic && !exempt) {
      start();
    } else {
      stop();
    }
  }

  function checkNavigation() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    evaluate().catch(() => {});
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local') return;
    if (changes.enabled || changes.cosmetic || changes.allowlist) {
      evaluate().catch(() => {});
    }
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

  // Listen for the extension being reloaded/updated in Chrome
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'forceReevaluate') {
      lastHref = location.href;
      evaluate().catch(() => {});
      sendResponse({ ok: true });
    }
  });

  // 1. Listen for the secure handshake from page.js
  let bmzSecretToken = null;
  document.addEventListener('bmz-handshake', (event) => {
    if (typeof event.detail === 'string') {
      bmzSecretToken = event.detail;
    }
  });

  // 2. Relay ad-slip diagnostics, strictly verifying the token
  try {
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const data = event.data;
      
      // Verify it's our message AND has the correct token
      if (!data || data.__bmz !== 'adSlipped') return;
      if (!bmzSecretToken || data.token !== bmzSecretToken) return; 
      
      if (window.top !== window) return;
      try {
        chrome.runtime.sendMessage({ type: 'recordSlippedAd', record: data })
          .catch(() => {});
      } catch {}
    });
  } catch {}

  try {
    window.addEventListener('pagehide', flush, { capture: true });
    window.addEventListener('pageshow', () => {
      lastHref = location.href;
      evaluate().catch(() => {});
    });
  } catch {}

  navigationTimer = setInterval(checkNavigation, NAVIGATION_CHECK_MS);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      evaluate().catch(() => {});
    }, { once: true });
  }

  evaluate().catch(() => {});
    window.addEventListener('pagehide', cleanup, { once: true });
})();