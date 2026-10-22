# Privacy Policy for BuildMintZ Shield

**Last Updated: October 22, 2026**

BuildMintZ Shield is a local-only browser extension. We believe your browsing history and data belong to you.

## Data Collection
**We do not collect, store, transmit, or sell any personal data.** 
BuildMintZ Shield does not contain any analytics, telemetry, tracking pixels, or remote servers. 

## Local Storage
All settings, including your global pause state, cosmetic filtering toggle, per-site allowlist, and ad-slip diagnostics, are stored locally on your device using the browser's `chrome.storage.local` API. This data never leaves your computer.

## Network Requests
The extension uses Chrome's native `declarativeNetRequest` API to block requests to known ad, tracker, and malicious domains. It does not read the content of your network traffic. 

## Permissions
- **storage:** Required to save your settings and allowlist locally.
- **activeTab:** Required to read the current URL so the popup can display the correct site exception button.
- **declarativeNetRequest:** Required to block network requests to known ad and tracker domains.
- **host_permissions (http/https):** Required so the extension can apply network rules and cosmetic filtering across websites.
- **YouTube Content Scripts:** Required to detect and skip YouTube video ads locally.

## Contact
If you have any questions about this privacy policy, please open an issue on our GitHub repository.
