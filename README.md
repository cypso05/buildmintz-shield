# BuildMintZ Shield

A lightweight, local-only browser extension for blocking requests to known ad, tracking, and scam domains, and hiding common ad containers. Manifest V3 is the primary target; Firefox output is generated but not validated here.

## What it does

- **Blocks Network Requests:** Blocks requests to ~155 hand-curated ad, tracker, and malicious-domain hosts using Chrome's `declarativeNetRequest` engine — native, no per-request JavaScript, no background CPU cost.
- **Cosmetic Filtering:** Hides common ad containers via a scoped cosmetic stylesheet plus a `MutationObserver` that catches dynamically inserted ads.
- **YouTube Ad Skipping:** Runs a lightweight script to instantly detect, mute, speed up, and skip YouTube pre-rolls and mid-rolls (including the "Sponsored" layout). *Note: Server-side stitched ads (SSAP) cannot be skipped by any extension.*
- **Global Pause & Allowlist:** Offers a global pause switch and per-site exceptions directly from the popup.
- **Privacy First:** Does **not** require an account, subscription, telemetry endpoint, or any BuildMintZ-operated backend. All storage is local to your browser.
- **Ad-Slip Diagnostics:** If a YouTube ad slips through (e.g., missing a skip button or using an unblockable format), the extension records the DOM signals it saw. You can view this raw local log in the Settings page to see exactly what YouTube is doing.

## What it does not do

- **No Guarantees against Server-Side Ads:** Ads delivered inside the same media stream as the content (SSAP) cannot be skipped or blocked by client-side extensions. The player is not broken; those specific ads will just play normally.
- **Not an antivirus:** The security rule group is small and hand-authored. Keep Chrome Safe Browsing enabled.
- **No remote filter lists:** Rules ship with this release. A future updater would need signed or pinned provenance — see `docs/FILTER-SOURCES.md`.

## Install in Chrome (Developer Mode)

Since this extension is not on the Chrome Web Store, you must load it manually:

1. Download or clone this repository.
2. Run `npm run build` in your terminal to generate the `dist/` folder. (Requires Node 18+).
3. Open `chrome://extensions` in your browser.
4. Enable **Developer mode** (toggle in the top right corner).
5. Click **Load unpacked** and select the `dist/chrome-unpacked/` folder (the one containing `manifest.json`).
6. Pin the extension to your toolbar and open its popup to confirm the protection status.

## Develop & Build

Requires Node 18+ at build time only. The runtime has zero dependencies.

```bash
npm run validate     # schema + rule checks
npm run build        # produces dist/chrome-unpacked/, dist/*.zip, and SHA256SUMS
npm run build:chrome # builds only the Chrome version
npm run build:firefox # builds only the Firefox version
Repository Structure
background.js — Service worker handling DNR rules, state, and message passing.

content/ — Content scripts (content.js for cosmetic filtering, page.js for YouTube skipping).

popup/ — The extension popup UI and controller.

options/ — The settings page UI, controller, and diagnostics log.

rules/ — Hand-authored JSON files for ads, trackers, and security.

docs/ — Security model, testing checklist, and filter sourcing policies.

# License
MIT License. See LICENSE for details.

# Filter provenance and trademark notices are documented in NOTICE.md.