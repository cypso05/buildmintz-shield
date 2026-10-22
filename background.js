/* BuildMintZ Shield — background service worker (MV3) */

'use strict';

const SCHEMA_VERSION = 2;
const RULESET_IDS = Object.freeze(['ads', 'trackers', 'security']);
const ALLOW_RULE_BASE = 100000;
const ALLOW_RULE_MAX = 4500;
const EXTENSION_ORIGIN = chrome.runtime.getURL('');

const DEFAULTS = Object.freeze({
  enabled: true,
  cosmetic: true,
  allowlist: [],
  schemaVersion: SCHEMA_VERSION
});

const ALLOW_RULE_RESOURCE_TYPES = Object.freeze([
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
  'object', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other'
]);

/* ---------- serialized operation queues ---------- */
function createQueue(label) {
  let tail = Promise.resolve();
  return function enqueue(operation) {
    const next = tail.then(operation);
    tail = next.catch(error => console.error(`[BMZ] ${label} failed`, error));
    return next;
  };
}

const runRuleset = createQueue('ruleset operation');
const runAllowlist = createQueue('allowlist operation');
const runState = createQueue('state operation');
const runCounts = createQueue('counter operation');

/* ---------- helpers ---------- */
function getToday() {
  return new Date().toISOString().split('T')[0];
}

function normalizeHost(value) {
  if (typeof value !== 'string') return null;
  const input = value.trim();
  if (!input || /[\s/@*\\?#]/.test(input)) return null;
  try {
    const url = new URL(input.includes('://') ? input : `https://${input}`);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    if (url.pathname !== '/' || url.search || url.hash) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
    if (!host || host.length > 253 || !host.includes('.') || !/^[a-z0-9.-]+$/.test(host) || host.startsWith('.') || host.endsWith('.') || host.includes('..')) {
      return null;
    }
    return host;
  } catch {
    return null;
  }
}

function normalizeAllowlist(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeHost).filter(Boolean))].slice(0, ALLOW_RULE_MAX);
}

/* ---------- State ---------- */
async function readState() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  const state = {
    enabled: typeof stored.enabled === 'boolean' ? stored.enabled : DEFAULTS.enabled,
    cosmetic: typeof stored.cosmetic === 'boolean' ? stored.cosmetic : DEFAULTS.cosmetic,
    allowlist: normalizeAllowlist(stored.allowlist),
    schemaVersion: SCHEMA_VERSION
  };
  const updates = {};
  if (stored.schemaVersion !== SCHEMA_VERSION) updates.schemaVersion = SCHEMA_VERSION;
  if (!Array.isArray(stored.allowlist) || stored.allowlist.length !== state.allowlist.length) updates.allowlist = state.allowlist;
  if (Object.keys(updates).length) await chrome.storage.local.set(updates);
  return state;
}

/* ---------- Rulesets ---------- */
async function syncBadge(enabled) {
  try {
    if (enabled) {
      await chrome.action.setBadgeText({ text: '' });
    } else {
      await chrome.action.setBadgeBackgroundColor({ color: '#c2410c' });
      await chrome.action.setBadgeText({ text: 'OFF' });
    }
  } catch (e) {}
}

async function syncRulesets() {
  const { enabled } = await readState();
  const currentlyEnabled = await chrome.declarativeNetRequest.getEnabledRulesets();
  const wanted = enabled ? [...RULESET_IDS] : [];
  const enableRulesetIds = wanted.filter(id => !currentlyEnabled.includes(id));
  const disableRulesetIds = currentlyEnabled.filter(id => !wanted.includes(id));

  if (enableRulesetIds.length || disableRulesetIds.length) {
    await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds, disableRulesetIds });
  }
  await syncBadge(enabled);
}

async function syncAllowlistRules() {
  const { allowlist } = await chrome.storage.local.get({ allowlist: [] });
  const clean = normalizeAllowlist(allowlist);
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.filter(rule => rule.id >= ALLOW_RULE_BASE && rule.id < ALLOW_RULE_BASE + ALLOW_RULE_MAX).map(rule => rule.id);

  const addRules = clean.map((host, index) => ({
    id: ALLOW_RULE_BASE + index,
    priority: 100000,
    action: { type: 'allow' },
    condition: { initiatorDomains: [host], resourceTypes: [...ALLOW_RULE_RESOURCE_TYPES] }
  }));

  if (!removeRuleIds.length && !addRules.length) return;
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

/* ---------- Cosmetic Counting (DOM) ---------- */
// Bumps three counters in one atomic write:
//   domDaily   — session-scoped total, resets at midnight
//   dailyCount — same as domDaily, kept for popup "Today" label
//   tabCounts  — per-tab count, resets on navigation, cleared on close
function recordCosmetic(count, tabId) {
  return runCounts(async () => {
    const today = getToday();
    const data = await chrome.storage.local.get({
      domDaily: 0, dailyCount: 0, dailyDate: today, tabCounts: {}
    });
    let domDaily = data.domDaily;
    let dailyCount = data.dailyCount;
    if (data.dailyDate !== today) {
      domDaily = 0;
      dailyCount = 0;
    }
    const tabCounts = data.tabCounts;
    if (typeof tabId === 'number' && tabId > 0) {
      tabCounts[tabId] = (tabCounts[tabId] || 0) + count;
    }
    await chrome.storage.local.set({
      domDaily: domDaily + count,
      dailyCount: dailyCount + count,
      dailyDate: today,
      tabCounts
    });
  });
}

/* ---------- Tab counter lifecycle ---------- */
// Clear tab count on close so tabCounts does not grow forever.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { tabCounts = {} } = await chrome.storage.local.get('tabCounts');
  if (tabCounts[tabId] !== undefined) {
    delete tabCounts[tabId];
    await chrome.storage.local.set({ tabCounts });
  }
});

