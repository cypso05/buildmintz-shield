/* BuildMintZ Shield — options controller
 *
 * Every element lookup goes through requireEl(), so an HTML/JS ID mismatch
 * fails loudly with the missing ID in the console instead of silently
 * killing the rest of the script.
 */

'use strict';

const MAX_ALLOWLIST_ENTRIES = 4500;
const MAX_IMPORT_SIZE = 1024 * 1024;

const EXTENSION_ORIGIN = chrome.runtime.getURL('');

/* ---------- element access ---------- */

function requireEl(id) {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error(`[BMZ options] missing element #${id}`);
  }

  return element;
}

/* ---------- helpers ---------- */

function normalizeHost(input) {
  if (typeof input !== 'string') return null;

  const value = input.trim();

  if (!value || /[\s/@*\\?#]/.test(value)) return null;

  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);

    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    if (url.pathname !== '/' || url.search || url.hash) return null;

    const host = url.hostname
      .toLowerCase()
      .replace(/\.$/, '')
      .replace(/^www\./, '');

    if (
      !host.includes('.') ||
      host.length > 253 ||
      !/^[a-z0-9.-]+$/.test(host) ||
      host.startsWith('.') ||
      host.endsWith('.') ||
      host.includes('..')
    ) {
      return null;
    }

    return host;
  } catch {
    return null;
  }
}

function normalizeAllowlist(value) {
  if (!Array.isArray(value)) return [];

  return [...new Set(value.map(normalizeHost).filter(Boolean))]
    .slice(0, MAX_ALLOWLIST_ENTRIES);
}

function setMessage(text, isError = false) {
  const element = document.getElementById('message');
  if (!element) return;

  element.textContent = text || '';
  element.style.color = isError ? '#ff9a9a' : '#78e3bd';
}

/* ---------- allowlist store ---------- */

async function readAllowlist() {
  const stored = await chrome.storage.local.get({ allowlist: [] });
  return normalizeAllowlist(stored.allowlist);
}

async function writeAllowlist(next) {
  const clean = normalizeAllowlist(next);
  await chrome.storage.local.set({ allowlist: clean });
  return clean;
}

/* One serialized mutation queue. Rejections are swallowed for the chain but
 * still surfaced to the caller. */
let mutationTail = Promise.resolve();

function enqueueMutation(operation) {
  const next = mutationTail.then(operation);
  mutationTail = next.catch(() => {});
  return next;
}

function withAllowlist(handler) {
  return enqueueMutation(async () => {
    const current = await readAllowlist();
    return handler(current);
  });
}

function allowlistEquals(a, b) {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/* ---------- render ---------- */

let rendering = false;
let renderAgain = false;

function createEmptyRow(text) {
  const item = document.createElement('li');
  item.className = 'empty';
  item.textContent = text;
  return item;
}

function createSiteRow(host) {
  const item = document.createElement('li');

  const label = document.createElement('span');
  label.textContent = host;

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'button small secondary';
  remove.textContent = 'Remove';
  remove.setAttribute('aria-label', `Remove exception for ${host}`);

  remove.addEventListener('click', async () => {
    remove.disabled = true;

    try {
      const outcome = await withAllowlist(async current => {
        if (!current.includes(host)) return { status: 'absent' };
        await writeAllowlist(current.filter(entry => entry !== host));
        return { status: 'removed' };
      });

      setMessage(
        outcome.status === 'removed'
          ? `Removed ${host}.`
          : `${host} was not in the list.`
      );

      await render();
    } catch (error) {
      console.error('[BMZ options] remove failed', error);
      setMessage('Could not remove site exception.', true);
      remove.disabled = false;
    }
  });

  item.append(label, remove);
  return item;
}

async function render() {
  if (rendering) {
    renderAgain = true;
    return;
  }

  rendering = true;

  try {
    do {
      renderAgain = false;

      const stored = await chrome.storage.local.get({ cosmetic: true });
      requireEl('cosmetic').checked = stored.cosmetic !== false;

      const allowlist = normalizeAllowlist(
        (await chrome.storage.local.get({ allowlist: [] })).allowlist
      );

      const list = requireEl('sites');
      list.replaceChildren();

      if (!allowlist.length) {
        list.append(createEmptyRow('No sites excepted.'));
        continue;
      }

      for (const host of allowlist) {
        list.append(createSiteRow(host));
      }
    } while (renderAgain);
  } catch (error) {
    console.error('[BMZ options] render failed', error);
    setMessage('Could not load settings.', true);
  } finally {
    rendering = false;
  }
}

/* ---------- cosmetic toggle ---------- */

function bindCosmeticToggle() {
  const checkbox = requireEl('cosmetic');

  checkbox.addEventListener('change', async () => {
    checkbox.disabled = true;

    try {
      await chrome.storage.local.set({ cosmetic: checkbox.checked });
      setMessage('Settings saved locally.');
    } catch (error) {
      console.error('[BMZ options] save failed', error);
      setMessage('Could not save settings.', true);
      await render();
    } finally {
      checkbox.disabled = false;
    }
  });
}

/* ---------- add exception ---------- */

function bindAddForm() {
  const form = requireEl('addForm');
  const input = requireEl('host');

  form.addEventListener('submit', async event => {
    event.preventDefault();

    const host = normalizeHost(input.value);

    if (!host) {
      setMessage('Enter a valid hostname, such as example.com.', true);
      return;
    }

    const submitButton = form.querySelector('button[type="submit"]');
    if (submitButton) submitButton.disabled = true;

    try {
      const outcome = await withAllowlist(async current => {
        if (current.includes(host)) return { status: 'exists' };
        if (current.length >= MAX_ALLOWLIST_ENTRIES) return { status: 'full' };

        await writeAllowlist([...current, host]);
        return { status: 'added' };
      });

      if (outcome.status === 'exists') {
        setMessage('That site is already excepted.', true);
        return;
      }

      if (outcome.status === 'full') {
        setMessage('The site exception limit has been reached.', true);
        return;
      }

      input.value = '';
      setMessage(`Added ${host}.`);
      await render();
    } catch (error) {
      console.error('[BMZ options] add failed', error);
      setMessage('Could not add site exception.', true);
    } finally {
      if (submitButton) submitButton.disabled = false;
    }
  });
}

/* ---------- export ---------- */

function bindExport() {
  requireEl('export').addEventListener('click', async () => {
    let objectUrl = '';

    try {
      const allowlist = await readAllowlist();

      const blob = new Blob(
        [JSON.stringify({ version: 1, allowlist }, null, 2)],
        { type: 'application/json' }
      );

      objectUrl = URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = 'buildmintz-shield-allowlist.json';

      document.body.appendChild(link);
      link.click();
      link.remove();

      setMessage('Allowlist exported.');
    } catch (error) {
      console.error('[BMZ options] export failed', error);
      setMessage('Could not export allowlist.', true);
    } finally {
      if (objectUrl) {
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      }
    }
  });
}

/* ---------- import ---------- */

function bindImport() {
  const fileInput = requireEl('importFile');

  requireEl('import').addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', async event => {
    const input = event.currentTarget;
    const file = input.files?.[0];

    input.value = '';

    if (!file) return;

    if (file.size > MAX_IMPORT_SIZE) {
      setMessage('Import file is too large (maximum 1 MB).', true);
      return;
    }

    try {
      const parsed = JSON.parse(await file.text());

      const incoming = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.allowlist)
          ? parsed.allowlist
          : null;

      if (!incoming) {
        setMessage('File has no allowlist array.', true);
        return;
      }

      const clean = [...new Set(incoming.map(normalizeHost).filter(Boolean))];

      const outcome = await withAllowlist(async current => {
        const merged = normalizeAllowlist([...current, ...clean]);

        if (allowlistEquals(merged, current)) {
          return { status: 'unchanged', merged };
        }

        await writeAllowlist(merged);
        return { status: 'merged', merged };
      });

      setMessage(
        outcome.status === 'unchanged'
          ? `No new entries (${outcome.merged.length} total).`
          : `Imported ${clean.length} entries (${outcome.merged.length} total).`
      );

      await render();
    } catch (error) {
      console.error('[BMZ options] import failed', error);
      setMessage('Could not import file.', true);
    }
  });
}

