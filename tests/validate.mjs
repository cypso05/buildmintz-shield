import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const errors = [];
const warnings = [];

/* Chrome 120+ allows 100 declared static rulesets and 50 enabled, with a
 * guaranteed 30,000 static rules. Firefox throws at install time rather than
 * silently dropping rules, so the project caps itself well below both. */
const MAX_STATIC_RULESETS = 100;
const MAX_ENABLED_STATIC_RULESETS = 50;
const MAX_RULES_PER_RULESET = 10_000;
const MAX_TOTAL_RULES = 25_000;
const MAX_RULE_ID = 2_000_000_000;
const MAX_RULE_FILE_BYTES = 2 * 1024 * 1024;

const VALID_ACTION_TYPES = new Set([
  'block',
  'allow',
  'allowAllRequests',
  'redirect',
  'upgradeScheme',
  'modifyHeaders'
]);

const VALID_ACTION_KEYS = new Set([
  'type',
  'redirect',
  'requestHeaders',
  'responseHeaders'
]);

const VALID_RESOURCE_TYPES = new Set([
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'webtransport',
  'webbundle',
  'other'
]);

const VALID_CONDITION_KEYS = new Set([
  'urlFilter',
  'regexFilter',
  'isUrlFilterCaseSensitive',
  'initiatorDomains',
  'excludedInitiatorDomains',
  'requestDomains',
  'excludedRequestDomains',
  'resourceTypes',
  'excludedResourceTypes',
  'domainType',
  'tabIds',
  'excludedTabIds',
  'requestMethods',
  'excludedRequestMethods',
  'responseHeaders',
  'excludedResponseHeaders',
  'domains',
  'excludedDomains'
]);

/* Rulesets other than `security` must never block top-level navigation. */
const RULESETS_ALLOWED_MAIN_FRAME = new Set(['security']);

function fail(message) {
  errors.push(message);
}

function warn(message) {
  warnings.push(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
  return Boolean(condition);
}

function projectPath(relativePath) {
  const resolved = path.resolve(ROOT, relativePath);
  const relative = path.relative(ROOT, resolved);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`path escapes project root: ${relativePath}`);
    return null;
  }

  return resolved;
}

function readText(relativePath) {
  const filePath = projectPath(relativePath);
  if (!filePath || !fs.existsSync(filePath)) return null;

  return fs.readFileSync(filePath, 'utf8');
}

function exists(relativePath) {
  const filePath = projectPath(relativePath);

  if (!filePath) return false;

  if (!fs.existsSync(filePath)) {
    fail(`missing file: ${relativePath}`);
    return false;
  }

  return true;
}

