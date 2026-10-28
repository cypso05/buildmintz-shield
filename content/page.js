// content/page.js — YouTube ad skipper (main world)
// Added: Toggle awareness, Anti-Adblock logging, CPU Saving.
(() => {
  if (!/(^|\.)youtube\.com$/.test(location.hostname)) return;

  const AD_SKIP_SELECTORS = [
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button-container button',
    '.ytp-ad-overlay-close-button',
    '.ytp-ad-survey-close-button'
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

  const SECRET_TOKEN = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  document.dispatchEvent(new CustomEvent('bmz-handshake', { detail: SECRET_TOKEN }));

  let adReported = false;
  let hasLoggedBlock = false;
  let isExtensionEnabled = true; // Default to true until storage says otherwise
  let steadyInterval = null;

  // 1. CHECK EXTENSION TOGGLE STATE
  // We need to read chrome.storage directly to know if the user turned it off.
  function checkEnabledState() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get({ enabled: true }, (result) => {
        isExtensionEnabled = result.enabled;
      });
    }
  }
  
  // Check immediately, then listen for changes (when user clicks toggle)
  checkEnabledState();
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.enabled) {
        isExtensionEnabled = changes.enabled.newValue;
        console.log(`[BMZ] Extension toggled: ${isExtensionEnabled ? 'ON' : 'OFF'}`);
      }
    });
  }

  function isAdActive() {
    const player = document.querySelector('.html5-video-player');
    if (player && player.classList.contains('ad-showing')) return true;

    const badges = document.querySelectorAll(AD_BADGE_SELECTORS);
    for (const b of badges) {
      if (b.offsetParent !== null || b.getClientRects().length) return true;
    }

    if (document.querySelector('.ytp-ad-duration-remaining')) return true;
    if (player && /(Sponsored|Ad · \d+ of \d+)/i.test(player.textContent)) return true;

    return false;
  }

  // 2. ANTI-ADBLOCK DETECTION AND LOGGING
  function checkYouTubeBlock() {
    let popup = document.querySelector('ytd-enforcement-message-view-model');
    if (!popup) popup = document.querySelector('tp-yt-paper-dialog');
    if (!popup) popup = document.querySelector('ytd-popup-container');
    
    const bodyText = document.body.innerText || '';
    const hasViolationText = bodyText.includes("Ad blockers violate YouTube's Terms of Service");

    if ((popup && popup.offsetParent !== null) || hasViolationText) {
      if (!hasLoggedBlock) {
        hasLoggedBlock = true;
        
        // Log to Browser Console for debugging
        console.warn("========================================");
        console.warn("[BMZ] ANTI-ADBLOCK DETECTED BY YOUTUBE");
        console.warn("Reason:", popup ? "Popup Element Found" : "Text Detected");
        if (popup) {
          console.log("DOM Dump of Popup:", popup.outerHTML.substring(0, 1500));
          const buttons = popup.querySelectorAll('button, tp-yt-paper-button');
          buttons.forEach((btn, i) => {
            console.log(`Button ${i}:`, btn.innerText, btn.className);
          });
        }
        console.warn("========================================");

        // Send to background script for the diagnostics page
        window.postMessage({
          __bmz: 'adSlipped',
          token: SECRET_TOKEN,
          url: location.href,
          signals: {
            antiAdblockDetected: true,
            reason: popup ? "Popup Element Found" : "Text Detected",
            domSnippet: popup ? popup.outerHTML.substring(0, 500) : "No element, text only."
          },
          ts: Date.now()
        }, '*');
      }
      return true;
    }
    hasLoggedBlock = false;
    return false;
  }

  function tick() {
    // If toggle is OFF, do absolutely nothing.
    if (!isExtensionEnabled) return;

    // If YouTube's anti-adblock is visible, stop skipping so we don't trip it harder.
    if (checkYouTubeBlock()) return;

    const video = document.querySelector('video.html5-main-video');
    const ad = isAdActive();

    if (ad) {
      if (video && video.playbackRate !== 1) try { video.playbackRate = 1; } catch {}
      if (video && video.muted) try { video.muted = false; } catch {}

      const buttons = document.querySelectorAll(AD_SKIP_SELECTORS);
      for (const btn of buttons) {
        if (btn.offsetParent !== null && !btn.disabled) try { btn.click(); } catch {}
      }

      if (video && Number.isFinite(video.duration) && video.duration > 0) {
        if (video.currentTime < video.duration - 0.5) try { video.currentTime = video.duration; } catch {}
      }

      if (!adReported) {
        adReported = true;
        setTimeout(() => {
          if (!isAdActive()) { adReported = false; return; }
          const badge = document.querySelector(AD_BADGE_SELECTORS);
          window.postMessage({
            __bmz: 'adSlipped',
            token: SECRET_TOKEN,
            url: location.href,
            signals: {
              adShowing: !!document.querySelector('.html5-video-player.ad-showing'),
              badgeText: badge ? (badge.textContent || '').trim().slice(0, 200) : '',
              skipButtonPresent: buttons.length > 0,
              videoDuration: video ? video.duration : null
            },
            ts: Date.now()
          }, '*');
          adReported = false;
        }, 1500);
      }

    } else {
      if (video && video.playbackRate !== 1) try { video.playbackRate = 1; } catch {}
    }
  }

  function startSteadyPoll() {
    if (steadyInterval) clearInterval(steadyInterval);
    steadyInterval = setInterval(tick, 250);
  }

  function stopSteadyPoll() {
    if (steadyInterval) { clearInterval(steadyInterval); steadyInterval = null; }
  }

  // Aggressive Fast Poll on Load
  let fastTicks = 0;
  const fastTimer = setInterval(() => {
    tick();
    if (++fastTicks >= 24) clearInterval(fastTimer);
  }, 125);

  // Steady state poll
  startSteadyPoll();

  // Pause when tab is hidden to save CPU
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      tick();
      startSteadyPoll();
    } else {
      stopSteadyPoll();
    }
  });

  // SPA Navigation Watcher
  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    adReported = false;
    hasLoggedBlock = false;

    let n = 0;
    const t = setInterval(() => {
      tick();
      if (++n >= 24) clearInterval(t);
    }, 125);
  }, 500);
})();