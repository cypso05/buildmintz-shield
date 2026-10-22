# Filter Sources

## Current Release (v0.1.0)

**No third-party filter-list data is bundled.** All rules in `rules/*.json` are intended to be hand-authored for this project and distributed under the same MIT license as the rest of the source tree.

This is a deliberate decision for the initial release:

- **Licensing clarity:** Avoid importing third-party list data before its licensing and redistribution requirements have been reviewed.
- **Reproducible builds:** Avoid depending on an unpinned conversion tool whose output or interpretation may change between builds.
- **Auditability:** Keep the shipped rulesets small, understandable, and straightforward to review.

These statements describe the intended policy. The actual rule files and build configuration must be checked to confirm compliance.

## Requirements for Adding External Lists

Any third-party filter list must be documented in this file **before it is imported**. Each source record must include:

| Field | Description |
|---|---|
| `id` | Stable identifier, such as `easylist-ads`. |
| `source_url` | Canonical HTTPS URL for the upstream source. |
| `license` | SPDX identifier and any applicable additional terms. |
| `attribution` | Exact attribution required by the applicable license. |
| `conversion` | Converter name, version, and configuration used to generate DNR rules. |
| `last_fetched` | ISO 8601 date of the last successful build-time fetch. |
| `sha256` | SHA-256 checksum of the upstream file fetched for that build. |
| `expected_rule_count` | Expected output rule count and an acceptable change threshold. |
| `redistributable` | Whether the source and resulting rule data may legally be redistributed. |

The build should fail if required metadata is missing, licensing is unresolved, or generated output exceeds configured validation limits.

Upstream changes should be reviewed explicitly. A rule-count change greater than 10% should trigger a build failure pending review rather than being silently accepted.

A metadata record alone does not establish that a source or its converted output is legally redistributable. Licensing must be evaluated for the actual source, applicable terms, and intended distribution.

## Sources Considered but Not Bundled (v0.1.0)

The following sources are potential candidates for a future build-time integration. **None are declared as active dependencies by this document.** Their current licensing and redistribution terms must be verified before adoption.

- **EasyList** — https://easylist.to/easylist/easylist.txt
- **EasyPrivacy** — distributed through the EasyList project.
- **AdGuard Base** — https://filters.adtidy.org/extension/ublock/filters/2.txt
- **AdGuard Annoyances** — available through AdGuard's filter distribution infrastructure.
- **URLhaus host file** — https://urlhaus.abuse.ch/downloads/hostfile/
- **Spam404** — https://raw.githubusercontent.com/Spam404/lists/master/main-blacklist.txt
- **uBlock Origin filter lists** — review applicable licensing, attribution, branding, and redistribution requirements before use.

The source names and URLs above are candidates only. They must not be interpreted as confirmation of current availability, license compatibility, or permission to redistribute converted data.

Blocking unreviewed list imports is intentional. Adding a third-party source is a policy and supply-chain change that requires review, not merely a code change.

## Build-Time Import Policy

If external sources are approved in a future release, the build pipeline should:

1. Fetch only from explicitly approved HTTPS origins.
2. Pin converter versions and configuration.
3. Record source checksums and retrieval dates.
4. Validate input formats before conversion.
5. Validate generated DNR JSON against Chrome's supported schema and rule constraints.
6. Enforce per-ruleset rule-count and file-size limits.
7. Compare generated output against expected bounds and flag unexpected changes.
8. Preserve license notices and required attribution in the distributed package.
9. Produce reproducible, reviewable build artifacts.
10. Fail closed when source integrity, validation, or licensing checks fail.

## Local Runtime Updates

The v0.1.0 policy is **no runtime filter-list fetching or updating**.

Any future updater must undergo a separate security review and satisfy these requirements:

1. Fetch only from an explicit HTTPS origin allowlist.
2. Validate downloaded data, schema, rule counts, and byte-size limits before applying changes.
3. Apply updates through supported Chrome Declarative Net Request APIs.
4. Preserve the last known-good ruleset until the replacement has passed validation.
5. Roll back safely if applying or verifying the replacement fails.
6. Never download or execute JavaScript as filter-list content.
7. Keep remote data strictly separate from executable extension code.
8. Document update behavior, integrity controls, and failure handling before release.

**Release guarantee:** Filter-list data is packaged with the extension. No remote filter-list update mechanism is part of the intended v0.1.0 design.

Verify the manifest, build scripts, generated rules, and runtime code before presenting these policy statements as confirmed implementation guarantees.