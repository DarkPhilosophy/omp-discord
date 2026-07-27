# Changelog

## Unreleased

### Added

- Rich outbound Discord messages: `discord_send_message` supports embeds and local file uploads, while `discord_edit_message` supports content and embed updates.
- Native multipart attachment uploads with explicit filenames/descriptions, regular-file validation, and a 10 MiB per-file limit.

### Removed

- The `darkphilosophy-discord` marketplace catalog. `omp-discord` is distributed through the single `darkphilosophy` catalog.

## 0.1.1 — 2026-07-23

### Added

- The repository is now an OMP plugin marketplace (`.omp-plugin/marketplace.json`, catalog `darkphilosophy-discord`), enabling managed installs and upgrades. The release gate verifies the catalog version matches the package version.

### Changed

- Standardized project metadata and tooling: `DarkPhilosophy` author, canonical `git+` repository URL, packaged README/CHANGELOG, the `check`/`format`/`typecheck`/`test`/`scan`/`verify` script convention, a strict `tsconfig.json` (ES2023 lib, `verbatimModuleSyntax`), and a full Biome configuration (VCS-aware, 100-column, double quotes).

## 0.1.0 — 2026-07-23

Initial release.

### Added

- Explicit local Discord account operations for OMP: 17 scoped tools covering account status/login/logout, guild/channel/DM browsing, message listing/search/send/edit/delete, attachment reads, follow management, and the session operation ledger.
- Credential storage in the local OS secret service (`secret-tool`); the credential is never a tool parameter and never persisted elsewhere.
- Interactive `/discord` command: `login`, `logout`, `status`, `follow [start | stop | status]`, `config`, and `set <section.key> <value>` with argument completion.
- Persistent channel follow: cursor-based polling (`after` snowflake), batching by `batch_size`/`flush_ms`, atomic persisted state with resume-on-start, and strict per-session ownership.
- Follow registered as a real OMP background job — visible in `hub jobs`, cancellable (cancel stops the follow), with progress reporting and a delivery summary on stop.
- Batch delivery as plugin steering notifications (`customType: "discord-follow"`): wakes a waiting agent immediately, starts a turn when idle, and is never attributed to the user. Content is always marked untrusted data.
- Safe attachment handling: metadata-only listings, CDN links included only in follow notifications, `discord_read_attachment` with per-content-type byte limits, trusted-host checks, and bounded downloads.
- YAML configuration at `~/.omp/agent/discord.yml` (auto-created commented template, atomic writes, 0600) with `OMP_DISCORD_*` env overrides and validation warnings.
- Discord 429 handling with `retry_after`, exponential poll backoff (capped 60 s), and per-poll jitter.
- `belowEditor` status widget showing the followed target (resolved guild/channel names or raw IDs via `follow.display`), received count, and last delivery time.
- Session ledger under `~/.omp/discord`: hashed session filenames, metadata-only records, no message bodies.
