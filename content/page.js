// content/page.js — YouTube ad skipper (main world)
// Fully hardened: handles reloads, SPA transitions, "Sponsored" layouts, 
// diagnostic logging, and prevents black screens on long videos.
(() => {
  if (!/(^|\.)youtube\.com$/.test(location.hostname)) return;

  const AD_SKIP_SELECTORS = [
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button-container button'
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

  const STATE = {
    saved: null, 
    lastAd: false,
    reportTimer: null 
  };

  function isAdActive() {
    const player = document.querySelector('.html5-video-player');
    if (player && player.classList.contains('ad-showing')) return true;

    const badges = document.querySelectorAll(AD_BADGE_SELECTORS);
    for (const b of badges) {
      if (b.offsetParent !== null || b.getClientRects().length) return true;
    }

    if (document.querySelector('.ytp-ad-duration-remaining')) return true;

    // Catch the "Sponsored" layout
    if (player && /(Sponsored|Ad · \d+ of \d+)/i.test(player.textContent)) {
      return true;
    }

    return false;
  }

  function skipAd(video) {
    const skip = document.querySelector(AD_SKIP_SELECTORS);
    if (skip && skip.offsetParent !== null) {
      try { skip.click(); } catch {}
    }

    if (video && Number.isFinite(video.duration) && video.duration > 0) {
      if (!STATE.saved) {
        STATE.saved = { playbackRate: video.playbackRate, muted: video.muted };
      }
      try { video.currentTime = Math.max(video.duration - 0.1, video.currentTime); } catch {}
    }

    if (video) {
      if (!STATE.saved) {
        STATE.saved = { playbackRate: video.playbackRate, muted: video.muted };
      }
      try { video.muted = true; } catch {}
      try { video.playbackRate = 16; } catch {}
    }
  }

  function restore(video) {
    if (!STATE.saved) return;
    
    // INSTANT RESTORE: This prevents the black screen chunks on long videos.
    // It restores speed/volume immediately without waiting 500ms.
    try { video.playbackRate = STATE.saved.playbackRate; } catch {}
    try { video.muted = STATE.saved.muted; } catch {}
    STATE.saved = null;
  }

  function tick() {
    const video = document.querySelector('video.html5-main-video');
    if (!video) { STATE.lastAd = false; return; }

    const ad = isAdActive();

    if (ad) {
      STATE.lastAd = true;
      skipAd(video);

      // Diagnostic Logger: If the ad is still here after 1.5s, record it.
      if (!STATE.reportTimer) {
        STATE.reportTimer = setTimeout(() => {
          STATE.reportTimer = null;
          if (!isAdActive()) return;
          const badge = document.querySelector(AD_BADGE_SELECTORS);
          const whyLink = [...document.querySelectorAll('a')].find(a =>
            /why this ad|about this ad/i.test(a.textContent || ''));
          
          window.postMessage({
            __bmz: 'adSlipped',
            url: location.href,
            signals: {
              adShowing: !!document.querySelector('.html5-video-player.ad-showing'),
              badgeText: badge ? (badge.textContent || '').trim().slice(0, 200) : '',
              whyAdHref: whyLink ? whyLink.href : '',
              skipButtonPresent: !!document.querySelector(AD_SKIP_SELECTORS),
              videoDuration: video && Number.isFinite(video.duration) ? video.duration : null,
              videoCurrentTime: video ? video.currentTime : null
            },
            ts: Date.now()
          }, '*');
        }, 1500);
      }
    } else if (STATE.lastAd) {
      STATE.lastAd = false;
      restore(video);
    }
  }

  // 1. Aggressive Fast Poll on Load/Reload (3 seconds)
  let fastTicks = 0;
  const fastTimer = setInterval(() => {
    tick();
    if (++fastTicks >= 24) clearInterval(fastTimer);
  }, 125);

  // 2. Steady state poll for mid-rolls
  setInterval(tick, 250);

  // 3. SPA Navigation Watcher
  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    
    STATE.saved = null;
    STATE.lastAd = false;
    if (STATE.reportTimer) {
      clearTimeout(STATE.reportTimer);
      STATE.reportTimer = null;
    }

    let n = 0;
    const t = setInterval(() => {
      tick();
      if (++n >= 24) clearInterval(t);
    }, 125);
  }, 500);
})();