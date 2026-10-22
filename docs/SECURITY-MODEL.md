# Security model

## Protected against

- Network requests to **83 known ad domains, 68 tracker domains, and 21
  confirmed malicious/coercive-redirect domains** — 172 static rules total
  across three rulesets. These counts are machine-verified against
  `rules/*.json` by `npm run validate`; a mismatch fails the build.
  Filtering is performed by Chrome's `declarativeNetRequest` engine in the
  browser process, before the response is delivered to the requesting
  context: top-level document, sub-frame, script, stylesheet, image, font,
  XHR/fetch, ping, media, WebSocket, or other. The page still executes its
  own scripts; only the blocked request's response is withheld.
- Common cosmetic ad containers (Google Ads slots, GAM iframes, Taboola,
  Outbrain, sponsored test IDs) hidden by a scoped stylesheet plus a
  `MutationObserver` that catches dynamically inserted nodes.
- Popunder, paid-link shortener, and crypto-miner domains blocked including
  for `main_frame` navigations. **This protection depends on the `security`
  ruleset being enabled.** With `security` off and `ads` on, those domains
  remain blocked as sub-resources but top-level navigation to them is
  allowed. The default configuration enables all three rulesets.

## Not protected against

- **Unknown or newly registered** phishing and malware domains. The bundled
  security list is hand-curated, not a reputation feed, and does not update
  itself.
- Malicious ads served from a site's own origin, or from a trusted CDN the
  site depends on. These cannot be distinguished from content by network
  rules or by DOM selectors.
- YouTube pre-roll, mid-roll, or feed ads. Same-origin delivery makes them
  unblockable by network rules; the player continues to work normally.
- First-party sponsored posts. Server-rendered content carries no network
  signal an extension can block.
- **Ads rendered inside iframes.** The content script is declared with
  `all_frames: false`, so cosmetic hiding runs only in the top-level frame.
  Network rules still block ad-network iframes at the request layer, but a
  same-origin or unblocked third-party iframe that renders an ad will not be
  cosmetically hidden.
- Drive-by downloads, exploit chains, or browser zero-days.
- Any threat outside the browser (email, DNS, OS).

## Design principles

- **No remote code execution.** No `eval`, no dynamically fetched scripts,
  no runtime rule conversion. All rules ship as JSON data inside the
  extension package.
- **Local-only data.** The extension does not intentionally transmit user
  data or browsing history to BuildMintZ or any third party. Settings live
  in `chrome.storage.local`; session counters live in
  `chrome.storage.session` and are cleared by the browser. Chrome itself
  makes its own network calls — extension updates, Safe Browsing lookups,
  crash reporting — under its own policies, independent of this extension.
- **DNR over request interception.** Blocking is handled by Chrome's native
  network engine. No per-request JavaScript, no page-world hooks, no
  `window.open` patching.
- **Stateless background worker.** The Manifest V3 service worker holds no
  load-bearing in-memory state. Counters are persisted to
  `chrome.storage.session` on every report so worker eviction cannot lose
  data. Every listener is registered synchronously at the top level.
- **Least privilege.** The manifest requests `storage`, `activeTab`, and
  `declarativeNetRequest` only. `declarativeNetRequestFeedback` is omitted:
  nothing in the shipped code calls `getMatchedRules()` or
  `onRuleMatchedDebug`, and the counters are derived from the DOM, not from
  matched-rule events.
- **Fail-open on cosmetic, fail-safe on network.** If the content script
  throws, the page is unaffected; ads stay visible but the site works. If a
  network rule is wrong, the user can allowlist the site from the popup
  without reinstalling.

## Site exceptions

A host in `allowlist`:

- Receives a dynamic DNR `allow` rule with `priority: 100000`, overriding
  all bundled block rules (priority 1 in `ads`/`trackers`, 100 in
  `security`) for requests **initiated by** that host. Matching uses
  `initiatorDomains`, so the exception applies to requests the site makes,
  not to third-party iframes layered on top of it.
- Is skipped by the content script's cosmetic filter.
- Is stored locally and never transmitted.

There is no wildcard support. `example.com` also matches `sub.example.com`
(initiator-domain matching is subtree-aware) but does not match
`notexample.com`.

Allow rules occupy the reserved ID range `100000`–`104499`. The cap of 4,500
entries keeps the extension inside Chrome's 30,000 dynamic-rule budget and
Firefox's 5,000-per-ruleset quota with headroom.

## Counting

"Elements hidden" is an **approximate** count of DOM nodes matching our
cosmetic selectors that were added during the session. It:

- Includes nodes that were later removed or hidden by the site's own CSS.
  The content script counts a node when it observes it; it does not verify
  that the node remained hidden.
- Does not count network-blocked requests. `onRuleMatchedDebug` fires only
  for unpacked extensions and cannot back a shipped product's counter.
- Is persisted to `chrome.storage.session`, so it survives service worker
  eviction. It resets when the browser closes.

It is not proof that ads were blocked. It is a session-scoped signal that
the cosmetic layer is doing work.

## Known trade-offs

- **Blocking `googletagmanager.com/gtag/js` and `gtm.js`** also breaks consent
  management platforms and A/B testing tools that are delivered through GTM.
  Some sites will show a cookie banner that never resolves. Allowlisting the
  site is the intended remedy.
- **Blocking `facebook.com/tr`** can break conversion tracking used by
  e-commerce checkout flows; the purchase still completes, but the merchant
  loses attribution. This is the intended behaviour of a tracker blocker.
- **Blocking `bat.bing.com`** can break Microsoft Advertising conversion
  reporting with the same caveat.

## Incident response

If a page breaks:

1. Use the popup to allowlist that site.
2. Report the URL and which ruleset is responsible (DevTools → Network →
   look for `blockedbyclient` or `ERR_BLOCKED_BY_CLIENT`, then match the
   request host against `rules/*.json`).
3. Do not add broad allow rules. Allowlisting one host is the intended
   escape hatch.

## Consistency requirements

This document describes intent. It becomes a verified claim only when these
files agree with it:

- `manifest.json` — permissions, DNR ruleset declarations, content script
  matches and `all_frames`
- `background.js` — allowlist mechanism (dynamic rules, priority 100000,
  reserved ID band), stateless counter implementation
- `content/content.js` — cosmetic count source
- `rules/ads.json`, `rules/trackers.json`, `rules/security.json` — rule
  counts, `main_frame` presence, resource types

`npm run validate` enforces the rule counts quoted at the top of this file
against the actual JSON, rejects duplicate `urlFilter` values within a
ruleset, rejects unknown condition/action keys, cross-checks every element
ID referenced by `popup.js` and `options.js` against its HTML, and verifies
that `package.json` and `manifest.json` versions match.

Chrome 120+ allows up to 100 declared static rulesets (50 enabled) with a
guaranteed 30,000 static rules; this project caps itself at 25,000 total and
10,000 per ruleset so it stays comfortably inside both Chrome's guarantee and
Firefox's stricter installation-time behaviour.