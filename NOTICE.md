# Notices and filter provenance

## v0.1.0

This release contains **hand-authored domain rules only**, in
`rules/ads.json`, `rules/trackers.json`, and `rules/security.json`. It does
**not** bundle EasyList, EasyPrivacy, AdGuard lists, uBlock Origin lists, or
any other third-party filter list.

All rules are original to this project and MIT licensed under the terms in
`LICENSE`. The domain selections are informed by public knowledge of the
adtech and malicious-redirect ecosystems, but the rules themselves are not
copied from any third-party dataset.

## Why no third-party list is bundled

- **Licensing clarity.** EasyList is dual-licensed GPLv3 / CC BY-SA 3.0;
  AdGuard lists are LGPL-3.0 with additional terms. Redistributing converted
  rules can carry those obligations even though this extension's code is MIT.
- **Reproducible builds.** No dependency on an unpinned ABP-to-DNR converter
  whose output could change between builds.
- **Auditability.** 169 rules can be read end-to-end by one reviewer.

## Before adding a third-party list

Record in `docs/FILTER-SOURCES.md` **before** importing:

- Canonical HTTPS source URL
- SPDX license identifier and any additional terms
- Exact attribution text the license requires
- Retrieval date and SHA-256 of the fetched file
- Converter name, version, and configuration
- Whether the resulting DNR JSON may be redistributed

Redistributing derived rules may carry the source list's license obligations
even when the extension code is MIT. Treat list ingestion as a licensing and
supply-chain change, not a code change.

## Cross-ruleset duplication is intentional

Several domains appear in more than one ruleset (for example `criteo.com` in
both `ads.json` and `trackers.json`). This is deliberate: disabling one
ruleset must not silently remove protection for that domain. Do not "clean
up" cross-ruleset duplicates — only duplicates *within* a single ruleset are
bugs, and `npm run validate` fails on those.

## Trademark note

The project name and icon are not derived from uBlock Origin, AdGuard, or
EasyList. If any of those are ever forked or incorporated, keep their
trademarks out of the BuildMintZ Shield name and credit them explicitly here.