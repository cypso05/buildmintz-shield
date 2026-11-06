// content/page.js — YouTube ad skipper (MAIN world)
(() => {
  'use strict';
  if (!/(^|\.)youtube\.com$/.test(location.hostname)) return;

  // Bump this string on every shipped change so DevTools can confirm which
  // build is live: document.documentElement.dataset.bmzBuild
  const BUILD_MARKER = '2026-11-06-patches-A+B+build-marker';

  // ---------------- Selectors ----------------
  const SKIP_SELECTORS = [
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button-container button',
    '.ytp-ad-skip-button-slot button',
    '[class*="skip-button"]',
    '[class*="skip-ad"]',
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
  const AD_RATE                  = 16;
  const MAX_SEEK_ATTEMPTS        = 40;
  const SEEK_BUDGET_LONG         = 4;
  const AD_POD_GAP_MS            = 2000;
  const LONG_VIDEO_THRESHOLD_S   = 180;
  const AD_DURATION_MAX_SEEK_S   = 180;
  const STRUCTURAL_GUARD_MS      = 2000;

  const WARMUP_MS                = 5000;
  const ACCEL_MUTE_HOLD_MS       = 900;

  // Stuck-detection grace: if the ad has been "active" for this long AND
  // the video has clearly played through to its duration end, treat as done.
  const STUCK_AD_GRACE_MS        = 2000;

  const SECRET_TOKEN = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  document.documentElement.dataset.bmzToken = SECRET_TOKEN;
  document.documentElement.dataset.bmzBuild = BUILD_MARKER;
  document.dispatchEvent(new CustomEvent('bmz-handshake', { detail: SECRET_TOKEN }));

  // ---------------- State ----------------
  let adReported       = false;
  let steadyInterval   = null;

  let adSeekAttempts   = 0;
  let lastNonAdAt      = 0;
  let mainDuration     = 0;
  let lastNonAdRate    = 1;
  let weAccelerated    = false;
  let acceleratedAt    = 0;
  let lastSeekAt       = 0;
  let lastSeekTarget   = -1;
  let seekWasRejected  = false;
  let adDetectedSince  = 0;    // first tick of the current continuous ad state

  let lastTime         = null;
  let lastDuration     = null;

  let warmupUntil      = Date.now() + WARMUP_MS;
  let muteHoldUntil    = 0;
  let mutedByUs        = false;

  // ---------------- Slip spy (diagnostic) ----------------
  const spy = {
    lastRate: null,
    lastDuration: null,
    lastTime: null,
    lastMuted: false,
    lastAdClass: false,
    lastBadgeCount: 0,
    lastSkipCount: 0,
    lastPostedAt: 0
  };

  // A skip button is "clickable" when it's not disabled and either has layout
  // rects OR lives inside the player (covers shadow-root pre-renders where
  // getClientRects() may report 0 even though the button is active).
  function isClickableSkip(btn) {
    if (!btn) return false;
    if (btn.disabled) return false;
    if (btn.getClientRects().length > 0) return true;
    if (btn.closest('.html5-video-player')) return true;
    return false;
  }

  function hasInteractiveSkipButton() {
    for (const b of document.querySelectorAll(SKIP_SELECTORS)) {
      if (isClickableSkip(b)) return true;
    }
    return false;
  }

  function spyTick(video) {
    if (!video) return;
    const player = document.querySelector('.html5-video-player');
    const interactiveSkip = hasInteractiveSkipButton();
    const snapshot = {
      duration:    Number.isFinite(video.duration)    ? video.duration    : null,
      currentTime: Number.isFinite(video.currentTime) ? video.currentTime : null,
      playbackRate: video.playbackRate,
      muted:       video.muted,
      paused:      video.paused,
      adShowing:   !!(player && player.classList.contains('ad-showing')),
      badgeCount:  document.querySelectorAll(AD_BADGE_SELECTORS).length,
      skipBtnCount:document.querySelectorAll(SKIP_SELECTORS).length,
      interactiveSkip,
      adDurationEl:!!document.querySelector('.ytp-ad-duration-remaining')
    };

    const anomalies = [];

    if (spy.lastRate === AD_RATE && snapshot.playbackRate !== AD_RATE) {
      anomalies.push('rate_reset_by_youtube');
    }
    if (spy.lastDuration != null && snapshot.duration != null &&
        Math.abs(snapshot.duration - spy.lastDuration) > 5) {
      anomalies.push(`duration_change:${spy.lastDuration.toFixed(1)}->${snapshot.duration.toFixed(1)}`);
    }
    if (spy.lastTime != null && snapshot.currentTime != null &&
        snapshot.currentTime - spy.lastTime > 3) {
      anomalies.push(`forward_jump:${spy.lastTime.toFixed(1)}->${snapshot.currentTime.toFixed(1)}`);
    }
    if (spy.lastTime != null && snapshot.currentTime != null &&
        spy.lastTime - snapshot.currentTime > 1.5) {
      anomalies.push(`rewind:${spy.lastTime.toFixed(1)}->${snapshot.currentTime.toFixed(1)}`);
    }
    if (spy.lastMuted !== snapshot.muted && Date.now() > muteHoldUntil) {
      anomalies.push(`mute:${spy.lastMuted}->${snapshot.muted}`);
    }
    if (snapshot.adShowing !== spy.lastAdClass) {
      anomalies.push(`ad_class:${spy.lastAdClass}->${snapshot.adShowing}`);
    }

    // Tightened: only fire when the button is actually interactive.
    if (interactiveSkip && spy.lastSkipCount === 0) {
      anomalies.push('skip_button_appeared');
    }

    if (anomalies.length && Date.now() - spy.lastPostedAt > 1000) {
      spy.lastPostedAt = Date.now();
      try {
        window.postMessage({
          __bmz: 'adSlipped',
          kind: 'anomaly',
          token: SECRET_TOKEN,
          url: location.href,
          signals: {
            kind: 'anomaly',
            anomalies,
            longVideo: isLongVideo(video),
            mainDuration,
            videoState: snapshot
          },
          ts: Date.now()
        }, '*');
      } catch {}
    }

    spy.lastRate       = snapshot.playbackRate;
    spy.lastDuration   = snapshot.duration;
    spy.lastTime       = snapshot.currentTime;
    spy.lastMuted      = snapshot.muted;
    spy.lastAdClass    = snapshot.adShowing;
    spy.lastBadgeCount = snapshot.badgeCount;
    spy.lastSkipCount  = interactiveSkip ? 1 : 0;
  }

  // ---------------- Basic helpers ----------------
  function isEnabled() {
    return document.documentElement.getAttribute('data-bmz-enabled') !== '0';
  }

  function isLongVideo(video) {
    if (mainDuration > LONG_VIDEO_THRESHOLD_S) return true;
    if (video && Number.isFinite(video.duration) && video.duration > LONG_VIDEO_THRESHOLD_S) return true;
    return false;
  }

  function inWarmup() {
    return Date.now() < warmupUntil;
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
      if (!isClickableSkip(btn)) continue;
      try { btn.click(); } catch {}
    }
  }

  // ---------------- Detection ----------------
  function detectAd(video, longVideo) {
    const player = document.querySelector('.html5-video-player');
    let isAd = false;

    if (player && player.classList.contains('ad-showing')) {
      isAd = true;
    } else {
      for (const badge of document.querySelectorAll(AD_BADGE_SELECTORS)) {
        if (badge.offsetParent !== null || badge.getClientRects().length) { isAd = true; break; }
      }
      if (!isAd && document.querySelector('.ytp-ad-duration-remaining')) isAd = true;
      if (!isAd && player && /(Sponsored|Ad · \d+ of \d+)/i.test(player.textContent || '')) isAd = true;

      if (!isAd && longVideo && video && lastTime !== null && lastDuration !== null) {
        const rewound         = Number.isFinite(video.currentTime) && video.currentTime + 1.5 < lastTime;
        const durationChanged = Number.isFinite(video.duration) && Math.abs(video.duration - lastDuration) > 1;
        if (rewound && durationChanged && Date.now() - acceleratedAt > STRUCTURAL_GUARD_MS) {
          return { ad: true, viaStructural: true };
        }
      }
    }

    if (isAd) {
      // Track start of continuous ad state
      if (!adDetectedSince) adDetectedSince = Date.now();

      // Stuck heuristic: the ad has been "active" for a while AND the player
      // has clearly played through to the end of the current timeline.
      if (adDetectedSince && Date.now() - adDetectedSince > STUCK_AD_GRACE_MS &&
          video && Number.isFinite(video.duration) && Number.isFinite(video.currentTime) &&
          video.currentTime >= video.duration - 0.5) {
        adDetectedSince = 0;
        return { ad: false, viaStructural: false, viaStuckHeuristic: true };
      }

      return { ad: true, viaStructural: false };
    }

    // Not an ad — reset the continuous-ad tracker.
    adDetectedSince = 0;
    return { ad: false, viaStructural: false };
  }

  // ---------------- Rate helpers (silent accel) ----------------
  function canAccelerate() {
    if (inWarmup()) return false;
    if (mainDuration === 0) return false;
    return true;
  }

  function accelerateAd(video) {
    if (!video) return;
    if (!canAccelerate()) return;

    if (video.playbackRate !== AD_RATE) {
      try { video.playbackRate = AD_RATE; } catch {}
    }
    weAccelerated = true;
    acceleratedAt = Date.now();

    muteHoldUntil = Date.now() + ACCEL_MUTE_HOLD_MS;
    if (!video.muted) {
      try { video.muted = true; mutedByUs = true; } catch {}
    }
  }

  function restoreRate(video) {
    if (!video) return;

    if (mutedByUs && Date.now() > muteHoldUntil) {
      try { video.muted = false; } catch {}
      mutedByUs = false;
    }
    if (weAccelerated && video.playbackRate === AD_RATE) {
      try { video.playbackRate = lastNonAdRate || 1; } catch {}
      weAccelerated = false;
    }
  }

  // ---------------- Seek logic ----------------
  function issueSeek(video, target) {
    if (!video) return false;
    try { video.currentTime = target; } catch { return false; }
    lastSeekAt = Date.now();
    lastSeekTarget = target;
    seekWasRejected = false;
    return true;
  }

  function trySkipAd(video, longVideo, viaStructural) {
    if (!video) return;

    const dur = video.duration;
    const cur = video.currentTime;
    if (!Number.isFinite(dur) || dur <= 0) return;
    if (!Number.isFinite(cur) || cur >= dur - 0.5) return;

    if (lastSeekAt && Date.now() - lastSeekAt > 300 &&
        lastSeekTarget > 0 && cur < lastSeekTarget - 1) {
      seekWasRejected = true;
    }

    if (mainDuration === 0 || inWarmup()) {
      if (adSeekAttempts < MAX_SEEK_ATTEMPTS) {
        adSeekAttempts++;
        issueSeek(video, dur);
      }
      return;
    }

    const looksLikeAdTimeline = dur < mainDuration - 5 && dur <= AD_DURATION_MAX_SEEK_S;

    if (looksLikeAdTimeline) {
      const budget = longVideo ? SEEK_BUDGET_LONG : MAX_SEEK_ATTEMPTS;
      if (adSeekAttempts < budget) {
        adSeekAttempts++;
        issueSeek(video, dur);
        return;
      }
      if (longVideo && seekWasRejected) accelerateAd(video);
      return;
    }

    if (longVideo) {
      if (viaStructural && seekWasRejected) {
        accelerateAd(video);
        return;
      }
      if (adSeekAttempts < SEEK_BUDGET_LONG) {
        adSeekAttempts++;
        return;
      }
      if (seekWasRejected) accelerateAd(video);
    }
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

        // Snapshot tool availability AT DETECTION TIME.
        const snap = {
          skipButtonPresent: hasInteractiveSkipButton(),
          seekIssued:        adSeekAttempts > 0,
          accelAttempted:    weAccelerated === true
        };

        setTimeout(() => {
          const v = document.querySelector('video.html5-main-video');
          if (!detectAd(v, isLongVideo(v)).ad) {
            adReported = false;
            return;  // ad resolved itself; not a slip
          }

          const skipStillPresent = hasInteractiveSkipButton();
          const accelStillActive = !!(v && v.playbackRate === AD_RATE);

          const toolAttemptedAndFailed =
            (snap.skipButtonPresent && skipStillPresent) ||
            seekWasRejected ||
            (snap.accelAttempted && !accelStillActive);

          if (!toolAttemptedAndFailed) {
            // Inherently unskippable; not a failure.
            adReported = false;
            return;
          }

          const kind = seekWasRejected
            ? 'seek_rejected'
            : (snap.skipButtonPresent && skipStillPresent)
              ? 'skip_click_failed'
              : 'accel_failed';

          const badge = document.querySelector(AD_BADGE_SELECTORS);
          try {
            window.postMessage({
              __bmz: 'adSlipped',
              kind,
              token: SECRET_TOKEN,
              url: location.href,
              signals: {
                kind,
                adShowing: !!document.querySelector('.html5-video-player.ad-showing'),
                badgeText: badge ? (badge.textContent || '').trim().slice(0, 200) : '',
                skipButtonPresent: skipStillPresent,
                skipButtonWasPresentAtStart: snap.skipButtonPresent,
                videoDuration: v ? v.duration : null,
                longVideo,
                viaStructural,
                accelerated: accelStillActive,
                accelAttempted: snap.accelAttempted,
                seekIssued: snap.seekIssued,
                seekRejected: seekWasRejected
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

    spyTick(video);
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

    adReported      = false;
    adSeekAttempts  = 0;
    lastNonAdAt     = 0;
    mainDuration    = 0;
    lastNonAdRate   = 1;
    weAccelerated   = false;
    acceleratedAt   = 0;
    lastSeekAt      = 0;
    lastSeekTarget  = -1;
    seekWasRejected = false;
    adDetectedSince = 0;
    lastTime        = null;
    lastDuration    = null;
    mutedByUs       = false;
    muteHoldUntil   = 0;

    warmupUntil = Date.now() + WARMUP_MS;

    let n = 0;
    const t = setInterval(() => { tick(); if (++n >= 24) clearInterval(t); }, 125);
  }, 500);
})();