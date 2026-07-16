# Silicon Interface desktop

This directory contains the single Electron shell used for the macOS, Windows,
and Linux applications. It renders the production Interface website at
`https://interface.teamofsilicons.com/`; it does not run a localhost proxy,
rewrite `Origin`, duplicate the chat UI, or fork chat state machines by OS.

The product-wide design and research are in
[`../DESKTOP_APPLICATION_MASTER_PLAN.md`](../DESKTOP_APPLICATION_MASTER_PLAN.md).
This document is the implementation, testing, and release runbook.

## What is implemented

The same Interface build powers web and all three desktop products. The shell
adds only capabilities a normal browser cannot provide reliably:

- one persistent Chromium profile, preserving login cookies, IndexedDB drafts,
  outbox entries, media staging, cached history, and preferences across restarts;
- a sandboxed, versioned `window.siliconDesktop` bridge with no Node or raw
  Electron objects exposed to the page;
- native Save As downloads with completion-based success reporting;
- native notification permission, Dock/taskbar unread badges, notification
  activation, single-instance routing, and closed deep-link parsing;
- Windows/Linux tray behavior and conventional macOS Dock behavior;
- native edit, spelling, link, zoom, fullscreen, and update menus;
- camera/microphone access only for the trusted top-level Interface origin;
- sleep/resume signaling, renderer-crash recovery, and an offline recovery page;
- a quit/update handshake that flushes all live draft revisions and refuses to
  quit while a recording, attachment transfer, or failed local save is unsafe;
- signed automatic updates on macOS and Windows. Linux deliberately follows the
  package/download source because Electron has no safe universal Linux updater;
- security fuses that disable RunAsNode, `NODE_OPTIONS`, CLI inspection, and
  loading application code outside the integrity-checked ASAR.

Uploads still use the website's picker, drop, and paste paths. The selected Blob
is strictly committed to the existing IndexedDB media journal before the send
intent can become visible. This is intentional: the renderer and desktop app run
the same durable attachment and outbox implementation instead of maintaining a
second native upload engine.

## Trust boundary

Production always loads the exact Interface HTTPS origin. A build-time or
runtime environment variable cannot change it. Development may use only the
production origin or an HTTP(S) loopback address.

Main-process controls include:

- `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`;
- exact top-frame origin checks on every IPC request;
- explicit allow-lists for navigation, external URLs, downloads, and permissions;
- all popups denied; trusted in-app destinations reuse the main window and safe
  external HTTP(S)/mailto links open in the system browser;
- HID, USB, device selection, webviews, credentialed URLs, mixed content, and
  production Developer Tools denied;
- closed deep-link forms only: `silicon://chat/<room>`,
  `silicon://join/<token>`, and equivalent verified production HTTPS links.

The shell does not add E2EE. Transport and server-side security remain exactly
the same as the web application.

## Repository map

```text
desktop/
  src/main.ts             lifecycle, window, session, IPC, downloads, tray
  src/preload.ts          self-contained sandbox bridge
  src/contracts.ts        bridge v1 contract
  src/policy.ts           pure origin/URL/permission/update policy
  src/deep-links.ts       closed deep-link parser
  src/updater.ts          safe macOS/Windows update coordinator
  resources/offline.html local recovery surface
  resources/entitlements.mac.plist
  tests/                  pure policy, link, and release-tool tests
  scripts/                release version, SBOM, and checksum tooling
  infra/                  private release bucket, CDN, and GitHub OIDC stack
  electron-builder.yml    package targets, entitlements, fuses, update metadata
```

The evidence-backed current status is maintained in
[`VERIFICATION.md`](VERIFICATION.md).

The web adapter lives in:

- `src/lib/desktop-bridge.ts`;
- `src/components/desktop-bridge-init.tsx`;
- `src/lib/notifications.ts`, `src/lib/push.ts`, and
  `src/components/chat/media-previewer.tsx`.

## Local development

Install once from the Interface root:

```bash
pnpm install
```

Run the desktop shell against production:

```bash
pnpm desktop:start
```

Run against a local Interface server:

```bash
pnpm dev
SILICON_DESKTOP_URL=http://127.0.0.1:3000 SILICON_DISABLE_UPDATES=1 pnpm desktop:start
```

The production package ignores `SILICON_DESKTOP_URL`. Updates are disabled in
unpackaged development automatically; `SILICON_DISABLE_UPDATES=1` is useful for
packaged smoke tests.

## Required verification

Run from the Interface root:

```bash
pnpm desktop:test
pnpm exec tsc --noEmit
pnpm test:reliability
pnpm build
```

Build an unsigned local candidate on the current OS:

