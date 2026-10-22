// content/page.js — YouTube ad skipper (main world)
// Highly resilient, dynamic, kills static image ads, saves CPU on background tabs.
(() => {
  if (!/(^|\.)youtube\.com$/.test(location.hostname)) return;

  const AD_SKIP_SELECTORS = [
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button-container button',
    '.ytp-ad-overlay-close-button', // NEW: For static image ads
    '.ytp-ad-survey-close-button'   // NEW: For survey ads
  ].join(',');

  const AD_BADGE_SELECTORS = [
    '.ytp-ad-badge',
    '.ytp-ad-simple-ad-badge',
    '.ytp-ad-text',
    '.ytp-ad-player-overlay-layout',
    '.ytp-ad-module',
    '.ytp-ad-overlay-slot',
    '.ytp-ad-sparkles',             
    '.ytp-visit-advertiser-link'    
  ].join(',');

  // Generate a random token to secure postMessage communication
  const SECRET_TOKEN = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  document.dispatchEvent(new CustomEvent('bmz-handshake', { detail: SECRET_TOKEN }));

  let adReported = false;
  let isTabVisible = !document.hidden;
  let steadyInterval = null;

  function isAdActive() {
    const player = document.querySelector('.html5-video-player');
    if (player && player.classList.contains('ad-showing')) return true;

    const badges = document.querySelectorAll(AD_BADGE_SELECTORS);
    for (const b of badges) {
      if (b.offsetParent !== null || b.getClientRects().length) return true;
    }

    if (document.querySelector('.ytp-ad-duration-remaining')) return true;

    // Catch the "Sponsored" text layout dynamically
    if (player && /(Sponsored|Ad · \d+ of \d+)/i.test(player.textContent)) {
      return true;
    }

    return false;
  }

  function tick() {
    const video = document.querySelector('video.html5-main-video');
    const ad = isAdActive();

    if (ad) {
      // 1. FORCE normal speed and sound. 
      if (video && video.playbackRate !== 1) {
        try { video.playbackRate = 1; } catch {}
      }
      if (video && video.muted) {
        try { video.muted = false; } catch {}
      }

      // 2. AGGRESSIVE CLICKING: Click ALL visible skip/close buttons instantly.
      // This handles static image ads where we can't jump the video timeline.
      const buttons = document.querySelectorAll(AD_SKIP_SELECTORS);
      for (const btn of buttons) {
        if (btn.offsetParent !== null && !btn.disabled) {
          try { btn.click(); } catch {}
        }
      }

      // 3. Jump to the end of the ad instantly (if it's a video)
      if (video && Number.isFinite(video.duration) && video.duration > 0) {
        if (video.currentTime < video.duration - 0.5) {
          try { video.currentTime = video.duration; } catch {}
        }
      }

      // 4. Diagnostic Logger (Secured)
      if (!adReported) {
        adReported = true;
        setTimeout(() => {
          if (!isAdActive()) { adReported = false; return; }
          const badge = document.querySelector(AD_BADGE_SELECTORS);
          const whyLink = [...document.querySelectorAll('a')].find(a =>
            /why this ad|about this ad/i.test(a.textContent || ''));
          
          window.postMessage({
            __bmz: 'adSlipped',
            token: SECRET_TOKEN,
            url: location.href,
            signals: {
              adShowing: !!document.querySelector('.html5-video-player.ad-showing'),
              badgeText: badge ? (badge.textContent || '').trim().slice(0, 200) : '',
              whyAdHref: whyLink ? whyLink.href : '',
              skipButtonPresent: buttons.length > 0,
              videoDuration: video ? video.duration : null
            },
            ts: Date.now()
          }, '*');
          adReported = false;
        }, 1500);
      }

    } else {
      // 5. SAFETY NET
      if (video && video.playbackRate !== 1) {
        try { video.playbackRate = 1; } catch {}
      }
    }
  }

  function startSteadyPoll() {
    if (steadyInterval) clearInterval(steadyInterval);
    steadyInterval = setInterval(tick, 250);
  }

  function stopSteadyPoll() {
    if (steadyInterval) {
      clearInterval(steadyInterval);
      steadyInterval = null;
    }
  }

  // 1. Aggressive Fast Poll on Load/Reload (3 seconds)
  let fastTicks = 0;
  const fastTimer = setInterval(() => {
    tick();
    if (++fastTicks >= 24) clearInterval(fastTimer);
  }, 125);

  // 2. Steady state poll (only runs if tab is visible)
  startSteadyPoll();

  // 3. TAB VISIBILITY OPTIMIZATION
  document.addEventListener('visibilitychange', () => {
    isTabVisible = !document.hidden;
    if (isTabVisible) {
      tick(); // Immediately check when you switch back to the tab
      startSteadyPoll();
    } else {
      stopSteadyPoll(); // Pause polling in background tabs to save CPU
    }
  });

  // 4. SPA Navigation Watcher
  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    
    adReported = false;

    // Re-arm fast poll
    let n = 0;
    const t = setInterval(() => {
      tick();
      if (++n >= 24) clearInterval(t);
    }, 125);
  }, 500);
})();