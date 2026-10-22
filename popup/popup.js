/* BuildMintZ Shield — popup controller */

'use strict';

const $ = id => document.getElementById(id);

const state = {
  enabled: true,
  cosmetic: true,
  allowlist: [],
  activeRulesets: [],
  // Updated to the new stat shape
  counts: { page: 0, daily: 0, dom: 0 },
  currentHost: '',
  currentAllowed: false,
  currentTabUrl: '',
  currentTabId: null
};

let renderInProgress = false;
let renderQueued = false;
let refreshTimer = null;

/* ---------- helpers ---------- */

async function callBackground(message) {
  try {
    // Wake up the service worker if it's asleep
    try {
      await chrome.runtime.sendMessage({ type: 'ping' });
    } catch {}

    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    console.error('[BMZ popup]', error);
    return null;
  }
}

async function getActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });
    return tab || null;
  } catch {
    return null;
  }
}

function hostFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function normalizeHost(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().replace(/^www\./, '');
}

function hostMatches(host, entry) {
  const normalizedHost = normalizeHost(host);
  const normalizedEntry = normalizeHost(entry);
  return Boolean(
    normalizedHost &&
    normalizedEntry &&
    (normalizedHost === normalizedEntry || normalizedHost.endsWith(`.${normalizedEntry}`))
  );
}

function setStatusError(message = 'Could not read protection state') {
  $('statusText').textContent = message;
  $('statusSub').textContent = 'Try reopening the popup';
  $('enabled').disabled = true;
  $('allowSite').disabled = true;
}

/* ---------- render ---------- */

async function render() {
  if (renderInProgress) {
    renderQueued = true;
    return;
  }

  renderInProgress = true;

  try {
    do {
      renderQueued = false;

      // 1. Get the active tab first, so we can ask the background for its specific count
      const tab = await getActiveTab();
      state.currentTabId = tab?.id || null;
      state.currentTabUrl = tab?.url || '';
      state.currentHost = hostFromUrl(state.currentTabUrl);

      // 2. Ask background for state AND the counts for this specific tab
      const remote = await callBackground({ 
        type: 'getState',
        tabId: state.currentTabId 
      });

      if (!remote || typeof remote.enabled !== 'boolean') {
        setStatusError();
        return;
      }

      Object.assign(state, remote);
      state.allowlist = Array.isArray(remote.allowlist) ? remote.allowlist : [];
      state.activeRulesets = Array.isArray(remote.activeRulesets) ? remote.activeRulesets : [];
      state.counts = remote.counts || { page: 0, daily: 0, dom: 0 };

      // 3. Update UI Toggle
      const on = state.enabled;
      $('enabled').checked = on;
      $('enabled').disabled = false;
      $('dot').classList.toggle('off', !on);
      $('statusText').textContent = on ? 'Protection is active' : 'Protection is paused';
      $('statusSub').textContent = 'Local browser protection';
      $('statusDetail').textContent = on
        ? 'Known ad and tracking rules enabled'
        : 'Network protection rules are disabled';

      // 4. Update the 3 Stats Boxes
      $('stat-page').textContent = Math.max(0, Number(state.counts.page) || 0).toLocaleString();
      $('stat-today').textContent = Math.max(0, Number(state.counts.daily) || 0).toLocaleString();
      $('stat-dom').textContent = Math.max(0, Number(state.counts.dom) || 0).toLocaleString();

      // 5. Update Site Info & Allowlist Button
      const siteEligible = Boolean(state.currentHost);
      $('siteHost').textContent = siteEligible ? state.currentHost : 'Not a web page';

      state.currentAllowed = siteEligible && state.allowlist.some(entry => hostMatches(state.currentHost, entry));

      const allowButton = $('allowSite');
      allowButton.disabled = !siteEligible;
      allowButton.textContent = !siteEligible
        ? 'Unavailable on this page'
        : state.currentAllowed
          ? 'Remove site exception'
          : 'Allow this site';

      allowButton.classList.toggle('secondary', !state.currentAllowed);
      allowButton.classList.toggle('link', state.currentAllowed);

    } while (renderQueued);
  } catch (error) {
    console.error('[BMZ popup] render failed', error);
    setStatusError('Could not load status');
  } finally {
    renderInProgress = false;
  }
}

/* ---------- events ---------- */

$('enabled').addEventListener('change', async event => {
  const checkbox = event.currentTarget;
  const value = checkbox.checked;

  checkbox.disabled = true;

  const result = await callBackground({ type: 'setEnabled', value });

  if (!result?.ok) {
    checkbox.checked = state.enabled;
    setStatusError('Could not update protection');
    return;
  }

  await render();
});

$('allowSite').addEventListener('click', async () => {
  const host = state.currentHost;
  if (!host) return;

  const wasAllowed = state.currentAllowed;
  const button = $('allowSite');
  button.disabled = true;

  const result = await callBackground({
    type: wasAllowed ? 'removeAllow' : 'addAllow',
    host
  });

  if (!result?.ok) {
    button.disabled = false;
    button.textContent = 'Could not update exception';
    return;
  }

  await render();
});

$('options').addEventListener('click', () => {
  try {
    chrome.runtime.openOptionsPage();
  } catch (error) {
    console.error('[BMZ popup] options page failed', error);
  }
});

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    // When the background script updates daily/page counts, re-render the popup
    if (area === 'local' && (changes.enabled || changes.allowlist || changes.dailyCount || changes.tabCounts || changes.domDaily)) {
      render().catch(() => {});
    }
  });
} catch {}

/* ---------- boot and live updates ---------- */

render().catch(error => {
  console.error('[BMZ popup] startup failed', error);
  setStatusError('Could not load status');
});

// Refresh UI every 1.5 seconds while popup is open to show live counts
refreshTimer = setInterval(async () => {
  if (!state.currentTabId) return;
  
  const remote = await callBackground({ 
    type: 'getState',
    tabId: state.currentTabId 
  });
  
  if (!remote || !remote.counts) return;

  state.counts = remote.counts;
  $('stat-page').textContent = Math.max(0, Number(state.counts.page) || 0).toLocaleString();
  $('stat-today').textContent = Math.max(0, Number(state.counts.daily) || 0).toLocaleString();
  $('stat-dom').textContent = Math.max(0, Number(state.counts.dom) || 0).toLocaleString();
}, 1500);

window.addEventListener('unload', () => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}, { once: true });