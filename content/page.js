// content/page.js — YouTube ad skipper (main world)
// Highly resilient, dynamic, and avoids black screens / fast-forward glitches.
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

  let adReported = false;

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
    if (!video) return;

    const ad = isAdActive();

    if (ad) {
      // 1. FORCE normal speed and sound. 
      // If YouTube glitched and left it at 16x, this instantly fixes it.
      if (video.playbackRate !== 1) {
        try { video.playbackRate = 1; } catch {}
      }
      if (video.muted) {
        try { video.muted = false; } catch {}
      }

      // 2. Click Skip if visible
      const skip = document.querySelector(AD_SKIP_SELECTORS);
      if (skip && skip.offsetParent !== null) {
        try { skip.click(); } catch {}
      }

      // 3. Jump to the end of the ad instantly.
      // Using currentTime is much safer than 16x speed and prevents black screens.
      if (Number.isFinite(video.duration) && video.duration > 0) {
        if (video.currentTime < video.duration - 0.5) {
          try { video.currentTime = video.duration; } catch {}
        }
      }

      // 4. Diagnostic Logger
      if (!adReported) {
        adReported = true;
        setTimeout(() => {
          if (!isAdActive()) { adReported = false; return; }
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
              videoDuration: video ? video.duration : null
            },
            ts: Date.now()
          }, '*');
          adReported = false;
        }, 1500);
      }

    } else {
      // 5. SAFETY NET: If the ad is gone, ensure the real video is at normal speed.
      if (video.playbackRate !== 1) {
        try { video.playbackRate = 1; } catch {}
      }
    }
  }

  // 1. Aggressive Fast Poll on Load/Reload (3 seconds)
  let fastTicks = 0;
  const fastTimer = setInterval(() => {
    tick();
    if (++fastTicks >= 24) clearInterval(fastTimer);
  }, 125);

  // 2. Steady state poll for mid-rolls on long videos
  setInterval(tick, 250);

  // 3. SPA Navigation Watcher (Catches when you click a new video without reloading)
  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    
    adReported = false;

    // Re-arm the aggressive fast poll for the new video page
    let n = 0;
    const t = setInterval(() => {
      tick();
      if (++n >= 24) clearInterval(t);
    }, 125);
  }, 500);
})();