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
  let steadyInterval = null;

  // Per-ad seek state.
  // adSeekAttempts: how many times we've tried currentTime = duration for the current ad.
  // lastNonAdAt:   timestamp of the most recent tick where no ad was detected.
  // A pod gap (brief ad -> non-ad -> ad) must not reset these, so we only reset
  // after 2s of continuous non-ad.
  let adSeekAttempts = 0;
  let lastNonAdAt = 0;

  const MAX_SEEK_ATTEMPTS = 40;       // 40 ticks * 250ms = 10s of retrying
  const AD_POD_GAP_MS = 2000;         // sustained non-ad interval before reset

  function isEnabled() {
    return document.documentElement.getAttribute('data-bmz-enabled') !== '0';
  }

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

  // Seek past the current ad. Retries across ticks because:
  //   - video.duration is briefly NaN/0 right after the ad swap
  //   - YouTube can silently discard currentTime writes during transitions
  //   - ad pods reset the player between segments
  function trySkipAd(video) {
    if (!video || adSeekAttempts >= MAX_SEEK_ATTEMPTS) return;
    const dur = video.duration;
    const cur = video.currentTime;
    if (!Number.isFinite(dur) || dur <= 0) return;
    if (!Number.isFinite(cur) || cur >= dur - 0.5) return;
    adSeekAttempts++;
    try { video.currentTime = dur; } catch {}
  }

  function tick() {
    if (!isEnabled()) return;

    ensureAntiAdblockStyle();
    dismissEnforcementPopup();
    hideOverlayAds();

    const ad = isAdActive();
    const video = document.querySelector('video.html5-main-video');

    if (ad) {
      lastNonAdAt = 0;
      clickSkipButtons();
      trySkipAd(video);

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
      // Sustained non-ad only. A single tick of no-ad inside an ad pod must not
      // reset the seek budget, or the next segment of the pod re-seeks from zero.
      if (!lastNonAdAt) lastNonAdAt = Date.now();
      if (Date.now() - lastNonAdAt > AD_POD_GAP_MS) {
        adSeekAttempts = 0;
      }
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
    adSeekAttempts = 0;
    lastNonAdAt = 0;
    let n = 0;
    const t = setInterval(() => { tick(); if (++n >= 24) clearInterval(t); }, 125);
  }, 500);
})();