```bash
pnpm desktop:dist:win
pnpm desktop:dist:linux
```

On Apple Silicon, Electron fuse writes invalidate the vendor signature and
macOS will terminate a truly unsigned bundle. Use the dedicated engineering
smoke build, which prepares the unpacked app for an ad-hoc identity after
fuses, then run the same app-authored readiness gate used by CI:

```bash
pnpm -C desktop dist:mac:local
node desktop/scripts/smoke-mac-engineering.mjs desktop/dist-local
```

Electron cookie encryption requires a stable signing identity on macOS. The
disposable ad-hoc engineering build disables only that identity-bound fuse;
every other production fuse remains enforced. The release smoke is
non-mutating and requires cookie encryption, a timestamped Developer ID
Application signature, the configured Apple team, hardened runtime, and a
valid deep signature. An ad-hoc build is never distributable.

The branch workflow also executes these fresh-package gates on the native host:

```bash
# Windows Server 2022
node desktop/scripts/smoke-windows-package.mjs desktop/dist

# Ubuntu 22.04 after installing xvfb
node desktop/scripts/smoke-linux-package.mjs desktop/dist --format appimage
node desktop/scripts/smoke-linux-package.mjs desktop/dist --format deb --deb-mode install
```

These commands use an isolated session and require a one-time app-authored
receipt after the deployed Interface has hydrated its trusted desktop bridge.
They validate package version, platform, architecture, process identity, and
the exact HTTPS production origin, hold a stability window, terminate the full
process tree, and remove all smoke data. Linux extracts and launches the exact
AppImage without depending on FUSE, then separately performs a real DEB install
and uninstall. Windows performs a silent NSIS install, launches the installed
executable through the same readiness gate, and then confirms a silent
uninstall in an ephemeral directory. The smoke mode never reads a user's
cookies or drafts, takes over an installed app, changes the protocol handler,
or checks for updates.

Cross-compilation proves that files can be assembled, but it does not replace a
launch/install check on the target OS. CI builds each target on its native GitHub
runner. Before stable promotion, run this physical acceptance slice on every OS:

1. Install without bypassing Gatekeeper, SmartScreen, or package verification.
2. Log in, quit, relaunch, and confirm the session remains.
3. Open a room, type a draft, force-kill, reopen, and confirm exact recovery.
4. Pick, drop, and paste attachments; interrupt one upload and recover it.
5. Send while disconnecting; confirm one eventual message and correct receipts.
6. Download with Save As; cancel once and confirm no false success.
7. Receive one notification, click it, and confirm the exact room opens.
8. Test warm and cold `silicon://chat/<room>` links.
9. Sleep/resume during a live chat and verify reconnection without lost input.
10. Download an update while a draft is open; restart and verify the draft.
11. Check keyboard navigation, IME input, zoom, reduced motion, and a screen reader.
12. Uninstall and confirm the selected data-retention behavior.

## Release workflow

`.github/workflows/desktop-release.yml` is the only production release path. It:

1. requires a tag matching `desktop/package.json`, for example
   `desktop-v0.1.0`;
2. runs desktop unit tests, all Interface reliability tests, type checking, and
   the exact production web build;
3. builds x64 and arm64 packages on macOS, Windows, and Linux runners;
4. verifies every updater file name, size, and SHA-512 value, rejecting missing
   or duplicate update metadata;
5. signs/notarizes macOS, signs Windows, verifies the notarization ticket inside
   the unpacked app, DMG, and ZIP, and launches the app extracted from the exact
   host-native macOS ZIP plus the installed Windows application;
6. launches the host-native Linux AppImage and separately performs a real DEB
   install/runtime/uninstall gate;
7. emits DMG/ZIP, NSIS/ZIP, AppImage/DEB, updater metadata, a CycloneDX SBOM,
   `SHA256SUMS.txt`, and `release-manifest.json`;
8. optionally emits GitHub/Sigstore provenance when the repository plan supports
   artifact attestations;
9. prepares a private GitHub draft and verifies every asset digest without
   allowing same-name replacement;
10. uploads every versioned payload before its mutable updater pointer, rejects
   any conflicting immutable S3 path, retains older installers, and only then
   activates architecture-isolated feeds using short-lived GitHub OIDC
   credentials;
11. publishes the already-verified GitHub draft last and invalidates only the
   mutable downloads CDN paths.

The updater paths are fixed in signed code and cannot be supplied by the page:

```text
https://downloads.teamofsilicons.com/interface/stable/darwin/x64
https://downloads.teamofsilicons.com/interface/stable/darwin/arm64
https://downloads.teamofsilicons.com/interface/stable/win32/x64
https://downloads.teamofsilicons.com/interface/stable/win32/arm64
```

