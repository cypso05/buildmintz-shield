# Test checklist

This package has been structurally generated but has not been exercised
end-to-end in a real browser in the current environment. Before calling any
build a release, run the following.

## Install

- [ ] Load `dist/chrome-unpacked/` via `chrome://extensions` (Developer mode).
- [ ] Confirm no red errors on the extension card.
- [ ] Open the service worker inspector; console is empty.
- [ ] Popup opens, shows "Protection is active", site line shows the correct host.
- [ ] Options page opens, shows empty allowlist.
- [ ] Options page opens, shows "Ad-slip diagnostics" card with "No slipped
      ads recorded." in the log area.

## Toggles

- [ ] Popup switch pauses → `chrome.declarativeNetRequest.getEnabledRulesets()`
      returns empty in the SW console.
- [ ] Popup switch resumes → all three rulesets enabled.
- [ ] Options cosmetic toggle changes the popup's "elements hidden" counter
      behavior on a fresh page load (either starts counting, or stops).

## Allowlist

- [ ] From the popup on `https://example.com`, click "Allow this site".
- [ ] Reload the page. Content script no longer injects the style element
      (DevTools → Elements → search `buildmintz-shield-cosmetic`).
- [ ] Network requests from that host to `doubleclick.net` are no longer
      blocked (check DevTools → Network).
- [ ] Remove the exception; reload; both behaviors return.

## Known-ads fixture

Use a static test page (fixture, not a live ad network). With DevTools open:

- [ ] Request to `https://doubleclick.net/` shows `ERR_BLOCKED_BY_CLIENT`.
- [ ] `<ins class="adsbygoogle">` is `display: none`.
- [ ] `<div id="div-gpt-ad-123">` is `display: none`.
- [ ] Legit `<img>`, `<script>`, and same-origin `<iframe>` still load.

## YouTube ad skipping

- [ ] Load a watch page with a known skippable pre-roll. The ad is skipped
      within ~500 ms; the video plays at its normal speed and is not muted.
- [ ] Navigate search → watch page. The pre-roll on the new page is skipped.
- [ ] Reload while an ad is playing. The ad is skipped after reload.
- [ ] Open a long video with a mid-roll. The mid-roll is skipped.
- [ ] Open a normal (non-ad) video. `video.playbackRate` and `video.muted`
      are unchanged by the extension (compare before/after enabling it).
- [ ] Open a non-YouTube site. `content/page.js` does nothing (it early-returns
      on non-`youtube.com` hosts).
- [ ] On a YouTube feed page, in-feed ads (`ytd-ad-slot-renderer`, promoted
      videos) are hidden by the cosmetic stylesheet.
- [ ] On a YouTube watch page, `#player-ads` and `#masthead-ad` are hidden.

## Ad-slip diagnostics

- [ ] Options → Ad-slip diagnostics shows "No slipped ads recorded." on a
      fresh install.
- [ ] After a session where an ad was detected but not skipped within 1.5 s,
      the log contains one JSON record per slip.
- [ ] The record contains `url`, `signals.badgeText`, `signals.whyAdHref`,
      `signals.skipButtonPresent`, `signals.videoDuration`, `ts`. It does
      not contain an advertiser name (YouTube does not expose one).
- [ ] "Refresh" reloads the log from `chrome.storage.local`.
- [ ] "Clear log" empties the list and persists the empty array.
- [ ] The `slippedAds` array is capped at 200 entries; the oldest entries
      are dropped first.

## Site breakage sweep

For each of news / shopping / banking / streaming / search / login, open a
real page and confirm primary content and sign-in still work.

## Performance

- [ ] Cold start: extension installed, no tab open, `chrome://system` shows
      no extension process until a page is opened.
- [ ] Idle CPU: open 5 tabs, wait 60 s, extension's service worker is asleep
      (`chrome://serviceworker-internals`).
- [ ] Page load: use DevTools Performance on 5 pages; no measurable slowdown
      compared to the same pages with the extension disabled.
- [ ] YouTube: open a watch page and leave it playing for 5 minutes. The
      main-world `page.js` interval does not raise CPU above a few percent.

## Updates / restart

- [ ] Close and reopen Chrome; state (enabled, cosmetic, allowlist) survives.
- [ ] Session counter resets (expected).
- [ ] Uninstall → reinstall preserves nothing (expected, by design).

## Build

- [ ] `npm run validate` passes.
- [ ] `npm run build` produces three artifacts in `dist/` and `SHA256SUMS`.
- [ ] Extracting `dist/BuildMintZ-Shield-chrome-v<version>.zip` yields a
      folder whose root contains `manifest.json` (loadable unpacked).
- [ ] SHA-256 in `SHA256SUMS` matches `sha256sum` on the extracted ZIPs.

## Not covered (deliberately)

- **Server-side stitched YouTube ads (SSAP).** Ads delivered inside the
  same media stream as the content cannot be skipped by any client-side
  technique. If tested, expect these ads to play; do not file as a bug.
  Client-side skippable ads are covered by the "YouTube ad skipping"
  checklist above.
- **Advertiser names in the slip log.** YouTube does not expose them to
  the page. The log records what the content script could observe (page
  URL, badge text, "Why this ad" link when present), not an advertiser
  report.
- Firefox: the `make-firefox.mjs` output is provided but has not been
  smoke-tested in this environment.