/* ---------- reset ---------- */

function bindReset() {
  requireEl('clearAll').addEventListener('click', async () => {
    if (!confirm('Clear all BuildMintZ Shield settings and exceptions?')) return;

    try {
      await enqueueMutation(async () => {
        await chrome.storage.local.set({
          enabled: true,
          cosmetic: true,
          allowlist: [],
          schemaVersion: 2
        });

        try {
          await chrome.storage.session.clear();
        } catch {
          /* Older Firefox builds may not expose storage.session.clear. */
        }
      });

      setMessage('Settings reset to defaults.');
      await render();
    } catch (error) {
      console.error('[BMZ options] reset failed', error);
      setMessage('Could not reset settings.', true);
    }
  });
}

/* ---------- ad-slip diagnostics ---------- */

function bindSlippedLog() {
  const log = requireEl('slippedLog');
  const refresh = requireEl('refreshSlipped');
  const clear = requireEl('clearSlipped');

  async function load() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'getSlippedAds' });
      const entries = Array.isArray(res?.slippedAds) ? res.slippedAds : [];
      if (!entries.length) {
        log.textContent = 'No slipped ads recorded.';
        return;
      }
      log.textContent = entries
        .slice()
        .reverse()
        .map(e => JSON.stringify(e, null, 2))
        .join('\n\n');
    } catch (error) {
      console.error('[BMZ options] slipped log load failed', error);
      log.textContent = 'Could not load log.';
    }
  }

  refresh.addEventListener('click', load);

  clear.addEventListener('click', async () => {
    if (!confirm('Clear the ad-slip diagnostics log?')) return;
    try {
      await chrome.storage.local.set({ slippedAds: [] });
      log.textContent = 'No slipped ads recorded.';
      setMessage('Diagnostics log cleared.');
    } catch (error) {
      console.error('[BMZ options] slipped log clear failed', error);
      setMessage('Could not clear log.', true);
    }
  });

  load();
}

/* ---------- storage sync ---------- */

function bindStorageSync() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if (changes.cosmetic || changes.allowlist || changes.enabled) {
      render().catch(() => {});
    }
  });
}

/* ---------- boot ---------- */

function boot() {
  try {
    bindCosmeticToggle();
    bindAddForm();
    bindExport();
    bindImport();
    bindReset();
    bindSlippedLog(); // ADDED: Connects the diagnostics card
    bindStorageSync();
  } catch (error) {
    console.error('[BMZ options] startup failed', error);
    setMessage('Could not initialise settings page.', true);
    return;
  }

  render().catch(error => {
    console.error('[BMZ options] startup render failed', error);
    setMessage('Could not load settings.', true);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}