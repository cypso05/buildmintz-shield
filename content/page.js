// content/page.js — YouTube ad skipper (main world)
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
  let isExtensionEnabled = true;
  let steadyInterval = null;

  function checkEnabledState() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get({ enabled: true }, (result) => {
        isExtensionEnabled = result.enabled;
      });
    }
  }
  
  checkEnabledState();
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.enabled) {
        isExtensionEnabled = changes.enabled.newValue;
      }
    });
  }

  // 1. Inject CSS to forcibly hide the anti-adblock popup AND its dark background
  function injectAntiAdblockCSS() {
    if (document.getElementById('bmz-anti-adblock-css')) return;
    const style = document.createElement('style');
    style.id = 'bmz-anti-adblock-css';
    style.textContent = `
      ytd-popup-container,
      tp-yt-paper-dialog,
      ytd-enforcement-message-view-model,
      tp-yt-iron-overlay-backdrop {
        display: none !important;
        opacity: 0 !important;
        pointer-events: none !important;
        visibility: hidden !important;
      }
    `;
    if (document.documentElement) {
      document.documentElement.appendChild(style);
    }
  }
  injectAntiAdblockCSS();
  setInterval(injectAntiAdblockCSS, 1000);

  function checkYouTubeBlock() {
    let hasViolationText = false;
    
    function checkText(node) {
      if (hasViolationText) return;
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.textContent && (
            node.textContent.includes("Ad blockers violate YouTube's Terms of Service") ||
            node.textContent.includes("Which of these extensions do you have")
        )) {
          hasViolationText = true;
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.shadowRoot) checkText(node.shadowRoot);
        for (let child of node.childNodes) checkText(child);
      }
    }
    
    if (document.body) checkText(document.body);

    if (hasViolationText) {
      if (!hasLoggedBlock) {
        hasLoggedBlock = true;
        console.warn("[BMZ] Anti-Adblock detected. Destroying popup and forcing play...");
      }

      // BRUTE FORCE: Rip the popup out of the DOM entirely
      document.querySelectorAll('ytd-enforcement-message-view-model, tp-yt-paper-dialog, ytd-popup-container, tp-yt-iron-overlay-backdrop').forEach(el => el.remove());

      // FORCE THE VIDEO TO PLAY
      const video = document.querySelector('video.html5-main-video');
      if (video && video.paused) {
        video.play().catch(() => {});
      }

      // Try clicking any "Allow" button just in case
      document.querySelectorAll('button, tp-yt-paper-button').forEach(btn => {
        const text = (btn.innerText || '').toLowerCase();
        if (text.includes('allow youtube ads') || text === 'allow') {
            btn.click();
        }
      });

      return true;
    }
    
    hasLoggedBlock = false;
    return false;
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

  function tick() {
    if (!isExtensionEnabled) return;
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
          }, '*'); // Using '*' is correct here.
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

  let fastTicks = 0;
  const fastTimer = setInterval(() => {
    tick();
    if (++fastTicks >= 24) clearInterval(fastTimer);
  }, 125);

  startSteadyPoll();

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      tick();
      startSteadyPoll();
    } else {
      stopSteadyPoll();
    }
  });

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