function loadJSON(relativePath) {
  const text = readText(relativePath);

  if (text === null) {
    fail(`missing file: ${relativePath}`);
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`invalid JSON in ${relativePath}: ${error.message}`);
    return null;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateResourceTypes(types, label) {
  if (!Array.isArray(types)) {
    fail(`${label}: resourceTypes must be an array`);
    return;
  }

  if (!types.length) {
    fail(`${label}: resourceTypes must not be empty`);
    return;
  }

  for (const type of types) {
    assert(
      VALID_RESOURCE_TYPES.has(type),
      `${label}: unsupported resource type "${type}"`
    );
  }
}

function validateDomains(value, label, key) {
  if (!Array.isArray(value) || !value.length) {
    fail(`${label}: ${key} must be a non-empty array of strings`);
    return;
  }

  for (const entry of value) {
    if (typeof entry !== 'string' || !entry) {
      fail(`${label}: ${key} contains a non-string or empty entry`);
      continue;
    }

    if (/[\s/]/.test(entry)) {
      fail(`${label}: ${key} entry "${entry}" looks like a URL, not a domain`);
    }
  }
}

function validateAction(action, label) {
  assert(isPlainObject(action), `${label}: action must be an object`);
  if (!isPlainObject(action)) return;

  for (const key of Object.keys(action)) {
    if (!VALID_ACTION_KEYS.has(key)) {
      warn(`${label}: unknown action key "${key}"`);
    }
  }

  if (!assert(VALID_ACTION_TYPES.has(action.type), `${label}: unsupported action type "${action.type}"`)) {
    return;
  }

  if (action.type === 'redirect') {
    const redirect = action.redirect;
    assert(
      isPlainObject(redirect) &&
        (typeof redirect.extensionPath === 'string' ||
          typeof redirect.url === 'string' ||
          typeof redirect.regexSubstitution === 'string' ||
          isPlainObject(redirect.transform)),
      `${label}: redirect action requires extensionPath, url, regexSubstitution, or transform`
    );
  }

  if (action.type === 'modifyHeaders') {
    assert(
      Array.isArray(action.requestHeaders) || Array.isArray(action.responseHeaders),
      `${label}: modifyHeaders requires requestHeaders or responseHeaders`
    );
  }
}

function validateCondition(condition, label, rulesetId) {
  assert(isPlainObject(condition), `${label}: condition must be an object`);
  if (!isPlainObject(condition)) return null;

  for (const key of Object.keys(condition)) {
    if (!VALID_CONDITION_KEYS.has(key)) {
      warn(`${label}: unknown condition key "${key}"`);
    }
  }

  const hasUrlFilter = typeof condition.urlFilter === 'string' && condition.urlFilter.length > 0;
  const hasRegexFilter = typeof condition.regexFilter === 'string' && condition.regexFilter.length > 0;

  assert(hasUrlFilter || hasRegexFilter, `${label}: needs a non-empty urlFilter or regexFilter`);

  if (hasUrlFilter) {
    if (/\s/.test(condition.urlFilter)) {
      fail(`${label}: urlFilter contains whitespace, which DNR rejects`);
    }

    assert(condition.urlFilter.length <= 2000, `${label}: urlFilter exceeds 2000 characters`);
  }

  if (condition.resourceTypes !== undefined) {
    validateResourceTypes(condition.resourceTypes, label);

    if (
      Array.isArray(condition.resourceTypes) &&
      condition.resourceTypes.includes('main_frame') &&
      !RULESETS_ALLOWED_MAIN_FRAME.has(rulesetId)
    ) {
      warn(`${label}: main_frame is blocked from ruleset "${rulesetId}" — confirm this is intentional`);
    }
  }

  if (condition.excludedResourceTypes !== undefined) {
    validateResourceTypes(condition.excludedResourceTypes, label);
  }

  for (const key of [
    'initiatorDomains',
    'excludedInitiatorDomains',
    'requestDomains',
    'excludedRequestDomains',
    'domains',
    'excludedDomains'
  ]) {
    if (condition[key] !== undefined) validateDomains(condition[key], label, key);
  }

  assert(
    condition.urlFilter === undefined || condition.regexFilter === undefined,
    `${label}: urlFilter and regexFilter are mutually exclusive`
  );

  return hasUrlFilter ? condition.urlFilter : null;
}

function validateRule(rule, rulesetId, seenIds, seenFilters) {
  const label = `${rulesetId} rule ${String(rule?.id ?? '?')}`;

  if (!assert(isPlainObject(rule), `${label}: rule must be an object`)) return;

  assert(
    Number.isInteger(rule.id) && rule.id >= 1 && rule.id < MAX_RULE_ID,
    `${label}: id must be a positive integer below ${MAX_RULE_ID}`
  );

  if (Number.isInteger(rule.id)) {
    if (seenIds.has(rule.id)) {
      fail(`${label}: duplicate rule ID`);
    } else {
      seenIds.add(rule.id);
    }
  }

  if (rule.priority !== undefined) {
    assert(
      Number.isInteger(rule.priority) && rule.priority >= 1,
      `${label}: priority must be a positive integer`
    );
  }

  validateAction(rule.action, label);

  const urlFilter = validateCondition(rule.condition, label, rulesetId);

  if (typeof urlFilter === 'string') {
    if (seenFilters.has(urlFilter)) {
      fail(`${label}: duplicate urlFilter "${urlFilter}" within ruleset "${rulesetId}"`);
    } else {
      seenFilters.add(urlFilter);
    }
  }
}

function validateManifest() {
  const manifest = loadJSON('manifest.json');
  if (!manifest) return null;

  assert(manifest.manifest_version === 3, 'manifest_version must be 3');
  assert(
    typeof manifest.name === 'string' && manifest.name.trim().length > 0,
    'manifest.name is required'
  );
  assert(
    typeof manifest.version === 'string' && /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(manifest.version),
    'manifest.version must be a dotted numeric version'
  );

  assert(
    isPlainObject(manifest.background) && typeof manifest.background.service_worker === 'string',
    'background.service_worker is required'
  );

  assert(Array.isArray(manifest.permissions), 'permissions must be an array');
  assert(
    manifest.permissions?.includes('declarativeNetRequest'),
    'declarativeNetRequest permission is required'
  );

  assert(Array.isArray(manifest.host_permissions), 'host_permissions must be an array');
  assert(
    manifest.host_permissions?.includes('http://*/*'),
    'http://*/* host permission is required'
  );
  assert(
    manifest.host_permissions?.includes('https://*/*'),
    'https://*/* host permission is required'
  );

  for (const size of ['16', '48', '128']) {
    const iconPath = manifest.icons?.[size];

    if (typeof iconPath !== 'string' || !iconPath) {
      fail(`manifest.icons["${size}"] is required`);
    } else {
      exists(iconPath);
    }
  }

  if (manifest.background?.service_worker) exists(manifest.background.service_worker);
  if (manifest.action?.default_popup) exists(manifest.action.default_popup);
  if (manifest.options_page) exists(manifest.options_page);
  if (manifest.options_ui?.page) exists(manifest.options_ui.page);

  for (const contentScript of manifest.content_scripts ?? []) {
    assert(
      Array.isArray(contentScript.matches) && contentScript.matches.length > 0,
      'content_scripts[].matches must be a non-empty array'
    );

    if (contentScript.all_frames !== undefined) {
      assert(
        typeof contentScript.all_frames === 'boolean',
        'content_scripts[].all_frames must be a boolean'
      );
    }

    for (const file of contentScript.js ?? []) exists(file);
    for (const file of contentScript.css ?? []) exists(file);
  }

  const resources = manifest.declarative_net_request?.rule_resources;

  if (!assert(Array.isArray(resources) && resources.length > 0, 'at least one rule resource is required')) {
    return manifest;
  }

  assert(resources.length <= MAX_STATIC_RULESETS, `declared static rulesets exceed ${MAX_STATIC_RULESETS}`);

  const enabledCount = resources.filter(resource => resource?.enabled === true).length;
  assert(
    enabledCount <= MAX_ENABLED_STATIC_RULESETS,
    `enabled static rulesets (${enabledCount}) exceed ${MAX_ENABLED_STATIC_RULESETS}`
  );

  const rulesetIds = new Set();
  const rulesetPaths = new Set();
  let totalRules = 0;

  for (const resource of resources) {
    if (!isPlainObject(resource)) {
      fail('each rule resource must be an object');
      continue;
    }

    assert(typeof resource.id === 'string' && resource.id.length > 0, 'ruleset id is required');
    assert(typeof resource.path === 'string' && resource.path.length > 0, `ruleset ${resource.id || '?'}: path is required`);
    assert(typeof resource.enabled === 'boolean', `ruleset ${resource.id || '?'}: enabled must be a boolean`);

    if (typeof resource.id !== 'string' || !resource.id) continue;

    if (rulesetIds.has(resource.id)) fail(`duplicate ruleset id: ${resource.id}`);
    rulesetIds.add(resource.id);

    if (typeof resource.path !== 'string' || !resource.path) continue;

    if (rulesetPaths.has(resource.path)) fail(`duplicate ruleset path: ${resource.path}`);
    rulesetPaths.add(resource.path);

    const absolute = path.join(ROOT, resource.path);

    if (fs.existsSync(absolute)) {
      const bytes = fs.statSync(absolute).size;

      if (bytes > MAX_RULE_FILE_BYTES) {
        fail(`${resource.path} is ${(bytes / 1024 / 1024).toFixed(1)} MB, above the 2 MB cap`);
      }
    }

    const rules = loadJSON(resource.path);

    if (!Array.isArray(rules)) {
      fail(`${resource.path} must contain a JSON array`);
      continue;
    }

    assert(
      rules.length <= MAX_RULES_PER_RULESET,
      `${resource.path}: ${rules.length} rules exceeds the per-ruleset cap of ${MAX_RULES_PER_RULESET}`
    );

    const seenIds = new Set();
    const seenFilters = new Set();

    for (const rule of rules) {
      validateRule(rule, resource.id, seenIds, seenFilters);
    }

    totalRules += rules.length;
    console.log(`  ${resource.id}: ${rules.length} rules`);
  }

  assert(totalRules <= MAX_TOTAL_RULES, `total static rules ${totalRules} exceeds the cap of ${MAX_TOTAL_RULES}`);
  console.log(`\nTotal static rules: ${totalRules}`);

  return manifest;
}

/* Cross-check every element ID referenced by a controller script against
 * the IDs actually defined in its HTML. This is the check that would have
 * caught the four broken references on the options page in one second. */
function validateElementReferences() {
  const pairs = [
    { js: 'popup/popup.js', html: 'popup/popup.html' },
    { js: 'options/options.js', html: 'options/options.html' }
  ];

  for (const { js, html } of pairs) {
    const script = readText(js);
    const markup = readText(html);

    if (script === null || markup === null) continue;

    const referenced = new Set(
      [...script.matchAll(/(?:\$|requireEl|getElementById)\(\s*'([A-Za-z][\w-]*)'\s*\)/g)].map(
        match => match[1]
      )
    );

    const defined = new Set(
      [...markup.matchAll(/\bid="([^"]+)"/g)].map(match => match[1])
    );

    for (const id of referenced) {
      if (!defined.has(id)) {
        fail(`${js} references #${id} but ${html} does not define it`);
      }
    }
  }
}

/* Keep the rule counts quoted in docs/SECURITY-MODEL.md from drifting away
 * from the actual JSON. If the sentence is reworded, warn instead of fail. */
function validateDocumentedCounts(manifest, counts) {
  const doc = readText('docs/SECURITY-MODEL.md');
  if (doc === null) return;

  const match = doc.match(
    /(\d+)\s+known ad domains,\s*(\d+)\s+tracker domains,\s*and\s*(\d+)\s+confirmed/i
  );

  if (!match) {
    warn('could not find the rule-count sentence in docs/SECURITY-MODEL.md');
    return;
  }

  const documented = {
    ads: Number(match[1]),
    trackers: Number(match[2]),
    security: Number(match[3])
  };

  const byRuleset = {};
  for (const resource of manifest?.declarative_net_request?.rule_resources ?? []) {
    const rules = loadJSON(resource.path);
    if (Array.isArray(rules)) byRuleset[resource.id] = rules.length;
  }

  for (const key of Object.keys(documented)) {
    if (byRuleset[key] !== documented[key]) {
      fail(
        `docs/SECURITY-MODEL.md claims ${documented[key]} ${key} rules but ` +
          `${key}.json contains ${byRuleset[key] ?? 'an unknown number of'} rules`
      );
    }
  }

  void counts;
}

function validateVersionAlignment(manifest) {
  const pkg = loadJSON('package.json');
  if (!pkg || !manifest) return;

  if (pkg.version !== manifest.version) {
    fail(`package.json version (${pkg.version}) does not match manifest.json version (${manifest.version})`);
  }
}

function validateRequiredFiles() {
  const requiredFiles = [
    'README.md',
    'LICENSE',
    'NOTICE.md',
    'docs/FILTER-SOURCES.md',
    'docs/SECURITY-MODEL.md',
    'docs/TESTING.md',
    'background.js',
    'content/content.js',
    'popup/popup.html',
    'popup/popup.js',
    'popup/popup.css',
    'options/options.html',
    'options/options.js',
    'options/options.css',
    'rules/ads.json',
    'rules/trackers.json',
    'rules/security.json',
    'scripts/make-firefox.mjs',
    'package.json'
  ];

  for (const file of requiredFiles) exists(file);
}

function validatePackage() {
  const pkg = loadJSON('package.json');
  if (!pkg) return;

  assert(pkg.type === 'module', 'package.json must set type to "module"');
  assert(typeof pkg.engines?.node === 'string', 'package.json should declare the required Node.js version');

  for (const script of ['validate', 'build:chrome', 'build:firefox', 'build']) {
    assert(typeof pkg.scripts?.[script] === 'string', `package.json is missing the "${script}" script`);
  }
}

console.log('Validating BuildMintZ Shield...\n');

validateRequiredFiles();
validatePackage();

const manifest = validateManifest();

validateElementReferences();
validateDocumentedCounts(manifest);
validateVersionAlignment(manifest);

if (warnings.length) {
  console.warn(`\nWarnings (${warnings.length}):`);
  for (const warning of warnings) console.warn(`  - ${warning}`);
}

if (errors.length) {
  console.error(`\n✗ Validation failed: ${errors.length} error(s)`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exitCode = 1;
} else {
  console.log('\n✓ Project validation passed.');
}