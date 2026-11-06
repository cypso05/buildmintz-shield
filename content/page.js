// content/page.js — YouTube ad skipper (MAIN world)
(() => {
  'use strict';
  if (!/(^|\.)youtube\.com$/.test(location.hostname)) return;

  // ---------------- Selectors (unchanged) ----------------
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

  // ---------------- Config ----------------
  const AD_RATE                = 16;    // long-video fallback only
  const MAX_SEEK_ATTEMPTS      = 40;    // pre-roll + shorts
  const SEEK_BUDGET_LONG       = 4;     // ~1s of seek attempts before accel on long mid-rolls
  const AD_POD_GAP_MS          = 2000;
  const LONG_VIDEO_THRESHOLD_S = 180;
  const AD_DURATION_MAX_SEEK_S = 180;
  const STRUCTURAL_GUARD_MS    = 2000;  // don't trust structural signal for 2s after we accel (prevents ad-end false positive)

  const SECRET_TOKEN = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  document.documentElement.dataset.bmzToken = SECRET_TOKEN;
  document.dispatchEvent(new CustomEvent('bmz-handshake', { detail: SECRET_TOKEN }));

  // ---------------- State ----------------
  let adReported     = false;
  let steadyInterval = null;

  let adSeekAttempts = 0;
  let lastNonAdAt    = 0;
  let mainDuration   = 0;
  let lastNonAdRate  = 1;
  let weAccelerated  = false;
  let acceleratedAt  = 0;

  let lastTime       = null;  // previous tick's currentTime
  let lastDuration   = null;  // previous tick's duration

  function isEnabled() {
    return document.documentElement.getAttribute('data-bmz-enabled') !== '0';
  }

  function isLongVideo(video) {
    if (mainDuration > LONG_VIDEO_THRESHOLD_S) return true;
    if (video && Number.isFinite(video.duration) && video.duration > LONG_VIDEO_THRESHOLD_S) return true;
    return false;
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

  // ---------------- Detection ----------------
  // Returns { ad, viaStructural }. `viaStructural` tells the caller the ad was
  // detected ONLY via the structural signal — this matters because structural
  // detection on its own should never accelerate a short video.
  function detectAd(video, longVideo) {
    const player = document.querySelector('.html5-video-player');
    if (player && player.classList.contains('ad-showing')) return { ad: true, viaStructural: false };

    for (const badge of document.querySelectorAll(AD_BADGE_SELECTORS)) {
      if (badge.offsetParent !== null || badge.getClientRects().length) return { ad: true, viaStructural: false };
    }
    if (document.querySelector('.ytp-ad-duration-remaining')) return { ad: true, viaStructural: false };
    if (player && /(Sponsored|Ad · \d+ of \d+)/i.test(player.textContent || '')) return { ad: true, viaStructural: false };

    // Structural signal — ONLY for long videos. Catches mid-rolls where
    // YouTube never toggles .ad-showing and never changes duration away from
    // the content timeline (the case that was slipping through).
    if (longVideo && video && lastTime !== null && lastDuration !== null) {
      const rewound         = Number.isFinite(video.currentTime) && video.currentTime + 1.5 < lastTime;
      const durationChanged = Number.isFinite(video.duration) && Math.abs(video.duration - lastDuration) > 1;
      if (rewound && durationChanged) {
        // Ignore right after we ourselves accelerated — the ad→content swap
        // also rewinds + changes duration and would otherwise false-positive.
        if (Date.now() - acceleratedAt > STRUCTURAL_GUARD_MS) {
          return { ad: true, viaStructural: true };
        }
      }
    }

    return { ad: false, viaStructural: false };
  }

  // ---------------- Rate helpers (fallback only) ----------------
  function accelerateAd(video) {
    if (!video) return;
    if (video.playbackRate === AD_RATE) { weAccelerated = true; acceleratedAt = Date.now(); return; }
    try { video.playbackRate = AD_RATE; } catch {}
    weAccelerated = true;
    acceleratedAt = Date.now();
  }

  function restoreRate(video) {
    if (!video || !weAccelerated) return;
    try { video.playbackRate = lastNonAdRate || 1; } catch {}
    weAccelerated = false;
  }

  // ---------------- Seek logic ----------------
  function trySkipAd(video, longVideo, viaStructural) {
    if (!video) return;

    const dur = video.duration;
    const cur = video.currentTime;
    if (!Number.isFinite(dur) || dur <= 0) return;
    if (!Number.isFinite(cur) || cur >= dur - 0.5) return;

    // Pre-roll: no content seen yet. Seek only.
    if (mainDuration === 0) {
      if (adSeekAttempts < MAX_SEEK_ATTEMPTS) {
        adSeekAttempts++;
        try { video.currentTime = dur; } catch {}
      }
      return;
    }

    // Mid-roll with a *provably separate* ad timeline → seek.
    const looksLikeAdTimeline = dur < mainDuration - 5 && dur <= AD_DURATION_MAX_SEEK_S;

    if (looksLikeAdTimeline) {
      const budget = longVideo ? SEEK_BUDGET_LONG : MAX_SEEK_ATTEMPTS;
      if (adSeekAttempts < budget) {
        adSeekAttempts++;
        try { video.currentTime = dur; } catch {}
        return;
      }
      if (longVideo) accelerateAd(video);
      return;
    }

    // Mid-roll that is NOT a separate timeline (SSAI / duration kept as content).
    // This is the case that was slipping through — seek can't help here (dur is
    // the content length, seeking would skip the whole video), so accelerate.
    if (longVideo) {
      // If detection was structural-only, accelerate right away — this is the
      // exact scenario that regressed.
      if (viaStructural) {
        accelerateAd(video);
        return;
      }
      // Regular ad signals but no ad timeline → still accelerate after budget.
      if (adSeekAttempts < SEEK_BUDGET_LONG) {
        adSeekAttempts++;
        return;
      }
      accelerateAd(video);
    }
    // Short videos with no separate ad timeline: do nothing (can't seek safely).
  }

  // ---------------- Tick ----------------
  function tick() {
    if (!isEnabled()) return;

    ensureAntiAdblockStyle();
    dismissEnforcementPopup();
    hideOverlayAds();

    const video = document.querySelector('video.html5-main-video');
    const longVideo = isLongVideo(video);
    const { ad, viaStructural } = detectAd(video, longVideo);

    if (ad) {
      lastNonAdAt = 0;
      clickSkipButtons();
      trySkipAd(video, longVideo, viaStructural);

      if (!adReported) {
        adReported = true;
        setTimeout(() => {
          const v = document.querySelector('video.html5-main-video');
          if (!detectAd(v, isLongVideo(v)).ad) { adReported = false; return; }
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
                videoDuration: v ? v.duration : null,
                longVideo,
                viaStructural
              },
              ts: Date.now()
            }, '*');
          } catch {}
          adReported = false;
        }, 1500);
      }
    } else {
      restoreRate(video);

      if (video && Number.isFinite(video.playbackRate) &&
          video.playbackRate > 0 && video.playbackRate !== AD_RATE) {
        lastNonAdRate = video.playbackRate;
      }

      if (video && Number.isFinite(video.duration) && video.duration > 0) {
        if (video.duration > mainDuration) mainDuration = video.duration;
      }

      if (!lastNonAdAt) lastNonAdAt = Date.now();
      if (Date.now() - lastNonAdAt > AD_POD_GAP_MS) adSeekAttempts = 0;
    }

    if (video) {
      lastTime     = Number.isFinite(video.currentTime) ? video.currentTime : null;
      lastDuration = Number.isFinite(video.duration) ? video.duration : null;
    }
  }

  // ---------------- Lifecycle ----------------
  function startPoll() { if (!steadyInterval) steadyInterval = setInterval(tick, 250); }
  function stopPoll()  { if (steadyInterval) { clearInterval(steadyInterval); steadyInterval = null; } }

  let fastTicks = 0;
  const fastTimer = setInterval(() => {
    tick();
    if (++fastTicks >= 24) clearInterval(fastTimer);
  }, 125);

  startPoll();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      const v = document.querySelector('video.html5-main-video');
      if (!isLongVideo(v)) stopPoll();
    } else {
      tick();
      startPoll();
    }
  });

  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    adReported     = false;
    adSeekAttempts = 0;
    lastNonAdAt    = 0;
    mainDuration   = 0;
    lastNonAdRate  = 1;
    weAccelerated  = false;
    acceleratedAt  = 0;
    lastTime       = null;
    lastDuration   = null;
    let n = 0;
    const t = setInterval(() => { tick(); if (++n >= 24) clearInterval(t); }, 125);
  }, 500);
})();