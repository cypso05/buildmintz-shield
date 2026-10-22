/* content/page.js — BuildMintZ Shield YouTube Ad Skipper (Hybrid)
 * Main-world script. Secured against spoofing, safe for user pauses.
 */
(() => {
  'use strict';

  if (location.protocol !== 'https:' || !/(^|\.)youtube\.com$/i.test(location.hostname)) {
    return;
  }

  const INSTANCE_KEY = '__bmzYouTubeSkipperV2';
  if (window[INSTANCE_KEY]) return;
  window[INSTANCE_KEY] = true;

  // Generate a random token to secure postMessage communication
  const SECRET_TOKEN = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

  // Send the token to the isolated world (content.js) via a CustomEvent
  document.dispatchEvent(new CustomEvent('bmz-handshake', { detail: SECRET_TOKEN }));

  const PLAYER_SELECTOR = '.html5-video-player';
  const VIDEO_SELECTOR = 'video.html5-main-video';

  const SKIP_SELECTOR = [
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button-container button'
  ].join(',');

  const AD_MARKER_SELECTOR = [
    '.ytp-ad-badge',
    '.ytp-ad-simple-ad-badge',
    '.ytp-ad-text',
    '.ytp-ad-player-overlay-layout',
    '.ytp-ad-module',
    '.ytp-ad-overlay-slot',
    '.ytp-ad-sparkles',
    '.ytp-visit-advertiser-link'
  ].join(',');

  const AD_REMAINING_SELECTOR = '.ytp-ad-duration-remaining';

  const CONFIG = {
    fastPollMs: 100,
    fastPollDurationMs: 3000,
    fallbackPollMs: 500,
    navigationPollMs: 750,
    mutationDebounceMs: 50,
    seekFallbackDelayMs: 500, 
    seekCooldownMs: 5000,
    diagnosticDelayMs: 1500
  };

  let lastHref = location.href;
  let currentVideo = null;
  let adActiveSince = 0;
  let adEpisodeReported = false;
  let seekAttemptedThisEpisode = false;
  let lastSeekAttemptAt = 0;

  let fastPollTimer = null;
  let fastPollStartedAt = 0;
  let mutationDebounceTimer = null;
  let diagnosticTimer = null;

  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    if (element.getClientRects().length === 0) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function getPlayer() { return document.querySelector(PLAYER_SELECTOR); }
  function getVideo() { return document.querySelector(VIDEO_SELECTOR); }

  function getVisibleSkipButton(player) {
    if (!player) return null;
    for (const button of player.querySelectorAll(SKIP_SELECTOR)) {
      if (isVisible(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true') {
        return button;
      }
    }
    return null;
  }

  function getVisibleAdMarker(player) {
    if (!player) return null;
    for (const marker of player.querySelectorAll(AD_MARKER_SELECTOR)) {
      if (isVisible(marker)) return marker;
    }
    return null;
  }

  function inspectAdState() {
    const player = getPlayer();
    if (!player) return { active: false, explicit: false, player: null, video: null, skipButton: null, marker: null };

    const video = getVideo();
    const explicit = player.classList.contains('ad-showing');
    const skipButton = getVisibleSkipButton(player);
    const remaining = player.querySelector(AD_REMAINING_SELECTOR);
    const remainingVisible = isVisible(remaining);
    const marker = getVisibleAdMarker(player);

    if (explicit) return { active: true, explicit: true, player, video, skipButton, marker };

    const corroborated = remainingVisible || (Boolean(skipButton) && Boolean(marker));
    return { active: corroborated, explicit: false, player, video, skipButton, marker };
  }

  function beginAdEpisode() {
    if (adActiveSince) return;
    adActiveSince = Date.now();
    adEpisodeReported = false;
    seekAttemptedThisEpisode = false;
    
    // FIX 1: Reset the cooldown on a new ad episode
    lastSeekAttemptAt = 0; 
    
    clearTimeout(diagnosticTimer);

    diagnosticTimer = setTimeout(() => {
      const state = inspectAdState();
      if (state.active) reportPersistentAd(state);
    }, CONFIG.diagnosticDelayMs);
  }

  function endAdEpisode() {
    if (!adActiveSince) return;
    adActiveSince = 0;
    adEpisodeReported = false;
    seekAttemptedThisEpisode = false;
    clearTimeout(diagnosticTimer);
    diagnosticTimer = null;
  }

  function reportPersistentAd(state) {
    if (adEpisodeReported) return;
    adEpisodeReported = true;

    // FIX 3: Include the secret token to prevent spoofing
    window.postMessage({
      __bmz: 'adSlipped',
      token: SECRET_TOKEN,
      signals: {
        adShowing: Boolean(state.player?.classList.contains('ad-showing')),
        skipButtonPresent: Boolean(state.skipButton),
        adMarkerPresent: Boolean(state.marker),
        videoDuration: Number.isFinite(state.video?.duration) ? state.video.duration : null
      },
      ts: Date.now()
    }, location.origin);
  }

  function tryNativeSkip(state) {
    const button = state.skipButton || getVisibleSkipButton(state.player);
    if (!button) return false;
    try { button.click(); return true; } catch { return false; }
  }

  function trySeekToAvailableEnd(state) {
    const video = state.video;
    if (!state.explicit || !video) return false;
    if (seekAttemptedThisEpisode) return false;

    const now = Date.now();
    if (now - lastSeekAttemptAt < CONFIG.seekCooldownMs) return false;
    if (!adActiveSince) return false;
    if (now - adActiveSince < CONFIG.seekFallbackDelayMs) return false;

    if (!Number.isFinite(video.duration) || video.duration <= 0 || !Number.isFinite(video.currentTime)) return false;

    let seekEnd = NaN;
    try {
      const ranges = video.seekable;
      if (ranges.length > 0) seekEnd = ranges.end(ranges.length - 1);
    } catch { return false; }

    if (!Number.isFinite(seekEnd)) return false;

    const target = Math.min(seekEnd - 0.1, video.duration - 0.1);
    if (!Number.isFinite(target) || target <= video.currentTime + 0.5) return false;

    seekAttemptedThisEpisode = true;
    lastSeekAttemptAt = now;

    try {
      video.currentTime = target;
      return true;
    } catch { return false; }
  }

  function tick() {
    const state = inspectAdState();

    if (!state.video) {
      currentVideo = null;
      endAdEpisode();
      return;
    }

    if (currentVideo !== state.video) {
      currentVideo = state.video;
    }

    if (!state.active) {
      endAdEpisode();
      return;
    }

    beginAdEpisode();

    // FIX 2: The video.play() block has been removed to respect user pauses.

    if (tryNativeSkip(state)) return;
    trySeekToAvailableEnd(state);
  }

  function startFastPolling() {
    clearInterval(fastPollTimer);
    fastPollStartedAt = Date.now();

    fastPollTimer = setInterval(() => {
      tick();
      if (Date.now() - fastPollStartedAt >= CONFIG.fastPollDurationMs) {
        clearInterval(fastPollTimer);
        fastPollTimer = null;
      }
    }, CONFIG.fastPollMs);
  }

  function scheduleTick() {
    if (mutationDebounceTimer !== null) return;
    mutationDebounceTimer = setTimeout(() => {
      mutationDebounceTimer = null;
      tick();
    }, CONFIG.mutationDebounceMs);
  }

  const observer = new MutationObserver(() => {
    scheduleTick();
  });

  function attachObserver() {
    if (!document.documentElement) return;
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'aria-disabled', 'disabled']
    });
  }

  function onNavigation() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    endAdEpisode();
    currentVideo = null;
    startFastPolling();
    scheduleTick();
  }

  document.addEventListener('yt-navigate-finish', onNavigation);
  window.addEventListener('popstate', onNavigation);
  window.addEventListener('hashchange', onNavigation);

  setInterval(() => {
    if (location.href !== lastHref) onNavigation();
  }, CONFIG.navigationPollMs);

  attachObserver();
  startFastPolling();
  setInterval(tick, CONFIG.fallbackPollMs);
  tick();
})();