### One-time GitHub configuration

Certificate acquisition, Apple Developer ID export, notarization, and the
Windows cloud-signing decision are documented in
[`SIGNING_SETUP.md`](SIGNING_SETUP.md). Complete that guide before adding any
secret below; modern Windows public-trust keys are commonly cloud-HSM backed and
may require a provider-specific workflow instead of the classic `.pfx` path.

Add these encrypted Actions secrets:

| Secret | Purpose |
| --- | --- |
| `MACOS_CSC_LINK` | Base64 Developer ID Application `.p12` |
| `MACOS_CSC_KEY_PASSWORD` | Password for that certificate |
| `APPLE_ID` | Apple notarization account |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific notarization password |
| `APPLE_TEAM_ID` | Apple Developer team ID |
| `WINDOWS_CSC_LINK` | Base64 trusted Windows code-signing `.pfx` (legacy PFX path only) |
| `WINDOWS_CSC_KEY_PASSWORD` | Password for that certificate (legacy PFX path only) |
| `SSL_ESIGNER_USERNAME` | Dedicated SSL.com eSigner automation username |
| `SSL_ESIGNER_PASSWORD` | Dedicated SSL.com eSigner automation password |
| `SSL_ESIGNER_CREDENTIAL_ID` | Cloud-HSM signing credential ID |
| `SSL_ESIGNER_TOTP_SECRET` | OAuth TOTP automation secret; never a one-time code |

Add these Actions variables:

| Variable | Purpose |
| --- | --- |
| `AWS_RELEASE_ROLE_ARN` | GitHub OIDC role allowed to publish desktop artifacts |
| `AWS_RELEASE_BUCKET` | Private-origin bucket behind `downloads.teamofsilicons.com` |
| `AWS_RELEASE_CLOUDFRONT_DISTRIBUTION_ID` | Optional CDN invalidation target |
| `ENABLE_GITHUB_ATTESTATIONS` | Set `true` only when the repository plan supports them |
| `WINDOWS_SIGNING_PROVIDER` | Set `sslcom-esigner` for the cloud-HSM adapter; leave unset for PFX |

The AWS role should trust only this repository and release workflow/ref. Its
permissions should be limited to the bucket's `interface/stable/*` prefix plus
the one CloudFront invalidation action when configured. No AWS access key or
signing certificate belongs in the repository.

The repeatable AWS/CloudFront/OIDC stack and provisioning command are documented
in [`infra/README.md`](infra/README.md). DNS validation and the final
`downloads` CNAME remain in Namecheap; every AWS resource is otherwise created
from `infra/release-foundation.yml`.

### Cutting a release

1. Deploy the compatible Interface web commit to
   `interface.teamofsilicons.com` and complete its smoke test.
2. Set the semantic version in `desktop/package.json` and refresh
   `pnpm-lock.yaml`.
3. Run the required verification commands above.
4. Commit, create the exact `desktop-vX.Y.Z` tag, and push the commit and tag.
5. Watch **Desktop release**. Do not distribute anything from a failed or
   cancelled workflow.
6. Verify one downloaded artifact against `SHA256SUMS.txt`, then complete the
   physical acceptance slice before widening distribution.

## Current release blockers

The source and package candidates are implemented and locally verified. The
Apple Developer ID/notarization gate and the production downloads DNS/TLS/CDN
foundation are complete. A public production release is not complete until all
of the following remaining external gates are satisfied and the tagged release
workflow is green:

- CA validation and credentials for the trusted Windows signing identity (the
  SSL.com eSigner CI adapter is implemented; the verified publisher is not yet
  issued);
- clean-machine install/runtime acceptance on actual Windows and Linux systems;
- final `desktop-vX.Y.Z` signed release run and stable-feed promotion.

The production web bridge is already live: the deployed Interface bundle was
verified to contain the protocol-v1 lifecycle and deep-link adapter on
2026-07-16, and Glass `/healthz` plus `/readyz` were green at the same check.

Unsigned candidates are for engineering smoke tests only. They must never be
presented as public installers or accompanied by instructions to weaken OS
security controls.

## Operational recovery

- A failed build publishes nothing.
- A downloaded update is never installed until the renderer confirms its live
  work is durable; unsafe work keeps the current app open.
- Stop a rollout by removing the current update metadata from the stable CDN or
  restoring the previous known-good metadata. Existing installations keep their
  profile and unsent state.
- Prefer a signed forward-fix release. Do not silently cross-grade Windows NSIS
  identity to a future MSIX/store identity.
- Keep the prior signed installers and manifests immutable in GitHub Releases.
- Review Electron security support monthly and rebuild all OS packages for every
  Electron security update.
