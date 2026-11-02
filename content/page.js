// content/page.js — YouTube ad skipper (MAIN world)
(() => {
  'use strict';
  if (!/(^|\.)youtube\.com$/.test(location.hostname)) return;

  const SKIP_SELECTORS = [
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button-container button',
    '.ytp-ad-overlay-close-button',
    '.ytp-ad-survey-close-button',
    // "Next" on survey / overlay carousel (fallback only; CSS hide is primary)
    '.ytp-ad-survey-next-button',
    '.ytp-ad-overlay-next-button'
  ].join(',');

  const AD_BADGE_SELECTORS = [
    '.ytp-ad-badge',
    '.ytp-ad-simple-ad-badge',
    '.ytp-ad-text',
    '.ytp-ad-player-overlay-layout',
    '.ytp-ad-module',
    '.ytp-ad-overlay-slot',
    '.ytp-ad-overlay-container',
    '.ytp-ad-image-overlay',
    '.ytp-ad-survey',
    '.ytp-ad-sparkles',
    '.ytp-visit-advertiser-link'
  ].join(',');

  // Elements we forcibly hide inline (beats YouTube's !important via inline specificity).
  const OVERLAY_SELECTORS = [
    '.ytp-ad-overlay-container',
    '.ytp-ad-overlay-slot',
    '.ytp-ad-image-overlay',
    '.ytp-ad-text-overlay',
    '.ytp-ad-survey',
    '.ytp-ad-survey-container',
    '.ytp-ad-overlay-ad-info-dialog-container',
    '.ytp-ad-overlay-ad-info-button-container',
    '.ytp-ad-overlay-close-container',
    '.ytp-ad-player-overlay-layout'
  ].join(',');

  const ENFORCEMENT_SELECTOR = 'ytd-enforcement-message-view-model';

  const SECRET_TOKEN = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  document.documentElement.dataset.bmzToken = SECRET_TOKEN;
  document.dispatchEvent(new CustomEvent('bmz-handshake', { detail: SECRET_TOKEN }));

  let adReported = false;
  let adSkipIssuedForCurrentAd = false;
  let steadyInterval = null;

  // Enabled flag is written by content.js onto <html data-bmz-enabled>. Safe default = on.
  function isEnabled() {
    return document.documentElement.getAttribute('data-bmz-enabled') !== '0';
  }

  // Only hide the enforcement popup; never hide generic popups/backdrops.
  function ensureAntiAdblockStyle() {
    if (document.getElementById('bmz-anti-adblock-css')) return;
    const style = document.createElement('style');
    style.id = 'bmz-anti-adblock-css';
    style.textContent = `
      ytd-enforcement-message-view-model { display: none !important; }
      ytd-popup-container:has(> ytd-enforcement-message-view-model) { display: none !important; }
    `;
    document.documentElement.appendChild(style);
  }

  function isAdActive() {
    const player = document.querySelector('.html5-video-player');
    if (player && player.classList.contains('ad-showing')) return true;
    for (const badge of document.querySelectorAll(AD_BADGE_SELECTORS)) {
      if (badge.offsetParent !== null || badge.getClientRects().length) return true;
    }
    if (document.querySelector('.ytp-ad-duration-remaining')) return true;
    if (player && /(Sponsored|Ad · \d+ of \d+)/i.test(player.textContent || '')) return true;
    return false;
  }

  // Hide image overlay ads inline. Inline !important wins over external !important.
  function hideOverlayAds() {
    for (const el of document.querySelectorAll(OVERLAY_SELECTORS)) {
      if (el.style.getPropertyValue('display') !== 'none') {
        try { el.style.setProperty('display', 'none', 'important'); } catch {}
      }
    }
  }

  function dismissEnforcementPopup() {
    const popups = document.querySelectorAll(ENFORCEMENT_SELECTOR);
    if (!popups.length) return false;
    const toRemove = new Set();
    for (const popup of popups) {
      const dialog = popup.closest('tp-yt-paper-dialog');
      const container = popup.closest('ytd-popup-container');
      if (dialog) toRemove.add(dialog);
      if (container) toRemove.add(container);
      try { popup.remove(); } catch {}
    }
    for (const node of toRemove) {
      const prev = node.previousElementSibling;
      if (prev && prev.tagName === 'TP-YT-IRON-OVERLAY-BACKDROP') {
        try { prev.remove(); } catch {}
      }
      try { node.remove(); } catch {}
    }
    const video = document.querySelector('video.html5-main-video');
    if (video && video.paused) try { video.play().catch(() => {}); } catch {}
    return true;
  }

  function clickSkipButtons() {
    for (const btn of document.querySelectorAll(SKIP_SELECTORS)) {
      if (btn.disabled) continue;
      if (btn.offsetParent === null && btn.getClientRects().length === 0) continue;
      try { btn.click(); } catch {}
    }
  }

  function tick() {
    if (!isEnabled()) return;

    ensureAntiAdblockStyle();
    dismissEnforcementPopup();
    hideOverlayAds();

    const ad = isAdActive();
    const video = document.querySelector('video.html5-main-video');

    if (ad) {
      clickSkipButtons();

      // Jump past the ad once. Never touch playbackRate or muted — both are
      // user-controlled and both are detection signals.
      if (!adSkipIssuedForCurrentAd && video &&
          Number.isFinite(video.duration) && video.duration > 0 &&
          video.currentTime < video.duration - 0.5) {
        adSkipIssuedForCurrentAd = true;
        try { video.currentTime = video.duration; } catch {}
      }

      if (!adReported) {
        adReported = true;
        setTimeout(() => {
          if (!isAdActive()) { adReported = false; return; }
          const badge = document.querySelector(AD_BADGE_SELECTORS);
          try {
            window.postMessage({
              __bmz: 'adSlipped',
              token: SECRET_TOKEN,
              url: location.href,
              signals: {
                adShowing: !!document.querySelector('.html5-video-player.ad-showing'),
                badgeText: badge ? (badge.textContent || '').trim().slice(0, 200) : '',
                skipButtonPresent: document.querySelectorAll(SKIP_SELECTORS).length > 0,
                videoDuration: video ? video.duration : null
              },
              ts: Date.now()
            }, '*');
          } catch {}
          adReported = false;
        }, 1500);
      }
    } else {
      adSkipIssuedForCurrentAd = false;
    }
  }

  function startPoll() { if (!steadyInterval) steadyInterval = setInterval(tick, 250); }
  function stopPoll()  { if (steadyInterval) { clearInterval(steadyInterval); steadyInterval = null; } }

  let fastTicks = 0;
  const fastTimer = setInterval(() => {
    tick();
    if (++fastTicks >= 24) clearInterval(fastTimer);
  }, 125);

  startPoll();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPoll();
    else { tick(); startPoll(); }
  });

  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    adReported = false;
    adSkipIssuedForCurrentAd = false;
    let n = 0;
    const t = setInterval(() => { tick(); if (++n >= 24) clearInterval(t); }, 125);
  }, 500);
})();