// Reset tab count when the user navigates or reloads.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    const { tabCounts = {} } = await chrome.storage.local.get('tabCounts');
    if (tabCounts[tabId] !== undefined) {
      tabCounts[tabId] = 0;
      await chrome.storage.local.set({ tabCounts });
    }
  }
});

/* ---------- Initialization ---------- */
let initPromise = null;
function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await readState();
    await runRuleset(syncRulesets);
    await runAllowlist(syncAllowlistRules);
  })().catch(err => console.error('[BMZ] init failed', err))
     .finally(() => { initPromise = null; });
  return initPromise;
}

/* ---------- Lifecycle Events ---------- */
chrome.runtime.onInstalled.addListener(() => {
  init();
  chrome.tabs.query({}, (tabs) => {
    for (let tab of tabs) {
      if (tab.id) chrome.tabs.sendMessage(tab.id, { type: 'forceReevaluate' }).catch(() => {});
    }
  });
});

chrome.runtime.onStartup.addListener(() => {
  init();
  chrome.tabs.query({}, (tabs) => {
    for (let tab of tabs) {
      if (tab.id) chrome.tabs.sendMessage(tab.id, { type: 'forceReevaluate' }).catch(() => {});
    }
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.enabled) runRuleset(syncRulesets);
  if (changes.allowlist) runAllowlist(syncAllowlistRules);
});

/* ---------- Message Bus ---------- */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message?.type;
  if (typeof type !== 'string') return false;

  (async () => {
    try {
      switch (type) {
        case 'ping':
          sendResponse({ ok: true });
          break;

        case 'getState': {
          const [state, activeRulesets, data] = await Promise.all([
            readState(),
            chrome.declarativeNetRequest.getEnabledRulesets(),
            chrome.storage.local.get({ dailyCount: 0, tabCounts: {}, domDaily: 0 })
          ]);

          const tabId = message.tabId || (sender.tab ? sender.tab.id : -1);
          const pageCount = data.tabCounts[tabId] || 0;

          sendResponse({
            enabled: state.enabled,
            cosmetic: state.cosmetic,
            allowlist: state.allowlist,
            activeRulesets,
            counts: { page: pageCount, daily: data.dailyCount, dom: data.domDaily }
          });
          break;
        }

        case 'setEnabled': {
          if (!sender?.url?.startsWith(EXTENSION_ORIGIN)) return sendResponse({ ok: false });
          await chrome.storage.local.set({ enabled: message.value });
          await runRuleset(syncRulesets);
          sendResponse({ ok: true });
          break;
        }

        case 'addAllow': {
          if (!sender?.url?.startsWith(EXTENSION_ORIGIN)) return sendResponse({ ok: false });
          const host = normalizeHost(message.host);
          if (!host) return sendResponse({ ok: false });

          await runState(async () => {
            const { allowlist = [] } = await chrome.storage.local.get({ allowlist: [] });
            const current = normalizeAllowlist(allowlist);
            if (!current.includes(host) && current.length < ALLOW_RULE_MAX) {
              await chrome.storage.local.set({ allowlist: [...current, host] });
            }
          });
          await runAllowlist(syncAllowlistRules);
          sendResponse({ ok: true });
          break;
        }

        case 'removeAllow': {
          if (!sender?.url?.startsWith(EXTENSION_ORIGIN)) return sendResponse({ ok: false });
          const host = normalizeHost(message.host);
          if (!host) return sendResponse({ ok: false });

          await runState(async () => {
            const { allowlist = [] } = await chrome.storage.local.get({ allowlist: [] });
            const current = normalizeAllowlist(allowlist);
            await chrome.storage.local.set({ allowlist: current.filter(entry => entry !== host) });
          });
          await runAllowlist(syncAllowlistRules);
          sendResponse({ ok: true });
          break;
        }

        case 'cosmeticHidden': {
          if (!sender?.tab) return sendResponse({ ok: false });
          await recordCosmetic(message.count, sender.tab.id);
          sendResponse({ ok: true });
          break;
        }

        case 'recordSlippedAd': {
          if (!sender?.tab) return sendResponse({ ok: false });
          const rec = message.record;
          if (!rec || rec.__bmz !== 'adSlipped') return sendResponse({ ok: false });

          await runCounts(async () => {
            const { slippedAds = [] } = await chrome.storage.local.get({ slippedAds: [] });
            slippedAds.push({
              ts: rec.ts || Date.now(),
              url: typeof rec.url === 'string' ? rec.url.slice(0, 2048) : '',
              tabId: sender.tab.id,
              signals: rec.signals && typeof rec.signals === 'object' ? rec.signals : {}
            });
            await chrome.storage.local.set({ slippedAds: slippedAds.slice(-200) });
          });

          sendResponse({ ok: true });
          break;
        }

        case 'getSlippedAds': {
          const { slippedAds = [] } = await chrome.storage.local.get({ slippedAds: [] });
          sendResponse({ ok: true, slippedAds });
          break;
        }

        default:
          sendResponse({ ok: false, error: 'unknown' });
      }
    } catch (e) {
      console.error('[BMZ] message handler failed', e);
      try { sendResponse({ ok: false }); } catch {}
    }
  })();

  return true;
});

init();